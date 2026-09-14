/**
 * The Quinoa wire contract.
 *
 * Everything in this file is derived from the two documents in the workspace `docs/` folder:
 *   - `quinoa-protocol-docs.html`: the field guide to the wire (transport, forms, sequencing, state)
 *   - `quinoa-api-reference.html`: the reverse-engineered client API surface (typedefs, enums)
 *
 * Where the two disagree, the protocol field guide wins on wire facts and the API reference wins on
 * type/function shape. Every divergence is called out in a comment.
 *
 * This file contains *no* behaviour: it is the vocabulary the rest of the package
 * speaks. Behaviour lives in `envelope.ts`, `sequencer.ts` and `forms.ts`.
 */

// --------------------------------------------------------------------------------------
// Scope
// --------------------------------------------------------------------------------------

/**
 * The two scope paths the server accepts.
 *
 * - `["Room"]`: room-level actions (chat, emotes, kicking, voting for a game, editing your own
 *   player record). Always sent flat.
 * - `["Room","Quinoa"]`: gameplay actions inside the farming minigame. Sent either flat (for the
 *   documented allowlist) or wrapped in a `QuinoaCommand` envelope.
 */
export type ScopePath = readonly ['Room'] | readonly ['Room', 'Quinoa'];

// Typed as narrow readonly tuples rather than the `ScopePath` union, so assigning them into a
// `RoomFrame`/`FlatFrame` type-checks without a cast.
export const SCOPE_ROOM = ['Room'] as const;
export const SCOPE_QUINOA = ['Room', 'Quinoa'] as const;

/**
 * How a given action must be put on the wire.
 *
 * - `room`    → `{ scopePath: ["Room"], type, ...params }`
 * - `flat`    → `{ scopePath: ["Room","Quinoa"], type, ...params }`
 * - `wrapped` → `{ scopePath: ["Room","Quinoa"], type: "QuinoaCommand", requestId, commandSequence, command: { type, ...params } }`
 *
 * Getting this wrong fails *silently*: a wrapped type sent flat comes back as
 * `{ type:"QuinoaCommandResult", commandType:"unknown", ok:false, code:"invalid_message" }` and the
 * action never happens. The protocol doc calls this "the single most common way a hand-rolled client
 * 'does nothing' for no visible reason."
 */
export type ActionForm = 'room' | 'flat' | 'wrapped';

// --------------------------------------------------------------------------------------
// Outbound frames
// --------------------------------------------------------------------------------------

/** A room-scoped action, always sent flat. */
export interface RoomFrame {
  scopePath: readonly ['Room'];
  type: string;
  [param: string]: unknown;
}

/** A Quinoa-scoped action from the flat allowlist, sent without an envelope. */
export interface FlatFrame {
  scopePath: readonly ['Room', 'Quinoa'];
  type: string;
  [param: string]: unknown;
}

/** The inner `command` object of a wrapped gameplay action. */
export interface CommandBody {
  type: string;
  [param: string]: unknown;
}

/**
 * The `QuinoaCommand` envelope.
 *
 * NOTE: the API reference names `QuinoaCommand` six times but never defines it as a typedef; this
 * shape comes from the protocol field guide's verbatim example and from the working mod source.
 */
export interface WrappedFrame {
  scopePath: readonly ['Room', 'Quinoa'];
  type: 'QuinoaCommand';
  requestId: string;
  commandSequence: number;
  command: CommandBody;
}

/** Any frame this package can put on the wire. */
export type OutboundFrame = RoomFrame | FlatFrame | WrappedFrame;

// --------------------------------------------------------------------------------------
// Inbound frames
// --------------------------------------------------------------------------------------

/** A JSON-Patch (RFC 6902) operation as the server emits it. */
export interface Patch {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: unknown;
  from?: string;
}

/** The full-state snapshot carried by `Welcome`. */
export interface FullState {
  /**
   * Room state: players, chat log, host.
   *
   * This level holds `players` (each with `id`, matching `selfPlayerId`, and `discordUserId`,
   * or `databaseUserId` on older builds), `chat`, and `hostPlayerId`.
   */
  data: unknown;
  /**
   * Game state: garden tiles, inventory, shops, weather.
   *
   * NOTE the extra nesting: game state is one level deeper than room state. The protocol doc warns
   * that this "trips up naive path code later when reconciling with patches".
   */
  child?: { data: unknown } | null;
}

