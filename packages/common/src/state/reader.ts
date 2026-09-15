/**
 * The read API: `client.state`, the shapes a mod author actually types.
 *
 * ## The tree, as the game sends it
 *
 *     userSlots[i].data.garden.tileObjects[<tile>]      a tile
 *                                   .slots[<n>]         a crop planted on it
 *
 * Room state is rooted at `/data` and game state two levels down at `/child/data`, and a player's
 * garden is reached through their own slot rather than through the room. None of that is visible here:
 * a view knows where it came from, so a caller walks objects instead of pointers.
 *
 * ## The two ways to be absent
 *
 * A lookup that finds nothing is `null` or an empty array, never a throw and never `undefined`:
 * `state.self` is `null` until the room names the caller, and `player.garden` is `null` when the join
 * from a room player to their slot failed. A garden with no tiles is a garden. The distinction matters
 * because the failure mode of confusing them is a loop that silently does nothing.
 *
 * ## Derived values, and why watching is not just change delivery
 *
 * `crop.ready` and `crop.remainingMs` are not fields the server sends; the game computes them from
 * `endTime` against its own clock. So no patch ever announces the moment a crop ripens. {@link
 * StateReader.watch} therefore arms a timer for the next `endTime` under its target and re-arms after
 * every delivery, because a watcher that only fired on patches could never see a crop become ready.
 *
 * ## Typed where the game defines a field
 *
 * `entities.ts` types every field the game's own bundle defines, with the schema each was read from
 * named in the comment. Anything the bundle does not pin stays readable by name through
 * {@link StateRecord}, which is the one deliberate escape hatch for a mod that cannot wait for a
 * release of this library. There is no other place in the public API where a field name is a string.
 */

import { unrefTimer } from '../poll.js';
import { asFiniteMs, ServerClock } from './clock.js';
import type {
  ActivityEntry,
  Crop,
  Currency,
  Garden,
  Inventory,
  InventoryItem,
  Mutation,
  Pet,
  Player,
  PlayerRecord,
  Room,
  StateRecordLike,
  Storage,
  Tile,
  TileType,
} from './entities.js';
import { ACTIVITY_ACTION_FIELDS, ACTIVITY_PARAMETER_FIELDS, DISCORD_ID_FIELDS } from './entities.js';
import {
  activityLogs,
  CHAT,
  GAME_ROOT,
  HOST_PLAYER_ID,
  PLAYERS,
  player as playerPath,
  ROOM_ROOT,
  USER_SLOTS,
} from './paths.js';
import { pointerContains } from './pointer.js';
import type { ObservableStore, StateChange } from './store.js';

/** Anything a watcher can be pointed at. Every view carries the path it was built from. */
export interface Watchable {
  /** The store path this view reads, which is what a change is matched against. */
  readonly entityPath: string;
}

/** What {@link StateReader.watch} accepts: one view, or a plain array of views. */
export type WatchTarget = Watchable | readonly Watchable[];

/** Options for {@link StateReader.when}. */
export interface WaitOptions {
  /** Reject after this many milliseconds with a {@link StateWaitError}. */
  readonly timeoutMs?: number | undefined;
  /** Cancel the wait. */
  readonly signal?: AbortSignal | undefined;
}

/** Thrown when a {@link StateReader.when} wait times out or is cancelled. */
export class StateWaitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateWaitError';
  }
}

/**
 * One game object read field by field.
 *
 * Every getter takes its fallback, so a missing or wrongly-typed field returns what the caller asked
 * for instead of `undefined`. That is the point of an escape hatch: a field this library has not typed
 * yet is still reachable, and a name that changed in a game update degrades to a default the caller
 * chose.
 */
export class StateRecord implements StateRecordLike {
  /** The raw object, when a caller needs a field this class does not cover. */
  readonly raw: Record<string, unknown>;

  constructor(value: unknown) {
    this.raw = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  }

  /** The field as a string, when it is one. */
  string(field: string, fallback = ''): string {
    const value = this.raw[field];
    return typeof value === 'string' ? value : fallback;
  }

  /**
   * The field as a string, accepting a number and rendering it.
   *
   * The game's own schema uses both for identifiers: a pet's `id` is declared as a string, while a
   * grow slot's `slotId` is a plain number. A caller holding one of them wants a string either way, so
   * a string-only getter would silently drop every numeric id.
   */
  id(field: string, fallback = ''): string {
    const value = this.raw[field];
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return fallback;
  }

