/**
 * A catalogue source backed by any HTTP base URL exposing the existing server's `/data` category
 * shape.
 *
 * The reference deployment (`Magic-garden-API` in this workspace) exposes, per its own recon:
 *   /data/plants, /data/pets, /data/eggs, /data/decors, /data/mutations, /data/items,
 *   /data/abilities, /data/enums, /data/weathers  (and /data/version)
 *
 * It also caches aggressively and offers 304s on the per-category JSON routes, so a 304 is treated as "no
 * change" rather than as an error and the cached payload is returned.
 *
 * It does **not** send `If-None-Match`. The reason is that sending it needs the ETag the server last
 * issued, and `fetchJson` exposes no response headers by design. Phase 2.3 removed the `'manual'` redirect
 * option for the same reason: `Location` is a header, so a helper that hands headers to a caller hands it
 * that too. A public setter existed for a caller that already knew an ETag; nothing in the repository ever
 * called it, so the map it wrote to was always empty and the
 * conditional path was unreachable. The setter is gone (Phase 6). The 304 branch stays, because a deployment
 * can answer 304 without being asked and discarding a valid cached payload over it is the failure this code
 * exists to avoid.
 *
 * Nothing here hardcodes a host. The same code works against a local instance, a
 * self-hosted mirror, or a different implementation that matches the shape.
 */

import type { CatalogKind } from './defs.js';
import type { FetchJsonOptions } from './http.js';
import { fetchJson } from './http.js';
import type { CatalogSource } from './source.js';

/** Default path per category, matching the reference deployment. */
export const DEFAULT_REMOTE_PATHS: Record<CatalogKind, string> = {
  version: '/data/version',
  plants: '/data/plants',
  pets: '/data/pets',
  eggs: '/data/eggs',
  decors: '/data/decors',
  mutations: '/data/mutations',
  items: '/data/items',
  abilities: '/data/abilities',
  enums: '/data/enums',
  // The reference deployment names this route in the plural.
  weather: '/data/weathers',
  shops: '/live/shops',
};

export interface RemoteJsonSourceOptions {
  /** Origin, without a trailing slash. Required, because there is no sensible default. */
  baseUrl: string;
  /** Override any category's path. */
  paths?: Partial<Record<CatalogKind, string>>;
  /** Limits which categories this source advertises. Defaults to all. */
  kinds?: CatalogKind[];
  fetchOptions?: FetchJsonOptions;
  /**
   * Unwrap a category response. The reference deployment wraps most categories
   * (e.g. `{ plants: [...] }`), so the default unwraps a single-key object when that key matches the
   * category name, and otherwise returns the payload untouched.
   */
  unwrap?: (kind: CatalogKind, payload: unknown) => unknown;
}

/** A generic JSON-over-HTTP catalogue source. */
export class RemoteJsonSource implements CatalogSource {
  readonly id: string;
  readonly capabilities: ReadonlySet<CatalogKind>;

  private readonly baseUrl: string;
  private readonly paths: Record<CatalogKind, string>;
  /** The URL each category actually fetches: `paths` resolved against the base once, at construction. */
  private readonly targets: Record<CatalogKind, string>;
  private readonly fetchOptions: FetchJsonOptions;
  private readonly unwrap: (kind: CatalogKind, payload: unknown) => unknown;
  /** Last successful payload per category, served back on a 304. */
  private readonly lastGood = new Map<CatalogKind, unknown>();

  constructor(options: RemoteJsonSourceOptions) {
    // The origin is the only thing pinning these requests, so pin it by construction: resolve each path
    // against the base once, here, and keep *that* URL as the only thing the loader ever fetches.
    // Validating `new URL(path, base)` while fetching `${baseUrl}${path}` validates one URL and requests
    // another. The example `'https://a.test' + '@evil.test/x'` fetches `https://a.test@evil.test/x`, host
    // `evil.test`. Caller inputs are rejected, never stripped (audit 23).
    if (options.baseUrl.length === 0) {
      throw new Error('RemoteJsonSource: baseUrl must be an absolute URL, got an empty string.');
    }
    let base: URL;
    try {
      base = new URL(options.baseUrl);
    } catch (error) {
      throw new Error(
        `RemoteJsonSource: baseUrl must be an absolute URL, got ${JSON.stringify(options.baseUrl)}.`,
        { cause: error },
      );
    }
    if (base.protocol !== 'https:') {
      throw new Error(`RemoteJsonSource: baseUrl must be an https origin, got ${base.protocol}`);
    }

    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    // Derive the id from the normalised value: `https://a.test/` and `https://a.test` are one origin, and
    // two ids for it would let the same catalogue be loaded and cached twice.
    this.id = `remote-json:${this.baseUrl}`;
    this.paths = { ...DEFAULT_REMOTE_PATHS, ...options.paths };
    // Caller inputs are rejected, never stripped: a leading `//` is left alone rather than silently
    // reinterpreted, and it is an error.
    const targets: Record<string, string> = {};
    for (const [kind, path] of Object.entries(this.paths)) {
      // `new URL('', base)` resolves to the base, so an empty override passes the origin check below and
      // silently turns the request into the base URL. Name the option that is wrong instead.
      if (path.length === 0) {
        throw new Error(
          `RemoteJsonSource: the "paths.${kind}" override must not be an empty string; an empty path ` +
            `would silently fetch the base URL.`,
        );
      }
      const target = new URL(path, base);
      if (target.origin !== base.origin) {
        throw new Error(
          `RemoteJsonSource: the "${kind}" path ${JSON.stringify(path)} leaves the base origin ` +
            `${base.origin}. Paths must be relative.`,
        );
      }
      targets[kind] = target.href;
    }
    // The check above and the request below now read the same value, because the loader fetches these
    // resolved URLs rather than rebuilding one from `baseUrl` and `path`.
    this.targets = targets;
    this.capabilities = new Set<CatalogKind>(options.kinds ?? (Object.keys(this.paths) as CatalogKind[]));
    this.fetchOptions = options.fetchOptions ?? {};
    this.unwrap = options.unwrap ?? defaultUnwrap;
  }

  async load(kind: CatalogKind): Promise<unknown> {
    if (!this.capabilities.has(kind)) return null;
    const target = this.targets[kind];
    if (!target) return null;

    try {
      const payload = await fetchJson<unknown>(target, this.fetchOptions);
      const unwrapped = this.unwrap(kind, payload);
      this.lastGood.set(kind, unwrapped);
      return unwrapped;
    } catch (error) {
      // A 304 means our cached copy is still good. The reference deployment returns these on its
      // per-category JSON routes, so treating it as a failure would discard valid data.
      if (isNotModified(error) && this.lastGood.has(kind)) {
        return this.lastGood.get(kind);
      }
      throw error;
    }
  }
}

/** The reference deployment's `{ plants: [...] }` wrapping, unwrapped. */
function defaultUnwrap(kind: CatalogKind, payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1) {
    const only = keys[0] as string;
    if (only === kind || only === `${kind}s`) return record[only];
  }
  return payload;
}

function isNotModified(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'status' in error &&
    (error as { status?: unknown }).status === 304
  );
}
