/**
 * Credential containment: `mc_jwt` never leaves the transport.
 *
 * DESIGN I3, "no credential ever leaves the transport", is a runtime property, not a code-review
 * property, so every test here works from what a caller can actually observe: the event payloads a
 * subscriber receives, the records a `MemoryLogSink` holds, and whether a session was ever announced as
 * ready. Each one serialises the whole capture and asserts the sentinel token substring is absent, which
 * is the only assertion that survives a future rename of the field that carries it.
 *
 * The injected-factory case is the interesting one: an injected constructor is a promise the host makes
 * ("this one can send headers"), and when it turns out it cannot, the credential is dropped. The client
 * must fail closed rather than report a session that was never authenticated.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { MemoryLogSink } from '@mg.js/common';
import { CookieAuthProvider } from '../src/auth/cookie.js';
import type { HeadlessClientOptions } from '../src/client.js';
import { HeadlessClient } from '../src/client.js';
import type { SocketLike, WebSocketFactory } from '../src/transport/runtime.js';
import type { MockServer } from './fixtures/mock-server.js';
import { startMockServer } from './fixtures/mock-server.js';

/** A JWT-shaped sentinel. Three base64url segments; the header decodes to `{"`, the documented shape. */
const SENTINEL_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJwXzEiLCJpYXQiOjE3MDAwMDAwMDB9.c2lnbmF0dXJlLXNlbnRpbmVs';

const servers: MockServer[] = [];
const clients: HeadlessClient[] = [];

