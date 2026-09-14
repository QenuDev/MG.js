/**
 * `GameActions`: every documented action as a typed method.
 *
 * This is the surface that makes the wrapper "all-purpose": 72 methods covering all 71 distinct wire
 * strings, each one knowing which of the three forms it must use, so the documented silent-failure
 * mode (sending a `wrapped` action flat) cannot happen by accident.
 *
 * Methods are thin on purpose. Each one only maps its params object onto the wire fields and hands the
 * result to the {@link CommandSender}. Envelope construction, sequencing, and ack correlation live in
 * the client core, so the bootstrapped and headless clients share all of it.
 *
 * 72 methods for 71 wire strings, because `fuseCrystal()` is a documented convenience over
 * `PlaceCrystal` with `intent:{type:"merge"}` rather than a distinct wire command. The field guide is
 * explicit that "there is no separate fuse command"; the reference exposes both methods anyway, and so
 * does this class.
 */

import { randomUuid } from '../protocol/id.js';
import type { CommandHandle, CommandSender } from './handle.js';
import type {
  ChatParams,
  DisplayCropParams,
  EmoteParams,
  EquipPetCosmeticParams,
  FeedPetParams,
  FuseCrystalParams,
  GameNameParams,
  GrowEggParams,
  GrowSlotParams,
  HarvestCropParams,
  KickPlayerParams,
  LocalTileParams,
  MarkChatReadParams,
  MoveInventoryItemParams,
  MoveParams,
  MovePetSlotParams,
  MovePetTeamParams,
  MoveStorageItemParams,
  MutationPotionParams,
  NamePetParams,
  PetAbilityParams,
  PetItemParams,
  PickupCrystalParams,
  PickupPetParams,
  PingParams,
  PlaceCrystalParams,
  PlaceDecorParams,
  PlacePetParams,
  PlantGardenPlantParams,
  PlantSeedParams,
  PotPlantParams,
  PreserveParams,
  PurchaseShopItemParams,
  PutItemInStorageParams,
  RemoveGardenObjectParams,
  RequestPetGreetParams,
  RestartGameParams,
  RetrieveItemFromStorageParams,
  SavePetTeamParams,
  SellPetParams,
  SetPetTeamEmblemParams,
  SetPlayerDataParams,
  SetSelectedItemParams,
  SlotParams,
  SwapItemWithStorageParams,
  SwapPetFromStorageParams,
  SwapPetParams,
  TeamIdParams,
  ToggleLockItemParams,
  WishParams,
} from './params.js';

/**
 * Every action, typed.
 *
 * Construct with a {@link CommandSender}, in practice the shared client core, which supplies envelope
 * building and sequence numbering.
 */
export class GameActions {
  private readonly sender: CommandSender;

  constructor(sender: CommandSender) {
    this.sender = sender;
  }

  // -------------------------------------------------------------- session & heartbeat

  /**
   * Flat `Ping`, answered with a matching `Pong`.
   *
   * Structurally different from a command: it gets a direct `Pong` reply rather than a
   * `QuinoaCommandResult`, so its handle will not settle on a result frame. Distinct from the
   * bare-string `"ping"`/`"pong"` keepalive, which both clients' transports answer automatically.
   */
  ping(params: PingParams = {}): CommandHandle {
    return this.sender.send('Ping', { id: params.id ?? Date.now() });
  }

  /** Room-scoped. Send on open, before {@link setSelectedGame}. */
  voteForGame(params: GameNameParams = {}): CommandHandle {
    return this.sender.send('VoteForGame', { gameName: params.gameName ?? 'Quinoa' });
  }

  /** Room-scoped. Field is `gameName` here too. */
  setSelectedGame(params: GameNameParams = {}): CommandHandle {
    return this.sender.send('SetSelectedGame', { gameName: params.gameName ?? 'Quinoa' });
  }

  /**
   * Room-scoped.
   *
   * NOTE the wire-field divergence: this method takes `gameName` but emits `name`, because that is
   * what the server expects for `RestartGame` alone.
   */
  restartGame(params: RestartGameParams = {}): CommandHandle {
    return this.sender.send('RestartGame', { name: params.gameName ?? 'Quinoa' });
  }