/**
 * The first message after a successful connect, and again after every reconnect.
 *
 * Carries `selfPlayerId`, the seed for the command-sequence counter, and the full room+game
 * snapshot. Nothing gameplay-related may be sent before this arrives: the sequence counter is not
 * seeded yet, so every command would be rejected as `invalid_sequence`.
 */
export interface WelcomeMessage {
  type: 'Welcome';
  /** This session's player id, server-assigned and always prefixed `p_`. */
  selfPlayerId: string;
  /** The last command number the server has executed. The next command you send must be this + 1. */
  executedCommandSequence: number;
  fullState: FullState;
  [key: string]: unknown;
}

/**
 * The legacy frame `RoomFrame` replaced.
 *
 * `PartialState` was removed in version 756: "gone: PartialState, new: RoomFrame has
 * message.state?.patches, the data is the same, just a different name". It is kept because older builds
 * and captured traffic still contain it, and because the two shapes differ only in where the patches sit.
 */
export interface PartialStateMessage {
  type: 'PartialState';
  /**
   * NOTE (documented contradiction): the protocol doc's prose says game-state patches carry a
   * `/child` path prefix, but its own `applyPatch` sample never strips one. The applier in
   * `state/patch.ts` is tolerant of both and records which form matched.
   */
  patches?: Patch[];
  [key: string]: unknown;
}

/**
 * The current state frame, and the successor to `PartialState` as of version 756.
 *
 * Carries the executed command frontier alongside the patches, which is the most reliable place to read
 * it from: it is "kept current on every frame".
 */
export interface RoomFrameMessage {
  type: 'RoomFrame';
  executedCommandSequence?: number;
  state?: { patches?: Patch[] };
  /** Some builds put patches at the top level instead of under `state`. */
  patches?: Patch[];
  [key: string]: unknown;
}

/**
 * Acknowledges (or rejects) a previously-sent `QuinoaCommand` envelope.
 *
 * DOCUMENTED UNCERTAINTY: the protocol doc's result payload carries **no** `requestId`, so there is
 * no specified way to correlate an ack to the command that caused it. The API reference types
 * `requestId` as optional, implying some builds do echo it. This package therefore never claims a
 * confirmed ack unless `requestId` is actually present. See `actions/CommandHandle`.
 */
export interface QuinoaCommandResultMessage {
  type: 'QuinoaCommandResult';
  /** Present in some builds, absent in others. */
  requestId?: string;
  /** The action that was executed, or the literal string `"unknown"` when the server could not parse it. */
  commandType: string;
  ok: boolean;
  /** Present when `ok` is false. */
  code?: string;
  [key: string]: unknown;
}

/** The reply to a flat `Ping` action. Distinct from the bare-string keepalive. */
export interface PongMessage {
  type: 'Pong';
  id?: number;
  [key: string]: unknown;
}

/** Every inbound message this package knows how to name. */
export type InboundMessage =
  | WelcomeMessage
  | PartialStateMessage
  | RoomFrameMessage
  | QuinoaCommandResultMessage
  | PongMessage;

/** The bare-string application-level keepalive. Not JSON, and handled before parsing. */
export const KEEPALIVE_PING = 'ping';
export const KEEPALIVE_PONG = 'pong';

/**
 * The doc's own handler accepts both the raw and JSON-quoted forms, "evidence the exact quoting has
 * been observed both ways". Kept here so both clients behave identically.
 */
export function isKeepalivePing(data: string): boolean {
  return data === KEEPALIVE_PING || data === `"${KEEPALIVE_PING}"`;
}

// --------------------------------------------------------------------------------------
// Movement / geometry primitives
// --------------------------------------------------------------------------------------

/** Tile-grid coordinates. */
export interface Position {
  x: number;
  y: number;
}

/** An inventory item reference passed to `placeCrystal()` / `fuseCrystal()`. */
export interface CrystalShard {
  itemId: string;
  crystalType: string;
}

/**
 * Discriminated-union badge payload for `setPetTeamEmblem()`.
 *
 * The protocol doc is emphatic: "Send the emblem as an object, never a bare string; a string is
 * silently dropped by the game's own reducer."
 */
export interface PetTeamEmblem {
  type: string;
  [field: string]: unknown;
}

// --------------------------------------------------------------------------------------
// Connect options
// --------------------------------------------------------------------------------------

/**
 * Reconnect policy shared by both clients.
 *
 * Backoff shape the docs say all three reference projects broadly agree on: exponential from a small
 * base (~1.5s), doubling per attempt, capped around 60s, plus jitter so many clients don't retry in
 * lockstep. Superseded closes get a longer base delay (order of 30s) since retrying instantly just
 * gets superseded again. A brand-new session's very first attempt gets a handful of fast retries.
 */
