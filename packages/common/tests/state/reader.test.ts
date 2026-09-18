/**
 * The named state accessors, the typed domain model, and the server clock timings are judged against.
 *
 * ## Why this file exists
 *
 * `reader.ts` exists because a mod author should not have to know that room state is at `/data` and game
 * state at `/child/data`, or that a garden's tiles live under `tileObjects`. That claim is worth nothing
 * unless the accessors agree with the literals the game sends, so the assertions here compare an accessor
 * against `store.get(<literal>)` rather than against another accessor: two accessors agreeing would prove
 * the module is self-consistent even if both were wrong.
 *
 * The previous revision of this file encoded its own assumption about the shape and therefore could not
 * fail. It handed the reader a flat array at `garden` and an array at `pets`, which is not what bundle
 * 1171 sends, so `toGarden` returned an empty garden on every real tree and these tests passed anyway.
 * The fixture below is a real garden read out of that bundle, which is the only kind of fixture that can
 * catch that class of bug.
 *
 * The rest covers the two things a caller relies on and cannot check by reading it once:
 *
 *   1. **The domain model.** A crop's fields are the game's own schema `Uo`, so the fixture uses the field
 *      names read out of bundle 1171, and a rename in a future build shows up here rather than as an
 *      `undefined` in someone's mod.
 *   2. **The clock.** `ready` and `remainingMs` are only correct if they are computed against server time.
 *      The fixture anchors a clock deliberately hours away from the machine clock, because a test that
 *      passes with both clocks equal would also pass with the wrong one.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServerClock } from '../../src/state/clock.js';
import { mutationName, type Tile } from '../../src/state/entities.js';
import { asRecord, StateReader, StateRecord, StateWaitError } from '../../src/state/reader.js';
import { ObservableStore } from '../../src/state/store.js';

/** A fixed local clock, so nothing in this file depends on when it runs. */
function fixedClock(startMs: number) {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** A `Welcome` timestamp two hours ahead of the local clock, which is the case that catches `Date.now()`. */
const LOCAL_START = 1_700_000_000_000;
const SERVER_AHEAD_MS = 2 * 60 * 60 * 1000;
const SERVER_START = LOCAL_START + SERVER_AHEAD_MS;

/**
 * A real garden, quoted from the sample the game's own bundle embeds at version 1171.
 *
 * The tile keys are the bundle's own, and they are deliberately sparse: `10, 11, 30, 50, 70, 88`. A sparse
 * key set is the case that separates an honest dense array from a sparse one, so the fixture keeps it.
 */
const REAL_TILE_OBJECTS = {
  '10': {
    objectType: 'plant',
    species: 'Tomato',
    slots: [
      {
        species: 'Tomato',
        startTime: SERVER_START - 40_000,
        endTime: SERVER_START - 1_000,
        size: 50,
        mutations: [],
        slotId: 0,
      },
    ],
    plantedAt: SERVER_START - 40_000,
    maturedAt: SERVER_START - 1_000,
  },
  '30': {
    objectType: 'plant',
    species: 'Strawberry',
    slots: [
      {
        species: 'Strawberry',
        startTime: SERVER_START - 8_000,
        endTime: SERVER_START - 500,
        size: 62,
        mutations: ['Gold', 'Wet'],
        x: 3,
        y: 4,
        rotation: 90,
        flipped: false,
        preserved: true,
        slotId: 7,
      },
      {
        species: 'Strawberry',
        startTime: SERVER_START - 1_000,
        endTime: SERVER_START + 20_000,
        size: 50,
        mutations: [],
        x: 3,
        y: 5,
        rotation: 0,
        flipped: false,
        preserved: false,
        slotId: 8,
      },
    ],
    plantedAt: SERVER_START - 1_000,
    maturedAt: SERVER_START + 20_000,
  },
  '88': { objectType: 'decor', decorId: 'fence', slots: [] },
};

/** A tree shaped like the game's own: room at `data`, game at `child.data`, tiles under `tileObjects`. */
function sampleStore(): ObservableStore {
  return new ObservableStore({
    initial: {
      data: {
        players: [
          { id: 'p_1', name: 'Ada', discordUserId: '111' },
          { id: 'p_2', name: 'Bo' },
          { id: 'p_3', name: 'Cy', databaseUserId: '333' },
        ],
        chat: [{ message: 'hi', authorId: 'p_1' }],
        hostPlayerId: 'p_1',
      },
      child: {
        data: {
          userSlots: [
            {
              userId: 'p_1',
              data: {
                // The saved object the garden, both balances and the inventory are all fields of.
                coinsCount: 1250,
                magicDustCount: 226_100,
                inventory: {
                  items: [
                    { itemType: 'Seed', species: 'Clover', quantity: 12 },
                    { itemType: 'Produce', id: 'crop_1', species: 'Tomato', size: 75, mutations: ['Gold'] },
                    { itemType: 'Tool', toolId: 'WateringCan', quantity: 1 },
                    {
                      itemType: 'Tool',
                      id: 'tool_1',
                      toolId: 'RainPotion',
                      quantity: 1,
                      remainingActiveSeconds: 0,
                    },
                    { itemType: 'Egg', eggId: 'SnowEgg', quantity: 3 },
                    { itemType: 'Decor', decorId: 'Fence', quantity: 4 },
                    {
                      itemType: 'Pet',
                      id: 'pet_bag',
                      petSpecies: 'Fox',
                      name: 'Rusty',
                      xp: 10,
                      hunger: 50,
                      mutations: [],
                      targetScale: 1,
                      abilities: [],
                    },
                  ],
                  storages: [
                    {
                      decorId: 'SeedSilo',
                      capacitySlots: 200,
                      items: [{ itemType: 'Seed', species: 'Pumpkin', quantity: 3 }],
                    },
                    {
                      decorId: 'ToolShack',
                      capacitySlots: 30,
                      items: [{ itemType: 'Tool', toolId: 'Shovel', quantity: 1 }],
                    },
                  ],
                  favoritedItemIds: [],
                },
                garden: { tileObjects: REAL_TILE_OBJECTS, boardwalkTileObjects: {} },
                petSlots: [
                  {
                    id: 'pet_1',
                    petSpecies: 'SnowFox',
                    name: 'Frost',
                    xp: 120,
                    hunger: 44,
                    mutations: ['Rainbow'],
                    targetScale: 1,
                    abilities: ['CoinFinderI', 'SnowyCoinFinder'],
                    sourceEggId: 'SnowEgg',
                    abilityCooldowns: {},
                    equippedCosmetics: {},
                  },
                ],
                activityLogs: [
                  { action: 'Bloom', parameters: { pet: 'pet_1' }, timestamp: SERVER_START },
                  { Action: 'Turtle-Timer', Parameters: { Pet: 'pet_1' }, timestamp: SERVER_START + 5 },
                ],
              },
            },
            {
              userId: 'p_2',
              data: { garden: { tileObjects: {}, boardwalkTileObjects: {} }, petSlots: [], activityLogs: [] },
            },
            { userId: 'p_3', data: { inventory: { items: [], storages: [], favoritedItemIds: [] } } },
          ],
        },
      },
    },
  });
}

/** A reader over the sample store, with the server clock anchored and the local clock fixed. */
function readerWithClock(): {
  state: StateReader;
  store: ObservableStore;
  clock: { now: () => number; advance: (ms: number) => void };
} {
  const local = fixedClock(LOCAL_START);
  const serverClock = new ServerClock(local.now);
  serverClock.reset(SERVER_START);
  const store = sampleStore();
  const state = new StateReader(store, { clock: serverClock });
  state.selfPlayerId = 'p_1';
  return { state, store, clock: local };
}

// ---------------------------------------------------------------- the room, and the join

void test('the room reads its players, chat and host from the documented room paths', () => {
  const store = sampleStore();
  const state = new StateReader(store);

  assert.deepEqual(
    state.room.players.map((player) => player.id),
    (store.get('/data/players') as { id: string }[]).map((entry) => entry.id),
  );
  assert.equal(state.room.players.length, 3);
  assert.equal(state.room.players[0]?.name, 'Ada');
  // The balances come from the player's saved data, not from the room's list of who is here.
  assert.equal(state.room.players[0]?.coinsCount, 1250);
  assert.equal(state.room.players[0]?.magicDustCount, 226_100);
  // A player with no saved data reads as nothing spent, not as a missing field.
  assert.equal(state.room.players[1]?.coinsCount, 0);
  assert.equal(state.room.players[1]?.magicDustCount, 0);
  assert.deepEqual(
    state.room.chat.map((record) => record.raw),
    store.get('/data/chat'),
  );
  assert.equal(state.room.hostPlayerId, store.get('/data/hostPlayerId'));
});

void test('a player carries the whole inventory, and every kind of item reads its own fields', () => {
  const { state } = readerWithClock();
  const me = state.self;
  assert.ok(me !== null, 'the fixture names this account');

  const byKind = (kind: string) => me.inventory.items.filter((item) => item.itemType === kind);
  assert.equal(me.inventory.items.length, 7, 'every entry in the save is read');

  const [seed] = byKind('Seed');
  assert.equal(seed?.species, 'Clover');
  assert.equal(seed?.quantity, 12);
  // A stack carries no id of its own, and says so rather than inventing one.
  assert.equal(seed?.id, '');

  const [produce] = byKind('Produce');
  assert.equal(produce?.species, 'Tomato');
  assert.equal(produce?.size, 75);
  assert.deepEqual(produce?.mutations, ['Gold']);
  // A kind with no quantity of its own is one item, which is the save's own default.
  assert.equal(produce?.quantity, 1);

  const tools = byKind('Tool');
  assert.equal(tools.length, 2);
  assert.equal(tools[0]?.toolId, 'WateringCan');
  assert.equal(tools[0]?.hasLife, false, 'a tool with no stated life is not a spent one');
  assert.equal(tools[1]?.hasLife, true, 'a consumable tool states its life, even at zero');

  assert.equal(byKind('Egg')[0]?.eggId, 'SnowEgg');
  assert.equal(byKind('Decor')[0]?.decorId, 'Fence');
  assert.equal(byKind('Pet')[0]?.species, 'Fox');
  assert.equal(byKind('Pet')[0]?.name, 'Rusty');
});

void test('the inventory lists every storage with the decoration it came from', () => {
  const { state } = readerWithClock();
  const me = state.self;
  assert.ok(me !== null);

  assert.deepEqual(
    me.inventory.storages.map((storage) => storage.decorId),
    ['SeedSilo', 'ToolShack'],
  );
  const silo = me.inventory.storages.find((storage) => storage.decorId === 'SeedSilo');
  assert.equal(silo?.capacitySlots, 200);
  assert.equal(silo?.items.length, 1);
  assert.equal(silo?.items[0]?.species, 'Pumpkin');
  assert.equal(silo?.items[0]?.quantity, 3);
});

void test('an inventory the save has not sent yet is empty, not null', () => {
  const { state } = readerWithClock();
  // Slot 2 in the fixture has a garden and no inventory at all, which is what a player who has just joined
  // looks like. Reading it must not throw, and must not report a missing inventory as a broken one.
  const other = state.room.players[1];
  assert.ok(other !== undefined);
  assert.deepEqual(other.inventory.items, []);
  assert.deepEqual(other.inventory.storages, []);
});

void test('a room that has not arrived yet is an empty room, not null', () => {
  const state = new StateReader(new ObservableStore());
  assert.deepEqual(state.room.players, []);
  assert.equal(state.room.hostPlayerId, null);
  assert.deepEqual(state.room.chat, []);
  assert.equal(state.self, null);
});

void test('self is the caller, resolved from the connection id rather than from the tree', () => {
  const { state } = readerWithClock();
  assert.equal(state.self?.id, 'p_1');
  assert.equal(state.self?.name, 'Ada');

  state.selfPlayerId = 'p_2';
  assert.equal(state.self?.id, 'p_2');

  state.selfPlayerId = null;
  assert.equal(state.self, null);

  state.selfPlayerId = 'nobody';
  assert.equal(state.self, null, 'an id with no matching room player is not a player');
});

void test('a player is joined to their own slot data by the slot userId', () => {
  const { state } = readerWithClock();
  const [ada, bo, cy] = state.room.players;

  assert.equal(ada?.garden?.tiles.length, 3, 'p_1 has three tiles');
  assert.deepEqual(bo?.garden?.tiles, [], 'p_2 has an empty garden, which is not a failed join');
  assert.equal(cy?.garden, null, 'p_3 has no garden object at all, which IS a failed join');
  assert.equal(ada?.pets.length, 1);
  assert.equal(ada?.pets[0]?.species, 'SnowFox', 'the wire calls it petSpecies');
  assert.equal(cy?.pets.length, 0);
});

void test('a failed slot join is distinguishable from an empty garden', () => {
  const store = new ObservableStore({
    initial: {
      data: { players: [{ id: 'p_1' }] },
      child: { data: { userSlots: [] } },
    },
  });
  const state = new StateReader(store);
  state.selfPlayerId = 'p_1';

  assert.equal(state.room.players[0]?.garden, null);
  assert.notDeepEqual(state.room.players[0]?.garden, { tiles: [], record: state.room.players[0]?.record });
});

// ---------------------------------------------------------------- the garden tree

void test('the garden is read from tileObjects, three levels deep', () => {
  const store = sampleStore();
  const state = new StateReader(store);

  const garden = state.garden(0);
  assert.notEqual(garden, null);
  assert.equal(garden?.tiles.length, 3, 'three tiles, from the sparse keys 10, 30 and 88');
  assert.deepEqual(
    garden?.tiles.map((tile) => tile.id),
    [10, 30, 88],
    'tile ids are the keys of tileObjects, in ascending order',
  );
  assert.deepEqual(
    garden?.tiles.map((tile) => tile.plots.length),
    [1, 2, 0],
    'a tile carries its own slots array, so a crop is never at the garden level',
  );

  // The literal that proves the reader walked the real path rather than a plausible one.
  assert.deepEqual(
    garden?.tiles[1]?.record.raw,
    store.get('/child/data/userSlots/0/data/garden/tileObjects/30'),
  );
});

void test('a boardwalk tile is kept even when its key collides with a ground tile', () => {
  // The two maps are keyed independently, so key 12 can name a plantable tile and a boardwalk tile at
  // once. Merging them into one list dropped whichever lost the collision, which silently lost decoration.
  const store = new ObservableStore({
    initial: {
      data: { players: [{ id: 'p_1' }] },
      child: {
        data: {
          userSlots: [
            {
              userId: 'p_1',
              data: {
                garden: {
                  tileObjects: { '12': { objectType: 'plant', species: 'Clover', slots: [] } },
                  boardwalkTileObjects: {
                    '12': { objectType: 'decor', decorId: 'PetHutch' },
                    '7': { objectType: 'decor', decorId: 'FeedingTrough' },
                  },
                },
              },
            },
          ],
        },
      },
    },
  });
  const state = new StateReader(store);
  state.selfPlayerId = 'p_1';

  const garden = state.garden(0);
  assert.notEqual(garden, null);
  assert.deepEqual(
    garden?.tiles.map((tile) => tile.id),
    [12],
    'the ground keeps its own key 12',
  );
  assert.deepEqual(
    garden?.boardwalkTiles.map((tile) => tile.id),
    [7, 12],
    'the boardwalk keeps both of its tiles, including the colliding key',
  );
  assert.equal(garden?.boardwalkTiles[1]?.objectType, 'decor');
  assert.equal(
    garden?.boardwalkTiles[1]?.objectType === 'decor' ? garden.boardwalkTiles[1].decorId : null,
    'PetHutch',
    'a decoration tile states its decoration as a field of its own arm',
  );

  // And the ground tile at the same key is the plant, not the hutch.
  assert.equal(garden?.tiles[0]?.objectType, 'plant');
  assert.equal(
    garden?.tiles[0]?.objectType === 'plant' ? garden.tiles[0].species : null,
    'Clover',
    'a plant tile states its species as a field, not only through the escape hatch',
  );

  // Each tile says which ground it is on, because an index on its own is not an address: 12 names both of
  // these. It is the game's own name for the pair, and the map the tile is keyed in is where it says so —
  // nothing on the tile itself does, since a hutch can stand in the soil and a shard can charge on the
  // boardwalk.
  assert.equal(garden?.tiles[0]?.tileType, 'Dirt', 'the soil tile says it is soil');
  assert.deepEqual(
    garden?.boardwalkTiles.map((tile) => tile.tileType),
    ['Boardwalk', 'Boardwalk'],
    'and every boardwalk tile says it is boardwalk',
  );
});

void test('the ground a tile is on is the map, not what the tile holds', () => {
  // Both grounds hold more than their usual contents: decoration stands in the soil and a shard is charged
  // on the boardwalk. Reading the contents as the place is what put a garden's decoration on the rim.
  const store = new ObservableStore({
    initial: {
      data: { players: [{ id: 'p_1' }] },
      child: {
        data: {
          userSlots: [
            {
              userId: 'p_1',
              data: {
                garden: {
                  tileObjects: {
                    '4': { objectType: 'decor', decorId: 'MarblePedestal' },
                    '5': {
                      objectType: 'crystal',
                      crystalType: 'Hunger',
                      remainingActiveSeconds: 1_440,
                    },
                  },
                  boardwalkTileObjects: {
                    '6': {
                      objectType: 'crystal',
                      crystalType: 'XP',
                      remainingActiveSeconds: 900,
                    },
                  },
                },
              },
            },
          ],
        },
      },
    },
  });
  const state = new StateReader(store);
  state.selfPlayerId = 'p_1';
  const garden = state.garden(0);

  assert.deepEqual(
    garden?.tiles.map((tile) => [tile.id, tile.objectType, tile.tileType]),
    [
      [4, 'decor', 'Dirt'],
      [5, 'crystal', 'Dirt'],
    ],
    'decoration and a shard in the soil are both soil tiles',
  );
  assert.deepEqual(
    garden?.boardwalkTiles.map((tile) => [tile.id, tile.objectType, tile.tileType]),
    [[6, 'crystal', 'Boardwalk']],
    'and a shard on the boardwalk is a boardwalk tile',
  );
});

/**
 * What one tile says about itself, read through the arm its own kind selects.
 *
 * This is the reason the union is worth having, and it is a check and not a comment: `npm run typecheck`
 * compiles this file, so a field read off the wrong kind of tile (`tile.eggId` on a plant, `tile.crystalType`
 * on a decoration) is a build error rather than `undefined` at runtime.
 */
function readingOf(tile: Tile): string {
  switch (tile.objectType) {
    case 'plant':
      return `${tile.species}, ${tile.plots.length} crops`;
    case 'egg':
      return `${tile.eggId}, due ${tile.maturedAt}`;
    case 'decor':
      return `${tile.decorId} at ${tile.rotation}${tile.mountedCrop === null ? '' : `, wearing ${tile.mountedCrop.species}`}`;
    case 'crystal':
      return tile.hasLife
        ? `${tile.crystalType}, ${tile.remainingActiveSeconds}s left`
        : `${tile.crystalType}, no charge stated`;
    default:
      return tile.record.string('objectType') === ''
        ? 'no kind at all'
        : `a kind this reader does not know: ${tile.record.string('objectType')}`;
  }
}

void test("a tile is the arm its own kind declares, and carries that arm's fields", () => {
  // The four schemas the save can write, one tile each, plus a kind none of them declares and a decoration
  // with nothing mounted on it — the two arms that are easiest to get wrong, because they are the quiet ones.
  const store = new ObservableStore({
    initial: {
      data: { players: [{ id: 'p_1' }] },
      child: {
        data: {
          userSlots: [
            {
              userId: 'p_1',
              data: {
                garden: {
                  tileObjects: {
                    '0': {
                      objectType: 'plant',
                      species: 'Clover',
                      slots: [{ species: 'Clover', startTime: 0, endTime: 1_000, size: 50, slotId: 0 }],
                      plantedAt: 0,
                      maturedAt: 1_000,
                    },
                    '1': { objectType: 'egg', eggId: 'SnowEgg', plantedAt: 0, maturedAt: 60_000 },
                    '2': {
                      objectType: 'decor',
                      decorId: 'MarblePedestal',
                      rotation: 90,
                      mountedCrop: {
                        species: 'Tomato',
                        startTime: 0,
                        endTime: 2_000,
                        size: 75,
                        x: 0.1,
                        y: -0.2,
                        slotId: 3,
                      },
                    },
                    '3': { objectType: 'decor', decorId: 'Fence' },
                    '4': { objectType: 'crystal', crystalType: 'Hunger', remainingActiveSeconds: 1_440 },
                    // A crystal tile that states no charge at all, which is not the same as a spent one.
                    '5': { objectType: 'crystal', crystalType: 'XP' },
                    '6': { objectType: 'pet', species: 'Fox' },
                  },
                },
              },
            },
          ],
        },
      },
    },
  });
  const state = new StateReader(store);
  state.selfPlayerId = 'p_1';
  const tiles = state.garden(0)?.tiles ?? [];
  const byId = new Map(tiles.map((tile) => [tile.id, tile]));

  assert.deepEqual(
    tiles.map(readingOf),
    [
      'Clover, 1 crops',
      'SnowEgg, due 60000',
      'MarblePedestal at 90, wearing Tomato',
      'Fence at 0',
      'Hunger, 1440s left',
      'XP, no charge stated',
      'a kind this reader does not know: pet',
    ],
    'each tile reads as its own kind, and a kind none declares reads as the base',
  );

  // The fields themselves, arm by arm — and the ones that are absent read as the game's own defaults. Each
  // tile is bound to a local first: narrowing applies to a reference, so `byId.get(1)?.objectType === 'egg'`
  // would not narrow the *second* call to `get`.
  const plant = byId.get(0);
  const egg = byId.get(1);
  const decor = byId.get(2);
  const bareDecor = byId.get(3);
  const charged = byId.get(4);
  const bare = byId.get(5);
  const unknown = byId.get(6);
  assert.equal(plant?.objectType === 'plant' ? plant.species : null, 'Clover');
  assert.equal(plant?.objectType === 'plant' ? plant.plots.length : null, 1, 'and its plots are its `slots`');
  assert.equal(egg?.objectType === 'egg' ? egg.eggId : null, 'SnowEgg');
  assert.equal(egg?.objectType === 'egg' ? egg.maturedAt : null, 60_000);
  assert.equal(
    decor?.objectType === 'decor' ? decor.rotation : null,
    90,
    'a turned decoration states its angle',
  );
  assert.equal(
    decor?.objectType === 'decor' ? (decor.mountedCrop?.species ?? null) : null,
    'Tomato',
    'and its mounted crop is read as a crop, with the crop reader',
  );
  assert.equal(decor?.objectType === 'decor' ? (decor.mountedCrop?.x ?? null) : null, 0.1);
  assert.equal(decor?.objectType === 'decor' ? (decor.mountedCrop?.positioned ?? null) : null, true);
  assert.equal(
    bareDecor?.objectType === 'decor' ? bareDecor.mountedCrop : 'not a decoration',
    null,
    'a decoration with nothing mounted carries no crop',
  );
  assert.equal(bareDecor?.objectType === 'decor' ? bareDecor.rotation : null, 0, 'and stands at zero');
  assert.equal(charged?.objectType === 'crystal' ? charged.crystalType : null, 'Hunger');
  assert.equal(charged?.objectType === 'crystal' ? charged.remainingActiveSeconds : null, 1_440);
  assert.equal(
    charged?.objectType === 'crystal' ? charged.hasLife : null,
    true,
    'a stated charge is a charge',
  );
  assert.equal(
    bare?.objectType === 'crystal' ? bare.remainingActiveSeconds : null,
    0,
    'a charge it never stated reads as zero',
  );
  assert.equal(
    bare?.objectType === 'crystal' ? bare.hasLife : null,
    false,
    'and is told apart from a spent one',
  );

  // A kind none of the four declares is the empty kind, and the save's own spelling is still in the record:
  // the arm stands for "not one of the four" so the union narrows, and nothing the save said is lost.
  assert.equal(unknown?.objectType, '', 'a fifth kind reads as no kind');
  assert.equal(unknown?.record.string('objectType'), 'pet', 'and the record still says what the save said');
  assert.equal(unknown?.plots.length, 0, 'with the base readings it shares with every arm');

  // Every arm keeps the escape hatch, and the three readings that are on all of them.
  for (const tile of tiles) {
    assert.ok(tile.record !== undefined, `tile ${tile.id} keeps its record`);
    assert.equal(typeof tile.plantedAt, 'number');
    assert.equal(typeof tile.maturedAt, 'number');
    assert.ok(Array.isArray(tile.plots));
  }
});

void test('a crop id is the wire slotId, and a tile id is the tileObjects key', () => {
  const { state } = readerWithClock();
  const tiles = state.self?.garden?.tiles ?? [];

  assert.deepEqual(
    tiles[1]?.plots.map((crop) => crop.id),
    [7, 8],
    'slotId is a number on the wire, so the id is a number',
  );
  assert.equal(tiles[0]?.plots[0]?.id, 0);
  assert.equal(tiles[1]?.id, 30);
  assert.equal(tiles[1]?.objectType, 'plant');
  assert.equal(tiles[2]?.objectType, 'decor');
});

void test('a crop carries every field of the game grow-slot schema', () => {
  const { state } = readerWithClock();
  const crop = state.self?.garden?.tiles[1]?.plots[0];

  assert.equal(crop?.species, 'Strawberry');
  assert.equal(crop?.size, 62);
  assert.deepEqual(crop?.mutations, ['Gold', 'Wet']);
  assert.equal(crop?.x, 3);
  assert.equal(crop?.y, 4);
  assert.equal(crop?.rotation, 90);
  assert.equal(crop?.flipped, false);
  assert.equal(crop?.preserved, true);
  assert.equal(mutationName('Gold'), 'Gold');
});

void test('a tile species is the tile type, not a crop species', () => {
  const { state } = readerWithClock();
  const tile = state.self?.garden?.tiles[0];
  assert.equal(tile?.record.string('species'), 'Tomato');
  assert.equal(tile?.plots[0]?.species, 'Tomato', 'these coincide here; the types keep them apart');
});

void test('piecewise reads of the same thing agree with the whole', () => {
  const { state } = readerWithClock();
  const garden = state.self?.garden;
  assert.equal(garden?.tiles.length, state.garden(0)?.tiles.length);
  assert.deepEqual(
    garden?.tiles[1]?.plots.map((crop) => crop.id),
    state.garden(0)?.tiles[1]?.plots.map((crop) => crop.id),
  );
});

// ---------------------------------------------------------------- the clock

void test('ready and remainingMs are judged against the server clock, never the local one', () => {
  const { state, clock } = readerWithClock();
  const [ripe, growing] = state.self?.garden?.tiles[1]?.plots ?? [];

  // The local clock is two hours behind the server, so a crop that is ripe on server time is far in the
  // future locally. A `Date.now()` comparison would call this one unripe.
  assert.equal(clock.now(), LOCAL_START);
  assert.equal(ripe?.ready, true);
  assert.equal(ripe?.remainingMs, 0);
  assert.equal(growing?.ready, false);
  assert.ok((growing?.remainingMs ?? 0) > 0);
  assert.equal(
    growing?.remainingMs,
    (growing?.endTime ?? 0) - SERVER_START,
    'remaining is measured from server time',
  );
});

void test('advancing the server clock ripens a crop without any patch arriving', () => {
  const { state, clock } = readerWithClock();
  const before = state.self?.garden?.tiles[1]?.plots[1];
  assert.equal(before?.ready, false);

  clock.advance((before?.remainingMs ?? 0) + 1);

  const after = state.self?.garden?.tiles[1]?.plots[1];
  assert.equal(after?.ready, true, 'the field is not sent, it is computed');
  assert.equal(after?.remainingMs, 0);
});

// ---------------------------------------------------------------- pets and the log

void test('pets are read from petSlots, not from pets', () => {
  const store = sampleStore();
  const state = new StateReader(store);

  assert.equal(state.pets(0).length, 1);
  assert.equal(state.pets(1).length, 0);
  assert.equal(
    state.pets(0)[0]?.record.raw,
    store.get('/child/data/userSlots/0/data/petSlots/0'),
    'the wire field is petSlots',
  );
  assert.equal(state.pet('pet_1')?.name, 'Frost');
  assert.equal(state.pet('missing'), null);
});

void test('a pet carries its mutations, abilities and hunger', () => {
  const { state } = readerWithClock();
  const pet = state.self?.pets[0];
  assert.deepEqual(pet?.mutations, ['Rainbow']);
  assert.deepEqual(pet?.abilities, ['CoinFinderI', 'SnowyCoinFinder']);
  assert.equal(pet?.hunger, 44);
  assert.equal(pet?.xp, 120);
  assert.equal(pet?.sourceEggId, 'SnowEgg');
  assert.equal(pet?.targetScale, 1);
});

void test('an activity entry reads both spellings of action and parameters', () => {
  const { state } = readerWithClock();
  const log = state.self?.activityLog ?? [];

  assert.equal(log.length, 2);
  assert.equal(log[0]?.action, 'Bloom');
  assert.equal(log[1]?.action, 'Turtle-Timer', 'the capitalised spelling is read too');
  assert.equal(log[0]?.parameters.string('pet'), 'pet_1');
  assert.equal(log[1]?.parameters.string('Pet'), 'pet_1');
  assert.equal(log[0]?.timestamp, SERVER_START);
  assert.equal(log[1]?.timestamp, SERVER_START + 5);
});

// ---------------------------------------------------------------- the escape hatch

void test('the escape hatch reads a field this release does not model', () => {
  const store = sampleStore();
  const state = new StateReader(store);
  const tile = state.garden(0)?.tiles[0];

  assert.equal(tile?.record.number('plantedAt'), SERVER_START - 40_000);
  assert.equal(tile?.record.has('maturedAt'), true);
  assert.deepEqual(tile?.record.fields().sort(), [
    'maturedAt',
    'objectType',
    'plantedAt',
    'slots',
    'species',
  ]);
  assert.equal(asRecord({ a: 1 }).number('a'), 1);
  assert.equal(new StateRecord(undefined).string('anything', 'fallback'), 'fallback');
  assert.equal(asRecord(null).raw.a, undefined);
});

// ---------------------------------------------------------------- watching

void test('watch fires when a patch touches the target', async () => {
  const { state, store } = readerWithClock();
  let fired = 0;
  const stop = state.watch(state.self?.garden as never, () => {
    fired += 1;
  });

  assert.equal(fired, 0, 'never on subscribe: a baseline must be seeded by the caller');

  store.applyPatches([
    {
      op: 'add',
      path: '/child/data/userSlots/0/data/garden/tileObjects/30/slots/-',
      value: { species: 'Corn', slotId: 9 },
    },
  ]);
  assert.equal(fired, 1);
  assert.equal(state.self?.garden?.tiles[1]?.plots.length, 3);

  stop();
  store.applyPatches([{ op: 'remove', path: '/child/data/userSlots/0/data/garden/tileObjects/30/slots/2' }]);
  assert.equal(fired, 1, 'a stopped watcher is silent');
});

void test('watch ignores a change outside its target', () => {
  const { state, store } = readerWithClock();
  let fired = 0;
  const stop = state.watch(state.self?.garden as never, () => {
    fired += 1;
  });

  store.applyPatches([{ op: 'add', path: '/data/chat/-', value: { message: 'hello' } }]);
  assert.equal(fired, 0);
  stop();
});

void test('watch fires when the server clock passes an endTime, with no patch at all', async () => {
  // A crop that ripens shortly after the anchor, so the clock wake is exercised without the test waiting
  // out a real growing time. This is the case no patch can announce: `ready` is derived from `endTime`.
  const local = fixedClock(LOCAL_START);
  const serverClock = new ServerClock(local.now);
  serverClock.reset(SERVER_START);
  const store = new ObservableStore({
    initial: {
      data: { players: [{ id: 'p_1' }] },
      child: {
        data: {
          userSlots: [
            {
              userId: 'p_1',
              data: {
                garden: {
                  tileObjects: {
                    '10': {
                      objectType: 'plant',
                      species: 'Tomato',
                      slots: [
                        {
                          species: 'Tomato',
                          startTime: SERVER_START,
                          endTime: SERVER_START + 15,
                          size: 50,
                          mutations: [],
                          slotId: 0,
                        },
                      ],
                    },
                  },
                  boardwalkTileObjects: {},
                },
              },
            },
          ],
        },
      },
    },
  });
  const state = new StateReader(store, { clock: serverClock });
  state.selfPlayerId = 'p_1';

  const crop = state.self?.garden?.tiles[0]?.plots[0];
  assert.equal(crop?.ready, false);
  assert.equal(crop?.remainingMs, 15);

  let fired = 0;
  const stop = state.watch(state.self?.garden as never, () => {
    fired += 1;
  });

  // Nothing else can announce this, so the handler can only run because the watcher armed a timer.
  local.advance(15);
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.ok(fired >= 1, 'the clock wake fired the handler with no patch');
  assert.equal(state.self?.garden?.tiles[0]?.plots[0]?.ready, true);
  stop();

  // And a stopped watcher stops waking.
  local.advance(60);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fired, 1);
});

