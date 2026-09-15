/**
 * Catalogue source interface and the merging client.
 *
 * The three sources have different reach, and the client is built around that:
 *
 *   - {@link PlatformApiSource} talks to `magicgarden.gg/platform/v1/*`, needs no auth, is always live, but
 *     only exposes version, shops and weather. It is authoritative for those three.
 *   - {@link RemoteJsonSource} talks to any HTTP base URL exposing the existing server's `/data`
 *     category shape. It can supply every category, at whatever freshness that server keeps.
 *   - {@link StaticCatalogSource} carries a fixed object, for tests and offline use.
 *
 * Sources are consulted in priority order per category, and the provenance of every field is recorded,
 * so a caller can tell whether the plant list they are reading is live, proxied, or canned.
 */

import { summarizeError, toMgError } from '../errors.js';
import type { CatalogKind, DomainCatalog } from './defs.js';
import { CATALOG_KINDS, emptyCatalog } from './defs.js';

/** One provider of catalogue data. */
export interface CatalogSource {
  /** Stable identifier, recorded in {@link DomainCatalog.provenance}. */
  readonly id: string;
  /** The categories this source can actually supply. Consulted before any network call. */
  readonly capabilities: ReadonlySet<CatalogKind>;
  /**
   * Load one category.
   *
   * Returning `null` means "I am capable of this but have nothing right now", so the client falls
   * through to the next source rather than treating it as an error.
   */
  load(kind: CatalogKind): Promise<unknown>;
}

/** The code a recorded source failure carries when the thrown value has no code of its own. */
export const SOURCE_FAILURE_CODE = 'source_failure';

/** Options for {@link CatalogClient}. */
export interface CatalogClientOptions {
  /** Consulted in order; earlier sources win per category. */
  sources: CatalogSource[];
  /** How long a loaded catalogue stays fresh. Default 5 minutes, matching the game's own grid. */
  ttlMs?: number;
  /**
   * Called when a source throws, with the raw value. The client keeps going with the remaining sources.
   *
   * Optional, and no longer the only record: {@link DomainCatalog.errors} carries the redacted summary
   * whether or not this is supplied, so a caller that forgets it does not make the failure invisible.
   */
  onSourceError?: (sourceId: string, kind: CatalogKind, error: unknown) => void;
}

/**
 * Merges several sources into one catalogue, with caching.
 *
 * Failure policy: a source that throws is skipped, not fatal. The existing server's own `/data** route
 * degrades with `Promise.allSettled` for this reason, and a wrapper that refuses to start
 * because the pets list is down would be worse than one that reports pets as missing.
 *
 * But "skipped" is not "swallowed": every failure is recorded in {@link DomainCatalog.errors} before the
 * client moves on, so the reason survives even when no `onSourceError` callback was wired up.
 */
export class CatalogClient {
  private readonly sources: CatalogSource[];
  private readonly ttlMs: number;
  private readonly onSourceError: ((sourceId: string, kind: CatalogKind, error: unknown) => void) | undefined;
  private cached: DomainCatalog | null = null;
  private inflight: Promise<DomainCatalog> | null = null;
  private readonly listeners = new Set<(catalog: DomainCatalog) => void>();

  constructor(options: CatalogClientOptions) {
    this.sources = options.sources;
    this.ttlMs = options.ttlMs ?? 300_000;
    this.onSourceError = options.onSourceError;
  }

  /** The cached catalogue, or `null` if never loaded. */
  get current(): DomainCatalog | null {
    return this.cached;
  }

  /**
   * The ids of the configured sources, in the order they are consulted.
   *
   * Exposed for diagnostics, because "which sources is this client actually using" is the first question a
   * report like "shops are always missing" needs answered, and the answer is not visible from the
   * catalogue alone when a source contributed nothing.
   */
  get sourceIds(): string[] {
    return this.sources.map((source) => source.id);
  }

  /** True when the cache exists and has not aged past the TTL. */
  get isFresh(): boolean {
    if (!this.cached) return false;
    return Date.now() - this.cached.loadedAt < this.ttlMs;
  }

  /**
   * Load the catalogue, reusing the cache when fresh.
   *
   * Concurrent calls share one in-flight load, so a burst of callers does not produce a burst of
   * requests, which matters because the game's own endpoints are rate-limited.
   */
  async load(options: { force?: boolean } = {}): Promise<DomainCatalog> {
    if (!options.force && this.isFresh && this.cached) return this.cached;
    if (this.inflight && !options.force) return this.inflight;

    const run = this.loadAll();
    this.inflight = run;
    try {
      const catalog = await run;
      this.cached = catalog;
      for (const listener of [...this.listeners]) {
        try {
          listener(catalog);
        } catch {
          // A throwing listener must not break a load.
        }
      }
      return catalog;
    } finally {
      if (this.inflight === run) this.inflight = null;
    }
  }

