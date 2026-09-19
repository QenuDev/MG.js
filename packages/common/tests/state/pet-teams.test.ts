/**
 * A saved pet team: what it states, and the two questions the game asks of it.
 *
 * ## Why this file exists
 *
 * A player's saved data carries `petSlots` and `petTeams` side by side, and the protocol names the team's four
 * actions (`SavePetTeam`, `ApplyPetTeam`, `DeletePetTeam`, `MovePetTeam`, `SetPetTeamEmblem`) without ever
 * saying what a team *is*. The schema does (`sendQuinoaRpc-CltrbGZc.js`, the player record `Bu`):
 *
 *     petSlots: w(Kl), petTeams: w($l), petCosmetics: Gl, …
 *     ql = g({ petId: b(), petSpecies: Do, name: oe(b()) })                 // a member
 *     Ql = ce(`type`, [ g({type:i(`number`),number:Yl}), g({type:i(`pet`),petId:b()}),
 *                       g({type:i(`icon`),icon:Zl}), g({type:i(`cosmetic`),cosmetic:nc}) ])   // an emblem
 *     $l = g({ id: b(), name: b(), members: S(w(ql), u(1), l(3)), emblem: Ql })            // a team
 *
 * and the game's own UI asks two questions of one, both in `installPlayerSystems-NMjL0ny-.js`:
 *
 *     function Uu(e,t){ let n=new Set(e.petSlots.map(e=>e.id)), r=new Set(t.members.map(e=>e.petId));
 *       return r.size>0 && r.size===t.members.length && r.size===n.size && t.members.every(e=>n.has(e.petId)) }
 *
 *     function Hu(e,t){ let n=[],r=[],i=[],a=new Set;
 *       for(let o of t.members){ let t=qc(e,o.petId); if(!t){ r.push(o); continue } n.push(o), … } … }
 *
 * `Uu` is "is this team the one I have out" and `Hu` resolves a team's members against the pets the player
 * still has — `qc` finds a pet by id across every carrier, so a member in the bag or in a hutch is still with
 * you. Both are rules about a save, which is why they live here rather than in each caller.
 *
 * ## The fixture is built so the two sources can disagree
 *
 * A team states its member's `name` and `petSpecies`, and the pet it names states its own. The fixture makes
 * them disagree (`Saved Mittens` on the team, `Mittens II` on the pet), so a view that reported one where the
 * other belongs fails these assertions rather than agreeing with a value both carry. The three members cover
 * the three carriers `qc` reaches — a slot, the bag and a storage — plus one id nothing states, which is the
 * `missingMembers` branch.
 *
 * ## Built through the real readers
 *
 * The player is the package's own `StateReader` over a tree shaped like the game's, so `petTeams` is read
 * from the path a real save has it at and not from a fixture handed straight to the reader. What is stated by
 * hand is only what the game states: the save.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PetTeam } from '../../src/state/entities.js';
import { teamIsOut, teamMembersOf } from '../../src/state/pet-teams.js';
import { asRecord, StateReader, toPet, toPetTeam } from '../../src/state/reader.js';
import { ObservableStore } from '../../src/state/store.js';

const SLOT_DATA = '/child/data/userSlots/0/data';
const TEAMS_PATH = `${SLOT_DATA}/petTeams`;

/** The pet that is out, in the slot the fixture saves, named differently from the team's own copy of it. */
const SLOT_PET = 'pet_slot_only';

/** The pet in the bag. */
const BAG_PET = 'pet_bag_only';

/** The pet in a hutch. */
const STORAGE_PET = 'pet_container_only';

/** An id no carrier states: the pet was sold, and only the team remembers it. */
const GONE_PET = 'pet_gone';

/**
 * The save's pets, in the three carriers the game's own lookup reaches, quoted in its own spellings.
 *
 * The slot pet's name differs from the team's copy of it on purpose: which of the two a view reports is
 * exactly what these tests are about.
 */
