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
import { mutationName } from '../../src/state/entities.js';
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
          { id: 'p_1', name: 'Ada', discordUserId: '111', coins: 1250 },
          { id: 'p_2', name: 'Bo' },
          { id: 'p_3', name: 'Cy', databaseUserId: '333', coins: 40 },
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
  assert.equal(state.room.players[0]?.coins, 1250);
  assert.deepEqual(
    state.room.chat.map((record) => record.raw),
    store.get('/data/chat'),
  );
  assert.equal(state.room.hostPlayerId, store.get('/data/hostPlayerId'));
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
