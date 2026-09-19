/**
 * The item union narrows on `itemType`, one arm per kind, with the empty arm last.
 *
 * ## Why this file exists
 *
 * `ac7bcb5` did this for tiles and stated the rule this pass reuses: a kind family is a discriminated union
 * on its discriminant, or it is not modelled yet (`docs/DESIGN.md` §5). An item union that merely *has* the
 * seven arms is worth little — the defect §0 reports was a field reachable only through the escape hatch,
 * which is exactly what a union nobody switches on looks like from the inside. So `InventoryItem` is derived
 * from one map (`ItemFields`) and the switch below is the test: one case per kind plus a last case for `''`,
 * each reading that arm's own fields with no cast. A kind added to the map is a compile error here rather
 * than an `undefined` in a consumer.
 *
 * The assertion is the compilation. The runtime call keeps the switch honest: every arm is driven through it
 * on a record read by the real reader, so a case that stopped being reachable fails here rather than
 * compiling — including the five arms whose own fields happen to be base fields, because their fields are
 * still read through the arm and not through a cast.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InventoryItem } from '../../../src/state/items/base.js';
import { ITEM_KINDS } from '../../../src/state/items/registry.js';
import { toInventoryItem } from '../../../src/state/reader.js';

/**
 * Every arm's own fields, read with no cast.
 *
 * The switch is exhaustive over the closed union, so a kind the map gains makes this function stop
 * returning — which is the point. `''` is the last case, as `OtherTile` is a tile's.
 */
function ownFieldsOf(item: InventoryItem): Record<string, unknown> {
  switch (item.itemType) {
    case 'Seed':
      return { species: item.species, quantity: item.quantity };
    case 'Produce':
      return { species: item.species, size: item.size, mutations: item.mutations };
    case 'Plant':
      return { plantedAt: item.plantedAt, maturedAt: item.maturedAt, crops: item.crops.length };
    case 'Tool':
      return {
        toolId: item.toolId,
        hasLife: item.hasLife,
        remainingActiveSeconds: item.remainingActiveSeconds,
      };
    case 'Pet':
      return {
        xp: item.xp,
        hunger: item.hunger,
        targetScale: item.targetScale,
        abilities: item.abilities,
        sourceEggId: item.sourceEggId,
        abilityCooldowns: item.abilityCooldowns,
        equippedCosmetics: item.equippedCosmetics,
      };
    case 'Egg':
      return { eggId: item.eggId, quantity: item.quantity };
    case 'Decor':
      return { decorId: item.decorId, quantity: item.quantity };
    case '':
      // The empty arm: the kind this release does not declare, whose own spelling stays in the record.
      return { stated: item.record.string('itemType') };
  }
}

void test('an arm narrows to its own fields, and the last case is the kind we do not declare', () => {
  // One record per kind, each read by the real reader, each asserted through the switch. The five kinds
  // whose own fields are base fields are here too: their arms read those fields off the reader's object
  // like every other arm, and a case that stopped producing values would fail rather than compile.
  const arms: readonly (readonly [Record<string, unknown>, Record<string, unknown>])[] = [
    [
      { itemType: 'Seed', species: 'Clover', quantity: 12 },
      { species: 'Clover', quantity: 12 },
    ],
    [
      { itemType: 'Produce', species: 'Tomato', size: 75, mutations: ['Gold'] },
      { species: 'Tomato', size: 75, mutations: ['Gold'] },
    ],
    [
      { itemType: 'Plant', species: 'Rose', plantedAt: 5, maturedAt: 9 },
      { plantedAt: 5, maturedAt: 9, crops: 0 },
    ],
    [
      { itemType: 'Tool', toolId: 'RainPotion', remainingActiveSeconds: 0 },
      { toolId: 'RainPotion', hasLife: true, remainingActiveSeconds: 0 },
    ],
    [
      {
        itemType: 'Pet',
        petSpecies: 'Fox',
        xp: 10,
        hunger: 50,
        targetScale: 1,
        abilities: ['DawnCoinFinder'],
      },
      {
        xp: 10,
        hunger: 50,
        targetScale: 1,
        abilities: ['DawnCoinFinder'],
        sourceEggId: '',
        abilityCooldowns: {},
        equippedCosmetics: {},
      },
    ],
    [
      { itemType: 'Egg', eggId: 'SnowEgg', quantity: 3 },
      { eggId: 'SnowEgg', quantity: 3 },
    ],
    [
      { itemType: 'Decor', decorId: 'Fence', quantity: 4 },
      { decorId: 'Fence', quantity: 4 },
    ],
  ];
  for (const [record, ownFields] of arms) {
    assert.deepEqual(ownFieldsOf(toInventoryItem(record, '/items/0')), ownFields);
  }

  // A kind none of the seven declares is the empty arm, and the spelling it used is still in the record.
  assert.deepEqual(ownFieldsOf(toInventoryItem({ itemType: 'Crystal' }, '/items/2')), {
    stated: 'Crystal',
  });

  // `ITEM_KINDS` is the runtime list a generic consumer walks, read off the registry's own keys. Pinned
  // here so a derivation that silently dropped a kind fails now rather than in a consumer's loop.
  assert.deepEqual([...ITEM_KINDS].sort(), ['Decor', 'Egg', 'Pet', 'Plant', 'Produce', 'Seed', 'Tool']);
});
