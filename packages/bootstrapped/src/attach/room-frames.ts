/**
 * Normalising and serialising the frames that arrive through the room connection.
 *
 * Split out of `room-connection.ts` (Phase 5 Task 5.7d). Pure: a frame in, a normalised shape or a string
 * out, with no page access.
 */

import { asSequence } from '@mg.js/common';
import type { RoomFrameEvent } from './room-types.js';

/**
 * Normalise a raw `RoomFrame` into the shape the transport and store want.
 *
 * Tolerates the two documented patch locations (`state.patches` and a top-level `patches`) because
 * `@mg.js/common`'s `extractPatches` does the same and the two must agree on what a frame contains.
 */
export function normaliseRoomFrame(frame: unknown): RoomFrameEvent {
  if (frame === null || typeof frame !== 'object') {
    return { executedCommandSequence: null, patches: null, raw: frame };
  }
  const record = frame as Record<string, unknown>;
  const sequence = asSequence(record['executedCommandSequence']);

  let patches: unknown[] | null = null;
  const direct = record['patches'];
  if (Array.isArray(direct)) {
    patches = direct;
  } else {
    const state = record['state'];
    if (state !== null && typeof state === 'object') {
      const inner = (state as { patches?: unknown }).patches;
      if (Array.isArray(inner)) patches = inner;
    }
  }
  return { executedCommandSequence: sequence, patches, raw: frame };
}

/**
 * Re-serialise a parsed room frame back to the raw string the `Transport` seam speaks.
 *
 * The seam deals in strings so that both attachment kinds are interchangeable, and the room connection
 * deals in objects because that is its whole advantage. This is the one conversion between them, and it is
 * lossy in one direction only: it produces `{"type":"RoomFrame", ...}`, which `parseFrame` and
 * `extractPatches` both understand.
 *
 * @returns the JSON string, or `null` when the frame will not serialise (a circular value the game attached).
 */
export function serialiseFrame(frame: unknown): string | null {
  if (frame === null || frame === undefined) return null;
  if (typeof frame === 'string') return frame;
  if (typeof frame !== 'object' || Array.isArray(frame)) return null;

  const record = frame as Record<string, unknown>;
  const type = record['type'];

  // A frame that already names its own type is passed through unchanged.
  //
  // This is needed for correctness. `subscribeToRoomFrames`' callback receives room frames,
  // but a build may hand the *same* callback other message types, and a `Welcome` carries `selfPlayerId` and
  // `fullState` that a rebuild from patches alone would silently discard. Dropping `selfPlayerId` would leave
  // the client without an identity for the whole session, with nothing to show for it in a log.
  if (typeof type === 'string' && type !== '' && type !== 'RoomFrame') {
    try {
      return JSON.stringify(record);
    } catch {
      return null;
    }
  }

  // Otherwise this is a room frame, possibly with a different name or with no name at all: normalise it, and
  // rebuild with an explicit `type: 'RoomFrame'` so `@mg.js/common`'s parser recognises it.
  const event = normaliseRoomFrame(frame);
  const payload: Record<string, unknown> = { type: 'RoomFrame' };
  if (event.executedCommandSequence !== null) {
    payload['executedCommandSequence'] = event.executedCommandSequence;
  }
  if (event.patches !== null) payload['patches'] = event.patches;
  if (payload['patches'] === undefined && payload['executedCommandSequence'] === undefined) return null;
  try {
    return JSON.stringify(payload);
  } catch {
    return null;
  }
}
