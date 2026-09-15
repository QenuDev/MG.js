/**
 * Binding to the game's own `MagicCircle_RoomConnection`.
 *
 * Split out of `room-connection.ts` (Phase 5 Task 5.7d). The binding is the large half: identity-guarded
 * hooks, the self-player resolution both sides need, and the unsubscribe normalisation.
 */

import { asSequence } from '@mg.js/common';
import { brandWrapper, classifySlot, isBranded, restoreSlot } from '../coexistence/brand.js';
import type { PageRealm } from '../page/realm.js';
import { getPage } from '../page/realm.js';
import { normaliseRoomFrame, serialiseFrame } from './room-frames.js';
import { createRoomConnectionSink } from './room-sink.js';
import type {
  AttachedSink,
  BindRoomConnectionOptions,
  RoomConnectionBinding,
  RoomConnectionLike,
  RoomFrameEvent,
  WelcomeEvent,
} from './room-types.js';
import { ROOM_CONNECTION_KEY } from './room-types.js';

/**
 * Read the connection object from the page.
 *
 * Read *fresh on every call* rather than captured once, and that is deliberate: §4 says reconnects are
 * transparent for subscriptions but says nothing about the object surviving, and the companion mod's own
 * re-attach loop (`page.MagicCircle_RoomConnection?.currentWebSocket` on a timer) implies the object can be
 * replaced. Reading fresh costs one property access and cannot go stale.
 */
export function readRoomConnection(page: PageRealm | null = getPage()): RoomConnectionLike | null {
  if (page === null) return null;
  const candidate = page[ROOM_CONNECTION_KEY];
  if (candidate === null || (typeof candidate !== 'object' && typeof candidate !== 'function')) {
    return null;
  }
  return candidate as RoomConnectionLike;
}

/** Normalise a subscription's return value into a plain unsubscribe. */
function toUnsubscribe(result: unknown): () => void {
  // The older shape: a bare function. Checked first because a function with an `unsubscribe` property is
  // still callable, and calling it cannot be wrong.
  if (typeof result === 'function') {
    return () => {
      try {
        (result as () => void)();
      } catch {
        // A subscription that throws on unsubscribe is already gone.
      }
    };
  }
  if (result !== null && typeof result === 'object') {
    const unsubscribe = (result as { unsubscribe?: unknown }).unsubscribe;
    if (typeof unsubscribe === 'function') {
      return () => {
        try {
          (unsubscribe as () => void)();
        } catch {
          // As above.
        }
      };
    }
  }
  // Neither shape: nothing to call. Returning a no-op rather than throwing keeps a caller's teardown
  // working, and the subscription is reported by the absence of a frontier rather than by an exception.
  return () => {
    // Nothing to unsubscribe.
  };
}

/** Pull `selfPlayerId` out of whatever the welcome callback received. */
function readSelfPlayerId(state: unknown): string | null {
  if (state === null || typeof state !== 'object') return null;
  const direct = (state as { selfPlayerId?: unknown }).selfPlayerId;
  if (typeof direct === 'string' && direct !== '') return direct;
  // Some builds pass the full frame rather than the state.
  const nested = (state as { fullState?: unknown }).fullState;
  if (nested !== null && typeof nested === 'object') {
    const inner = (nested as { selfPlayerId?: unknown }).selfPlayerId;
    if (typeof inner === 'string' && inner !== '') return inner;
  }
  return null;
}

/**
 * The best available `selfPlayerId`, from the two sources that can carry it.
 *
 *   1. **the state**, when a build puts the id in the state it hands to welcome subscribers. The shipped
 *      build does not: its `Welcome` handler reads the id off the *message* (`t(g, e.selfPlayerId)`) and
 *      publishes only `cloneForDistribution(e.fullState)` to those subscribers, so this is a courtesy to
 *      other builds rather than the source that answers on this one;
 *   2. **`fromSeam`**, the caller's own resolver. The client supplies one that reads what the attached
 *      socket seam scraped off the wire, and that is the source that actually answers here.
 *
 * A miss is silent, so neither source is asked only once: the session's stand-in welcome consults this, every
 * real `Welcome` consults it, and the client re-runs its own resolver on every `selfPlayerId` read. That is
 * what picks up an id that only reaches the socket after the session started. See
 * `BootstrappedClient.selfPlayerId`.
 */
