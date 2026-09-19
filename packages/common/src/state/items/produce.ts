/**
 * Produce: the schema `_a = d({ id, species, itemType, size, mutations })`.
 *
 * All four of its fields are base fields, so this kind declares nothing of its own and its reader has
 * nothing to read. The module still exists, and is still registered, because that is what makes a kind the
 * game adds next a file and a line rather than a re-design.
 */

import type { ItemOfKind, ItemOwnFields } from './base.js';

/** A produce stack. Its own fields — `species`, `size` and `mutations` — are on {@link InventoryItemBase}. */
export type ProduceItem = ItemOfKind<'Produce'>;

/** The produce's own fields, which it has none of: everything `_a` declares is on the base. */
export function readProduce(): ItemOwnFields<'Produce'> {
  return {};
}
