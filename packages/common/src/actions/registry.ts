/**
 * The action form registry: the single source of truth for which of the three outbound forms each
 * action must use.
 *
 * Why this file exists: sending a `wrapped` action flat fails **silently**. The protocol doc calls
 * that "the single most common way a hand-rolled client 'does nothing' for no visible reason."
 * Centralising the classification means no action method can get it wrong by accident, and the whole
 * table is testable in one place.
 *
 * The classification is explicitly "a moving target", and the doc says as much: "as the developers
 * migrate more action types into the envelope, anything still marked `flat` today may need to move
 * to `wrapped` in a future client build", and recommends the same fallback if an action starts
 * silently failing: "try wrapping it". Hence `setActionForm()` below, an explicit per-action opt-in,
 * because an automatic rewrite of a known-good flat action is what would break it.
 */

import { MgProtocolError } from '../errors.js';
import type { ActionForm, ScopePath } from '../protocol/wire.js';
import { SCOPE_QUINOA, SCOPE_ROOM } from '../protocol/wire.js';

/** A single action's entry in the registry. */
export interface ActionSpec {
  /** The exact wire string used as `type` (flat) or `command.type` (wrapped). */
  readonly wire: string;
  /** Which of the three forms this action takes. */
  readonly form: ActionForm;
  /** Where the action lives, for grouping and documentation. */
  readonly category: ActionCategory;
  /**
   * Parameter names, for validation and docs. `?` suffix marks an optional parameter.
   * This is advisory: the registry never strips or invents parameters.
   */
  readonly params: readonly string[];
  /** Human note for anything surprising about this action. */
  readonly note?: string;
}

export type ActionCategory =
  | 'session'
  | 'social'
  | 'movement'
  | 'shop'
  | 'garden'
  | 'decor'
  | 'pets'
  | 'inventory';

/**
 * The complete outbound action registry.
 *
 * 71 distinct wire strings across 8 categories: 9 `room`, 15 `flat`, 47 `wrapped`.
 * Derived from the protocol field guide's action reference tables (§4.1-§4.8).
 */
