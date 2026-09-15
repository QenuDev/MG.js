/**
 * The `__mgjs` page namespace: one global, a refcount, a bus and a teardown list.
 *
 * Split out of `realm.ts` (Phase 5 Task 5.6b); the argument for one namespace rather than ~40 loose globals
 * is in `page/realm.ts`'s header, which is where it belongs because that is the module a reader arrives at.
 */

import { BUNDLE_VERSION } from '../build-info.js';
import type { PageRealm } from './realm.js';
import { getPage, requirePage } from './realm.js';

/**
 * The single page-global key this package owns.
 *
 * Version-free in its name: a version suffix would defeat the point, because copy A and
 * copy B of different versions would then each believe they were alone. Version skew is resolved
 * *inside* the namespace by {@link RealmNamespace.version} and {@link claimInstall}.
 */
export const NAMESPACE_KEY = '__mgjs';

/**
 * Semantic version of this bundle, stamped into the namespace for skew detection.
 *
 * **The definition lives in `../build-info.ts`** (Phase 5 Task 5.7e). Build identity is not a realm
 * concern: the namespace key below is a deliberate *communication* decision, while the version is identity
 * that several modules want, and a module whose subject is "which page global do I claim" should not be the
 * one that has to know the release number. This re-export is a door, not a second home. It exists because
 * this module is where the value is stamped (below) and because it is where callers have always read it.
 */
export { BUNDLE_VERSION };

/**
 * The shape of the page's one global.
 *
 * Everything is optional on read because a *different* build of this package may have created the
 * namespace first. A namespace we did not create is a namespace whose fields we cannot assume.
 */
export interface RealmNamespace {
  /** Marker so a foreign `__mgjs` (some unrelated page script) can be recognised and refused. */
  readonly marker: typeof NAMESPACE_KEY;
  /** Version of the copy that created the namespace. */
  readonly version: string;
  /**
   * Named values published for other mods, keyed by short name.
   *
   * This is the sanctioned replacement for the companion's fleet of page globals: instead of
   * `window.mgApiClient`, a mod reads `getPage().__mgjs.globals.apiClient`.
   */
  readonly globals: Record<string, unknown>;
  /**
   * Whether *any* load of this package has completed {@link BootstrappedClient.install}.
   *
   * The hooks (socket patch, Pixi init wrap, jotai cache wrap) are installed once globally, not once
   * per load. This flag is how the second load knows to reuse them.
   */
  installed: boolean;
  /** How many loads currently want the hooks alive. The hooks are torn down at zero. */
  refCount: number;
  /**
   * Cross-load notification bus.
   *
   * A `Map` of event name to handler set, kept tiny: it exists so an uninstall in one load
   * can tell the others before it rips hooks out from under them.
   */
  readonly hooks: Map<string, Set<(...args: unknown[]) => void>>;
  /**
   * Teardown callbacks registered by the load that actually installed, run once when `refCount`
   * reaches zero.
   */
  readonly teardowns: Array<() => void>;
}

/** Structural check for a namespace this package created (as opposed to an unrelated global). */
function isOurNamespace(value: unknown): value is RealmNamespace {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Partial<RealmNamespace>;
  return record.marker === NAMESPACE_KEY && typeof record.version === 'string';
}

/**
 * Get or create the `__mgjs` namespace on a page.
 *
 * Idempotent across loads: if a valid namespace already exists it is returned untouched, so the
 * second copy inherits the first copy's registry, bus and refcount rather than replacing them.
 *
 * A foreign value under the same key is a hard error rather than an overwrite. Silently clobbering
 * another script's global is precisely the behaviour this namespace design exists to avoid.
 */
export function getNamespace(page: PageRealm = requirePage()): RealmNamespace {
  const existing = page[NAMESPACE_KEY];
  if (isOurNamespace(existing)) return existing;
  if (existing !== undefined) {
    throw new Error(
      `mg.js: the page global "${NAMESPACE_KEY}" already exists and was not created by mg.js. ` +
        'Refusing to overwrite it.',
    );
  }

  const created: RealmNamespace = {
    marker: NAMESPACE_KEY,
    version: BUNDLE_VERSION,
    globals: {},
    installed: false,
    refCount: 0,
    hooks: new Map(),
    teardowns: [],
  };
  page[NAMESPACE_KEY] = created;
  return created;
}

/** The namespace if one exists, without creating it. */
export function peekNamespace(page: PageRealm | null = getPage()): RealmNamespace | null {
  if (page === null) return null;
  const existing = page[NAMESPACE_KEY];
  return isOurNamespace(existing) ? existing : null;
}

