/**
 * The one place an item kind is registered.
 *
 * ## Why a registry rather than a switch
 *
 * A switch on `itemType` in the reader would narrow just as well, but it would not give a consumer the
 * runtime list of kinds (a dump, a count, a catalogue join), and it would leave "every kind has a reader"
 * as something a reader of the switch has to verify by eye. Here it is one `satisfies`: a kind this release
 * declares but does not register fails to compile, and a reader for a kind it does not declare fails too.
 *
 * Each entry is typed by its own key (`KindReader<K>`, not `KindReader<ItemKind>`), so a kind's reader is
 * also held to that kind's own fields rather than to the union of them.
 */

import type { StateRecord } from '../reader.js';
import type { ItemKind, ItemOwnFields } from './base.js';
import { readDecor } from './decor.js';
import { readEgg } from './egg.js';
import { readPet } from './pet.js';
import { readPlant } from './plant.js';
import { readProduce } from './produce.js';
import { readSeed } from './seed.js';
import { readTool } from './tool.js';

/**
 * Read one kind's own fields off the entry's record.
 *
 * "Own" is exact: the fields that kind's schema declares and {@link InventoryItemBase} does not already
 * carry, so merging the result over the base reconstructs the arm with no field read twice.
 */
export type KindReader<K extends ItemKind> = (record: StateRecord) => ItemOwnFields<K>;

/** The kinds, in the library's own order — the same order `ItemKind`'s literals are listed in. */
export const ITEM_READERS = {
  Seed: readSeed,
  Produce: readProduce,
  Plant: readPlant,
  Tool: readTool,
  Pet: readPet,
  Egg: readEgg,
  Decor: readDecor,
} satisfies { readonly [K in ItemKind]: KindReader<K> };

/**
 * True when a save's own `itemType` spelling is a kind this release declares.
 *
 * The registry's keys are exactly the kinds — the `satisfies` above is what proves that — so this is how a
 * caller reads the kind off a record without a cast. Not re-exported by the items barrel: it is the
 * dispatcher's guard, not a consumer's API.
 */
export function isItemKind(value: string): value is ItemKind {
  return Object.hasOwn(ITEM_READERS, value);
}

/**
 * The kinds, for a consumer that walks them generically (a dump, a count, a catalogue join).
 *
 * Read off the registry's own keys rather than written out again, filtered through {@link isItemKind} so
 * the list is typed without a cast: `Object.keys` widens to `string[]`, and the membership test is what
 * puts the literals back.
 */
export const ITEM_KINDS: readonly ItemKind[] = Object.keys(ITEM_READERS).filter(isItemKind);