export const ACTION_SPECS = {
  // ---------------------------------------------------------------- session & heartbeat (§4.1)
  Ping: {
    wire: 'Ping',
    form: 'flat',
    category: 'session',
    params: ['id'],
    note: 'Answered with a matching Pong. Structurally different from a command, and never expected to move into the envelope.',
  },
  VoteForGame: {
    wire: 'VoteForGame',
    form: 'room',
    category: 'session',
    params: ['gameName'],
    note: 'Send on open, before SetSelectedGame.',
  },
  SetSelectedGame: {
    wire: 'SetSelectedGame',
    form: 'room',
    category: 'session',
    params: ['gameName'],
    note: "Field is `gameName` here too; don't confuse it with RestartGame's `name`.",
  },
  RestartGame: {
    wire: 'RestartGame',
    form: 'room',
    category: 'session',
    params: ['name'],
    note: 'Uses `name`, unlike VoteForGame/SetSelectedGame which use `gameName`.',
  },
  CheckWeatherStatus: {
    wire: 'CheckWeatherStatus',
    form: 'flat',
    category: 'session',
    params: [],
    note: 'Nudges the server to (re)confirm current weather.',
  },

  // ------------------------------------------------------------------- social & chat (§4.2)
  Chat: { wire: 'Chat', form: 'room', category: 'social', params: ['message'] },
  Emote: { wire: 'Emote', form: 'room', category: 'social', params: ['emoteType'] },
  Wish: {
    wire: 'Wish',
    form: 'wrapped',
    category: 'social',
    params: ['itemId?'],
    note: 'Throws a coin in the wishing well. Omit itemId for an untargeted wish; do not send null.',
  },
  KickPlayer: {
    wire: 'KickPlayer',
    form: 'room',
    category: 'social',
    params: ['targetPlayerId'],
    note: 'Host-only, enforced server-side.',
  },
  SetPlayerData: {
    wire: 'SetPlayerData',
    form: 'room',
    category: 'social',
    params: ['name?', 'cosmetic?'],
    note: "Include only the field(s) you're changing.",
  },
  UsurpHost: { wire: 'UsurpHost', form: 'room', category: 'social', params: [] },
  MarkChatRead: {
    wire: 'MarkChatRead',
    form: 'room',
    category: 'social',
    params: ['seq'],
    note: 'Implies the chat log is sequence-indexed.',
  },

  // ----------------------------------------------------------------------- movement (§4.3)
  PlayerPosition: {
    wire: 'PlayerPosition',
    form: 'flat',
    category: 'movement',
    params: ['position'],
    note: 'Sent continuously to broadcast movement. Feeds a continuous snapshot channel rather than a discrete sequenced action, so it is never expected to move into the envelope.',
  },
  Teleport: {
    wire: 'Teleport',
    form: 'flat',
    category: 'movement',
    params: ['position'],
    note: 'Instant position set, tile-grid coordinates.',
  },

  // --------------------------------------------------------------------------- shop (§4.4)
  PurchaseShopItem: {
    wire: 'PurchaseShopItem',
    form: 'wrapped',
    category: 'shop',
    params: ['shop', 'item'],
    note: 'Replaces older per-category purchase messages.',
  },

  // ---------------------------------------------------------------- garden & crops (§4.5)
  PlantSeed: { wire: 'PlantSeed', form: 'wrapped', category: 'garden', params: ['slot', 'seedItemId'] },
  WaterPlant: { wire: 'WaterPlant', form: 'wrapped', category: 'garden', params: ['slot'] },
  HarvestCrop: {
    wire: 'HarvestCrop',
    form: 'wrapped',
    category: 'garden',
    params: ['slot', 'cropItemId'],
    note: 'cropItemId is a client-minted UUID and is required; mint it, do not wait for one. The resulting item arrives in the next inventory patch (a RoomFrame since v756; PartialState before that); there is no synchronous response.',
  },
  SellAllCrops: { wire: 'SellAllCrops', form: 'wrapped', category: 'garden', params: [] },
  PlantGardenPlant: {
    wire: 'PlantGardenPlant',
    form: 'wrapped',
    category: 'garden',
    params: ['slot', 'itemId'],
    note: 'Plants a potted plant already in inventory back into the ground.',
  },
  PotPlant: {
    wire: 'PotPlant',
    form: 'wrapped',
    category: 'garden',
    params: ['slot', 'plantItemId'],
    note: 'Client mints the id so it can reference the pot immediately without waiting for the state patch.',
  },
  MutationPotion: {
    wire: 'MutationPotion',
    form: 'wrapped',
    category: 'garden',
    params: ['tileObjectIdx', 'growSlotIdx', 'mutation'],
  },
  CropCleanser: {
    wire: 'CropCleanser',
    form: 'wrapped',
    category: 'garden',
    params: ['tileObjectIdx', 'growSlotIdx'],
    note: 'Strips mutations from a crop.',
  },
  PlaceCrystal: {
    wire: 'PlaceCrystal',
    form: 'wrapped',
    category: 'garden',
    params: ['tileType', 'localTileIndex', 'item', 'intent'],
    note: 'Also used to fuse a shard into an existing crystal, with intent {type:"merge", mergeGainSeconds}. There is no separate fuse wire command.',
  },
  PickupCrystal: {
    wire: 'PickupCrystal',
    form: 'wrapped',
    category: 'garden',
    params: ['tileType', 'localTileIndex', 'crystalType', 'itemId'],
    note: "Keeps the crystal's remaining time. itemId is client-minted.",
  },
  RemoveGardenObject: {
    wire: 'RemoveGardenObject',
    form: 'wrapped',
    category: 'garden',
    params: ['slot', 'slotType'],
  },
  Preserve: {
    wire: 'Preserve',
    form: 'wrapped',
    category: 'garden',
    params: ['itemId', 'growSlotIdx'],
    note: 'Turns a harvested crop into a preserve.',
  },
  DisplayCrop: {
    wire: 'DisplayCrop',
    form: 'wrapped',
    category: 'garden',
    params: ['tileType', 'localTileIndex', 'itemId'],
  },
  PickupDisplayedCrop: {
    wire: 'PickupDisplayedCrop',
    form: 'wrapped',
    category: 'garden',
    params: ['tileType', 'localTileIndex'],
  },

  // -------------------------------------------------------------------------- decor (§4.6)
  PlaceDecor: {
    wire: 'PlaceDecor',
    form: 'wrapped',
    category: 'decor',
    params: ['decorId', 'tileType', 'localTileIndex', 'rotation?'],
    note: 'Omit rotation for the default orientation.',
  },
  PickupDecor: {
    wire: 'PickupDecor',
    form: 'wrapped',
    category: 'decor',
    params: ['tileType', 'localTileIndex'],
  },

  // --------------------------------------------------------------- pets & pet teams (§4.7)
  PlacePet: {
    wire: 'PlacePet',
    form: 'wrapped',
    category: 'pets',
    params: ['itemId', 'position', 'tileType', 'localTileIndex'],
  },
  PickupPet: { wire: 'PickupPet', form: 'wrapped', category: 'pets', params: ['petId'] },
  FeedPet: { wire: 'FeedPet', form: 'wrapped', category: 'pets', params: ['petItemId', 'cropItemId'] },
  ReplenishPotion: {
    wire: 'ReplenishPotion',
    form: 'wrapped',
    category: 'pets',
    params: ['petItemId'],
    note: "Fully restores hunger. Must be standing on the pet's tile; use Teleport first if needed.",
  },
  SellPet: { wire: 'SellPet', form: 'wrapped', category: 'pets', params: ['itemId'] },
  RidePet: {
    wire: 'RidePet',
    form: 'wrapped',
    category: 'pets',
    params: ['petItemId'],
    note: 'Required before any rideable ability (DawnCapture, Thundercharge).',
  },
  DismountPet: { wire: 'DismountPet', form: 'wrapped', category: 'pets', params: [] },
  DawnCapture: {
    wire: 'DawnCapture',
    form: 'wrapped',
    category: 'pets',
    params: ['petItemId', 'position'],
    note: 'Requires riding the pet and being off cooldown.',
  },
  Thundercharge: {
    wire: 'Thundercharge',
    form: 'wrapped',
    category: 'pets',
    params: ['petItemId', 'position'],
    note: 'Same preconditions as DawnCapture.',
  },
  XPPotion: { wire: 'XPPotion', form: 'wrapped', category: 'pets', params: ['petItemId'] },
  RequestPetGreet: { wire: 'RequestPetGreet', form: 'flat', category: 'pets', params: ['position'] },
  EquipPetCosmetic: {
    wire: 'EquipPetCosmetic',
    form: 'wrapped',
    category: 'pets',
    params: ['petItemId', 'slotCategory', 'cosmeticId'],
  },
  NamePet: { wire: 'NamePet', form: 'wrapped', category: 'pets', params: ['petItemId', 'name'] },
  SwapPet: { wire: 'SwapPet', form: 'wrapped', category: 'pets', params: ['petSlotId', 'petInventoryId'] },
  SwapPetFromStorage: {
    wire: 'SwapPetFromStorage',
    form: 'wrapped',
    category: 'pets',
    params: ['petSlotId', 'storagePetId', 'storageId'],
  },
  MovePetSlot: {
    wire: 'MovePetSlot',
    form: 'wrapped',
    category: 'pets',
    params: ['movePetSlotId', 'toPetSlotIndex'],
  },
  GrowEgg: { wire: 'GrowEgg', form: 'wrapped', category: 'pets', params: ['slot', 'eggId'] },
  HatchEgg: { wire: 'HatchEgg', form: 'wrapped', category: 'pets', params: ['slot'] },
  UpgradePetHutch: { wire: 'UpgradePetHutch', form: 'flat', category: 'pets', params: [] },
  SavePetTeam: {
    wire: 'SavePetTeam',
    form: 'wrapped',
    category: 'pets',
    params: ['teamId', 'name', 'petIds', 'isCreate'],
    note: 'isCreate distinguishes a new team from an edit of an existing teamId.',
  },
  ApplyPetTeam: { wire: 'ApplyPetTeam', form: 'wrapped', category: 'pets', params: ['teamId'] },
  DeletePetTeam: { wire: 'DeletePetTeam', form: 'wrapped', category: 'pets', params: ['teamId'] },
  MovePetTeam: {
    wire: 'MovePetTeam',
    form: 'wrapped',
    category: 'pets',
    params: ['movePetTeamId', 'toPetTeamIndex'],
  },
  SetPetTeamEmblem: {
    wire: 'SetPetTeamEmblem',
    form: 'wrapped',
    category: 'pets',
    params: ['teamId', 'emblem'],
    note: "Send the emblem as an object, never a bare string; a string is silently dropped by the game's own reducer.",
  },

  // ---------------------------------------------------------- inventory & storage (§4.8)
  MoveInventoryItem: {
    wire: 'MoveInventoryItem',
    form: 'wrapped',
    category: 'inventory',
    params: ['moveItemId', 'toInventoryIndex'],
  },
  SetSelectedItem: { wire: 'SetSelectedItem', form: 'flat', category: 'inventory', params: ['itemIndex'] },
  ToggleLockItem: { wire: 'ToggleLockItem', form: 'wrapped', category: 'inventory', params: ['itemId'] },
  DropObject: {
    wire: 'DropObject',
    form: 'flat',
    category: 'inventory',
    params: [],
    note: "Acts on whatever's currently held/stood-on; sending any params gets it rejected as malformed.",
  },
  PickupObject: {
    wire: 'PickupObject',
    form: 'flat',
    category: 'inventory',
    params: [],
    note: 'Same as DropObject: sending any params gets it rejected as malformed.',
  },
  PutItemInStorage: {
    wire: 'PutItemInStorage',
    form: 'wrapped',
    category: 'inventory',
    params: ['itemId', 'storageId', 'toStorageIndex?', 'quantity?'],
    note: 'Omit toStorageIndex to append at the end; omit quantity to move the whole stack.',
  },
  RetrieveItemFromStorage: {
    wire: 'RetrieveItemFromStorage',
    form: 'wrapped',
    category: 'inventory',
    params: ['itemId', 'storageId', 'toInventoryIndex?', 'quantity?'],
  },
  MoveStorageItem: {
    wire: 'MoveStorageItem',
    form: 'wrapped',
    category: 'inventory',
    params: ['itemId', 'storageId', 'toStorageIndex'],
  },
  SwapItemWithStorage: {
    wire: 'SwapItemWithStorage',
    form: 'wrapped',
    category: 'inventory',
    params: [
      'storageId',
      'inventoryItemId',
      'storageItemId',
      'toStorageIndex?',
      'toInventoryIndex?',
      'draggedQuantity?',
      'draggedFromInventory?',
    ],
    note: 'One atomic exchange rather than a retrieve+put pair; keeps both capacities unchanged mid-swap. Only send draggedQuantity/draggedFromInventory together.',
  },
  LogItems: { wire: 'LogItems', form: 'wrapped', category: 'inventory', params: [] },
  UpgradeSeedSilo: { wire: 'UpgradeSeedSilo', form: 'flat', category: 'inventory', params: [] },
  UpgradeDecorShed: { wire: 'UpgradeDecorShed', form: 'flat', category: 'inventory', params: [] },
  UpgradeToolShack: { wire: 'UpgradeToolShack', form: 'flat', category: 'inventory', params: [] },
  ThrowSnowball: {
    wire: 'ThrowSnowball',
    form: 'flat',
    category: 'inventory',
    params: [],
    note: 'Seasonal.',
  },
  CheckFriendBonus: { wire: 'CheckFriendBonus', form: 'flat', category: 'inventory', params: [] },
  QuinoaTutorialSkipped: {
    wire: 'QuinoaTutorialSkipped',
    form: 'flat',
    category: 'inventory',
    params: [],
  },
} as const satisfies Record<string, ActionSpec>;

