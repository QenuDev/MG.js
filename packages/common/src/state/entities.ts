/**
 * The domain model: the shapes `StateReader` returns, typed from what the game itself uses.
 *
 * ## Where every field name here comes from
 *
 * Not from the vendored protocol field guide, which names only a handful of paths and gets the garden's
 * nesting wrong, and not from guessing. Every field was read out of the game's own client bundle
 * (version 1171), from the schema definitions and the accessors the game runs on the same objects a mod
 * receives. That is the standard `catalog/defs.ts` already set for entity shapes ("name the fields that
 * are actually observed"), applied to the state tree.
 *
 * The consequence worth understanding: **this file is versioned with the game.** A crop's fields are the
 * schema `Uo` in the game's bundle, and a build that renames one is a build this model must follow. Each
 * type names the source it was read from, so the next person can check it rather than trust it.
 *
 * ## The three levels, which are easy to get wrong
 *
 *     userSlots[i].data.garden.tileObjects[<tile>]     a tile
 *                                   .slots[<n>]        a crop planted on it
 *
 * `tileObjects` is an object keyed by tile, not an array, and a tile holds zero or more crops. A crop is
 * what the wire calls a "grow slot"; `slot` is never a word in this API.
 *
 * ## Where the escape hatch is
 *
 * Anything the bundle does not pin stays readable by name, through {@link StateRecordLike}. That is one
 * deliberate hole for a mod that cannot wait for a library release, and it is the only place in the
 * public API where a field name is a string.
 */

/**
 * A crop mutation id.
 *
 * The eleven ids are the keys of the game's own mutation table (`U` in `quinoaPredictionAtoms`), and they
 * are the values that appear in a crop's `mutations` array. They are **not** the display names: see
 * {@link MutationInfo}.
 *
 * The trailing intersection is deliberate: a game update can add a mutation before this library ships, and
 * a mod checking `mutation === 'NewThing'` should still compile. The known ids give autocomplete without
 * making a new one a type error.
 */
export type Mutation =
  | 'Gold'
  | 'Rainbow'
  | 'Wet'
  | 'Chilled'
  | 'Frozen'
  | 'Thunderstruck'
  | 'Dawnlit'
  | 'Ambershine'
  | 'Dawncharged'
  | 'Ambercharged'
  | 'Thundercharged'
  | (string & Record<never, never>);

/** The `group` field on a mutation, which is what weather and pet abilities are keyed by. */
export type MutationGroup = 'Growth' | 'Hydro' | 'Lunar' | (string & Record<never, never>);

/**
 * One mutation as the game defines it.
 *
 * `name` is the display name and it is **not** always the id: the bundle maps `Ambershine` to `Amberlit`,
 * `Dawncharged` to `Dawnbound` and `Ambercharged` to `Amberbound`. A mod that shows an id to a player shows
 * the wrong word, which is why both are here.
 */
export interface MutationInfo {
  readonly id: Mutation;
  readonly name: string;
  readonly group: MutationGroup;
  readonly coinMultiplier: number;
  readonly baseChance: number;
}

/** Every mutation the game defines at version 1171, keyed by id. */
export const MUTATIONS: Readonly<Record<string, MutationInfo>> = {
  Gold: { id: 'Gold', name: 'Gold', group: 'Growth', coinMultiplier: 25, baseChance: 0.01 },
  Rainbow: { id: 'Rainbow', name: 'Rainbow', group: 'Growth', coinMultiplier: 50, baseChance: 0.001 },
  Wet: { id: 'Wet', name: 'Wet', group: 'Hydro', coinMultiplier: 2, baseChance: 0 },
  Chilled: { id: 'Chilled', name: 'Chilled', group: 'Hydro', coinMultiplier: 2, baseChance: 0 },
  Frozen: { id: 'Frozen', name: 'Frozen', group: 'Hydro', coinMultiplier: 6, baseChance: 0 },
  Thunderstruck: {
    id: 'Thunderstruck',
    name: 'Thunderstruck',
    group: 'Hydro',
    coinMultiplier: 5,
    baseChance: 0,
  },
  Dawnlit: { id: 'Dawnlit', name: 'Dawnlit', group: 'Lunar', coinMultiplier: 4, baseChance: 0 },
  Ambershine: { id: 'Ambershine', name: 'Amberlit', group: 'Lunar', coinMultiplier: 6, baseChance: 0 },
  Dawncharged: { id: 'Dawncharged', name: 'Dawnbound', group: 'Lunar', coinMultiplier: 7, baseChance: 0 },
  Ambercharged: {
    id: 'Ambercharged',
    name: 'Amberbound',
    group: 'Lunar',
    coinMultiplier: 10,
    baseChance: 0,
  },
  Thundercharged: {
    id: 'Thundercharged',
    name: 'Thundercharged',
    group: 'Hydro',
    coinMultiplier: 7,
    baseChance: 0,
  },
};

