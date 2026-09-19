/**
 * The value coercions the state reader and the per-kind item readers share.
 *
 * ## Why this module exists
 *
 * A field the game declares can arrive absent, `null`, or as the wrong shape, and every reader in this
 * package has to turn that into the empty value its type promises rather than into `undefined`
 * (`DESIGN.md` §5). The item readers (`state/items/*.ts`) need the same coercions `reader.ts` uses, and
 * `reader.ts` is the module that dispatches into them: a kind reader importing a value from `reader.ts`
 * would make `reader -> items/registry -> items/pet -> reader` a cycle. So the coercions live here —
 * one home — and both sides import it. It is deliberately not re-exported by any barrel, because it is
 * not public surface.
 */

import type { Mutation } from './entities.js';

/** A mutation list, keeping only strings, which is all the game sends. */
export function toMutations(value: unknown): Mutation[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Mutation => typeof entry === 'string');
}

/** The string entries of an array field. `[]` when the field is absent or is not an array. */
export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * A `{ name: number }` field, keeping only finite numbers — the pet's `abilityCooldowns`.
 *
 * `{}` when the field is absent or is not a plain object, so a caller reads a map either way. An array is
 * not a map here even though it is an object, which is the case that would otherwise read as `{ 0: … }`.
 */
export function toNumberRecord(value: unknown): Readonly<Record<string, number>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry;
  }
  return out;
}

/**
 * A `{ slot: id }` field, keeping only string values — the pet's `equippedCosmetics`.
 *
 * A map and never an array: `state/items/pet.ts` quotes the game's own `oa = l(Di, ji)` declaration and the
 * empty pet literal (`equippedCosmetics: {}`) that say so, and the pet-cosmetic modal reads the field by
 * slot category (`equippedCosmetics[t]`).
 */
export function toStringRecord(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}