/** Every action name in the registry. */
export type ActionName = keyof typeof ACTION_SPECS;

/** The runtime list of wire strings, in registry order. */
export const ACTION_NAMES = Object.keys(ACTION_SPECS) as ActionName[];

/**
 * The 15 actions that stay flat even inside the Quinoa scope, per the protocol doc's §5 allowlist.
 *
 * Kept as an explicit list, independently derived from `ACTION_SPECS`, so a test can assert the two
 * never drift apart. `Ping` and `PlayerPosition` are structurally different from a command
 * (a direct `Pong` reply, and a continuous snapshot channel respectively), and neither is ever expected
 * to move into the envelope.
 */
export const FLAT_ALLOWLIST: readonly ActionName[] = [
  'Ping',
  'PlayerPosition',
  'Teleport',
  'SetSelectedItem',
  'CheckWeatherStatus',
  'CheckFriendBonus',
  'ThrowSnowball',
  'QuinoaTutorialSkipped',
  'RequestPetGreet',
  'DropObject',
  'PickupObject',
  'UpgradePetHutch',
  'UpgradeSeedSilo',
  'UpgradeDecorShed',
  'UpgradeToolShack',
] as const;

/** Resolve an action name to its spec. Throws on an unknown name so typos fail loudly. */
export function getActionSpec(name: string): ActionSpec {
  const spec = (ACTION_SPECS as Record<string, ActionSpec | undefined>)[name];
  if (!spec) {
    throw new MgProtocolError(`Unknown action "${name}". Known actions: ${ACTION_NAMES.join(', ')}`);
  }
  return spec;
}