/** What a mutation is called in the game's own UI, which is often not its id. */
export function mutationName(mutation: Mutation): string {
  return MUTATIONS[mutation]?.name ?? mutation;
}

/** An inventory or placement kind, from the game's own `itemType` enum (`O` in the bundle). */
export type ItemType =
  | 'Seed'
  | 'Produce'
  | 'Plant'
  | 'Tool'
  | 'Pet'
  | 'Egg'
  | 'Decor'
  | (string & Record<never, never>);

/**
 * A view of one location in the store.
 *
 * Every view knows the path it was built from. That is what lets {@link StateReader.watch} match a change
 * to the object a caller is holding, without the caller ever writing a JSON Pointer.
 */
export interface StateView {
  /** The store path this view reads. */
  readonly entityPath: string;
}

/**
 * A view of one location in the store.
 *
 * Every view knows the path it was built from. That is what lets {@link StateReader.watch} match a change
 * to the object a caller is already holding, without the caller ever writing a JSON Pointer.
 */
export interface StateView {
  /** The store path this view reads. */
  readonly entityPath: string;
}

/**
 * One crop planted on a tile: the grow-slot schema `Uo` in the game's bundle.
 *
 *     Uo = d({ species, startTime, endTime, size, mutations, x, y, rotation, flipped, preserved, slotId })
 *
 * `startTime` and `endTime` are server milliseconds, and `remainingMs` and `ready` are derived from them
 * against {@link StateReader.now} rather than `Date.now()`, because that is the clock the game itself
 * compares against.
 */
export interface Crop extends StateView {
  /** The path of this crop: `.../garden/tileObjects/<tile>/slots/<n>`. */
  readonly entityPath: string;
  /**
   * The crop's own id: the wire's `slotId`.
   *
   * The schema declares it a plain number, and the same number is what `HarvestCrop` sends as
   * `slotsIndex` and what `CropCleanser` and `MutationPotion` send as `growSlotIdx`. It is unique within
   * its tile, not across a garden, so a crop is addressed by its tile and its id together.
   */
  readonly id: number;
  /** The species id, e.g. `Carrot`. */
  readonly species: string;
  /** When it was planted, in server milliseconds. `0` when the field is absent. */
  readonly startTime: number;
  /** When it finishes growing, in server milliseconds. `0` when the field is absent. */
  readonly endTime: number;
  /** The crop's size. The bundle's default is 50, with a range up to 100. */
  readonly size: number;
  /** Every mutation on this crop. */
  readonly mutations: Mutation[];
  /** Where on its plant or tile it sits. `0` when the save does not state one. */
  readonly x: number;
  /** Where on its plant or tile it sits. `0` when the save does not state one. */
  readonly y: number;
  /**
   * True when the save stated a position at all.
   *
   * The position is optional on the wire, and a crop that carries none is not at zero: the game places it at
   * `plant.slotOffsets[slotId]` from the blueprint. Without this, a missing position and a position of zero
   * are the same value, and every crop on a potted plant reads as being at the plant's middle.
   */
  readonly positioned: boolean;
  /** Rotation in degrees. The game's own set is `0, -360, 90, -90, 180, -180, 270, -270`. */
  readonly rotation: number;
  /** True when the crop is drawn mirrored. */
  readonly flipped: boolean;
  /** True when the crop was preserved, which is what the harvest prompt offers on it. */
  readonly preserved: boolean;
  /**
   * True when the crop is finished and can be harvested.
   *
   * Derived, not sent: the game computes it from {@link endTime} against its own clock, so no patch ever
   * announces the moment a crop ripens. That is why {@link StateReader.watch} arms a timer for it, and
   * why a watcher built on change delivery alone would never see it flip.
   */
  readonly ready: boolean;
  /** Milliseconds until it finishes, or `0` when it already has. */
  readonly remainingMs: number;
  /** Everything else the crop carries, read by name. The escape hatch. */
  readonly record: StateRecordLike;
}