function resolveSelfPlayerId(state: unknown, fromSeam: (() => string | null) | undefined): string | null {
  const direct = readSelfPlayerId(state);
  if (direct !== null) return direct;
  if (fromSeam !== undefined) {
    try {
      const value = fromSeam();
      if (typeof value === 'string' && value !== '') return value;
    } catch {
      // A resolver that throws must not cost us the other source.
    }
  }
  return null;
}

/**
 * Bind to the page's room connection.
 *
 * Installing this binding wraps `sendMessage` and `trySendMessageNow` in place. The wraps are **branded and
 * chained** (`brand.ts`): a foreign wrapper on either slot is preserved and called through, and a
 * pre-existing wrap of *ours* is reused rather than stacked.
 */
export function bindRoomConnection(options: BindRoomConnectionOptions = {}): RoomConnectionBinding {
  const page = options.page ?? getPage();

  /** Outbound interceptors, applied in registration order before delegation. */
  const outbound = new Set<(payload: unknown) => unknown>();
  /** Inbound raw-frame handlers, fed from the room-frame subscription. This is the transport channel. */
  const frameHandlers = new Set<(raw: string) => void>();
  /**
   * Structured room-frame observers.
   *
   * A *separate* channel from {@link frameHandlers} rather than one channel with a flag: the
   * transport seam is defined in raw strings (so that the room-connection and raw-socket paths are
   * interchangeable), while a caller that asked this binding for `subscribeToRoomFrames` wants the parsed
   * frame with its frontier and patches intact. Collapsing them would force the transport to re-parse a frame
   * it had just serialised.
   */
  const roomFrameObservers = new Set<(frame: RoomFrameEvent) => void>();
  /** Welcome handlers. */
  const welcomeHandlers = new Set<(event: WelcomeEvent) => void>();
  /**
   * Handlers that {@link RoomConnectionBinding.subscribeToWelcome} has already handed this session's stand-in
   * to, so the frame path does not hand them a second one.
   *
   * The two paths publish the same event to different audiences: that one replays it to a subscriber that
   * arrived after the session start, while this one announces it to everyone already listening. A subscriber
   * served by both would see one session start twice.
   */
  const standInReplayedTo = new Set<(event: WelcomeEvent) => void>();
  /** Patch handlers, forwarded verbatim. */
  const patchHandlers = new Set<(patches: unknown, fullState: unknown) => void>();
  /** Subscription teardowns. */
  const subscriptions: Array<() => void> = [];
  /** Hook teardowns, so `release()` restores the object. */
  const hookReleases: Array<() => boolean> = [];

  let released = false;
  /**
   * The single active outbound rewriter.
   *
   * One slot rather than a set, because two rewriters on one send path would each renumber commands, which
   * is the double-renumbering failure `coexistence/renumber.ts` exists to prevent. Replacing is therefore the
   * only supported operation.
   */
  let activeRewriter: ((payload: unknown) => unknown) | null = null;
  /** The most recent frontier seen from any source; a fallback when the publication object is gone. */
  let lastFrontier: number | null = null;
  /** The most recent selfPlayerId seen. */
  let lastSelfPlayerId: string | null = null;
  /** The most recent full state seen from *any* channel, not only `Welcome`. */
  let lastFullState: unknown = null;
  /**
   * True once a real `Welcome` has been observed.
   *
   * Until it is, the state channels are allowed to stand in for one. See
   * {@link buildStandInWelcome}. A live session made the need for this concrete: `attach kind:
   * room-connection`, `433 patches applied`, and `ready: false` with no `playerId`, because the game fired
   * `Welcome` before this binding existed, did not re-fire for the late subscriber, and this build exposes
   * no `lastRoomStateJsonable`. State was arriving in bulk while the client sat permanently un-ready.
   */
  let sawWelcome = false;
  /**
   * True once the state channels have stood in for a missed `Welcome`.
   *
   * The stand-in is a *session-start* event: `ClientCore` consumes it as a `Welcome`, which seeds the
   * command sequencer and clears its outstanding ledger. It therefore has to be once per session, not once
   * per patch frame. It was per frame, and the consequence was that a command sent between two frames was
   * renumbered behind its own ledger entry: the second frame's stand-in re-seeded the counter to the
   * frontier and dropped the in-flight command.
   *
   * Kept separate from {@link sawWelcome} because the two answer different questions: that one says "a real
   * `Welcome` was observed" and decides whether a stand-in is *allowed at all*; this one says "the session
   * start has already been announced" and decides whether it is still *needed*.
   *
   * Latching at emission is safe only because every welcome subscriber is registered before this can fire: a
   * binding is created and its sink handed to the transport in one synchronous step (`attach/detect.ts`'s
   * poll → `BootstrappedClient.upgradeAttachment`), while patch frames arrive from the socket's own message
   * events and cannot interleave. An attach path that awaited between binding and sink would have to replay
   * the latched event instead, or the session would sit un-ready, which is the bug this stand-in exists to
   * fix.
   */
  let standInWelcomeEmitted = false;

  /**
   * Build a `Welcome`-shaped event from a full state, or `null` when one cannot be made.
   *
   * The room object's own late-subscriber contract ("fires immediately with the current state if you
   * subscribe after the fact") is a promise about the *game's* implementation, and it does not always hold:
   * on a build that neither re-fires nor exposes `lastRoomStateJsonable`, nothing would ever report the
   * session as started. `subscribeToPatches` carries the same full state on every update, so it is a
   * reliable second source for the two facts `Welcome` exists to deliver: the state and `selfPlayerId`.
   *
   * `executedCommandSequence` comes from the high-water frontier rather than a per-frame value, for the
   * same reason `readFrontier` does: it is a lower bound being used to seed a counter, and a stale lower
   * value is the duplicate-stamp hazard.
   */
  const buildStandInWelcome = (state: unknown): WelcomeEvent | null => {
    if (state === null || state === undefined || typeof state !== 'object') return null;
    const selfPlayerId = lastSelfPlayerId ?? resolveSelfPlayerId(state, options.selfPlayerIdResolver);
    if (selfPlayerId !== null) lastSelfPlayerId = selfPlayerId;
    return {
      state,
      executedCommandSequence: lastFrontier,
      publishedAtServerMs: null,
      selfPlayerId,
    };
  };

  /**
   * Apply every outbound interceptor, then delegate.
   *
   * Shared by both send paths so that the renumbering hook and any caller's own interceptor behave
   * identically whichever route the transport takes. A throwing interceptor is skipped rather than allowed
   * to drop the game's message.
   */
  const interceptOutbound = (payload: unknown): unknown => {
    let current = payload;
    for (const interceptor of outbound) {
      try {
        current = interceptor(current);
      } catch {
        // An interceptor that throws leaves the payload as it was; never drop the host's frame.
      }
    }
    return current;
  };

  /**
   * Wrap a send method in place, branded and chained.
   *
   * `sendMessage` returns `void`, `trySendMessageNow` returns `boolean`, so the wrapper's return value is
   * whatever the original produced. For `trySendMessageNow` that value is the informative part, and it must
   * be preserved for the caller to know whether the frame actually went out.
   */
  const wrapSend = (method: 'sendMessage' | 'trySendMessageNow'): void => {
    const connection = readRoomConnection(page);
    if (connection === null) return;
    const existing = connection[method];
    if (typeof existing !== 'function') return;

    const label = `room.${method}`;
    if (classifySlot(connection as object, method) === 'mine') return;
    if (classifySlot(connection as object, method) === 'foreign') {
      // We chain onto it, so it stays working. Report it so a caller can see the layering.
      options.onForeignHook?.(method);
    }

    const original = existing as (payload: unknown) => unknown;
    const wrapper = brandWrapper(function interceptedSend(this: unknown, payload: unknown): unknown {
      const outgoing = interceptOutbound(payload);
      return original.call(this, outgoing);
    }, label);

    (connection as Record<string, unknown>)[method] = wrapper;
    hookReleases.push(() => restoreSlot(connection as object, method, original, wrapper));
  };

  wrapSend('sendMessage');
  wrapSend('trySendMessageNow');

  /**
   * Attach the room-frame subscription, once.
   *
   * Retried rather than assumed: the object may exist while `subscribeToRoomFrames` does not yet (a build
   * that wires it up after connecting), so an absent method is not a permanent answer. The retry is bounded
   * and cheap: one property read per attempt.
   */
  const attachFrameSubscription = (): boolean => {
    const connection = readRoomConnection(page);
    if (connection === null) return false;
    const subscribe = connection.subscribeToRoomFrames;
    if (typeof subscribe !== 'function') return false;

    const result = subscribe.call(connection, (frame: unknown) => {
      const event = normaliseRoomFrame(frame);
      if (event.executedCommandSequence !== null) observeFrontier(event.executedCommandSequence);
      for (const observer of [...roomFrameObservers]) {
        try {
          observer(event);
        } catch {
          // A consumer's failure must not stop the others, or the game's own dispatch.
        }
      }
      const serialised = serialiseFrame(event.raw);
      if (serialised === null) return;
      for (const handler of [...frameHandlers]) {
        try {
          handler(serialised);
        } catch {
          // As above.
        }
      }
    });
    subscriptions.push(toUnsubscribe(result));
    return true;
  };

  const attachPatchSubscription = (): boolean => {
    const connection = readRoomConnection(page);
    if (connection === null) return false;
    const subscribe = connection.subscribeToPatches;
    if (typeof subscribe !== 'function') return false;

    const result = subscribe.call(connection, (patches: unknown, fullState: unknown) => {
      // Remember the full state from this channel too. That has to keep happening on every frame, because it
      // is the state the read-time identity resolution reads, and it must stand in for a missed `Welcome`
      // *before* the patches are applied, since the patches were computed against this state. The stand-in
      // itself is latched: it announces a session start, and a session starts once.
      if (fullState !== null && fullState !== undefined) {
        lastFullState = fullState;
        if (!sawWelcome && !standInWelcomeEmitted) {
          const standIn = buildStandInWelcome(fullState);
          if (standIn !== null) {
            standInWelcomeEmitted = true;
            for (const welcomeHandler of [...welcomeHandlers]) {
              if (standInReplayedTo.has(welcomeHandler)) continue;
              try {
                welcomeHandler(standIn);
              } catch {
                // A consumer's failure must not stop the others.
              }
            }
          }
        }
      }
      for (const handler of [...patchHandlers]) {
        try {
          handler(patches, fullState);
        } catch {
          // As above.
        }
      }
    });
    subscriptions.push(toUnsubscribe(result));
    return true;
  };

  const attachWelcomeSubscription = (): boolean => {
    const connection = readRoomConnection(page);
    if (connection === null) return false;
    const subscribe = connection.subscribeToWelcome;
    if (typeof subscribe !== 'function') return false;

    const result = subscribe.call(
      connection,
      (state: unknown, publishedAtServerMs?: number, executedCommandSequence?: number) => {
        sawWelcome = true;
        if (state !== null && state !== undefined) lastFullState = state;
        const event: WelcomeEvent = {
          state,
          executedCommandSequence: asSequence(executedCommandSequence),
          publishedAtServerMs:
            typeof publishedAtServerMs === 'number' && Number.isFinite(publishedAtServerMs)
              ? publishedAtServerMs
              : null,
          // The state alone will not have it on the shipped build, as `resolveSelfPlayerId` explains. The
          // caller's resolver, which reads the id the socket seam scraped off the wire, is what answers here.
          selfPlayerId: resolveSelfPlayerId(state, options.selfPlayerIdResolver),
        };
        if (event.executedCommandSequence !== null) observeFrontier(event.executedCommandSequence);
        if (event.selfPlayerId !== null) lastSelfPlayerId = event.selfPlayerId;
        for (const handler of [...welcomeHandlers]) {
          try {
            handler(event);
          } catch {
            // As above.
          }
        }
      },
    );
    subscriptions.push(toUnsubscribe(result));
    return true;
  };

  /** Keep the best frontier we have seen, since the publication object can vanish mid-session. */
  const observeFrontier = (value: number): void => {
    if (lastFrontier === null || value > lastFrontier) lastFrontier = value;
  };

  // Subscribe eagerly for welcome/patches (both are cheap, the welcome may fire immediately, and eager
  // subscription is what lets a late subscriber still learn `selfPlayerId`), and lazily for room frames
  // (whose only purpose here is to feed the transport, which attaches later).
  attachWelcomeSubscription();
  attachPatchSubscription();
  attachFrameSubscription();

  const binding: RoomConnectionBinding = {
    kind: 'room-connection',

    connection: () => readRoomConnection(page),

    available: () => readRoomConnection(page) !== null,

    isCommandSessionReady(): boolean {
      const connection = readRoomConnection(page);
      if (connection === null) return false;
      const flag = connection.isCommandSessionReady;
      // The field is authoritative *when it is a boolean*: `true` means a command session is open, and
      // `false` means one is not, even on a build that also exposes the synchronous send. Trusting the
      // send path over an explicit `false` would push stamped commands at a session that is not ready.
      // Appendix A warns about that case ("hands a now-invalid sequence number to a session that hasn't
      // opened yet").
      if (flag === true) return true;
      if (flag === false) return false;
      // Absent on this build. The best available signal is "there is a way to send at all"; a request that
      // arrives too early is refused by `trySendMessageNow` returning `false`, which the transport reports
      // honestly rather than counting as sent. Requiring a *frontier* here would have been wrong as well as
      // arbitrary: some builds expose no frontier until after the first frame.
      return (
        typeof connection.trySendMessageNow === 'function' || typeof connection.sendMessage === 'function'
      );
    },

    readFrontier(): number | null {
      const connection = readRoomConnection(page);
      if (connection === null) return lastFrontier;
      const publication = connection.lastDistributedRoomPublication;
      if (publication === null || publication === undefined) return lastFrontier;
      const value = asSequence(publication.executedCommandSequence);
      if (value === null) return lastFrontier;
      observeFrontier(value);
      // The *high-water mark*, not the raw field. This runs before every stamp, and the field it reads is
      // the live one, which can legitimately regress for a moment: a stale `RoomFrame` that overtook a
      // newer publication, or a reconnect that restarts the server's numbering. Returning the raw value
      // would hand `FrontierAnchoredStrategy` a *lower* frontier and make it re-issue numbers the server
      // may already have executed, which is the duplicate it drops silently.
      return lastFrontier;
    },

    readState(): unknown {
      const connection = readRoomConnection(page);
      return connection === null ? null : (connection.lastRoomStateJsonable ?? null);
    },

    send(payload: unknown): boolean {
      const connection = readRoomConnection(page);
      if (connection === null) return false;
      // Prefer the synchronous path for commands. Appendix A is explicit that `sendMessage` "queues
      // instead, which hands a now-invalid sequence number to a session that hasn't opened yet", so
      // queueing a stamped command is not merely slower, it is wrong.
      if (typeof connection.trySendMessageNow === 'function') {
        try {
          return connection.trySendMessageNow(payload) !== false;
        } catch {
          return false;
        }
      }
      if (typeof connection.sendMessage === 'function') {
        try {
          connection.sendMessage(payload);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    },

    sendNow(payload: unknown): boolean {
      const connection = readRoomConnection(page);
      if (connection === null || typeof connection.trySendMessageNow !== 'function') return false;
      try {
        return connection.trySendMessageNow(payload) !== false;
      } catch {
        return false;
      }
    },

    subscribeToWelcome(handler: (event: WelcomeEvent) => void): () => void {
      welcomeHandlers.add(handler);
      // A late subscriber still learns the current state: Appendix A says the callback "fires immediately
      // with the current state if you subscribe after the fact", but that is a promise about the *game's*
      // implementation. Standing in for it closes the gap when the build does not. The earlier version of
      // this required a `selfPlayerId` that only a real `Welcome` could have set, so on a session whose
      // `Welcome` was missed entirely it emitted nothing at all and the client never became ready.
      //
      // This is a replay to one subscriber, not another session start, so it is not gated by
      // `standInWelcomeEmitted`: a subscriber that arrived after the session started still needs the event.
      const standIn = buildStandInWelcome(lastFullState ?? binding.readState());
      if (standIn !== null) {
        standInReplayedTo.add(handler);
        try {
          handler(standIn);
        } catch {
          // A handler's failure is its own.
        }
      }
      return () => {
        welcomeHandlers.delete(handler);
        standInReplayedTo.delete(handler);
      };
    },

    subscribeToPatches(handler: (patches: unknown, fullState: unknown) => void): () => void {
      patchHandlers.add(handler);
      return () => {
        patchHandlers.delete(handler);
      };
    },

    subscribeToRoomFrames(handler: ((frame: RoomFrameEvent) => void) | ((raw: string) => void)): () => void {
      // Distinguish by arity is impossible, so register in both channels and let the unused registration be a
      // no-op: the structured observers receive a `RoomFrameEvent`, the raw handlers receive a string, and a
      // handler written for one shape ignores the other without throwing.
      roomFrameObservers.add(handler as (frame: RoomFrameEvent) => void);
      frameHandlers.add(handler as (raw: string) => void);
      return () => {
        roomFrameObservers.delete(handler as (frame: RoomFrameEvent) => void);
        frameHandlers.delete(handler as (raw: string) => void);
      };
    },

    sink(): AttachedSink {
      return createRoomConnectionSink({
        onFrame: (handler) => {
          frameHandlers.add(handler);
          return () => frameHandlers.delete(handler);
        },
        onWelcome: (handler) => {
          welcomeHandlers.add(handler);
          return () => welcomeHandlers.delete(handler);
        },
        addOutbound: (interceptor) => {
          outbound.add(interceptor);
        },
        removeOutbound: (interceptor) => {
          outbound.delete(interceptor);
        },
        frontier: () => binding.readFrontier(),
        ready: () => binding.isCommandSessionReady(),
        sendNow: (payload) => binding.sendNow(payload),
        sendQueued: (payload) => {
          const connection = readRoomConnection(page);
          if (connection === null || typeof connection.sendMessage !== 'function') return false;
          try {
            connection.sendMessage(interceptOutbound(payload));
            return true;
          } catch {
            return false;
          }
        },
      });
    },

    setOutboundRewriter(rewriter: ((payload: unknown) => unknown) | null): void {
      if (activeRewriter !== null) outbound.delete(activeRewriter);
      activeRewriter = rewriter;
      if (rewriter !== null) outbound.add(rewriter);
    },

    hooksActive(): boolean {
      const connection = readRoomConnection(page);
      if (connection === null) return false;
      return (
        (typeof connection.sendMessage === 'function' && isBranded(connection.sendMessage)) ||
        (typeof connection.trySendMessageNow === 'function' && isBranded(connection.trySendMessageNow))
      );
    },

    release(): void {
      if (released) return;
      released = true;
      for (const unsubscribe of subscriptions.splice(0)) {
        try {
          unsubscribe();
        } catch {
          // Teardown must complete.
        }
      }
      // Identity-guarded restore, in reverse order: if another mod wrapped our wrapper, that mod's hook
      // stays installed (brand.ts).
      for (const releaseHook of hookReleases.splice(0).reverse()) {
        try {
          releaseHook();
        } catch {
          // As above.
        }
      }
      frameHandlers.clear();
      roomFrameObservers.clear();
      welcomeHandlers.clear();
      standInReplayedTo.clear();
      patchHandlers.clear();
      outbound.clear();
      // The high-water mark is per binding. Clearing it here stops a fresh binding after a reconnect from
      // inheriting a frontier belonging to a session that has ended.
      lastFrontier = null;
      activeRewriter = null;
    },
  };

  return binding;
}
