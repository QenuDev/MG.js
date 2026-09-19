/**
 * Where a pet is: the game's own walk over its three carriers, with the live values winning.
 *
 * ## Why this file exists
 *
 * §7 S1 of the plan this pass implements: a pet lives in a pet slot, in the bag, or in a storage, and a
 * consumer that types the bag arm and reads `xp` has the **save's** copy, which for a pet that is out in a
 * slot is not the live one. The game itself does both halves: `bo` walks the three carriers
 * (`worldDepthSortKey-BXUHHrP0.js` ~645890, quoted in `state/pets.ts`), and the seat system **overlays** a
 * bag pet with the pet-slot progress record, keyed by id, before showing it
 * (`installSeatSystems-B2ZqVPv6.js` ~340426). A consumer had to hand-roll both; `petsOf`/`petById` are
 * where the game has them.
 *
 * ## The two copies of `pet_live` are built to disagree
 *
 * That pet is in a slot and in the bag, and the copies state **different** numbers for every one of the six
 * fields the game overlays. A fixture whose copies agree cannot show which one won, which is exactly the
 * §1.1 failure mode this plan is about ("the fixture kept the fields, the test agreed with the model"). So
 * the slot record says `xp: 40, hunger: 10` and the bag item says `xp: 3, hunger: 99`: an implementation
 * that returned the bag item passes every assertion about *shape* and fails these about *value*.
 *
 * They also disagree on `species` (`SnowFox` live, `Fox` saved) precisely because it is **not** in the
 * game's overlay list — it is taken from the carrier being read, so the test can tell that apart from the
 * six fields that come from the slot. The other fixtures cover the remaining shapes: a pet in the bag only,
 * a pet in a storage only, a pet in a slot only, and two carriers that state no id.
 *
 * ## Built through the real readers
 *
 * The carriers are the package's own readings of the game's records (`toInventory` for the inventory and its
 * storages, `toPet` for the slots), so no field is transcribed a second way: a rename in a future build
 * shows up here as a failed assertion rather than as an `undefined`. What the file does state by hand is the
 * exact key set a joined pet carries, which is the contract the join owes a consumer and is not a copy of
 * any schema.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Inventory, Pet, Player } from '../../src/state/entities.js';
import type { InventoryItem, PetItem } from '../../src/state/items/index.js';
import { petById, petsOf } from '../../src/state/pets.js';
import { asRecord, toInventory, toPet } from '../../src/state/reader.js';

const SLOT_INDEX = 0;
const SLOT_DATA = `/child/data/userSlots/${SLOT_INDEX}/data`;

/** The pet whose slot record and bag item both exist and disagree. */
const LIVE_IN_SLOT = 'pet_live';

/** A bag pet whose id no slot record names: it is itself. */
const ONLY_IN_BAG = 'pet_bag_only';

/** A storage pet whose id no slot record names: it is itself. */
const ONLY_IN_STORAGE = 'pet_hutch_only';

/** A pet that is in a slot and nowhere else, so the slot branch is the only branch. */
const ONLY_IN_SLOT = 'pet_slot_only';

/**
 * The live pet-slot record, quoted in the game's own spellings.
 *
 * Its values are the ones a consumer showing a card wants, and they are deliberately the six the game's
 * overlay takes from here: `hunger`, `xp`, `targetScale`, `name`, `mutations`, `abilityCooldowns`.
 */
const LIVE_SLOT_RECORD = {
  id: LIVE_IN_SLOT,
  petSpecies: 'SnowFox',
  name: 'Frost',
  xp: 40,
  hunger: 10,
  mutations: ['Rainbow'],
  targetScale: 1.25,
  abilities: ['DawnCoinFinder'],
  sourceEggId: 'SnowEgg',
  abilityCooldowns: { DawnCoinFinder: 30 },
  equippedCosmetics: { hat: 'Ballcap' },
};

/**
 * The slot-only pet, whose values are its own: nothing else in the fixture states this id.
 *
 * It is the primary carrier — the whole reason this module exists is that its record is the live one — so
 * the tests assert its address and every value rather than only its presence.
 */
