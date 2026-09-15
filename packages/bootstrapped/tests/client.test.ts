/**
 * The client lifecycle: one verb pair, one diagnostic surface, one emitter.
 *
 * ## The bugs these tests exist for
 *
 * (a) The old `install()` claimed the page namespace but never cleared the latch the old `uninstall()` raised.
 * A second `install()` therefore created a fresh `__mgjs` namespace whose own `uninstall()` returned on its
 * first line. That left a page hook with nobody to release it:
 *
 *     client.start(); client.stop(); client.start(); client.stop();
 *     // → page.__mgjs is still there
 *
 * (The verbs were `install`/`uninstall` when that bug was found and fixed; 4.4 renamed them to the contract's
 * `start`/`stop`, and the assertions below are what keep the pair symmetric.)
 *
 * The assertions below are on the observable page state after the final teardown, plus the wrapper
 * `raw-socket.ts` puts in `page.WebSocket`, which must be restored like any other hook we took.
 *
 * (b) Phase 4.4 gives the client the contract's verbs (`start`/`stop`), a `report` **getter** where a
 * `report()` **method** of the same name used to be, so `report()` now has to move to `report.detail`,
 * and the `events` emitter it never had, so a mod no longer has to reach through `client.core.on`. The
 * emitter is the core itself (one bus, not two), so the listener-count tests below pin this: a
 * teardown must release every listener the client added (I2), and a restart must not accumulate them.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClientEvents, Logger, MgClient } from '@mg.js/common';
import { MG_VERSION, MgTransportError } from '@mg.js/common';
import { BootstrappedClient } from '../src/client.ts';
import { isBranded } from '../src/coexistence/brand.ts';
import { ATOM_CACHE_KEY } from '../src/jotai/bridge.ts';
import { BUNDLE_VERSION, onTeardown, peekNamespace } from '../src/page/namespace.ts';
import { installRealmOverride } from '../src/page/override.ts';
import type { PageRealm } from '../src/page/realm.ts';

/** A page socket class with the static surface `raw-socket.ts` preserves. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.OPEN;
  constructor(readonly url: string) {}
  send(_data: string): void {
    // Nothing to do: this test never sends a frame.
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
  addEventListener(_type: string, _listener: (event: unknown) => void): void {
    // No inbound frames in this test.
  }
  removeEventListener(_type: string, _listener: (event: unknown) => void): void {
    // No inbound frames in this test.
  }
}

function makeClient(page: PageRealm): BootstrappedClient {
  return new BootstrappedClient({
    page,
    storage: { forceBackend: 'memory' },
    // This test is about the client's own hooks, so the render/catalog/jotai bridges stay out of it.
    features: { render: false, jotai: false },
    // A live socket wins the attachment immediately, so `waitForAttachment()` settles without waiting on
    // the clock.
    attachTimeoutMs: 1000,
    roomUpgradeTimeoutMs: 1000,
    roomUpgradeIntervalMs: 10,
  });
}

/** A client with only the jotai bridge on, for the bridge's own lifecycle assertions. */
function makeJotaiClient(page: PageRealm): BootstrappedClient {
  return new BootstrappedClient({
    page,
    storage: { forceBackend: 'memory' },
    features: { render: false, catalog: false, jotai: true },
    attachTimeoutMs: 1000,
    roomUpgradeTimeoutMs: 1000,
    roomUpgradeIntervalMs: 10,
  });
}

/** A client with only the in-page catalogue on, for the catalogue's own lifecycle assertions. */
function makeCatalogClient(page: PageRealm): BootstrappedClient {
  return new BootstrappedClient({
    page,
    storage: { forceBackend: 'memory' },
    // `platformCatalog: false` keeps the test off the network: the bundle source is the only one this
    // test needs, and it is built from the page.
    features: { render: false, jotai: false, catalog: true, platformCatalog: false },
    attachTimeoutMs: 1000,
    roomUpgradeTimeoutMs: 1000,
    roomUpgradeIntervalMs: 10,
  });
}

/** Every listener the client itself holds on the shared emitter, across the events it wires. */
function wiredListenerCount(client: BootstrappedClient): number {
  return client.events.listenerCount('welcome') + client.events.listenerCount('state');
}

