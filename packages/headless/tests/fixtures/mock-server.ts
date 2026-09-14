/**
 * A real WebSocket server that plays the Quinoa server role.
 *
 * WHY `ws` AND NOT SOMETHING SIMPLER
 * ----------------------------------
 * RFC 6455 framing is not something a test double can fake: the client under test is Node's *global*
 * `WebSocket` (undici), which performs a real HTTP upgrade, real masking, and real close handshakes. A
 * hand-rolled TCP server would have to reimplement all of that before it could test anything. `ws` is
 * already a devDependency of this workspace (root `package.json`), with `@types/ws` alongside it, so
 * using it here costs nothing and keeps the client at zero runtime dependencies.
 *
 * WHAT IT IMPLEMENTS, FROM THE RECON
 * ----------------------------------
 * The scripted sequence follows `recon-quinoa-protocol.md`:
 *
 *   1. §1.6: on connection (after an optional delay), the server replies with
 *      `{ type: "Welcome", selfPlayerId, executedCommandSequence, fullState }`. `selfPlayerId` here is
 *      `"p_1"` and the snapshot carries room state at `fullState.data` and game state at
 *      `fullState.child.data` (§7, §6.1), including `/data/players/0/coins`, the pointer the
 *      integration test reads after a patch.
 *   2. §1.6: the client's `VoteForGame` and `SetSelectedGame` rooms frames arrive *before* `Welcome` is
 *      even relevant; the server records them (it does not need to answer them, since no response type is
 *      documented for either) and exposes them so the ordering assertion is possible.
 *   3. §1.7: the server sends the bare-string `"ping"` periodically and expects the bare string
 *      `"pong"`.
 *   4. §2.2 + §8.1: every inbound frame is parsed. A `QuinoaCommand` envelope is answered with
 *      `{ type: "QuinoaCommandResult", requestId: <echoed>, commandType: <command.type>, ok: true }`
 *      followed by a `PartialState` frame whose patches mutate the synthetic tree.
 *   5. §1.8: the test-facing control channel can force-close a live socket with an arbitrary code, so
 *      the `4400` reconnect path and the `4710` version-refetch path are both exercised for real.
 *
 * TWO DELIBERATE DEPARTURES FROM A REAL SERVER, BOTH DOCUMENTED
 * ------------------------------------------------------------
 *   - **It echoes `requestId`.** The protocol doc says the real `QuinoaCommandResult` payload carries no
 *     `requestId` (and the common package's `QuinoaCommandResultMessage` types it as optional for that
 *     reason). Echoing it makes the *test* deterministic, since the client can confirm correlation, while
 *     staying inside a shape the API reference explicitly allows ("`requestId` as optional, implying
 *     some builds do echo it"). `echoRequestId: false` restores the documented no-echo behaviour for
 *     anyone who wants to test the ambiguous path.
 *   - **It never supersedes.** There is no second connection here, so `4250`/`4300` are produced only on
 *     request through the control channel.
 *
 * The control channel is HTTP on the same server, so a test can drive the mock without a second port and
 * without reaching into module state:
 *
 *   - `POST /__control/close` with `{ "code": 4400, "reason": "..." }` closes every open socket.
 *   - `POST /__control/ping` sends one bare `"ping"` to every open socket.
 *   - `GET  /__control/state` returns the request log (handshakes, command frames, pongs, counts).
 */

import type { IncomingMessage, Server } from 'node:http';
import { createServer } from 'node:http';
import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';

/**
 * The synthetic room + game state.
 *
 * `players[0]` is the connecting player and holds `coins`, which the command handler increments, and the
 * integration test asserts the store saw the resulting patch at `/data/players/0/coins`.
 */
