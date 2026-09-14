/**
 * `AttachedTransport`: the `@mg.js/common` transport seam, implemented over someone else's socket.
 *
 * ## The four rules, and where each one is enforced
 *
 * `@mg.js/common`'s `transport/seam.ts` states what an `attached` transport must do, and every one of the
 * four is a way this could break the *host game* rather than merely itself:
 *
 *   1. **`send(raw)` must go through the host's own send path.** The interface's own comment: "In the
 *      bootstrapped case this route passes *through* the game's own send path, so that any coexistence
 *      hook installed on it sees our frames like any other. That is how the renumbering hook keeps one
 *      consistent counter." So this class does **not** hold a socket and call `socket.send`;
 *      it calls `sink.sendRaw`, which is the hooked path.
 *
 *   2. **`close()` must detach, never close.** "For an `attached` transport this detaches listeners and
 *      releases hooks rather than closing the host's socket, so the host game keeps running." {@link close}
 *      therefore sets state to `'closed'`, fires the close event, and detaches. The one thing it must not do
 *      is call `socket.close()`. That would disconnect the player from their game because a mod unloaded.
 *
 *   3. **It must not answer the keepalive.** `ClientCoreOptions.autoHandledKeepalive`: "the bootstrapped
 *      transport must not [answer it], because the host game answers it." The client is constructed with
 *      `autoHandledKeepalive: false` (see `client.ts`), which is the documented way to express this. This
 *      module also never consumes keepalives from the inbound stream, because
 *      `Transport.onMessage` says "Not called for keepalives the transport consumed itself"; we consume
 *      none, so every frame reaches the core and the core's own keepalive handling is what applies.
 *
 *   4. **It must not consume the host's frames exclusively; it observes.** Every inbound frame is delivered
 *      to our listeners *and* the game's own listeners keep firing, because the room-connection path rides
 *      `subscribeTo*` (which is multi-subscriber by contract) and the socket path adds listeners without
 *      removing any. Nothing here ever calls `stopPropagation`, and nothing here replaces a handler.
 *
 * ## Why `send` is synchronous but the host's may not be
 *
 * `Transport.send` returns `void`. The room connection's `trySendMessageNow` returns a boolean, and the socket's
 * `send` returns nothing. So this class reports the outcome through the `open`/`close` event stream and through
 * {@link AttachedTransport.lastSendResult} rather than by returning it; a caller that needs to know keeps a
 * `CommandHandle`, which is where that information actually belongs.
 *
 * ## The readiness gate
 *
 * `state` is derived, not stored: it is `'open'` when the sink says it can send, `'closed'` once `close()` has
 * run, and `'connecting'` otherwise. Deriving it is the only way to be correct on a page where the game
 * reconnects underneath us: the recon says the room connection reconnects transparently, and a stored
 * `'open'` would keep claiming readiness across a gap in which every command is dropped.
 */

import type {
  Transport,
  TransportCloseInfo,
  TransportKind,
  TransportState,
  Unsubscribe,
} from '@mg.js/common';
import { Emitter, isKeepalivePing, watchUntil } from '@mg.js/common';
import type { AttachedSink, WelcomeEvent } from './room-connection.js';

/**
 * Re-frame a room-path `Welcome` event as the message the core already knows how to parse.
 *
 * The two attachment paths deliver the start of a session in different shapes, and only one of them was
 * reaching the core:
 *
 *   - the **raw socket** scrapes the actual `Welcome` frame off the wire and hands it over as a string, so
 *     the core parses it and goes ready;
 *   - the **room object** delivers it as a *callback* (`subscribeToWelcome`), which was stored for
 *     diagnostics and never given to the core at all.
 *
 * So on the documented, preferred path the client sat at `ready: false` with no `playerId` while state
 * poured in. A live badge read `attach kind: room-connection`, `ready: false`, `playerId: -`, `433 patches
 * applied`. Nothing was wrong with the connection; the core was never told the session had started.
 *
 * `fullState` is omitted rather than sent as `undefined` (`JSON.stringify` drops the key), and the core
 * already tolerates a `Welcome` without it.
 */
function welcomeToFrame(event: WelcomeEvent): string | null {
  try {
    return JSON.stringify({
      type: 'Welcome',
      selfPlayerId: event.selfPlayerId,
      executedCommandSequence: event.executedCommandSequence,
      publishedAtServerMs: event.publishedAtServerMs,
      fullState: event.state,
    });
  } catch {
    // A state with a cycle cannot be re-framed; the frame path still carries the patches, so the session is
    // merely less well described rather than broken.
    return null;
  }
}

