/**
 * Version discovery, with a TTL cache.
 *
 * THIS IS THE FILE THAT CURES THE `4710` LOOP.
 *
 * Protocol recon §1.4:
 *
 *   > "Connecting with a stale one gets you closed with code `4710` ('Version Expired')", so re-fetch the
 *   > current version before reconnecting.
 *
 * and §9 ("Versions / bundles / update handshakes"), verbatim:
 *
 *   > "Re-fetch the current game version before reconnecting, the version changing out from under a long
 *   > retry loop is exactly the case that produces an endless `4710` loop otherwise."
 *
 * The same section is explicit that the doc **never says where or how to fetch the current
 * `gameVersion`**: "the doc never says where or how to fetch the current `gameVersion`". It only says
 * to 're-fetch' it. (GAP.) So this file takes the only source that has actually been verified live,
 * which `@mg.js/common`'s `PlatformApiSource` documents in its own header:
 *
 *   GET https://magicgarden.gg/platform/v1/version  → {"version":"1157"}
 *
 * No authentication is involved, which matters: version discovery must keep working when the JWT has
 * expired, or a `4800`-closed client could never recover.
 *
 * WHY A TTL AND NOT A CACHE-FOREVER
 * ---------------------------------
 * The version is cheap to fetch and changes rarely, but it is *the* input to the reconnect decision.
 * Two requirements pull in opposite directions:
 *   - Fetching on every attempt adds a network round trip to every reconnect, including the fast
 *     cold-start retries, and a flaky platform API would then block reconnects that would otherwise
 *     have succeeded with an unchanged version.
 *   - Caching forever reintroduces the `4710` loop this class exists to prevent.
 *
 * A TTL splits them: within the window, `resolve()` is free; on `4710` the client calls
 * {@link VersionResolver.refresh}, which bypasses the cache unconditionally. There is no "the version
 * changed but we did not notice" path, because the one signal that the version moved (`4710`) forces a
 * refresh by construction.
 *
 * WHY A NAMED ROOM'S OWN PAGE, AND NOT THE PLATFORM ENDPOINT
 * ---------------------------------------------------------
 * `/platform/v1/version` states the build of the **newest** room, and the game updates its rooms one at a
 * time. Measured on 2026-09-15 while the game was rolling 1176 → 1177, with one fixed cookie that is not a
 * session (so the close is the *first* check the socket makes, before the cookie matters):
 *
 *     room `8T7R`    + version/1176 → 4710 VersionExpired     + version/1177 → 4840 SessionExpired
 *     room `GOOBERS` + version/1176 → 4840 SessionExpired     + version/1177 → 4710 VersionExpired
 *
 * — and the platform endpoint said `1177` throughout. So for a caller that names a room, the platform's
 * answer is the one build that room is guaranteed to refuse, and the refusal cannot be cured by
 * re-resolving: the refresh returns `1177` again. That is the endless `4710` this file exists to prevent,
 * reached with every number correct except the room's.
 *
 * A room's own page states the build it is served at, because every asset it links is under
 * `/version/<n>/` — `GET https://magicgarden.gg/r/GOOBERS` → `<script src="/version/1176/assets/…">` — which
 * is what {@link RoomVersionSource} reads. A room the game does not serve is answered at the newest build,
 * which is what the platform endpoint states, so an invented slug is served correctly by the fallback.
 */

import type { CatalogKind } from '@mg.js/common';
import { PlatformApiSource } from '@mg.js/common';

/**
 * The narrow slice of `CatalogSource` a version resolver needs.
 *
 * Structural rather than importing `CatalogSource` itself, so a caller can pass a one-line fake in
 * tests, and so this package does not couple to the whole catalogue interface for one endpoint.
 */
export interface VersionSource {
  /** Stable identifier, used in log records. */
  readonly id: string;
  /** Load the `version` category. Resolves `null` when the source has nothing right now. */
  load(kind: CatalogKind): Promise<unknown>;
}