void test('start() after stop() still tears its page hook down', async () => {
  const page: PageRealm = { WebSocket: FakeWebSocket };
  const restore = installRealmOverride({ page });
  const client = makeClient(page);

  try {
    await client.start();
    await client.waitForAttachment();

    // The first start really did hook the page, so "no hook left" below is not vacuous: the socket
    // constructor is replaced by a branded wrapper for as long as the client holds it.
    assert.equal(isBranded(page['WebSocket']), true, 'the first start must wrap page.WebSocket');

    await client.stop();
    assert.equal(Object.hasOwn(page, '__mgjs'), false, 'the first teardown must remove the namespace');
    assert.equal(isBranded(page['WebSocket']), false, 'the first teardown must restore the socket');

    await client.start();
    // The restart really does attach again now, because the released attachment is no longer handed
    // back, so this pair has to be waited out like the first one before the teardown gives the socket
    // hook back.
    // This assertion used to pass only because the restarted client did not attach at all.
    await client.waitForAttachment();
    await client.stop();

    assert.equal(
      Object.hasOwn(page, '__mgjs'),
      false,
      'the second start claimed a page hook that its own stop() could not release',
    );
    assert.equal(isBranded(page['WebSocket']), false, 'no mg.js wrapper may survive teardown');
  } finally {
    restore();
  }
});

void test('start() after stop() reports itself as started again', async () => {
  const page: PageRealm = { WebSocket: FakeWebSocket };
  const restore = installRealmOverride({ page });
  const client = makeClient(page);

  try {
    await client.start();
    await client.waitForAttachment();
    await client.stop();
    await client.start();

    // The latch that `stop()` raised is what `report.started` reads; if `start()` leaves it standing, the
    // client reports itself torn down while holding a live page hook.
    assert.equal(client.report.started, true, 'start() after stop() must count as started again');
    assert.equal(client.isInstalled, true);
  } finally {
    await client.stop();
    restore();
  }
});

void test('stop() releases the attachment, so a second start() attaches afresh', async () => {
  const page: PageRealm = { WebSocket: FakeWebSocket };
  const restore = installRealmOverride({ page });
  const client = makeClient(page);

  try {
    await client.start();
    const released = await client.waitForAttachment();
    assert.equal(released.kind, 'raw-socket', 'the harness page has a live socket to bind');

    await client.stop();
    assert.equal(isBranded(page['WebSocket']), false, 'the first teardown must restore the socket');

    await client.start();
    const reattached = await client.waitForAttachment();

    // `waitForAttachment()` memoised the attachment, and `stop()` released the binding underneath it
    // without clearing the memo. A second `start()` therefore reported readiness against a torn-down sink
    // and a page whose socket hook had already been given back. The observable tell is the page itself: a
    // client that is ready on the raw-socket path is one that holds a wrapper on
    // `page.WebSocket`.
    assert.notEqual(
      reattached,
      released,
      'waitForAttachment() after stop() handed back the already-released attachment',
    );
    assert.equal(
      isBranded(page['WebSocket']),
      true,
      'a client that reports ready must hold a live attachment: the socket hook was never re-taken',
    );
    assert.equal(client.attachmentKind, 'raw-socket', 'the re-attached client must still report its kind');
    assert.notEqual(client.attachmentReport, null, 'a re-attached client must still report an attachment');
  } finally {
    await client.stop();
    restore();
  }
});

void test('the bundle version is the common version, not a second literal', () => {
  // The cross-package identity is the assertion a restated literal cannot fake: `BUNDLE_VERSION` is
  // stamped into the page namespace for skew detection, and a second copy of the number is how the two
  // drift apart. Phase 8.4 moves the number; this pins it to one home first.
  assert.equal(BUNDLE_VERSION, MG_VERSION);
});

void test('a BootstrappedClient satisfies MgClient', async () => {
  const page: PageRealm = { WebSocket: FakeWebSocket };
  const restore = installRealmOverride({ page });
  const client = makeClient(page);

  try {
    // The compile-time half: a caller that only knows the contract can drive this client. Before 4.4 none
    // of `start`, `stop`, `report` (as a value) or `events` existed.
    const contract: MgClient<ClientEvents> = client;
    assert.equal(typeof contract.start, 'function');
    assert.equal(typeof contract.stop, 'function');
    assert.equal(contract.events, client.core, 'the emitter is the core, not a second bus');
    assert.equal(contract.report.kind, 'bootstrapped');
    assert.equal(contract.report.selfPlayerId, client.selfPlayerId);
    assert.equal(contract.lastError, null);

    await contract.start();
    // `waitForAttachment` is the client's own seam, not part of `MgClient` (the contract's `start()` does not
    // block on a 20 s attachment window), so the rest of this test goes through the concrete client.
    await client.waitForAttachment();

    assert.equal(contract.report.started, true);
    assert.equal(contract.report.ready, client.isReady);
    assert.equal(contract.report.version, MG_VERSION);
    // The whole pre-4.4 report is still reachable, under `detail`.
    assert.equal(client.report.detail.version, BUNDLE_VERSION);
    assert.equal(client.report.detail.hasPage, true);
    assert.equal(typeof client.report.detail.storage.durable, 'boolean');
    assert.equal(client.report.detail.attachment.kind, 'raw-socket');
  } finally {
    await client.stop();
    restore();
  }
});