  /** Nudges the server to (re)confirm current weather. */
  checkWeatherStatus(): CommandHandle {
    return this.sender.send('CheckWeatherStatus');
  }

  // ------------------------------------------------------------------- social & chat

  chat(params: ChatParams): CommandHandle {
    return this.sender.send('Chat', { message: params.message });
  }

  emote(params: EmoteParams): CommandHandle {
    return this.sender.send('Emote', { emoteType: params.emoteType });
  }

  /**
   * Throws a coin in the wishing well.
   *
   * Omit `itemId` entirely for an untargeted wish. Do not send `null`. Passing `undefined` or
   * leaving the key out both produce a frame with no `itemId`.
   */
  wish(params: WishParams = {}): CommandHandle {
    return this.sender.send('Wish', { itemId: params.itemId });
  }

  /** Host-only, enforced server-side. */
  kickPlayer(params: KickPlayerParams): CommandHandle {
    return this.sender.send('KickPlayer', { targetPlayerId: params.targetPlayerId });
  }

  /** Include only the field(s) you are changing. */
  setPlayerData(params: SetPlayerDataParams): CommandHandle {
    return this.sender.send('SetPlayerData', { name: params.name, cosmetic: params.cosmetic });
  }

  usurpHost(): CommandHandle {
    return this.sender.send('UsurpHost');
  }

  markChatRead(params: MarkChatReadParams): CommandHandle {
    return this.sender.send('MarkChatRead', { seq: params.seq });
  }

  // ----------------------------------------------------------------------- movement

  /**
   * Broadcast a movement position.
   *
   * Sent continuously: it feeds a snapshot channel rather than a discrete sequenced action, so it is
   * never expected to move into the command envelope. The wire nests `x`/`y` under `position`.
   */
  move(params: MoveParams): CommandHandle {
    return this.sender.send('PlayerPosition', { position: { x: params.x, y: params.y } });
  }

  /** Instant position set, tile-grid coordinates. */
  teleport(params: MoveParams): CommandHandle {
    return this.sender.send('Teleport', { position: { x: params.x, y: params.y } });
  }

  // --------------------------------------------------------------------------- shop

  /** Replaces the older per-category purchase messages. */
  purchaseShopItem(params: PurchaseShopItemParams): CommandHandle {
    return this.sender.send('PurchaseShopItem', { shop: params.shop, item: params.item });
  }

  // ---------------------------------------------------------------- garden & crops

  plantSeed(params: PlantSeedParams): CommandHandle {
    return this.sender.send('PlantSeed', {
      slot: params.slot,
      seedItemId: params.seedItemId,
    });
  }

  waterPlant(params: SlotParams): CommandHandle {
    return this.sender.send('WaterPlant', { slot: params.slot });
  }

  /**
   * Harvest a crop.
   *
   * `cropItemId` is a client-minted UUID and is required on the wire. The documented rationale is
   * that the resulting item "shows up in the next PartialState's inventory patch", so there is no
   * synchronous response to wait for and the client must be able to reference the crop immediately.
   * One is minted here when you do not supply one.
   *
   * (That quote is from a doc written before v756 renamed the frame to `RoomFrame`; the arrival being
   * asynchronous is the part that still holds, and it is the part this signature is built around.)
   */
  harvestCrop(params: HarvestCropParams): CommandHandle {
    return this.sender.send('HarvestCrop', {
      slot: params.slot,
      slotsIndex: params.slotsIndex,
      cropItemId: params.cropItemId ?? randomUuid(),
    });
  }

  sellAllCrops(): CommandHandle {
    return this.sender.send('SellAllCrops');
  }

  /** Plants a potted plant already in inventory back into the ground. */
  plantGardenPlant(params: PlantGardenPlantParams): CommandHandle {
    return this.sender.send('PlantGardenPlant', { slot: params.slot, itemId: params.itemId });
  }

  /** Moves the growing plant on `slot` into inventory, minting the item id when not supplied. */
  potPlant(params: PotPlantParams): CommandHandle {
    return this.sender.send('PotPlant', {
      slot: params.slot,
      plantItemId: params.plantItemId ?? randomUuid(),
    });
  }