const ONLY_SLOT_RECORD = {
  id: ONLY_IN_SLOT,
  petSpecies: 'Cat',
  name: 'Mittens II',
  xp: 900,
  hunger: 5,
  mutations: ['Wet'],
  targetScale: 2,
  abilities: ['NineLives'],
  sourceEggId: 'CatEgg',
  abilityCooldowns: { NineLives: 45 },
  equippedCosmetics: { hat: 'PartyHat' },
};

/**
 * Two carriers that state no id: a pet that has just hatched has none yet.
 *
 * They are two pets, not one pet in two places, so the walk must report both. Collapsing them by id — the
 * empty string — would be this function dropping a pet.
 */
const IDLESS_BAG_ITEM = { itemType: 'Pet', petSpecies: 'Fox', name: 'Hatchling', xp: 1, hunger: 80 };
const IDLESS_STORAGE_ITEM = { itemType: 'Pet', petSpecies: 'Cat', name: 'Newborn', xp: 2, hunger: 90 };

/**
 * The save's own inventory, quoted in the game's own spellings.
 *
 * `pet_live`'s bag copy disagrees with the slot record on every overlaid field **and** on `species`, which
 * is not overlaid. `abilities`, `sourceEggId` and `equippedCosmetics` are not overlaid either, so the bag
 * copy's values are the ones a join must keep — that is what tells "the six fields" apart from "the whole
 * slot record".
 */
const SAVED_INVENTORY = {
  items: [
    { itemType: 'Egg', eggId: 'SnowEgg', quantity: 3 },
    {
      itemType: 'Pet',
      id: LIVE_IN_SLOT,
      petSpecies: 'Fox',
      name: 'Saved Frost',
      xp: 3,
      hunger: 99,
      mutations: ['Gold'],
      targetScale: 0.5,
      abilities: ['SnowyCoinFinder'],
      sourceEggId: 'FoxEgg',
      abilityCooldowns: { SnowyCoinFinder: 999 },
      equippedCosmetics: { tie: 'Bowtie' },
    },
    {
      itemType: 'Pet',
      id: ONLY_IN_BAG,
      petSpecies: 'Fox',
      name: 'Rusty',
      xp: 7,
      hunger: 55,
      mutations: [],
      targetScale: 1,
      abilities: [],
    },
    IDLESS_BAG_ITEM,
  ],
  storages: [
    {
      decorId: 'SeedSilo',
      capacitySlots: 200,
      items: [{ itemType: 'Seed', species: 'Pumpkin', quantity: 3 }],
    },
    {
      decorId: 'PetHutch',
      capacitySlots: 6,
      items: [
        {
          itemType: 'Pet',
          id: ONLY_IN_STORAGE,
          petSpecies: 'Cat',
          name: 'Mittens',
          xp: 12,
          hunger: 60,
          mutations: [],
          targetScale: 1,
          abilities: [],
        },
        IDLESS_STORAGE_ITEM,
      ],
    },
  ],
};

/**
 * One pet slot, read the way `StateReader.toPlayer` reads one.
 *
 * A record with a species *is* a pet, so the `null` branch is the fixture's own invariant failing rather
 * than a case under test.
 */
function slotPet(record: unknown, index: number): Pet {
  const pet = toPet(record, `${SLOT_DATA}/petSlots/${index}`);
  assert.ok(pet !== null, `slot record ${index} states a species, so it is a pet`);
  return pet;
}

/** The list `player.pets` carries: the two pets the game has out, in slot order. */
function slotPets(): Pet[] {
  return [slotPet(LIVE_SLOT_RECORD, 0), slotPet(ONLY_SLOT_RECORD, 1)];
}

/** The save's inventory, read through the package's own readers. */
function savedInventory(): Inventory {
  return toInventory(SAVED_INVENTORY, `${SLOT_DATA}/inventory`);
}

/**
 * A player view carrying all three carriers.
 *
 * The pets are the slot views the reader itself would return, and the inventory and storages are the ones
 * `toInventory` returns, so the only thing this test constructs is the player's own wrapper — the join under
 * test reads the carriers a real `toPlayer` would have handed it.
 */