/** Options for {@link RoomVersionSource}. */
export interface RoomVersionSourceOptions {
  /** The room slug whose build is wanted, spelled as the connect URL spells it. */
  room: string;
  /** Origin, without a trailing slash. Default `https://magicgarden.gg`. */
  baseUrl?: string | undefined;
  /** The fetch a room page is read with. Defaults to the global one; injected by tests. */
  fetch?: typeof fetch | undefined;
  /**
   * What to ask when the room's own page cannot be read or states nothing.
   *
   * Defaults to a live {@link PlatformApiSource}, and it is not a nicety: {@link VersionResolver.refresh} is
   * strict, so a source that yields nothing after a `4710` stops the client rather than retrying it, and an
   * unreachable page would then be an unrecoverable connect instead of a merely stale build.
   */
  fallback?: VersionSource | undefined;
}

/**
 * The build a room's page is served at, from the first `/version/<n>/` it links, or `null`.
 *
 * Pure, and exported, so the shape it depends on can be pinned by a test without a network call. The page is
 * the game's own build output: the first versioned URL in it is the first `<script src>` in its `<head>`, so
 * the first match is the build, not a later asset of some other one.
 */
export function roomPageVersion(html: string): string | null {
  const found = /\/version\/([0-9]+)\//.exec(html);
  return found?.[1] ?? null;
}

/**
 * The build a named room is being served at, read from that room's own page.
 *
 * The file header carries the measurement that makes this the right source for a named room. The page is
 * fetched once per {@link VersionResolver} cache window rather than per attempt, because the resolver, not
 * this class, owns the TTL.
 */
export class RoomVersionSource implements VersionSource {
  readonly id: string;

  private readonly room: string;
  private readonly baseUrl: string;
  private readonly read: typeof fetch | undefined;
  private readonly fallback: VersionSource;

  constructor(options: RoomVersionSourceOptions) {
    this.room = options.room;
    this.baseUrl = (options.baseUrl ?? 'https://magicgarden.gg').replace(/\/+$/, '');
    this.read = options.fetch;
    this.fallback =
      options.fallback ??
      (new PlatformApiSource({
        ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      }) as unknown as VersionSource);
    this.id = `room-page:${options.room}`;
  }

  async load(kind: CatalogKind): Promise<unknown> {
    if (kind !== 'version') return null;
    return this.fetchVersion();
  }

  /** The build this room is served at, or the fallback's answer when its own page says nothing usable. */
  async fetchVersion(): Promise<string> {
    const stated = await this.readRoomPage();
    if (stated !== null) return stated;

    const fallbackVersion = extractVersion(await this.fallback.load('version'));
    if (fallbackVersion === null) {
      throw new VersionUnavailableError(
        `Could not read the version of room ${this.room}: its page stated none and ` +
          `${this.fallback.id} had none either.`,
      );
    }
    return fallbackVersion;
  }

  /** The room's stated build, or `null` when the page could not be read or named no version. */
  private async readRoomPage(): Promise<string | null> {
    try {
      const response = await (this.read ?? fetch)(`${this.baseUrl}/r/${encodeURIComponent(this.room)}`, {
        headers: { accept: 'text/html' },
      });
      if (!response.ok) return null;
      return roomPageVersion(await response.text());
    } catch {
      // A page that cannot be read is the fallback's business, not an error of its own.
      return null;
    }
  }
}

/** A resolved version plus where and when it came from. */
export interface ResolvedVersion {
  /** The client build identifier, e.g. `"1157"`. Opaque. */
  version: string;
  /** `true` when this value came from the network on this call, `false` when it was cached. */
  fresh: boolean;
  /** The source id that supplied it. */
  source: string;
  /** Epoch ms when the value was fetched from the source. */
  fetchedAt: number;
}