  mutationPotion(params: MutationPotionParams): CommandHandle {
    return this.sender.send('MutationPotion', {
      tileObjectIdx: params.tileObjectIdx,
      growSlotIdx: params.growSlotIdx,
      mutation: params.mutation,
    });
  }

  /** Strips mutations from a crop. */
  cropCleanser(params: GrowSlotParams): CommandHandle {
    return this.sender.send('CropCleanser', {
      tileObjectIdx: params.tileObjectIdx,
      growSlotIdx: params.growSlotIdx,
    });
  }

  /** Place a crystal from inventory onto the ground. */
  placeCrystal(params: PlaceCrystalParams): CommandHandle {
    return this.sender.send('PlaceCrystal', {
      tileType: params.tileType,
      localTileIndex: params.localTileIndex,
      item: params.shard,
      intent: { type: 'place' },
    });
  }

  /**
   * Fuse a shard into an existing crystal.
   *
   * Convenience over {@link placeCrystal} with `intent:{type:"merge"}`. The field guide states flatly
   * that "there is no separate fuse command". Exposed as its own method because the API reference does.
   */
  fuseCrystal(params: FuseCrystalParams): CommandHandle {
    return this.sender.send('PlaceCrystal', {
      tileType: params.tileType,
      localTileIndex: params.localTileIndex,
      item: params.shard,
      intent: { type: 'merge', mergeGainSeconds: params.mergeGainSeconds },
    });
  }

  /** Picks up a crystal, keeping its remaining time. Mints the id when not supplied. */
  pickupCrystal(params: PickupCrystalParams): CommandHandle {
    return this.sender.send('PickupCrystal', {
      tileType: params.tileType,
      localTileIndex: params.localTileIndex,
      crystalType: params.crystalType,
      itemId: params.itemId ?? randomUuid(),
    });
  }

  removeGardenObject(params: RemoveGardenObjectParams): CommandHandle {
    return this.sender.send('RemoveGardenObject', {
      slot: params.slot,
      slotType: params.slotType,
    });
  }

  /** Turns a harvested crop into a preserve. */
  preserve(params: PreserveParams): CommandHandle {
    return this.sender.send('Preserve', {
      itemId: params.itemId,
      growSlotIdx: params.growSlotIdx,
    });
  }

  displayCrop(params: DisplayCropParams): CommandHandle {
    return this.sender.send('DisplayCrop', {
      tileType: params.tileType,
      localTileIndex: params.localTileIndex,
      itemId: params.itemId,
    });
  }

  pickupDisplayedCrop(params: LocalTileParams): CommandHandle {
    return this.sender.send('PickupDisplayedCrop', {
      tileType: params.tileType,
      localTileIndex: params.localTileIndex,
    });
  }

  // -------------------------------------------------------------------------- decor

  /** Omit `rotation` for the default orientation. */
  placeDecor(params: PlaceDecorParams): CommandHandle {
    return this.sender.send('PlaceDecor', {
      decorId: params.decorId,
      tileType: params.tileType,
      localTileIndex: params.localTileIndex,
      rotation: params.rotation,
    });
  }

  pickupDecor(params: LocalTileParams): CommandHandle {
    return this.sender.send('PickupDecor', {
      tileType: params.tileType,
      localTileIndex: params.localTileIndex,
    });
  }

  // --------------------------------------------------------------- pets & pet teams

  placePet(params: PlacePetParams): CommandHandle {
    return this.sender.send('PlacePet', {
      itemId: params.itemId,
      position: { x: params.x, y: params.y },
      tileType: params.tileType,
      localTileIndex: params.localTileIndex,
    });
  }

  pickupPet(params: PickupPetParams): CommandHandle {
    return this.sender.send('PickupPet', { petId: params.petId });
  }

  feedPet(params: FeedPetParams): CommandHandle {
    return this.sender.send('FeedPet', {
      petItemId: params.petItemId,
      cropItemId: params.cropItemId,
    });
  }

