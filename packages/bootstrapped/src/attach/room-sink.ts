/**
 * The attached sink over a room connection, and the diagnostics that describe one.
 *
 * Split out of `room-connection.ts` (Phase 5 Task 5.7d).
 */

import type { PageRealm } from '../page/realm.js';
import { getPage } from '../page/realm.js';
import { readRoomConnection } from './room-binding.js';
import type { AttachedSink, SinkWiring } from './room-types.js';

/**
 * Build the {@link AttachedSink} over a room-connection binding.
 *
 * `sendRaw` parses the string back into an object, because this path exists to hand the game a *parsed*
 * payload, one that is "already speaking parsed objects instead of JSON strings" (§4). A frame that will not
 * parse is refused rather than sent as a string, because a string handed to `trySendMessageNow` would
 * double-encode.
 */
export function createRoomConnectionSink(wiring: SinkWiring): AttachedSink {
  return {
    kind: 'room-connection',

    canSend: () => wiring.ready(),

    sendRaw(raw: string): boolean {
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return false;
      }
      // Prefer the synchronous route; fall back to the queueing one only when the build has no synchronous
      // send at all (see `RoomConnectionBinding.send` for why queueing a stamped command is wrong).
      return wiring.sendNow(payload) || wiring.sendQueued(payload);
    },

    onFrame: (handler) => wiring.onFrame(handler),
    onWelcome: (handler) => wiring.onWelcome(handler),
    readFrontier: () => wiring.frontier(),

    detach(): void {
      // Nothing sink-local to release: the binding owns the hooks and subscriptions, and
      // `RoomConnectionBinding.release()` is what detaches them. That this method is a no-op is on
      // purpose: a per-sink detach that removed the binding's hooks would break every other sink.
    },
  };
}

/**
 * Whether this build exposes a usable room connection.
 *
 * The test is on the *pieces the transport needs*, not on the object existing: an object that is present but
 * has neither send path cannot carry a command, so treating it as available would send `attach/detect.ts`
 * down a path that cannot work.
 */
export function isRoomConnectionUsable(page: PageRealm | null = getPage()): boolean {
  const connection = readRoomConnection(page);
  if (connection === null) return false;
  const canSend =
    typeof connection.trySendMessageNow === 'function' || typeof connection.sendMessage === 'function';
  const canObserve =
    typeof connection.subscribeToRoomFrames === 'function' ||
    typeof connection.subscribeToPatches === 'function' ||
    connection.lastDistributedRoomPublication !== undefined;
  return canSend && canObserve;
}

/** Describe what this build's object exposes. Used by `detect.ts`'s report and by diagnostics. */
export function describeRoomConnection(page: PageRealm | null = getPage()): Record<string, boolean> {
  const connection = readRoomConnection(page);
  if (connection === null) {
    return { present: false };
  }
  return {
    present: true,
    sendMessage: typeof connection.sendMessage === 'function',
    trySendMessageNow: typeof connection.trySendMessageNow === 'function',
    isCommandSessionReady: connection.isCommandSessionReady !== undefined,
    subscribeToPatches: typeof connection.subscribeToPatches === 'function',
    subscribeToWelcome: typeof connection.subscribeToWelcome === 'function',
    subscribeToRoomFrames: typeof connection.subscribeToRoomFrames === 'function',
    lastDistributedRoomPublication: connection.lastDistributedRoomPublication !== undefined,
    lastRoomStateJsonable: connection.lastRoomStateJsonable !== undefined,
    currentWebSocket: connection.currentWebSocket !== undefined,
  };
}