void test('a clock re-anchor re-arms a pending wake instead of dropping it', async () => {
  // A `RoomFrame` re-anchors the clock, which makes the delay already armed against the old anchor stale.
  // A watcher that only cleared its timer here would keep its subscription and never fire again.
  const local = fixedClock(LOCAL_START);
  const serverClock = new ServerClock(local.now);
  serverClock.reset(SERVER_START);
  const store = new ObservableStore({
    initial: {
      data: { players: [{ id: 'p_1' }] },
      child: {
        data: {
          userSlots: [
            {
              userId: 'p_1',
              data: {
                garden: {
                  tileObjects: {
                    '10': {
                      objectType: 'plant',
                      species: 'Tomato',
                      slots: [
                        {
                          species: 'Tomato',
                          startTime: SERVER_START,
                          endTime: SERVER_START + 200,
                          size: 50,
                          mutations: [],
                          slotId: 0,
                        },
                      ],
                    },
                  },
                  boardwalkTileObjects: {},
                },
              },
            },
          ],
        },
      },
    },
  });
  const state = new StateReader(store, { clock: serverClock });
  state.selfPlayerId = 'p_1';

  let fired = 0;
  const stop = state.watch(state.self?.garden as never, () => {
    fired += 1;
  });

  // The server's clock jumps forward, as it does when a frame's timestamp is far ahead of the anchor.
  state.observeClock(SERVER_START + 200);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fired, 1, 'the re-anchored wake still fired');
  assert.equal(state.self?.garden?.tiles[0]?.plots[0]?.ready, true);
  stop();
});