void test('start() is idempotent and stop() is total', async () => {
  const page: PageRealm = { WebSocket: FakeWebSocket };
  const restore = installRealmOverride({ page });
  const client = makeClient(page);

  try {
    await client.start();
    await client.start();
    await client.waitForAttachment();
    assert.equal(client.report.started, true);

    await client.stop();
    await client.stop();
    assert.equal(client.report.started, false, 'a stopped client has not been started');
    assert.equal(client.attachmentReport, null, 'the attachment is released, not reported as live');
    assert.equal(client.report.ready, false);
    assert.equal(client.report.detail.hasPage, true, 'the report still describes the page it found');
  } finally {
    await client.stop();
    restore();
  }
});

void test('a failed start() does not claim to be started', async () => {
  // No realm override and no page: `start()`'s page check is a rejection now, not a synchronous throw, and
  // a half-finished start must not report itself as installed (I7: fail loudly, never half-install).
  const client = new BootstrappedClient({
    storage: { forceBackend: 'memory' },
    features: { render: false, catalog: false, jotai: false },
  });

  await assert.rejects(client.start(), /no page realm/);
  assert.equal(client.report.started, false, 'a failed start() must not claim to be installed');

  // A failed start is still cleanable: nothing was claimed, but the transport and core the constructor built
  // are released, and that is what `stop()` being total has to mean for a client that never got a page.
  await client.stop();
  assert.equal(client.report.started, false);
});

void test('stop() never throws when the page has gone away', async () => {
  const page: PageRealm = { WebSocket: FakeWebSocket };
  const restore = installRealmOverride({ page });
  const client = makeClient(page);

  try {
    await client.start();
    await client.waitForAttachment();
  } finally {
    // The page realm vanishes under the client. It still holds the page object it captured, so the
    // teardown has something to release and must complete rather than reject with "no page realm".
    restore();
  }

  await client.stop();
  assert.equal(client.report.started, false);

  // And a client that never had a page at all: there is nothing to release, and `stop()` is still total.
  const orphan = new BootstrappedClient({
    storage: { forceBackend: 'memory' },
    features: { render: false, catalog: false, jotai: false },
  });
  await orphan.stop();
  assert.equal(orphan.report.started, false);
});

void test('events reach a caller through client.events, and a restart does not accumulate them', async () => {
  const page: PageRealm = { WebSocket: FakeWebSocket };
  const restore = installRealmOverride({ page });
  const client = makeClient(page);

  try {
    await client.start();
    await client.waitForAttachment();

    const readies: string[] = [];
    client.events.on('ready', () => readies.push('ready'));
    client.core.emit('ready');
    assert.deepEqual(readies, ['ready'], 'a caller reaches the core emitter through client.events');

    const afterFirst = wiredListenerCount(client);
    assert.ok(afterFirst > 0, `the client wires its own core listeners, saw ${afterFirst}`);

    // Several cycles, not one. A released listener is only observable through a *later* cycle: sampling
    // after the first start and stopping there is why deleting the client's own `detach()` invocation in
    // `stop()` once left every test green while the count climbed 2 → 4 → 6 from the second cycle: the
    // second stop is the first one whose listeners nothing else happens to clear. Assert the invariant
    // after *every* cycle, so no single cycle carries the whole claim.
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await client.stop();
      assert.equal(
        wiredListenerCount(client),
        0,
        `stop() must release every listener the client added (I2), cycle ${cycle}`,
      );
      await client.start();
      await client.waitForAttachment();
      assert.equal(
        wiredListenerCount(client),
        afterFirst,
        `start() must re-wire the client, not accumulate a second copy, cycle ${cycle}`,
      );
    }
  } finally {
    await client.stop();
    restore();
  }
});

