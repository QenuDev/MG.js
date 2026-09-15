/**
 * The realm bridge, as one folder.
 *
 * `page/realm.ts` resolves the page, `page/override.ts` substitutes it, and `page/namespace.ts` owns the
 * single `__mgjs` global everything else is published inside. This barrel re-exports the same names
 * `src/realm.ts` exported before the split (Phase 5 Task 5.6b); `src/index.ts` re-exports it wholesale.
 */

export type { RealmNamespace } from './namespace.js';
export {
  BUNDLE_VERSION,
  claimInstall,
  defineGlobal,
  deleteNamespace,
  emitNamespaceEvent,
  getNamespace,
  NAMESPACE_KEY,
  onNamespaceEvent,
  onTeardown,
  peekNamespace,
  readGlobal,
  releaseInstall,
  undefineGlobal,
} from './namespace.js';
export type { RealmOverrideOptions } from './override.js';
export { installRealmOverride } from './override.js';
export type { PageRealm } from './realm.js';
export { getPage, hasPage, requirePage } from './realm.js';
