/**
 * A decoration stack: the schema `d({ decorId, itemType, quantity })` — the seventh arm of the game's union.
 *
 * All three of its fields are base fields, so this kind declares nothing of its own and its reader has
 * nothing to read. The module still exists, and is still registered, because that is what makes a kind the
 * game adds next a file and a line rather than a re-design.
 */

import type { ItemOfKind, ItemOwnFields } from './base.js';

/** A decoration stack. Its own fields — `decorId` and `quantity` — are on {@link InventoryItemBase}. */
export type DecorItem = ItemOfKind<'Decor'>;

/** The decoration's own fields, which it has none of: everything the decor arm declares is on the base. */
export function readDecor(): ItemOwnFields<'Decor'> {
  return {};
}
