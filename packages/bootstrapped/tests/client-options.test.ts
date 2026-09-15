/**
 * Every documented `features` option has to change observable behaviour (I8: "a gate must be able to
 * fail").
 *
 * Phase 4.5 replaced the five negative `disableX` flags with one positive `features` object, matching the
 * polarity {@link BootstrapReport} already reported. Five flags that all defaulted to "on" were hard to
 * tell apart from flags that did nothing; this file is the acceptance the master plan asked for: one
 * assertion per feature, each observing the thing the flag claims to control rather than the flag itself.
 *
 * The page is a single fake room connection, because that is the attachment path where all five features
 * are installed: the renumbering rewriter needs the room seam, and the catalogue/ render/ jotai hooks are
 * installed by `start()` regardless.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BootstrappedClientOptions } from '../src/client.ts';
import { BootstrappedClient } from '../src/client.ts';
import { installRealmOverride } from '../src/page/override.ts';
import type { PageRealm } from '../src/page/realm.ts';

/** The minimum room-connection shape `detectAttachment` accepts, with every subscription a no-op. */
class MinimalRoomConnection {
  isCommandSessionReady = true;
  lastDistributedRoomPublication: { executedCommandSequence?: unknown } | null = {
    executedCommandSequence: 1,
  };
  lastRoomStateJsonable: unknown = { data: {} };
  sendMessage(): void {
    // Nothing needs to go out in this test.
  }
  trySendMessageNow(): boolean {
    return true;
  }
  subscribeToRoomFrames(): () => void {
    return () => undefined;
  }
  subscribeToWelcome(): () => void {
    return () => undefined;
  }
  subscribeToPatches(): () => void {
    return () => undefined;
  }
}

/**
 * Start a client over one fake room connection, hand it to `run`, and always stop it.
 *
 * `undefined` for `features` means the caller passed no feature options at all, so the defaults are what
 * the first test observes.
 */
async function withClient(
  features: BootstrappedClientOptions['features'],
  run: (client: BootstrappedClient) => void,
): Promise<void> {
  const page = { MagicCircle_RoomConnection: new MinimalRoomConnection() } as Record<string, unknown>;
  const restore = installRealmOverride({ page: page as unknown as PageRealm });
  const client = new BootstrappedClient({
    page: page as unknown as PageRealm,
    storage: { forceBackend: 'memory' },
    ...(features !== undefined ? { features } : {}),
    roomUpgradeTimeoutMs: 0,
  });
  try {
    await client.start();
    await client.waitForAttachment();
    run(client);
  } finally {
    await client.stop();
    restore();
  }
}

void test('a default client installs all five features', async () => {
  await withClient(undefined, (client) => {
    const detail = client.report.detail;
    assert.equal(detail.render.enabled, true, 'the Pixi capture is on by default');
    assert.equal(detail.jotai.enabled, true, 'the jotai bridge is on by default');
    assert.equal(detail.catalog.enabled, true, 'the catalogue hook is on by default');
    assert.ok(
      (client.catalog?.sourceIds ?? []).includes('platform-api'),
      'the platform source is on by default',
    );
    assert.equal(detail.renumbering.enabled, true, 'the renumbering hook is on by default');
  });
});

void test('features.render: false suppresses the Pixi capture', async () => {
  await withClient({ render: false }, (client) => {
    assert.equal(client.report.detail.render.enabled, false);
    assert.equal(client.report.detail.render.initFired, false);
  });
});

void test('features.jotai: false leaves the bridge null', async () => {
  await withClient({ jotai: false }, (client) => {
    assert.equal(client.report.detail.jotai.enabled, false);
    assert.equal(client.report.detail.jotai.atomsSeen, 0);
  });
});

void test('features.catalog: false leaves no catalogue at all', async () => {
  await withClient({ catalog: false }, (client) => {
    assert.equal(client.catalog, null);
    assert.equal(client.report.detail.catalog.enabled, false);
    assert.deepEqual(client.report.detail.catalog.tables, []);
  });
});

void test('features.platformCatalog: false wires no platform source', async () => {
  await withClient({ platformCatalog: false }, (client) => {
    const ids = client.catalog?.sourceIds ?? [];
    // `sourceIds` is the observable that decides whether any request is ever made: a source that is not
    // wired up cannot fetch. Asserting it here keeps the test off the network.
    assert.ok(!ids.includes('platform-api'), `saw ${JSON.stringify(ids)}`);
    assert.equal(client.report.detail.catalog.enabled, true, 'the in-page capture stays wired');
  });
});

void test('features.renumbering: false installs no rewriter', async () => {
  await withClient({ renumbering: false }, (client) => {
    assert.equal(client.report.detail.renumbering.enabled, false);
    assert.equal(client.report.renumbering, false);
  });
});