export interface ReconnectConfig {
  /** Master switch. */
  enabled: boolean;
  /** Base delay in ms for the first backoff step. Default 1500. */
  baseDelayMs: number;
  /** Ceiling for a single backoff step. Default 60000. */
  maxDelayMs: number;
  /** Random jitter applied as a multiplier in [1 - jitter, 1 + jitter]. Default 0.25. */
  jitter: number;
  /** Base delay applied when the previous close was a superseded code. Default 30000. */
  supersededBaseDelayMs: number;
  /**
   * Fast, un-backed-off attempts allowed for a brand-new session, the initial connection included. Default 3.
   *
   * The first attempt of a session is the connection that was opened; this setting bounds how many
   * attempts of that session may be retried with no backoff at all. `coldStartFastRetries: 3` therefore
   * gives the first two retries immediately (attempts 2 and 3) and backs off from attempt 4.
   */
  coldStartFastRetries: number;
  /**
   * The most consecutive retries of a *bounded* disposition (`4800`, an auth failure) this policy will
   * schedule. Default 3.
   *
   * Split out from `coldStartFastRetries` (Phase 4.5). One setting used to serve both policies, which were
   * documented as independent: raising `coldStartFastRetries` to widen the fast-retry window also let a bad
   * cookie be retried that many times. `maxAttempts` stays the caller's hard cap; this is the policy's own,
   * smaller one, expressed per session.
   */
  boundedRetryCap: number;
  /**
   * Hard cap on how many **connections** may be opened in one session, the initial connection included.
   *
   * Stated explicitly because the natural reading is ambiguous, and the two readings differ by one:
   *
   *   - **This is the meaning.** `maxAttempts: 3` opens at most 3 connections: the first, plus 2 retries.
   *     The number in the config equals the number of times the server sees you connect, and that is
   *     what a caller setting the value wants to reason about.
   *   - It is NOT "3 retries on top of the first connection" (which would be 4 connections).
   *
   * The attempt counter increments per connection opened, and resets only when a `Welcome` arrives,
   * i.e. when a session actually starts. A server that accepts and immediately drops therefore cannot
   * hold the client in a fast loop, because those drops still consume the budget.
   *
   * Default `Infinity` (never give up).
   */
  maxAttempts: number;
}

export const DEFAULT_RECONNECT: ReconnectConfig = {
  enabled: true,
  baseDelayMs: 1500,
  maxDelayMs: 60000,
  jitter: 0.25,
  supersededBaseDelayMs: 30000,
  coldStartFastRetries: 3,
  boundedRetryCap: 3,
  maxAttempts: Number.POSITIVE_INFINITY,
};

/**
 * Everything needed to build the connect URL.
 *
 * The URL template is:
 * `wss://<host>/version/<gameVersion>/api/rooms/<roomId>/connect`
 */
export interface ConnectOptions {
  /** Host, without scheme. Default `magicgarden.gg`. */
  host?: string;
  /** The client build identifier currently deployed. Opaque string; live value is e.g. `"1157"`. */
  version: string;
  /**
   * Lowercase alphanumeric room slug. Omit (or pass a fresh random one) to get a private room of
   * your own.
   */
  room?: string;
  /** UUID identifying this "tab" for the whole session. Stable across reconnects. */
  documentId?: string;
  /** `1` for the first connection with this documentId, incrementing by one per retry. */
  connectionAttempt?: number;
  /** `"navigate"` on the first attempt, `"reload"` on every retry. */
  isReload?: boolean;
  /**
   * Send as literal `true` only when the previous connection closed with a superseded code
   * (4250/4300) and you are reconnecting the same identity. Omitted entirely otherwise; never send
   * it as `false`.
   */
  reclaimSuperseded?: boolean;
  /** Overrides the JSON-encoded `surface` query value. Default `"web"`. */
  surface?: string;
  /** Overrides the JSON-encoded `platform` query value. Default `"desktop"`. */
  platform?: string;
  /** Overrides the JSON-encoded `capabilities` query value. Default `"fbo_mipmap_unsupported"`. */
  capabilities?: string;
  /** Overrides the JSON-encoded `locale` query value. Default `"en"`. */
  locale?: string;
  /** Overrides the JSON-encoded `clientVisibilityState` query value. Default `"visible"`. */
  clientVisibilityState?: string;
}