  /**
   * Fully restores hunger.
   *
   * Must be standing on the pet's tile. Use {@link teleport} first if needed.
   */
  useReplenishPotion(params: PetItemParams): CommandHandle {
    return this.sender.send('ReplenishPotion', { petItemId: params.petItemId });
  }

  sellPet(params: SellPetParams): CommandHandle {
    return this.sender.send('SellPet', { itemId: params.itemId });
  }

  /** Required before any rideable ability ({@link dawnCapture}, {@link thundercharge}). */
  ridePet(params: PetItemParams): CommandHandle {
    return this.sender.send('RidePet', { petItemId: params.petItemId });
  }

  dismountPet(): CommandHandle {
    return this.sender.send('DismountPet');
  }

  /** Requires riding the pet and being off cooldown. */
  dawnCapture(params: PetAbilityParams): CommandHandle {
    return this.sender.send('DawnCapture', {
      petItemId: params.petItemId,
      position: { x: params.x, y: params.y },
    });
  }

  /** Same preconditions as {@link dawnCapture}. */
  thundercharge(params: PetAbilityParams): CommandHandle {
    return this.sender.send('Thundercharge', {
      petItemId: params.petItemId,
      position: { x: params.x, y: params.y },
    });
  }

  xpPotion(params: PetItemParams): CommandHandle {
    return this.sender.send('XPPotion', { petItemId: params.petItemId });
  }

  /** Flat: one of the 15 actions that stay outside the envelope. */
  requestPetGreet(params: RequestPetGreetParams): CommandHandle {
    return this.sender.send('RequestPetGreet', {
      position: { x: params.x, y: params.y },
    });
  }

  equipPetCosmetic(params: EquipPetCosmeticParams): CommandHandle {
    return this.sender.send('EquipPetCosmetic', {
      petItemId: params.petItemId,
      slotCategory: params.slotCategory,
      cosmeticId: params.cosmeticId,
    });
  }

  namePet(params: NamePetParams): CommandHandle {
    return this.sender.send('NamePet', { petItemId: params.petItemId, name: params.name });
  }

  swapPet(params: SwapPetParams): CommandHandle {
    return this.sender.send('SwapPet', {
      petSlotId: params.petSlotId,
      petInventoryId: params.petInventoryId,
    });
  }

  swapPetFromStorage(params: SwapPetFromStorageParams): CommandHandle {
    return this.sender.send('SwapPetFromStorage', {
      petSlotId: params.petSlotId,
      storagePetId: params.storagePetId,
      storageId: params.storageId,
    });
  }

  movePetSlot(params: MovePetSlotParams): CommandHandle {
    return this.sender.send('MovePetSlot', {
      movePetSlotId: params.movePetSlotId,
      toPetSlotIndex: params.toPetSlotIndex,
    });
  }

  growEgg(params: GrowEggParams): CommandHandle {
    return this.sender.send('GrowEgg', { slot: params.slot, eggId: params.eggId });
  }

  hatchEgg(params: SlotParams): CommandHandle {
    return this.sender.send('HatchEgg', { slot: params.slot });
  }

  /** Flat: one of the 15 actions that stay outside the envelope. */
  upgradePetHutch(): CommandHandle {
    return this.sender.send('UpgradePetHutch');
  }

  /** `isCreate` distinguishes a new team from an edit of an existing `teamId`. */
  savePetTeam(params: SavePetTeamParams): CommandHandle {
    return this.sender.send('SavePetTeam', {
      teamId: params.teamId,
      name: params.name,
      petIds: params.petIds,
      isCreate: params.isCreate,
    });
  }

  applyPetTeam(params: TeamIdParams): CommandHandle {
    return this.sender.send('ApplyPetTeam', { teamId: params.teamId });
  }

  deletePetTeam(params: TeamIdParams): CommandHandle {
    return this.sender.send('DeletePetTeam', { teamId: params.teamId });
  }

  movePetTeam(params: MovePetTeamParams): CommandHandle {
    return this.sender.send('MovePetTeam', {
      movePetTeamId: params.movePetTeamId,
      toPetTeamIndex: params.toPetTeamIndex,
    });
  }