/**
 * Publish a named value inside the namespace.
 *
 * This is the *only* sanctioned way to add anything to the page's global object. Note that it takes a
 * short name (`'apiClient'`), never a dotted path and never a leading `window.` The point is that the
 * namespace is one object with named fields, not a flat sprawl.
 *
 * @returns the previous value, so a caller can restore it on uninstall.
 */
export function defineGlobal(name: string, value: unknown, page: PageRealm = requirePage()): unknown {
  const namespace = getNamespace(page);
  const previous = namespace.globals[name];
  namespace.globals[name] = value;
  return previous;
}

/** Read a named value out of the namespace. */
export function readGlobal<T = unknown>(name: string, page: PageRealm | null = getPage()): T | null {
  const namespace = peekNamespace(page);
  if (namespace === null) return null;
  const value = namespace.globals[name];
  return value === undefined ? null : (value as T);
}

/** Remove a named value, only if it is still the one the caller published. */
export function undefineGlobal(name: string, expected: unknown, page: PageRealm | null = getPage()): void {
  const namespace = peekNamespace(page);
  if (namespace === null) return;
  if (namespace.globals[name] !== expected) return;
  delete namespace.globals[name];
}

// --------------------------------------------------------------------------------------
// Cross-load bus
// --------------------------------------------------------------------------------------

/**
 * Subscribe to a namespace event.
 *
 * Events are advisory only: "another load is installing", "another load uninstalled". They carry no
 * protocol data and must never be used to move frames between loads; the game's own socket already
 * does that.
 */
export function onNamespaceEvent(
  event: string,
  handler: (...args: unknown[]) => void,
  page: PageRealm = requirePage(),
): () => void {
  const namespace = getNamespace(page);
  let handlers = namespace.hooks.get(event);
  if (handlers === undefined) {
    handlers = new Set();
    namespace.hooks.set(event, handlers);
  }
  handlers.add(handler);
  return () => {
    const current = namespace.hooks.get(event);
    if (current === undefined) return;
    current.delete(handler);
    if (current.size === 0) namespace.hooks.delete(event);
  };
}

/** Emit a namespace event to every other load. A throwing listener never breaks the emitter. */
export function emitNamespaceEvent(
  event: string,
  args: unknown[] = [],
  page: PageRealm | null = getPage(),
): void {
  const namespace = peekNamespace(page);
  if (namespace === null) return;
  const handlers = namespace.hooks.get(event);
  if (handlers === undefined) return;
  for (const handler of [...handlers]) {
    try {
      handler(...args);
    } catch {
      // A subscriber's failure is its own; the emitter must always complete so that one broken
      // consumer cannot prevent the others from being notified.
    }
  }
}

/**
 * Claim (or share) the global install.
 *
 * @returns `'installed'` when the caller is the first load and now owns the hooks; `'shared'` when a
 *   previous load already installed them and this call only incremented the refcount.
 *
 * The distinction matters for teardown: only the owner may remove hooks, and it must not do so until
 * every sharer has released.
 */
export function claimInstall(page: PageRealm = requirePage()): 'installed' | 'shared' {
  const namespace = getNamespace(page);
  const outcome = namespace.installed ? 'shared' : 'installed';
  namespace.refCount += 1;
  namespace.installed = true;
  emitNamespaceEvent('install', [{ outcome, refCount: namespace.refCount }], page);
  return outcome;
}

/**
 * Release the install.
 *
 * @returns the teardown callbacks to run, or an empty array when other loads still hold a claim. The
 *   caller runs them; this function does not, because the owner's teardown order is its own business.
 */
export function releaseInstall(page: PageRealm = requirePage()): Array<() => void> {
  const namespace = getNamespace(page);
  if (namespace.refCount > 0) namespace.refCount -= 1;
  if (namespace.refCount > 0) {
    emitNamespaceEvent('release', [{ refCount: namespace.refCount }], page);
    return [];
  }
  const teardowns = namespace.teardowns.splice(0);
  namespace.installed = false;
  emitNamespaceEvent('release', [{ refCount: 0 }], page);
  return teardowns;
}

/** Register a teardown to run when the last claim is released. */
export function onTeardown(teardown: () => void, page: PageRealm = requirePage()): void {
  getNamespace(page).teardowns.push(teardown);
}

/**
 * Remove the namespace entirely.
 *
 * Only safe when nothing else is using it, so it is not called from `uninstall()`: a
 * second load may still be live. Exposed for tests and for a future "full reset" menu command.
 */
export function deleteNamespace(page: PageRealm | null = getPage()): boolean {
  if (page === null) return false;
  if (peekNamespace(page) === null) return false;
  delete page[NAMESPACE_KEY];
  return true;
}
