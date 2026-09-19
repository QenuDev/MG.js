/**
 * A seed stack: the schema `va = d({ species, itemType, quantity })`.
 *
 * All three of its fields are base fields, so this kind declares nothing of its own and its reader has
 * nothing to read. The module still exists, and is still registered, because that is what makes a kind the
 * game adds next a file and a line rather than a re-design.
 */

import type { ItemOfKind, ItemOwnFields } from './base.js';

/** A seed stack. Its own fields — `species` and `quantity` — are on {@link InventoryItemBase}. */
export type SeedItem = ItemOfKind<'Seed'>;

/** The seed's own fields, which it has none of: everything `va` declares is on the base. */
export function readSeed(): ItemOwnFields<'Seed'> {
  return {};
}
