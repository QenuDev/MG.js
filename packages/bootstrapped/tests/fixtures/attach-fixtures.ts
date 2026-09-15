/**
 * Shared fixtures for the two `attach` test files, `tests/attach/detect.test.ts` and
 * `tests/attach/room-connection.test.ts`.
 *
 * A single `tests/attach.test.ts` used to hold both suites' fixtures at its top. Splitting that file by the
 * module each test exercises left both halves needing the same fake page and the same fake connection, so the
 * shared ones moved here rather than one test file importing another: a fixture module is not itself a suite,
 * so neither half can accidentally run the other's tests.
 *
 * All four helpers below are used by `room-connection.test.ts`; `FakeRoomConnection` and `pageWith` are also
 * used by `detect.test.ts`. They moved as one set because `FakeRoomConnection`'s contract note refers to
 * {@link makeLegacyRoomConnection}, and a fixture module is the right home for the reference implementation
 * of the page object whichever half of the split reaches for it.
 *
 * **This `FakeRoomConnection` is not the only class of that name the package used to have, and it is not
 * merged with the others.** `client-options.test.ts` and `integration/room-upgrade.test.ts`
 * each declared their own, for different jobs: one is a ten-line minimum shape that proves what
 * `detectAttachment` will accept, and the other models the socket-backed send path the upgrade walks.
 * Folding them into this Appendix-A reference implementation would destroy what each was asserting, so
 * instead all three now say what they are: `MinimalRoomConnection`, `UpgradeRoomConnection` and this one.
 */

import type { WelcomeMessage } from '@mg.js/common';
import type { PageRealm } from '../../src/page/realm.js';

/**
 * A fake room connection following Appendix A.
 *
 * The `subscribeToPatches` return value is the `{ currentState, unsubscribe }` record, because that is the
 * shape the recon calls out as the one that "has been observed as both a bare function and a
 * `{ currentState, unsubscribe }` record across bundles", so exercising the record shape is the more
 * informative of the two, and the bare-function shape is covered by {@link makeLegacyRoomConnection}.
 */
export class FakeRoomConnection {
  isCommandSessionReady = false;
  lastDistributedRoomPublication: { executedCommandSequence?: unknown } | null = {
    executedCommandSequence: 3,
  };
  lastRoomStateJsonable: unknown = { data: { players: [] } };

  sent: unknown[] = [];
  private frameHandlers = new Set<(frame: unknown) => void>();
  private welcomeHandlers = new Set<(state: unknown, at?: number, seq?: number) => void>();

  sendMessage(payload: unknown): void {
    this.sent.push({ via: 'sendMessage', payload });
  }

  trySendMessageNow(payload: unknown): boolean {
    if (!this.isCommandSessionReady) return false;
    this.sent.push({ via: 'trySendMessageNow', payload });
    return true;
  }

  subscribeToPatches(_cb: (patches: unknown, fullState: unknown) => void): unknown {
    return {
      currentState: this.lastRoomStateJsonable,
      unsubscribe: () => undefined,
    };
  }

  subscribeToWelcome(cb: (state: unknown, at?: number, seq?: number) => void): unknown {
    this.welcomeHandlers.add(cb);
    return () => this.welcomeHandlers.delete(cb);
  }

  subscribeToRoomFrames(cb: (frame: unknown) => void): unknown {
    this.frameHandlers.add(cb);
    return () => this.frameHandlers.delete(cb);
  }

  /** Test helper: deliver a room frame. */
  emitFrame(frame: unknown): void {
    for (const handler of [...this.frameHandlers]) handler(frame);
  }

  /** Test helper: deliver a `Welcome`. */
  emitWelcome(state: unknown, at?: number, seq?: number): void {
    for (const handler of [...this.welcomeHandlers]) handler(state, at, seq);
  }
}

/** The older subscription shape: a bare unsubscribe function. */
export function makeLegacyRoomConnection(): Record<string, unknown> {
  return {
    sendMessage: () => undefined,
    subscribeToPatches: () => () => undefined,
    lastDistributedRoomPublication: { executedCommandSequence: 1 },
  };
}

/** Build a page realm holding a connection. */
export function pageWith(connection: unknown): PageRealm {
  return { MagicCircle_RoomConnection: connection } as PageRealm;
}

/** A minimal valid `Welcome`. */
export function welcomeMessage(selfPlayerId = 'p_1', executedCommandSequence = 7): WelcomeMessage {
  return {
    type: 'Welcome',
    selfPlayerId,
    executedCommandSequence,
    fullState: { data: { players: [] }, child: { data: {} } },
  };
}