function fixturePlayer(pets: readonly Pet[] = slotPets()): Player {
  return {
    entityPath: '/data/players/0',
    id: 'p_1',
    name: 'Ada',
    coinsCount: 0,
    magicDustCount: 0,
    inventory: savedInventory(),
    garden: null,
    pets: [...pets],
    activityLog: [],
    record: pets[0]?.record ?? asRecord({}),
  };
}

/** The bag arm of an item, or `null`. The compiler narrows here, so no assertion below needs a cast. */
function petArmOf(item: InventoryItem): PetItem | null {
  return item.itemType === 'Pet' ? item : null;
}

/** A bag item with a stated id, found by id so the index into the save's array is not this test's opinion. */
function bagItemWithId(inventory: Inventory, id: string): InventoryItem {
  const item = inventory.items.find((candidate) => candidate.record.string('id') === id);
  assert.ok(item !== undefined, `the fixture holds a bag item with id ${id}`);
  return item;
}

void test('a pet that is only in a slot is itself: the slot branch, read from petSlots', () => {
  const player = fixturePlayer();
  const joined = petById(player, ONLY_IN_SLOT);
  assert.ok(joined !== null, 'the primary carrier is reachable');

  // The slot record is already the live one, so the join has nothing to overlay: every value is the slot's
  // own, and the address is the slot's. This is the branch a consumer showing a card for a pet that is out
  // takes, and nothing else in this file asserts it.
  assert.equal(joined.entityPath, `${SLOT_DATA}/petSlots/1`);
  assert.equal(joined.species, 'Cat');
  assert.equal(joined.name, 'Mittens II');
  assert.equal(joined.xp, 900);
  assert.equal(joined.hunger, 5);
  assert.equal(joined.targetScale, 2);
  assert.deepEqual(joined.mutations, ['Wet']);
  assert.deepEqual(joined.abilities, ['NineLives']);
  assert.equal(joined.sourceEggId, 'CatEgg');
  assert.deepEqual(joined.abilityCooldowns, { NineLives: 45 });
  assert.deepEqual(joined.equippedCosmetics, { hat: 'PartyHat' });

  // And the walk reaches it first, in slot order, before any bag or storage entry.
  assert.equal(petsOf(player)[1]?.id, ONLY_IN_SLOT);
});

void test('two carriers that state no id are two pets, not one collapsed entry', () => {
  const player = fixturePlayer();
  const unnamed = petsOf(player).filter((pet) => pet.id === '');

  // An empty id names no pet to join on, so these are two carriers of two pets: collapsing them by id
  // would silently drop one of them.
  assert.deepEqual(
    unnamed.map((pet) => pet.name),
    ['Hatchling', 'Newborn'],
    'each id-less carrier stands alone, in walk order',
  );
  assert.equal(unnamed[0]?.entityPath, `${SLOT_DATA}/inventory/items/3`);
  assert.equal(unnamed[1]?.entityPath, `${SLOT_DATA}/inventory/storages/1/items/1`);

  // An empty id names nothing, so the by-id lookup answers `null` rather than picking one of them.
  assert.equal(petById(player, ''), null);

  // They come after the named entries rather than in their walk position: `petsOf` keeps the named walk in
  // one map and these beside it. The ids below are the assertion that this is the only ordering difference.
  assert.deepEqual(
    petsOf(player).map((pet) => pet.id),
    [LIVE_IN_SLOT, ONLY_IN_SLOT, ONLY_IN_BAG, ONLY_IN_STORAGE, '', ''],
  );
});

void test('a bag pet with no slot record is itself, and the join does not change its reading', () => {
  const player = fixturePlayer();
  const bagArm = petArmOf(bagItemWithId(player.inventory, ONLY_IN_BAG));
  assert.ok(bagArm !== null, 'the fixture’s bag pet is the pet arm');

  const joined = petById(player, ONLY_IN_BAG);
  assert.ok(joined !== null, 'a pet in the bag is one of the player’s pets');

  // Every field a pet has, with the bag item's own readings: no slot record names this id, so there is
  // nothing to overlay.
  assert.deepEqual(joined, {
    entityPath: bagArm.entityPath,
    id: bagArm.id,
    species: bagArm.species,
    name: bagArm.name,
    hunger: bagArm.hunger,
    xp: bagArm.xp,
    targetScale: bagArm.targetScale,
    mutations: bagArm.mutations,
    abilityCooldowns: bagArm.abilityCooldowns,
    abilities: bagArm.abilities,
    sourceEggId: bagArm.sourceEggId,
    equippedCosmetics: bagArm.equippedCosmetics,
    record: bagArm.record,
  });
});