/**
 * Which of the garden's two grounds a tile belongs to.
 *
 * The game keeps two tile maps — `garden.tileObjects` for the soil and `garden.boardwalkTileObjects` for the
 * boardwalk — and an index only means something with the map it came from, because the two are keyed
 * independently: the same key can name a soil tile and a boardwalk tile at once. The game's own name for the
 * pair is `tileType`, and it is what every tile-addressed action states beside the index (`PlaceCrystal`,
 * `PickupCrystal`, `PlaceDecor`, `PlacePet`, …).
 *
 * It says which ground, not what is on it. Both grounds hold more than their usual contents: a shard can be
 * charged on the boardwalk, and decoration can stand in the soil, so nothing about the object on a tile says
 * which of the two maps it is keyed in.
 */
export type TileType = 'Dirt' | 'Boardwalk';

/**
 * What a tile holds, in the spelling a tile writes it.
 *
 * A tile says its kind in lowercase (`plant`, `egg`, `decor`, `crystal`) while an inventory entry says its own
 * in capitals (`Plant`, `Tool`, …), which is the game's spelling on each side and not a choice here.
 */
export type TileObjectType = 'plant' | 'egg' | 'decor' | 'crystal';

/**
 * One garden tile: the game's own tile schemas, which are four shapes and not one.
 *
 *     ka = d({ objectType: N.Plant,   species: L, slots: x(ga), plantedAt: U, maturedAt: U })
 *     Aa = d({ objectType: N.Egg,     eggId: j, plantedAt: U, maturedAt: U })
 *     ja = d({ objectType: N.Decor,   decorId: Ln, mountedCrop: c(_a), rotation: na })
 *     Ma = d({ objectType: N.Crystal, crystalType: nn, remainingActiveSeconds: y(h(), b(), r(0), a(an)) })
 *     Na = f([ka, Aa, ja, Ma])      // `tileObjects`: a tile is any of the four
 *     Pa = f([ja, Ma])              // `boardwalkTileObjects`: decoration or a charged shard only
 *     Fa = d({ tileObjects: l(_(), Na), boardwalkTileObjects: l(_(), Pa) })
 *
 * The four are modelled as the game models them — a **union discriminated by `objectType`** — rather than as
 * one record with everything optional in it. A tile then carries the fields its own kind declares and no
 * others, and a reader that checks {@link TileBase.objectType} gets that kind's fields without a cast.
 *
 * Three readings are on every arm rather than on the kind that declares them, because a tile's own fields are
 * read the same way whichever kind it is: {@link TileBase.plantedAt} and {@link TileBase.maturedAt} (declared
 * by the plant and egg schemas) and {@link TileBase.plots} (the plant schema's `slots`). A tile whose kind
 * does not state one reads `0`, or no crops, which is the same reading the game's own defaults make.
 */
export type Tile = PlantTile | EggTile | DecorTile | CrystalTile | OtherTile;

/** What every tile carries, whichever kind it is. */
export interface TileBase extends StateView {
  /** The path of this tile: `.../garden/tileObjects/<id>`. */
  readonly entityPath: string;
  /**
   * Which ground this tile is on: the map it was read from.
   *
   * Not a field the game sends — the save says it by which of the two maps the tile is keyed in — so this is
   * that reading, under the game's own name for it. It is what makes {@link id} an address: the boardwalk
   * numbers its keys from zero as well, so an id on its own names a soil tile and a boardwalk tile at once.
   */
  readonly tileType: TileType;
  /**
   * The tile's key in its own map: what the wire calls a tile object index.
   *
   * The schema declares these keys as numbers, and this is the number `HarvestCrop` sends as `slot` and
   * that `CropCleanser` and `MutationPotion` send as `tileObjectIdx`.
   */
  readonly id: number;
  /** What this tile holds: the discriminant of {@link Tile}. */
  readonly objectType: ItemType;
  /**
   * When the tile's contents were placed, in server milliseconds.
   *
   * The plant and egg schemas declare it, and for an egg it is the start of the hatching period. `0` when the
   * field is absent.
   */
  readonly plantedAt: number;
  /**
   * When the tile's contents are due to finish, in server milliseconds.
   *
   * The plant and egg schemas declare it. `0` when the field is absent.
   */
  readonly maturedAt: number;
  /**
   * The crops in the tile's `slots`, in the game's own order.
   *
   * The plant schema declares `slots`; a tile of another kind reads as no crops. A decoration's crop is
   * {@link DecorTile.mountedCrop} rather than a plot.
   */
  readonly plots: Crop[];
  /** Everything else the tile carries, read by name. The escape hatch. */
  readonly record: StateRecordLike;
}

