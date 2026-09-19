/**
 * The item schemas: the union, one arm per kind, and the registry that reads them.
 *
 * The types are the public face of this folder; the readers themselves are not re-exported, because
 * `ITEM_READERS` already hands a consumer the one for a kind it names and `toInventoryItem` is the reader
 * an item is reached through. A reader exported on its own would be a second route to the same object.
 */

export type {
  InventoryItem,
  InventoryItemBase,
  ItemFields,
  ItemKind,
  ItemOfKind,
  ItemOwnFields,
  OtherItem,
} from './base.js';
export type { DecorItem } from './decor.js';
export type { EggItem } from './egg.js';
export type { PetFields, PetItem } from './pet.js';
export type { PlantItem } from './plant.js';
export type { ProduceItem } from './produce.js';
export type { KindReader } from './registry.js';
export { ITEM_KINDS, ITEM_READERS } from './registry.js';
export type { SeedItem } from './seed.js';
export type { ToolItem } from './tool.js';