  /** Force a reload. */
  refresh(): Promise<DomainCatalog> {
    return this.load({ force: true });
  }

  /** Subscribe to completed loads. */
  subscribe(listener: (catalog: DomainCatalog) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Resolve an id to its definition, across the entity categories.
   *
   * Ids are not globally unique across categories (a plant and a decor can share a name), so callers
   * should pass the category when they know it.
   */
  find(kind: CatalogKind, id: string): unknown | null {
    const catalog = this.cached;
    if (!catalog) return null;
    const collection = catalog[kind as keyof DomainCatalog];
    if (!Array.isArray(collection)) return null;
    return (collection as { id?: string }[]).find((entry) => entry && entry.id === id) ?? null;
  }

  private async loadAll(): Promise<DomainCatalog> {
    const catalog = emptyCatalog();
    const remaining = new Set<CatalogKind>(CATALOG_KINDS);
    /**
     * A capable source that returned `null`, remembered rather than discarded.
     *
     * This is the fix for a real ambiguity: `null` from `load()` means two different things,
     * "I have nothing, try someone else" and "the value is null". The live weather endpoint
     * returns literal `null` when nothing is active, so without this the catalogue would report weather
     * as *missing* forever, permanently conflating "no weather" with "no weather source".
     *
     * Resolution rule: a later source that supplies a real value wins; if none does, the remembered
     * `null` is the answer, with the offering source recorded as its provenance.
     */
    const nullOffers = new Map<CatalogKind, string>();

    for (const source of this.sources) {
      if (remaining.size === 0 && nullOffers.size === 0) break;

      for (const kind of [...remaining]) {
        if (!source.capabilities.has(kind)) continue;
        try {
          const value = await source.load(kind);
          if (value === null || value === undefined) {
            if (!nullOffers.has(kind)) nullOffers.set(kind, source.id);
            continue;
          }
          assignKind(catalog, kind, value, source.id);
          remaining.delete(kind);
        } catch (error) {
          // Record first, then notify: the catalogue is the channel that cannot be forgotten. A kind that
          // a later source supplies keeps this failure listed: the source *did* fail, and a diagnostic
          // that hides a broken source because another one covered for it is how a degradation goes
          // unnoticed for a whole TTL.
          catalog.errors[kind] = summarizeError(toMgError(error, SOURCE_FAILURE_CODE));
          this.onSourceError?.(source.id, kind, error);
        }
      }
    }

    // Anything still unclaimed whose only offer was an explicit null resolves to that null.
    for (const [kind, sourceId] of nullOffers) {
      if (!remaining.has(kind)) continue;
      assignKind(catalog, kind, null, sourceId);
      remaining.delete(kind);
    }

    catalog.missing = [...remaining];
    catalog.loadedAt = Date.now();
    return catalog;
  }
}

/** Write one category into the catalogue, with its provenance. */
function assignKind(catalog: DomainCatalog, kind: CatalogKind, value: unknown, sourceId: string): void {
  // A resolved null is a value, not an absence: record it verbatim rather than coercing it. Coercing
  // would turn "no weather is active" into the string "null", and "no entities" into an empty array
  // that looks like real (empty) data.
  if (value === null) {
    switch (kind) {
      case 'version':
        catalog.version = null;
        break;
      case 'shops':
        catalog.shops = null;
        break;
      case 'weather':
        catalog.weather = null;
        break;
      case 'enums':
        catalog.enums = null;
        break;
      case 'plants':
      case 'pets':
      case 'eggs':
      case 'decors':
      case 'mutations':
      case 'items':
      case 'abilities':
        catalog[kind] = null;
        break;
    }
    catalog.provenance[kind] = sourceId;
    return;
  }

  switch (kind) {
    case 'version':
      catalog.version = typeof value === 'string' ? value : String(value);
      break;
    case 'shops':
      catalog.shops = value as DomainCatalog['shops'];
      break;
    case 'weather':
      catalog.weather = value as DomainCatalog['weather'];
      break;
    case 'enums':
      catalog.enums = value as DomainCatalog['enums'];
      break;
    case 'plants':
    case 'pets':
    case 'eggs':
    case 'decors':
    case 'mutations':
    case 'items':
    case 'abilities':
      catalog[kind] = Array.isArray(value) ? (value as never) : (normalizeEntityMap(value) as never);
      break;
  }
  catalog.provenance[kind] = sourceId;
}

/**
 * Coerce a record keyed by id into an array of entities carrying that id.
 *
 * The existing extractors produce either shape depending on the category, so normalising here keeps
 * callers from having to care.
 */
export function normalizeEntityMap(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).map(([id, entry]) => {
    if (entry !== null && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      return record.id === undefined ? { id, ...record } : record;
    }
    return { id, value: entry };
  });
}

/** Reserve a source id that can never collide with a real one, for tests. */
export const STATIC_SOURCE_ID = 'static';
