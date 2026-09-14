/**
 * Live smoke check for the catalogue layer.
 *
 * This hits the real game endpoints, so it is a script rather than part of the test suite. A unit
 * test that requires the internet is a flaky test. Run it by hand:
 *
 *     npm run verify:catalog
 *
 * It answers one question: does `@mg.js/common`'s catalogue layer actually parse what the deployed
 * game serves today, rather than what the docs said it served?
 */

import { GAME_GRID_MS, restockCountdown } from '../packages/common/src/catalog/defs.js';
import { PlatformApiSource } from '../packages/common/src/catalog/platform-source.js';
import { CatalogClient } from '../packages/common/src/catalog/source.js';
import { weatherAt } from '../packages/common/src/catalog/weather.js';

async function main(): Promise<void> {
  const source = new PlatformApiSource();
  const client = new CatalogClient({ sources: [source], ttlMs: 0 });

  console.log('Fetching live catalogue from magicgarden.gg …\n');

  const catalog = await client.load();
  let failures = 0;

  const report = (label: string, ok: boolean, detail: string): void => {
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(34)} ${detail}`);
  };

  report(
    'version',
    typeof catalog.version === 'string' && catalog.version.length > 0,
    `version=${JSON.stringify(catalog.version)} source=${catalog.provenance.version ?? 'none'}`,
  );

  const shops = catalog.shops;
  const shopKeys = shops ? Object.keys(shops.shops) : [];
  report(
    'shops (present)',
    Boolean(shops) && shopKeys.length > 0,
    `${shopKeys.length} shops: ${shopKeys.join(', ')}`,
  );

  // Every shop must carry the fields the live API is observed to send. `nextRestockAt` is a string OR
  // null: the six seasonal shops are reported closed with a null timestamp.
  let shapedShops = 0;
  let permanentShops = 0;
  let seasonalShops = 0;
  for (const [key, shop] of Object.entries(shops?.shops ?? {})) {
    const ok =
      typeof shop.open === 'boolean' &&
      (typeof shop.nextRestockAt === 'string' || shop.nextRestockAt === null) &&
      Array.isArray(shop.items);
    if (ok) shapedShops += 1;
    else console.log(`      shop "${key}" has an unexpected shape: ${JSON.stringify(shop).slice(0, 120)}`);
    if (typeof shop.nextRestockAt === 'string') permanentShops += 1;
    else seasonalShops += 1;
  }
  report(
    'shops (shape)',
    shapedShops === shopKeys.length,
    `${shapedShops}/${shopKeys.length} shaped {open, nextRestockAt: string|null, items[]}`,
  );
  report(
    'shops (restock split)',
    permanentShops > 0,
    `${permanentShops} with a scheduled restock, ${seasonalShops} closed with nextRestockAt=null`,
  );

  // The first shop item must carry the fields the extractors rely on.
  const stockedShop = Object.values(shops?.shops ?? {}).find((shop) => shop.items.length > 0);
  const firstItem = stockedShop?.items[0];
  report(
    'shop item shape',
    Boolean(firstItem) &&
      typeof firstItem?.itemId === 'string' &&
      typeof firstItem?.name === 'string' &&
      typeof firstItem?.coinPrice === 'number' &&
      typeof firstItem?.stock === 'number',
    firstItem ? JSON.stringify(firstItem) : 'no stocked shop found',
  );

  // Weather is legitimately null, so this asserts that the *provenance* was recorded. That is the bug
  // check originally caught: a null value used to be indistinguishable from an unavailable category.
  report(
    'weather (resolved, not missing)',
    'weather' in catalog.provenance && !catalog.missing.includes('weather'),
    catalog.weather === null
      ? 'null (correct here: no weather active right now), recorded with provenance'
      : JSON.stringify(catalog.weather).slice(0, 120),
  );

  // The forecast is now *modelled* rather than passed through, so assert the model against the live
  // payload: the block must have normalised into `current` + `upcoming`, every slot must carry all five
  // fields (including explicit nulls, which the live data does send), and a slot's own window must resolve
  // back to itself through `weatherAt`.
  const forecast = catalog.weather;
  if (forecast !== null) {
    const slotFields = ['weatherId', 'name', 'groupId', 'startsAt', 'endsAt'];
    const slots = [...(forecast.current === null ? [] : [forecast.current]), ...forecast.upcoming];
    const shaped = slots.every((slot) => slotFields.every((field) => field in slot));
    report(
      'weather (modelled forecast)',
      shaped && Array.isArray(forecast.upcoming),
      `current=${forecast.current === null ? 'null' : JSON.stringify(forecast.current.weatherId)} ` +
        `upcoming=${forecast.upcoming.length} slots, ${slots.length}/${slots.length} shaped`,
    );

    const first = forecast.upcoming[0];
    if (first !== undefined && first.startsAt !== null) {
      const found = weatherAt(forecast, Date.parse(first.startsAt));
      report(
        'weatherAt resolves a live slot',
        found?.slot.startsAt === first.startsAt,
        found === null
          ? 'no slot matched its own startsAt'
          : `startsAt=${first.startsAt} -> groupId=${found.slot.groupId ?? 'null'}`,
      );
    }
  }

  // Restock maths against a real timestamp.
  const seed = shops?.shops.seed;
  if (seed && seed.nextRestockAt !== null) {
    const countdown = restockCountdown(seed);
    report(
      'restock countdown',
      countdown !== null,
      countdown
        ? `${Math.round(countdown.ms / 1000)}s away (${countdown.gridSlots} grid slots, GRID_MS=${GAME_GRID_MS})`
        : 'unparseable nextRestockAt',
    );
  }

  // A closed seasonal shop must yield a null countdown, not a bogus zero.
  const seasonal = Object.values(shops?.shops ?? {}).find((shop) => shop.nextRestockAt === null);
  if (seasonal) {
    report(
      'closed shop countdown',
      restockCountdown(seasonal) === null,
      'nextRestockAt=null correctly yields no countdown rather than 0',
    );
  }

  // The categories this source is honest about not having.
  report(
    'plants correctly missing',
    catalog.plants === null && catalog.missing.includes('plants'),
    'platform API does not serve entity catalogues; a RemoteJsonSource must',
  );

  console.log(`\n${failures === 0 ? 'ALL LIVE CHECKS PASSED' : `${failures} LIVE CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error('Live verification could not complete:', error);
  process.exitCode = 1;
});
