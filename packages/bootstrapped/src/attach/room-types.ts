/**
 * The room-connection shapes: the key, the seams, and the sink contract.
 *
 * Split out of `room-connection.ts` (Phase 5 Task 5.7d). Types only plus one string constant, so every
 * other module in the group can import it without a cycle.
 */

import type { PageRealm } from '../page/realm.js';

/** The page global the object lives under. */
export const ROOM_CONNECTION_KEY = 'MagicCircle_RoomConnection';

/**
 * The documented interface (Appendix A), with everything treated as optional.
 *
 * A single deviation from Appendix A, by design: the optionality. The docs declare `sendMessage` and
 * `isCommandSessionReady` as required, but a required field in a type is a claim that it is present, and the
 * recon's own drift warning says no field should be trusted. Marking them optional forces every call site
 * here through a guard, which is the behaviour that survives a build where they are gone.
 */
export interface RoomConnectionLike {
  /**
   * "Queues instead of sending when disconnected". Not what we want for commands: see
   * {@link RoomConnectionBinding.sendNow}.
   */
  sendMessage?: (payload: unknown) => void;
  /**
   * Appendix A: "Immediate, synchronous send", which "returns false (and drops the message) if disconnected
   * or before Welcome". QuinoaCommand envelopes need this one: `sendMessage()` queues instead, which hands a
   * now-invalid sequence number to a session that hasn't opened yet.
   */
  trySendMessageNow?: (payload: unknown) => boolean;
  /** Appendix A: whether a command session is open. */
  isCommandSessionReady?: boolean;
  /** Fires on every state update. Return shape varies; see the module header. */
  subscribeToPatches?: (cb: (patches: unknown, fullState: unknown) => void) => unknown;
  /** Fires on initial connect and every reconnect, and immediately for a late subscriber. */
  subscribeToWelcome?: (
    cb: (state: unknown, publishedAtServerMs?: number, executedCommandSequence?: number) => void,
  ) => unknown;
  /** Fires on every `RoomFrame`. */
  subscribeToRoomFrames?: (cb: (frame: unknown) => void) => unknown;
  /** One-shot synchronous frontier read, kept current on every frame. */
  lastDistributedRoomPublication?: { executedCommandSequence?: unknown } | null;
  /** One-shot synchronous state snapshot. */
  lastRoomStateJsonable?: unknown;
  /** Present on some builds only. */
  currentWebSocket?: unknown;
  [key: string]: unknown;
}

/** A `Welcome`-shaped event extracted from whatever `subscribeToWelcome` handed us. */
export interface WelcomeEvent {
  /** The raw first argument. */
  state: unknown;
  /** The frontier reported alongside it, when the build passes one. */
  executedCommandSequence: number | null;
  /** The server's publish time, when the build passes one. */
  publishedAtServerMs: number | null;
  /** This session's player id, when the state carries one. */
  selfPlayerId: string | null;
}

/** A room frame, normalised. */
export interface RoomFrameEvent {
  executedCommandSequence: number | null;
  patches: unknown[] | null;
  raw: unknown;
}

/** What kind of transport a binding can feed. */
export type AttachKind = 'room-connection' | 'raw-socket' | 'none';

/**
 * The seam `attach/attached-transport.ts` consumes.
 *
 * By design, *not* the property names of any particular discovery mechanism: the room-connection path and
 * the raw-socket path both produce this, so the transport does not know or care which one won. `sendDetailed`
 * is separate from `canSend` because the socket path has to serialise and hand bytes to `send` while the room
 * path hands an object to `trySendMessageNow`, and collapsing them would force one of them to lie.
 */