/** A plant tile: a species growing in `slots`. */
export interface PlantTile extends TileBase {
  readonly objectType: 'plant';
  /** The planted species — the same name an inventory seed or produce carries. */
  readonly species: string;
}

/** An egg tile: the egg that is hatching in it. */
export interface EggTile extends TileBase {
  readonly objectType: 'egg';
  /** The egg's own id, in the spelling the egg table uses (`SnowEgg`). */
  readonly eggId: string;
}

/** A decoration tile: the decoration standing on it, at the angle it is placed at. */
export interface DecorTile extends TileBase {
  readonly objectType: 'decor';
  /** The decoration's id, as the game's decor table spells it. */
  readonly decorId: string;
  /**
   * The angle the decoration is placed at, in degrees.
   *
   * The game hangs six decorations half a tile off their tile at `0`, `90`, `180` and `270`, which moves both
   * the art and its place in the world stack. `0` when the field is absent.
   */
  readonly rotation: number;
  /**
   * A crop mounted **on** the decoration, or `null`.
   *
   * The decor schema declares it (`mountedCrop: c(_a)`), and it is a crop like any other: a decoration can
   * carry one where a plant tile carries `slots`.
   */
  readonly mountedCrop: Crop | null;
}

/** A crystal tile: a shard charged in it, and how much of that charge is left. */
export interface CrystalTile extends TileBase {
  readonly objectType: 'crystal';
  /** The crystal's type, as the crystal table spells it (`Hunger`). */
  readonly crystalType: string;
  /** What is left of the charge, in seconds. `0` when the tile states none, which the game reads as spent. */
  readonly remainingActiveSeconds: number;
  /**
   * Whether the tile states a charge at all.
   *
   * A spent crystal states a zero; a tile that states nothing has no charge to count. The two read the same
   * through {@link remainingActiveSeconds}, so the difference is named here, exactly as an inventory entry's
   * own `hasLife` names it.
   */
  readonly hasLife: boolean;
}

/**
 * A tile whose `objectType` is none of the four the game declares.
 *
 * A valid save holds no such tile — the game's own schema for a tile is `f([ka, Aa, ja, Ma])` — so this arm is
 * the reader saying "a kind I do not know", which is what a **fifth** kind would be. It reads as the empty
 * kind rather than as whatever the save spelled, because the empty kind is the only unit type that can stand
 * for "not one of the four": TypeScript needs a unit type for an arm of a discriminated union, and an arm
 * typed `string` is a supertype of every literal, which silently stops the whole union from narrowing. The
 * save's own spelling is not lost: {@link TileBase.record} states it.
 */
export interface OtherTile extends TileBase {
  readonly objectType: '';
}

/**
 * One garden: a player's tiles, as the game's two grounds.
 *
 * The game sends two tile maps and they are read as two, never merged: they are keyed independently, so the
 * same key can name a soil tile and a boardwalk tile at once and a merge would drop whichever lost. Each tile
 * says which ground it is on ({@link Tile.tileType}), so a caller that wants them together can say so itself
 * without losing the distinction.
 *
 * What is on a tile does not say which ground it is on. Decoration can stand in the soil and a shard can be
 * charged on the boardwalk, so a caller classifying by `objectType` puts both in the wrong place.
 */