const SAVED_INVENTORY = {
  items: [
    { itemType: 'Egg', eggId: 'CatEgg', quantity: 2 },
    {
      itemType: 'Pet',
      id: BAG_PET,
      petSpecies: 'Fox',
      name: 'Rusty',
      xp: 7,
      hunger: 55,
      mutations: ['Gold'],
      targetScale: 1,
      abilities: [],
    },
  ],
  storages: [
    {
      decorId: 'PetHutch',
      capacitySlots: 6,
      items: [
        {
          itemType: 'Pet',
          id: STORAGE_PET,
          petSpecies: 'SnowFox',
          name: 'Frost',
          xp: 12,
          hunger: 60,
          mutations: [],
          targetScale: 1,
          abilities: [],
        },
      ],
    },
  ],
};

/** The two pets the player has out. The second one no team in the fixture names. */
const SAVED_PET_SLOTS = [
  {
    id: SLOT_PET,
    petSpecies: 'Cat',
    name: 'Mittens II',
    xp: 900,
    hunger: 5,
    mutations: ['Wet'],
    targetScale: 2,
    abilities: ['NineLives'],
  },
  { id: 'pet_other_slot', petSpecies: 'Fox', name: 'Ash', xp: 3, hunger: 90, targetScale: 1 },
];

/**
 * The teams the save holds, quoted in the game's own spellings.
 *
 * `team_out` names both pets the slots hold and is the only team that is out. `team_stale` names one of them
 * and one pet that is gone, so it is neither out nor fully resolved. `team_bag` is out of the slots entirely
 * — its members still resolve, which is the case that separates "resolved" from "out".
 */
const SAVED_TEAMS = [
  {
    id: 'team_out',
    name: 'Egg Refund',
    members: [
      { petId: SLOT_PET, petSpecies: 'Cat', name: 'Saved Mittens' },
      { petId: 'pet_other_slot', petSpecies: 'Fox', name: 'Ash' },
    ],
    emblem: { type: 'number', number: 5 },
  },
  {
    id: 'team_stale',
    name: 'Snow Day',
    members: [
      { petId: SLOT_PET, petSpecies: 'Cat', name: 'Saved Mittens' },
      { petId: GONE_PET, petSpecies: 'SnowFox', name: 'No longer with you' },
    ],
    emblem: { type: 'pet', petId: SLOT_PET },
  },
  {
    id: 'team_bag',
    name: 'Sell Run',
    members: [
      { petId: BAG_PET, petSpecies: 'Fox', name: 'Rusty' },
      { petId: STORAGE_PET, petSpecies: 'SnowFox', name: 'Frost' },
    ],
    emblem: { type: 'icon', icon: 'thunder' },
  },
];

/** A tree shaped like the game's: room at `data`, game at `child.data`, a slot's save at `userSlots/0/data`. */
function fixtureReader(): StateReader {
  const store = new ObservableStore({
    initial: {
      data: { players: [{ id: 'p_1', name: 'Ada' }], chat: [], hostPlayerId: 'p_1' },
      child: {
        data: {
          userSlots: [
            {
              userId: 'p_1',
              data: {
                coinsCount: 10,
                magicDustCount: 0,
                inventory: SAVED_INVENTORY,
                petSlots: SAVED_PET_SLOTS,
                petTeams: SAVED_TEAMS,
              },
            },
          ],
        },
      },
    },
  });
  const state = new StateReader(store);
  state.selfPlayerId = 'p_1';
  return state;
}

/** The connected player, whose saved data holds the teams. */
function fixturePlayer() {
  const me = fixtureReader().self;
  assert.ok(me !== null, 'the fixture names this account');
  return me;
}

/** The team with the given id, found by id so an array index is not this test's opinion. */
function teamWithId(player: ReturnType<typeof fixturePlayer>, id: string): PetTeam {
  const team = player.petTeams.find((candidate) => candidate.id === id);
  assert.ok(team !== undefined, `the fixture holds a team with id ${id}`);
  return team;
}

