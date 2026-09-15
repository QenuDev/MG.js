/**
 * A manual `connect()` supersedes a reconnect that is parked in its backoff.
 *
 * The defect this file pins down: `connect()` installed a fresh `reconnectAbort` controller *without*
 * cancelling the plan already parked in the old one. The parked sleep still held the old signal, so it
 * woke after the backoff and ran a stale attempt whose first act (`openConnection` → `detachTransport`)
 * tore down the healthy connection `connect()` had just installed. The reviewer measured the trace: a
 * `close`, then two `open`s, transport replaced. `localShutdown` guards the shutdown case, so the stale
 * attempt never installed a socket *after* a shutdown; it destroyed a live connection, which is the bug.
 *
 * The race is made observable rather than timing-dependent in the way that matters: the assertion window
 * (1000 ms) is strictly longer than the parked plan's delay (600 ms), so a stale attempt that still runs
 * has ample time to run, and a pass means it did not run at all.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
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

/** Build a client wired to a mock server. */
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

describe('HeadlessClient: connect() supersedes a parked reconnect', () => {
  it('cancels the parked plan rather than letting it tear down the new connection', async () => {
    const server = await mock({ pingIntervalMs: 0 });
    const client = makeClient(server, {
      // Jitter off, so the parked backoff is exactly 600 ms and the assertion window below is real.
      reconnect: { jitter: 0, baseDelayMs: 600, maxDelayMs: 600, coldStartFastRetries: 0 },
    });

    const opens: number[] = [];
    const closes: number[] = [];
    client.on('open', () => opens.push(Date.now()));
    client.on('close', () => closes.push(Date.now()));

    await client.start();
    await client.waitUntilReady();
    assert.equal(opens.length, 1, 'the first connection opened once');
    assert.equal(server.connectionCount, 1, 'the server accepted one connection');

    // Park a reconnect in its backoff: force a resumable close and wait for the plan to be announced.
    const parked = new Promise<void>((resolve) => {
      client.on('reconnect', () => resolve());
    });
    await server.forceClose(4400, 'idle timeout');
    await parked;
    assert.equal(client.willReconnect, true, 'a reconnect plan is parked in its backoff');

    // The manual connect lands *while that plan is parked*.
    await client.start();
    await client.waitUntilReady();
    const manualTransport = client.transport;
    assert.ok(manualTransport !== null, 'the manual connect installed a transport');
    assert.equal(opens.length, 2, `the manual connect installed exactly one new connection`);
    const closesAtManualConnect = closes.length;
    const opensAtManualConnect = opens.length;

    // Past the parked plan's 600 ms delay: a stale attempt that survived would run inside this window.
    await delay(1000);

    // The honest red: pre-fix the stale attempt detaches the manual transport and opens a third
    // connection, so `opens.length` reaches 3 and the live transport is a different object.
    assert.equal(
      closes.length,
      closesAtManualConnect,
      'a stale attempt closed the healthy connection that connect() had just installed',
    );
    assert.equal(opens.length, opensAtManualConnect, 'a stale attempt opened a connection nobody asked for');
    assert.equal(server.connectionCount, 2, 'the server saw a connection the client did not ask for');
    assert.equal(
      client.transport,
      manualTransport,
      'the live transport was replaced by a stale reconnect attempt',
    );
    assert.equal(client.willReconnect, false, 'the superseded plan must not remain scheduled');
    assert.equal(client.isReady, true, 'the manual connection is the live one');
  });
});