export interface Garden extends StateView {
  /** The path of this garden: `.../userSlots/<slot>/data/garden`. */
  readonly entityPath: string;
  /** The soil: every plantable tile, ordered by tile id, from the game's `tileObjects`. */
  readonly tiles: Tile[];
  /**
   * The garden's boardwalk, from `boardwalkTileObjects`, ordered by tile id.
   *
   * Kept apart from {@link tiles} on purpose. The two maps are keyed independently, so the same key can
   * name a plantable tile and a boardwalk tile at once, and merging them into one list silently dropped
   * whichever lost the collision. A boardwalk tile usually holds decoration such as a pet hutch, but it is
   * the ground that makes it a boardwalk tile, not the hutch: a shard charged there is a boardwalk tile too.
   */
  readonly boardwalkTiles: Tile[];
  /** Everything else the garden carries, read by name. The escape hatch. */
  readonly record: StateRecordLike;
}

/**
 * A pet, from the game's own pet record schema.
 *
 * The schema is spread from a base record and extended, so the fields are:
 *
 *     { id, petSpecies, name, xp, hunger, mutations, targetScale, abilities,
 *       sourceEggId, abilityCooldowns, equippedCosmetics }
 */
export interface Pet extends StateView {
  /** The path of this pet: `.../userSlots/<slot>/data/petSlots/<n>`. */
  readonly entityPath: string;
  readonly id: string;
  /** The pet's species: the wire's `petSpecies`. */
  readonly species: string;
  /** The name the player gave it, or `''`. */
  readonly name: string;
  readonly xp: number;
  /**
   * Hunger, `0` to `100`. `0` is starving.
   *
   * The scale is per species: the game renders the bar against a per-species replenish cost, so this is a
   * bare number rather than a percentage.
   */
  readonly hunger: number;
  readonly mutations: Mutation[];
  readonly targetScale: number;
  /** The ability ids this pet has, which is what a pet-team layout cares about. */
  readonly abilities: string[];
  /** The egg it hatched from. */
  readonly sourceEggId: string;
  /** Everything else the pet carries, read by name. The escape hatch. */
  readonly record: StateRecordLike;
}

/**
 * One player, as the room's `players` array carries them.
 *
 * This is the room's own list, and the room says nothing about money: an entry is an id, a name and the
 * Discord id under one of two spellings. A balance lives in the player's saved data, which is
 * {@link Currency} and is read from their slot rather than from here.
 */
export interface PlayerRecord {
  /** This session's id for the player, matching `Welcome.selfPlayerId`. */
  readonly id: string;
  /** The player's display name, as the room shows it. */
  readonly name: string;
  /** The player's Discord snowflake, on builds that spell it this way. */
  readonly discordUserId: string;
  /** The same value under the older build's name. Empty when the build sends `discordUserId`. */
  readonly databaseUserId: string;
  /** True when either Discord id field was present, which is how a signed-in player is told from a guest. */
  readonly hasDiscordId: boolean;
}

/**
 * What a player can spend, from their saved data.
 *
 * Both balances are fields of the same saved object the garden lives in, so they are read from the player's
 * own slot. The room's player list does not carry them: an early revision of this library read coins from
 * there, and every player's balance came back as zero.
 *
 * The names are the save's own. An abbreviated one (`dust` for `magicDustCount`) would be this library
 * inventing a currency rather than reporting one.
 */
export interface Currency {
  /** Coins, as `coinsCount` in the player's saved data. */
  readonly coinsCount: number;
  /** Magic Dust, as `magicDustCount` in the player's saved data. */
  readonly magicDustCount: number;
}

/**
 * One stack in an inventory.
 *
 * The save keeps one array for everything a player owns, and `itemType` decides which of the item schemas
 * an entry is. The fields that are true of every kind are read here whatever the entry is; the rest are
 * read per kind and left empty otherwise, so a caller switching on `itemType` sees the fields that kind
 * carries rather than a hole where the others would be.
 *
 * The item schemas in the game's bundle are:
 *
 *     produce  { id, species, itemType, size, mutations }
 *     seed     { species, itemType, quantity }
 *     tool     { toolId, itemType, quantity } or { id, toolId, itemType, quantity, remainingActiveSeconds }
 *     plant    { id, species, itemType, slots, plantedAt, maturedAt }
 *     egg      { eggId, itemType, quantity }
 *     decor    { decorId, itemType, quantity }
 *     pet      { id, petSpecies, itemType, name, xp, hunger, mutations, targetScale, abilities, … }
 */
