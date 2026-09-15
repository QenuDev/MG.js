/**
 * The page-realm override: how tests and non-browser hosts substitute a page.
 *
 * Split out of `realm.ts` (Phase 5 Task 5.6b). The slot is a module-level `let` by design rather than a
 * field on anything: {@link getPage} is called on the game's hot paths and must stay synchronous and
 * allocation-free, so it reads this through {@link installedOverride} rather than allocating.
 */

import type { PageRealm } from './realm.js';

/** Options bag for {@link installRealmOverride}, used only by tests and non-browser hosts. */
export interface RealmOverrideOptions {
  /** An explicit object to treat as the page realm. */
  page: PageRealm | null;
}

/**
 * Test/host override.
 *
 * Kept as a module-level slot because {@link getPage} must stay synchronous and allocation-free. It is
 * called on the game's hot paths (every socket send, every frame). The slot is only ever
 * written by {@link installRealmOverride}, which no `src/` code calls.
 */
let realmOverride: { page: PageRealm | null } | null = null;

/**
 * Substitute the page realm.
 *
 * @returns a function that restores the previous resolution behaviour, so tests never leak state
 *   between cases.
 */
export function installRealmOverride(options: RealmOverrideOptions): () => void {
  const previous = realmOverride;
  realmOverride = { page: options.page };
  return () => {
    realmOverride = previous;
  };
}

/**
 * The installed override, or `null`.
 *
 * Internal: not on `page/index.ts`'s barrel, because it is plumbing between two modules rather than part
 * of the surface `realm.ts` used to publish. `getPage` is its only caller.
 */
export function installedOverride(): { page: PageRealm | null } | null {
  return realmOverride;
}
