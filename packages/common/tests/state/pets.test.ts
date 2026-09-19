/**
 * Where a pet is: the game's own walk over its three carriers, and the index it builds over them.
 *
 * ## Why this file exists
 *
 * §7 S1 of the plan this pass implements: a pet lives in a pet slot, in the bag, or in a storage, and the
 * game reads all three. `bo` walks the carriers (`worldDepthSortKey-BXUHHrP0.js` ~645890, quoted in
 * `state/pets.ts`), and `Yu` reduces that walk to one entry per id — the carrier's own fields, reported from
 * the last carrier in walk order, plus the index's own `isInPetSlot` (`worldDepthSortKey-BXUHHrP0.js`
 * ~705743, exported as `Tr` and installed as `petsProgress`). A consumer had to hand-roll both;
 * `petsOf`/`petById` are where the game has them.
 *
 * ## The two copies of `pet_live` are built to disagree
 *
 * That pet is in a slot and in the bag, and the copies state **different** values for every field, so a test
 * can say which carrier the index reported rather than agreeing with a number both copies carry. That is
 * the §1.1 failure mode this plan is about ("the fixture kept the fields, the test agreed with the model"):
 * the bag item says `xp: 3, hunger: 99` and the slot record says `xp: 40, hunger: 10`, and the bag comes
 * after the slots in the walk, so the bag's values are the ones the index reports. An implementation that
 * took the slot record's numbers passes every assertion about *shape* and fails these about *value*.
 *
 * The other fixtures cover the remaining shapes: a pet in the bag only, a pet in a storage only, a pet in a
 * slot only, and two carriers that state no id.
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
 * The pet-slot record for the duplicated id, quoted in the game's own spellings.
 *
 * Every value here differs from the bag item's for the same id, which is what lets the tests say which
 * carrier the index reported rather than agreeing with a value both copies carry.
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
 * It is the one branch where a slot carrier is the index's only entry, so the tests assert its address and
 * every value rather than only its presence.
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
 * `pet_live`'s bag copy disagrees with the slot record on every field. The bag comes after the slots in the
 * walk, so it is the carrier the index reports for that id, and the tests assert the bag's values —
 * `name`, `species` and the extras included — rather than the slot's.
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

  // The slot record is the only carrier that states this id, so the index reports the slot's own values and
  // the address is the slot's. This is the branch a consumer showing a card for a pet that is out takes, and
  // nothing else in this file asserts it.
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

  // It is in a pet slot, so the game's own flag is true — the question the entry's address used to be
  // misread as answering.
  assert.equal(joined.isInPetSlot, true, 'a slot carrier is a pet that is out');

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

  // Neither is a slot carrier, and an empty id is not an id the slots state, so the index's flag is false
  // for both. The game's own `i.has('')` would answer true if any slot also stated no id; that is two
  // spellings of "no id" matching, not a pet that is out, which is why this module does not ask it.
  assert.deepEqual(
    unnamed.map((pet) => pet.isInPetSlot),
    [false, false],
    'an id-less bag or storage carrier is not out',
  );

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

  // Every field a pet has, with the bag item's own readings: no slot record names this id, so the index's
  // only entry for it is this carrier and its `isInPetSlot` is false.
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
    isInPetSlot: false,
  });
});

void test('the index reports the last carrier’s own values when two carriers state one id', () => {
  const player = fixturePlayer();
  const joined = petById(player, LIVE_IN_SLOT);
  assert.ok(joined !== null);

  // The slot record and the bag item disagree on every field, and the bag is later in the walk (slots → bag
  // → storages), so the index's entry for this id is the bag's reading. Every assertion names which record
  // the index reported rather than agreeing with a value both carry: these are the *saved* numbers, not the
  // slot's 40, 10, 1.25, 'Frost', ['Rainbow'], { DawnCoinFinder: 30 }.
  assert.equal(joined.xp, 3, 'the bag’s xp, which is the carrier the index reached last');
  assert.equal(joined.hunger, 99, 'the bag’s hunger');
  assert.equal(joined.targetScale, 0.5, 'the bag’s scale');
  assert.equal(joined.name, 'Saved Frost', 'the bag’s name');
  assert.deepEqual(joined.mutations, ['Gold'], 'the bag’s mutations');
  assert.deepEqual(joined.abilityCooldowns, { SnowyCoinFinder: 999 }, 'the bag’s cooldowns');

  // `species`, `abilities`, `sourceEggId` and `equippedCosmetics` come from that same carrier: the index
  // reports one carrier's whole record, not six fields of one and the rest of another.
  assert.equal(joined.species, 'Fox', 'the bag’s species, not the slot’s SnowFox');
  assert.deepEqual(joined.abilities, ['SnowyCoinFinder'], 'the bag’s abilities');
  assert.equal(joined.sourceEggId, 'FoxEgg', 'the bag’s egg');
  assert.deepEqual(joined.equippedCosmetics, { tie: 'Bowtie' }, 'the bag’s cosmetics');

  // A slot states this id, so the game's own flag says the pet is out — the fact the old precedence was
  // reaching for.
  assert.equal(joined.isInPetSlot, true, 'a slot carries this id');
});

void test('a joined pet is the pet’s own shape, not the bag arm’s', () => {
  const player = fixturePlayer();
  const joined = petById(player, LIVE_IN_SLOT);
  assert.ok(joined !== null);

  // The address and every field are the bag's, because the bag is the last carrier the walk reaches for
  // this id and that is the carrier the index reports — not because the pet "is" in the bag. The game's `bo`
  // yields both carriers and `Yu` indexes them by id without saying which owns the pet; a join that took the
  // slot's address would be asserting an ownership the game does not state.
  assert.equal(joined.entityPath, `${SLOT_DATA}/inventory/items/1`);

  // Exactly `Pet`'s fields plus the index's own flag: the bag arm's `itemType` is a discriminant of the item
  // union, so a joined pet that carried it would be an item arm wearing the pet pointer's name.
  assert.deepEqual(Object.keys(joined).sort(), [
    'abilities',
    'abilityCooldowns',
    'entityPath',
    'equippedCosmetics',
    'hunger',
    'id',
    'isInPetSlot',
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

void test('the name is the last carrier’s own, with no species-default fallback', () => {
  // The bag copy of `pet_live` still names it and the bag is the last carrier, so the bag's name is the one
  // the index reports.
  const unnamedSlot = toPet({ ...LIVE_SLOT_RECORD, name: '' }, `${SLOT_DATA}/petSlots/0`);
  assert.ok(unnamedSlot !== null);
  const joined = petById(fixturePlayer([unnamedSlot]), LIVE_IN_SLOT);
  assert.equal(joined?.name, 'Saved Frost', 'the later carrier’s name is the one reported');

  // With no later carrier, the stated name is the slot's own `''`. The game's index would fall back to the
  // species' default name (`name ?? M[petSpecies].name`); this library carries no species-name table and
  // reports what the save states, a deliberate divergence stated in `state/pets.ts`.
  const bagless: Player = {
    ...fixturePlayer([unnamedSlot]),
    inventory: toInventory({ items: [{ itemType: 'Egg', eggId: 'SnowEgg' }] }, `${SLOT_DATA}/inventory`),
  };
  assert.equal(petById(bagless, LIVE_IN_SLOT)?.name, '', 'the save states no name and none is invented');
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

  // The bag copy comes first in the walk and the hutch's later, so the later carrier is the one the index
  // reports. That is the rule the entry follows, not a claim about where the pet is.
  const pet = petById(player, ONLY_IN_STORAGE);
  assert.ok(pet !== null);
  assert.equal(pet.entityPath, `${SLOT_DATA}/inventory/storages/1/items/0`);
  assert.equal(pet.name, 'Mittens', 'the last carrier’s own name');
  assert.equal(pet.isInPetSlot, false, 'no slot states this id, so the pet is not out');
});

void test('the pet is the same one entry petById and petsOf answer with', () => {
  const player = fixturePlayer();
  const joined = petById(player, LIVE_IN_SLOT);
  assert.ok(joined !== null);

  // Both `petsOf` and `petById` build the joined value from the same carrier, so the two objects are equal
  // field for field — including the `record` and `entityPath` of the bag, the last carrier the walk reaches
  // for this id.
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
  assert.equal(pet.isInPetSlot, false, 'the hutch is a storage, so the pet is not out');
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

void test('the index reports the bag’s own copy, so the join adds the flag and not a value', () => {
  const player = fixturePlayer();
  const bagArm = petArmOf(bagItemWithId(player.inventory, LIVE_IN_SLOT));
  assert.ok(bagArm !== null);

  // The bag is the carrier the index reached last for this id, so the joined pet states the bag's own
  // numbers — the same ones the arm already has. Nothing overwrites them with the slot record's 40/10; the
  // slot's contribution to this entry is `isInPetSlot`.
  assert.equal(bagArm.xp, 3);
  assert.equal(bagArm.hunger, 99);
  assert.equal(petById(player, LIVE_IN_SLOT)?.xp, 3);
  assert.equal(petById(player, LIVE_IN_SLOT)?.hunger, 99);
  assert.equal(petById(player, LIVE_IN_SLOT)?.isInPetSlot, true);
});

void test('a numeric slot id joins the bag item that states the same number', () => {
  // The reader accepts a number for an id and renders it (`StateRecord.id`), which a grow slot's `slotId`
  // already needs. Both pet carriers must read it the same way or the join silently misses: a slot reading
  // `''` while the bag item reads `'42'` is the §0 bug back again.
  const numericSlot = toPet(
    { id: 42, petSpecies: 'Fox', name: 'Forty Two', xp: 5, hunger: 5 },
    `${SLOT_DATA}/petSlots/9`,
  );
  assert.ok(numericSlot !== null);
  assert.equal(numericSlot.id, '42', 'the slot carrier renders a numeric id the way the base reader does');

  const player: Player = {
    ...fixturePlayer([numericSlot]),
    inventory: toInventory(
      { items: [{ itemType: 'Pet', id: 42, petSpecies: 'Fox', name: 'Saved' }] },
      `${SLOT_DATA}/inventory`,
    ),
  };
  assert.equal(petById(player, '42')?.isInPetSlot, true, 'the two carriers met on the same id');
  assert.equal(petById(player, '42')?.name, 'Saved', 'the bag is the last carrier');
});

void test('an id-less bag pet does not inherit an id-less slot record', () => {
  // The old join keyed its slot lookup on `''`, so a pet that states no id could be handed an unrelated
  // id-less slot record's fields. The lookup no longer runs on the empty id: the slot's entry is the slot's,
  // the bag's is the bag's.
  const idlessSlot = toPet(
    { petSpecies: 'Cat', name: 'Slot Hatchling', xp: 111, hunger: 111 },
    `${SLOT_DATA}/petSlots/7`,
  );
  assert.ok(idlessSlot !== null);
  const player: Player = {
    ...fixturePlayer([idlessSlot]),
    inventory: toInventory(
      { items: [{ itemType: 'Pet', petSpecies: 'Fox', name: 'Bag Hatchling', xp: 1, hunger: 80 }] },
      `${SLOT_DATA}/inventory`,
    ),
  };

  const unnamed = petsOf(player).filter((pet) => pet.id === '');
  assert.deepEqual(
    unnamed.map((pet) => [pet.name, pet.xp, pet.isInPetSlot]),
    [
      ['Slot Hatchling', 111, true],
      ['Bag Hatchling', 1, false],
    ],
    'each id-less carrier keeps its own values, and only the slot carrier is out',
  );
});