export interface InventoryItem extends StateView {
  /** The path of this item: `.../userSlots/<slot>/data/inventory/items/<n>`. */
  readonly entityPath: string;
  /** What this entry is. This is the game's own discriminator field. */
  readonly itemType: ItemType;
  /**
   * The entry's own id, or `''`.
   *
   * A stack of seeds or eggs is identified by its species and carries no id; a pet, a potted plant and a
   * tool with a remaining life do carry one.
   */
  readonly id: string;
  /** The species, for the kinds that have one: produce, seed, plant and pet. */
  readonly species: string;
  /** How many are in this stack. `1` for the kinds that are stored one at a time. */
  readonly quantity: number;
  /** The crop's size, for produce. `0` for every other kind. */
  readonly size: number;
  /** The crop's mutations, for produce. Empty for every other kind. */
  readonly mutations: Mutation[];
  /** The tool's id, for tools. `''` for every other kind. */
  readonly toolId: string;
  /**
   * Seconds of life left on a consumable tool, for the kinds that have one.
   *
   * `0` for a tool that is not consumable and for every other kind, which is why it is not the way to tell
   * whether a tool is spent: `remainingActiveSeconds` being absent is. {@link hasLife} says which it is.
   */
  readonly remainingActiveSeconds: number;
  /** True when the entry carries a `remainingActiveSeconds` at all, rather than reporting it as `0`. */
  readonly hasLife: boolean;
  /** The egg's id, for eggs. `''` for every other kind. */
  readonly eggId: string;
  /** The decoration's id, for decor. `''` for every other kind. */
  readonly decorId: string;
  /** The name the player gave it, for a pet in the bag. `''` for every other kind. */
  readonly name: string;
  /**
   * What is growing in it, for a potted plant. Empty for every other kind.
   *
   * A plant item is a pot with crops in it, and the save holds those crops under `slots`, the same field a
   * garden tile uses. Reading them here is what tells a potted plant with something growing from one that
   * is bare.
   */
  readonly crops: Crop[];
  /** Everything else the item carries, read by name. The escape hatch. */
  readonly record: StateRecordLike;
}

/**
 * A container a player owns, and what is in it.
 *
 * A storage is created by placing the decoration that provides it, so `decorId` is both what it is and
 * where it came from: a seed silo is a storage whose `decorId` is `SeedSilo`. A player can own more than
 * one of the same kind, so an inventory holds a list rather than a lookup by kind.
 */
export interface Storage extends StateView {
  /** The path of this storage: `.../userSlots/<slot>/data/inventory/storages/<n>`. */
  readonly entityPath: string;
  /** The decoration that provides this storage, such as `SeedSilo`, `PetHutch`, `ToolShack` or `DecorShed`. */
  readonly decorId: string;
  /** How many slots the storage has. `0` when the field is absent. */
  readonly capacitySlots: number;
  /** What is in it. Empty is a real state, and is not the same as the storage being absent. */
  readonly items: InventoryItem[];
  /** Everything else the storage carries, read by name. The escape hatch. */
  readonly record: StateRecordLike;
}

/**
 * Everything a player owns.
 *
 * The loose items are the ones held in hand, and the storages are the containers built from decoration.
 * Both live under the player's saved `inventory`, which is the same object the garden and the balances
 * come from.
 */
export interface Inventory {
  /** The items outside any container. */
  readonly items: InventoryItem[];
  /** Every container the player has built, in the save's own order. */
  readonly storages: Storage[];
}

/**
 * One player: the room's record of them, joined to their own data in the game tree.
 *
 * The room names a player by id and the game tree holds their garden under a slot, so this is a join.
 * {@link garden} is `null` exactly when that join failed, which is not the same as a garden with no tiles
 * and must not be read as one.
 */
