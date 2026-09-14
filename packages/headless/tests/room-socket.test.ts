/**
 * `RoomSocket`: the documented facade.
 *
 * These tests exist for *fidelity to the API reference*, so they assert the documented surface
 * itself: the class name, the four properties (`room`, `playerId`, `sequencer`, plus the `actions`/
 * `store` surface), the four methods (`connect`, `disconnect`, `send`, static `buildConnectUrl`) and the
 * four documented events. If a rename ever breaks that contract, this file is what catches it.
 *
 * The one behaviour worth calling out is that `on*` subscriptions work *before* `connect()`. The
 * reference's usage pattern is construct → subscribe → connect, and a facade that only accepted
 * subscriptions after connecting would silently drop the first `Welcome`, the single most important
 * event to catch.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { after, describe, it } from 'node:test';

import type { MgClient } from '@mg.js/common';
import { pollUntil } from '@mg.js/common';
import type { HeadlessClientEvents } from '../src/client.js';
import { MgConfigError } from '../src/errors.js';
import { RoomSocket } from '../src/room-socket.js';
import type { MockServer } from './fixtures/mock-server.js';
import { startMockServer } from './fixtures/mock-server.js';

const servers: MockServer[] = [];
const sockets: RoomSocket[] = [];

after(async () => {
  for (const socket of sockets.splice(0)) {
    try {
      await socket.stop();
    } catch {
      /* best effort */
    }
  }
  for (const server of servers.splice(0)) {
    try {
      await server.stop();
    } catch {
      /* best effort */
    }
  }
});

async function mock(options: Parameters<typeof startMockServer>[0] = {}): Promise<MockServer> {
  const server = await startMockServer(options);
  servers.push(server);
  return server;
}

/**
 * Register a socket for the `after` teardown.
 *
 * Kept as its own helper rather than a call inside {@link makeSocket} because some tests need a socket whose
 * options are not a mock server's (a never-connected instance, or one pointed at a closed port) and still
 * want the same teardown guarantee.
 */
function track(socket: RoomSocket): RoomSocket {
  sockets.push(socket);
  return socket;
}

function makeSocket(server: MockServer, overrides: Record<string, unknown> = {}): RoomSocket {
  return track(
    new RoomSocket({
      host: server.host,
      port: server.port,
      tls: false,
      version: server.version,
      room: 'testroom',
      reconnect: { enabled: false },
      ...overrides,
    }),
  );
}

describe('RoomSocket: the documented static surface', () => {
  it('exposes the documented name and static buildConnectUrl', () => {
    assert.equal(typeof RoomSocket, 'function');
    assert.equal(RoomSocket.name, 'RoomSocket');
    assert.equal(typeof RoomSocket.buildConnectUrl, 'function');
  });

  it('builds the documented URL template and JSON-encodes every string value', () => {
    const url = RoomSocket.buildConnectUrl({
      version: '1158',
      room: 'abcde12345',
      documentId: 'doc-1',
    });
    assert.ok(
      url.startsWith('wss://magicgarden.gg/version/1158/api/rooms/abcde12345/connect?'),
      `unexpected URL: ${url}`,
    );
    const params = new URL(url).searchParams;
    assert.equal(params.get('surface'), '"web"');
    assert.equal(params.get('version'), '"1158"');
    assert.equal(params.get('clientDocumentId'), '"doc-1"');
    // Numeric values are never quoted.
    assert.equal(params.get('clientConnectionAttempt'), '1');
  });
});

