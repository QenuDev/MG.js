/**
 * Parameter types for every action method.
 *
 * ## One intentional deviation from the API reference
 *
 * The reference declares `GameActions` methods with **positional** arguments
 * (`harvestCrop(slot, slotsIndex?, cropItemId?)`, `placePet(itemId, x, y, tileType, localTileIndex)`).
 * Every method here takes a **single params object** instead. Three reasons, all of which matter at
 * 72 methods:
 *
 *   1. 44 of the 72 methods have optional parameters, and several have *two or three* adjacent
 *      optionals. Positional calls with a trailing optional force callers to pass `undefined`
 *      placeholders, which are easy to get wrong and impossible to type-check meaningfully.
 *   2. The documented rule for several parameters is "omit it entirely, do not send null"
 *      (`Wish.itemId`, `DropObject`/`PickupObject`'s total absence of params). The builder drops
 *      `undefined`, so an absent object key is the natural spelling of that rule.
 *   3. Field names inside the object match the **wire fields**, so the code and a packet capture read
 *      the same. The only reshaping is `position`, where the reference passes `x, y` but the wire
 *      nests `{position:{x,y}}`; those methods accept `x`/`y` and nest for you.
 *
 * Where the reference and the field guide disagree, the field guide's wire field names win, and the
 * divergence is commented at the type.
 */

import type { CrystalShard, PetTeamEmblem } from '../protocol/wire.js';
import type { TileType } from '../state/entities.js';

// ---------------------------------------------------------------- session & heartbeat

export interface PingParams {
  /** Echoed back unchanged; conventionally the current timestamp. */
  id?: number;
}

/**
 * `RestartGame` params.
 *
 * NOTE the wire-field divergence: the reference method is `restartGame(gameName?)`, but the wire
 * field for this action is `name`, unlike `VoteForGame`/`SetSelectedGame` which use `gameName`. The
 * method takes `gameName` for ergonomics and emits `name`.
 */
export interface RestartGameParams {
  gameName?: string;
}

export interface GameNameParams {
  gameName?: string;
}

// ------------------------------------------------------------------- social & chat

export interface ChatParams {
  message: string;
}

export interface EmoteParams {
  emoteType: string;
}

export interface WishParams {
  /**
   * Omit entirely for an untargeted wish; do not send `null`.
   * Leaving the key out is correct; passing `undefined` is equivalent.
   */
  itemId?: string;
}

export interface KickPlayerParams {
  targetPlayerId: string;
}

export interface SetPlayerDataParams {
  /** Include only the field(s) you are changing. */
  name?: string;
  cosmetic?: unknown;
}

export interface MarkChatReadParams {
  seq: number;
}

// ----------------------------------------------------------------------- movement

/** Tile-grid coordinates. The wire nests these under `position`. */
export interface MoveParams {
  x: number;
  y: number;
}

// --------------------------------------------------------------------------- shop

/**
 * Shop keys named in the sources; the reference gives the list as
 * `"seed"|"tool"|"egg"|"decor"|"dawn"|...`.
 */
export type ShopKey = 'seed' | 'tool' | 'egg' | 'decor' | 'dawn' | (string & {});

export interface PurchaseShopItemParams {
  shop: ShopKey;
  /**
   * `itemType` plus the id field appropriate to it. The field guide says `itemType` is derived, so it
   * is required here but the id field it pairs with is not statically named.
   */
  item: { itemType: string } & Record<string, unknown>;
}

// ---------------------------------------------------------------- garden & crops

export interface PlantSeedParams {
  slot: number;
  /**
   * The seed species, e.g. `Carrot`.
   *
   * The wire field is `species`, from the game's own sender: ``PlantSeed`,slot:n,species:t.species`. This
   * was previously named `seedItemId` and sent under that name, which the server does not read: the
   * string `seedItemId` appears nowhere in bundle 1171.
   */
  species: string;
}

export interface SlotParams {
  slot: number;
}

export interface HarvestCropParams {
  slot: number;
  /**
   * Which crop on the tile, which is the crop's own `slotId`.
   *
   * The bundle's schema marks it required: ``fd=b({type:o(`HarvestCrop`),slot:_(),slotsIndex:_(),cropItemId:...})``,
   * and the game's sender is ``slotsIndex:a.slotId``. Optional here only because a caller harvesting the
   * tile's only crop should not have to name it.
   */
  slotsIndex?: number;
  /**
   * Client-minted UUID. The field guide says it is required and must be minted before sending rather
   * than awaited; the reference marks it optional. This method mints one for you when omitted, so
   * both readings are satisfied.
   */
  cropItemId?: string;
}

export interface PlantGardenPlantParams {
  slot: number;
  itemId: string;
}

export interface PotPlantParams {
  slot: number;
  /**
   * Client-minted UUID so the pot can be referenced immediately without waiting for the state patch.
   * Minted for you when omitted.
   */
  plantItemId?: string;
}