export interface MockGameState {
  data: {
    players: Array<{ id: string; name: string; coins: number; [key: string]: unknown }>;
    chat: unknown[];
    hostPlayerId: string;
    [key: string]: unknown;
  };
  child: {
    data: {
      userSlots: Array<{ data: { garden: Record<string, unknown> } }>;
      weather: unknown;
      shops: Record<string, unknown>;
      [key: string]: unknown;
    };
  };
}

/** One inbound frame the server saw, kept for assertions. */
export interface MockRequestLogEntry {
  /** Milliseconds since the server started. */
  at: number;
  /** Where the bytes landed: the upgrade URL or an HTTP control path. */
  path: string;
  /** `parsed` for JSON, `raw` for anything else (including the bare-string keepalive). */
  kind: 'parsed' | 'raw' | 'binary';
  /** The decoded frame, when it was JSON. */
  frame?: Record<string, unknown>;
  /** The raw text, always (capped at 2000 chars). */
  raw: string;
  /** The server-side connection index this frame arrived on. */
  connection: number;
}

/** Options for {@link startMockServer}. */
export interface MockServerOptions {
  /**
   * Delay before `Welcome` is sent, in ms. Default 0.
   *
   * Non-zero exists to exercise the client's "Welcome has not arrived yet" window, because the handshake
   * ordering assertion (`VoteForGame` then `SetSelectedGame`, both before `Welcome`) needs the server
   * to have received them first, and a delay makes that ordering observable rather than a race.
   */
  welcomeDelayMs?: number;
  /** Period between server-initiated bare-string `"ping"` frames, in ms. Default 1000. `0` disables. */
  pingIntervalMs?: number;
  /** The game version the server pretends to require, echoed in logs. */
  version?: string;
  /** `selfPlayerId` in `Welcome`. Default `"p_1"` (the recon's example shape is `"p_..."`). */
  selfPlayerId?: string;
  /** `executedCommandSequence` in `Welcome`. Default 10, so the first command must be 11. */
  executedCommandSequence?: number;
  /** Echo the client's `requestId` in `QuinoaCommandResult`. Default `true`; see the file header. */
  echoRequestId?: boolean;
  /** The starting snapshot. Defaults to {@link defaultMockState}. */
  initialState?: MockGameState;
  /** Close open sockets this long after each connect, in ms. `0`/omitted disables. */
  closeAfterMs?: number;
  /** Close code used by {@link MockServerOptions.closeAfterMs}. Default 4400 (idle timeout, §1.8). */
  closeAfterCode?: number;
  /**
   * Reason string used by {@link MockServerOptions.closeAfterMs}. Default `'idle timeout'`.
   *
   * Exists because the reason is required for 4300: `analyzeClose` reads a 4300 whose reason mentions
   * "heartbeat" as our own reconnect racing itself rather than a real supersession by another client, and
   * that distinction is what decides whether a human has to confirm before reconnecting.
   */
  closeAfterReason?: string;
  /**
   * Wait for the `Welcome` frame to be *sent* before starting the {@link MockServerOptions.closeAfterMs}
   * countdown.
   *
   * `false` (the default) measures the delay from accept, which models a server that drops a connection
   * before the handshake completes. `true` models the more interesting case: the session is established,
   * so the client's reconnect policy resets its attempt budget before the close arrives. That is the only
   * way to test superseded/disposition behaviour with a *welcomed* session.
   */
  closeAfterWelcome?: boolean;
  /**
   * Log every inbound frame to stdout. Default `false`; the tests assert against
   * {@link MockServer.requests} instead of scraping logs.
   */
  verbose?: boolean;
  /**
   * Close every newly accepted connection with {@link alwaysCloseCode} before the script runs.
   *
   * This models "a server that accepts and immediately drops you", the case that must not be able to
   * trap a client in a fast reconnect loop. Unlike `closeNextConnection` (one-shot), this stays armed
   * until the server is stopped.
   */
  alwaysClose?: boolean;
  /** The code used by {@link MockServerOptions.alwaysClose}. Default 4400 (idle timeout, §1.8). */
  alwaysCloseCode?: number;
}