/** Options for {@link VersionResolver}. */
export interface VersionResolverOptions {
  /**
   * Where to read the version from. Defaults to {@link RoomVersionSource} when {@link room} is given, and to
   * a live {@link PlatformApiSource} (`https://magicgarden.gg/platform/v1/version`) when it is not.
   */
  source?: VersionSource | undefined;
  /**
   * The room the connection is for, so the version resolved is the build *that room* is served at.
   *
   * Rooms are updated one at a time, so the platform's version is the newest room's and a named older room
   * refuses it: see the file header for the measurement. Ignored when {@link source} or {@link fetcher} is
   * supplied, since a caller who decided where the version comes from has decided.
   */
  room?: string | undefined;
  /** The fetch {@link RoomVersionSource} reads a room page with. Defaults to the global one. */
  roomFetch?: typeof fetch | undefined;
  /** Origin for the room page and the platform endpoint alike, without a trailing slash. */
  baseUrl?: string | undefined;
  /**
   * How long a cached version stays usable, in ms. Default 5 minutes.
   *
   * Matches `@mg.js/common`'s catalogue TTL, which the common package documents as "matching the
   * game's own grid"; the same cadence is a defensible default here.
   */
  ttlMs?: number | undefined;
  /** A version to seed the cache with, skipping the very first network call. */
  initialVersion?: string | undefined;
  /**
   * A direct fetcher, taking priority over {@link source}.
   *
   * This is the seam tests use (see `tests/integration/integration.test.ts`, which counts calls to prove a `4710`
   * close really does re-resolve). It is a plain function rather than a source object because the only
   * thing a version fetch returns is a string.
   */
  fetcher?: (() => Promise<string | undefined>) | undefined;
  /** Clock, injectable so TTL behaviour is testable without sleeping. */
  now?: (() => number) | undefined;
}

/** Thrown when the version cannot be determined. */
export class VersionUnavailableError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = 'VersionUnavailableError';
  }
}

/**
 * The `platform/v1/version` response body, as `PlatformApiSource` describes it:
 * `{"version":"1157"}`.
 */
interface VersionPayload {
  version?: unknown;
}

/**
 * Pull a version string out of whatever shape a source returned.
 *
 * Tolerant about the envelope (`{version}` at the top level, or a bare string) and strict about the
 * value: a non-string or empty version would be written into the connect URL as
 * `/version/undefined/`, which the server answers with `4710`, the very loop this class prevents. It
 * is better to fail loudly here.
 */
export function extractVersion(payload: unknown): string | null {
  if (typeof payload === 'string' && payload.length > 0) return payload;
  if (payload !== null && typeof payload === 'object') {
    const candidate = (payload as VersionPayload).version;
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
  }
  return null;
}

const VERSION_CATEGORY: CatalogKind = 'version';

/** Resolves the current game build, with caching and an explicit bypass. */
export class VersionResolver {
  private readonly source: VersionSource | undefined;
  private readonly fetcher: (() => Promise<string | undefined>) | undefined;
  private readonly ttlMs: number;
  private readonly now: () => number;

  private cached: ResolvedVersion | null = null;
  /** In-flight fetch, so concurrent callers share one request instead of stampeding the endpoint. */
  private inFlight: Promise<ResolvedVersion> | null = null;
  /** The strictness {@link inFlight} was started with; a request may only be shared with its own mode. */
  private inFlightAllowStale = true;

  constructor(options: VersionResolverOptions = {}) {
    this.source = options.source;
    this.fetcher = options.fetcher;
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;

    if (this.source === undefined && this.fetcher === undefined) {
      // The only network default in this package. `headless.ts` never reaches it unless the caller
      // supplied neither a resolver nor a version, because an offline/test host must not be surprised
      // by an outbound request.
      this.source =
        options.room !== undefined && options.room.length > 0
          ? new RoomVersionSource({
              room: options.room,
              ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
              ...(options.roomFetch !== undefined ? { fetch: options.roomFetch } : {}),
            })
          : (new PlatformApiSource() as unknown as VersionSource);
    }

    if (options.initialVersion !== undefined && options.initialVersion.length > 0) {
      this.cached = {
        version: options.initialVersion,
        fresh: false,
        source: 'initial',
        fetchedAt: this.now(),
      };
    }
  }

  /** The cached version, without any freshness guarantee. `null` before the first resolve. */
  get current(): string | null {
    return this.cached?.version ?? null;
  }

  /** True when {@link resolve} would return the cached value without hitting the source. */
  isFresh(): boolean {
    if (this.cached === null) return false;
    return this.now() - this.cached.fetchedAt < this.ttlMs;
  }