  /** The field as a finite number, when it is one. `NaN` and `Infinity` fall back. */
  number(field: string, fallback = 0): number {
    const value = this.raw[field];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  /** The field as a boolean, when it is one. */
  boolean(field: string, fallback = false): boolean {
    const value = this.raw[field];
    return typeof value === 'boolean' ? value : fallback;
  }

  /**
   * The field as an array of records, or an empty array.
   *
   * Never `null`, so a loop over a field that is absent or mistyped can be written plainly.
   */
  records(field: string): StateRecordLike[] {
    const value = this.raw[field];
    if (!Array.isArray(value)) return [];
    return value.map((entry) => new StateRecord(entry));
  }

  /** One nested object as a record, or an empty record when the field is absent. */
  record(field: string): StateRecordLike {
    return new StateRecord(this.raw[field]);
  }

  /** True when the field is present with any value other than `undefined`. */
  has(field: string): boolean {
    return this.raw[field] !== undefined;
  }

  /** The field names this object actually carries, which is how a caller discovers what changed. */
  fields(): string[] {
    return Object.keys(this.raw);
  }

  /** A value at a slash-separated path below this object. */
  read(path: string): unknown {
    let current: unknown = this.raw;
    for (const segment of path.split('/')) {
      if (segment === '') continue;
      if (current === null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  }
}

/** Wrap a value as a record. `asRecord(undefined)` is an empty record rather than a throw. */
export function asRecord(value: unknown): StateRecord {
  return new StateRecord(value);
}

/** A mutation list, keeping only strings, which is all the game sends. */
function toMutations(value: unknown): Mutation[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Mutation => typeof entry === 'string');
}

/** The string entries of an array field. */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * One player as the room's own list carries them.
 *
 * The room player schema is `{ id, name, ... }` and no more: it is the room's list of who is here, and it
 * carries no balance. The Discord id has two documented spellings, so both are probed.
 */
export function toPlayerRecord(value: unknown): PlayerRecord {
  const record = new StateRecord(value);
  return {
    id: record.string('id'),
    name: record.string('name'),
    discordUserId: record.string(DISCORD_ID_FIELDS[0]),
    databaseUserId: record.string(DISCORD_ID_FIELDS[1]),
    hasDiscordId: DISCORD_ID_FIELDS.some((field) => record.string(field) !== ''),
  };
}

/**
 * One inventory entry, from the game's own item union.
 *
 * Every kind of item has its own schema, and all of them are told apart by `itemType`. The fields a kind
 * does not carry read as their empty value rather than being left off, so a caller that switches on
 * `itemType` sees a whole item either way and never has to test whether a field exists.
 *
 * `hasLife` exists because a consumable tool's `remainingActiveSeconds` can legitimately be `0`, and `0` is
 * not the same as the field being absent: a spent tool and a tool that never had a life are two different
 * items, and the save tells them apart only by whether the field is there.
 */
export function toInventoryItem(value: unknown, entityPath: string, nowMs = 0): InventoryItem {
  const record = new StateRecord(value);
  return {
    entityPath,
    itemType: record.string('itemType'),
    id: record.id('id'),
    // A pet in the bag is the one kind whose species is spelled `petSpecies`, the same as a pet in a slot.
    species: record.string('petSpecies') || record.string('species'),
    // A stack with no stated quantity is one item, which is what the save's own default says.
    quantity: record.number('quantity', 1),
    size: record.number('size'),
    mutations: toStringArray(record.read('mutations')),
    toolId: record.id('toolId'),
    remainingActiveSeconds: record.number('remainingActiveSeconds'),
    hasLife: record.has('remainingActiveSeconds'),
    eggId: record.string('eggId'),
    decorId: record.string('decorId'),
    name: record.string('name'),
    // A potted plant's crops live under the same `slots` field a garden tile's do.
    crops: toCrops(record.read('slots'), nowMs, `${entityPath}/slots`),
    record,
  };
}

/** One container: the decoration it came from, its size, and what is inside it. */
export function toStorage(value: unknown, entityPath: string, nowMs = 0): Storage {
  const record = new StateRecord(value);
  return {
    entityPath,
    decorId: record.string('decorId'),
    capacitySlots: record.number('capacitySlots'),
    items: toInventoryItems(record.read('items'), `${entityPath}/items`, nowMs),
    record,
  };
}

/** A list of inventory entries, each carrying its own path. */
export function toInventoryItems(value: unknown, entityPath: string, nowMs = 0): InventoryItem[] {
  if (!Array.isArray(value)) return [];
  const items: InventoryItem[] = [];
  for (let index = 0; index < value.length; index += 1) {
    items.push(toInventoryItem(value[index], `${entityPath}/${index}`, nowMs));
  }
  return items;
}

/** Everything a player owns, from `userSlots[<n>]/data/inventory`. */
export function toInventory(value: unknown, entityPath: string, nowMs = 0): Inventory {
  const record = new StateRecord(value);
  const rawStorages = record.read('storages');
  const storages: Storage[] = [];
  if (Array.isArray(rawStorages)) {
    for (let index = 0; index < rawStorages.length; index += 1) {
      storages.push(toStorage(rawStorages[index], `${entityPath}/storages/${index}`, nowMs));
    }
  }
  return {
    items: toInventoryItems(record.read('items'), `${entityPath}/items`, nowMs),
    storages,
  };
}

/**
 * What a player can spend, from the saved object their garden also lives in.
 *
 * The room's list of players does not carry a balance, so this is read from the player's own slot. Both
 * fields keep the save's names: `coinsCount` and `magicDustCount`.
 */
export function toCurrency(value: unknown): Currency {
  const record = new StateRecord(value);
  return {
    coinsCount: record.number('coinsCount'),
    magicDustCount: record.number('magicDustCount'),
  };
}

/**
 * One activity-log entry.
 *
 * The guide's own examples use both spellings of `action` and `parameters`, so each pair is probed in
 * order.
 */
export function toActivityEntry(value: unknown, entityPath: string): ActivityEntry {
  const record = new StateRecord(value);
  const parameters = new StateRecord(
    record.raw[ACTIVITY_PARAMETER_FIELDS[0]] ?? record.raw[ACTIVITY_PARAMETER_FIELDS[1]],
  );
  return {
    entityPath,
    action: record.string(ACTIVITY_ACTION_FIELDS[0]) || record.string(ACTIVITY_ACTION_FIELDS[1]),
    // `timestamp` is not in the game's declared schema, so it is read through the escape hatch. The
    // log is capped, which makes it the only usable watermark for "since I last looked".
    timestamp: record.number('timestamp'),
    parameters,
    record,
  };
}

/**
 * One crop, typed from the grow-slot schema `Uo` in the game's own bundle:
 *
 *     Uo = d({ species, startTime, endTime, size, mutations, x, y, rotation, flipped, preserved, slotId })
 *
 * `ready` and `remainingMs` are computed here against server time, which is what the game compares
 * against, because the server sends neither.
 *
 * `id` is the wire's `slotId`, which the schemas declare as a number and which the commands send as
 * `slotsIndex` / `growSlotIdx`.
 */
/**
 * The crops under a `slots` array.
 *
 * Both a garden tile and a potted plant keep what is growing in them under `slots`, so one reader serves
 * both and a plant in the bag reports its crops the way a tile does.
 */
export function toCrops(value: unknown, nowMs: number, entityPath: string): Crop[] {
  if (!Array.isArray(value)) return [];
  const crops: Crop[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (entry === null || typeof entry !== 'object') continue;
    crops.push(toCrop(entry, nowMs, `${entityPath}/slots/${index}`));
  }
  return crops;
}

export function toCrop(value: unknown, nowMs: number, entityPath: string): Crop {
  const record = new StateRecord(value);
  const endTime = record.number('endTime');
  const remainingMs = endTime > 0 ? Math.max(0, endTime - nowMs) : 0;

  return {
    entityPath,
    id: record.number('slotId'),
    species: record.string('species'),
    startTime: record.number('startTime'),
    endTime,
    size: record.number('size'),
    mutations: toMutations(record.raw['mutations']),
    x: record.number('x'),
    y: record.number('y'),
    rotation: record.number('rotation'),
    positioned: record.has('x') || record.has('y'),
    flipped: record.boolean('flipped'),
    preserved: record.boolean('preserved'),
    ready: endTime > 0 && remainingMs === 0,
    remainingMs,
    record,
  };
}

/**
 * One garden tile, typed from the tile schema `ts` in the game's own bundle:
 *
 *     ts = d({ objectType, species, slots, plantedAt, maturedAt })
 *
 * @param id The tile's key in its own map, which the schemas declare as a number.
 * @param tileType Which of the garden's two maps it was read from, because the keys of one do not address
 *   the other. The tile itself does not carry this: the map it is keyed in is where the game says it.
 */
export function toTile(
  id: number,
  value: unknown,
  nowMs: number,
  entityPath: string,
  tileType: TileType,
): Tile {
  const record = new StateRecord(value);
  const plots = toCrops(record.raw['slots'], nowMs, entityPath);

  return {
    entityPath,
    tileType,
    id,
    objectType: record.string('objectType'),
    plantedAt: record.number('plantedAt'),
    maturedAt: record.number('maturedAt'),
    plots,
    record,
  };
}

/**
 * One garden, from `userSlots[i].data.garden`.
 *
 * The game's two tile maps are read as two, never merged: they are keyed independently, so the same number
 * can address a soil tile and a boardwalk tile at once and a merge would drop one of them. Each tile says
 * which ground it came from, so a caller that wants one list can join them without losing the distinction.
 *
 * @returns `null` when the value is not an object at all, which is how a failed slot join surfaces.
 */
export function toGarden(value: unknown, nowMs: number, entityPath: string): Garden | null {
  if (value === null || typeof value !== 'object') return null;
  const record = new StateRecord(value);

  /**
   * One of the garden's two tile maps, read in id order.
   *
   * The maps are read separately rather than merged: their keys are independent, so the same number can
   * address a plantable tile and a boardwalk tile at once, and merging would drop one of them.
   */
  const readMap = (field: string, tileType: TileType): Tile[] => {
    const map = record.raw[field];
    if (map === null || typeof map !== 'object') return [];
    const found: Tile[] = [];
    for (const [key, tile] of Object.entries(map as Record<string, unknown>)) {
      const id = Number(key);
      // A non-numeric key cannot be sent back to the server as a tile index, so it is not a tile.
      if (!Number.isInteger(id)) continue;
      found.push(toTile(id, tile, nowMs, `${entityPath}/${field}/${key}`, tileType));
    }
    return found.sort((left, right) => left.id - right.id);
  };

  return {
    entityPath,
    tiles: readMap('tileObjects', 'Dirt'),
    boardwalkTiles: readMap('boardwalkTileObjects', 'Boardwalk'),
    record,
  };
}

/**
 * One pet, typed from the game's pet record schema.
 *
 * `petSpecies` is what makes a record a pet, so a slot without one is not returned. A pet in a bag or
 * a storage is an inventory item rather than one of these.
 */
export function toPet(value: unknown, entityPath: string): Pet | null {
  if (value === null || typeof value !== 'object') return null;
  const record = new StateRecord(value);
  const species = record.string('petSpecies');
  if (species === '') return null;

  return {
    entityPath,
    id: record.string('id'),
    species,
    name: record.string('name'),
    xp: record.number('xp'),
    hunger: record.number('hunger'),
    mutations: toMutations(record.raw['mutations']),
    targetScale: record.number('targetScale'),
    abilities: toStringArray(record.raw['abilities']),
    sourceEggId: record.string('sourceEggId'),
    record,
  };
}

/** Options for {@link StateReader}. */
interface StateReaderOptions {
  /** Applied to paths before they are used for subscriber matching. */
  readonly normalizePath?: ((path: string) => string) | undefined;
  /** The clock to judge crop timings against. Defaults to one anchored from `Welcome`. */
  readonly clock?: ServerClock | undefined;
}

/**
 * One live watcher: what it watches, what it runs, and the timer that wakes it.
 *
 * The target is held so the clock wake can be recomputed. When a `RoomFrame` re-anchors the clock, every
 * pending wake is stale, and a watcher that only had a timer would have no way to arm another one: it would
 * keep its subscription and never fire again.
 */
interface Watcher {
  readonly paths: readonly string[];
  readonly handler: () => void;
  readonly target: unknown;
  timer: ReturnType<typeof setTimeout> | null;
  wakeAt: number | null;
}

/** Every numeric `endTime` reachable from a watch target, which is what a clock wake is armed from. */
function endTimesIn(target: unknown, into: number[]): void {
  if (target === null || typeof target !== 'object') return;
  if (Array.isArray(target)) {
    for (const entry of target) endTimesIn(entry, into);
    return;
  }
  const candidate = target as Partial<Crop> & Partial<Garden> & Partial<Tile>;
  if (typeof candidate.endTime === 'number') into.push(candidate.endTime);
  if (Array.isArray(candidate.plots)) endTimesIn(candidate.plots, into);
  if (Array.isArray(candidate.tiles)) endTimesIn(candidate.tiles, into);
}

/** The store paths a target reads, used to decide whether a change touched it. */
function pathsOf(target: WatchTarget): string[] {
  const list = Array.isArray(target) ? target : [target as Watchable];
  const paths: string[] = [];
  for (const entry of list) {
    const path = (entry as Partial<Watchable> | null)?.entityPath;
    if (typeof path === 'string' && path !== '') paths.push(path);
  }
  return paths;
}

/**
 * True when a change to `moved` can have changed what `watched` reads.
 *
 * Deliberately one-directional: a change to a *descendant* of what a view reads can change that view, but a
 * change to its *ancestor* cannot. `state.watch(crop, ...)` must not fire because a sibling crop was planted
 * on the same tile.
 *
 * The `-` token needs the special case. RFC 6902 uses it to mean "the end of the array", so the store
 * reports an append as `/petSlots/-`, while the view built after that append reads `/petSlots/7`. A literal
 * comparison misses every append, which is a silent failure: the handler simply never runs.
 */
function changeTouches(watched: string, moved: string): boolean {
  if (watched === '') return true;

  const watchedTokens = watched.split('/');
  const movedTokens = moved.split('/');
  if (movedTokens.length < watchedTokens.length) return false;

  for (let index = 0; index < watchedTokens.length; index += 1) {
    // `-` addresses any array position, including one that did not exist when the view was built. It can
    // appear at the end of the path (a plain append) or in the middle of one (an append inside a tile).
    if (movedTokens[index] === '-') continue;
    if (movedTokens[index] !== watchedTokens[index]) return false;
  }

  return true;
}

/**
 * Named reads over one store, as objects rather than as paths.
 *
 * Construct it around a store, or take the one a client already built: `client.state`. The accessors
 * are the documented anchors; anything not covered here reads through {@link StateReader.get} with the
 * constants from `paths.ts`.
 */
export class StateReader {
  /** The store behind this reader, for a path that has no accessor yet. */
  readonly store: ObservableStore;

  /**
   * The clock crop timings are judged against.
   *
   * Anchored from `Welcome.publishedAtServerMs` and refreshed by every `RoomFrame`, which is what the
   * game itself does. {@link now} is therefore server milliseconds, so a crop the game draws as ready
   * is one this reports as ready even when the local clock is wrong.
   */
  readonly clock: ServerClock;

  /**
   * The current player's own id, which the client sets from `Welcome`.
   *
   * Held here as well as read from the tree, because `selfPlayerId` is a property of the connection and
   * the tree does not always carry it.
   */
  selfPlayerId: string | null = null;

  private readonly normalize: (path: string) => string;
  private readonly watchers = new Set<Watcher>();
  private static readonly readers = new WeakMap<ObservableStore, StateReader>();

  constructor(store: ObservableStore, options: StateReaderOptions = {}) {
    this.store = store;
    this.clock = options.clock ?? new ServerClock();
    this.normalize = options.normalizePath ?? ((path: string) => path);
  }

  /**
   * The reader for a store, created once per store.
   *
   * The clients go through this, so `client.state` is one object per client rather than a new one per
   * access, which matters when a mod holds it in a variable across a reload.
   */
  static of(store: ObservableStore, options: StateReaderOptions = {}): StateReader {
    const existing = StateReader.readers.get(store);
    if (existing !== undefined) return existing;
    const reader = new StateReader(store, options);
    StateReader.readers.set(store, reader);
    return reader;
  }

  // ------------------------------------------------------------------ the tree

  /**
   * The room, and the players in it.
   *
   * Safe to read before the first state arrives: it is a room with no players rather than `null`.
   */
  get room(): Room {
    const nowMs = this.clock.now();
    const value = this.store.get(PLAYERS);
    const rawPlayers = Array.isArray(value) ? value : [];

    const players: Player[] = [];
    for (let index = 0; index < rawPlayers.length; index += 1) {
      players.push(this.toPlayer(rawPlayers[index], index, rawPlayers.length, nowMs));
    }

    return {
      entityPath: ROOM_ROOT,
      players,
      hostPlayerId: this.hostPlayerId(),
      chat: this.chatRecords(),
      record: new StateRecord(this.store.get(ROOM_ROOT)),
    };
  }

  /**
   * The caller's own player, or `null` until the room names them.
   *
   * This is the one shortcut in the tree, and it exists because only the library knows which player is
   * the caller: resolving your own id is {@link selfPlayerId}, which the connection owns. Every other
   * collection is reached through its owner.
   */
  get self(): Player | null {
    const players = this.room.players;
    const id = this.selfPlayerId;
    if (id === null || id === '') return null;
    for (const player of players) {
      if (player.id === id) return player;
    }
    return null;
  }

  /** The server's time now, in server milliseconds. */
  now(): number {
    return this.clock.now();
  }

  /** How far the server is ahead of this machine, or `null` before the first `Welcome`. */
  get skewMs(): number | null {
    return this.clock.skewMs;
  }

  /** The store's version, which increments on every applied change. */
  get version(): number {
    return this.store.version;
  }

  /** Read any path. A thin pass-through, so every read in a mod can go through one object. */
  get(path: string): unknown {
    return this.store.get(path);
  }

  /** A deep copy of the whole tree, which is what the devtools console wants. */
  snapshot(): unknown {
    return this.store.snapshot();
  }

  /** True when the path resolves. */
  has(path: string): boolean {
    return this.store.has(path);
  }

  // --------------------------------------------------------------- room state

  /** Every room member, typed from the room's own player list. */
  players(): PlayerRecord[] {
    const value = this.store.get(PLAYERS);
    if (!Array.isArray(value)) return [];
    return value.map((entry) => toPlayerRecord(entry));
  }

  /** One room member's record by array index. */
  player(index: number): PlayerRecord {
    return toPlayerRecord(this.store.get(playerPath(index)));
  }

  /**
   * A room member by id, or `null`.
   *
   * The guide's own way to confirm that authentication took: "find your own record in `players` by id
   * and check for a `discordUserId` field".
   */
  playerById(playerId: string): PlayerRecord | null {
    for (const record of this.players()) {
      if (record.id === playerId) return record;
    }
    return null;
  }

  /** The room host's player id, or `null` before it is known. */
  hostPlayerId(): string | null {
    const value = this.store.get(HOST_PLAYER_ID);
    return typeof value === 'string' && value !== '' ? value : null;
  }

  /** The room's chat log. Loose, because neither document names a chat message's fields. */
  chat(): StateRecord[] {
    return this.chatRecords().map((entry) => entry as StateRecord);
  }

  // --------------------------------------------------------------- game state

  /** The game-state root, `/child/data`. */
  game(): unknown {
    return this.store.get(GAME_ROOT);
  }

  /**
   * One player slot's garden, or `null` when the slot has no garden object.
   *
   * Prefer walking there through a player: `state.self?.garden`. This is the direct read for a slot a
   * caller already knows the index of.
   */
  garden(slotIndex: number): Garden | null {
    const path = `${USER_SLOTS}/${slotIndex}/data/garden`;
    return toGarden(this.store.get(path), this.clock.now(), path);
  }

  /** One player slot's pets. */
  pets(slotIndex: number): Pet[] {
    const field = `${USER_SLOTS}/${slotIndex}/data/petSlots`;
    const value = this.store.get(field);
    if (!Array.isArray(value)) return [];
    const pets: Pet[] = [];
    for (let index = 0; index < value.length; index += 1) {
      // The path uses the array index rather than the result length, so an entry that is not a pet does
      // not shift every later pet's path.
      const pet = toPet(value[index], `${field}/${index}`);
      if (pet !== null) pets.push(pet);
    }
    return pets;
  }

  /** One pet by id across every slot, or `null`. */
  pet(petId: string): Pet | null {
    const value = this.store.get(USER_SLOTS);
    if (!Array.isArray(value)) return null;
    for (let index = 0; index < value.length; index += 1) {
      for (const pet of this.pets(index)) {
        if (pet.id === petId) return pet;
      }
    }
    return null;
  }

  /** One player slot's activity log. */
  activityLogs(slotIndex: number): ActivityEntry[] {
    const value = this.store.get(activityLogs(slotIndex));
    if (!Array.isArray(value)) return [];
    return value.map((entry, index) => toActivityEntry(entry, `${activityLogs(slotIndex)}/${index}`));
  }

  /**
   * The slot index of the caller's own player, or `null`.
   *
   * The room lists players and the game tree lists slots, and nothing in either says they line up. The
   * documented ways to join them are tried in order: the slot's own `userId`, then `playerId`, then the
   * slot data's `playerId`. A slot whose ids are all absent is not claimed.
   */
  selfSlotIndex(): number | null {
    const id = this.selfPlayerId;
    if (id === null || id === '') return null;
    const value = this.store.get(USER_SLOTS);
    if (!Array.isArray(value)) return null;

    for (let index = 0; index < value.length; index += 1) {
      const slot = value[index];
      if (slot === null || typeof slot !== 'object') continue;
      const raw = slot as Record<string, unknown>;
      const data = raw['data'];
      const candidates = [
        raw['userId'],
        raw['playerId'],
        data !== null && typeof data === 'object' ? (data as Record<string, unknown>)['playerId'] : undefined,
      ];
      if (candidates.some((candidate) => typeof candidate === 'string' && candidate === id)) {
        return index;
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ changes

  /**
   * Run a handler when anything under a target changes, and when a crop under it ripens.
   *
   * Two deliveries, both needed:
   *
   * - a patch touched a path under the target, which is ordinary change notification;
   * - the server clock passed an `endTime` under the target. `ready` is derived, so no patch announces
   *   it, and a watcher without this could never see a crop become ready.
   *
   * The handler is called with no arguments, because a re-read inside it is already current: patches
   * are applied before subscribers run. The handler never fires on subscribe; seed your baseline
   * before calling this, which is what makes "a player joined" mean joined rather than present.
   */
  watch(target: WatchTarget, handler: () => void): () => void {
    const paths = pathsOf(target).map((path) => this.normalize(path));
    const watcher: Watcher = { paths, handler, target, timer: null, wakeAt: null };

    const subscription =
      paths.length === 0
        ? null
        : this.store.subscribeAll((change: StateChange) => {
            for (const path of change.changedPaths) {
              const moved = this.normalize(path);
              for (const watched of paths) {
                if (changeTouches(watched, moved)) {
                  this.arm(watcher, target);
                  handler();
                  return;
                }
              }
            }
          });

    this.watchers.add(watcher);
    this.arm(watcher, target);

    return () => {
      if (watcher.timer !== null) clearTimeout(watcher.timer);
      watcher.timer = null;
      this.watchers.delete(watcher);
      subscription?.();
    };
  }

  /**
   * Resolve the first value a selector returns that satisfies a predicate.
   *
   * This is the arrival gate every mod needs at startup: `state.self` is `null` until the room names
   * the caller, and this waits for it once instead of leaving a null check on every later line.
   */
  when<T, S extends T>(
    select: () => T,
    predicate: (value: T) => value is S,
    options?: WaitOptions,
  ): Promise<S>;
  when<T>(select: () => T, predicate: (value: T) => boolean, options?: WaitOptions): Promise<T>;
  when<T>(select: () => T, predicate: (value: T) => boolean, options: WaitOptions = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = options.timeoutMs;
      const signal = options.signal;

      if (signal?.aborted === true) {
        reject(new StateWaitError('state wait was aborted before it started'));
        return;
      }

      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = (outcome: () => void): void => {
        if (timer !== null) clearTimeout(timer);
        subscription();
        signal?.removeEventListener('abort', onAbort);
        outcome();
      };
      const onAbort = (): void => {
        settle(() => reject(new StateWaitError('state wait was aborted')));
      };

      const subscription = this.store.subscribeAll(() => {
        const value = select();
        if (predicate(value)) settle(() => resolve(value));
      });

      const initial = select();
      if (predicate(initial)) {
        settle(() => resolve(initial));
        return;
      }

      if (timeoutMs !== undefined) {
        // Deliberately NOT unref'd. A timeout exists to settle this promise, so a timer that lets the
        // process exit first would leave the caller's `await` pending forever.
        timer = setTimeout(() => {
          settle(() => reject(new StateWaitError(`state wait timed out after ${timeoutMs}ms`)));
        }, timeoutMs);
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** The paths under one root that a change touched. */
  changedUnder(change: StateChange, root: string): string[] {
    const moved = new Set<string>();
    for (const patch of change.patches ?? []) {
      if (pointerContains(root, patch.path)) moved.add(patch.path);
    }
    return [...moved];
  }

  /** Anchor the clock from a `Welcome`. Called by the client. */
  anchorClock(publishedAtServerMs: unknown): boolean {
    const anchored = this.clock.reset(publishedAtServerMs);
    this.rearmAll();
    return anchored;
  }

  /** Refresh the clock from a `RoomFrame`. Called by the client. */
  observeClock(publishedAtServerMs: unknown): boolean {
    const observed =
      asFiniteMs(publishedAtServerMs) === null ? false : this.clock.observe(publishedAtServerMs);

    // A frame timestamp well ahead of the anchor moves server time past deadlines that had a wake armed.
    // Those wakes have nothing left to arm, so the watchers are dispatched here: the crop ripened, and no
    // patch will say so.
    const nowMs = this.clock.now();
    for (const watcher of [...this.watchers]) {
      if (watcher.wakeAt === null || watcher.wakeAt > nowMs) continue;
      if (watcher.timer !== null) clearTimeout(watcher.timer);
      watcher.timer = null;
      watcher.handler();
    }

    this.rearmAll();
    return observed;
  }

  // ------------------------------------------------------------------ internals

  /** Build one player by joining the room's record to their slot data. */
  private toPlayer(value: unknown, index: number, total: number, nowMs: number): Player {
    const record = toPlayerRecord(value);
    const slotIndex = this.slotIndexFor(record.id, index, total);
    const dataPath = slotIndex === null ? null : `${USER_SLOTS}/${slotIndex}/data`;
    // The garden and the balances are fields of one saved object, so both are read from the same place and
    // both are empty when the join to that object failed.
    const saved = dataPath === null ? undefined : this.store.get(dataPath);
    const gardenValue = dataPath === null ? undefined : this.store.get(`${dataPath}/garden`);

    return {
      entityPath: playerPath(index),
      id: record.id,
      name: record.name,
      ...toCurrency(saved),
      inventory: toInventory(
        dataPath === null ? undefined : this.store.get(`${dataPath}/inventory`),
        `${dataPath ?? `${USER_SLOTS}/${index}/data`}/inventory`,
        nowMs,
      ),
      garden: toGarden(gardenValue, nowMs, `${dataPath ?? `${USER_SLOTS}/${index}/data`}/garden`),
      pets: slotIndex === null ? [] : this.pets(slotIndex),
      activityLog: slotIndex === null ? [] : this.activityLogs(slotIndex),
      record: new StateRecord(slotIndex === null ? value : this.store.get(dataPath as string)),
    };
  }

  /**
   * The slot a player occupies, or `null`.
   *
   * The room's player list index is tried first, because the room and the slot array are the same
   * length in practice and it costs nothing. When that slot does not name the player, the slot's own id
   * fields are searched, which is the join the reference companion needed three spellings for.
   */
  private slotIndexFor(playerId: string, roomIndex: number, total: number): number | null {
    if (playerId === '') return roomIndex < total ? roomIndex : null;
    const value = this.store.get(USER_SLOTS);
    if (!Array.isArray(value)) return null;
    if (this.slotNames(value[roomIndex], playerId)) return roomIndex;
    for (let index = 0; index < value.length; index += 1) {
      if (this.slotNames(value[index], playerId)) return index;
    }
    return null;
  }

  /** True when a slot's own id fields name this player. */
  private slotNames(slot: unknown, playerId: string): boolean {
    if (slot === null || typeof slot !== 'object') return false;
    const raw = slot as Record<string, unknown>;
    const data = raw['data'];
    const candidates: unknown[] = [raw['userId'], raw['playerId']];
    if (data !== null && typeof data === 'object') {
      candidates.push((data as Record<string, unknown>)['playerId']);
    }
    return candidates.some((candidate) => typeof candidate === 'string' && candidate === playerId);
  }

  /** The chat log, as records. */
  private chatRecords(): StateRecordLike[] {
    const value = this.store.get(CHAT);
    if (!Array.isArray(value)) return [];
    return value.map((entry) => new StateRecord(entry));
  }

  /** Arm a watcher's timer for the next `endTime` under it. */
  private arm(watcher: Watcher, target: unknown): void {
    if (watcher.timer !== null) clearTimeout(watcher.timer);
    watcher.timer = null;

    const nowMs = this.clock.now();
    const endTimes: number[] = [];
    endTimesIn(target, endTimes);

    let next: number | null = null;
    for (const endTime of endTimes) {
      if (!Number.isFinite(endTime) || endTime <= nowMs) continue;
      if (next === null || endTime < next) next = endTime;
    }
    watcher.wakeAt = next;
    if (next === null) return;

    // The clock is server time and the timer is local, so the delay is the difference and the clock is
    // re-checked when it fires: a `RoomFrame` between the two re-anchors it and this re-arms.
    const delay = Math.max(0, next - nowMs);
    watcher.timer = setTimeout(() => {
      watcher.timer = null;
      if (this.clock.now() < (watcher.wakeAt ?? 0)) {
        this.arm(watcher, target);
        return;
      }
      watcher.handler();
      this.arm(watcher, target);
    }, delay);
    unrefTimer(watcher.timer);
  }

  /**
   * Re-arm every watcher, after the clock moved.
   *
   * A clock re-anchor makes every pending wake time stale: the delay was computed against the old anchor,
   * so the timer would fire late or early relative to the server's own clock. Re-arming from the target is
   * the only way to recover, which is why the watcher holds it.
   */
  private rearmAll(): void {
    for (const watcher of this.watchers) this.arm(watcher, watcher.target);
  }
}