void test('the live slot record wins the six fields the game overlays, and only those', () => {
  const player = fixturePlayer();
  const joined = petById(player, LIVE_IN_SLOT);
  assert.ok(joined !== null);

  // The six `installSeatSystems` overlays, quoted in `state/pets.ts`. The saved copies are all different,
  // so each assertion names which record won rather than agreeing with a value both carry.
  assert.equal(joined.xp, 40, 'the live xp, not the save’s 3');
  assert.equal(joined.hunger, 10, 'the live hunger, not the save’s 99');
  assert.equal(joined.targetScale, 1.25, 'the live scale, not the save’s 0.5');
  assert.equal(joined.name, 'Frost', 'the slot’s name when it has one');
  assert.deepEqual(joined.mutations, ['Rainbow'], 'the live mutations, not the save’s Gold');
  assert.deepEqual(joined.abilityCooldowns, { DawnCoinFinder: 30 }, 'the live cooldowns, not the save’s 999');

  // Not overlaid, so they are the carrier's own reading: a pet whose save states an ability or a cosmetic
  // the slot record has not caught up with keeps it. `species` is here for the same reason, and it is the
  // sharpest of the four, because the two copies disagree (`SnowFox` live, `Fox` saved).
  assert.equal(joined.species, 'Fox', 'the carrier’s own species reading, which is not overlaid');
  assert.deepEqual(joined.abilities, ['SnowyCoinFinder'], 'abilities are not overlaid');
  assert.equal(joined.sourceEggId, 'FoxEgg', 'the egg is not overlaid');
  assert.deepEqual(joined.equippedCosmetics, { tie: 'Bowtie' }, 'cosmetics are not overlaid');
});

void test('a joined pet is the pet’s own shape, not the bag arm’s', () => {
  const player = fixturePlayer();
  const joined = petById(player, LIVE_IN_SLOT);
  assert.ok(joined !== null);

  // The address and the carrier-owned fields are the bag's, because the bag is the last carrier the walk
  // reaches for this id — not because the pet "is" in the bag. The game's `bo` yields both carriers and does
  // not say which owns the pet; only the six live fields are resolved, and they come from the slot record.
  // A join that took the slot's address would be asserting an ownership the game does not state.
  assert.equal(joined.entityPath, `${SLOT_DATA}/inventory/items/1`);

  // Exactly `Pet`'s fields: the bag arm's `itemType` is a discriminant of the item union, so a joined pet
  // that carried it would be an item arm wearing the pet pointer's name.
  assert.deepEqual(Object.keys(joined).sort(), [
    'abilities',
    'abilityCooldowns',
    'entityPath',
    'equippedCosmetics',
    'hunger',
    'id',
    'mutations',
    'name',
    'record',
    'sourceEggId',
    'species',
    'targetScale',
    'xp',
  ]);
  assert.equal(Object.hasOwn(joined, 'itemType'), false, 'the join is a pet, not an item arm');
});

void test('the game’s name rule: the slot’s name when it has one, the item’s name otherwise', () => {
  const unnamed = toPet({ ...LIVE_SLOT_RECORD, name: '' }, `${SLOT_DATA}/petSlots/0`);
  assert.ok(unnamed !== null);
  const player = fixturePlayer([unnamed]);

  const joined = petById(player, LIVE_IN_SLOT);
  assert.ok(joined !== null);
  assert.equal(joined.name, 'Saved Frost', 'the item’s name stands in for a slot record that names none');
});

