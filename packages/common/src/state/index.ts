/** The state engine: JSON Pointer, RFC 6902 patch application, and the observable store. */

export type { Unsubscribe } from '../unsubscribe.js';
export type { ServerClockState } from './clock.js';
export { asFiniteMs, ServerClock } from './clock.js';
export type {
  ActivityEntry,
  CarvingVerdict,
  Crop,
  Currency,
  EdgeDecor,
  EdgeObject,
  EdgeOrientation,
  EdgePart,
  EdgePosition,
  EdgeSide,
  Garden,
  Inventory,
  Mutation,
  MutationGroup,
  MutationInfo,
  Pet,
  PetTeam,
  PetTeamMember,
  Player,
  PlayerRecord,
  Room,
  StateRecordLike,
  Storage,
  TeamEmblem,
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
export type {
  DecorItem,
  EggItem,
  InventoryItem,
  InventoryItemBase,
  ItemFields,
  ItemKind,
  ItemOfKind,
  ItemOwnFields,
  KindReader,
  OtherItem,
  PetFields,
  PetItem,
  PlantItem,
  ProduceItem,
  SeedItem,
  ToolItem,
} from './items/index.js';
export { ITEM_KINDS, ITEM_READERS } from './items/index.js';
export type { ApplyPatchOptions, ApplyPatchResult, PatchOutcome } from './patch.js';
export { applyPatch, deepClone, deepEqual, JsonPatch } from './patch.js';
export * from './paths.js';
export type { PetTeamMemberView } from './pet-teams.js';
export { teamIsOut, teamMembersOf } from './pet-teams.js';
export { petById, petsOf } from './pets.js';
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
  toPetTeam,
  toStorage,
} from './reader.js';
export type { ObservableStoreOptions, StateChange, StateSubscriber } from './store.js';
export { emptyStateTree, ObservableStore } from './store.js';
