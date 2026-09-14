/**
 * A deliberate `connect()` supersedes a reconnect attempt that is already inside `openConnection`.
 *
 * The parked half of this was fixed for `7b7e8c2`: a `connect()` cancels a plan parked in its backoff
 * by aborting the controller it captured. The adjacent window stayed open, and it is the same shape:
 * once an attempt has *passed* the sleep and is inside `openConnection`, the only supersession test it
 * ran was `localShutdown`, which `connect()` sets to `false`. So a stale attempt resumed, installed its
 * own transport and core over the healthy manual connection, or (if its socket had already been
 * allocated) synthesised a close, parked a plan, and had that plan's first act be
 * `detachTransport()`, disposing the connection `connect()` had just installed.
 *
 * Both orderings are pinned here, because they fail at different points:
 *
 *   - `auth.prepare()` is step 2 of `openConnection`, before any socket is allocated. Holding an
 *     attempt there and superseding it asserts the stale attempt installs *nothing*.
 *   - `transport.connect()` is the last await, after the transport and core are already installed.
 *     Holding an attempt there and superseding it asserts the stale attempt *schedules* nothing. The
 *     socket it allocated is already lost to the supersession, but a reconnect scheduled from its
 *     failure would tear down the replacement connection.
 *
 * Neither race is timing-dependent: the held attempt is parked on a promise the test controls, and the
 * superseding `connect()` completes (and is observed `ready`) before that promise is released.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { WebSocket as NodeWebSocket } from 'ws';
import type { AuthContribution, AuthProvider } from '../src/auth/types.js';
import type { HeadlessClientOptions } from '../src/client.js';
import { HeadlessClient } from '../src/client.js';
import type { SocketLike, WebSocketFactory } from '../src/transport/runtime.js';
import type { MockServer } from './fixtures/mock-server.js';
import { startMockServer } from './fixtures/mock-server.js';

/** Every server started by a test, torn down afterwards so the runner exits. */
const servers: MockServer[] = [];
/** Every client started by a test, destroyed afterwards so the runner exits. */
const clients: HeadlessClient[] = [];

after(async () => {
  for (const client of clients.splice(0)) {
    try {
      await client.stop();
    } catch {
      // Best effort.
    }
  }
  for (const server of servers.splice(0)) {
    try {
      await server.stop();
    } catch {
      // Best effort.
    }
  }
});

/** Start a mock server and track it for teardown. */
async function mock(options: Parameters<typeof startMockServer>[0] = {}): Promise<MockServer> {
  const server = await startMockServer(options);
  servers.push(server);
  return server;
}

