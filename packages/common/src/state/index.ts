/** The state engine: JSON Pointer, RFC 6902 patch application, and the observable store. */

export type { Unsubscribe } from '../unsubscribe.js';
export type { ApplyPatchOptions, ApplyPatchResult, PatchOutcome } from './patch.js';
export { applyPatch, deepClone, deepEqual, JsonPatch } from './patch.js';
export * from './paths.js';
export type { PointerTokens } from './pointer.js';
export {
  addLeadingChild,
  dropLeadingChild,
  escapeToken,
  formatPointer,
  getPointer,
  joinPointer,
  parsePointer,
  pointerContains,
  resolvePointer,
} from './pointer.js';
export type { ObservableStoreOptions, StateChange, StateSubscriber } from './store.js';
export { emptyStateTree, ObservableStore } from './store.js';