export interface MutationPotionParams {
  tileObjectIdx: number;
  growSlotIdx: number;
  mutation: string;
}

export interface GrowSlotParams {
  tileObjectIdx: number;
  growSlotIdx: number;
}

/** `intent` discriminates a fresh placement from fusing a shard into an existing crystal. */
export type CrystalIntent = { type: 'place' } | { type: 'merge'; mergeGainSeconds: number };

export interface PlaceCrystalParams {
  /** The inventory item reference. The reference method takes this first, as `shard`. */
  shard: CrystalShard;
  /**
   * Which ground the tile is on. Both grounds are numbered from zero and hold more than their usual
   * contents — a shard can be charged on the boardwalk and decoration can stand in the soil — so the index
   * below addresses nothing without this.
   */
  tileType: TileType;
  localTileIndex: number;
}

export interface FuseCrystalParams extends PlaceCrystalParams {
  mergeGainSeconds: number;
}

export interface PickupCrystalParams {
  crystalType: string;
  tileType: TileType;
  localTileIndex: number;
  /** Client-minted so the crystal keeps its remaining time. Minted for you when omitted. */
  itemId?: string;
}

export interface RemoveGardenObjectParams {
  slot: number;
  slotType: string;
}

export interface PreserveParams {
  itemId: string;
  growSlotIdx: number;
}

export interface DisplayCropParams {
  tileType: TileType;
  localTileIndex: number;
  itemId: string;
}

export interface LocalTileParams {
  tileType: TileType;
  localTileIndex: number;
}

// -------------------------------------------------------------------------- decor

export interface PlaceDecorParams {
  decorId: string;
  tileType: TileType;
  localTileIndex: number;
  /** Omit for the default orientation. */
  rotation?: number;
}

// --------------------------------------------------------------- pets & pet teams

export interface PlacePetParams {
  itemId: string;
  /** The wire nests these under `position`. */
  x: number;
  y: number;
  tileType: TileType;
  localTileIndex: number;
}

export interface PickupPetParams {
  petId: string;
}

export interface FeedPetParams {
  petItemId: string;
  cropItemId: string;
}

export interface PetItemParams {
  petItemId: string;
}

export interface SellPetParams {
  itemId: string;
}

export interface PetAbilityParams {
  petItemId: string;
  x: number;
  y: number;
}

/** `RequestPetGreet` takes only a position, and is flat. */
export interface RequestPetGreetParams {
  x: number;
  y: number;
}

export interface EquipPetCosmeticParams {
  petItemId: string;
  slotCategory: string;
  cosmeticId: string;
}

export interface NamePetParams {
  petItemId: string;
  name: string;
}

export interface SwapPetParams {
  petSlotId: string;
  petInventoryId: string;
}

export interface SwapPetFromStorageParams {
  petSlotId: string;
  storagePetId: string;
  storageId: string;
}

export interface MovePetSlotParams {
  movePetSlotId: string;
  toPetSlotIndex: number;
}

export interface GrowEggParams {
  slot: number;
  eggId: string;
}

export interface SavePetTeamParams {
  teamId: string;
  name: string;
  petIds: string[];
  /** Distinguishes a new team from an edit of an existing `teamId`. */
  isCreate: boolean;
}

export interface TeamIdParams {
  teamId: string;
}

export interface MovePetTeamParams {
  movePetTeamId: string;
  toPetTeamIndex: number;
}

export interface SetPetTeamEmblemParams {
  teamId: string;
  /** Must be an object; a bare string is silently dropped by the game's own reducer. */
  emblem: PetTeamEmblem;
}

// ---------------------------------------------------------- inventory & storage

export interface MoveInventoryItemParams {
  moveItemId: string;
  toInventoryIndex: number;
}

export interface SetSelectedItemParams {
  itemIndex: number;
}

export interface ToggleLockItemParams {
  itemId: string;
}

export interface PutItemInStorageParams {
  itemId: string;
  storageId: string;
  /** Omit to append at the end. */
  toStorageIndex?: number;
  /** Omit to move the whole stack. */
  quantity?: number;
}

export interface RetrieveItemFromStorageParams {
  itemId: string;
  storageId: string;
  /** Omit to append at the end. */
  toInventoryIndex?: number;
  /** Omit to move the whole stack. */
  quantity?: number;
}

export interface MoveStorageItemParams {
  itemId: string;
  storageId: string;
  toStorageIndex: number;
}

export interface SwapItemWithStorageParams {
  storageId: string;
  inventoryItemId: string;
  storageItemId: string;
  toStorageIndex?: number;
  toInventoryIndex?: number;
  /** Only send together with `draggedFromInventory`. */
  draggedQuantity?: number;
  draggedFromInventory?: boolean;
}
