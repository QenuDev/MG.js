/**
 * The three reads, off captured payloads, with no socket.
 *
 * Everything a test needs to know about the game is in `fixtures/atlas/`: the manifest and the first pack
 * were captured live, the version answer is the shape the plan captured (`{"version":"1189"}`) carrying the
 * version the captured manifest is read from, and the three sibling packs the first pack names are written
 * here -- the capture holds pack 0 only, because the rest of the set is what the walk discovers.
 *
 * The `fetch` is a stub over those payloads, and it answers *only* the URLs it was given. That is the point
 * rather than a convenience: which URL was asked for is the only way to see a relative path resolve, so the
 * assertions below are mostly about the request, not about the value that came back.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { atlasImage, atlasPacks, gameVersion } from '../../src/source/index.ts';

const fixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/atlas/${name}`, import.meta.url), 'utf8');

const ORIGIN = 'https://magicgarden.gg';
const VERSION = '1191';
const ASSETS = `${ORIGIN}/version/${VERSION}/assets/`;
const MANIFEST = `${ASSETS}manifest.json`;
const FIRST_PACK = `${ASSETS}atlases/sprites-2x-0.json`;

/**
 * The live image the captured first pack points at, resolved: `meta.image` is
 * `../../../../runtime-assets/sprites-2x-0.f8d9eded5f10abf24410.ktx2` read from `atlases/sprites-2x-0.json`,
 * four directories up from the pack and beside `/version/` rather than under it.
 */
const IMAGE = `${ORIGIN}/runtime-assets/sprites-2x-0.f8d9eded5f10abf24410.ktx2`;

/**
 * The image body a test serves. Deliberately not a captured `.ktx2`: the capture is 4.9 MB, no `.ktx2`
 * belongs in the tree, and nothing here reads a pixel -- what is under test is that the whole body arrives
 * in one request, so any bytes at all are as good as the game's.
 */
const IMAGE_BYTES = Uint8Array.from({ length: 64 }, (_, index) => index);

/** The siblings the captured first pack names, as the walk discovers them. */
const RELATED = ['sprites-2x-1.json', 'sprites-2x-2.json', 'sprites-2x-3.json'] as const;

/**
 * The sibling packs, and nothing else: one frame each, and a `related_multi_packs` that names the other
 * three back.
 *
 * Written here rather than added to `fixtures/atlas/`, so that everything in that directory is a captured
 * payload and nothing is a plausible-looking invention. They carry no `meta.image`, for the same reason:
 * these packs exist to make the walk observable, and a texture hash for a texture nobody fetches would be a
 * game value with no source.
 */
function siblingPayloads(): Record<string, string> {
  const payloads: Record<string, string> = {};
  for (const name of RELATED) {
    const stem = name.replace('.json', '');
    payloads[`${ASSETS}atlases/${name}`] = JSON.stringify({
      frames: {
        [`sprite/related/${stem}`]: {
          frame: { x: 0, y: 0, w: 8, h: 8 },
          rotated: false,
          trimmed: false,
          sourceSize: { w: 8, h: 8 },
          anchor: { x: 0.5, y: 0.5 },
        },
      },
      meta: {
        // The chain is symmetric live -- each pack names the other three -- so it is here: it is what makes
        // the walk prove it terminates on a name it has already read rather than on a list it was handed.
        related_multi_packs: ['sprites-2x-0.json', ...RELATED].filter((other) => other !== name),
      },
    });
  }
  return payloads;
}

interface Recorded {
  readonly url: string;
  readonly headers: Headers;
  readonly redirect: RequestRedirect | undefined;
}

interface Stub {
  readonly fetch: typeof fetch;
  readonly requests: Recorded[];
  saw(url: string): boolean;
  count(url: string): number;
}

/**
 * `Uint8Array<ArrayBuffer>` rather than plain `Uint8Array`: a response body is a `BodyInit`, and a view over
 * an `ArrayBufferLike` that might be a `SharedArrayBuffer` is not one.
 */
type Payload = string | Uint8Array<ArrayBuffer>;
/** A route that can look at the request: used for the image, which is where a `Range` would show up. */
type Route = (request: Recorded) => Response;

function jsonResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Bytes with the headers the real response was measured to carry. `accept-ranges` is advertised, unused. */
function binaryResponse(body: Uint8Array<ArrayBuffer>): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'image/ktx2', 'accept-ranges': 'bytes' },
  });
}