/** The scope path a given form implies. */
export function scopeForForm(form: ActionForm): ScopePath {
  return form === 'room' ? SCOPE_ROOM : SCOPE_QUINOA;
}

// --------------------------------------------------------------------------------------
// Runtime overrides
// --------------------------------------------------------------------------------------

export interface FormRegistryOptions {
  /** Per-action form overrides, for when the server-side migration moves ahead of this table. */
  overrides?: Partial<Record<ActionName, ActionForm>>;
}

/**
 * A mutable view over the form registry.
 *
 * The classification is a moving target: the developers are mid-migration from flat gameplay
 * messages to the envelope, and "anything still marked flat today may need to move to wrapped in a
 * future client build". Rather than forcing callers to wait for a release when an action starts
 * silently doing nothing, this lets them flip a form at runtime.
 */
export class FormRegistry {
  private readonly overrides: Map<string, ActionForm>;

  constructor(options: FormRegistryOptions = {}) {
    this.overrides = new Map(Object.entries(options.overrides ?? {}) as [string, ActionForm][]);
  }

  /**
   * The effective form for an action, honouring any override.
   *
   * There is no automatic fallback for `flat` actions, and the reason is worth keeping even
   * though the switch that used to exist was removed in Phase 6: the documented flat allowlist is
   * known-good, and wrapping a flat action such as `Ping` or `PlayerPosition`, which are structurally
   * not commands, would break it. Never rewrite a known-good wire form on speculation; a caller opts one
   * action in with {@link setActionForm} instead.
   */
  formOf(name: ActionName | string): ActionForm {
    const override = this.overrides.get(name);
    if (override) return override;
    return getActionSpec(name).form;
  }

  /** The declared form, ignoring overrides and fallback. */
  declaredFormOf(name: ActionName | string): ActionForm {
    return getActionSpec(name).form;
  }

  /** Force an action onto a specific form. Pass `null` to clear the override. */
  setActionForm(name: ActionName | string, form: ActionForm | null): void {
    getActionSpec(name); // validate the name
    if (form === null) this.overrides.delete(name);
    else this.overrides.set(name, form);
  }

  /** Snapshot of every override currently in force. */
  get activeOverrides(): ReadonlyMap<string, ActionForm> {
    return this.overrides;
  }
}

/** The process-wide default registry. Clients may hold their own instead. */
export const defaultFormRegistry = new FormRegistry();