void test('a player carries the teams their save holds, at petTeams', () => {
  const player = fixturePlayer();
  assert.equal(player.petTeams.length, SAVED_TEAMS.length, 'every saved team is read');
  assert.deepEqual(
    player.petTeams.map((team) => team.id),
    SAVED_TEAMS.map((team) => team.id),
    'in the save’s own order, since the order is what MovePetTeam rearranges',
  );
});

void test('a team reads its own fields, its members, and its address', () => {
  const team = teamWithId(fixturePlayer(), 'team_out');
  assert.equal(team.entityPath, `${TEAMS_PATH}/0`, 'the address is the entry the save holds it at');
  assert.equal(team.id, 'team_out');
  assert.equal(team.name, 'Egg Refund');
  assert.deepEqual(team.members, [
    { petId: SLOT_PET, species: 'Cat', name: 'Saved Mittens' },
    { petId: 'pet_other_slot', species: 'Fox', name: 'Ash' },
  ]);
});

void test('each emblem arm the schema names is reported as the save states it', () => {
  const player = fixturePlayer();
  assert.deepEqual(teamWithId(player, 'team_out').emblem, { type: 'number', number: 5 });
  assert.deepEqual(teamWithId(player, 'team_stale').emblem, { type: 'pet', petId: SLOT_PET });
  assert.deepEqual(teamWithId(player, 'team_bag').emblem, { type: 'icon', icon: 'thunder' });
});

void test('a cosmetic emblem is read as the cosmetic it names', () => {
  const team = toPetTeam(
    { id: 'team_hat', name: 'Party', members: [], emblem: { type: 'cosmetic', cosmetic: 'PartyHat' } },
    `${TEAMS_PATH}/9`,
  );
  assert.ok(team !== null);
  assert.deepEqual(team.emblem, { type: 'cosmetic', cosmetic: 'PartyHat' });
});

void test('an emblem arm this release does not know is reported as stated, not forced into one of the four', () => {
  const team = toPetTeam(
    { id: 'team_new', name: 'Tomorrow', members: [], emblem: { type: 'sticker', sticker: 'star' } },
    `${TEAMS_PATH}/9`,
  );
  assert.ok(team !== null);
  // The game may add a fifth arm; a reader that picked one of the four would draw the wrong badge and say
  // nothing about it. This reports the type the save states, which is what a caller needs to notice.
  assert.deepEqual(team.emblem, { type: 'other', stated: 'sticker' });
});

void test('an entry in petTeams that is not a record is not a team', () => {
  assert.equal(toPetTeam(null, `${TEAMS_PATH}/0`), null);
  assert.equal(toPetTeam('team_out', `${TEAMS_PATH}/0`), null);
});

void test('a team that states no emblem and no members still reads: the save may be mid-write', () => {
  const team = toPetTeam({ id: 'team_new' }, `${TEAMS_PATH}/9`);
  assert.ok(team !== null);
  assert.equal(team.name, '');
  assert.deepEqual(team.members, []);
  assert.deepEqual(team.emblem, { type: 'other', stated: '' });
});

void test('a member is paired with the pet the player still has, wherever that pet lives', () => {
  const player = fixturePlayer();
  const roster = teamMembersOf(player, teamWithId(player, 'team_bag'));

  assert.equal(roster.length, 2);
  // The bag member, found by the package's own by-id lookup rather than by this test's reading of petSlots.
  assert.equal(roster[0]?.petId, BAG_PET);
  assert.equal(roster[0]?.pet?.species, 'Fox');
  assert.equal(roster[0]?.pet?.entityPath, `${SLOT_DATA}/inventory/items/1`);
  // The member in a hutch, which is a carrier `petSlots` never names.
  assert.equal(roster[1]?.petId, STORAGE_PET);
  assert.equal(roster[1]?.pet?.name, 'Frost');
});

