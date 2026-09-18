/**
 * End-to-end: a `HeadlessClient` against a real WebSocket server.
 *
 * Everything here is real except the game: the client's own `StandaloneTransport` opens a real TCP
 * connection to the `ws`-based mock server in `tests/fixtures/mock-server.ts`, performs a real RFC 6455
 * handshake, sends real text frames, and applies real JSON-Patch batches to its state store. That matters
 * because the two things most likely to be wrong in this package are the things a mocked
 * transport would not catch: whether the handshake frames can legally be sent before `Welcome`, and
 * whether the close/`analyzeClose`/backoff path actually reconnects.
 *
 * The `host`/`port` split deserves a note. The mock listens on `127.0.0.1:<ephemeral>`, so the client is
 * given `host: '127.0.0.1'` and `port: <ephemeral>`, which produces the production URL shape
 * `wss://127.0.0.1:<port>/version/<v>/api/rooms/<room>/connect`. Node's global `WebSocket` refuses a
 * `wss://` URL with no TLS listener, so the scheme is downgraded to `ws://` at the transport boundary.
 * That is the documented seam on `StandaloneTransport` for a local or reverse-proxied endpoint. Everything
 * after the upgrade is byte-identical to the production path.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { pollUntil } from '@mg.js/common';
import type { HeadlessClientOptions } from '../../src/client.js';
import { HeadlessClient } from '../../src/client.js';
import { acquireWebSocketRuntime } from '../../src/transport/runtime.js';
import { VersionResolver } from '../../src/version.js';
import type { MockServer } from '../fixtures/mock-server.js';
import { startMockServer } from '../fixtures/mock-server.js';

/** Every server started by a test, torn down afterwards so the runner exits. */
const servers: MockServer[] = [];
/** Every client started by a test, destroyed afterwards. */
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
    // The mock listens in plaintext; the production URL is built `wss://` and the transport downgrades it.
    tls: false,
    version: server.version,
    room: 'testroom',
    // No jitter and a short base delay: the tests assert *that* a reconnect happens, not how long a
    // production backoff should be (which `backoff.test.ts` covers exactly).
    reconnect: { jitter: 0, baseDelayMs: 20, maxDelayMs: 80 },
    ...overrides,
  });
  clients.push(client);
  return client;
}

/**
 * Poll until `predicate` is true, or fail loudly with a useful message.
 *
 * Built on `@mg.js/common`'s `pollUntil` so the suite does not carry a seventh copy of the deadline loop.
 * The assertion is driven by the *resolved* value rather than by `onTimeout`: a throw from `onTimeout`
 * would happen inside a timer callback, where it is an uncaught exception rather than a rejection.
 */