/** Build a client wired to a mock server, with a pinned version so no network call can happen. */
function makeClient(server: MockServer, overrides: Partial<HeadlessClientOptions> = {}): HeadlessClient {
  const client = new HeadlessClient({
    host: server.host,
    port: server.port,
    tls: false,
    version: server.version,
    room: 'testroom',
    reconnect: { jitter: 0, baseDelayMs: 20, maxDelayMs: 80 },
    ...overrides,
  });
  clients.push(client);
  return client;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * An auth provider whose chosen `prepare()` call parks until the test releases it.
 *
 * `prepare()` runs before the URL is built and before any socket exists, so parking here holds an
 * attempt open at the earliest point where a superseding `connect()` used to be ignored.
 */
class GatedAuthProvider implements AuthProvider {
  readonly id = 'gated';
  readonly authenticated = false;
  private calls = 0;

  constructor(
    private readonly parkedCall: number,
    private readonly onEnter: () => void,
    private readonly gate: Promise<void>,
  ) {}

  async prepare(): Promise<AuthContribution> {
    this.calls += 1;
    if (this.calls === this.parkedCall) {
      this.onEnter();
      await this.gate;
    }
    return {};
  }
}

/**
 * A WebSocket constructor that hands its *second* connection a socket which never opens.
 *
 * The transport builds its socket inside `connect()`, after `openConnection` has installed the
 * transport and the core, so a factory is the only seam that can hold an attempt *after* it has
 * allocated anything. Every other connection gets a real `ws` socket, so the client talks to
 * the mock server; the held one ignores its target because it never goes anywhere.
 */
function heldSecondSocket(): { factory: WebSocketFactory; entered: Promise<void> } {
  let calls = 0;
  const mark = { signal: (): void => undefined };
  const entered = new Promise<void>((resolve) => {
    mark.signal = () => resolve();
  });

  /** A socket frozen in `CONNECTING`: no open, no close, no error, ever. */
  class HeldSocket implements SocketLike {
    readonly readyState = 0;
    close(): void {}
    send(): void {}
    addEventListener(..._args: [string, ...unknown[]]): void {}
    removeEventListener(..._args: [string, ...unknown[]]): void {}
  }

  // A function expression rather than a `class`: returning a substitute socket from a class constructor
  // is a biome error (and a real foot-gun), while a `new`-called function returning an object is the
  // plain JavaScript `ws` itself relies on. `isConstructor` only needs a function with a `.prototype`,
  // and the `this` parameter is how a function says it is meant to be called with `new`.
  const factory = function (this: unknown, url: string): SocketLike {
    calls += 1;
    if (calls === 2) {
      mark.signal();
      return new HeldSocket();
    }
    return new NodeWebSocket(url) as unknown as SocketLike;
  };

  // TypeScript cannot see a call signature satisfying a construct signature; the double assertion is
  // the same bridge the credential-leak test uses for its injected factory.
  return { factory: factory as unknown as WebSocketFactory, entered };
}

describe('HeadlessClient: a superseded attempt abandons its result', () => {
  it('installs nothing when a connect() supersedes it before allocation', async () => {
    const server = await mock({ pingIntervalMs: 0 });
    const mark = { signal: (): void => undefined };
    const entered = new Promise<void>((resolve) => {
      mark.signal = () => resolve();
    });
    const release = { run: (): void => undefined };
    const gate = new Promise<void>((resolve) => {
      release.run = () => resolve();
    });
    // Call 1 is the initial connect, call 2 the reconnect attempt that parks, call 3 the manual one.
    const auth = new GatedAuthProvider(2, mark.signal, gate);
    const client = makeClient(server, { auth });

    await client.start();
    await client.waitUntilReady();
    assert.equal(server.connectionCount, 1);

    await server.forceClose(4400, 'idle timeout');
    await entered; // the retry is parked inside `openConnection`, before allocating anything

    await client.start();
    await client.waitUntilReady();
    const healthy = client.transport;
    assert.notEqual(healthy, null, 'the deliberate connect() must produce a transport');

    release.run(); // let the superseded attempt resume
    await delay(200);

    assert.equal(
      client.transport,
      healthy,
      'the superseded attempt installed its own transport over the healthy one',
    );
    assert.equal(
      server.connectionCount,
      2,
      'the superseded attempt opened a socket of its own on top of the healthy connection',
    );
    assert.equal(client.isReady, true, 'the healthy connection must still be the ready one');
    assert.equal(client.willReconnect, false, 'the superseded attempt scheduled a retry');
  });

  it('schedules nothing when a connect() supersedes it inside the socket open', async () => {
    const server = await mock({ pingIntervalMs: 0 });
    const { factory, entered } = heldSecondSocket();
    const client = makeClient(server, { webSocketFactory: factory });

    await client.start();
    await client.waitUntilReady();
    assert.equal(server.connectionCount, 1);

    await server.forceClose(4400, 'idle timeout');
    await entered; // the retry now owns a transport and a core, and is awaiting `transport.connect`
    assert.equal(server.connectionCount, 1, 'the held socket never reaches the server');

    const closes: number[] = [];
    client.on('close', ({ info }) => closes.push(info.code));

    await client.start();
    await client.waitUntilReady();
    const healthy = client.transport;
    assert.notEqual(healthy, null, 'the deliberate connect() must produce a transport');

    // Long enough for a reconnect scheduled from the stale attempt's failure to serve a backoff step
    // (20 ms) and run its `detachTransport()`.
    await delay(200);

    assert.equal(
      client.transport,
      healthy,
      'a retry scheduled by the superseded attempt replaced the healthy transport',
    );
    assert.equal(
      server.connectionCount,
      2,
      'a retry scheduled by the superseded attempt opened an extra connection',
    );
    assert.deepEqual(closes, [], 'the healthy connection was closed');
    assert.equal(client.willReconnect, false, 'the superseded attempt scheduled a retry');
  });
});