void test('a member the player no longer has is null, and keeps the team’s own name and species', () => {
  const player = fixturePlayer();
  const roster = teamMembersOf(player, teamWithId(player, 'team_stale'));

  const gone = roster.find((view) => view.petId === GONE_PET);
  assert.ok(gone !== undefined, 'the missing member is reported rather than dropped');
  assert.equal(gone.pet, null, 'nothing in the save states this id');
  // The team’s own snapshot is what a card is drawn from when the pet is gone, so it is reported as the save
  // states it — a view that read the species or name off the live pet would have nothing to read here.
  assert.equal(gone.species, 'SnowFox');
  assert.equal(gone.name, 'No longer with you');

  // The member that is still here reports both: the team's copy and the live pet, which disagree by design.
  const here = roster.find((view) => view.petId === SLOT_PET);
  assert.ok(here !== undefined);
  assert.equal(here.name, 'Saved Mittens', 'the team’s own copy');
  assert.equal(here.pet?.name, 'Mittens II', 'and the pet the save actually has');
});

void test('the team that is out is the one whose members are exactly the pets in the slots', () => {
  const player = fixturePlayer();
  assert.equal(teamIsOut(player, teamWithId(player, 'team_out')), true);
  assert.equal(
    teamIsOut(player, teamWithId(player, 'team_stale')),
    false,
    'one of its members is gone and it names only one of the two pets that are out',
  );
  assert.equal(
    teamIsOut(player, teamWithId(player, 'team_bag')),
    false,
    'its members are all still with the player, but neither of them is out',
  );
});

void test('the game’s own guards: a repeated id, and a team with no members, are neither of them out', () => {
  const player = fixturePlayer();
  const path = `${TEAMS_PATH}/9`;

  // `Uu` requires the member set to be the same size as the list, so a team that names one pet twice is not
  // the team that is out even when the slots hold exactly that pet. A set comparison that skipped this would
  // call it out.
  const repeated = toPetTeam(
    { id: 'team_dup', name: 'Twice', members: [{ petId: SLOT_PET }, { petId: SLOT_PET }], emblem: {} },
    path,
  );
  assert.ok(repeated !== null);
  assert.equal(teamIsOut(player, repeated), false);

  // `Uu` opens with `r.size > 0`: an empty team is not out, whatever the slots hold.
  const empty = toPetTeam({ id: 'team_empty', name: 'Empty', members: [], emblem: {} }, path);
  assert.ok(empty !== null);
  assert.equal(teamIsOut(player, empty), false);
});

void test('both sides of the comparison are sets of distinct ids, not lists of entries', () => {
  // `Uu` builds a `Set` on each side, so a save that states one id in two slots compares as one pet. A join
  // that compared `player.pets.length` against `team.members.length` looks equivalent and answers false here,
  // which is why this fixture has the same pet in two slots.
  const player = fixturePlayer();
  const [first] = player.pets;
  assert.ok(first !== undefined, 'the fixture has a pet in a slot');
  const doubled = { ...player, pets: [first, first] };
  const one = toPetTeam({ id: 'team_one', name: 'One', members: [{ petId: SLOT_PET }], emblem: {} }, 'x');
  assert.ok(one !== null);
  assert.equal(teamIsOut(doubled, one), true, 'one distinct id on each side, however many entries state it');

  // The same rule reads the other way for an id the member list repeats, which is the test above.
  const twoEntries = toPetTeam(
    { id: 'team_two', name: 'Two', members: [{ petId: SLOT_PET }, { petId: SLOT_PET }], emblem: {} },
    'x',
  );
  assert.ok(twoEntries !== null);
  assert.equal(teamIsOut(player, twoEntries), false, 'two entries, one distinct id, two pets in the slots');
});