export interface AttachedSink {
  readonly kind: AttachKind;
  /** Whether we currently have a way to put a frame on the wire right now. */
  canSend(): boolean;
  /**
   * Send a raw, already-serialised frame.
   *
   * @returns `true` when it was accepted for transmission.
   */
  sendRaw(raw: string): boolean;
  /** Subscribe to inbound frames (already parsed back to their raw string form). */
  onFrame(handler: (raw: string) => void): () => void;
  /** Subscribe to `Welcome`-equivalent events. */
  onWelcome(handler: (event: WelcomeEvent) => void): () => void;
  /** The server's confirmed command frontier, or `null` when unknown. */
  readFrontier(): number | null;
  /** Release every subscription and restore every hook. Must not close the host's socket. */
  detach(): void;
}

/** Options for {@link bindRoomConnection}. */
export interface BindRoomConnectionOptions {
  /**
   * Resolve `selfPlayerId` from outside this module: the room object never hands the id to a subscriber.
   *
   * The client supplies one that reads what the attached socket seam scraped off the wire, which is the
   * source that resolves it on the shipped build. Consulted after the state and only when the state misses.
   */
  selfPlayerIdResolver?: () => string | null;
  /** Page realm. Defaults to `realm.getPage()`. Exported for tests. */
  page?: PageRealm | null;
  /** Notified when a hook could not be installed because a foreign wrapper owns the slot. Diagnostic. */
  onForeignHook?: (method: string) => void;
}

/** The binding. */
export interface RoomConnectionBinding {
  readonly kind: 'room-connection';
  /** The live object, read fresh from the page each time it is needed. */
  connection(): RoomConnectionLike | null;
  /** Appendix A's readiness flag, feature-detected. */
  isCommandSessionReady(): boolean;
  /** The frontier, straight off `lastDistributedRoomPublication`. */
  readFrontier(): number | null;
  /** A synchronous state snapshot from `lastRoomStateJsonable`. */
  readState(): unknown;
  /** Send through the game's own send path. See {@link RoomConnectionBinding.send}. */
  send(payload: unknown): boolean;
  /** Appendix A's synchronous send, when the build has it. */
  sendNow(payload: unknown): boolean;
  subscribeToWelcome(handler: (event: WelcomeEvent) => void): () => void;
  subscribeToPatches(handler: (patches: unknown, fullState: unknown) => void): () => void;
  /**
   * Subscribe to room frames.
   *
   * Two handler shapes are accepted on purpose. The structured form is what a mod wants, a parsed frame with
   * its frontier and patches intact, while the raw-string form is what the `Transport` seam speaks (so that
   * the room-connection and raw-socket paths are interchangeable). Widening the parameter here rather than
   * making callers adapt keeps both honest.
   */
  subscribeToRoomFrames(handler: ((frame: RoomFrameEvent) => void) | ((raw: string) => void)): () => void;
  /** The sink `attach/attached-transport.ts` consumes. */
  sink(): AttachedSink;
  /**
   * Install (or replace) the outbound rewriter.
   *
   * The coexistence renumberer is a *policy* that `attach/detect.ts` owns; this binding owns the mechanism.
   * Keeping them apart is what lets the renumbering state machine be pure and unit-testable
   * (`coexistence/renumber.ts`) while the hook lives where the interception actually happens.
   */
  setOutboundRewriter(rewriter: ((payload: unknown) => unknown) | null): void;
  /** Whether `sendMessage`/`trySendMessageNow` are currently wrapped by us. Diagnostics. */
  hooksActive(): boolean;
  /** Remove every hook and subscription this binding installed. */
  release(): void;
  /** Whether the page currently exposes the object. */
  available(): boolean;
}

/** The internal wiring {@link createRoomConnectionSink} needs from the binding. */
export interface SinkWiring {
  onFrame: (handler: (raw: string) => void) => () => void;
  onWelcome: (handler: (event: WelcomeEvent) => void) => () => void;
  addOutbound: (interceptor: (payload: unknown) => unknown) => void;
  removeOutbound: (interceptor: (payload: unknown) => unknown) => void;
  frontier: () => number | null;
  ready: () => boolean;
  sendNow: (payload: unknown) => boolean;
  sendQueued: (payload: unknown) => boolean;
}
