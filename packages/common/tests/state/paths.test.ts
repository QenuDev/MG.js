/**
 * Every surviving path helper produces the literal the field guide documents.
 *
 * ## Why this file exists
 *
 * `state/paths.ts` is a module of constants and three-line functions whose entire value is the string they
 * produce, and until Phase 6 **not one of them had a test**. The module's own header claimed each path was
 * "quoted from the protocol field guide's state-model section", which made the documentation and the code two
 * separate statements of the same fact with nothing keeping them equal: rewriting `/data/players` as
 * `/data/player` would have changed a public helper's answer silently, and nothing in the suite would have
 * noticed. That is the same shape as every other defect this programme has removed, in a module where it is
 * cheapest to fix.
 *
 * So each assertion below is a literal, not a call to another helper: asserting `PLAYERS === \`${ROOM_ROOT}
 * /players\`` would only prove the composition is self-consistent, which it would be even if both halves were
 * wrong. The literals come from the field guide, and the point is that the code agrees with them.
 *
 * Phase 6's audit decided this module name by name. Eight helpers nothing read were deleted, including
 * `signatureOf`, which implemented the string-signature diffing `state/store.ts` explicitly rejects. What
 * remains is what a caller can actually want, and this file is the acceptance Phase 6 owes for keeping it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activityLogs,
  CHAT,
  findPlayerIndex,
  GAME_ROOT,
  HOST_PLAYER_ID,
  PLAYERS,
  player,
  playerCount,
  ROOM_ROOT,
  USER_SLOTS,
} from '../../src/state/paths.js';

/** The field guide's own two prefixes, written here as literals rather than imported. */
const ROOM = '/data';
const GAME = '/child/data';

void test('the room-state paths are the documented literals', () => {
  assert.equal(ROOM_ROOT, ROOM);
  assert.equal(PLAYERS, '/data/players');
  assert.equal(HOST_PLAYER_ID, '/data/hostPlayerId');
  assert.equal(CHAT, '/data/chat');
  assert.equal(player(0), '/data/players/0');
  assert.equal(player(12), '/data/players/12', 'the index is interpolated, not appended at a fixed width');
});

void test('the game-state paths are the documented literals', () => {
  assert.equal(GAME_ROOT, GAME);
  assert.equal(USER_SLOTS, '/child/data/userSlots');
  assert.equal(activityLogs(2), '/child/data/userSlots/2/data/activityLogs');
});

void test('playerCount reads defensively rather than throwing on an unpopulated tree', () => {
  // Documented behaviour, and the reason is startup: the state is empty until the first patch lands, and a
  // helper that throws there would be useless in the moment a caller reaches for it.
  assert.equal(playerCount(null), 0);
  assert.equal(playerCount(undefined), 0);
  assert.equal(playerCount('nonsense'), 0);
  assert.equal(playerCount({}), 0);
  assert.equal(playerCount({ data: {} }), 0);
  assert.equal(playerCount({ data: { players: 'not an array' } }), 0);
  assert.equal(playerCount({ data: { players: [] } }), 0);
  assert.equal(playerCount({ data: { players: [{ id: 'a' }, { id: 'b' }] } }), 2);
});

void test('findPlayerIndex reports -1 rather than 0 when there is no match', () => {
  const game = { data: { players: [{ id: 'a' }, { id: 'b' }] } };

  assert.equal(findPlayerIndex(game, 'b'), 1);
  assert.equal(
    findPlayerIndex(game, 'a'),
    0,
    'index 0 is a real answer and must not be confused with a miss',
  );
  assert.equal(findPlayerIndex(game, 'missing'), -1);
  assert.equal(findPlayerIndex(null, 'a'), -1);
  assert.equal(findPlayerIndex({ data: {} }, 'a'), -1);
  assert.equal(
    findPlayerIndex({ data: { players: [null, { id: 'a' }] } }, 'a'),
    1,
    'a null entry in the list must not throw while scanning',
  );
});
