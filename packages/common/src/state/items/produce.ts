/**
 * Produce: the schema `ld = u({ id, species, itemType, size, mutations, carving, carvingVerdict })`.
 *
 * The first six fields are on {@link InventoryItemBase} or the shared crop reading; the two carving fields
 * arrived with the 1650 build, when a harvested pumpkin kept the carving it was given. Both are optional on
 * the wire, so an absent one reads as `null` rather than as an empty string that a caller would have to
 * tell apart from a real (if invalid) carving.
 */

import type { StateRecord } from '../reader.js';
import type { ItemOfKind, ItemOwnFields } from './base.js';

/** A produce stack. Its own fields — `species`, `size` and `mutations` — are on {@link InventoryItemBase}. */
export type ProduceItem = ItemOfKind<'Produce'>;

/** The produce's own fields: the two the crop schema shares with a harvested crop. */
export function readProduce(record: StateRecord): ItemOwnFields<'Produce'> {
  const carving = record.string('carving');
  const verdict = record.read('carvingVerdict');
  return {
    carving: carving === '' ? null : carving,
    carvingVerdict: verdict === 'approved' || verdict === 'hidden' ? verdict : null,
  };
}
