/**
 * A plant item: the schema `ba = d({ id, species, itemType, slots, plantedAt, maturedAt })`.
 *
 * `slots` is the one reading the base already carries under its own name for a plant: {@link InventoryItemBase.crops},
 * read with the crop reader. The two times are the plant's own, so `readPlant` is the whole of its reader.
 */

import type { StateRecord } from '../reader.js';
import type { ItemOfKind } from './base.js';

/** A potted plant: its `species`, `id` and `crops` are base fields, and the two times are its own. */
export type PlantItem = ItemOfKind<'Plant'>;

/** The plant's own fields. `slots` is the base's `crops`, so it is read there rather than here. */
export function readPlant(record: StateRecord): Pick<PlantItem, 'plantedAt' | 'maturedAt'> {
  return {
    plantedAt: record.number('plantedAt'),
    maturedAt: record.number('maturedAt'),
  };
}