describe('RoomSocket: construction and the pre-connect contract', () => {
  it('does not touch the network or window at construction', () => {
    // Constructing must be side-effect free: the reference's own example constructs, subscribes, then
    // connects.
    const socket = new RoomSocket({ version: '1', room: 'r' });
    sockets.push(socket);
    assert.equal(socket.isReady, false);
    // I6: an identity the server has not assigned is `null`, not `''`, the placeholder this used to be.
    assert.equal(socket.playerId, null);
    assert.equal(socket.selfPlayerId, null);
    assert.equal(socket.sequencer, null);
    assert.deepEqual(
      {
        kind: socket.report.kind,
        started: socket.report.started,
        ready: socket.report.ready,
        selfPlayerId: socket.report.selfPlayerId,
        queuedSubscriptionCount: socket.report.queuedSubscriptionCount,
      },
      { kind: 'headless', started: false, ready: false, selfPlayerId: null, queuedSubscriptionCount: 0 },
    );
  });

  it('throws a clear error for accessors that need a connection', () => {
    const socket = new RoomSocket({ version: '1', room: 'r' });
    sockets.push(socket);
    assert.throws(() => socket.actions, /not available before start\(\)/);
    assert.throws(() => socket.store, /not available before start\(\)/);
    assert.throws(() => socket.roomState, /not available before start\(\)/);
    assert.throws(() => socket.gameState, /not available before start\(\)/);
    assert.throws(() => socket.underlying, /not available before start\(\)/);
  });

  it('reports the configured room before connecting', () => {
    const socket = new RoomSocket({ version: '1', room: 'myroom' });
    sockets.push(socket);
    assert.equal(socket.room, 'myroom');
  });

  it('accepts and cancels a subscription made before connect', async () => {
    const server = await mock();
    const socket = makeSocket(server);
    let calls = 0;
    const off = socket.onWelcome(() => {
      calls += 1;
    });
    off();
    await socket.start();
    await socket.waitUntilReady();
    assert.equal(calls, 0, 'a cancelled pre-connect subscription must never fire');
  });

  it('refuses a second connect on the same instance', async () => {
    const server = await mock();
    const socket = makeSocket(server);
    await socket.start();
    await assert.rejects(socket.start(), /already been called/);
  });
});

describe('RoomSocket: the documented connect/ready/actions flow', () => {
  it('connects, becomes ready, and exposes the documented properties', async () => {
    const server = await mock();
    const socket = makeSocket(server);

    const url = await socket.start();
    assert.ok(url.includes('/version/'), `start() must resolve to the URL that was opened: ${url}`);
    assert.equal(url, socket.url);

    await socket.waitUntilReady();

    assert.equal(socket.isReady, true);
    const assigned = socket.selfPlayerId;
    assert.ok(
      typeof assigned === 'string' && assigned.length > 0,
      `selfPlayerId must be populated from Welcome, got ${String(assigned)}`,
    );
    assert.equal(socket.playerId, assigned, 'the reference-shaped alias reads the same value');
    assert.ok(socket.sequencer !== null, 'the sequencer must be exposed after Welcome');
    assert.equal(socket.room, 'testroom');
    assert.ok(socket.roomState !== undefined || socket.roomState === null);
  });

  it('delivers the documented welcome event to a subscription made BEFORE connect', async () => {
    // The natural usage order is construct -> subscribe -> connect. A Welcome missed because of
    // subscription ordering would be the most damaging possible bug in this facade.
    const server = await mock();
    const socket = makeSocket(server);

    const welcomes: unknown[] = [];
    socket.onWelcome((message) => welcomes.push(message));
    socket.onReady(() => welcomes.push('ready'));

    await socket.start();
    await socket.waitUntilReady();

    assert.equal(welcomes.length, 2, `expected welcome + ready, got ${JSON.stringify(welcomes)}`);
    assert.equal(welcomes[1], 'ready');
    const welcome = welcomes[0] as { type?: string; selfPlayerId?: string };
    assert.equal(welcome.type, 'Welcome');
    assert.equal(typeof welcome.selfPlayerId, 'string');
  });

  it('exposes the typed action surface and sends an action end to end', async () => {
    const server = await mock();
    const socket = makeSocket(server);
    await socket.start();
    await socket.waitUntilReady();

    // 72 wire-capable methods on the shared action class.
    assert.equal(typeof socket.actions.harvestCrop, 'function');
    assert.equal(typeof socket.actions.waterPlant, 'function');

    // `harvestCrop` is the documented wrapped (envelope) case, and the mock replies with a
    // `QuinoaCommandResult` plus a state patch.
    const handle = socket.actions.harvestCrop({ slot: 3 });
    const result = await handle;
    assert.equal(result.ok, true);
    assert.equal(result.confirmed, true, 'the mock echoes requestId, so this is the strong form');

    await until(
      () => socket.store.get('/data/players/0/coins') === 1,
      'the action to produce a state patch',
      3000,
    );
    assert.equal(socket.store.get('/data/players/0/coins'), 1, 'the action must have produced a state patch');
  });

  it('sends a pre-built payload verbatim through send()', async () => {
    const server = await mock();
    const socket = makeSocket(server);
    await socket.start();
    await socket.waitUntilReady();

    socket.send({ scopePath: ['Room'], type: 'UsurpHost' });
    // A bare string must pass through untouched, since that is how the keepalive is expressed.
    socket.send('pong');

    // Assert on the bytes the server actually received, not on `send()` having failed to throw: a client
    // that re-serialised the object or dropped the bare string would throw nothing either. This used to
    // read `server.commands.length > 0 || true`, which is `assert.ok(true)`, a gate that could not fail.
    const sawRawPong = (): boolean =>
      server.requests.some((entry) => entry.kind === 'raw' && entry.raw === 'pong');
    await until(sawRawPong, 'the bare string to reach the server', 1_000);

    assert.ok(
      sawRawPong(),
      `the bare string must reach the server byte-for-byte; frames seen: ${JSON.stringify(
        server.requests.map((entry) => ({ kind: entry.kind, raw: entry.raw })),
      )}`,
    );
    assert.ok(
      server.requests.some((entry) => entry.kind === 'parsed' && entry.raw.includes('UsurpHost')),
      'the hand-built object frame must reach the server as JSON',
    );
  });

  it('disconnects cleanly without reconnecting', async () => {
    const server = await mock();
    const socket = makeSocket(server);
    await socket.start();
    await socket.waitUntilReady();

    const connectionsBefore = server.connectionCount;
    await socket.stop();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(server.connectionCount, connectionsBefore, 'disconnect() must suppress reconnect');
  });
});