export interface Player extends StateView, Currency {
  /** The player's path in the room's own list: `/data/players/<index>`. */
  readonly entityPath: string;
  /** This session's id for the player, matching `Welcome.selfPlayerId`. */
  readonly id: string;
  /** The player's display name, as the room shows it. */
  readonly name: string;
  /**
   * The player's garden, or `null` when their slot could not be resolved.
   *
   * `null` means this release could not find the player's data in the game tree; a `Garden` with no tiles
   * means they have no tiles. A caller about to act on a garden should treat `null` as a failure rather
   * than as an empty garden, because that is the difference between doing nothing and doing the wrong
   * thing.
   */
  readonly garden: Garden | null;
  /** Everything the player owns, in hand and in storage. */
  readonly inventory: Inventory;
  /** The pets this player has out. A pet in a bag or a storage is an inventory item, not one of these. */
  readonly pets: Pet[];
  /** The player's ability and event log. Capped by the game, so use entry timestamps as a watermark. */
  readonly activityLog: ActivityEntry[];
  /** Everything else this player's data carries, read by name. The escape hatch. */
  readonly record: StateRecordLike;
}

/** The room, and everything in it that this release models. */
export interface Room extends StateView {
  /** The room-state root, `/data`. */
  readonly entityPath: string;
  /** Everyone in the room, in the order the room lists them. */
  readonly players: Player[];
  /**
   * The room host's player id, or `null` before it is known.
   *
   * Exposed as the id rather than as a materialised player, because the room sends an id and a host object
   * would be a second route to a `Player` that {@link players} already reaches.
   */
  readonly hostPlayerId: string | null;
  /** The room's chat log. Loose, because no document names a chat message's fields. */
  readonly chat: StateRecordLike[];
  /** The room-state root, read by name. The escape hatch. */
  readonly record: StateRecordLike;
}

/**
 * One entry in a player's ability and event log, at `userSlots[i].data.activityLogs`.
 *
 * The guide names three fields on an entry: `action` ("check against the game's known ability-name list"),
 * `parameters`, and `parameters.pet` ("read for who did it"). The capitalised spellings appear in the
 * guide's own patch examples, so both are read.
 */
export interface ActivityEntry extends StateView {
  /** The path of this entry: `.../data/activityLogs/<n>`. */
  readonly entityPath: string;
  /** The action the game logged, e.g. `harvest`, `feedPet` or an ability name. */
  readonly action: string;
  /**
   * When it happened, in server milliseconds, or `0` when the entry does not carry one.
   *
   * Not in the game's declared schema, so it is read through the escape hatch and offered here because the
   * cap on the log makes it the only usable watermark for "since I last looked".
   */
  readonly timestamp: number;
  /** Every parameter the entry carries, still untyped, because the guide does not name them. */
  readonly parameters: StateRecordLike;
  /** The entry exactly as the server sent it. */
  readonly record: StateRecordLike;
}

/**
 * The read surface behind every loosely-typed value these types reference.
 *
 * Declared as an interface rather than imported from `reader.ts` so this module stays free of a cycle:
 * `reader.ts` imports these types, and these types only need to say what the reader can do.
 */
export interface StateRecordLike {
  /** The underlying object, for a field no accessor covers. */
  readonly raw: Record<string, unknown>;
  string(field: string, fallback?: string): string;
  /** The field as a string, accepting a number and rendering it. */
  id(field: string, fallback?: string): string;
  number(field: string, fallback?: number): number;
  boolean(field: string, fallback?: boolean): boolean;
  records(field: string): StateRecordLike[];
  record(field: string): StateRecordLike;
  /** True when the field is present with any value other than `undefined`. */
  has(field: string): boolean;
  /** The field names this object actually carries. */
  fields(): string[];
  /** A value at a nested slash-separated path, so `read('parameters/pet')` needs no casts. */
  read(path: string): unknown;
}

/** The two spellings of the Discord id field, in the order they are probed. */
export const DISCORD_ID_FIELDS = ['discordUserId', 'databaseUserId'] as const;

/** The two spellings of an activity entry's action field. */
export const ACTIVITY_ACTION_FIELDS = ['action', 'Action'] as const;

/** The two spellings of an activity entry's parameter bag. */
export const ACTIVITY_PARAMETER_FIELDS = ['parameters', 'Parameters'] as const;

/** The two spellings of the pet field inside an activity entry's parameter bag. */
export const ACTIVITY_PET_FIELDS = ['pet', 'Pet'] as const;
