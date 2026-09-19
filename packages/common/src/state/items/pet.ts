/**
 * A pet's fields, wherever it is carried.
 *
 * ## One list, two carriers
 *
 * The game builds its pet item arm on a shared base and extends it: `aa` is the pet base (`id`, `petSpecies`,
 * `name`, `xp`, `hunger`, `mutations`, `targetScale`, `abilities`), `Sa` adds the item discriminant, and the
 * two variants `Ca`/`wa` add the same three extras — required in one, optional in the other. The game uses
 * `Ca` in the item union, and a pet in a slot is the same record, so this library states the field list
 * **once** here: the slot carrier (`state/entities.ts`'s `Pet`) extends {@link PetFields} and the bag arm
 * (`PetItem`, built from `ItemFields.Pet`) is made of it, which is what stops the two readers drifting apart.
 *
 * §7 S2 of the plan this pass implements is the defect that shape prevents: the slot pet and the bag pet are
 * one schema, and before this they were two hand-written lists, one of which was empty.
 *
 * ## Why the extras are always present
 *
 * `wa` declares `sourceEggId`, `abilityCooldowns` and `equippedCosmetics` optional and `Ca` requires them;
 * both read as the empty value a save that states none means (`''`, `{}`, `{}`), never `undefined` and never
 * an optional property (`DESIGN.md` §5). The game's own pet literal does the same thing — it is the literal
 * `Ht` builds, and it appears again on the live pet:
 *
 *     {…, abilities: [], sourceEggId: Vt(e) ?? `CommonEgg`, abilityCooldowns: {}, equippedCosmetics: {}, …t}
 *
 * ## Where the two record extras' value types are stated
 *
 * `sourceEggId` is the egg enum `j`. The other two are records, and **no extracted table carries their
 * shape**, so the game's own declarations are the evidence and are quoted here in the style the model uses
 * for a bundle citation (`worldDepthSortKey-BXUHHrP0.js` at 1192, beside `aa`/`Ca`):
 *
 *     ia = l(_(), ra)                    abilityCooldowns: a string-keyed record of numbers
 *     ra = y(h(), r(0))
 *     oa = l(Di, ji)                     equippedCosmetics: a record keyed by cosmetic slot
 *     Di = g(Ei), Ei = [`hat`, `tie`]    the slot categories
 *     ji = g(Ai), Ai = Object.keys(ki)   the cosmetic ids, from the catalogue
 *     ki = {Ballcap: {slotCategory: `hat`, …}, …}
 *
 * That last line is why `equippedCosmetics` is a map and not a list: the pet-cosmetic modal reads it by slot
 * category, `equippedCosmetics[slotCategory]`, and the catalogue's own records say which category each
 * cosmetic fills. A `string[]` here would read `[]` for every pet that is wearing anything.
 */

import { toNumberRecord, toStringArray, toStringRecord } from '../coercions.js';
import type { Mutation } from '../entities.js';
import type { StateRecord } from '../reader.js';
import type { ItemOfKind, ItemOwnFields } from './base.js';

/**
 * The fields a pet has wherever it is carried — a pet slot, a bag, a hutch.
 *
 * Stated once for both carriers: `Pet` (the slot) extends this, and `PetItem` (the bag arm) is built from
 * it, so the two carriers cannot read different fields. Three of them — `species`, `name` and `mutations` —
 * are fields every kind spells the same way, so they live on {@link InventoryItemBase} and only the pet's
 * own seven are read by `readPet` (`ItemOwnFields<'Pet'>` is this list minus those three).
 */
export interface PetFields {
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
  readonly targetScale: number;
  readonly mutations: Mutation[];
  /** The ability ids this pet has, which is what a pet-team layout cares about. */
  readonly abilities: string[];
  /** The egg it hatched from, or `''` when the save states none (the game's optional `wa` variant). */
  readonly sourceEggId: string;
  /** Seconds left on each ability, keyed by ability id. `{}` when the save states none. */
  readonly abilityCooldowns: Readonly<Record<string, number>>;
  /** What the pet is wearing, keyed by the cosmetic slot it fills. `{}` when the save states none. */
  readonly equippedCosmetics: Readonly<Record<string, string>>;
}

/** A pet in a bag, a storage or a hutch: the pet's own fields, on the item base. */
export type PetItem = ItemOfKind<'Pet'>;

/**
 * A pet's **own** fields, read from the record the game sends for either carrier.
 *
 * Exactly `ItemOwnFields<'Pet'>` — the fields `aa`/`Ca` declare that the base has no home for. The three
 * `PetFields` names the base already carries (`species`, `name`, `mutations`) are deliberately **not** read
 * here: a reader that returned one would be read a second way, and the dispatch in `reader.ts` merges a
 * reader's fields *over* the base, so the base's own reading — including the `petSpecies || species`
 * fallback every kind shares — would be silently replaced. The declared return type is what keeps that
 * honest: an object literal with a base field on it is a compile error, not an override.
 */
export function readPet(record: StateRecord): ItemOwnFields<'Pet'> {
  return {
    xp: record.number('xp'),
    hunger: record.number('hunger'),
    targetScale: record.number('targetScale'),
    abilities: toStringArray(record.raw['abilities']),
    // The three extras `Ca` adds to `Sa`. A save that states none of them reads as the empty value, so a
    // caller never has to test whether the field is there.
    sourceEggId: record.string('sourceEggId'),
    abilityCooldowns: toNumberRecord(record.raw['abilityCooldowns']),
    equippedCosmetics: toStringRecord(record.raw['equippedCosmetics']),
  };
}
