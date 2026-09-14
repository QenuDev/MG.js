/**
 * The `4710` loop must terminate with an honest reason, not run until the process dies.
 *
 * `4710`/`4700` are `requiresVersionRefetch` and `isBounded: false`, an unbounded retry by policy, and
 * the only thing that can end the loop is the version re-resolve either succeeding or failing. Before
 * Task 2.7 it could never fail: `refresh()` fell back to the cached value, so every retry re-sent the
 * version the server had just rejected and every connection was closed `4710` again. Nothing emitted
 * `stopped`, and a host had nothing to act on.
 *
 * The mock server closes *every* connection with `4710`, so the loop is mechanical here:
 * the real endpoint is the only thing that would otherwise stop it.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import type { CatalogKind } from '@mg.js/common';

import type { HeadlessClientOptions } from '../src/client.js';
import { HeadlessClient } from '../src/client.js';
import type { VersionSource } from '../src/version.js';
import { VersionResolver } from '../src/version.js';
import type { MockServer } from './fixtures/mock-server.js';
import { startMockServer } from './fixtures/mock-server.js';

/** Every server started by a test, torn down afterwards so the runner exits. */
const servers: MockServer[] = [];
/** Every client started by a test, destroyed afterwards so a looping client cannot outlive the run. */
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

/** Build a client wired to a mock server. */
function makeClient(server: MockServer, overrides: Partial<HeadlessClientOptions> = {}): HeadlessClient {
  const client = new HeadlessClient({
    host: server.host,
    port: server.port,
    tls: false,
    version: server.version,
    room: 'testroom',
    reconnect: { jitter: 0, baseDelayMs: 20, maxDelayMs: 40 },
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

/** Poll until `predicate` is true, or fail loudly rather than hanging. */
async function until(predicate: () => boolean, description: string, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

/** `1157` on the first read, then a payload `extractVersion` refuses: the version endpoint broke. */
class BrokenVersionSource implements VersionSource {
  readonly id = 'broken';
  calls = 0;

  async load(_kind: CatalogKind): Promise<unknown> {
    this.calls += 1;
    return this.calls === 1 ? '1157' : { version: { nested: 1 } };
  }
}

describe('HeadlessClient: a 4710 whose version cannot be re-resolved stops', () => {
  it('stops with a version reason instead of looping on 4710', async () => {
    const server = await mock({ pingIntervalMs: 0, alwaysClose: true, alwaysCloseCode: 4710 });
    const client = makeClient(server, {
      version: undefined,
      versionResolver: new VersionResolver({ source: new BrokenVersionSource() }),
    });

    const stops: string[] = [];
    client.on('stopped', ({ reason }) => stops.push(reason));

    await client.start().catch(() => undefined);
    await until(() => stops.length > 0, 'the client to stop instead of looping on 4710');
    // Settle: a client still looping keeps accepting connections, so this is what makes the bound below
    // a statement about the loop rather than about the instant the event fired.
    await delay(300);

    assert.equal(stops.length, 1, `expected exactly one stopped event, got ${JSON.stringify(stops)}`);
    assert.ok(client.stopped !== null, 'stopped must say why');
    assert.match(client.stopped ?? '', /version/i);
    assert.equal(client.willReconnect, false, 'nothing may still be retrying');
    assert.ok(server.connectionCount <= 2, `expected at most 2 connections, saw ${server.connectionCount}`);
  });
});

/**
 * A version source the test settles by hand.
 *
 * The bug is an *interleaving*, so the source has to be able to hold a refresh open while a newer
 * session starts and its own refresh succeeds. `ResolvedVersion` lives on the resolver, so the raw
 * payload here is just whatever `extractVersion` reads: `'1157'` succeeds, a malformed object fails.
 */
class DeferredVersionSource implements VersionSource {
  readonly id = 'deferred';
  private readonly calls: {
    settle: (value: unknown) => void;
  }[] = [];

  load(_kind: CatalogKind): Promise<unknown> {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const call = {
      value: '1157' as unknown,
      settle(value: unknown): void {
        call.value = value;
        release();
      },
    };
    this.calls.push(call);
    return gate.then(() => call.value);
  }

  /** Settle the call at `index` with a usable version. */
  succeed(index: number): void {
    this.calls[index]?.settle('1157');
  }

  /** Settle the call at `index` with a payload `extractVersion` refuses, so the resolver throws. */
  fail(index: number): void {
    this.calls[index]?.settle({ version: { nested: 1 } });
  }

  /** Wait until the source has been asked for a version `count` times. */
  async waitForCalls(count: number, description: string): Promise<void> {
    const deadline = Date.now() + 1500;
    while (this.calls.length < count && Date.now() < deadline) {
      await delay(5);
    }
    assert.ok(this.calls.length >= count, `Timed out waiting for ${description}`);
  }
}

describe('HeadlessClient: a superseded session cannot stop a newer one', () => {
  it('ignores a version-refresh failure from the session a newer connect() replaced', async () => {
    const server = await mock({ pingIntervalMs: 0 });
    const source = new DeferredVersionSource();
    const client = makeClient(server, {
      version: undefined,
      versionResolver: new VersionResolver({ source }),
      reconnect: { jitter: 0, baseDelayMs: 300, maxDelayMs: 300, maxAttempts: 5 },
    });

    const stops: string[] = [];
    client.on('stopped', ({ reason }) => stops.push(reason));

    // ---- Session A: connect, then get closed with 4710. Its reconnect (300 ms backoff) starts a strict
    // version refresh (source call 2), and then parks.
    const connectA = client.start();
    await source.waitForCalls(1, 'session A to resolve its version');
    source.succeed(0);
    await connectA;
    await client.waitUntilReady();
    await server.forceClose(4710, 'version mismatch');
    await source.waitForCalls(2, "session A's version refresh");

    // ---- Session B: a deliberate connect() supersedes A (aborting A's parked retry and clearing the
    // failure field) and connects with the cached version. It is then closed with 4710 as well, so it
    // schedules its *own* retry, which is the plan the stale failure must not be able to stop.
    await client.start();
    await client.waitUntilReady();
    await server.forceClose(4710, 'version mismatch');

    // A's refresh fails *late*, while B's retry is still inside its 300 ms backoff. The failure carries
    // A's message, but A is not the session that owns the retry about to run.
    source.fail(1);
    // Wait for whichever comes first: B's retry reaching the server, or the spurious stop that pre-empts
    // it. A stop is terminal, so a third connection is itself proof that no stop happened.
    await until(
      () => stops.length > 0 || server.connectionCount >= 3,
      "session B's retry to connect (or a stop to pre-empt it)",
    );

    assert.deepEqual(
      stops,
      [],
      `a superseded refresh failure must not stop the new session: ${stops[0] ?? ''}`,
    );
    assert.ok(server.connectionCount >= 3, 'session B reconnected instead of being stopped');
  });

  it('still stops when the current session\u2019s own version refresh fails', async () => {
    const server = await mock({ pingIntervalMs: 0 });
    const source = new DeferredVersionSource();
    const client = makeClient(server, {
      version: undefined,
      versionResolver: new VersionResolver({ source }),
      reconnect: { jitter: 0, baseDelayMs: 20, maxDelayMs: 40, maxAttempts: 5 },
    });

    const stops: string[] = [];
    client.on('stopped', ({ reason }) => stops.push(reason));

    // One session, one 4710, one refresh, and that refresh fails. It is real evidence that must stop the
    // client.
    const connectA = client.start();
    await source.waitForCalls(1, 'the initial version');
    source.succeed(0);
    await connectA;
    await client.waitUntilReady();

    await server.forceClose(4710, 'version mismatch');
    await source.waitForCalls(2, 'the refresh for this session');
    source.fail(1);

    await until(() => stops.length > 0, 'the current session to stop');
    assert.match(stops[0] ?? '', /version/i);
    assert.equal(client.willReconnect, false, 'a stopped client does not keep retrying');
  });
});
