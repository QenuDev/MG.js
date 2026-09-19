/**
 * An egg stack: the schema `xa = d({ eggId, itemType, quantity })`.
 *
 * All three of its fields are base fields, so this kind declares nothing of its own and its reader has
 * nothing to read. The module still exists, and is still registered, because that is what makes a kind the
 * game adds next a file and a line rather than a re-design.
 */

import type { ItemOfKind, ItemOwnFields } from './base.js';

/** An egg stack. Its own fields — `eggId` and `quantity` — are on {@link InventoryItemBase}. */
export type EggItem = ItemOfKind<'Egg'>;

/** The egg's own fields, which it has none of: everything `xa` declares is on the base. */
export function readEgg(): ItemOwnFields<'Egg'> {
  return {};
}
