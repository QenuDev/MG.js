/** The state engine: JSON Pointer, RFC 6902 patch application, and the observable store. */

export type { Unsubscribe } from '../unsubscribe.js';
export type { ServerClockState } from './clock.js';
export { asFiniteMs, ServerClock } from './clock.js';
export type {
  ActivityEntry,
  Crop,
  Currency,
  Garden,
  Inventory,
  InventoryItem,
  ItemType,
  Mutation,
  MutationGroup,
  MutationInfo,
  Pet,
  Player,
  PlayerRecord,
  Room,
  StateRecordLike,
  Storage,
  Tile,
  TileType,
} from './entities.js';
export {
  ACTIVITY_ACTION_FIELDS,
  ACTIVITY_PARAMETER_FIELDS,
  ACTIVITY_PET_FIELDS,
  DISCORD_ID_FIELDS,
  MUTATIONS,
  mutationName,
} from './entities.js';
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
export type { WaitOptions, Watchable, WatchTarget } from './reader.js';
export {
  asRecord,
  StateReader,
  StateRecord,
  StateWaitError,
  toCrops,
  toCurrency,
  toInventory,
  toInventoryItem,
  toInventoryItems,
  toStorage,
} from './reader.js';
export type { ObservableStoreOptions, StateChange, StateSubscriber } from './store.js';
export { emptyStateTree, ObservableStore } from './store.js';
