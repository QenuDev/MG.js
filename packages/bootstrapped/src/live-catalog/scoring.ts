/**
 * Scoring a captured table against a catalogue kind.
 *
 * Split out of `catalog/bundle.ts` (Phase 5 Task 5.7a). The whole heuristic is here: which field names hint
 * at which kind, which page object is the root to scan, and how a table is profiled. It is free of any page
 * or hook access, so the scoring can be reasoned about (and tested) without a live game.
 */

import type { CatalogKind } from '@mg.js/common';

/** Field names the recon recorded per category. Used only to *rank* candidates, never as a requirement. */
const FIELD_HINTS: Record<CatalogKind, readonly string[]> = {
  version: ['version', 'gameVersion', 'build'],
  plants: ['crop', 'seed', 'rarity', 'growthTime', 'sproutTime', 'baseSellPrice', 'tier'],
  pets: ['ability', 'rarity', 'hunger', 'cooldown', 'petType', 'coins'],
  eggs: ['hatchTime', 'rarity', 'petSpecies', 'hatch'],
  decors: ['rarity', 'size', 'tile', 'decoration'],
  mutations: ['multiplier', 'chance', 'weight', 'tier'],
  items: ['stackable', 'rarity', 'type', 'category', 'value'],
  abilities: ['cooldown', 'duration', 'effect', 'target'],
  enums: ['key', 'value', 'label', 'name'],
  shops: ['restock', 'price', 'currency', 'stock', 'quantity'],
  weather: ['weather', 'temperature', 'rain', 'sun'],
};

/** Is this a plain object (not an array, not null, not a function)? */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The extra (non-`id`) field names, and how many entries carry each. */
function profileEntries(entries: readonly unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  const sample = entries.slice(0, 24);
  for (const entry of sample) {
    if (!isPlainObject(entry)) continue;
    for (const key of Object.keys(entry)) {
      if (key === 'id') continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Score a table against a category's field hints.
 *
 * The score is the number of hinted fields that appear on at least a third of the sampled entries, a
 * *coverage* measure rather than a raw count, so one exotic entry cannot make a table look like a match and
 * a table with a handful of entries is not penalised for lacking the long tail.
 *
 * Structural validity is a precondition, not a score: a candidate with no `id` fields is rejected outright
 * rather than scored low, because the `id` is the one field the recon records on every category.
 */
export function scoreTableForKind(entries: readonly unknown[], kind: CatalogKind): number | null {
  if (entries.length === 0) return null;
  const sample = entries.slice(0, 24);
  let withId = 0;
  for (const entry of sample) {
    if (!isPlainObject(entry)) continue;
    if (typeof entry['id'] === 'string' && entry['id'] !== '') withId += 1;
  }
  // Every sampled entry must carry a non-empty string id. Partially-id'd tables are not catalogues.
  if (withId !== sample.length) return null;

  const profile = profileEntries(sample);
  const threshold = Math.max(1, Math.floor(sample.length / 3));
  let score = 0;
  for (const hint of FIELD_HINTS[kind]) {
    if ((profile.get(hint) ?? 0) >= threshold) score += 1;
  }
  return score;
}

/**
 * Turn a value into a candidate entry list.
 *
 * Two shapes, both observed in the wild: a plain array of entities, and a record keyed by id whose values
 * are entities. The second is the shape the companion mod's extractors produce, so `@mg.js/common`
 * ships `normalizeEntityMap` to reconcile them. This function does the same job locally because it must
 * decide *whether* the shape is a catalogue at all before anything normalises it.
 */
export function asEntryList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every((entry) => isPlainObject(entry)) ? value : null;
  }
  if (!isPlainObject(value)) return null;
  const values = Object.values(value);
  if (values.length === 0) return null;
  if (!values.every((entry) => isPlainObject(entry))) return null;
  return values;
}