/**
 * The game's own `Uu`, transcribed verbatim from the build this reader was written against.
 *
 * `assets/sendQuinoaRpc-CltrbGZc.js`, v1230:
 *
 *     function Uu(e,t){let n=new Set(e.petSlots.map(e=>e.id)),r=new Set(t.members.map(e=>e.petId));
 *       return r.size>0&&r.size===t.members.length&&r.size===n.size&&t.members.every(e=>n.has(e.petId))}
 *
 * It is here so the rule can be run rather than described: the table below hands the same save and the same
 * team to both, in the shape each expects, and any disagreement is a port that drifted. A test that asserted
 * only the cases this release thought of would be a test of this release's reading of the rule.
 */
function gameIsOut(slots: readonly string[], members: readonly string[]): boolean {
  const out = new Set(slots);
  const named = new Set(members);
  return (
    named.size > 0 &&
    named.size === members.length &&
    named.size === out.size &&
    members.every((petId) => out.has(petId))
  );
}

void test('the rule is the game’s own expression, run over the same saves', () => {
  const cases: readonly { why: string; slots: string[]; members: string[] }[] = [
    { why: 'the same pets, in the same order', slots: ['a', 'b'], members: ['a', 'b'] },
    { why: 'the same pets, in another order', slots: ['a', 'b'], members: ['b', 'a'] },
    { why: 'all three slots', slots: ['a', 'b', 'c'], members: ['a', 'b', 'c'] },
    { why: 'the team names fewer pets than are out', slots: ['a', 'b'], members: ['a'] },
    { why: 'the team names a pet that is gone', slots: ['a', 'b'], members: ['a', 'c'] },
    { why: 'the team names one pet twice', slots: ['a'], members: ['a', 'a'] },
    { why: 'an empty team', slots: ['a'], members: [] },
    { why: 'no pets out at all', slots: [], members: ['a'] },
    { why: 'one pet stated in two slots', slots: ['a', 'a'], members: ['a'] },
    { why: 'nothing out and an empty team', slots: [], members: [] },
  ];

  for (const one of cases) {
    const team = toPetTeam(
      { id: 'team', name: '', members: one.members.map((petId) => ({ petId })), emblem: {} },
      'x',
    );
    assert.ok(team !== null);
    // The slot pets are the package's own reading of a slot record, for the reason the file's header gives:
    // a stand-in cast into place would be this test's idea of a pet rather than the reader's.
    const pets = one.slots.map((id, index) => {
      const pet = toPet({ id, petSpecies: 'Cat', name: '' }, `${SLOT_DATA}/petSlots/${index}`);
      assert.ok(pet !== null, 'a slot record that states a species is a pet');
      return pet;
    });
    assert.equal(
      teamIsOut({ ...fixturePlayer(), pets }, team),
      gameIsOut(one.slots, one.members),
      `${one.why}: the game says ${gameIsOut(one.slots, one.members)}`,
    );
  }
});

void test('a team read by hand carries its own record, for a field this release does not name', () => {
  const team = toPetTeam(
    { id: 'team_out', name: 'Egg Refund', members: [], emblem: {}, pinned: true },
    `${TEAMS_PATH}/0`,
  );
  assert.ok(team !== null);
  assert.equal(team.record.boolean('pinned'), true);
  assert.deepEqual(team.record.fields().sort(), ['emblem', 'id', 'members', 'name', 'pinned']);
  assert.equal(team.record.raw.id, 'team_out');
});

void test('a team built by hand with no record behind it still answers', () => {
  // `asRecord({})` is the empty view the package hands a caller with nothing to read; a join over a team
  // shaped like one must not depend on a field being there.
  const team: PetTeam = {
    entityPath: 'x',
    id: 'team_x',
    name: '',
    members: [],
    emblem: { type: 'other', stated: '' },
    record: asRecord({}),
  };
  assert.deepEqual(teamMembersOf(fixturePlayer(), team), []);
  assert.equal(teamIsOut(fixturePlayer(), team), false);
});
