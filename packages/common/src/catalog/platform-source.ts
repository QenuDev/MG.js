/**
 * Live catalogue data straight from the game's own platform API.
 *
 * This is the authoritative source for exactly three things and nothing else. Verified live:
 *
 *   GET https://magicgarden.gg/platform/v1/version  → {"version":"1157"}
 *   GET https://magicgarden.gg/platform/v1/shops    → {"shops":{"seed":{"open":true,
 *                                                     "nextRestockAt":"...","items":[...]}}}
 *   GET https://magicgarden.gg/platform/v1/weather  → null   (when no weather is active)
 *
 * No authentication is involved at any point: the existing server reaches all three with only a
 * User-Agent and an Accept header, and a live probe confirms it.
 *
 * `version` is the important one beyond catalogues: it is what cures the documented `4710` reconnect
 * loop, because "connecting with a stale one gets you closed with code 4710", and the fix is to re-fetch
 * the current version before reconnecting.
 */

import type { CatalogKind, ShopsSnapshot } from './defs.js';
import type { FetchJsonOptions } from './http.js';
import { fetchJson } from './http.js';
import type { CatalogSource } from './source.js';
import type { WeatherForecast, WeatherPayload } from './weather.js';
import { normaliseLegacyWeather, normaliseWeatherBlock } from './weather.js';

/** The three platform endpoints, exactly as the deployed client uses them. */
export const PLATFORM_PATHS = {
  version: '/platform/v1/version',
  shops: '/platform/v1/shops',
  weather: '/platform/v1/weather',
} as const;

export interface PlatformApiSourceOptions {
  /** Origin, without a trailing slash. Default `https://magicgarden.gg`. */
  baseUrl?: string;
  /** Passed through to every request. */
  fetchOptions?: FetchJsonOptions;
}

/** The live platform API as a catalogue source. */
export class PlatformApiSource implements CatalogSource {
  readonly id = 'platform-api';
  readonly capabilities: ReadonlySet<CatalogKind> = new Set<CatalogKind>(['version', 'shops', 'weather']);

  private readonly baseUrl: string;
  private readonly fetchOptions: FetchJsonOptions;

  /**
   * The most recent shops payload, kept briefly so a single catalogue refresh does not fetch
   * `/platform/v1/shops` twice.
   *
   * `shops` and `weather` are separate catalogue kinds, and both need this one response: `shops` for the
   * shops, `weather` for the forecast block the announcement added to it. Without this, every refresh
   * issued two byte-identical requests.
   *
   * The window is tiny ({@link SHOPS_DEDUPE_MS}), and it is a *dedupe* rather than a cache: it
   * exists to cover the span of one `loadAll` pass, not to serve stale data. Snapshot consistency is a free
   * side benefit, because the shops and the forecast then describe the same instant rather than two.
   */
  private shopsRead: { at: number; value: ShopsSnapshot } | null = null;

  private static readonly SHOPS_DEDUPE_MS = 1_000;

  constructor(options: PlatformApiSourceOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://magicgarden.gg').replace(/\/+$/, '');
    this.fetchOptions = options.fetchOptions ?? {};
  }

  async load(kind: CatalogKind): Promise<unknown> {
    switch (kind) {
      case 'version':
        return this.fetchVersion();
      case 'shops':
        // Through the dedupe, not `fetchShops()` directly. Otherwise this kind bypasses the cache and the
        // `weather` kind that follows it fetches the same payload a second time.
        return this.readShops();
      case 'weather':
        return this.fetchWeather();
      default:
        return null;
    }
  }

  /**
   * Read the shops payload, reusing one fetched within {@link SHOPS_DEDUPE_MS}.
   *
   * A failed read is never cached, so a transient error is retried by the next kind rather than poisoned
   * into the rest of the pass.
   */
  private async readShops(): Promise<ShopsSnapshot> {
    const cached = this.shopsRead;
    if (cached !== null && Date.now() - cached.at < PlatformApiSource.SHOPS_DEDUPE_MS) {
      return cached.value;
    }
    const value = await this.fetchShops();
    this.shopsRead = { at: Date.now(), value };
    return value;
  }

  /**
   * The current client build identifier.
   *
   * @throws {HttpError} when the endpoint fails or the payload has no usable `version`; the existing
   *   server treats exactly that condition as fatal for its whole `/data` tree, and the same reasoning
   *   applies here: a version we cannot read is worse than no version.
   */
  async fetchVersion(): Promise<string> {
    const payload = await fetchJson<{ version?: unknown }>(
      `${this.baseUrl}${PLATFORM_PATHS.version}`,
      this.fetchOptions,
    );
    const version = payload?.version;
    if (typeof version !== 'string' || version.length === 0) {
      throw new Error(
        `Platform version endpoint returned no usable version: ${JSON.stringify(payload).slice(0, 200)}`,
      );
    }
    return version;
  }

  /** The current shop snapshots, including per-shop restock times and stock. */
  async fetchShops(): Promise<ShopsSnapshot> {
    const payload = await fetchJson<ShopsSnapshot>(
      `${this.baseUrl}${PLATFORM_PATHS.shops}`,
      this.fetchOptions,
    );
    if (!payload || typeof payload !== 'object' || typeof payload.shops !== 'object') {
      throw new Error('Platform shops endpoint returned an unexpected shape.');
    }
    return payload;
  }
  /**
   * The weather now, plus the forecast.
   *
   * The shops payload is the complete source, since it carries the `weather` block with both `current` and
   * `upcoming`, so it is tried first, which normally costs one request. The legacy
   * `GET /platform/v1/weather` endpoint is the fallback: it predates the block, and it is also what keeps
   * the current weather available when the *shops* request is the thing that failed.
   *
   * @throws {HttpError} only when neither route produced anything. A resolved "no weather is active" is
   *   `{ current: null, upcoming: [] }` and is not an error; that is what normalising is for.
   */
  async fetchWeather(): Promise<WeatherForecast> {
    try {
      // Shares the pass's shops read, so a full refresh touches `/shops` once rather than twice.
      const shops = await this.readShops();
      const block = normaliseWeatherBlock(shops.weather);
      if (block !== null) return block;
    } catch {
      // Fall through to the dedicated endpoint. A shops outage must not cost us the current weather.
    }

    const payload = await fetchJson<WeatherPayload>(
      `${this.baseUrl}${PLATFORM_PATHS.weather}`,
      this.fetchOptions,
    );
    return normaliseLegacyWeather(payload);
  }
}
