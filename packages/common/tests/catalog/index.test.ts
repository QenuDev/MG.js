/**
 * The catalogue layer: source merging, provenance, degradation, and live-fetch parsing.
 *
 * The failure policy is the thing under test. The existing server's `/data` route degrades with
 * `Promise.allSettled` precisely so one dead upstream does not take the whole tree down; a wrapper that
 * threw because the pets list was unavailable would be strictly worse.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CatalogKind, ShopState } from '../../src/catalog/defs.js';
import { CATALOG_KINDS, emptyCatalog, GAME_GRID_MS, restockCountdown } from '../../src/catalog/defs.js';
import { PLATFORM_PATHS, PlatformApiSource } from '../../src/catalog/platform-source.js';
import { DEFAULT_REMOTE_PATHS, RemoteJsonSource } from '../../src/catalog/remote-json-source.js';
import type { CatalogSource } from '../../src/catalog/source.js';
import { CatalogClient } from '../../src/catalog/source.js';
import { StaticCatalogSource } from '../../src/catalog/static-source.js';

/** A source that can be told to fail or to return nothing. */
function fakeSource(id: string, kinds: CatalogKind[], impl: (kind: CatalogKind) => unknown): CatalogSource {
  return {
    id,
    capabilities: new Set(kinds),
    async load(kind) {
      return impl(kind);
    },
  };
}

