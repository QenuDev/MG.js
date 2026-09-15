/**
 * Wire codec: the boundary between raw frames and typed messages.
 *
 * The design is forgiving in one direction and strict in the other. Inbound, the server sends at least
 * two things that are not JSON (the bare-string keepalive, and whatever future builds invent), so
 * parsing must never throw on an unrecognised frame, because a wrapper that dies on one odd message is
 * worse than one that logs it. Outbound, we serialise exactly and refuse to send a frame that will not
 * survive a round trip.
 */

import type { InboundMessage, OutboundFrame, Patch } from './wire.js';
import { isKeepalivePing } from './wire.js';

/** A parsed inbound frame we could not type, kept intact so it can still be inspected. */
export interface UnknownMessage {
  type: string;
  raw: Record<string, unknown>;
}

/**
 * Discriminated on `isKnown` so that a caller who has checked it gets a properly narrowed `message`
 * without a cast.
 */
export type ParseResult =
  /** A frame the transport consumed itself (keepalive). Not for the client. */
  | { kind: 'keepalive' }
  /** A JSON frame whose `type` this package models. */
  | { kind: 'message'; isKnown: true; message: InboundMessage }
  /** A JSON frame with a `type` we do not model, kept intact so it can still be inspected. */
  | { kind: 'message'; isKnown: false; message: UnknownMessage }
  /**
   * The frame was larger than the cap, so it was refused **without being parsed or retained**.
   *
   * `bytes` is the byte offset at which the cap was first exceeded, so it is a **lower bound** on the
   * frame's size rather than its true size, because `utf8ByteLength` stops counting there instead of
   * scanning a frame it is refusing (see its own doc). `limit` is the cap that was applied.
   *
   * It carries no `text`/`raw` payload, by design: handing a caller the bytes of the frame we just
   * refused would defeat the bound, because the thing being bounded is exactly "how much of a hostile
   * frame can be held".
   */
  | { kind: 'oversized'; bytes: number; limit: number }
  /** Text that was not JSON and not a keepalive. */
  | { kind: 'unparsed'; text: string }
  /** The frame was empty. */
  | { kind: 'empty' };

/** The message types this package understands. */
const KNOWN_TYPES = new Set([
  'Welcome',
  'PartialState',
  'RoomFrame',
  'QuinoaCommandResult',
  'Pong',
  // Supersession can arrive as a *message*, not only as close code 4250/4300. The game's own bundle does
  // `case 'SessionSuperseded': this.permanentlyDisconnect(h.UserSessionSuperseded, e.context)`, which sets
  // `permanentDisconnectReason` and makes every later `onWebSocketClose` short-circuit. Recognising it is
  // what lets a client reach its supersede policy, which refuses to reclaim without a human's say-so,
  // before it keeps sending commands on a session that has already been taken.
  'SessionSuperseded',
]);

/**
 * The largest inbound frame this client will look at, in bytes.
 *
 * **A chosen bound, not a measured one.** No frame size was ever recorded in this repository, so nothing
 * here claims the ceiling cannot clip a legitimate frame: 8 MiB was picked because the catalogue layer
 * already caps a response at 8 MiB for the same reason: a hostile or broken far end (`catalog/http.ts`,
 * `FetchJsonOptions.maxBytes`). One number for "the most this client will hold from an untrusted source"
 * is easier to reason about than two. Its provenance is that precedent, not an observation.
 *
 * It is a *byte* count, not a string length: `raw.length` is UTF-16 code units and under-counts non-ASCII
 * frames by up to 2x.
 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * Count the UTF-8 bytes in `value`, stopping as soon as the count exceeds `limit`.
 *
 * Hand-rolled rather than `new TextEncoder().encode(value).length`: on the reject path that
 * would allocate a second copy of the very frame we are refusing to look at. Iterating code points makes
 * the count exact for surrogate pairs, and the early return makes the cost of a hostile frame bounded by
 * `limit` rather than by the frame.
 *
 * The early return is why the value at an over-limit return is **not** the string's true byte length: it is
 * the offset at which the cap was first crossed, so it can overshoot `limit` by up to 4. The code point that
 * crosses adds 1..4 bytes, which leaves the value somewhere in `limit + 1 .. limit + 4`. Callers that reject
 * on it are reporting a **lower bound**, and must say so rather than treating it as the frame's size.
 */
export function utf8ByteLength(value: string, limit = Number.POSITIVE_INFINITY): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > limit) return bytes;
  }
  return bytes;
}

