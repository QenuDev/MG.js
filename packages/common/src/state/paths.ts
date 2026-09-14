/**
 * Typed path helpers for the state locations the documentation actually names.
 *
 * Every path here is quoted from the protocol field guide's state-model section, so a caller who wants
 * "player slot 2's activity log" does not have to remember that room state is at `/data` while game state is
 * two levels down at `/child/data`. Each surviving one is pinned against the documented literal by
 * `tests/state/paths.test.ts`: a helper whose whole value is the string it produces must not be able to drift
 * from the documentation quietly.
 *
 * Phase 6 removed the eight helpers here that nothing read: the two Discord id spellings, the coin path, the
 * two activity-log field names, the slot garden and inventory paths, and `signatureOf`, which implemented the
 * string-signature diffing `state/store.ts` explicitly rejects because this library receives a patch stream
 * instead of polling. Reasons per name: `docs/plans/2026-09-13-phase-6-inert-surface.md`.
 *
 * The tree is rooted at the whole `fullState` object:
 *
 *     { data: { players, chat, hostPlayerId, ... },        // room state
 *       child: { data: { userSlots, garden, ... } } }      // game state
 */

/** Room-state prefix: players, chat, host. */
export const ROOM_ROOT = '/data';

/** Game-state prefix: garden tiles, inventory, shops, weather. */
export const GAME_ROOT = '/child/data';

/** The player list. Each entry has `id` (matching `selfPlayerId`) and a Discord id field. */
export const PLAYERS = `${ROOM_ROOT}/players`;

/** The room host's player id. */
export const HOST_PLAYER_ID = `${ROOM_ROOT}/hostPlayerId`;

/** The room's chat log. */
export const CHAT = `${ROOM_ROOT}/chat`;

/** A specific player record. */
export function player(index: number): string {
  return `${PLAYERS}/${index}`;
}

/** The per-slot user array. Indexed by player slot. */
export const USER_SLOTS = `${GAME_ROOT}/userSlots`;

/**
 * A player slot's activity log.
 *
 * The field guide describes the technique this powers: "diff the array length, and for each new entry
 * check `action` against the game's known ability-name list and read `parameters.pet` for who did it."
 */
export function activityLogs(slotIndex: number): string {
  return `${USER_SLOTS}/${slotIndex}/data/activityLogs`;
}

/**
 * The number of players in the room, or `0` when the list is not present yet.
 *
 * Reads defensively: the state may be empty before the first patch lands, and a helper that throws on
 * a not-yet-populated tree would be useless during startup.
 */
export function playerCount(gameState: unknown): number {
  if (gameState === null || typeof gameState !== 'object') return 0;
  const players = (gameState as { data?: { players?: unknown } }).data?.players;
  return Array.isArray(players) ? players.length : 0;
}

/**
 * Find a player's index by id.
 *
 * @returns the array index, or `-1`.
 */
export function findPlayerIndex(gameState: unknown, playerId: string): number {
  if (gameState === null || typeof gameState !== 'object') return -1;
  const players = (gameState as { data?: { players?: unknown } }).data?.players;
  if (!Array.isArray(players)) return -1;
  return players.findIndex(
    (entry) => entry !== null && typeof entry === 'object' && (entry as { id?: unknown }).id === playerId,
  );
}
