/**
 * A pet is one schema wherever it is carried, and the bag arm reads all of it.
 *
 * ## Why this file exists
 *
 * §0 of the plan this pass implements: a viewer drew a level-80 pet as "Strength 50/80, Weight 0.00,
 * Hunger 0%" because `xp`, `hunger`, `targetScale` and `abilities` had no typed home on the bag pet and
 * were reachable only through the escape hatch. The fix is not one assertion — it is that the arm carries
 * the fields at all, so this file asserts the values *and* the two type-level witnesses that keep the two
 * carriers from drifting apart again (§7 S2): the slot `Pet` and the bag `PetItem` both carry `PetFields`,
 * which is stated once.
 *
 * The extras a save may not state (`sourceEggId`, `abilityCooldowns`, `equippedCosmetics`) are asserted
 * present with an empty value rather than `undefined`, because `DESIGN.md` §5 forbids leaking `undefined`
 * where a field was not supplied.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pet } from '../../../src/state/entities.js';
import type { InventoryItem } from '../../../src/state/items/base.js';
import { type PetFields, type PetItem, readPet } from '../../../src/state/items/pet.js';
import { StateRecord, toInventoryItem, toPet } from '../../../src/state/reader.js';

/**
 * One list, both carriers: these two assignments are the assertion, in the direction that matters.
 *
 * They prove `Pet ⊆ PetFields` and `PetItem ⊆ PetFields`: every field the shared list states is on both
 * carriers, so **adding** a field to `PetFields` is a compile error until the slot carrier and the bag arm
 * both have it. That is the drift §7 S2 exists to stop. They do not prove the converse — a carrier may
 * legitimately carry its own extra (the slot's `record`, the arm's `itemType`, its address) — and they say
 * nothing about *values*: that the two carriers read those fields the same way is what the comparison at
 * the end of this file asserts. `void` keeps them live under `noUnusedLocals`.
 */
const slotPetCarriesEveryPetField = (pet: Pet): PetFields => pet;
const bagPetCarriesEveryPetField = (pet: PetItem): PetFields => pet;
void slotPetCarriesEveryPetField;
void bagPetCarriesEveryPetField;

/** The pet arm, or `null`. The compiler narrows here, so no assertion in this file needs a cast. */
function petArmOf(item: InventoryItem): PetItem | null {
  return item.itemType === 'Pet' ? item : null;
}

/** The game's own pet record, spelled the way the bundle's `aa`/`Ca` schemas spell it. */
const REAL_PET = {
  id: 'pet_1',
  petSpecies: 'SnowFox',
  name: 'Frost',
  xp: 1483200,
  hunger: 185,
  mutations: ['Rainbow'],
  targetScale: 1.03125,
  abilities: ['DawnCoinFinder', 'RainbowGranter', 'DawnbinderBoost'],
  sourceEggId: 'SnowEgg',
  abilityCooldowns: { DawnCoinFinder: 30 },
  equippedCosmetics: { hat: 'Ballcap' },
};

void test('a bag pet reads its own fields, which no typed home carried before this', () => {
  const pet = petArmOf(toInventoryItem({ itemType: 'Pet', ...REAL_PET }, '/items/0'));
  assert.ok(pet !== null, 'the record states its kind');

  assert.equal(pet.species, 'SnowFox', 'the wire spells it petSpecies');
  assert.equal(pet.name, 'Frost');
  assert.equal(pet.xp, 1_483_200);
  assert.equal(pet.hunger, 185);
  assert.equal(pet.targetScale, 1.03125);
  assert.deepEqual(pet.mutations, ['Rainbow']);
  assert.deepEqual(pet.abilities, ['DawnCoinFinder', 'RainbowGranter', 'DawnbinderBoost']);
  assert.equal(pet.sourceEggId, 'SnowEgg');
  assert.deepEqual(pet.abilityCooldowns, { DawnCoinFinder: 30 });
  assert.deepEqual(pet.equippedCosmetics, { hat: 'Ballcap' });
});

void test('the extras a save does not state read as their empty value, never undefined', () => {
  const pet = petArmOf(toInventoryItem({ itemType: 'Pet', petSpecies: 'Fox' }, '/items/0'));
  assert.ok(pet !== null);

  // `Ca` requires the three and `wa` declares them optional; both read as the empty value rather than as a
  // hole, which is the shape a caller can hand on to a card without a guard.
  assert.equal(pet.sourceEggId, '');
  assert.deepEqual(pet.abilityCooldowns, {});
  assert.deepEqual(pet.equippedCosmetics, {});
  assert.equal(Object.hasOwn(pet, 'abilityCooldowns'), true);
  assert.equal(Object.hasOwn(pet, 'equippedCosmetics'), true);
});

void test('the slot carrier and the bag arm read one pet schema, field for field', () => {
  const slot = toPet(REAL_PET, '/petSlots/0');
  const bag = petArmOf(toInventoryItem({ itemType: 'Pet', ...REAL_PET }, '/items/0'));
  assert.ok(slot !== null);
  assert.ok(bag !== null);

  for (const field of [
    'species',
    'name',
    'xp',
    'hunger',
    'targetScale',
    'mutations',
    'abilities',
    'sourceEggId',
    'abilityCooldowns',
    'equippedCosmetics',
  ] as const) {
    assert.deepEqual(bag[field], slot[field], `${field} reads the same on both carriers`);
  }

  // What each carrier adds on its own is its address, not a schema field.
  assert.equal(slot.entityPath, '/petSlots/0');
  assert.equal(bag.entityPath, '/items/0');
});

void test('the pet reader owns only the pet’s own fields, so no base reading is overridden', () => {
  // `readPet` reads the seven fields the base has no home for and nothing else. A record whose species is
  // spelled the way every other kind spells it is the case that tells the two apart: the bag arm's `species`
  // is the base's `petSpecies || species` reading, and a reader that also returned `species` would replace
  // it with `''` here. The comparison above cannot see that — with `petSpecies` set, both carriers would be
  // returning the same overridden value.
  const synthetic = toInventoryItem({ itemType: 'Pet', species: 'Fox', xp: 3 }, '/items/0');
  const bag = petArmOf(synthetic);
  assert.ok(bag !== null);
  assert.equal(bag.species, 'Fox', 'the base’s own species reading survives the merge');
  assert.equal(bag.name, '');
  assert.deepEqual(bag.mutations, []);

  // And the contract in one line: exactly the seven, so a base-owned field on the reader is a test failure
  // as well as the compile error `ItemOwnFields<'Pet'>` gives it.
  assert.deepEqual(Object.keys(readPet(new StateRecord(REAL_PET))).sort(), [
    'abilities',
    'abilityCooldowns',
    'equippedCosmetics',
    'hunger',
    'sourceEggId',
    'targetScale',
    'xp',
  ]);
});
