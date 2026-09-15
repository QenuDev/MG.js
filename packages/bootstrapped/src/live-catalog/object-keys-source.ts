/**
 * The live catalogue source: capture the page's own tables and serve them as a `CatalogSource`.
 *
 * Split out of `catalog/bundle.ts` (Phase 5 Task 5.7a). This half owns the page: the hook, the capture
 * window, and the inert handle returned when there is nothing to capture.
 */

import type { CatalogKind, CatalogSource } from '@mg.js/common';
import { CATALOG_KINDS, unrefTimer } from '@mg.js/common';

import { classifySlot, installHook, restoreSlot } from '../coexistence/brand.js';
import type { PageRealm } from '../page/realm.js';
import { getPage } from '../page/realm.js';

import { asEntryList, isPlainObject, scoreTableForKind } from './scoring.js';

/** The stable id recorded in `DomainCatalog.provenance`. */
export const BUNDLE_SOURCE_ID = 'game-bundle';

/**
 * How long to keep watching, in ms. 30 s, matching the companion's proven window.
 *
 * Measured from install, not from first data: a slow login can take most of that, and the catalogues are
 * read during the game's start-up, which happens once.
 */
export const DEFAULT_CAPTURE_WINDOW_MS = 30_000;

/** The maximum object depth a scan will descend. Three levels reaches the game's module namespace → table → entry shape. */
const MAX_SCAN_DEPTH = 3;

/**
 * The root key each category lives under in the assembled catalog.
 *
 * `enums` is absent from the candidate scan by design: it has no `id`-bearing entity shape to recognise,
 * so it is reported as unsupported rather than guessed at. `version`, `shops` and `weather` are all
 * authoritative elsewhere (the platform API source), so the bundle source does not claim them either. This
 * source exists for the *static* game definitions, which nothing else can supply.
 */
const KIND_ROOTS: Partial<Record<CatalogKind, string>> = {
  plants: 'plants',
  pets: 'pets',
  eggs: 'eggs',
  decors: 'decors',
  mutations: 'mutations',
  items: 'items',
  abilities: 'abilities',
};

/** The kinds this source can plausibly supply. Everything else is left to a source that can. */
export const BUNDLE_SUPPORTED_KINDS: readonly CatalogKind[] = CATALOG_KINDS.filter(
  (kind) => KIND_ROOTS[kind] !== undefined,
);

/** What a scan found, before it is shaped into a catalog. */
export interface BundleCapture {
  /** Detected tables, keyed by their *root key* as the catalog expects it. */
  readonly tables: Map<string, unknown[]>;
  /** How many `Object.keys` calls were inspected. Written by the capture loop; read by diagnostics. */
  keysCalls: number;
  /** How many objects were visited. Written by the capture loop; read by diagnostics. */
  objectsScanned: number;
  /** When the capture stopped watching, in ms since install. `null` while still watching. */
  detachedAfterMs: number | null;
}

/** A live capture session. */
export interface BundleCaptureHandle {
  /** Build a `CatalogSource` over whatever has been captured so far. */
  source(): CatalogSource;
  /** The raw capture state. */
  readonly capture: BundleCapture;
  /** Detach the hook now. Returns `true` when our wrapper was still installed and was removed. */
  dispose(): boolean;
  /** Whether the hook is still installed. */
  readonly active: boolean;
}

/** Options for {@link captureCatalogBundle}. */
export interface BundleCaptureOptions {
  /** Page realm. Defaults to `realm.getPage()`. Exported for tests. */
  page?: PageRealm | null;
  /** Override the capture window. `0` watches forever (the hook must then be disposed manually). */
  windowMs?: number;
  /** Timer injection for tests. */
  schedule?: (callback: () => void, delayMs: number) => unknown;
  /** Notified on every capture that adds a new table. Diagnostic. */
  onTable?: (rootKey: string, entries: unknown[]) => void;
}

/**
 * Capture the game's catalogue tables by intercepting `Object.keys`.
 *
 * Idempotent per page: the install is done through `brand.ts`'s `installHook`, so a second call while our
 * wrapper is present reports `'reused'` and does not double-wrap. That case matters because a second load of
 * this bundle (userscript plus an importing mod) would otherwise scan every object the game enumerates
 * twice, doubling the very cost this hook is careful about.
 */