void test('a stopped client reports no jotai bridge, and a restart builds a live one', async () => {
  // The bridge is one-way like the core and the transport: `release()` takes its page hook out, and
  // `JotaiBridge` has no reinstall. `stop()` released it but left the field pointing at the corpse, so
  // `report.detail.jotai.enabled` stayed `true` for a client that no longer had a bridge, and a restart
  // never built one. `catalog` and the Pixi capture are rebuilt on a restart; this pins the same rule.
  const page: PageRealm = { WebSocket: FakeWebSocket };
  const restore = installRealmOverride({ page });
  const client = makeJotaiClient(page);

  try {
    const first = client.jotai;
    assert.notEqual(first, null, 'the bridge is installed up front, before the first start');

    await client.start();
    await client.waitForAttachment();
    assert.equal(client.report.detail.jotai.enabled, true);

    await client.stop();
    assert.equal(client.jotai, null, 'a released bridge must not be handed out again');
    assert.equal(
      client.report.detail.jotai.enabled,
      false,
      'report.detail.jotai must not advertise a released bridge as enabled',
    );

    await client.start();
    await client.waitForAttachment();
    assert.notEqual(client.jotai, null, 'a restart must own a live bridge');
    assert.notEqual(
      client.jotai,
      first,
      'the released bridge cannot be revived; the restart builds a new one',
    );
    assert.equal(client.report.detail.jotai.enabled, true);
    assert.equal(
      Object.hasOwn(page, ATOM_CACHE_KEY),
      true,
      'the restarted client must re-install the page hook, not report a bridge it does not have',
    );
  } finally {
    await client.stop();
    restore();
  }
});

void test('a stopped client hands out no catalogue, and a restart builds a live one', async () => {
  // `catalogClient` is built in `start()` over a `BundleCaptureHandle`, and `stop()` disposes that handle
  // without clearing the field. The leftovers are not inert: `sourceIds` still answers and `load()` still
  // resolves, so the accessor handed out a catalogue client over a disposed capture, the same
  // released-thing-still-reachable hole `jotaiValue` was fixed for. `catalog` is nullable because of
  // this, so `null` is the honest answer between a stop and a restart.
  const page: PageRealm = { WebSocket: FakeWebSocket };
  const restore = installRealmOverride({ page });
  const client = makeCatalogClient(page);

  try {
    assert.equal(client.catalog, null, 'the catalogue is built by start(), not by the constructor');

    await client.start();
    await client.waitForAttachment();
    const first = client.catalog;
    assert.notEqual(first, null, 'start() must build the catalogue');
    assert.equal(client.report.detail.catalog.enabled, true);

    await client.stop();
    assert.equal(
      client.catalog,
      null,
      'a stopped client must not hand out a catalogue over a disposed capture',
    );
    assert.equal(client.report.detail.catalog.enabled, false);

    await client.start();
    await client.waitForAttachment();
    assert.notEqual(client.catalog, null, 'a restart must build a live catalogue');
    assert.notEqual(
      client.catalog,
      first,
      'the capture is rebuilt on a restart, so the catalogue built over it must be too',
    );
    assert.equal(client.report.detail.catalog.enabled, true);
  } finally {
    await client.stop();
    restore();
  }
});

void test('a transport that refuses the sink is a visible failure, not a healthy attachment', async () => {
  // `attachSink()` returns `false` when it did not attach, here because the transport was closed
  // before the attach window resolved. The return value used to be discarded, so the client adopted the
  // binding anyway and `attachmentReport` printed a healthy `raw-socket` attachment while the transport had
  // nothing wired to receive a frame. That is the silent-failure class I7 removes: a userscript must fail
  // safe and *visibly*, so the refusal is recorded as a typed `lastError` and the wait rejects.
  const page: PageRealm = { WebSocket: FakeWebSocket };
  const restore = installRealmOverride({ page });
  const client = makeClient(page);

  try {
    // The only way the real transport answers `false` for a fresh sink: close it first, which is the
    // state a `stop()` racing the attach window leaves behind.
    client.transport.close(1000, 'test: transport already closed');

    await client.start();
    await assert.rejects(
      () => client.waitForAttachment(),
      (error: unknown) => error instanceof MgTransportError && error.code === 'sink_not_attached',
      'a refused sink must reject the attachment wait with the typed reason',
    );
    assert.equal(
      client.attachmentReport,
      null,
      'a sink the transport never took is not an attachment, and must not be reported as one',
    );
    const lastError = client.lastError;
    assert.ok(
      lastError instanceof MgTransportError,
      `the refusal must reach the documented diagnostic surface; saw ${String(lastError)}`,
    );
    assert.equal(lastError.code, 'sink_not_attached');
    assert.equal(
      client.report.errors.some((error) => error.code === 'sink_not_attached'),
      true,
    );
  } finally {
    await client.stop();
    restore();
  }
});