  /**
   * Set a team emblem.
   *
   * Send the emblem as an **object**, never a bare string. The field guide warns that a string is
   * silently dropped by the game's own reducer.
   */
  setPetTeamEmblem(params: SetPetTeamEmblemParams): CommandHandle {
    return this.sender.send('SetPetTeamEmblem', {
      teamId: params.teamId,
      emblem: params.emblem,
    });
  }

  // ---------------------------------------------------------- inventory & storage

  moveInventoryItem(params: MoveInventoryItemParams): CommandHandle {
    return this.sender.send('MoveInventoryItem', {
      moveItemId: params.moveItemId,
      toInventoryIndex: params.toInventoryIndex,
    });
  }

  /** Flat. */
  setSelectedItem(params: SetSelectedItemParams): CommandHandle {
    return this.sender.send('SetSelectedItem', { itemIndex: params.itemIndex });
  }

  toggleLockItem(params: ToggleLockItemParams): CommandHandle {
    return this.sender.send('ToggleLockItem', { itemId: params.itemId });
  }

  /**
   * Flat, and takes **no** parameters.
   *
   * Acts on whatever is currently held or stood on. The field guide is explicit that sending any
   * parameters gets it "rejected as malformed", so this method accepts none and the type is the guard.
   */
  dropObject(): CommandHandle {
    return this.sender.send('DropObject');
  }

  /** Flat, and takes **no** parameters, like {@link dropObject}. */
  pickupObject(): CommandHandle {
    return this.sender.send('PickupObject');
  }

  /** Omit `toStorageIndex` to append at the end; omit `quantity` to move the whole stack. */
  putItemInStorage(params: PutItemInStorageParams): CommandHandle {
    return this.sender.send('PutItemInStorage', {
      itemId: params.itemId,
      storageId: params.storageId,
      toStorageIndex: params.toStorageIndex,
      quantity: params.quantity,
    });
  }

  /** Mirrored optional-field rules from {@link putItemInStorage}. */
  retrieveItemFromStorage(params: RetrieveItemFromStorageParams): CommandHandle {
    return this.sender.send('RetrieveItemFromStorage', {
      itemId: params.itemId,
      storageId: params.storageId,
      toInventoryIndex: params.toInventoryIndex,
      quantity: params.quantity,
    });
  }

  moveStorageItem(params: MoveStorageItemParams): CommandHandle {
    return this.sender.send('MoveStorageItem', {
      itemId: params.itemId,
      storageId: params.storageId,
      toStorageIndex: params.toStorageIndex,
    });
  }

  /**
   * One atomic exchange rather than a retrieve+put pair, which keeps both capacities unchanged
   * mid-swap. Only send `draggedQuantity`/`draggedFromInventory` together, when splitting part of a
   * stack.
   */
  swapItemWithStorage(params: SwapItemWithStorageParams): CommandHandle {
    return this.sender.send('SwapItemWithStorage', {
      storageId: params.storageId,
      inventoryItemId: params.inventoryItemId,
      storageItemId: params.storageItemId,
      toStorageIndex: params.toStorageIndex,
      toInventoryIndex: params.toInventoryIndex,
      draggedQuantity: params.draggedQuantity,
      draggedFromInventory: params.draggedFromInventory,
    });
  }

  logItems(): CommandHandle {
    return this.sender.send('LogItems');
  }

  /** Flat. */
  upgradeSeedSilo(): CommandHandle {
    return this.sender.send('UpgradeSeedSilo');
  }

  /** Flat. */
  upgradeDecorShed(): CommandHandle {
    return this.sender.send('UpgradeDecorShed');
  }

  /** Flat. */
  upgradeToolShack(): CommandHandle {
    return this.sender.send('UpgradeToolShack');
  }

  /** Flat. Seasonal. */
  throwSnowball(): CommandHandle {
    return this.sender.send('ThrowSnowball');
  }

  /** Flat. */
  checkFriendBonus(): CommandHandle {
    return this.sender.send('CheckFriendBonus');
  }

  /** Flat. */
  quinoaTutorialSkipped(): CommandHandle {
    return this.sender.send('QuinoaTutorialSkipped');
  }
}

/** The method count, asserted by a test so the surface cannot silently shrink. */
export const GAME_ACTION_METHOD_COUNT = 72;