// ------------------------------------------------------------------------------------
// Reconnect: the behaviour the facade inherits, and must therefore be able to report
// ------------------------------------------------------------------------------------
//
// `RoomSocket` delegates to `HeadlessClient`, which owns the reconnect policy, the version re-resolve
// and the `stopped` decision. None of that was reachable through the documented class: `on()` was typed
// over the *core's* event map only, so `reconnect`/`stopped` were a compile error and `onCore` could not
// deliver them even if the cast were forced. A host using the documented class could not tell "a retry
// is coming" from "the client has given up".

/**
 * Poll until `predicate` is true, or fail loudly rather than hanging.
 *
 * Built on `@mg.js/common`'s `pollUntil`; the assertion is driven by the resolved value, because a throw
 * from `onTimeout` would land in a timer callback as an uncaught exception.
 */
async function until(predicate: () => boolean, description: string, timeoutMs = 2000): Promise<void> {
  const found = await pollUntil<true>({
    attempt: () => (predicate() ? true : null),
    timeoutMs,
    intervalMs: 10,
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  });
  if (found === null) assert.fail(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

/** A port nothing is listening on: bind one, read it, release it. */
async function closedPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe('RoomSocket: reconnect is observable from the facade', () => {
  it('delivers reconnect and stopped before connect', async () => {
    const server = await mock();
    const socket = makeSocket(server, {
      // `maxAttempts: 2` means one retry: the welcome'd first connection, plus the retry the server kills
      // before the script can run.
      reconnect: {
        enabled: true,
        jitter: 0,
        baseDelayMs: 20,
        maxDelayMs: 40,
        maxAttempts: 2,
        coldStartFastRetries: 0,
      },
    });

    const attempts: number[] = [];
    const stops: string[] = [];
    // Registered BEFORE connect(): the documented usage order, and the reason the facade has a
    // pre-connect queue at all.
    socket.onReconnect((event) => attempts.push(event.plan.attempt));
    socket.onStopped((event) => stops.push(event.reason));

    await socket.start();
    await socket.waitUntilReady();

    // The next connection dies before the script, so the second close exhausts `maxAttempts: 2`.
    await server.closeNextConnection(4400, 'idle timeout');
    await server.forceClose(4400, 'idle timeout');

    await until(() => stops.length > 0, 'the budget-exhausted stop');
    assert.equal(attempts.length, 1, `expected one reported plan, got ${JSON.stringify(attempts)}`);
    assert.match(stops[0] ?? '', /budget exhausted|Reconnect refused/);
    assert.equal(socket.willReconnect, false, 'the client has stopped, so no retry is in flight');
    assert.equal(server.connectionCount, 2, 'the budget admitted exactly one retry');
    assert.equal(socket.reconnectAttempt, 1, 'the policy made exactly one retry for this session');
  });

  it('allows a second connect() after a failed first connect', async () => {
    const port = await closedPort();
    const socket = new RoomSocket({
      host: '127.0.0.1',
      port,
      tls: false,
      version: '1157',
      room: 'testroom',
      reconnect: { enabled: false },
      openTimeoutMs: 500,
    });
    sockets.push(socket);

    const first = await socket.start().then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(first instanceof Error, 'connecting to a closed port must fail');

    // The first attempt never became a connection, so the guard must still mean "already connected".
    // Before the fix `this.client` was assigned before the await and left set on failure, so this second
    // call threw "already been called" although no connection had ever been made.
    const second = await socket.start().then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(second instanceof Error, 'a second connect() must be attempted rather than refused up front');
    assert.doesNotMatch(second.message, /already been called/);
  });

  it('keeps onClose/onOpen/onReady delivering after a reconnect', async () => {
    // `openConnection` builds a *new* `ClientCore` on every attempt, and these three names used to route
    // to `onCore`, a binding to the core that existed at subscribe time. After the first reconnect they
    // silently stopped firing while `onReconnect` (bound to the stable client) kept going, which is the
    // asymmetry Phase 2.7 Part A exists to remove.
    const server = await mock();
    const socket = makeSocket(server, {
      reconnect: { enabled: true, jitter: 0, baseDelayMs: 20, maxDelayMs: 40, maxAttempts: 3 },
    });

    const closes: number[] = [];
    const opens: number[] = [];
    const readies: string[] = [];
    const genericCloses: number[] = [];
    socket.onClose((info) => closes.push(info.code));
    socket.onOpen(() => opens.push(1));
    socket.onReady(() => readies.push('ready'));
    // The shared name through the generic escape hatch must survive the reconnect too. Its payload is the
    // headless `{ info, analysis, willReconnect }`, which this route has always delivered, and
    // since 4.2 the core emits the same wrapper, so the `'info' in event` shape-probe that used to guard a
    // migration window is gone and the payload is read directly.
    socket.on('close', (event) => {
      genericCloses.push(event.info.code);
    });

    await socket.start();
    await socket.waitUntilReady();
    // A subscription made after `connect()` has already missed the first `open`: that event is emitted
    // synchronously inside `connect()`, while the facade can only attach afterwards. `ready` and `close`
    // are still to come, so those are delivered.
    assert.equal(opens.length, 0, 'the first open is already past when a post-connect subscription attaches');
    assert.equal(readies.length, 1, 'the first ready is delivered');
    assert.equal(closes.length, 0, 'nothing has closed yet');

    // Force a close the policy answers with a retry, then wait for the replacement connection.
    await server.forceClose(4400, 'forced by test');
    await until(() => server.connectionCount >= 2, 'the reconnect to open a second connection');
    await until(() => opens.length >= 1, 'the open on the reconnected socket');
    await until(() => readies.length >= 2, 'the second ready after the reconnect');

    assert.equal(closes.length, 1, 'onClose must see the first close');
    assert.equal(genericCloses.length, 1, 'the generic close subscription must see it too');
    assert.equal(opens.length, 1, 'onOpen must fire on the reconnected socket, not just the first');
    assert.equal(readies.length, 2, 'onReady must fire on the reconnected socket');

    // And a close on the *new* connection must still reach both routes: this is what proves the
    // subscription followed the reconnect rather than surviving only as a stale first-core binding.
    await server.forceClose(4400, 'forced by test again');
    await until(() => closes.length >= 2, 'the second close to reach onClose');
    assert.equal(closes[1], 4400, 'the reconnected close is the one the facade delivered');
    assert.equal(genericCloses.length, 2, 'the generic route followed the reconnect as well');
  });

  it('releases queued subscriptions when a socket is destroyed before connecting', async () => {
    const socket = new RoomSocket({ version: '1', room: 'testroom' });
    sockets.push(socket);
    socket.onWelcome(() => undefined);
    socket.onReady(() => undefined);
    socket.onClose(() => undefined);

    assert.equal(socket.queuedSubscriptionCount, 3, 'pre-connect subscriptions must be queued');

    await socket.stop();
    assert.equal(
      socket.queuedSubscriptionCount,
      0,
      'a never-connected socket must release its queued handlers instead of retaining them forever',
    );
  });
});

// ------------------------------------------------------------------------------------
// The contract suite, formerly `tests/room-socket-contract.test.ts`, merged in here
// ------------------------------------------------------------------------------------
//
// WHY THESE LIVE TOGETHER NOW
//
// Both files tested `src/room-socket.ts`. The contract file stood alone only because it carried its own copy
// of the scaffolding above: its own `servers`/`sockets` arrays and `after` teardown, its own `mock()`, and
// its own `track()`/`makeSocket()` pair. That copy had already drifted: the two `makeSocket()` definitions
// were equivalent but separately maintained, and only the copy used `track()`. Two scaffolds for one module
// mean every fixture change has to be made twice and nothing forces the two halves to agree on what the
// facade's surface is, so they now share one scaffold and one file.
//
// WHAT THE CONTRACT HALF PINS
//
// `RoomSocket` against `MgClient`: the axes it shares, and the three members where it diverges on purpose.
// Two things are pinned here, and both are invariant I6 ("identity is a resolved value, never a
// placeholder"). `RoomSocket.playerId` used to answer `''` before the first `Welcome`, which a caller
// cannot tell apart from a real id; the contract's answer is `null`. And the verb pair is `start`/`stop`
// rather than `connect`/`disconnect`/`destroy`, so the names a contract-aware caller uses are the ones
// this class answers. The `playerId` name survives as the reference-shaped alias and must answer the
// same resolved value, a second spelling and not a second answer.
//
// `RoomSocket` is **not** an `MgClient`: `ClientCore`, `HeadlessClient` and `BootstrappedClient` each
// assign to `MgClient<...>` in their own test as the compile-time half of the contract. `RoomSocket`
// cannot, and these tests do not claim it does: its reason to exist is fidelity to the reference API,
// which types three members differently. The divergences, compile-checked:
//
//   - `start(): Promise<string>`: it resolves to the connect URL, the reference's documented return,
//     which the test below asserts. `Promise<string>` is not assignable to the contract's `Promise<void>`.
//   - `events: Emitter<HeadlessClientEvents> | null`: the underlying `HeadlessClient` is not constructed
//     until the first `start()`, so there is no emitter to hand out before then; the contract's `events`
//     is non-null (`ClientCore` is its own emitter, a facade over a lazily-built client is not).
//   - `lastError` is absent. `report.errors` is this facade's diagnostic surface; a second accessor would
//     be a second answer to the same question.
//
// The shared axes do hold (one verb pair, one `report`, one resolved identity accessor, one `isReady`),
// and the describe block below asserts exactly those at compile time, so the three exclusions above are
// the whole of the difference rather than an unstated drift.

describe('RoomSocket: identity is a resolved value, never a placeholder', () => {
  it('answers null before the first Welcome, under both names', () => {
    const socket = track(new RoomSocket({ version: '1', room: 'testroom' }));

    // `assert.ok(x === null)` rather than `assert.equal(x, null)`: node's `equal` is declared
    // `asserts actual is T`, so it narrows the *property path* to `null` and every later read of the same
    // accessor is `never` to the compiler (the getter is not constant across calls at runtime).
    assert.ok(
      socket.playerId === null,
      "the reference-shaped alias must not answer '' for an identity the server has not assigned",
    );
    assert.ok(socket.selfPlayerId === null, 'unknown identity is null, never a placeholder');
  });

  it('stays null after start() until Welcome assigns it', async () => {
    // A delayed Welcome is what makes "before Welcome" observable rather than a race: `start()` resolves
    // once the socket is open and the handshake is written, which is *not* readiness.
    const server = await mock({ pingIntervalMs: 0, welcomeDelayMs: 300 });
    const socket = makeSocket(server);

    const url = await socket.start();
    assert.ok(url.includes('/version/'), `start() resolves to the URL that was opened: ${url}`);

    // Read the identity into a local first. `assert.equal(property, null)` narrows the *property path*
    // to `null` for the rest of the block, so a later read of the same getter compiles as `never`.
    const beforeWelcome: string | null = socket.selfPlayerId;
    assert.equal(beforeWelcome, null, 'the server has not assigned an id yet');
    assert.equal(socket.playerId, beforeWelcome, 'the alias reads the same value');

    await socket.waitUntilReady();

    const assigned: string | null = socket.selfPlayerId;
    assert.ok(
      typeof assigned === 'string' && assigned.length > 0,
      `Welcome must populate the identity, got ${String(assigned)}`,
    );
    assert.equal(socket.playerId, assigned);
  });
});

describe('RoomSocket: the contract verbs and the diagnostic surface', () => {
  it('refuses a second start() with an MgConfigError', async () => {
    const server = await mock();
    const socket = makeSocket(server);

    await socket.start();
    await assert.rejects(socket.start(), MgConfigError);
  });

  it('shares the contract axes the header claims, and only those', () => {
    const socket = track(new RoomSocket({ version: '1', room: 'testroom' }));

    // The compile-time half of the header's claim. `start`, `events` and `lastError` are the three
    // deliberate divergences named there, so they are excluded rather than faked; every other axis must
    // assign. A `MgClient<...> = socket` assignment here would be false and does not compile.
    const shared: Pick<
      MgClient<HeadlessClientEvents>,
      'stop' | 'isReady' | 'selfPlayerId' | 'report'
    > = socket;

    assert.equal(typeof shared.stop, 'function');
    assert.equal(shared.isReady, false);
    assert.equal(shared.selfPlayerId, null);
    assert.equal(shared.report.kind, 'headless');
  });

  it('reports the shared axes before start(), and the underlying report after it', async () => {
    const server = await mock();
    const socket = makeSocket(server);

    assert.equal(socket.report.kind, 'headless');
    assert.equal(socket.report.started, false);
    assert.equal(socket.report.selfPlayerId, null);
    assert.equal(socket.report.queuedSubscriptionCount, 0, 'nothing is queued on a socket nobody wired up');

    await socket.start();
    await socket.waitUntilReady();

    assert.equal(socket.report.started, true);
    assert.equal(socket.report.ready, true);
    assert.equal(socket.report.selfPlayerId, socket.selfPlayerId);
    assert.equal(socket.report.kind, 'headless');
  });

  it('exposes the underlying client emitter once start() has run, and null before it', async () => {
    const server = await mock();
    const socket = makeSocket(server);

    // A local, for the same `assert.equal(property, ...)` narrowing reason as above.
    const beforeStart = socket.events;
    assert.equal(beforeStart, null, 'there is no client to subscribe to before start()');

    await socket.start();
    assert.equal(socket.events, socket.underlying.events, 'one bus, not a facade-owned second one');

    const events = socket.events;
    assert.ok(events !== null, 'the emitter is reachable once start() has run');
    const readies: string[] = [];
    events.on('ready', () => readies.push('ready'));
    await socket.waitUntilReady();
    assert.equal(readies.length, 1);
  });

  it('stop() suppresses reconnect, like the disconnect() it replaces', async () => {
    const server = await mock();
    const socket = makeSocket(server);
    await socket.start();
    await socket.waitUntilReady();

    const connectionsBefore = server.connectionCount;
    await socket.stop();
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(server.connectionCount, connectionsBefore, 'stop() must not reconnect');
  });
});
