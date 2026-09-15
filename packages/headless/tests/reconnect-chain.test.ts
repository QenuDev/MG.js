/**
 * Honest reconnect accounting: `willReconnect: true` must mean the chain is still alive.
 *
 * The defect this file pins down (audit 06 §1, measured trace `['close 4400 willReconnect=true',
 * 'reconnect plan.attempt=1', 'close 1006 willReconnect=true']`, then silence): a reconnect attempt that
 * fails *before the socket opens* reports `willReconnect: true` and then kills the chain forever.
 *
 * The failure path is re-entrant. `openConnection`'s catch routes a pre-open failure through
 * `handleSyntheticClose` → `handleClose` → `afterClose` → `scheduleReconnect`, and that call arrives
 * while the reconnect task that is running it is still non-null, so the old guard "a task is already
 * running, drop the plan" threw the plan away. `stopped` is only reachable from the `plan === null`
 * branch, so nothing reported the stop either: with the documented `maxAttempts: Infinity` the client
 * went quiet after exactly one retry.
 *
 * WHY THE SEAM IS AN AUTH PROVIDER AND NOT `versionOptions.fetcher`
 * -----------------------------------------------------------------
 * The task plan suggests making the *second* `versionOptions.fetcher` call throw. That cannot produce a
 * pre-open failure: `VersionResolver` caches the first success for `ttlMs` (5 minutes by default), and a
 * fetch that throws with a cached value present returns the cache instead of rethrowing
 * (`packages/headless/src/version.ts`, the `if (version === null)` branch). Measured: the fetcher runs
 * once, the retry reuses the cached version, and the client is `ready` again on the second connection.
 * The chain never broke, so the test would have been asserting nothing.
 *
 * `AuthProvider.prepare()` is step 2 of `openConnection`, before any socket is allocated, so a throw
 * there lands on the same synthetic-1006 path the audit measured. It is also deterministic: a
 * call counter, no clock, no server-side race.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { AuthContribution, AuthProvider } from '../src/auth/types.js';
import type { HeadlessClientOptions } from '../src/client.js';
import { HeadlessClient } from '../src/client.js';
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
    // No jitter and a short backoff: these tests assert *that* the chain keeps running, not how long a
    // production backoff should be (`backoff.test.ts` owns the delay numbers).
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

/** Poll until `predicate` is true, or fail loudly with a useful message. */
async function until(predicate: () => boolean, description: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

/**
 * An auth provider that stops working on a chosen `prepare()` call.
 *
 * Models "the dependency broke between the first connect and the retry". Because `prepare()` runs before
 * the socket exists, the throw is a *pre-open* failure, the case whose plan used to be dropped.
 */
class FlakyAuthProvider implements AuthProvider {
  readonly id = 'flaky';
  readonly authenticated = false;
  /** How many `prepare()` calls have been made, so a test can prove attempts really continued. */
  calls = 0;

  constructor(private readonly failFromCall: number) {}

  async prepare(): Promise<AuthContribution> {
    this.calls += 1;
    if (this.calls >= this.failFromCall) throw new Error('credentials unavailable (test)');
    return {};
  }
}

describe('HeadlessClient: a reconnect chain must not die silently', () => {
  it('continues the chain when a pre-open attempt fails', async () => {
    const server = await mock({ pingIntervalMs: 0 });
    const auth = new FlakyAuthProvider(2);
    const client = makeClient(server, { auth });

    const reconnectAttempts: number[] = [];
    client.on('reconnect', ({ plan }) => reconnectAttempts.push(plan.attempt));

    await client.start();
    await client.waitUntilReady();
    assert.equal(server.connectionCount, 1);

    // A welcomed session, force-closed the way audit 06 §1 did it: the 4400 schedules attempt 1, and that
    // attempt then dies in `auth.prepare()` before a socket is ever allocated.
    const closed = await server.forceClose(4400, 'idle timeout');
    assert.equal(closed, 1);

    // Long enough for several backoff steps (20/40/80 ms) and their pre-open failures.
    await delay(500);

    // The discriminator: a parked plan that is *drained* schedules another attempt, so the reconnect
    // event count keeps growing. The defect reported `willReconnect: true` and then emitted nothing:
    // one event only, `client.stopped === null`, and `auth.calls === 2` forever.
    assert.ok(
      reconnectAttempts.length >= 2,
      `the chain stopped after ${reconnectAttempts.length} reconnect event(s) ` +
        `(attempts ${reconnectAttempts.join(', ')}) while the policy allows unlimited retries`,
    );
    assert.ok(
      auth.calls >= 3,
      `only ${auth.calls} connect attempt(s) reached the failing dependency; a dropped plan never retries`,
    );
    assert.equal(client.stopped, null, 'the policy still allows retries, so nothing may report a stop');
    assert.equal(client.willReconnect, true, 'a scheduled retry must be visible to the host');

    await client.stop();
  });

  it('emits stopped once with a reason when the budget is spent', async () => {
    const server = await mock({ pingIntervalMs: 0 });
    // Fails on every attempt, so the only thing that can end this chain is the declared budget.
    const auth = new FlakyAuthProvider(1);
    const client = makeClient(server, {
      auth,
      reconnect: { jitter: 0, baseDelayMs: 5, maxDelayMs: 10, maxAttempts: 3, coldStartFastRetries: 0 },
    });

    // One ordered trace, so "no reconnect after stopped" is a statement about the real ordering rather
    // than about two independently-sampled counters.
    const events: string[] = [];
    const stoppedReasons: string[] = [];
    client.on('reconnect', ({ plan }) => events.push(`reconnect:${plan.attempt}`));
    client.on('stopped', ({ reason }) => {
      stoppedReasons.push(reason);
      events.push('stopped');
    });

    await client.start().catch(() => undefined);
    await until(() => client.stopped !== null, 'the client to report why it stopped');
    const stoppedAt = events.indexOf('stopped');
    // Any late plan would have to survive a whole backoff step (5 to 10 ms) plus its failed pre-open
    // attempt.
    await delay(150);

    assert.equal(
      stoppedReasons.length,
      1,
      `expected exactly one stopped event, saw ${stoppedReasons.length}`,
    );
    const reason = stoppedReasons[0] ?? '';
    assert.ok(reason.length > 0, 'a stop must carry a reason');
    assert.equal(client.stopped, reason, 'the getter must report the same reason it emitted');
    assert.equal(
      events.slice(stoppedAt + 1).some((event) => event.startsWith('reconnect:')),
      false,
      `a reconnect was scheduled after the stop: ${events.join(' → ')}`,
    );
    assert.equal(client.willReconnect, false, 'nothing is scheduled after the budget is spent');
    assert.equal(client.isReady, false);
  });

  it('does not drain a parked plan after a deliberate disconnect', async () => {
    const server = await mock({ pingIntervalMs: 0 });
    // Fails on the *first* retry, so that retry's own task routes its synthetic pre-open close through
    // `afterClose` → `scheduleReconnect` while it is still the running task: that is the parked case,
    // not a plan sitting in a backoff with no task behind it.
    const auth = new FlakyAuthProvider(2);
    const client = makeClient(server, { auth });

    const reconnectAttempts: number[] = [];
    client.on('reconnect', ({ plan }) => reconnectAttempts.push(plan.attempt));

    await client.start();
    await client.waitUntilReady();

    // Proof that the plan really was parked: this close is emitted by the pre-open failure *while a
    // retry is already running* (`retriesWhenParked === 1`), so `scheduleReconnect` takes its "a task is
    // already running, park it" branch instead of scheduling directly.
    let parkedCloseWillReconnect: boolean | null = null;
    let retriesWhenParked = -1;
    const disconnected = new Promise<void>((resolve) => {
      client.on('close', ({ info, willReconnect }) => {
        if (info.code !== 1006) return;
        parkedCloseWillReconnect = willReconnect;
        retriesWhenParked = reconnectAttempts.length;
        // The park is written synchronously just after this handler returns, and the running task's
        // `finally` drains it in a later microtask. Queuing at this point is the only way to run in the
        // gap between those two moments, and the only public-surface way to shut down while a plan is
        // parked.
        queueMicrotask(() => {
          void client.stop().then(resolve);
        });
      });
    });

    await server.forceClose(4400, 'idle timeout');
    await disconnected;
    // Long enough for a drained plan to serve a whole backoff step (20 ms) and reconnect.
    await delay(150);

    assert.equal(parkedCloseWillReconnect, true, 'the close under test decided to reconnect');
    assert.equal(retriesWhenParked, 1, 'the plan must have arrived while a retry was already running');
    assert.equal(
      reconnectAttempts.length,
      1,
      `a shutdown must leave the parked plan undrained, saw attempts ${reconnectAttempts.join(', ')}`,
    );
    assert.equal(client.willReconnect, false);
    assert.equal(client.isConnecting, false);
    assert.equal(client.transport, null, 'the failed retry never allocated a socket');
    assert.equal(server.connectionCount, 1);
  });
});
