/**
 * The one place this entry reaches the network: the injected `fetch`, the policy every request is made
 * under, and the cache an answer is remembered in.
 *
 * `fetch`, and the clock a TTL is measured against, are arguments rather than globals. That is what makes
 * this entry's tests network-free and what lets a test move a TTL instead of waiting for one; it is also
 * the only reason a caller can reach this helper with a `fetch` the library cannot know about.
 *
 * The JSON reads go through `fetchJson` in `@mg.js/common/catalog`, which is where the timeout, the
 * streaming byte cap and the `redirect: 'error'` policy already live -- nothing here re-grows them. The
 * atlas image is the one read that cannot, because a `.ktx2` is not JSON and `fetchJson` would fail it at
 * `JSON.parse`. That read repeats the same policy against the same cap: `DEFAULT_MAX_RESPONSE_BYTES` is
 * imported rather than restated, because the reason the cap exists -- a hostile or broken endpoint must
 * not be able to make this buffer an unbounded body -- is not a reason that stops applying to pixels.
 */

import {
  DEFAULT_HEADERS,
  DEFAULT_MAX_RESPONSE_BYTES,
  type FetchJsonOptions,
  fetchJson,
  HttpError,
} from '@mg.js/common/catalog';

/**
 * What every source call is handed.
 *
 * All four are optional: with none of them the entry uses the global `fetch`, the real clock, the game's
 * six-hour TTL and the ten-second timeout `fetchJson` defaults to.
 */
export interface ArtSourceOptions {
  /** The `fetch` to call instead of the global one. A supplied `fetch` brings its own cache, below. */
  fetch?: typeof fetch;
  /** The clock a TTL is measured against, in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * How long a fetched answer is reused, in milliseconds. Defaults to
   * {@link DEFAULT_SOURCE_TTL_MS}. Zero (or less) reads every time.
   */
  ttlMs?: number;
  /** Abort a request after this many ms. Defaults to `fetchJson`'s own ten seconds. */
  timeoutMs?: number;
}

/** The game's own origin. Its public API, its asset tree and its binary tree are all here. */
export const GAME_ORIGIN = 'https://magicgarden.gg';

/**
 * How long a fetched answer is reused, in milliseconds: six hours.
 *
 * Not a number this package invented. It is the consumer's own frame-cache TTL, `garden-viewer/server.mjs`
 * (`6 * 60 * 60 * 1000`, `loadFrames`), carried over unchanged so that moving the read into the package
 * does not change how often the game is asked. An atlas is republished only when the art version moves and
 * a version is not a per-minute thing; the cost of being wrong is one stale frame for one afternoon.
 */
export const DEFAULT_SOURCE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * The timeout for the one read `fetchJson` cannot make, in milliseconds.
 *
 * The same ten seconds `fetchJson` defaults to (`catalog/http.ts`, `options.timeoutMs ?? 10_000`), restated
 * only because that default is not exported and a second request path should not quietly have none.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

interface CacheEntry {
  readonly at: number;
  readonly value: unknown;
}

/**
 * The cache, one per `fetch`.
 *
 * Keyed by the `fetch` it was filled through rather than being one module-wide map, for two reasons that
 * are the same reason: a caller who supplies a `fetch` (a page's wrapper, a runtime's proxy dispatcher)
 * must not read answers another caller fetched through a different one, and a test must not inherit what
 * an earlier test left behind -- without this, a test could not state the TTL as a fact.
 */
const caches = new WeakMap<typeof fetch, Map<string, CacheEntry>>();

function cacheFor(doFetch: typeof fetch): Map<string, CacheEntry> {
  let cache = caches.get(doFetch);
  if (cache === undefined) {
    cache = new Map();
    caches.set(doFetch, cache);
  }
  return cache;
}

/** The `fetch` a call will actually make, so the cache and the request cannot disagree about which one. */
function fetchFor(options: ArtSourceOptions): typeof fetch {
  return options.fetch ?? globalThis.fetch;
}

/** The clock a call measures its TTL against. */
function clockFor(options: ArtSourceOptions): () => number {
  return options.now ?? Date.now;
}

async function cached<T>(key: string, options: ArtSourceOptions, load: () => Promise<T>): Promise<T> {
  const cache = cacheFor(fetchFor(options));
  const now = clockFor(options);
  const entry = cache.get(key);
  if (entry !== undefined && now() - entry.at < (options.ttlMs ?? DEFAULT_SOURCE_TTL_MS)) {
    return entry.value as T;
  }
  const value = await load();
  cache.set(key, { at: now(), value });
  return value;
}

function jsonOptions(options: ArtSourceOptions): FetchJsonOptions {
  return { fetch: options.fetch, timeoutMs: options.timeoutMs };
}

/**
 * A JSON document, through `fetchJson` and the cache.
 *
 * The URL is the cache key: one answer per URL per `fetch`, until the TTL passes.
 */
export function json<T>(url: string, options: ArtSourceOptions): Promise<T> {
  return cached(url, options, () => fetchJson<T>(url, jsonOptions(options)));
}

/**
 * A binary document -- the atlas image -- as bytes.
 *
 * Not cached. A pack's `.ktx2` is 4.9 MB (measured: `sprites-2x-0`, 4,856,876 bytes) and a caller who wants
 * it twice is usually about to decode it, not to hold it; keeping every pack's pixels in a module map for
 * six hours is the caller's decision to make, not this function's.
 */
export async function bytes(url: string, options: ArtSourceOptions): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFor(options)(url, {
      headers: imageHeaders(),
      signal: controller.signal,
      // The same policy `fetchJson` defaults to: a redirect from a pinned origin is a rejection, not a hop.
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new HttpError(`HTTP ${response.status} for ${url}`, { status: response.status, url });
    }
    return await readCappedBytes(response, url);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const isAbort = error instanceof Error && error.name === 'AbortError';
    throw new HttpError(
      isAbort ? `Request to ${url} timed out after ${timeoutMs}ms.` : `Request to ${url} failed.`,
      { url, cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `DEFAULT_HEADERS`' User-Agent, and not its `Accept: application/json` -- which would be a lie about a
 * `.ktx2`, and which the captured request does not send. A browser sends its own User-Agent over this one,
 * exactly as it does over `fetchJson`'s.
 */
function imageHeaders(): Record<string, string> {
  const userAgent = DEFAULT_HEADERS['User-Agent'];
  return userAgent === undefined ? {} : { 'User-Agent': userAgent };
}

/**
 * Read a response body as bytes, refusing to assemble more than `DEFAULT_MAX_RESPONSE_BYTES`.
 *
 * The shape `readCapped` in `catalog/http.ts` has, for the reason it has it: real bytes are counted as they
 * arrive and the stream is cancelled the moment the cap is passed, so the cap bounds what is *read* rather
 * than what is accepted. A server that declares an over-cap `content-length` is refused before a byte is
 * read.
 */
async function readCappedBytes(response: Response, url: string): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > DEFAULT_MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new HttpError(
        `Response from ${url} declared ${size} bytes, over the ${DEFAULT_MAX_RESPONSE_BYTES} cap.`,
        { status: response.status, url },
      );
    }
  }

  const body = response.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > DEFAULT_MAX_RESPONSE_BYTES) {
        throw new HttpError(
          `Response from ${url} exceeded the ${DEFAULT_MAX_RESPONSE_BYTES}-byte cap (aborted at ${total}).`,
          { status: response.status, url },
        );
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}