/** A `fetch` that answers the URLs it was given, 404s everything else, and records every request. */
function stubFetch(routes: Record<string, Payload | Route>): Stub {
  const requests: Recorded[] = [];
  const doFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const recorded: Recorded = { url, headers: new Headers(init?.headers), redirect: init?.redirect };
    requests.push(recorded);

    const route = routes[url];
    if (route === undefined) {
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (typeof route === 'function') return route(recorded);
    return typeof route === 'string' ? jsonResponse(route) : binaryResponse(route);
  };
  return {
    fetch: doFetch,
    requests,
    saw: (url) => requests.some((request) => request.url === url),
    count: (url) => requests.filter((request) => request.url === url).length,
  };
}

/** The manifest and the four sprite packs the walk reaches, and nothing more. */
function atlasRoutes(extra: Record<string, Payload | Route> = {}): Record<string, Payload | Route> {
  return {
    [MANIFEST]: fixture('manifest-1191.json'),
    [FIRST_PACK]: fixture('pack-sprites-2x-0.json'),
    ...siblingPayloads(),
    ...extra,
  };
}

const askedUrls = (stub: Stub): string => stub.requests.map((request) => request.url).join(', ');

void test('the game version is read from the platform route and returned as the string it stated', async () => {
  const stub = stubFetch({ [`${ORIGIN}/platform/v1/version`]: fixture('version-1191.json') });

  assert.equal(await gameVersion({ fetch: stub.fetch }), '1191');
  assert.deepEqual(
    stub.requests.map((request) => request.url),
    [`${ORIGIN}/platform/v1/version`],
  );
});

void test('a version route that states no version is refused rather than pasted into a URL', async () => {
  // `1189` rather than `"1189"`: the shape the game answers a changed route with, and the one that would
  // otherwise build `/version//assets/manifest.json` and report a 404 about the manifest.
  const stub = stubFetch({ [`${ORIGIN}/platform/v1/version`]: JSON.stringify({ version: 1189 }) });

  await assert.rejects(gameVersion({ fetch: stub.fetch }), /rather than a version string/);
});

void test('a frame that states no sourcePixelRatio draws at its stated size, not NaN', async () => {
  const stub = stubFetch(atlasRoutes());

  const frames = await atlasPacks(VERSION, { fetch: stub.fetch });

  // The first frame of the first pack, captured live: 256x128 stated, no ratio, anchor in the middle. A
  // `source.w / frame.sourcePixelRatio` with no guard divides by `undefined`.
  const first = 'sprite/animation/NotifyFlag-0';
  assert.equal([...frames.keys()][0], first, 'the walk keeps the pack’s own frame order');
  assert.deepEqual(frames.get(first), {
    width: 256,
    height: 128,
    pixelRatio: 1,
    anchorX: 0.5,
    anchorY: 0.5,
  });
  assert.equal(Number.isNaN(frames.get(first)?.width), false);
});

void test('a frame that does state a sourcePixelRatio is divided by it', async () => {
  const stub = stubFetch(atlasRoutes());

  const frames = await atlasPacks(VERSION, { fetch: stub.fetch });

  // The other captured frame in the fixture: `sourceSize` 1024x1024 with `sourcePixelRatio: 2`.
  assert.deepEqual(frames.get('sprite/mutation-overlay/ChilledTallPlant'), {
    width: 512,
    height: 512,
    pixelRatio: 2,
    anchorX: 0.5,
    anchorY: 0.5,
  });
});

void test('a related_multi_packs filename resolves beside the pack that named it', async () => {
  const stub = stubFetch(atlasRoutes());

  const frames = await atlasPacks(VERSION, { fetch: stub.fetch });

  // Beside the pack, which is `atlases/`: what the reference loader does with `dir + related`.
  for (const name of RELATED) {
    assert.ok(stub.saw(`${ASSETS}atlases/${name}`), `expected a read of ${name}; asked ${askedUrls(stub)}`);
  }
  // And not against the asset root, which is where resolving the same bare name against the manifest puts
  // it: `sprites-2x-1.json` is not `atlases/sprites-2x-1.json`.
  assert.equal(
    stub.saw(`${ASSETS}sprites-2x-1.json`),
    false,
    'the sibling is not resolved against the assets root',
  );
  assert.equal(frames.size, 5, 'two captured frames and one from each of the three siblings');
});

void test('the first pack is the sprite atlas at resolution 2, not at resolution 1', async () => {
  const stub = stubFetch(atlasRoutes());

  await atlasPacks(VERSION, { fetch: stub.fetch });

  assert.ok(stub.saw(FIRST_PACK), `expected a read of ${FIRST_PACK}; asked ${askedUrls(stub)}`);
  // The manifest names six packs, three aliases at two resolutions each. None of the other five is reached:
  // the walk starts at one pack and follows the pack's own pointers from there.
  for (const url of stub.requests.map((request) => request.url)) {
    assert.equal(
      /sprites-1x|tiles|weather/.test(url),
      false,
      `the walk read something it should not have: ${url}`,
    );
  }
});