describe('CatalogClient', () => {
  it('fills every category it can and reports the rest as missing', async () => {
    const client = new CatalogClient({
      sources: [
        fakeSource('a', ['version', 'plants'], (kind) => (kind === 'version' ? '1157' : [{ id: 'Carrot' }])),
      ],
    });
    const catalog = await client.load();
    assert.equal(catalog.version, '1157');
    assert.deepEqual(catalog.plants, [{ id: 'Carrot' }]);
    assert.equal(catalog.pets, null, 'an unsupplied category must be null, never an empty array');
    assert.ok(catalog.missing.includes('pets'));
    assert.ok(!catalog.missing.includes('plants'));
  });

  it('records provenance per category', async () => {
    const client = new CatalogClient({
      sources: [
        fakeSource('first', ['version'], () => '1'),
        fakeSource('second', ['plants'], () => [{ id: 'Beet' }]),
      ],
    });
    const catalog = await client.load();
    assert.equal(catalog.provenance.version, 'first');
    assert.equal(catalog.provenance.plants, 'second');
  });

  it('lets an earlier source win a category', async () => {
    const client = new CatalogClient({
      sources: [
        fakeSource('winner', ['version'], () => 'live'),
        fakeSource('loser', ['version'], () => 'stale'),
      ],
    });
    const catalog = await client.load();
    assert.equal(catalog.version, 'live');
    assert.equal(catalog.provenance.version, 'winner');
  });

  it('falls through to the next source when one returns null', async () => {
    const client = new CatalogClient({
      sources: [fakeSource('empty', ['version'], () => null), fakeSource('real', ['version'], () => '1157')],
    });
    const catalog = await client.load();
    assert.equal(catalog.version, '1157');
    assert.equal(catalog.provenance.version, 'real');
  });

  it('survives a source that throws and keeps loading the others', async () => {
    const errors: string[] = [];
    const client = new CatalogClient({
      sources: [
        fakeSource('broken', ['plants', 'pets'], () => {
          throw new Error('upstream down');
        }),
        fakeSource('healthy', ['pets'], () => [{ id: 'Cat' }]),
      ],
      onSourceError: (id, kind) => errors.push(`${id}:${kind}`),
    });
    const catalog = await client.load();
    assert.equal(catalog.plants, null);
    assert.deepEqual(catalog.pets, [{ id: 'Cat' }]);
    // Lexicographic: 'broken:pe' < 'broken:pl'.
    assert.deepEqual(errors.sort(), ['broken:pets', 'broken:plants']);
  });

  it('records a source failure even when no callback is given', async () => {
    // The production wiring passed no `onSourceError`, so with every endpoint down the catalogue said
    // only "missing" and nothing anywhere recorded *why*, silently, for the whole 300 s TTL. The
    // summary is the observable that survives a lost callback, so this asserts the catalogue, not the
    // presence of a `catch` block.
    const client = new CatalogClient({
      sources: [
        fakeSource('broken', ['plants'], () => {
          throw new Error('upstream down');
        }),
      ],
    });
    const catalog = await client.load();
    assert.equal(catalog.errors.plants?.code, 'source_failure');
    assert.equal(catalog.errors.plants?.message, 'upstream down');
    assert.ok(
      catalog.missing.includes('plants'),
      'a failure must still leave the category visibly missing, not silently empty',
    );
  });

  it('does not call a source for a category it does not advertise', async () => {
    const asked: CatalogKind[] = [];
    const client = new CatalogClient({
      sources: [
        fakeSource('narrow', ['version'], (kind) => {
          asked.push(kind);
          return '1';
        }),
      ],
    });
    await client.load();
    assert.deepEqual(asked, ['version']);
  });

  it('normalizes a record keyed by id into an array of entities', async () => {
    const client = new CatalogClient({
      sources: [fakeSource('mapped', ['plants'], () => ({ Carrot: { rarity: 'common' } }))],
    });
    const catalog = await client.load();
    assert.deepEqual(catalog.plants, [{ id: 'Carrot', rarity: 'common' }]);
  });

  it('preserves an existing id field when normalizing', async () => {
    const client = new CatalogClient({
      sources: [fakeSource('mapped', ['pets'], () => ({ key: { id: 'explicit' } }))],
    });
    const catalog = await client.load();
    assert.deepEqual(catalog.pets, [{ id: 'explicit' }]);
  });

  it('caches within the TTL', async () => {
    let loads = 0;
    const client = new CatalogClient({
      sources: [
        fakeSource('counted', ['version'], () => {
          loads += 1;
          return '1';
        }),
      ],
      ttlMs: 60_000,
    });
    await client.load();
    await client.load();
    assert.equal(loads, 1);
    assert.equal(client.isFresh, true);
  });

  it('reloads when forced', async () => {
    let loads = 0;
    const client = new CatalogClient({
      sources: [
        fakeSource('counted', ['version'], () => {
          loads += 1;
          return String(loads);
        }),
      ],
    });
    await client.load();
    const refreshed = await client.refresh();
    assert.equal(loads, 2);
    assert.equal(refreshed.version, '2');
  });

  it('shares one in-flight load between concurrent callers', async () => {
    let loads = 0;
    const client = new CatalogClient({
      sources: [
        {
          id: 'slow',
          capabilities: new Set<CatalogKind>(['version']),
          async load() {
            loads += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return '1';
          },
        },
      ],
    });
    await Promise.all([client.load(), client.load(), client.load()]);
    assert.equal(loads, 1, 'a burst of callers must not produce a burst of requests');
  });

  it('notifies subscribers after a load', async () => {
    const client = new CatalogClient({
      sources: [fakeSource('a', ['version'], () => '1')],
    });
    let seen: string | null = null;
    client.subscribe((catalog) => {
      seen = catalog.version;
    });
    await client.load();
    assert.equal(seen, '1');
  });

  it('resolves a legitimately-null category instead of reporting it missing', async () => {
    // REGRESSION: the live weather endpoint returns literal `null` when nothing is active. Before the
    // fix, a null was indistinguishable from "no source has this", so weather was permanently reported
    // as missing, conflating "no weather" with "no weather source".
    const client = new CatalogClient({
      sources: [fakeSource('nullable', ['weather'], () => null)],
    });
    const catalog = await client.load();
    assert.equal(catalog.weather, null);
    assert.equal(catalog.provenance.weather, 'nullable');
    assert.ok(!catalog.missing.includes('weather'), 'a resolved null is a value, not an absence');
  });

  it('lets a real value from a later source beat an earlier explicit null', async () => {
    const client = new CatalogClient({
      sources: [
        fakeSource('nullable', ['weather'], () => null),
        fakeSource('real', ['weather'], () => ({ era: 'rain' })),
      ],
    });
    const catalog = await client.load();
    assert.deepEqual(catalog.weather, { era: 'rain' });
    assert.equal(catalog.provenance.weather, 'real');
  });

  it('does not coerce a null into a misleading empty array or the string "null"', async () => {
    const client = new CatalogClient({
      sources: [fakeSource('nullable', ['plants', 'version'], () => null)],
    });
    const catalog = await client.load();
    assert.equal(catalog.plants, null, 'must not become []');
    assert.equal(catalog.version, null, 'must not become the string "null"');
    assert.ok(!catalog.missing.includes('plants'));
  });

  it('still reports an unsupplied category as missing', async () => {
    const client = new CatalogClient({ sources: [fakeSource('narrow', ['version'], () => '1')] });
    const catalog = await client.load();
    assert.equal(catalog.weather, null);
    assert.ok(catalog.missing.includes('weather'));
    assert.equal(catalog.provenance.weather, undefined);
  });

  it('finds an entity by id', async () => {
    const client = new CatalogClient({
      sources: [fakeSource('a', ['plants'], () => [{ id: 'Carrot' }, { id: 'Beet' }])],
    });
    assert.equal(client.find('plants', 'nope'), null, 'before a load there is nothing to find');
    await client.load();
    assert.deepEqual(client.find('plants', 'Beet'), { id: 'Beet' });
    assert.equal(client.find('plants', 'nope'), null);
    assert.equal(client.find('pets', 'Beet'), null, 'a non-array category must not throw');
  });
});