/** A running mock server. */
export interface MockServer {
  /**
   * The `ws://127.0.0.1:<port>` base. Tests never rewrite the scheme to `wss`; plain `ws` is the
   * local case.
   */
  readonly url: string;
  readonly host: string;
  readonly port: number;
  /** The injected version string, for assertions about what the client was told. */
  readonly version: string;
  /** Every inbound frame, in arrival order. */
  readonly requests: MockRequestLogEntry[];
  /** How many sockets have been accepted. Proves a reconnect actually happened. */
  readonly connectionCount: number;
  /** How many bare-string `"pong"` replies were received. */
  readonly pongCount: number;
  /** Live sockets. */
  readonly openSockets: number;
  /** Sockets closed by {@link forceClose}. */
  readonly forcedCloses: number;
  /** The current synthetic state, mutated in place by command handlers. */
  readonly state: MockGameState;
  /** The `QuinoaCommand` envelopes received, parsed. */
  readonly commands: Array<{ type: string; requestId: string; commandSequence: number; connection: number }>;
  /** The room-scoped frames received (handshake + anything else), in order. */
  readonly roomFrames: Array<{ type: string; connection: number; beforeWelcome: boolean }>;
  /**
   * Every accepted upgrade, in order, with the query values the client sent.
   *
   * The URL is where a reconnect is *observable*: `clientConnectionAttempt` and the `/version/<v>/` path
   * segment are the two things the reconnect logic is required to change (§1.4, §9).
   */
  readonly upgrades: Array<{
    connection: number;
    url: string;
    version: string;
    connectionAttempt: string | null;
    navigationType: string | null;
    reclaimSuperseded: string | null;
    documentId: string | null;
    /** The upgrade request's headers, lower-cased by Node. Where a header-capable runtime lands. */
    headers: Record<string, string | string[] | undefined>;
  }>;
  /** `POST /__control/close`: close every open socket with a code/reason. Returns how many it hit. */
  forceClose(code: number, reason?: string): Promise<number>;
  /** `POST /__control/ping`: send one bare `"ping"` to every open socket. */
  pingOnce(): Promise<number>;
  /** Arm a one-shot override: the next accepted connection is closed with this code instead of running the script. */
  closeNextConnection(code: number, reason?: string): Promise<void>;
  /** Stop the HTTP + WebSocket servers and close every socket. */
  stop(): Promise<void>;
}

/** Build the default synthetic snapshot: room at `data`, game at `child.data` (§6.1). */
export function defaultMockState(): MockGameState {
  return {
    data: {
      players: [{ id: 'p_1', name: 'Tester', coins: 0 }],
      chat: [],
      hostPlayerId: 'p_1',
    },
    child: {
      data: {
        userSlots: [{ data: { garden: {} } }],
        weather: null,
        shops: {},
      },
    },
  };
}

/** The mutable internals behind the {@link MockServer} façade. */
interface MockInternals {
  host: string;
  port: number;
  version: string;
  pongCount: number;
  connectionCount: number;
  forcedCloses: number;
  sockets: Set<WebSocket>;
  nextConnectionCode: number | null;
  nextConnectionReason: string;
}

/**
 * Start the mock server on an ephemeral port.
 *
 * `port: 0` (the default) asks the OS for a free port, which keeps these tests parallel-safe.
 */
