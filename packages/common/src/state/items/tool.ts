/**
 * A tool: the union `ya = f([ … ])` of the game's own two tool variants.
 *
 *     ya#0  { toolId, itemType, quantity }
 *     ya#1  { id, toolId, itemType, quantity, remainingActiveSeconds }
 *
 * The two collapse to one arm because every field either variant declares is a base field: what separates
 * them is a reading the base already makes — {@link InventoryItemBase.hasLife} is true exactly when the save
 * states a `remainingActiveSeconds`, and a spent tool states a zero rather than omitting the field. So this
 * kind declares nothing of its own, and its reader has nothing to read.
 */

import type { ItemOfKind, ItemOwnFields } from './base.js';

/** A tool. Its own fields — `toolId`, `quantity`, `remainingActiveSeconds`, `hasLife` — are base fields. */
export type ToolItem = ItemOfKind<'Tool'>;

/** The tool's own fields, which it has none of: both `ya` variants are read by the base's own fields. */
export function readTool(): ItemOwnFields<'Tool'> {
  return {};
}
