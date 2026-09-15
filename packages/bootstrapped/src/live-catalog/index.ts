/**
 * Reading catalogues off the running page, as one folder.
 *
 * `live-catalog/scoring.ts` decides what a table is; `live-catalog/object-keys-source.ts` captures it and
 * serves it. This barrel re-exports the same names that `catalog/bundle.ts` exported before the split
 * (Phase 5 Task 5.7a); `src/index.ts` re-exports it wholesale.
 */

export type { BundleCapture, BundleCaptureHandle, BundleCaptureOptions } from './object-keys-source.js';
export {
  BUNDLE_SOURCE_ID,
  BUNDLE_SUPPORTED_KINDS,
  captureCatalogBundle,
  createBundleSource,
  DEFAULT_CAPTURE_WINDOW_MS,
  resolvePageObject,
  snapshotTables,
} from './object-keys-source.js';
export { asEntryList, scoreTableForKind } from './scoring.js';