  /**
   * Resolve the version, using the cache when it is fresh.
   *
   * @throws {VersionUnavailableError} when the source returns nothing usable and no cached value
   *   exists. When a stale cached value exists it is returned instead of throwing: a stale version gets
   *   us a `4710`, which triggers {@link refresh}, whereas no version at all cannot even build a URL.
   */
  async resolve(): Promise<string> {
    const resolved = await this.resolveDetailed();
    return resolved.version;
  }

  /**
   * As {@link resolve}, but reporting provenance and freshness.
   *
   * The stale fallback is on: this is the connect path, and a version that earns a `4710` is still a URL
   * that can be built and a close that can be classified.
   */
  async resolveDetailed(): Promise<ResolvedVersion> {
    if (this.cached !== null && this.isFresh()) return { ...this.cached, fresh: false };
    return this.fetch({ allowStale: true });
  }

  /**
   * Re-resolve the version unconditionally, bypassing the cache.
   *
   * This is the `4710` remedy and must never be short-circuited by a TTL: the server has just told us
   * in the clearest available terms that the cached value is wrong.
   *
   * **It is also strict about the fallback.** Handing back the cached value here would re-arm the exact
   * loop this class exists to cure, because the retry would carry the build the server has just rejected,
   * so a source that yields nothing usable throws {@link VersionUnavailableError} instead. That is a
   * behaviour change for callers of this method: a caller that relied on the stale value coming back
   * must either resolve a real version first (`resolve()` keeps the fallback) or treat the rejection as
   * "the version could not be re-resolved" and stop, as `HeadlessClient` does.
   */
  async refresh(): Promise<ResolvedVersion> {
    return this.fetch({ allowStale: false });
  }

  /** Drop the cache, so the next {@link resolve} refetches. */
  invalidate(): void {
    this.cached = null;
  }

  /**
   * Fetch, sharing one in-flight request between concurrent callers of the *same* strictness.
   *
   * They are not interchangeable: a lenient caller may accept the stale value that a strict caller must
   * reject, so a shared request would let one mode answer for the other. Mixed-mode concurrency is rare
   * (only `refresh()` is strict) and correctness matters more than the saved request.
   */
  private async fetch(options: { allowStale: boolean }): Promise<ResolvedVersion> {
    if (this.inFlight !== null && this.inFlightAllowStale === options.allowStale) return this.inFlight;

    const promise = this.load(options);
    this.inFlight = promise;
    this.inFlightAllowStale = options.allowStale;
    try {
      return await promise;
    } finally {
      if (this.inFlight === promise) this.inFlight = null;
    }
  }

  private async load(options: { allowStale: boolean }): Promise<ResolvedVersion> {
    const sourceId = this.fetcher !== undefined ? 'fetcher' : (this.source?.id ?? 'unknown');
    let version: string | null = null;
    let failure: unknown;

    try {
      if (this.fetcher !== undefined) {
        const raw = await this.fetcher();
        version = raw !== undefined ? extractVersion(raw) : null;
      } else if (this.source !== undefined) {
        version = extractVersion(await this.source.load(VERSION_CATEGORY));
      }
    } catch (error) {
      failure = error;
    }

    if (version === null) {
      if (options.allowStale && this.cached !== null) {
        // A stale version is strictly better than no version: it produces a `4710` close that the
        // caller turns back into a refresh, rather than an unbuildable URL. Only {@link resolve} and
        // {@link resolveDetailed} may take this branch; for {@link refresh} the cached value is the
        // thing the server has already rejected.
        return { ...this.cached, fresh: false };
      }
      throw new VersionUnavailableError(
        `Could not resolve the game version from ${sourceId}. The connect URL needs a concrete ` +
          'build id (/version/<gameVersion>/…), and connecting with a stale one only earns a 4710 close.',
        failure !== undefined ? { cause: failure } : {},
      );
    }

    const resolved: ResolvedVersion = {
      version,
      fresh: true,
      source: sourceId,
      fetchedAt: this.now(),
    };
    this.cached = resolved;
    return resolved;
  }
}
