/**
 * The store a caller cached survives a reconnect (audit 03 F1).
 *
 * `ClientCore` builds a new store unless it is handed one, and the headless client builds a **new
 * `ClientCore` per connection**: that is the only way to attach a different transport, because the
 * transport seam is constructor-only and `stop()` is what releases the old listeners. So without a store
 * option the client handed back a different store object on every reconnect, and a caller who did the
 * documented thing
 *
 *     const store = client.store;
 *     store.subscribe('/data/players/0/coins', refresh);
 *
 * held a detached object: it stopped receiving patches, silently, with no error and no indication why.
 * `ClientCoreOptions.store` was added for this, and it was inert until this commit because no
 * in-repo caller ever passed it.
 *
 * The assertion that matters is not the identity alone, since a client that reported a stale-but-live
 * store would pass that. It is that the **subscription made before the reconnect still fires after
 * it**, on the same object.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { ObservableStore } from '@mg.js/common';
import { pollUntil } from '@mg.js/common';
import { HeadlessClient } from '../src/client.js';
import type { MockServer } from './fixtures/mock-server.js';
import { startMockServer } from './fixtures/mock-server.js';

const servers: MockServer[] = [];
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

async function mock(options: Parameters<typeof startMockServer>[0] = {}): Promise<MockServer> {
  const server = await startMockServer(options);
  servers.push(server);
  return server;
}

/** Poll until `predicate` is true, or fail loudly with a useful message. */
async function until(predicate: () => boolean, description: string, timeoutMs = 3000): Promise<void> {
  // `pollUntil` rather than a hand-rolled loop: `common/tests/poll.test.ts` fails the build on a new
  // deadline loop drifting from the poll module, and `common` cannot default the scheduler (it is
  // platform-free), so the timer seam is supplied here.
  const ok = await pollUntil<boolean>({
    attempt: () => (predicate() ? true : null),
    timeoutMs,
    intervalMs: 10,
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancelSchedule: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    onTimeout: () => false,
  });
  assert.ok(ok, `Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

/** A client wired to a mock server, with a short backoff so a reconnect is quick. */
function makeClient(server: MockServer): HeadlessClient {
  const client = new HeadlessClient({
    host: server.host,
    port: server.port,
    tls: false,
    version: server.version,
    room: 'testroom',
    reconnect: { jitter: 0, baseDelayMs: 20, maxDelayMs: 80 },
  });
  clients.push(client);
  return client;
}

describe('HeadlessClient: the store identity survives a reconnect', () => {
  it('reuses the same store and keeps its subscriptions alive', async () => {
    const server = await mock({ pingIntervalMs: 0 });
    const client = makeClient(server);

    await client.start();
    await client.waitUntilReady();

    // The caller caches the store and subscribes once, exactly as the docs describe. The mock server's
    // welcome seeds `coins` at 0 and every `HarvestCrop` it executes pushes a `PartialState` replacing it,
    // so this subscription has a real patch to observe.
    const cached: ObservableStore = client.store;
    let deliveries = 0;
    cached.subscribe('/data/players/0/coins', () => {
      deliveries += 1;
    });
    const coinsBefore = cached.get('/data/players/0/coins');
    const deliveriesBefore = deliveries;

    // Force a reconnectable close: `4400` is classified as a reconnect, not a stop.
    const closed = await server.forceClose(4400, 'idle timeout');
    assert.equal(closed, 1);

    await until(() => server.connectionCount >= 2, 'the second connection');
    await until(() => client.isReady, 'the reconnected client to be welcomed');

    assert.equal(client.store, cached, 'the store object identity must survive the reconnect');

    // A command on the *new* connection makes the server push a patch, so this proves the subscription
    // cached before the reconnect is still attached to the store the new core is writing to. Before the
    // fix the old core's `stop()` had emptied that store, so `deliveries` could never move again.
    const handle = client.actions.harvestCrop({ slot: 3 });
    const result = await handle;
    assert.equal(result.ok, true, 'the command must round-trip on the reconnected session');
    assert.ok(deliveries > deliveriesBefore, 'the cached subscription must fire on the new connection');
    assert.equal(cached.get('/data/players/0/coins'), 1, 'and the patch landed on the cached store');
    assert.notEqual(cached.get('/data/players/0/coins'), coinsBefore);

    await client.stop();
  });
});
