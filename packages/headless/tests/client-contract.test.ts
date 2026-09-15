/**
 * `HeadlessClient` against `MgClient`: the contract, asserted rather than assumed.
 *
 * `docs/DESIGN.md` §3.2 says the four client-shaped classes answer four axes the same way: one verb pair
 * (`start`/`stop`), one lifecycle event namespace with one payload shape, one identity accessor that is
 * `string | null` and never a placeholder, and one JSON-safe diagnostic surface (`report`). `HeadlessClient`
 * answered all four differently (`connect`/`disconnect`/`destroy`, its own `close` payload, `stats`,
 * `error: unknown`), so no caller could be written against two clients at once.
 *
 * That compile-time line is what the first test is for: `const contract: MgClient<HeadlessClientEvents>`
 * is what a shared caller would write, and it fails to compile while any axis disagrees. The runtime
 * assertions beside it pin the values a caller reads, not the shape of the implementation.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import type { CatalogKind, ClientCloseEvent, MgClient } from '@mg.js/common';
import { pollUntil } from '@mg.js/common';

import type { HeadlessClientEvents, HeadlessClientOptions, HeadlessCloseEvent } from '../src/client.js';
import { HeadlessClient } from '../src/client.js';
import type { VersionSource } from '../src/version.js';
import { VersionResolver } from '../src/version.js';
import type { MockServer } from './fixtures/mock-server.js';
import { startMockServer } from './fixtures/mock-server.js';

/** Every server started by a test, torn down afterwards so the runner exits. */
const servers: MockServer[] = [];
/** Every client built by a test, stopped afterwards so no socket outlives the run. */
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

/** Track a client for teardown. */
function track(client: HeadlessClient): HeadlessClient {
  clients.push(client);
  return client;
}

/** Build a client wired to a mock server, with the version pinned so no network call can happen. */
function makeClient(server: MockServer, overrides: Partial<HeadlessClientOptions> = {}): HeadlessClient {
  return track(
    new HeadlessClient({
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

/** Poll until `predicate` is true, or fail loudly with a useful message. */
async function until(predicate: () => boolean, description: string, timeoutMs = 5000): Promise<void> {
  const found = await pollUntil<true>({
    attempt: () => (predicate() ? true : null),
    timeoutMs,
    intervalMs: 10,
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  });
  if (found === null) assert.fail(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

/** A source that hands back a scripted payload per call, repeating the last one forever. */
class ScriptedVersionSource implements VersionSource {
  readonly id = 'scripted';
  calls = 0;

  constructor(private readonly payloads: readonly unknown[]) {}

  async load(_kind: CatalogKind): Promise<unknown> {
    const payload = this.payloads[Math.min(this.calls, this.payloads.length - 1)];
    this.calls += 1;
    return payload;
  }
}

/** `{"version":{"nested":1}}`: the envelope is tolerated, the value is not, so no version is extracted. */
const MALFORMED: unknown = { version: { nested: 1 } };

describe('HeadlessClient: the shared client contract', () => {
  it('satisfies MgClient: one verb pair, one report, one identity accessor', () => {
    const client = track(new HeadlessClient({ version: '1157', room: 'testroom' }));
    // The compile-time half. A shared caller reaches every client through this interface.
    const contract: MgClient<HeadlessClientEvents> = client;

    assert.equal(typeof contract.start, 'function');
    assert.equal(typeof contract.stop, 'function');
    assert.equal(contract.report.kind, 'headless');
    assert.equal(contract.report.selfPlayerId, null, 'identity is resolved, never a placeholder');
    assert.equal(contract.selfPlayerId, null);
    assert.equal(contract.lastError, null);
    assert.equal(contract.isReady, false);
    assert.equal(contract.events, client, 'the client is its own emitter, not a second bus');
  });

  it('stop() is total, idempotent, and remembers the reason it was given', async () => {
    const client = track(new HeadlessClient({ version: '1157', room: 'testroom' }));

    await client.stop('test');
    await client.stop('test');

    assert.equal(client.stopped, 'test');
    assert.equal(client.report.started, false, 'a stopped client has not been started');
    assert.equal(client.report.ready, false);
  });

  it('report.errors names why the version could not be resolved', async () => {
    const client = track(
      new HeadlessClient({
        version: undefined,
        versionResolver: new VersionResolver({ source: new ScriptedVersionSource([MALFORMED]) }),
        reconnect: { enabled: false },
      }),
    );

    await assert.rejects(client.start());

    const [error] = client.report.errors;
    assert.ok(error, `a failed start() must leave a trace in report.errors: ${JSON.stringify(error)}`);
    // The class name and the message are the two axes a caller may branch on; `VersionUnavailableError`
    // carries no `code` of its own, so `summarizeError` reports `unknown` there (see the test's note).
    assert.equal(error.name, 'VersionUnavailableError');
    assert.match(error.message, /version/i);
    assert.equal(client.lastError?.message, error.message, 'lastError and report.errors agree');
  });

  it('the deprecated headersUnsupported event is gone, and headers-dropped remains', () => {
    const client = track(new HeadlessClient({ version: '1157', room: 'testroom' }));
    const names = client.eventNames() as readonly string[];

    assert.equal(
      names.includes('headersUnsupported'),
      false,
      'the deprecated name was removed rather than kept beside its replacement',
    );
    assert.equal(names.includes('headers-dropped'), true);
    for (const name of ['open', 'ready', 'close']) {
      assert.equal(names.includes(name), true, `the shared lifecycle event "${name}" must exist`);
    }
  });

  it('a close payload carries info, analysis and willReconnect', async () => {
    const server = await mock({ pingIntervalMs: 0 });
    const client = makeClient(server);

    // An array rather than a `let`: a value assigned only inside a listener stays narrowed to its
    // initializer for the compiler, which would make every assertion below read `never`.
    const closes: HeadlessCloseEvent[] = [];
    client.on('close', (event) => {
      closes.push(event);
    });

    await client.start();
    await client.waitUntilReady();
    await server.forceClose(4400, 'forced by test');
    await until(() => closes.length > 0, 'the close event');

    const [event] = closes;
    assert.ok(event);
    // The shared base is real, not a comment: `info` is the contract's own field.
    const base: ClientCloseEvent = event;
    assert.equal(base.info.code, 4400);
    assert.equal(event.analysis.code, 4400);
    assert.equal(event.analysis.disposition, 'reconnect');
    assert.equal(typeof event.willReconnect, 'boolean');
  });
});