void test('the atlas image resolves to /runtime-assets/, beside /version/ rather than under it', async () => {
  const stub = stubFetch(atlasRoutes({ [IMAGE]: () => binaryResponse(IMAGE_BYTES) }));

  await atlasPacks(VERSION, { fetch: stub.fetch });
  const image = await atlasImage(FIRST_PACK, { fetch: stub.fetch });

  assert.ok(stub.saw(IMAGE), `expected a read of ${IMAGE}; asked ${askedUrls(stub)}`);
  assert.equal(
    stub.requests.some(
      (request) => request.url.startsWith(`${ORIGIN}/version/`) && request.url.endsWith('.ktx2'),
    ),
    false,
    'nothing was read from under /version/ as an image',
  );
  assert.equal(image.byteLength, IMAGE_BYTES.byteLength);
  // The pack's own JSON was read once: `atlasImage` resolves the image from the pack, and it came from the
  // cache `atlasPacks` filled rather than a second trip.
  assert.equal(stub.count(FIRST_PACK), 1);
});

void test('the whole image is read in one request, and accept-ranges is not relied on', async () => {
  const refused: string[] = [];
  const stub = stubFetch(
    atlasRoutes({
      [IMAGE]: (request) => {
        if (request.headers.has('range')) {
          refused.push(request.headers.get('range') ?? '');
          return new Response(null, { status: 416, headers: { 'accept-ranges': 'bytes' } });
        }
        return binaryResponse(IMAGE_BYTES);
      },
    }),
  );

  const image = await atlasImage(FIRST_PACK, { fetch: stub.fetch });

  // The real response advertises `accept-ranges: bytes`; this reader must not act on it. The route above
  // answers a range request with 416, so a reader that sent one would not have bytes to return at all.
  assert.deepEqual(refused, []);
  assert.deepEqual([...image], [...IMAGE_BYTES], 'the whole declared body, not a slice of it');
  // `fetchJson`'s policy, on the one request that does not go through `fetchJson`: a redirect from a pinned
  // origin is a rejection, not a hop.
  const imageRequest = stub.requests.find((request) => request.url === IMAGE);
  assert.equal(imageRequest?.redirect, 'error');
});

void test('a pack that points off the game’s origin is refused, not fetched', async () => {
  // The image a pack names is a path on the game's own origin. A pack that named a host instead would turn
  // reading a captured payload into a request to whoever wrote that payload.
  const elsewhere = 'https://example.invalid/sprites.ktx2';
  const stub = stubFetch({ [FIRST_PACK]: JSON.stringify({ frames: {}, meta: { image: elsewhere } }) });

  await assert.rejects(atlasImage(FIRST_PACK, { fetch: stub.fetch }), /not under/);
  assert.equal(stub.saw(elsewhere), false, 'the refusal happens before the request is made');
});

void test('a fetched answer is reused until the TTL passes, against an injected clock', async () => {
  const stub = stubFetch(atlasRoutes());
  let clock = 1_700_000_000_000;
  const options = () => ({ fetch: stub.fetch, now: () => clock });

  await atlasPacks(VERSION, options());
  assert.equal(stub.count(MANIFEST), 1);

  // The same clock: the second walk is served from the cache, manifest and packs both.
  await atlasPacks(VERSION, options());
  assert.equal(stub.count(MANIFEST), 1, 'a second read inside the TTL is not a second request');
  assert.equal(stub.count(FIRST_PACK), 1);

  // One millisecond past the default, which is the consumer's own frame cache TTL -- six hours,
  // `garden-viewer/server.mjs`'s `loadFrames` (`6 * 60 * 60 * 1000`) -- carried over unchanged.
  clock += 6 * 60 * 60 * 1000 + 1;
  await atlasPacks(VERSION, options());
  assert.equal(stub.count(MANIFEST), 2, 'past the TTL the answer is read again');
  assert.equal(stub.count(FIRST_PACK), 2);
});

void test('an explicit ttlMs is the one honoured', async () => {
  const route = `${ORIGIN}/platform/v1/version`;
  const stub = stubFetch({ [route]: fixture('version-1191.json') });
  let clock = 0;
  const read = () => gameVersion({ fetch: stub.fetch, now: () => clock, ttlMs: 1_000 });

  assert.equal(await read(), '1191');
  clock += 999;
  assert.equal(await read(), '1191');
  assert.equal(stub.count(route), 1);

  clock += 2;
  assert.equal(await read(), '1191');
  assert.equal(stub.count(route), 2, '1001ms is past a 1000ms TTL');
});