export async function startMockServer(options: MockServerOptions = {}): Promise<MockServer> {
  const state = options.initialState ?? defaultMockState();
  const requests: MockRequestLogEntry[] = [];
  const commands: MockServer['commands'] = [];
  const roomFrames: MockServer['roomFrames'] = [];
  const upgrades: MockServer['upgrades'] = [];
  const internals: MockInternals = {
    host: '127.0.0.1',
    port: 0,
    version: options.version ?? 'test-version-1',
    pongCount: 0,
    connectionCount: 0,
    forcedCloses: 0,
    sockets: new Set<WebSocket>(),
    nextConnectionCode: null,
    nextConnectionReason: '',
  };

  const startedAt = Date.now();
  const pingIntervalMs = options.pingIntervalMs ?? 1000;
  const verbose = options.verbose ?? false;

  const httpServer: Server = createServer((req, res) => {
    void handleControlRequest(req, res, state, internals, requests, startedAt);
  });

  // `noServer` so the upgrade can be accepted (or refused) explicitly, which is closer to how the real
  // endpoint behaves than letting `ws` bind its own path.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  httpServer.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    internals.connectionCount += 1;
    const connection = internals.connectionCount;
    internals.sockets.add(ws);

    const path = req.url ?? '/';
    const upgradeUrl = new URL(path, 'http://127.0.0.1');
    const versionMatch = /\/version\/([^/]+)\//.exec(upgradeUrl.pathname);
    upgrades.push({
      connection,
      url: path,
      version: versionMatch?.[1] ?? '',
      connectionAttempt: upgradeUrl.searchParams.get('clientConnectionAttempt'),
      navigationType: upgradeUrl.searchParams.get('clientNavigationType'),
      reclaimSuperseded: upgradeUrl.searchParams.get('reclaimSupersededSession'),
      documentId: upgradeUrl.searchParams.get('clientDocumentId'),
      headers: { ...req.headers },
    });
    let welcomed = false;
    let closed = false;

    const sendJson = (payload: Record<string, unknown>): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
    };

    // Persistent override: every connection dies before the script. Used by the attempt-budget test.
    if (options.alwaysClose === true) {
      ws.close(options.alwaysCloseCode ?? 4400, 'always closing');
      closed = true;
    }

    // One-shot override: a test can make the very next connection die with a specific code before any of
    // the script runs. Used for the "server force-closes with 4400" path.
    if (internals.nextConnectionCode !== null) {
      const code = internals.nextConnectionCode;
      const reason = internals.nextConnectionReason;
      internals.nextConnectionCode = null;
      internals.nextConnectionReason = '';
      ws.close(code, reason);
      closed = true;
    }

    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let welcomeTimer: ReturnType<typeof setTimeout> | null = null;
    let autoCloseTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = (): void => {
      if (pingTimer !== null) clearInterval(pingTimer);
      if (welcomeTimer !== null) clearTimeout(welcomeTimer);
      if (autoCloseTimer !== null) clearTimeout(autoCloseTimer);
      pingTimer = null;
      welcomeTimer = null;
      autoCloseTimer = null;
    };

    const armAutoClose = (): void => {
      if (options.closeAfterMs === undefined || options.closeAfterMs <= 0) return;
      autoCloseTimer = setTimeout(() => {
        ws.close(options.closeAfterCode ?? 4400, options.closeAfterReason ?? 'idle timeout');
      }, options.closeAfterMs);
    };

    const sendWelcome = (): void => {
      if (closed || ws.readyState !== ws.OPEN) return;
      sendJson({
        type: 'Welcome',
        selfPlayerId: options.selfPlayerId ?? 'p_1',
        executedCommandSequence: options.executedCommandSequence ?? 10,
        fullState: state,
        // Not part of the documented payload; harmless extra evidence for a human reading a frame dump.
        gameVersion: internals.version,
      });
      welcomed = true;

      if (pingIntervalMs > 0) {
        pingTimer = setInterval(() => {
          // §1.7: the server-initiated keepalive is the BARE STRING `"ping"`, not a WebSocket protocol
          // ping and not JSON.
          if (ws.readyState === ws.OPEN) ws.send('ping');
        }, pingIntervalMs);
      }

      if (options.closeAfterWelcome === true) armAutoClose();
    };

    if (!closed) {
      const delay = options.welcomeDelayMs ?? 0;
      if (delay > 0) welcomeTimer = setTimeout(sendWelcome, delay);
      else sendWelcome();

      if (options.closeAfterWelcome !== true) armAutoClose();
    }

    ws.on('message', (data: unknown) => {
      const text = toText(data);
      let frame: Record<string, unknown> | undefined;
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          frame = parsed as Record<string, unknown>;
        }
      } catch {
        frame = undefined;
      }

      requests.push({
        at: Date.now() - startedAt,
        path,
        kind: frame === undefined ? 'raw' : 'parsed',
        ...(frame !== undefined ? { frame } : {}),
        raw: text.slice(0, 2000),
        connection,
      });
      if (verbose) console.log(`[mock] <- conn ${connection}:`, text.slice(0, 300));

      // The bare-string keepalive reply, both quoting forms tolerated on the way in.
      if (text === 'pong' || text === '"pong"') {
        internals.pongCount += 1;
        return;
      }

      if (frame === undefined) return;
      const type = frame.type;

      // Room-scoped frames: the §1.6 handshake, and anything else room-scoped (§2.2 Form B).
      if (Array.isArray(frame.scopePath) && frame.scopePath.length === 1) {
        if (typeof type === 'string') {
          roomFrames.push({ type, connection, beforeWelcome: !welcomed });
        }
        // No documented response to VoteForGame/SetSelectedGame; the real server's next observable act is
        // `Welcome`, which is already on its way.
        return;
      }

      // The wrapped gameplay envelope (§2.2 Form C).
      if (type === 'QuinoaCommand') {
        const command = frame.command;
        const inner =
          command !== null && typeof command === 'object' ? (command as Record<string, unknown>) : {};
        const commandType = typeof inner.type === 'string' ? inner.type : 'unknown';
        const requestId = typeof frame.requestId === 'string' ? frame.requestId : '';
        const commandSequence = typeof frame.commandSequence === 'number' ? frame.commandSequence : -1;
        commands.push({ type: commandType, requestId, commandSequence, connection });

        applyCommandEffects(commandType, inner, state);

        const result: Record<string, unknown> = {
          type: 'QuinoaCommandResult',
          commandType,
          ok: true,
        };
        // See the file header: echoing is the test-friendly default, and `echoRequestId: false` restores
        // the documented no-echo behaviour.
        if (options.echoRequestId !== false && requestId !== '') result.requestId = requestId;
        sendJson(result);

        // §6.2: the server then pushes a JSON-Patch batch. The patch mutates the synthetic tree so the
        // client's store has something real to apply.
        sendJson({
          type: 'PartialState',
          patches: [
            { op: 'replace', path: '/data/players/0/coins', value: state.data.players[0]?.coins ?? 0 },
          ],
        });
        return;
      }

      // Flat Quinoa frames (§2.2 Form A), acknowledged the same way, with no patch, so a mistaken form
      // is visible in the log rather than silently ignored.
      if (Array.isArray(frame.scopePath) && frame.scopePath.length === 2) {
        if (typeof type === 'string') {
          sendJson({ type: 'QuinoaCommandResult', commandType: type, ok: true });
        }
      }
    });

    ws.on('close', () => {
      clearTimers();
      internals.sockets.delete(ws);
    });

    ws.on('error', () => {
      clearTimers();
      internals.sockets.delete(ws);
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Mock server failed to bind an ephemeral port.');
  }
  internals.port = address.port;

  const url = `ws://127.0.0.1:${internals.port}`;

  const server: MockServer = {
    url,
    host: internals.host,
    port: internals.port,
    version: internals.version,
    requests,
    commands,
    roomFrames,
    upgrades,
    state,
    get connectionCount() {
      return internals.connectionCount;
    },
    get pongCount() {
      return internals.pongCount;
    },
    get openSockets() {
      return internals.sockets.size;
    },
    get forcedCloses() {
      return internals.forcedCloses;
    },
    async forceClose(code, reason = 'forced by test') {
      let hit = 0;
      for (const socket of [...internals.sockets]) {
        try {
          socket.close(code, reason);
          hit += 1;
        } catch {
          // Already gone.
        }
      }
      internals.forcedCloses += hit;
      return hit;
    },
    async pingOnce() {
      let sent = 0;
      for (const socket of [...internals.sockets]) {
        if (socket.readyState === socket.OPEN) {
          socket.send('ping');
          sent += 1;
        }
      }
      return sent;
    },
    async closeNextConnection(code, reason = 'forced before script') {
      internals.nextConnectionCode = code;
      internals.nextConnectionReason = reason;
    },
    async stop() {
      for (const socket of [...internals.sockets]) {
        try {
          socket.terminate();
        } catch {
          // Ignore.
        }
      }
      internals.sockets.clear();
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };

  return server;
}

/** Decode a `ws` message payload to text. `ws` gives a Buffer for text frames on the server side. */
function toText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('utf8');
  }
  return '';
}

