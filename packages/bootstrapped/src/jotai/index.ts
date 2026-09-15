/**
 * The jotai bridge: writing the game's own React state the way its UI buttons do.
 *
 * `src/index.ts` re-exports this barrel wholesale (Phase 5 Task 5.6a).
 */

export type {
  AtomCacheLike,
  AtomVisitor,
  JotaiAtom,
  JotaiBridgeHandle,
  JotaiBridgeOptions,
  JotaiLookup,
  JotaiSet,
  WriteFailureReason,
  WriteResult,
} from './bridge.js';
export {
  ATOM_CACHE_KEY,
  createLookup,
  getCapturedSet,
  hasCapturedSet,
  install as installJotaiBridge,
  JotaiBridge,
  labelMatches,
  resetJotaiCapture,
  restoreWrappedWrites,
  writeAtom,
} from './bridge.js';