describe('StaticCatalogSource', () => {
  it('advertises only the categories it has', () => {
    const source = new StaticCatalogSource({ data: { version: '1' } });
    assert.deepEqual([...source.capabilities], ['version']);
    assert.equal(source.capabilities.has('plants'), false);
  });

  it('returns null for a category it does not have', async () => {
    const source = new StaticCatalogSource({ data: { version: '1' } });
    assert.equal(await source.load('plants'), null);
  });

  it('supports a lazy value that is re-read on every load', async () => {
    let value = 1;
    const source = new StaticCatalogSource({ data: { version: () => String(value) } });
    assert.equal(await source.load('version'), '1');
    value = 2;
    assert.equal(await source.load('version'), '2');
  });

  it('learns a new category at runtime', async () => {
    const source = new StaticCatalogSource({ data: {} });
    source.set('plants', [{ id: 'Carrot' }]);
    assert.equal(source.capabilities.has('plants'), true);
    assert.deepEqual(await source.load('plants'), [{ id: 'Carrot' }]);
  });
});

describe('PlatformApiSource', () => {
  it('advertises version, shops and weather', () => {
    const source = new PlatformApiSource();
    assert.deepEqual([...source.capabilities].sort(), ['shops', 'version', 'weather']);
  });

  it('returns null for a category it cannot supply', async () => {
    const source = new PlatformApiSource();
    assert.equal(await source.load('plants'), null);
  });

  it('uses the documented endpoint paths', () => {
    assert.equal(PLATFORM_PATHS.version, '/platform/v1/version');
    assert.equal(PLATFORM_PATHS.shops, '/platform/v1/shops');
    assert.equal(PLATFORM_PATHS.weather, '/platform/v1/weather');
  });

  it('rejects a version payload with no usable version', async () => {
    // A version we cannot read is worse than no version: the existing server treats this
    // condition as fatal for its whole /data tree, and 4710 recovery depends on it being real.
    const source = new PlatformApiSource({ baseUrl: 'https://example.test' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
    try {
      await assert.rejects(source.fetchVersion(), /no usable version/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('normalises a null weather response into an inactive forecast', async () => {
    // Verified live: `/platform/v1/weather` returns literal `null` when no weather is active. That is a
    // legitimate answer, not a failure, and it is now normalised rather than passed through, so a caller
    // gets a shape it can read (`{ current: null, upcoming: [] }`) instead of having to special-case null.
    const source = new PlatformApiSource({ baseUrl: 'https://example.test' });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls += 1;
      // The shops request is tried first for the forecast block; answer it without a `weather` key so the
      // legacy endpoint is the one that resolves the answer.
      if (String(input).includes('/shops')) {
        return new Response(JSON.stringify({ shops: {} }), { status: 200 });
      }
      return new Response('null', { status: 200 });
    }) as typeof fetch;
    try {
      assert.deepEqual(await source.fetchWeather(), { current: null, upcoming: [] });
    } finally {
      globalThis.fetch = originalFetch;
      assert.equal(calls, 2, 'the shops block is tried first, then the legacy endpoint');
    }
  });

  it('prefers the shops weather block, which is the only source with a forecast', async () => {
    const source = new PlatformApiSource({ baseUrl: 'https://example.test' });
    const originalFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(
        JSON.stringify({
          shops: { seed: { open: true } },
          weather: {
            current: null,
            upcoming: [
              {
                weatherId: null,
                name: null,
                groupId: 'Lunar',
                startsAt: '2026-09-13T20:00:00.000Z',
                endsAt: '2026-09-13T20:10:00.000Z',
              },
            ],
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      const forecast = await source.fetchWeather();
      assert.equal(forecast.current, null);
      assert.equal(forecast.upcoming.length, 1);
      assert.equal(forecast.upcoming[0]?.groupId, 'Lunar');
      // One request is enough: the block is complete, so the legacy endpoint is not consulted.
      assert.equal(seen.length, 1);
      assert.match(seen[0] ?? '', /\/shops$/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fetches the shops payload once per refresh, for both shops and weather', async () => {
    // `shops` and `weather` are separate kinds but share one endpoint. Before the dedupe, a full catalogue
    // refresh issued two byte-identical GETs to `/platform/v1/shops` on every single load.
    const source = new PlatformApiSource({ baseUrl: 'https://example.test' });
    const client = new CatalogClient({ sources: [source], ttlMs: 0 });
    const originalFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.includes('/shops')) {
        return new Response(
          JSON.stringify({
            shops: { seed: { open: true, items: [], nextRestockAt: null } },
            weather: { current: null, upcoming: [] },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ version: '1158' }), { status: 200 });
    }) as typeof fetch;
    try {
      const catalog = await client.load();
      assert.equal(catalog.weather?.upcoming.length, 0);
      assert.notEqual(catalog.shops, null);
      const shopsRequests = seen.filter((url) => url.includes('/shops'));
      assert.equal(shopsRequests.length, 1, `expected one shops request, saw ${JSON.stringify(seen)}`);
      // The forecast block was found, so the legacy endpoint was not needed either.
      assert.equal(seen.filter((url) => url.endsWith('/weather')).length, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to the legacy endpoint when the shops request fails', async () => {
    // A shops outage must not cost the caller the current weather; the two endpoints are independent.
    const source = new PlatformApiSource({ baseUrl: 'https://example.test' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('/shops')) {
        return new Response('nope', { status: 500 });
      }
      return new Response(JSON.stringify({ weatherId: 'Frost', name: 'Snow' }), { status: 200 });
    }) as typeof fetch;
    try {
      const forecast = await source.fetchWeather();
      assert.equal(forecast.current?.weatherId, 'Frost');
      assert.deepEqual(forecast.upcoming, []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('RemoteJsonSource', () => {
  it('unwraps a single-key response matching the category', async () => {
    const source = new RemoteJsonSource({ baseUrl: 'https://example.test' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ plants: [{ id: 'Carrot' }] }), { status: 200 })) as typeof fetch;
    try {
      assert.deepEqual(await source.load('plants'), [{ id: 'Carrot' }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('leaves a multi-key response untouched', async () => {
    const source = new RemoteJsonSource({ baseUrl: 'https://example.test' });
    const originalFetch = globalThis.fetch;
    const payload = { plants: [], pets: [] };
    globalThis.fetch = (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
    try {
      assert.deepEqual(await source.load('plants'), payload);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('serves the last good payload on a 304', async () => {
    const source = new RemoteJsonSource({ baseUrl: 'https://example.test' });
    const originalFetch = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({ plants: [{ id: 'Carrot' }] }), { status: 200 });
      }
      // 304 is a null-body status, so the Response must be constructed with a null body.
      return new Response(null, { status: 304, headers: { ETag: 'abc' } });
    }) as typeof fetch;
    try {
      assert.deepEqual(await source.load('plants'), [{ id: 'Carrot' }]);
      const second = await source.load('plants');
      assert.deepEqual(second, [{ id: 'Carrot' }], 'a 304 must serve the cached payload, not throw');
      assert.equal(call, 2, 'the 304 response must have been requested and handled');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('still throws a non-304 error when there is no cached payload to fall back on', async () => {
    const source = new RemoteJsonSource({ baseUrl: 'https://example.test' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 304 })) as typeof fetch;
    try {
      await assert.rejects(source.load('plants'), /304/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses the documented default route names, including the plural weathers', () => {
    assert.equal(DEFAULT_REMOTE_PATHS.plants, '/data/plants');
    assert.equal(DEFAULT_REMOTE_PATHS.weather, '/data/weathers');
  });

  it('honours a path override and a restricted kind list', async () => {
    const source = new RemoteJsonSource({
      baseUrl: 'https://example.test',
      paths: { plants: '/custom/plants' },
      kinds: ['plants'],
    });
    assert.deepEqual([...source.capabilities], ['plants']);
    assert.equal(await source.load('pets'), null);
  });
});

describe('catalogue helpers', () => {
  it('starts an empty catalogue with everything missing', () => {
    const catalog = emptyCatalog();
    assert.equal(catalog.plants, null);
    assert.deepEqual(catalog.missing, [...CATALOG_KINDS]);
    assert.equal(catalog.loadedAt, 0);
  });

  it('uses the game grid quantum carried over from the existing server', () => {
    assert.equal(GAME_GRID_MS, 300_000);
  });

  it('computes a restock countdown at read time', () => {
    const now = Date.parse('2026-09-13T14:45:00.000Z');
    const result = restockCountdown(
      { open: true, nextRestockAt: '2026-09-13T14:50:00.000Z', items: [] },
      now,
    );
    assert.equal(result?.ms, 300_000);
    assert.equal(result?.gridSlots, 1);
  });

  it('never reports a negative countdown', () => {
    const now = Date.parse('2026-09-13T15:00:00.000Z');
    const result = restockCountdown(
      { open: true, nextRestockAt: '2026-09-13T14:50:00.000Z', items: [] },
      now,
    );
    assert.equal(result?.ms, 0);
  });

  it('returns null for an unparseable restock timestamp', () => {
    assert.equal(restockCountdown({ open: true, nextRestockAt: 'nonsense', items: [] }), null);
  });

  it('returns null for a closed seasonal shop, which live-reports nextRestockAt as null', () => {
    // VERIFIED LIVE: rain/dawn/amber/snow/thunder/apology are reported as
    // { open:false, nextRestockAt:null, items:[], catalog:[] }.
    assert.equal(restockCountdown({ open: false, nextRestockAt: null, items: [] }), null);
  });

  it('accepts the undocumented `catalog` field the live payload carries', () => {
    const shop: ShopState = {
      open: false,
      nextRestockAt: null,
      items: [],
      catalog: [],
    };
    assert.equal(restockCountdown(shop), null);
  });

  it('computes a countdown for a permanent shop that has one', () => {
    const now = Date.parse('2026-09-13T14:45:00.000Z');
    const shop: ShopState = {
      open: true,
      nextRestockAt: '2026-09-13T14:50:00.000Z',
      items: [{ itemId: 'Carrot', itemType: 'Seed', name: 'Carrot Seed', coinPrice: 10, stock: 22 }],
    };
    assert.equal(restockCountdown(shop, now)?.ms, 300_000);
  });
});