async function until(predicate: () => boolean, description: string, timeoutMs = 5000): Promise<void> {
  const found = await pollUntil<true>({
    attempt: () => (predicate() ? true : null),
    timeoutMs,
    intervalMs: 10,
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  });
  if (found === null) assert.fail(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

/**
 * Wait for the client to receive a fresh `Welcome` *after* a given point in time.
 *
 * Necessary because `waitUntilReady()` resolves immediately if the client is already ready, which is
 * the state a reconnect starts from, so it would return before the reconnect had even begun.
 */
async function waitForWelcomeAfter(
  client: HeadlessClient,
  server: MockServer,
  afterConnectionCount: number,
  description: string,
): Promise<void> {
  await until(() => server.connectionCount > afterConnectionCount && client.isReady, description);
}

describe('HeadlessClient: handshake, actions and state', () => {
  it('admits itself with SocketOpened, then runs the §1.6 vote and applies a command patch', async () => {
    const server = await mock({ pingIntervalMs: 0, welcomeDelayMs: 30 });
    const client = makeClient(server);

    await client.start();
    await client.waitUntilReady();

    // §1.6: `Welcome` carries a server-assigned `selfPlayerId`; the connect URL never carries one.
    assert.equal(client.selfPlayerId, 'p_1');
    assert.equal(client.isReady, true);

    // Admission is one **bare** frame, `{"type":"SocketOpened"}`, and it is the first thing the client
    // writes — the 1206 build admits a socket by it and closes a silent one with `AdmissionTimedOut`
    // (4410). It carries no `scopePath`, which is why it is not among `roomFrames`.
    const first = server.requests.find((entry) => entry.frame?.type === 'SocketOpened');
    assert.ok(first, 'the admission frame was written');
    assert.deepEqual(first?.frame, { type: 'SocketOpened' });
    assert.equal('scopePath' in (first?.frame ?? {}), false);
    assert.equal(
      server.requests.findIndex((entry) => entry.frame?.type === 'SocketOpened'),
      0,
      'and it is the first frame sent',
    );

    // The two §1.6 vote frames were sent in the documented order, and now **after** `Welcome`: the game's
    // own client writes them from its UI once the session exists, not to get in. They are therefore a
    // second round trip behind `ready`, so the test waits for them rather than assuming they have landed.
    await until(() => server.roomFrames.length >= 2, 'the two vote frames arrived after Welcome');
    const handshake = server.roomFrames.map((entry) => entry.type);
    assert.deepEqual(handshake.slice(0, 2), ['VoteForGame', 'SetSelectedGame']);
    assert.equal(server.roomFrames[0]?.beforeWelcome, false);

    // The handshake frames are room-scoped, so they carry no `commandSequence` at all (§8.1) and cannot
    // be rejected as `invalid_sequence`.
    const handshakeFrames = server.requests.filter(
      (entry) => entry.frame?.type === 'VoteForGame' || entry.frame?.type === 'SetSelectedGame',
    );
    assert.equal(handshakeFrames.length, 2);
    for (const entry of handshakeFrames) {
      assert.deepEqual(entry.frame?.scopePath, ['Room']);
      assert.equal(entry.frame?.gameName, 'Quinoa');
      assert.equal('commandSequence' in (entry.frame ?? {}), false);
      assert.equal('requestId' in (entry.frame ?? {}), false);
    }

    // The snapshot landed: room state at `fullState.data`, game state at `fullState.child.data` (§6.1).
    assert.equal(client.store.get('/data/players/0/coins'), 0);
    assert.equal(client.store.get('/data/players/0/id'), 'p_1');

    // A typed action through the documented surface. `harvestCrop` is `wrapped` (the silent-failure case
    // if it were ever sent flat), so it must arrive as a `QuinoaCommand` envelope.
    const handle = client.actions.harvestCrop({ slot: 3 });
    const result = await handle;
    assert.equal(result.ok, true);
    assert.equal(result.action, 'HarvestCrop');
    // The mock echoes `requestId`, which the API reference allows ("optional, implying some builds do"),
    // so this is the strong form of correlation rather than the `fifo` fallback.
    assert.equal(result.matchMethod, 'requestId');
    assert.equal(result.confirmed, true);

    // The envelope shape, straight off the wire.
    const sent = server.commands[0];
    assert.ok(sent);
    assert.equal(sent.type, 'HarvestCrop');
    // §8.1: `Welcome.executedCommandSequence` was 10, so the first command must be exactly 11.
    assert.equal(sent.commandSequence, 11);
    assert.equal(sent.requestId, handle.requestId);

    // The server then pushed the patch; the store saw it.
    await until(() => client.store.get('/data/players/0/coins') === 1, 'the coins patch to be applied');
    assert.equal(client.store.get('/data/players/0/coins'), 1);

    // The store is the core's own; the client accessor is the supported way to reach it.
    assert.equal(client.store.get('/data/players/0/coins'), 1);

    await client.stop();
  });

  it('is not writable before Welcome, and the core refuses rather than sending a bad sequence', async () => {
    // A long `welcomeDelayMs` widens the pre-Welcome window so the refusal is deterministic.
    const server = await mock({ pingIntervalMs: 0, welcomeDelayMs: 250 });
    const client = makeClient(server);

    await client.start();
    server.roomFrames.length = 0;

    // §1.6: gameplay commands must not be sent before `Welcome`. The core enforces this with
    // `MgNotReadyError`; the client must not paper over it.
    assert.throws(() => client.actions.harvestCrop({ slot: 0 }), /Welcome|not ready|Cannot send/i);
    assert.equal(server.commands.length, 0);

    await client.waitUntilReady();
    await client.stop();
  });
});

describe('HeadlessClient: headers and auth', () => {
  it('carries the cookie on a header-capable runtime, and the guest has none', async () => {
    // Whether headers can be sent is a property of the *resolved runtime*, not of this package's
    // configuration: Node's global `WebSocket` silently discards them, while the `ws` package honours an
    // `options.headers` bag. The integration suite therefore asserts the two things that hold either way:
    // the guest path sends no cookie, and the client never *claims* a header it could not send.
    const server = await mock({ pingIntervalMs: 0 });
    const client = makeClient(server);

    const degraded: string[] = [];
    // The one degradation report. Phase 4.3 deleted the deprecated `headersUnsupported` name; this is the
    // surviving event, and the count below is what proves the client says the same thing about it.
    client.on('headers-dropped', ({ runtime }) => degraded.push(runtime));

    await client.start();
    await client.waitUntilReady();

    const upgrade = server.upgrades[0];
    assert.ok(upgrade, 'expected an upgrade');
    // The guest provider's entire contribution is the query parameter (§3.2), and it sets no cookie.
    assert.ok(upgrade.url.includes('anonymousUserStyle'), upgrade.url);

    // If the runtime cannot carry headers, the client said so; if it can, it did not. Either way the
    // number of reports matches the resolved runtime's own answer.
    const transport = client.transport;
    assert.ok(transport);
    assert.equal(
      degraded.length,
      transport.supportsHeaders ? 0 : 1,
      `degradation reports must match supportsHeaders=${transport.supportsHeaders}`,
    );

    // And when the runtime *can* carry them, the wire proves it: §3.3's Origin and desktop-Chrome UA.
    if (transport.supportsHeaders) {
      assert.equal(upgrade.headers.origin, 'https://magicgarden.gg');
      assert.match(String(upgrade.headers['user-agent']), /Chrome\//);
    }

    await client.stop();
  });

  it('resolves the global WebSocket by default, and reports it cannot carry headers', async () => {
    const runtime = await acquireWebSocketRuntime();
    // Node 22 provides a global, so the zero-dependency default is taken and `preferAdapter` is not
    // consulted. Header support is a property of that implementation, and the honest answer depends only
    // on which one it is.
    assert.equal(runtime.kind, 'global');
    assert.equal(runtime.supportsHeaders, false);
    assert.match(runtime.description, /globalThis\.WebSocket/);

    // Asking for the adapter is an explicit opt-in and is the documented way to get headers without this
    // package depending on `ws`. In this workspace `ws` is installed (it is a devDependency of the root,
    // used by the mock server), so the adapter resolves and declares header support.
    const adapted = await acquireWebSocketRuntime({ preferAdapter: true });
    assert.equal(adapted.kind, 'node-ws-adapter');
    assert.equal(adapted.supportsHeaders, true);
  });
});

describe('HeadlessClient: keepalive survival', () => {
  it('answers server pings across cycles and stays ready', async () => {
    const server = await mock({ pingIntervalMs: 60 });
    const client = makeClient(server);

    await client.start();
    await client.waitUntilReady();

    // Two full cycles, as required. `pongCount` counts only bare `pong` replies, so a JSON-wrapped
    // `{"type":"Pong"}` would show up as a missing pong rather than passing silently.
    await until(() => server.pongCount >= 2, 'two pong replies');
    assert.ok(server.pongCount >= 2, `pongCount=${server.pongCount}`);

    // The raw replies on the wire, verbatim.
    const pongs = server.requests.filter((entry) => entry.raw === 'pong');
    assert.ok(pongs.length >= 2);
    for (const entry of pongs) assert.equal(entry.raw, 'pong');

    // The connection is untouched: no close, still ready, no reconnect attempted.
    assert.equal(client.isReady, true);
    assert.equal(server.connectionCount, 1);

    await client.stop();
  });
});

describe('HeadlessClient: reconnect', () => {
  it('reconnects and reaches ready again after the server force-closes with 4400', async () => {
    const server = await mock({ pingIntervalMs: 0 });
    const client = makeClient(server);

    const analyses: string[] = [];
    client.on('close', ({ analysis }) => {
      analyses.push(`${analysis.code}:${analysis.disposition}`);
    });

    await client.start();
    await client.waitUntilReady();
    assert.equal(server.connectionCount, 1);

    const closed = await server.forceClose(4400, 'idle timeout');
    assert.equal(closed, 1);

    // §1.8: 4400 is the idle timeout, and the documented response is to reconnect immediately, not to
    // give up, and not to slow down.
    await waitForWelcomeAfter(client, server, 1, 'a second connection to be welcomed');

    assert.equal(server.connectionCount, 2, JSON.stringify(server.upgrades, null, 2));
    assert.equal(client.isReady, true);
    assert.deepEqual(analyses, ['4400:reconnect']);

    // The reconnect is a new *connection* in the same session: same documentId, same room, attempt 2 and
    // `clientNavigationType="reload"` (§1.4). Asserted from the upgrade URLs the server actually saw,
    // because that is where the protocol puts those values.
    const reconnects = server.requests.filter((entry) => entry.frame?.type === 'VoteForGame');
    assert.equal(reconnects.length, 2);
    assert.equal(client.connectionAttempt, 2);

    const [firstUpgrade, secondUpgrade] = server.upgrades;
    assert.ok(firstUpgrade && secondUpgrade, JSON.stringify(server.upgrades, null, 2));
    // `upgrades` values come back through `URL.searchParams.get`, which percent-decodes, so the expected
    // value is the JSON-quoted string §1.3 mandates, not its percent-encoded form.
    assert.equal(firstUpgrade.connectionAttempt, '1');
    assert.equal(firstUpgrade.navigationType, '"navigate"');
    assert.equal(secondUpgrade.connectionAttempt, '2');
    assert.equal(secondUpgrade.navigationType, '"reload"');
    // §1.4: the documentId identifies the "tab" for the whole session and is stable across retries.
    assert.equal(firstUpgrade.documentId, secondUpgrade.documentId);
    assert.equal(firstUpgrade.version, server.version);
    assert.equal(secondUpgrade.version, server.version);
    // Nothing superseded us, so §1.4's "omit entirely otherwise" applies.
    assert.equal(firstUpgrade.reclaimSuperseded, null);
    assert.equal(secondUpgrade.reclaimSuperseded, null);

    // The handshake is re-sent on every connection (§1.6: "after every reconnect").
    assert.equal(server.roomFrames.filter((entry) => entry.type === 'VoteForGame').length, 2);

    await client.stop();
  });

  it('re-resolves the version before reconnecting after a 4710', async () => {
    const server = await mock({ pingIntervalMs: 0 });

    // The fake resolver is the seam that makes the 4710 behaviour assertable: it counts calls and hands
    // back a different version each time, so "the client re-resolved" and "the new version reached the
    // URL" are both observable.
    let calls = 0;
    const versions = ['v1', 'v2', 'v3'];
    const resolver = new VersionResolver({
      fetcher: async () => {
        const version = versions[Math.min(calls, versions.length - 1)] ?? 'v3';
        calls += 1;
        return version;
      },
    });

    const client = makeClient(server, { version: undefined, versionResolver: resolver });

    await client.start();
    await client.waitUntilReady();
    assert.equal(calls, 1);
    assert.equal(client.version, 'v1');
    assert.ok(client.url.includes('/version/v1/'));

    const closes: string[] = [];
    client.on('close', ({ analysis }) => closes.push(analysis.disposition));

    await server.forceClose(4710, 'version expired');

    // §9: reconnecting with the version that just got us closed is "the case that produces an
    // endless 4710 loop". The client must therefore re-resolve before the next attempt.
    await waitForWelcomeAfter(client, server, 1, 'a welcome on the re-resolved version');

    assert.deepEqual(closes, ['refetch-version']);
    assert.ok(calls >= 2, `expected the resolver to be called again, saw ${calls} calls`);
    assert.equal(client.version, 'v2');

    // The refreshed version has to reach the wire, or the client would be closed with 4710 again. The
    // `/version/<v>/` path segment is where §1.3 puts it, so that is what is asserted.
    const versionsSeen = server.upgrades.map((upgrade) => upgrade.version);
    assert.deepEqual(versionsSeen, ['v1', 'v2']);
    assert.equal(
      versionsSeen[versionsSeen.length - 1],
      'v2',
      `expected the retry to carry v2, got ${JSON.stringify(server.upgrades, null, 2)}`,
    );
    assert.equal(versionsSeen.includes('v1') && versionsSeen.indexOf('v1') === 0, true);

    await client.stop();
  });

  it('does not reconnect when the client disconnects itself', async () => {
    const server = await mock({ pingIntervalMs: 0 });
    const client = makeClient(server);

    await client.start();
    await client.waitUntilReady();

    const closes: Array<{ disposition: string; willReconnect: boolean }> = [];
    client.on('close', ({ analysis, willReconnect }) => {
      closes.push({ disposition: analysis.disposition, willReconnect });
    });

    await client.stop();

    // A local close is `wasManual`, which `analyzeClose` maps to `stop`, the documented reason a clean
    // shutdown cannot become a reconnect loop.
    assert.deepEqual(closes, [{ disposition: 'stop', willReconnect: false }]);

    // Give the (absent) reconnect a chance to happen before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(server.connectionCount, 1);
    assert.equal(client.isReady, false);
  });

  it('stops retrying once the attempt budget is exhausted', async () => {
    // Every connection is killed before the script runs, and `maxAttempts: 3` caps the loop.
    const server = await mock({ pingIntervalMs: 0, alwaysClose: true, alwaysCloseCode: 4400 });

    const client = makeClient(server, {
      reconnect: { jitter: 0, baseDelayMs: 5, maxDelayMs: 10, maxAttempts: 3, coldStartFastRetries: 0 },
    });

    const stopped: string[] = [];
    client.on('stopped', ({ reason }) => stopped.push(reason));

    await client.start().catch(() => undefined);

    // The client was never welcomed, so each failed attempt is a cold-start attempt; the third exhausts
    // the budget and the client reports why it stopped.
    await until(() => client.stopped !== null, 'the client to give up');
    assert.match(client.stopped ?? '', /budget exhausted|Reconnect refused/);
    assert.equal(stopped.length, 1);
    assert.equal(client.isReady, false);
    // `maxAttempts: 3` means three connections in total, never a fourth.
    assert.equal(
      server.connectionCount,
      3,
      `expected 3 connections, saw ${JSON.stringify(server.upgrades.map((u) => u.connectionAttempt))}`,
    );
  });

  it('refuses to reclaim a superseded session on its own, and reclaims it once confirmed', async () => {
    // The session is *established* (Welcome is sent) and then superseded, which is the case §1.4 describes:
    // after 4250/4300 the next connect must set `reclaimSupersededSession=true` and wait much longer than
    // an ordinary retry, because "retrying instantly just gets superseded again".
    //
    // The refusal half is the part that is not in §1.4. The game's developers asked for it directly:
    // reclaiming automatically "is unsafe, and can result in data loss, especially if the player has the
    // game open in two rooms, as each room will play tug-of-war over the user, and the result is nothing
    // gets saved", and since v473+ it is "only safe to do so with explicit confirmation from the player".
    const server = await mock({
      pingIntervalMs: 0,
      closeAfterMs: 20,
      closeAfterWelcome: true,
      closeAfterCode: 4300,
    });

    const client = makeClient(server, {
      // `supersededBaseDelayMs` is raised, not lowered: the assertion is that the superseded
      // path uses a *different, longer* base than the ordinary one (20ms here).
      reconnect: {
        jitter: 0,
        baseDelayMs: 20,
        maxDelayMs: 400,
        supersededBaseDelayMs: 200,
        maxAttempts: 2,
        coldStartFastRetries: 0,
      },
    });

    const plans: Array<{ delayMs: number; superseded: boolean }> = [];
    client.on('reconnect', ({ plan }) => {
      plans.push({ delayMs: plan.delayMs, superseded: plan.superseded });
    });
    let confirmations = 0;
    client.on('confirmationRequired', ({ analysis }) => {
      confirmations += 1;
      assert.equal(analysis.disposition, 'reconnect-confirm');
      assert.equal(analysis.isSuperseded, true);
    });

    await client.start().catch(() => undefined);

    // Give the client every chance to reconnect on its own. It must not: exactly one upgrade, no plans, and
    // an outstanding request for a human decision.
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(server.upgrades.length, 1, 'a supersession must not reconnect itself');
    // The explicit type argument pins the assertion predicate to `plans`' own type: strict
    // `deepEqual` is `asserts actual is T`, and inferring `T` from `[]` would narrow `plans` to
    // `never[]` for the rest of the scope.
    assert.deepEqual<typeof plans>(plans, [], 'no retry may be scheduled without confirmation');
    assert.equal(confirmations, 1, 'the caller must be told why nothing is happening');
    assert.equal(client.awaitingSupersedeConfirmation, true);

    // Now a person says yes.
    assert.equal(client.confirmSupersededReconnect(), true);
    await until(() => server.upgrades.length >= 2, 'the superseded reconnect');

    const attempts = server.upgrades.map((upgrade) => upgrade);
    assert.equal(attempts[0]?.connectionAttempt, '1');
    // The second attempt is the superseded one: same documentId (same identity, which is the whole point
    // of "reclaiming"), attempt 2, `reload`, and the reclaim flag present and literal `true`.
    assert.equal(attempts[1]?.connectionAttempt, '2');
    assert.equal(attempts[1]?.navigationType, '"reload"');
    assert.equal(attempts[1]?.reclaimSuperseded, 'true');
    assert.equal(attempts[1]?.documentId, attempts[0]?.documentId);

    // And the delay really did use the superseded base rather than the ordinary one.
    assert.equal(plans.length, 1, JSON.stringify(plans));
    assert.equal(plans[0]?.superseded, true);
    assert.equal(plans[0]?.delayMs, 200);

    // Confirming consumed the request: a second call has nothing left to confirm.
    assert.equal(client.awaitingSupersedeConfirmation, false);
    assert.equal(client.confirmSupersededReconnect(), false);

    // Stop it: this server supersedes every connection, so leaving the client running would keep
    // reconnecting for the rest of the test file.
    await client.stop();
  });

  it('does not ask for confirmation on a heartbeat supersede', async () => {
    // The other half of the 4300 disambiguation: a heartbeat supersede is our own reconnect racing itself,
    // nothing is fighting over the identity, and it must keep reconnecting without a human in the loop.
    const server = await mock({
      pingIntervalMs: 0,
      closeAfterMs: 20,
      closeAfterWelcome: true,
      closeAfterCode: 4300,
      closeAfterReason: 'heartbeat superseded',
    });

    const client = makeClient(server, {
      reconnect: {
        jitter: 0,
        baseDelayMs: 20,
        maxDelayMs: 400,
        supersededBaseDelayMs: 200,
        maxAttempts: 2,
        coldStartFastRetries: 0,
      },
    });

    let confirmations = 0;
    client.on('confirmationRequired', () => {
      confirmations += 1;
    });

    await client.start().catch(() => undefined);
    await until(() => server.upgrades.length >= 2, 'the ordinary reconnect');

    assert.equal(confirmations, 0);
    assert.equal(client.awaitingSupersedeConfirmation, false);

    await client.stop();
  });
});
