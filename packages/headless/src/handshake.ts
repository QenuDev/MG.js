/**
 * What a client writes when its socket opens, and what it writes once the session exists.
 *
 * Two different things, and the 1206 build is where they came apart:
 *
 *   * **admission** is one bare frame — `{"type":"SocketOpened"}` — and a socket that opens and stays
 *     silent is never admitted. The client the game serves today does exactly this on open
 *     (`RoomConnection-5QnhVCNm.js`, bundle 1206):
 *
 *         onWebSocketOpen = e => { e.send(JSON.stringify({ type: 'SocketOpened' })) }
 *
 *     and the same build's close-code enum adds `AdmissionTimedOut = 4410` for the client that never
 *     sends it (`bootScreen-*.js`: **twenty** codes where the 1192 capture carries eighteen, the two new
 *     ones being `AdmissionTimedOut` and `ConnectionAttemptObsolete = 4420`). That is what a viewer saw
 *     as "the game's last word was unclassified (4410)": this client wrote the §1.6 vote frames instead
 *     and the server waited for a frame that never came.
 *   * the **§1.6 vote pair** is the game's business rather than admission's. The 1206 client writes it
 *     from the game UI when the player's chosen game changes (`main-*.js`:
 *     `m({type:'VoteForGame', gameName:e})`), and `Welcome` arrives without it — so it no longer puts a
 *     caller *in*, it puts an already-established session into the engine's own scope
 *     (`["Room","Quinoa"]`). Sent on open it was, at best, ignored; sent once the session exists it is
 *     what the game's own client does.
 *
 * Split out of `client.ts` (Phase 5 Task 5.5b), which keeps re-exporting both constants so no import path
 * outside changes.
 *
 * The vote frames are built with `buildRoomFrame` rather than sent through `ClientCore.send` because they
 * are room-scoped and sequence-free: routing them through the sequencer would give them a `commandSequence`
 * they must not carry. `serializeFrame` is what the core itself uses, so the bytes on the wire are
 * identical to a core-routed send. The admission frame is a *bare* frame — a type and nothing else, no
 * `scopePath` — which is why it is written as its own bytes.
 */

import type { Logger } from '@mg.js/common';
import { buildRoomFrame, serializeFrame } from '@mg.js/common';

import type { StandaloneTransport } from './transport/standalone.js';

/** The admission frame: what tells the server the socket is open, and what it admits a client by. */
export const ADMISSION_FRAME = '{"type":"SocketOpened"}';

/**
 * The two §1.6 frames, as room-scoped action names.
 *
 * Not sent through `ClientCore.send()`, as the file header explains. Both are room-scoped, so neither
 * carries a `commandSequence` and neither needs the sequencer to be seeded.
 */
export const HANDSHAKE_ACTIONS = ['VoteForGame', 'SetSelectedGame'] as const;

/** The game name both handshake frames carry. §2.1: the engine's own scope is literally `"Quinoa"`. */
export const HANDSHAKE_GAME_NAME = 'Quinoa';

/**
 * Write the admission frame. Called once per attempt, **on open and before anything else**.
 * @internal
 */
export function writeAdmission(transport: StandaloneTransport, logger: Logger): void {
  transport.send(ADMISSION_FRAME);
  logger.debug('admission frame sent', { frame: ADMISSION_FRAME });
}

/**
 * Write the two §1.6 vote frames, in order. Called once the session exists (`Welcome`), which is where
 * the game's own client writes them — not to get in.
 * @internal
 */
export function writeHandshake(transport: StandaloneTransport, logger: Logger): void {
  for (const action of HANDSHAKE_ACTIONS) {
    const frame = buildRoomFrame(action, { gameName: HANDSHAKE_GAME_NAME });
    transport.send(serializeFrame(frame));
    logger.debug('handshake frame sent', { action, gameName: HANDSHAKE_GAME_NAME });
  }
}
