/**
 * Persistence, as one folder.
 *
 * `storage/types.ts` is the seam, `storage/backends.ts` picks an implementation, and `storage/typed.ts` is
 * what a caller imports. This barrel re-exports the same names that `src/storage.ts` exported before
 * the split (Phase 5 Task 5.6c); `src/index.ts` re-exports it wholesale.
 */

export { probeStorage, resolveGreasemonkeyApi, selectBackend } from './backends.js';
export type { TypedStorage } from './typed.js';
export { createStorage, DEFAULT_KEY_PREFIX } from './typed.js';
export type {
  GreasemonkeyApi,
  StorageBackend,
  StorageBackendKind,
  StorageOptions,
  WebStorageLike,
} from './types.js';