/**
 * Parse one inbound frame, refusing anything larger than `options.maxBytes` before touching it.
 *
 * The cap is checked first, ahead of the keepalive test and `JSON.parse`, so an oversized frame is never
 * interpreted at all. NOTE: `isKeepalivePing` also accepts the JSON-quoted `"ping"` form, because the
 * protocol doc's own handler does; there is "evidence the exact quoting has been observed both ways".
 */
export function parseFrame(raw: string, options: { maxBytes?: number } = {}): ParseResult {
  if (raw === undefined || raw === null || raw.length === 0) return { kind: 'empty' };

  const limit = options.maxBytes ?? MAX_FRAME_BYTES;
  const bytes = utf8ByteLength(raw, limit);
  if (bytes > limit) return { kind: 'oversized', bytes, limit };

  if (isKeepalivePing(raw)) return { kind: 'keepalive' };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: 'unparsed', text: raw };
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'unparsed', text: raw };
  }

  const record = value as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';

  if (type === '' || !KNOWN_TYPES.has(type)) {
    return { kind: 'message', message: { type, raw: record }, isKnown: false };
  }

  return { kind: 'message', message: record as unknown as InboundMessage, isKnown: true };
}

/** Serialise an outbound frame. Throws rather than sending something unparseable. */
export function serializeFrame(frame: OutboundFrame | Record<string, unknown>): string {
  const json = JSON.stringify(frame);
  if (json === undefined) {
    throw new Error('serializeFrame: frame serialised to undefined.');
  }
  return json;
}

/**
 * Extract the patch list from either `PartialState` or `RoomFrame`.
 *
 * `RoomFrame` is the **newer** of the two: it replaced `PartialState` as of version 756, announced as "an
 * upcoming netcode change replaces PartialState messages with RoomFrame messages (state.patches) ...
 * basically: gone: PartialState, new: RoomFrame has message.state?.patches". The data is the same, and
 * only the name differs. `PartialState` is therefore legacy rather than current, and the top-level
 * `patches` fallback below is what keeps a build that still sends it readable.
 *
 * Both locations are checked because the two shapes differ exactly there, and a normalisation the API
 * reference explicitly calls for: "RoomFrame messages are normalized into this same shape before the event
 * fires".
 */
export function extractPatches(message: unknown): Patch[] {
  if (message === null || typeof message !== 'object') return [];
  const record = message as Record<string, unknown>;

  const direct = record.patches;
  if (Array.isArray(direct)) return direct as Patch[];

  const state = record.state;
  if (state !== null && typeof state === 'object') {
    const nested = (state as Record<string, unknown>).patches;
    if (Array.isArray(nested)) return nested as Patch[];
  }

  return [];
}

/**
 * True when `value` can be a command sequence: a non-negative integer, nothing else.
 *
 * This is the canonical frontier rule, and the only place it is written. `commandSequence` and
 * `executedCommandSequence` are counters the server compares for equality, and a mismatch is its
 * `invalid_sequence` failure mode. Because the next value we stamp is `frontier + 1`, a frontier of `2.5`
 * makes us send `3.5`, which no counter comparison accepts. DESIGN I4 forbids letting untrusted data
 * become an index or a bound without a canonical check, and a sequence is used as both. `Number.isFinite`
 * was the rule in six copies and reported `2.5` as a frontier; a finite-but-fractional counter is malformed
 * input, and the honest reading of malformed input is "no evidence".
 *
 * Every place the wire hands us a sequence reads this predicate rather than testing `typeof` for itself.
 * {@link asSequence} is the same rule in the shape a read wants.
 */
export function isCanonicalSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * {@link isCanonicalSequence} in the shape a wire read wants: the canonical number, or `null`.
 *
 * The wire hands us a frontier at a dozen seams, and most of them want a value to seed a counter rather
 * than a boolean to branch on. Returning `null`, never a default, keeps "no evidence" distinct from
 * "the server has executed through sequence zero".
 */
export function asSequence(value: unknown): number | null {
  return isCanonicalSequence(value) ? value : null;
}

/**
 * Read the server's confirmed command frontier from any frame that carries one.
 *
 * `Welcome` carries it, and so does `RoomFrame`. The protocol doc calls the room-frame copy the most
 * reliable place to read it from, because it is "kept current on every frame".
 */
export function extractFrontier(message: unknown): number | null {
  if (message === null || typeof message !== 'object') return null;
  const record = message as Record<string, unknown>;
  return asSequence(record.executedCommandSequence);
}