/** What the last {@link AttachedTransport.send} attempt did. */
export interface SendAttempt {
  raw: string;
  at: number;
  accepted: boolean;
}

/** Options for {@link AttachedTransport}. */
export interface AttachedTransportOptions {
  /** The sink provided by `attach/detect.ts`. */
  sink: AttachedSink;
  /** A human-readable endpoint for logs and diagnostics, e.g. `"attached:room-connection"`. */
  endpoint?: string;
  /** How often to re-poll the sink's readiness, in ms. Default 1000. `0` disables polling. */
  readinessPollMs?: number;
  /** Timer injection for tests. */
  schedule?: (callback: () => void, delayMs: number) => unknown;
}

/**
 * The transport's events.
 *
 * A `type` alias rather than an interface for the reason `ClientEvents` documents: TypeScript gives
 * implicit index signatures to type aliases of object types but not to interfaces, and `Emitter`'s
 * `TEvents extends EventMap` constraint needs one.
 */
type AttachedTransportEvents = {
  message: [string];
  open: [];
  close: [TransportCloseInfo];
  /**
   * A frame this transport handed to the sink **and the sink accepted**.
   *
   * Emitted after the attempt, not before, so an observer is never told a frame went out that did not. A
   * refused send is `lastSendResult.accepted === false` instead. Observe-only: this is emitted after the
   * coexistence rewriter has run, so a subscriber consumes no sequence number and cannot displace
   * `Renumberer`, the reason `room-binding.ts` keeps its interceptor slot singular.
   */
  send: [string];
};

/**
 * The transport.
 *
 * `kind` is `'attached'` unconditionally, which is a claim the whole package rests on: the shared core must
 * never reconnect (`ClientCore` has no reconnect logic at all), never close the socket, and never answer the
 * keepalive. All three follow from this one field being correct.
 *
 * `Emitter`'s default `onListenerError` is **not** overridden by design: it swallows, as this transport has
 * always done. A consumer's failure must not stop the other consumers, and must never reach
 * the game's dispatch.
 */
export class AttachedTransport extends Emitter<AttachedTransportEvents> implements Transport {
  readonly kind: TransportKind = 'attached';

  private sink: AttachedSink;
  private endpointValue: string;
  private readonly detachers: Unsubscribe[] = [];

  private closed = false;
  private lastOpenState = false;
  private stopWatch: (() => void) | null = null;
  private lastSend: SendAttempt | null = null;
  private lastErrorValue: unknown = null;
  private lastWelcomeValue: WelcomeEvent | null = null;