void test('petsOf walks the three carriers in the game’s own order', () => {
  const ids = petsOf(fixturePlayer()).map((pet) => pet.id);

  // `bo` yields the slots, then the bag, then each storage, and the named entries keep that order. The two
  // id-less carriers are the exception and come last, which the id-less test states as its own assertion.
  assert.deepEqual(ids, [LIVE_IN_SLOT, ONLY_IN_SLOT, ONLY_IN_BAG, ONLY_IN_STORAGE, '', '']);
});

void test('a pet two carriers state is one entry, addressed by the last carrier the walk reached', () => {
  // A save can hold one pet id in the bag *and* in a hutch — the same id under two carriers is what makes
  // the collapse load-bearing. Without it a caller doing `petsOf(player).find(...)` could land on the first
  // entry for that id, which is not necessarily the one the join's later carrier pass produced.
  const doubled = {
    ...SAVED_INVENTORY,
    items: [
      ...SAVED_INVENTORY.items,
      { itemType: 'Pet', id: ONLY_IN_STORAGE, petSpecies: 'Cat', name: 'Saved Mittens', xp: 1, hunger: 1 },
    ],
  };
  const player: Player = {
    ...fixturePlayer(),
    inventory: toInventory(doubled, `${SLOT_DATA}/inventory`),
  };

  const ids = petsOf(player).map((pet) => pet.id);
  assert.deepEqual(
    ids,
    [LIVE_IN_SLOT, ONLY_IN_SLOT, ONLY_IN_BAG, ONLY_IN_STORAGE, '', ''],
    'the named id is named once',
  );

  // The bag copy comes first in the walk and the hutch's later, so the later carrier is the one the entry is
  // addressed to. That is the rule, not a claim about where the pet is.
  const pet = petById(player, ONLY_IN_STORAGE);
  assert.ok(pet !== null);
  assert.equal(pet.entityPath, `${SLOT_DATA}/inventory/storages/1/items/0`);
  assert.equal(pet.name, 'Mittens', 'the last carrier’s own name, which is not overlaid');
});

void test('the live pet is the same one entry petById and petsOf answer with', () => {
  const player = fixturePlayer();
  const joined = petById(player, LIVE_IN_SLOT);
  assert.ok(joined !== null);

  // Both `petsOf` and `petById` build the joined value with the same reader and the same slot record, so the
  // two objects are equal field for field — including the `record` and `entityPath` of the bag, the last
  // carrier the walk reaches for this id.
  assert.deepEqual(
    petsOf(player).find((pet) => pet.id === LIVE_IN_SLOT),
    joined,
  );
});

void test('a pet in a storage is a pet of the player, read from its own carrier', () => {
  const player = fixturePlayer();
  const pet = petsOf(player).find((candidate) => candidate.id === ONLY_IN_STORAGE);
  assert.ok(pet !== undefined, 'a storage is the third place a pet lives');
  assert.equal(pet.name, 'Mittens');
  assert.equal(pet.hunger, 60);
  assert.equal(pet.entityPath, `${SLOT_DATA}/inventory/storages/1/items/0`);
});

void test('a player with no pets has none: an empty list and an empty answer, never undefined', () => {
  const player = fixturePlayer([]);
  const petless: Player = {
    ...player,
    inventory: toInventory({ items: [{ itemType: 'Egg', eggId: 'SnowEgg' }] }, `${SLOT_DATA}/inventory`),
  };

  assert.deepEqual(petsOf(petless), []);
  // `reader.ts`'s own documented rule: a lookup that finds nothing is `null`, never a throw and never
  // `undefined`, so a caller can test the answer with `=== null`.
  assert.equal(petById(petless, LIVE_IN_SLOT), null);
  assert.equal(petById(petless, ''), null, 'an id no pet carries is nothing, the empty string included');
});

void test('the carrier itself still reads the save’s copy, which the join is what corrects', () => {
  const player = fixturePlayer();
  const bagArm = petArmOf(bagItemWithId(player.inventory, LIVE_IN_SLOT));
  assert.ok(bagArm !== null);

  // The defect the join closes: the arm a consumer reaches through `inventory.items` has the stale numbers,
  // and only the join puts the live ones on it.
  assert.equal(bagArm.xp, 3);
  assert.equal(bagArm.hunger, 99);
  assert.equal(petById(player, LIVE_IN_SLOT)?.xp, 40);
});
