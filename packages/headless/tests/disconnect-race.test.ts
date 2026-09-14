/**
 * A shutdown must cancel a wait instead of serving it out.
 *
 * Two defects, one file, because both are the same shape: `disconnect()` sets `localShutdown` and then
 * something the client is still waiting on ignores it.
 *
 *   - While a reconnect is parked in its backoff, `disconnect()` awaited the whole delay
 *     (audit 06 §3 measured 5256 ms with a 5 s policy; the default policy reaches 60 s).
 *   - A `connect()` that is still inside one of its own awaits when `disconnect()` returns could
 *     install a live transport and a core afterwards, and then emit `open` on a client the caller
 *     believes is closed.
 *
 * The races are made deterministic rather than timing-dependent: the second test parks `connect()` in
 * an injected version fetch and only releases it *after* `disconnect()` has returned, so "the socket
 * was installed afterwards" is observed, not hoped for. The first test's bound is real wall-clock time
 * around a genuine 5 s backoff, because that is the thing being measured.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { HeadlessClientOptions } from '../src/client.js';
import { HeadlessClient } from '../src/client.js';
import { VersionResolver } from '../src/version.js';
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

/** Build a client wired to a mock server, with a pinned version unless a resolver is injected. */
function makeClient(server: MockServer, overrides: Partial<HeadlessClientOptions> = {}): HeadlessClient {
  const client = new HeadlessClient({
    host: server.host,
    port: server.port,
    tls: false,
    version: server.version,
    room: 'testroom',
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

describe('HeadlessClient: a shutdown cancels the waits it can', () => {
  it('disconnect() during a reconnect backoff resolves in well under the backoff', async () => {
    const server = await mock({ pingIntervalMs: 0 });
    // A genuine 5 s wait: jitter off so the pending delay is exactly `maxDelayMs`.
    const client = makeClient(server, {
      reconnect: { jitter: 0, baseDelayMs: 5000, maxDelayMs: 5000, coldStartFastRetries: 0 },
    });

    await client.start();
    await client.waitUntilReady();

    const reconnecting = new Promise<void>((resolve) => {
      client.on('reconnect', () => resolve());
    });
    await server.forceClose(4400, 'idle timeout');
    await reconnecting;

    const t0 = Date.now();
    await client.stop();
    const elapsed = Date.now() - t0;

    // `disconnect()` also waits (bounded, ≤300 ms) for the already-closed socket to report its close, so
    // the bound sits an order of magnitude below the 5000 ms backoff rather than at 50 ms. A `disconnect`
    // that serves out the backoff takes ~5000 ms and cannot satisfy this.
    assert.ok(elapsed < 1000, `disconnect() took ${elapsed}ms; the pending backoff was 5000ms`);
  });

  it('disconnect() does not leave a socket installed after it returns', async () => {
    const server = await mock({ pingIntervalMs: 0 });

    // Park `connect()` inside the version fetch. Releasing the gate after `disconnect()` returns puts the
    // rest of `openConnection` strictly after the shutdown, which is where the leak was.
    const entered = { mark: (): void => undefined };
    const enteredPromise = new Promise<void>((resolve) => {
      entered.mark = () => resolve();
    });
    const gate = { release: (): void => undefined };
    const parked = new Promise<void>((resolve) => {
      gate.release = () => resolve();
    });
    const resolver = new VersionResolver({
      fetcher: async () => {
        entered.mark();
        await parked;
        return server.version;
      },
    });

    const client = makeClient(server, { version: undefined, versionResolver: resolver });

    const opens: number[] = [];
    client.on('open', () => opens.push(Date.now()));

    const connecting = client.start();
    await enteredPromise;

    await client.stop();
    gate.release();
    await connecting.catch(() => undefined);
    await delay(50);

    assert.deepEqual(opens, [], 'an open event fired after disconnect() had already returned');
    assert.equal(
      client.transport,
      null,
      'a transport was installed on a client that had already disconnected',
    );
    assert.equal(client.isConnecting, false, 'the client still reports a connection in flight');
  });
});