  constructor(options: AttachedTransportOptions) {
    super();

    this.sink = options.sink;
    this.endpointValue = options.endpoint ?? `attached:${options.sink.kind}`;

    // Observe inbound frames. Because this only *adds* listeners, the game's own subscribers are unaffected;
    // rule 4.
    this.detachers.push(
      this.sink.onFrame((raw) => {
        this.emit('message', raw);
      }),
    );

    this.detachers.push(
      this.sink.onWelcome((event) => {
        this.lastWelcomeValue = event;
        // The room path is the only one that reaches here, and it delivers `Welcome` as a callback rather
        // than as a frame. Hand the core the same shape it would have received from the socket, or it never
        // learns that the session started.
        const raw = welcomeToFrame(event);
        if (raw === null) return;
        this.emit('message', raw);
      }),
    );

    // Readiness is polled rather than evented: the room connection exposes a *boolean* field, not a
    // subscription, and the socket path has no open-event subscription by design (see `raw-socket.ts`). One
    // cheap property read per second is the correct cost for being able to report open/close at all.
    const pollMs = options.readinessPollMs ?? 1_000;
    if (pollMs > 0) {
      const schedule =
        options.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
      const cancelSchedule = (handle: unknown): void => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      };
      // A *level observer*, not a deadline poll: readiness is a boolean field with no subscription, and the
      // transport must notice every edge for the life of the page, including a reconnect underneath us.
      // There is no "found" answer and no fabricated deadline by design; the watch ticks until
      // `stopWatch()` runs from `close()`. `syncReadiness` is idempotent between edges (it returns early
      // when the state has not changed).
      this.stopWatch = watchUntil<never>({
        attempt: () => {
          this.syncReadiness();
          return null;
        },
        // Deferred exactly like the loop it replaces: the first readiness comparison is one interval in.
        firstAttempt: 'afterInterval',
        timeoutMs: Number.POSITIVE_INFINITY,
        intervalMs: pollMs,
        schedule,
        cancelSchedule,
      });
    }
  }

  /** The URL or pseudo-URL this transport is carrying, for logs. */
  get endpoint(): string {
    return this.endpointValue;
  }

  /** Why the transport last failed, when it did. */
  get lastError(): unknown {
    return this.lastErrorValue;
  }

  /** The most recent `Welcome`-equivalent event. Not part of the `Transport` interface; diagnostics. */
  get lastWelcome(): WelcomeEvent | null {
    return this.lastWelcomeValue;
  }

  /** What the last send attempt did. Not part of the `Transport` interface; diagnostics. */
  get lastSendResult(): SendAttempt | null {
    return this.lastSend;
  }

  /**
   * Derived, never stored.
   *
   * See the class header: a stored state would be wrong across the transparent reconnects the room
   * connection performs.
   */
  get state(): TransportState {
    if (this.closed) return 'closed';
    try {
      return this.sink.canSend() ? 'open' : 'connecting';
    } catch (error) {
      // A sink whose readiness check throws (a half-torn-down room connection) is not open.
      this.lastErrorValue = error;
      return 'connecting';
    }
  }

  /**
   * Send one already-serialised frame through the host's own send path.
   *
   * Rule 1, and the reason this method is three lines: the work is in `sink.sendRaw`, which routes through the
   * hooked `sendMessage`/`trySendMessageNow`/`send`. The string is not mutated, because the `Transport`
   * contract requires that; the renumbering hook is what rewrites frames, visibly, one layer down.
   */
  send(raw: string): void {
    if (this.closed) {
      this.lastSend = { raw, at: Date.now(), accepted: false };
      return;
    }
    let accepted = false;
    try {
      accepted = this.sink.sendRaw(raw);
    } catch (error) {
      this.lastErrorValue = error;
      accepted = false;
    }
    this.lastSend = { raw, at: Date.now(), accepted };
    if (accepted) {
      this.syncReadiness();
      this.emit('send', raw);
    }
  }

  /**
   * Detach. **Never** closes the host's socket.
   *
   * Rule 2. The distinction is not pedantic: the same method name on the standalone transport *does* close its
   * own socket, and a bootstrapped implementation that copied that behaviour would disconnect the player's game
   * whenever a mod was unloaded. So this method:
   *
   *   1. marks itself closed, so `state` and `send` stop claiming otherwise;
   *   2. fires the close event, so `ClientCore` fails every pending command with `wasManual: true`;
   *   3. runs every detacher (our subscriptions) and clears them;
   *   4. leaves the socket and every game subscription alone.
   *
   * `code`/`reason` are accepted for interface compatibility and recorded for diagnostics, because there is
   * nothing to pass them to: the socket is the game's.
   */
  close(code = 1000, reason = 'mg.js detached'): void {
    if (this.closed) return;
    this.closed = true;
    this.stopPolling();

    const info: TransportCloseInfo = {
      code,
      reason,
      // Local detachment is clean by definition: we intended it and completed it.
      wasClean: true,
      // True, and required: `ClientCore` distinguishes a manual close from a lost connection, and this is
      // the manual case. Getting this wrong would make `dispose()` report the player's session as lost.
      wasManual: true,
    };

    for (const detach of this.detachers.splice(0)) {
      try {
        detach();
      } catch {
        // Detaching must always complete.
      }
    }
    // The sink's own detach is a no-op by design (the binding owns the hooks), but calling it keeps the seam
    // honest for a future sink that does own something.
    try {
      this.sink.detach();
    } catch {
      // As above.
    }

    this.emit('close', info);
  }

  /**
   * Point the transport at a real sink, replacing the inert startup one.
   *
   * Necessary because `ClientCore` takes its transport in its constructor and has no way to swap it later,
   * while attachment cannot happen until the game has created its connection, and `@run-at document-start`
   * runs before that by design. So the transport object is stable and its *sink* is what changes.
   *
   * The old sink's subscriptions are released first, and the new sink's readiness is compared against the last
   * reported state so that an already-open sink fires exactly one `open` event rather than staying silent until
   * the next poll.
   *
   * @returns `true` when the sink was replaced.
   */
  attachSink(sink: AttachedSink): boolean {
    if (this.closed) return false;
    if (sink === this.sink) return false;

    for (const detach of this.detachers.splice(0)) {
      try {
        detach();
      } catch {
        // Releasing the old sink's subscriptions must complete.
      }
    }
    // Detach the old sink itself. For the inert startup sink and the two real sinks this is a documented
    // no-op, since the binding owns the hooks, but calling it keeps this method correct for a sink that
    // does own something.
    try {
      this.sink.detach();
    } catch {
      // As above.
    }

    this.sink = sink;
    this.endpointValue = `attached:${sink.kind}`;

    this.detachers.push(
      this.sink.onFrame((raw) => {
        this.emit('message', raw);
      }),
    );
    this.detachers.push(
      this.sink.onWelcome((event) => {
        this.lastWelcomeValue = event;
        // The room path is the only one that reaches here, and it delivers `Welcome` as a callback rather
        // than as a frame. Hand the core the same shape it would have received from the socket, or it never
        // learns that the session started.
        const raw = welcomeToFrame(event);
        if (raw === null) return;
        this.emit('message', raw);
      }),
    );

    // Re-evaluate readiness immediately: the first poll is up to a second away, and a sink that is already
    // open must say so now rather than sitting in `'connecting'`.
    this.syncReadiness();
    return true;
  }

  /**
   * Set `state` to the sink's own only when the sink does not answer.
   *
   * `sink.kind === 'none'` reports `canSend() === false`, which yields `'connecting'`, the honest answer
   * for a page with no game connection. This getter exists so that a caller reading `state` on a detached
   * client gets `'idle'` rather than a permanent `'connecting'`, which would imply an attempt in progress.
   */
  get isIdle(): boolean {
    if (this.closed) return false;
    return this.sink.kind === 'none';
  }

  /**
   * A raw inbound frame.
   *
   * Rule 3 in practice: no keepalive filtering happens here. The `Transport` contract says onMessage is "Not
   * called for keepalives the transport consumed itself"; this transport consumes none, so the core sees
   * everything and its own `autoHandledKeepalive: false` setting is what applies. Filtering here would be a
   * second, competing policy.
   */
  onMessage(handler: (raw: string) => void): Unsubscribe {
    return this.on('message', handler);
  }

  /** The transport became usable. */
  onOpen(handler: () => void): Unsubscribe {
    const detach = this.on('open', handler);
    // Registering while already open still fires, on the next microtask: `ClientCore` attaches its listeners
    // in its constructor, and a transport that was already open at that moment must not stay silent.
    if (!this.closed && this.isSinkReady()) {
      queueMicrotask(() => {
        if (this.closed) return;
        try {
          handler();
        } catch {
          // A listener's failure is its own.
        }
      });
    }
    return detach;
  }

  /** The transport stopped being usable. */
  onClose(handler: (info: TransportCloseInfo) => void): Unsubscribe {
    return this.on('close', handler);
  }

  /**
   * Every outbound frame this transport put on the wire, as it was written.
   *
   * The only seam every outbound frame passes through whichever attachment path won, and the alternative was
   * for a consumer to patch the host socket itself and re-implement the envelope test
   * `coexistence/envelope.ts` already owns. `client.ts` records both reference mods doing that.
   * Delivery follows this transport's inheritance from `Emitter`: a throwing observer is logged and the rest
   * still run, so a consumer's failure never reaches the game's dispatch.
   */
  onSend(handler: (raw: string) => void): Unsubscribe {
    return this.on('send', handler);
  }

  // ------------------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------------------

  private isSinkReady(): boolean {
    try {
      return this.sink.canSend();
    } catch (error) {
      this.lastErrorValue = error;
      return false;
    }
  }

  /**
   * Compare the sink's readiness against what we last reported, and fire the matching event.
   *
   * The edge, not the level: `ClientCore` treats `open` as "the socket became usable" and would otherwise be
   * re-notified every poll, re-running its `emit('open')` and any listener's side effects once a second.
   */
  private syncReadiness(): void {
    if (this.closed) return;
    const ready = this.isSinkReady();
    if (ready === this.lastOpenState) return;
    this.lastOpenState = ready;

    if (ready) {
      this.emit('open');
      return;
    }
    this.emit('close', {
      code: 1006,
      reason: "the host game's connection is no longer usable",
      wasClean: false,
      // Not manual: we did not ask for this, so `ClientCore` must treat it as a lost connection and let
      // pending commands fail as `superseded` rather than hand back an unconfirmed result.
      wasManual: false,
    });
  }

  /**
   * Stop the readiness poll. Called by `close()`.
   *
   * The stop cancels the pending tick outright, which is strictly stronger than the `unref` this replaces:
   * an `unref`'d timer still fires, it merely stops holding the event loop open.
   */
  private stopPolling(): void {
    this.stopWatch?.();
    this.stopWatch = null;
  }
}

/**
 * Whether a raw frame is the bare-string keepalive.
 *
 * Re-exported from `@mg.js/common` so a caller can assert that this transport keeps its hands off it; the
 * function is common's own, so the two packages cannot disagree about what a keepalive looks like.
 */
export { isKeepalivePing };
