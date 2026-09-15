/**
 * Which catalogue sources the bootstrapped client wires up.
 *
 * The bug this guards against: the client used to capture the game's in-page entity tables and nothing
 * else. That is the *only* authoritative source for plants, pets and items, but it can never supply shops
 * or weather, because the developers moved those off the socket and onto
 * `https://magicgarden.gg/platform/v1/*`. So an in-page mod asking for the weather forecast got
 * `missing: ['shops', 'weather']` forever, with nothing in the report explaining why.
 *
 * A mod running on that origin can call the platform API directly; reference mods do the same
 * (AriesMod reads `/platform/v1/version`).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BootstrappedClient } from '../../src/client.ts';
import { BUNDLE_SOURCE_ID } from '../../src/live-catalog/object-keys-source.ts';
import { installRealmOverride } from '../../src/page/override.ts';
import type { PageRealm } from '../../src/page/realm.ts';

function makeClient(
  page: Record<string, unknown>,
  options: Record<string, unknown> = {},
): BootstrappedClient {
  return new BootstrappedClient({
    page: page as unknown as PageRealm,
    storage: { forceBackend: 'memory' },
    features: { render: false, jotai: false },
    ...options,
  });
}

void test('the bootstrapped catalogue includes the live platform source by default', async () => {
  const page = {} as Record<string, unknown>;
  const restore = installRealmOverride({ page: page as unknown as PageRealm });
  const client = makeClient(page);
  try {
    await client.start();
    const ids = client.catalog?.sourceIds ?? [];
    assert.ok(
      ids.includes('platform-api'),
      `shops and weather exist only on the platform API, so it must be wired up; saw ${JSON.stringify(ids)}`,
    );
    // The in-page capture stays first: it is the authoritative source for the game's own entity tables.
    assert.equal(ids[0], BUNDLE_SOURCE_ID, `expected the bundle first, saw ${JSON.stringify(ids)}`);
  } finally {
    await client.stop();
    restore();
  }
});

void test('a mod that must make no network requests can drop the platform source', async () => {
  const page = {} as Record<string, unknown>;
  const restore = installRealmOverride({ page: page as unknown as PageRealm });
  const client = makeClient(page, { features: { platformCatalog: false } });
  try {
    await client.start();
    const ids = client.catalog?.sourceIds ?? [];
    assert.ok(!ids.includes('platform-api'), `saw ${JSON.stringify(ids)}`);
  } finally {
    await client.stop();
    restore();
  }
});

void test('disabling the catalogue disables every source, not just the capture hook', async () => {
  // Regression guard for the shape of the option: `features.catalog: false` means "no catalogue at all", so
  // it must not leave a live platform source running behind a null client.
  const page = {} as Record<string, unknown>;
  const restore = installRealmOverride({ page: page as unknown as PageRealm });
  const client = makeClient(page, { features: { catalog: false } });
  try {
    await client.start();
    assert.equal(client.catalog, null);
  } finally {
    await client.stop();
    restore();
  }
});