void test('watch works on a plain array of views', () => {
  const { state, store } = readerWithClock();
  let fired = 0;
  const stop = state.watch(state.self?.pets as never, () => {
    fired += 1;
  });

  store.applyPatches([
    { op: 'add', path: '/child/data/userSlots/0/data/petSlots/-', value: { id: 'pet_2', petSpecies: 'Cat' } },
  ]);
  assert.equal(fired, 1);
  assert.equal(state.self?.pets.length, 2);
  stop();
});

// ---------------------------------------------------------------- when

void test('when resolves immediately when the value is already there', async () => {
  const { state } = readerWithClock();
  const self = await state.when(
    () => state.self,
    (value): value is NonNullable<typeof value> => value !== null,
  );
  assert.equal(self.id, 'p_1');
});

void test('when waits for a value that arrives later', async () => {
  const { state, store } = readerWithClock();
  state.selfPlayerId = null;

  const pending = state.when(
    () => state.self,
    (value): value is NonNullable<typeof value> => value !== null,
    { timeoutMs: 500 },
  );

  state.selfPlayerId = 'p_1';
  store.applyPatches([{ op: 'add', path: '/data/chat/-', value: { message: 'wake' } }]);

  assert.equal((await pending)?.id, 'p_1');
});

void test('when rejects on timeout and on an aborted signal', async () => {
  const { state } = readerWithClock();
  state.selfPlayerId = null;

  await assert.rejects(
    state.when(
      () => state.self,
      (value) => value !== null,
      { timeoutMs: 10 },
    ),
    StateWaitError,
  );

  const controller = new AbortController();
  const pending = state.when(
    () => state.self,
    (value) => value !== null,
    {
      signal: controller.signal,
    },
  );
  controller.abort();
  await assert.rejects(pending, StateWaitError);
});

// ---------------------------------------------------------------- the clock itself

void test('the clock reports skew and refuses an unusable anchor', () => {
  const local = fixedClock(LOCAL_START);
  const clock = new ServerClock(local.now);
  const state = new StateReader(new ObservableStore(), { clock });

  assert.equal(state.skewMs, null, 'no anchor yet');
  assert.equal(state.now(), LOCAL_START, 'un-anchored reads the local clock');
  assert.equal(state.anchorClock(SERVER_START), true);
  assert.equal(state.skewMs, SERVER_AHEAD_MS);
  assert.equal(state.now(), SERVER_START);
  assert.equal(state.anchorClock('not a number'), false);
  assert.equal(state.observeClock(undefined), false);
});
