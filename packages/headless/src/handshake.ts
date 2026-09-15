/**
 * The §1.6 handshake: the two room-scoped frames written before `Welcome`.
 *
 * Split out of `client.ts` (Phase 5 Task 5.5b), which keeps re-exporting both constants so no import path
 * outside changes.
 *
 * The frames are built with `buildRoomFrame` rather than sent through `ClientCore.send` because they are
 * room-scoped and sequence-free: routing them through the sequencer would give them a `commandSequence`
 * they must not carry. `serializeFrame` is what the core itself uses, so the bytes on the wire are
 * identical to a core-routed send.
 */

import type { Logger } from '@mg.js/common';
import { buildRoomFrame, serializeFrame } from '@mg.js/common';

import type { StandaloneTransport } from './transport/standalone.js';

/**
 * The two handshake frames §1.6 requires, as room-scoped action names.
 *
 * Not sent through `ClientCore.send()`, as the file header explains. Both are room-scoped, so neither
 * carries a `commandSequence` and neither needs the sequencer to be seeded.
 */
export const HANDSHAKE_ACTIONS = ['VoteForGame', 'SetSelectedGame'] as const;

/** The game name both handshake frames carry. §2.1: the engine's own scope is literally `"Quinoa"`. */
export const HANDSHAKE_GAME_NAME = 'Quinoa';

/**
 * Write the handshake frames, in order. Called once per attempt, before `Welcome` can arrive.
 * @internal
 */
export function writeHandshake(transport: StandaloneTransport, logger: Logger): void {
  for (const action of HANDSHAKE_ACTIONS) {
    const frame = buildRoomFrame(action, { gameName: HANDSHAKE_GAME_NAME });
    transport.send(serializeFrame(frame));
    logger.debug('handshake frame sent', { action, gameName: HANDSHAKE_GAME_NAME });
  }
}