after(async () => {
  for (const client of clients.splice(0)) {
    try {
      await client.stop();
    } catch {
      // Best effort teardown; the runner must still exit.
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

async function mock(options: Parameters<typeof startMockServer>[0] = {}): Promise<MockServer> {
  const server = await startMockServer(options);
  servers.push(server);
  return server;
}

function makeClient(server: MockServer, overrides: Partial<HeadlessClientOptions> = {}): HeadlessClient {
  const client = new HeadlessClient({
    host: server.host,
    port: server.port,
    tls: false,
    version: server.version,
    room: 'testroom',
    reconnect: { jitter: 0, baseDelayMs: 20 },
    openTimeoutMs: 2000,
    ...overrides,
  });
  clients.push(client);
  return client;
}

/**
 * A constructable, header-incapable WebSocket factory.
 *
 * It has to behave like a WebSocket *constructor*: `StandaloneTransport` calls `new runtime.factory(...)`
 * and uses the instance as the socket, so a class whose work happened in a separate `build()` method
 * would hand the transport a useless object. The constructor therefore returns the socket directly, the
 * way `ws` does, and records the call count so a test can prove the injected factory is the one used.
 *
 * A function returning a class rather than `class ... implements WebSocketFactory`: TypeScript cannot see
 * that a class constructor satisfies an interface's construct signature, while an object whose call
 * signature and `prototype` line up, which is how `isConstructor` inspects it at runtime, is checked
 * structurally.
 */
function headerlessFactory(): { factory: WebSocketFactory; calls: () => number } {
  let calls = 0;
  class HeaderlessFactory implements SocketLike {
    static supportsConnectHeaders = false;

    readonly readyState = 1;

    constructor() {
      calls += 1;
    }

    close(): void {}
    send(): void {}
    removeEventListener(): void {}

    addEventListener(...args: [string, ...unknown[]]): void {
      const [type, listener] = args;
      if (type === 'open' && typeof listener === 'function') listener();
    }
  }
  return { factory: HeaderlessFactory as unknown as WebSocketFactory, calls: () => calls };
}

describe('HeadlessClient: the credential never leaves the transport', () => {
  it('never puts the session cookie into an event payload or a log line', async () => {
    const server = await mock({ pingIntervalMs: 0 });
    const sink = new MemoryLogSink();
    const payloads: unknown[] = [];

    const { factory, calls } = headerlessFactory();

    const client = makeClient(server, {
      auth: new CookieAuthProvider({ token: SENTINEL_JWT }),
      webSocketFactory: factory,
      // Observe the degradation instead of failing on it, so every reporting path runs.
      requireHeadersForAuth: false,
      logLevel: 'debug',
      logSink: sink,
    });
    for (const event of client.eventNames()) {
      client.on(event, (...args: unknown[]) => {
        payloads.push({ event, args });
      });
    }

    await client.start().catch(() => undefined);

    const serializedEvents = JSON.stringify(payloads);
    const serializedLogs = JSON.stringify(sink.snapshot());
    assert.ok(
      !serializedEvents.includes(SENTINEL_JWT),
      `an event payload carried the token: ${serializedEvents}`,
    );
    assert.ok(!serializedLogs.includes(SENTINEL_JWT), `a log record carried the token: ${serializedLogs}`);

    // The degradation is reported under one name now. Phase 4.3 deleted the deprecated
    // `headersUnsupported` event, whose payload carried a redacted copy of the bag, so this asserts two
    // things: the surviving payload names the lost headers, and the removed name is not emitted at all.
    const deprecated = payloads.filter((entry) => JSON.stringify(entry).includes('"headersUnsupported"'));
    const dropped = payloads.filter((entry) => JSON.stringify(entry).includes('"headers-dropped"'));
    assert.equal(deprecated.length, 0, `the removed event name must not be emitted: ${serializedEvents}`);
    assert.equal(dropped.length, 1, serializedEvents);
    // The payload reports which headers were lost by name, and carries no values at all.
    assert.ok(JSON.stringify(dropped[0]).includes('Cookie'), JSON.stringify(dropped[0]));

    // The constructor was reached once, and the transport, which builds the options bag from
    // `runtime.supportsHeaders`, had nothing to put in it.
    assert.equal(calls(), 1, serializedEvents);
  });

  it('fails closed when the factory cannot send headers and the cookie is required', async () => {
    const server = await mock({ pingIntervalMs: 0 });
    const sink = new MemoryLogSink();
    const payloads: unknown[] = [];

    const { factory } = headerlessFactory();

    const client = makeClient(server, {
      auth: new CookieAuthProvider({ token: SENTINEL_JWT }),
      webSocketFactory: factory,
      requireHeadersForAuth: true,
      logLevel: 'debug',
      logSink: sink,
    });
    for (const event of client.eventNames()) {
      client.on(event, (...args: unknown[]) => {
        payloads.push({ event, args });
      });
    }

    await assert.rejects(
      () => client.start(),
      (error: Error) => {
        assert.equal(error.name, 'MgConfigError');
        assert.match(error.message, /header/i);
        assert.ok(!error.message.includes(SENTINEL_JWT), error.message);
        return true;
      },
    );

    // Fail closed: the socket was never opened, and the session is not reported as authenticated.
    assert.equal(client.isReady, false);
    assert.equal(server.connectionCount, 0);
    assert.equal(client.headersBlocked, true, 'the caller must be able to tell why');
    assert.ok(!JSON.stringify(payloads).includes(SENTINEL_JWT), JSON.stringify(payloads));
    assert.ok(!JSON.stringify(sink.snapshot()).includes(SENTINEL_JWT), JSON.stringify(sink.snapshot()));
  });

  it('does not reach ready when an unqualified factory silently drops the cookie', async () => {
    // The audit's probe: an injected global constructor plus a cookie. Before the fix the client
    // resolved the connect, received Welcome over the unauthenticated socket, and reported `isReady:
    // true` with `cookie = null` on the wire.
    const server = await mock({ pingIntervalMs: 0, welcomeDelayMs: 10 });
    const sink = new MemoryLogSink();
    const payloads: unknown[] = [];

    const client = makeClient(server, {
      auth: new CookieAuthProvider({ token: SENTINEL_JWT }),
      webSocketFactory: globalThis.WebSocket,
      requireHeadersForAuth: true,
      logLevel: 'debug',
      logSink: sink,
    });
    for (const event of client.eventNames()) {
      client.on(event, (...args: unknown[]) => {
        payloads.push({ event, args });
      });
    }

    await assert.rejects(() => client.start(), /header/i);

    assert.equal(client.isReady, false);
    assert.equal(server.connectionCount, 0, 'no anonymous socket may be opened for a cookie session');
    assert.ok(!JSON.stringify(payloads).includes(SENTINEL_JWT), JSON.stringify(payloads));
    assert.ok(!JSON.stringify(sink.snapshot()).includes(SENTINEL_JWT), JSON.stringify(sink.snapshot()));
  });
});