/**
 * The documented effects of each wrapped command.
 *
 * Only the handful the integration tests use are modelled; everything else is accepted and ignored, which
 * is the honest behaviour for a mock, because inventing game rules would make the mock harder to trust, not
 * easier.
 */
function applyCommandEffects(
  commandType: string,
  command: Record<string, unknown>,
  state: MockGameState,
): void {
  const player = state.data.players[0];
  if (player === undefined) return;

  switch (commandType) {
    case 'HarvestCrop':
      player.coins += 1;
      return;
    case 'SellAllCrops':
      player.coins += 10;
      return;
    case 'PlantSeed':
    case 'WaterPlant':
      // No coin change: these are the "does the ack still correlate?" cases.
      void command;
      return;
    default:
      return;
  }
}

/** Handle the HTTP control channel. */
async function handleControlRequest(
  req: IncomingMessage,
  res: import('node:http').ServerResponse,
  state: MockGameState,
  internals: MockInternals,
  requests: MockRequestLogEntry[],
  startedAt: number,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;

  if (path === '/__control/state') {
    respond(res, 200, {
      connectionCount: internals.connectionCount,
      pongCount: internals.pongCount,
      openSockets: internals.sockets.size,
      forcedCloses: internals.forcedCloses,
      state,
      requests: requests.slice(-200),
    });
    return;
  }

  if (path === '/__control/close' && req.method === 'POST') {
    const body = await readBody(req);
    const code = typeof body.code === 'number' ? body.code : 4400;
    const reason = typeof body.reason === 'string' ? body.reason : 'forced by test';
    let hit = 0;
    for (const socket of [...internals.sockets]) {
      try {
        socket.close(code, reason);
        hit += 1;
      } catch {
        // Already gone.
      }
    }
    internals.forcedCloses += hit;
    requests.push({
      at: Date.now() - startedAt,
      path,
      kind: 'parsed',
      frame: { code, reason },
      raw: JSON.stringify({ code, reason }),
      connection: -1,
    });
    respond(res, 200, { closed: hit });
    return;
  }

  if (path === '/__control/ping' && req.method === 'POST') {
    let sent = 0;
    for (const socket of [...internals.sockets]) {
      if (socket.readyState === socket.OPEN) {
        socket.send('ping');
        sent += 1;
      }
    }
    respond(res, 200, { sent });
    return;
  }

  if (path === '/__control/close-next' && req.method === 'POST') {
    const body = await readBody(req);
    internals.nextConnectionCode = typeof body.code === 'number' ? body.code : 4400;
    internals.nextConnectionReason = typeof body.reason === 'string' ? body.reason : 'forced before script';
    respond(res, 200, { armed: internals.nextConnectionCode });
    return;
  }

  respond(res, 404, { error: `unknown control path ${path}` });
}

/** Read and JSON-parse a request body, tolerating an empty or malformed one. */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Write a JSON response. */
function respond(res: import('node:http').ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
