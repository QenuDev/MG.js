/**
 * The item union, and the shapes it is built from.
 *
 * ## Where every field here comes from
 *
 * The game's own item union (`Ta` in the client bundle) is one union of eight schemas over the seven
 * `itemType` members — the tool is the one kind with two variants. Task 0 extracted those schemas into the
 * `@mg.js/art` bundle table `kindSchemas` (`packages/art/data/<version>.json`): `kindSchemas.items` maps each
 * kind to its arm(s), `kindSchemas.arms` states each arm's fields in the game's own spellings, and
 * `kindSchemas.pets` records the pet base both pet carriers are built on. That table is the evidence base,
 * and its per-declaration provenance — the declaration and byte range each table was cut from — is recorded
 * in `docs/art-provenance.md`.
 *
 * So every field below was read from the schema that declares it, and an arm carries exactly the fields its
 * kind declares. The tables in the game's bundle are:
 *
 *     produce  { id, species, itemType, size, mutations, carving, carvingVerdict }
 *     seed     { species, itemType, quantity }
 *     tool     { toolId, itemType, quantity } or { id, toolId, itemType, quantity, remainingActiveSeconds }
 *     plant    { id, species, itemType, slots, plantedAt, maturedAt }
 *     egg      { eggId, itemType, quantity }
 *     decor    { decorId, itemType, quantity }
 *     pet      aa = { id, petSpecies, name, xp, hunger, mutations, targetScale, abilities }, plus Ca's
 *                   { sourceEggId, abilityCooldowns, equippedCosmetics }
 *
 * ## The two rules, kept from the tile union (`ac7bcb5`)
 *
 * > "Three readings are on every arm rather than on the kind that declares them, because a tile's own
 * > fields are read the same way whichever kind it is."
 *
 * The same is true here: a kind's own fields are read the same way whatever it is, so the readings the wire
 * shares across kinds are on {@link InventoryItemBase} — including the two it derives (`hasLife`, from
 * whether a `remainingActiveSeconds` is stated at all, and `crops`, a potted plant's `slots` read with the
 * crop reader). Each kind's reader returns only what its own schema declares and the base has no home for.
 *
 * > "A kind none of the four declares is read as `OtherTile` — the empty kind — rather than refused or
 * > guessed at."
 *
 * {@link OtherItem} is the same answer for an eighth item kind, for the same reason: a save that grows one
 * is still a save this reader can hand on, and the spelling it used is in the item's own `record`.
 */

import type { CarvingVerdict, Crop, Mutation, StateRecordLike, StateView } from '../entities.js';
import type { PetFields } from './pet.js';

/**
 * What every inventory item carries, whichever kind it is. `itemType` is the discriminant of
 * {@link InventoryItem}.
 *
 * Every field here is one the wire shares across kinds, and the kinds that declare one of them state it in
 * the same shape and the same spelling — a pet's species is the wire's `petSpecies` everywhere it appears,
 * and a plant's `slots` is the same field a garden tile grows crops in.
 */
export interface InventoryItemBase extends StateView {
  /** The path of this item: `.../userSlots/<slot>/data/inventory/items/<n>`. */
  readonly entityPath: string;
  /**
   * What this entry is: the game's own item-type discriminant.
   *
   * `''` is the empty kind — a kind this release does not declare — and is the reason the union narrows:
   * an arm typed `string` would be a supertype of every literal and would silently stop it.
   */
  readonly itemType: ItemKind | '';
  /**
   * The entry's own id, or `''`.
   *
   * A stack of seeds or eggs is identified by its species and carries no id; a pet, a potted plant and a
   * tool with a remaining life do carry one.
   */
  readonly id: string;
  /** The species, for the kinds that have one: produce, seed, plant and pet. */
  readonly species: string;
  /** The name the player gave it, for a pet in the bag. `''` for every other kind. */
  readonly name: string;
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
 * What each kind declares that the base has no home for.
 *
 * This is the one map the union is derived from, so an arm cannot exist without its fields: adding a kind
 * here without a reader fails the registry's `satisfies`, and adding a reader for a kind that is not here
 * fails it too. A kind whose own fields are all base fields states `unknown`, which adds nothing — the
 * empty shape. Four of the seven are that today, and three declare a reading the base does not carry:
 * the plant (`plantedAt`, `maturedAt`), the pet ({@link PetFields}) and the produce (the two carving
 * fields 1650 added). That is the honest result rather
 * than a defect: the map is what makes a missing kind a compile error and what gives the next game field a
 * home.
 */
export interface ItemFields {
  readonly Seed: unknown;
  /** 1650 states a produce the same two carving fields a crop has, because a harvest carries its carving. */
  readonly Produce: {
    readonly carving: string | null;
    readonly carvingVerdict: CarvingVerdict | null;
  };
  readonly Plant: { readonly plantedAt: number; readonly maturedAt: number };
  readonly Tool: unknown;
  readonly Pet: PetFields;
  readonly Egg: unknown;
  readonly Decor: unknown;
}

/** The item kinds this release declares: the literals of {@link InventoryItemBase.itemType}'s discriminant. */
export type ItemKind = keyof ItemFields;

/** One arm of {@link InventoryItem}: the base, the fields its own kind declares, and its discriminant. */
export type ItemOfKind<K extends ItemKind> = InventoryItemBase & ItemFields[K] & { readonly itemType: K };

/**
 * The fields a kind declares that the base does not already carry.
 *
 * What a kind reader returns, and what the registry is keyed by, so "does this kind have a reader for its
 * own fields" is a check the compiler makes rather than a list this package maintains by hand.
 */
export type ItemOwnFields<K extends ItemKind> = Omit<ItemOfKind<K>, keyof InventoryItemBase>;

/**
 * A kind none of the seven declares: the empty kind.
 *
 * A valid save holds no such item, so this arm is the reader saying "a kind I do not know", which is what an
 * eighth kind would be. It reads as the empty kind rather than as whatever the save spelled, for the reason
 * `OtherTile` gives (`state/entities.ts`): an arm typed `string` is a supertype of every literal, which
 * silently stops the union from narrowing. The save's own spelling is not lost — {@link InventoryItemBase.record}
 * states it.
 */
export interface OtherItem extends InventoryItemBase {
  readonly itemType: '';
}

/**
 * One entry from a player's inventory, as the game's own item union.
 *
 * A caller switches on `itemType` and gets that kind's fields, rather than a record with everything
 * optional in it: the fields a kind does not carry are not on its arm at all.
 */
export type InventoryItem = { readonly [K in ItemKind]: ItemOfKind<K> }[ItemKind] | OtherItem;