export function captureCatalogBundle(options: BundleCaptureOptions = {}): BundleCaptureHandle {
  const page = options.page ?? getPage();
  const capture: BundleCapture = {
    tables: new Map<string, unknown[]>(),
    keysCalls: 0,
    objectsScanned: 0,
    detachedAfterMs: null,
  };

  /**
   * The best score per category so far, so a better candidate replaces a worse one.
   *
   * Necessary rather than a nicety: multiple objects in the game's bundle will look catalogue-ish (a
   * species table, an achievements table, a furniture table), and the *first* one seen is not necessarily
   * the right one. Keeping the highest-scoring candidate means the hook does not have to be right on the
   * first call; it only has to be right eventually.
   */
  const best = new Map<CatalogKind, { score: number; entries: unknown[] }>();

  let watching = true;
  let scanning = false;
  let install: { release(): boolean } | null = null;
  let timer: unknown = null;

  /** The `Object.keys` interceptor. Never throws, always delegates. */
  const scan = (root: unknown, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH) return;
    if (!isPlainObject(root) && !Array.isArray(root)) return;

    const keys = Object.keys(root);
    capture.objectsScanned += 1;

    for (const key of keys) {
      let child: unknown;
      try {
        child = (root as Record<string, unknown>)[key];
      } catch {
        // A getter that throws. Skipping it is the only option.
        continue;
      }

      const entries = asEntryList(child);
      if (entries !== null) {
        considerTable(key, entries);
        continue;
      }
      // A namespace object: descend, because the game's module namespace is nested.
      if (depth < MAX_SCAN_DEPTH && isPlainObject(child)) {
        scan(child, depth + 1);
      }
    }
  };

  /** Score a candidate table against every category and keep the best. */
  const considerTable = (key: string, entries: unknown[]): void => {
    for (const kind of BUNDLE_SUPPORTED_KINDS) {
      const score = scoreTableForKind(entries, kind);
      if (score === null || score === 0) continue;
      const current = best.get(kind);
      if (current !== undefined && current.score >= score) continue;
      best.set(kind, { score, entries });
      const root = KIND_ROOTS[kind];
      if (root !== undefined) {
        capture.tables.set(root, entries);
        options.onTable?.(root, entries);
      }
      // Keep the map key in the log so a mis-detection is diagnosable.
      void key;
    }
  };

  const objectCtor = resolvePageObject(page);
  if (objectCtor === null) {
    // No page: return a source that supplies nothing, rather than throwing. An importable library loaded
    // outside a page must still construct.
    return inertHandle(capture);
  }

  const hook = installHook({
    target: objectCtor as unknown as object,
    key: 'keys',
    label: 'catalog:Object.keys',
    wrap: (previous) =>
      function captureObjectKeys(this: unknown, value: unknown): unknown {
        // The latch: a getter reached during a scan must not re-enter this hook, or a self-referential
        // table becomes an infinite loop inside the game's own call.
        if (watching && !scanning) {
          scanning = true;
          try {
            scan(value, 0);
          } catch {
            // "a scan must never break the game's own call."
          } finally {
            scanning = false;
          }
        }
        capture.keysCalls += 1;
        if (previous !== undefined) {
          return previous.call(this, value);
        }
        return [];
      },
  });
  install = hook;

  const windowMs = options.windowMs ?? DEFAULT_CAPTURE_WINDOW_MS;
  if (windowMs > 0) {
    const schedule =
      options.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
    const startedAt = Date.now();
    timer = schedule(() => {
      capture.detachedAfterMs = Date.now() - startedAt;
      detach();
    }, windowMs);
  }

  /** Stop watching and restore `Object.keys`, identity-guarded. */
  function detach(): boolean {
    watching = false;
    // Structural and total: a browser handle is a number, and `unref` is called with the timer as `this`.
    unrefTimer(timer);
    timer = null;
    return install?.release() ?? false;
  }

  return {
    capture,
    get active(): boolean {
      return watching;
    },
    dispose: detach,
    source(): CatalogSource {
      return createBundleSource(capture);
    },
  };
}

/**
 * Build the `CatalogSource`.
 *
 * `capabilities` is computed from what was *actually* captured, not from what the technique could in
 * principle capture. That is what makes `CatalogClient` skip this source entirely for a category it has
 * nothing for, rather than paying a `load()` round trip to receive `null`.
 */
export function createBundleSource(capture: BundleCapture): CatalogSource {
  const capabilities = new Set<CatalogKind>();
  for (const [kind, root] of Object.entries(KIND_ROOTS) as [CatalogKind, string][]) {
    if (root !== undefined && capture.tables.has(root)) capabilities.add(kind);
  }

  return {
    id: BUNDLE_SOURCE_ID,
    capabilities,
    load(kind: CatalogKind): Promise<unknown> {
      const root = KIND_ROOTS[kind];
      if (root === undefined) return Promise.resolve(null);
      const entries = capture.tables.get(root);
      if (entries === undefined) return Promise.resolve(null);
      // A fresh array per call: `CatalogClient` may keep the value, and handing out our internal array would
      // let a consumer mutate the capture.
      return Promise.resolve([...entries]);
    },
  };
}

/** A source that supplies nothing. Used when there is no page to hook. */
function inertHandle(capture: BundleCapture): BundleCaptureHandle {
  return {
    capture,
    active: false,
    source: () => createBundleSource(capture),
    dispose: () => false,
  };
}

/**
 * The page's `Object` constructor.
 *
 * Read through the realm, per §12's discipline. Falls back to `null` (not the ambient `Object`) when there
 * is no page, because hooking the *sandbox's* `Object` would intercept nothing the game does while looking
 * like a successful install. A silent no-op is worse than a reported absence.
 */
export function resolvePageObject(page: PageRealm | null): ObjectConstructor | null {
  if (page === null) return null;
  const candidate = page['Object'];
  return typeof candidate === 'function' ? (candidate as ObjectConstructor) : null;
}

/**
 * A one-shot read of the tables captured so far, for a caller that wants the data without a `CatalogSource`.
 *
 * Returns only what was recovered. A missing key means "not recovered on this build", which is the answer
 * the requirement to never fabricate demands.
 */
export function snapshotTables(capture: BundleCapture): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [root, entries] of capture.tables) out[root] = [...entries];
  return out;
}

// Re-exported so a caller can assert slot hygiene without reaching into `brand.ts`.
export { classifySlot, restoreSlot };