void test('start() registers no teardown that does nothing', async () => {
  const page: PageRealm = { WebSocket: FakeWebSocket };
  const restore = installRealmOverride({ page });
  const client = makeClient(page);

  try {
    await client.start();

    // `onTeardown` pushes onto the namespace's own list, and `releaseInstall` hands that list to whoever
    // tears down. A callback whose body is only a comment is not a teardown, since the push is its only
    // effect, and `start()` creates the namespace for its own `claimInstall` regardless. This assertion
    // was red before the registration was deleted (the list held one no-op) and is what makes the
    // deletion observable: a dead registration leaves no behavioural trace, so it survived this long.
    const namespace = peekNamespace(page);
    assert.notEqual(namespace, null, 'start() must have created the page namespace');
    assert.deepEqual(
      namespace?.teardowns,
      [],
      'a registration with no body is a call site pretending to be a teardown',
    );
  } finally {
    await client.stop();
    restore();
  }
});

void test('a real page teardown still runs when the last claim is released', async () => {
  // The live path the deletion above must not touch: `releaseInstall` returns the namespace's list and
  // `stop()` runs every entry. Asserted here because deleting the client's own never-pushed list is only
  // safe if this path, which is a *different* list, is what does the work.
  const page: PageRealm = { WebSocket: FakeWebSocket };
  const restore = installRealmOverride({ page });
  const client = makeClient(page);
  let ran = 0;

  try {
    await client.start();
    onTeardown(() => {
      ran += 1;
    }, page);

    await client.stop();
    assert.equal(ran, 1, 'the namespace teardown registered by the page must run at the last release');
  } finally {
    await client.stop();
    restore();
  }
});

void test('a start that fails part-way leaves no claim behind', async () => {
  // `start()` claims the namespace at `claimInstall` and only marks itself installed at the very end, so every
  // step in between runs with a claim held and nothing to release it. The first step of that span is the
  // startup log line, which makes an injectable logger a deterministic way to fail a start *after* the claim
  // exists, the ordering this test is about. Before the guard, the namespace kept the claim at `refCount 1`
  // and `stop()` was the only thing that could release it.
  const page: PageRealm = { WebSocket: FakeWebSocket };
  const restore = installRealmOverride({ page });
  let infoCalls = 0;
  const logger: Logger = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => {
      infoCalls += 1;
      if (infoCalls === 1) throw new Error('the first startup log line failed');
    },
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    level: () => 'info',
    setLevel: () => undefined,
  };
  const client = new BootstrappedClient({
    page,
    logger,
    storage: { forceBackend: 'memory' },
    features: { render: false, jotai: false, catalog: false },
    attachTimeoutMs: 5,
    roomUpgradeTimeoutMs: 5,
    roomUpgradeIntervalMs: 1,
  });

  try {
    await assert.rejects(() => client.start(), /the first startup log line failed/);
    assert.equal(client.isInstalled, false, 'a failed start is not an installed client');

    const namespace = peekNamespace(page);
    assert.equal(
      namespace?.refCount ?? 0,
      0,
      'a failed start must give its claim back, or the namespace outlives the client',
    );

    // And the claim really is re-usable: the second start succeeds (the logger only throws once) and a stop
    // takes the namespace away, which is the invariant the leak broke: a retry used to claim a *second*
    // time, and `stop()` releases one.
    await client.start();
    assert.equal(client.isInstalled, true, 'the retry must install');
    assert.equal(peekNamespace(page)?.refCount, 1, 'a successful start holds exactly one claim');

    await client.stop();
    assert.equal(Object.hasOwn(page, '__mgjs'), false, 'the last release must remove the namespace');
  } finally {
    // Unconditional, and run after a failed assertion too: a client whose start threw still holds a
    // transport with a readiness poller, and leaving it running keeps the event loop alive so `node --test`
    // never flushes its report. That is how this test first "failed": not red, but silent until the runner
    // was killed.
    await client.stop().catch(() => undefined);
    restore();
  }
});
