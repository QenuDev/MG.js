/**
 * `StandaloneTransport`: the socket, owned outright.
 *
 * This is the whole difference between the headless client and the page-attached one: nothing else is
 * on this socket, so nothing has to be negotiated, renumbered or shared. The transport implements the
 * five-member {@link Transport} seam from `@mg.js/common` and gets the entire protocol core for free.
 *
 * FOUR THINGS IN HERE ARE REQUIRED, AND EACH HAS A DOCUMENTED REASON
 * --------------------------------------------------------------------
 * 1. **The bare-string keepalive is consumed here, not upstream.** Protocol recon §1.7:
 *    "After the handshake, the server also sends application-level text pings as the bare string
 *    `"ping"` (not a WebSocket protocol ping). Reply with the bare string `"pong"`, verbatim, no JSON
 *    wrapper. Miss enough of these and the server drops you with close code `4400`." And §1.8 lists
 *    `4400 (idle)`.
 *
 *    The exact quoting has been observed BOTH ways, so both `ping` and `"ping"` are treated
 *    as the keepalive (`isKeepalivePing` in `@mg.js/common`), and the reply is the bare string
 *    `pong`, never `"pong"` and never `{"type":"Pong"}` (that is the reply to the *flat `Ping`
 *    action*, a different mechanism the doc warns not to confuse with this one). The keepalive is not
 *    surfaced to the client core as a message: it is not a protocol frame, and the core's parser would
 *    file it under `unparsed`.
 *
 * 2. **`ClientCoreOptions.autoHandledKeepalive` is `false`.** The core's own keepalive branch exists
 *    for the bootstrapped case; the common package documents that "the headless transport does this
 *    itself and passes `false`". Since this transport never emits the keepalive as a message, the
 *    core's branch would be dead code here anyway, but leaving it on would double-reply if a future
 *    refactor ever let the frame through, and the server tolerates neither noise nor ambiguity.
 *
 * 3. **Close information is serialised into {@link TransportCloseInfo} and
 *    `wasManual` is tracked here.** `analyzeClose(code, reason, wasManual)` in the common package turns
 *    `wasManual` into the `stop` disposition, so a local `close()` must be distinguishable from a
 *    server-initiated drop or `disconnect()` would trigger the reconnect loop it is meant to stop.
 *    `wasClean` is copied from the event rather than assumed.
 *
 * 4. **No socket event handler may throw.** A throw inside an `EventTarget` listener in Node surfaces
 *    as an unhandled exception that kills the process, which for a long-running headless bot is a far
 *    worse outcome than dropping one frame. Every handler body is wrapped, and every listener call is
 *    isolated as well, so one bad subscriber cannot take out the others.
 *
 * It also refuses to lie about headers: see `transport/headers.ts`. The intended `Origin` /
 * `User-Agent` / `Cookie` set is always computed, and applied only when the resolved runtime declares
 * that it forwards an `options.headers` bag.
 */

import type {
  ObservableTransport,
  TransportCloseInfo,
  TransportKind,
  TransportState,
  Unsubscribe,
} from '@mg.js/common';
import {
  DEFAULT_LIFECYCLE_TIMEOUTS,
  Emitter,
  isKeepalivePing,
  KEEPALIVE_PONG,
  MAX_FRAME_BYTES,
  unrefTimer,
  utf8ByteLength,
} from '@mg.js/common';
import type { ConnectHeaders } from './headers.js';
import type {
  SocketCloseEventLike,
  SocketLike,
  SocketMessageEventLike,
  WebSocketRuntime,
} from './runtime.js';
import { decodeSocketPayload } from './runtime.js';

/** The WebSocket `readyState` constants, written out rather than imported (DOM and `ws` both define them). */
const WS_CONNECTING = 0;
const WS_OPEN = 1;

/** Options for {@link StandaloneTransport}. */
export interface StandaloneTransportOptions {
  /** The resolved runtime: the constructor, plus whether it can carry headers. */
  runtime: WebSocketRuntime;
  /**
   * Headers the caller *wants* sent. Applied only when `runtime.supportsHeaders`.
   *
   * Computed by `transport/headers.ts` and possibly augmented by an `AuthProvider`.
   */
  headers?: ConnectHeaders | undefined;
  /**
   * Called when the runtime cannot carry headers, so the caller can log or fail loudly.
   *
   * A callback rather than a thrown error because the guest path works fine without headers, and
   * refusing to connect would turn a degradation into an outage.
   */
  onHeadersUnsupported?: ((headers: ConnectHeaders) => void) | undefined;
  /**
   * How long to wait for the socket to open before giving up and closing it, in ms.
   *
   * Default `DEFAULT_LIFECYCLE_TIMEOUTS.openMs` (20s) from the common package. A socket that never
   * fires `open` would otherwise hang `connect()` forever; the protocol gives no open timeout because
   * browsers have one internally, which a Node client does not inherit.
   */
  openTimeoutMs?: number | undefined;
  /**
   * Force the URL scheme (`'ws'` or `'wss'`) instead of keeping the one in the URL.
   *
   * The connect URL is always built as `wss://`, the scheme §1.3 documents and the one the real host
   * speaks. This exists for the one case that is not the real host: a local or reverse-proxied
   * plaintext endpoint (the integration tests' mock server). It is an escape hatch, not a feature of the
   * protocol, and the caller has to ask for it explicitly.
   */
  scheme?: 'ws' | 'wss' | undefined;
  /**
   * The largest inbound frame this transport will accept, in bytes. Defaults to `MAX_FRAME_BYTES`.
   *
   * Enforced twice, because no single mechanism covers every runtime: it is passed to the socket
   * constructor as `maxPayload` (which the `ws` runtime enforces at the protocol layer, so the frame is
   * never even decoded) and re-checked in `handleMessage` (because a browser or undici `WebSocket`
   * ignores the unknown third constructor argument). A frame over the cap closes the socket with `1009`.
   */
  maxFrameBytes?: number | undefined;
}

/** Subscribe/unsubscribe pair, kept so listeners can be removed on teardown. */
interface SocketBindings {
  readonly onOpen: () => void;
  readonly onClose: (event: SocketCloseEventLike) => void;
  readonly onMessage: (event: SocketMessageEventLike) => void;
  readonly onError: (event: unknown) => void;
}

/**
 * The transport's events.
 *
 * A `type` alias rather than an interface for the reason `ClientEvents` documents: TypeScript gives
 * implicit index signatures to type aliases of object types but not to interfaces, and `Emitter`'s
 * `TEvents extends EventMap` constraint needs one.
 */
type TransportEvents = { message: [string]; open: []; close: [TransportCloseInfo] };

/**
 * A transport that opens and owns a single WebSocket.
 *
 * Lifecycle: `idle` → `connecting` → `open` → (`closing`) → `closed`. {@link connect} may be called
 * again after `closed`, and that is what makes reconnect possible; every connect increments an internal
 * generation counter so a late event from a torn-down socket can never be attributed to the new one.
 */
export class StandaloneTransport extends Emitter<TransportEvents> implements ObservableTransport {
  readonly kind: TransportKind = 'standalone';

  private readonly runtime: WebSocketRuntime;
  private readonly headers: ConnectHeaders | undefined;
  private readonly onHeadersUnsupported: ((headers: ConnectHeaders) => void) | undefined;
  private readonly openTimeoutMs: number;
  private readonly scheme: 'ws' | 'wss' | undefined;
  private readonly maxFrameBytes: number;

  private currentState: TransportState = 'idle';
  private socket: SocketLike | null = null;
  private bindings: SocketBindings | null = null;
  private endpointValue = '';
  private lastErrorValue: unknown = null;

  /** Generation of the live socket. Events carrying an older generation are ignored. */
  private generation = 0;
  /** True once the close for the current generation has been dispatched. */
  private closeDispatched = true;
  /** True when this side called `close()` for the current generation. */
  private manualClose = false;
  private openTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Settles the `connect()` promise that is currently in flight, when there is one.
   *
   * That promise is resolved from inside socket event listeners, so anything which tears the socket down
   * *without* those events ({@link dispose}, or a {@link close} whose `socket.close()` throws) has to
   * settle it explicitly, or the caller waits forever on a socket that no longer exists.
   */
  private settleConnect: ((error?: unknown) => void) | null = null;

  constructor(options: StandaloneTransportOptions) {
    super();

    this.runtime = options.runtime;
    this.headers = options.headers;
    this.onHeadersUnsupported = options.onHeadersUnsupported;
    // The default comes from `common`, which owns the documented lifecycle timeouts, rather than from a
    // second literal here: this line used to read `?? DEFAULT_OPEN_TIMEOUT_MS`, a local constant whose
    // merely claimed in a comment to mirror `DEFAULT_LIFECYCLE_TIMEOUTS.openMs`. Two copies, one dead.
    this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_LIFECYCLE_TIMEOUTS.openMs;
    this.scheme = options.scheme;
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  }

  // ------------------------------------------------------------------------------------
  // Transport surface
  // ------------------------------------------------------------------------------------

  get state(): TransportState {
    return this.currentState;
  }

  /** The `wss://` URL currently (or most recently) carried, for logs and diagnostics. */
  get endpoint(): string {
    return this.endpointValue;
  }

  /** Why the socket last failed, when it did. */
  get lastError(): unknown {
    return this.lastErrorValue;
  }

  /** True when the socket is open and writable. */
  get isOpen(): boolean {
    return this.currentState === 'open' && this.socket !== null && this.socket.readyState === WS_OPEN;
  }

  /** Whether the resolved runtime can actually send the `Origin`/`User-Agent`/`Cookie` headers. */
  get supportsHeaders(): boolean {
    return this.runtime.supportsHeaders;
  }

  /**
   * Open the socket.
   *
   * Resolves when the socket is open; rejects when the constructor throws, when the socket errors
   * before opening, or when it fails to open inside {@link openTimeoutMs}. A rejection here is a
   * failed *attempt*, not a dead client, and the caller decides whether to retry.
   */
  async connect(url: string): Promise<void> {
    if (this.currentState === 'connecting') {
      throw new Error(`StandaloneTransport is already connecting to ${this.endpointValue}`);
    }
    if (this.currentState === 'open') {
      throw new Error(`StandaloneTransport is already open on ${this.endpointValue}`);
    }

    // Only rewrite the scheme when the caller asked for it; a mismatch between a `wss://` URL and a
    // plaintext listener produces an opaque TLS failure, so getting this wrong is loud rather than silent.
    const target =
      this.scheme === undefined
        ? url
        : url.replace(/^wss:/, `${this.scheme}:`).replace(/^ws:/, `${this.scheme}:`);

    this.endpointValue = target;
    this.lastErrorValue = null;
    this.manualClose = false;
    this.closeDispatched = false;
    this.currentState = 'connecting';

    this.generation += 1;
    const generation = this.generation;

    // The intended headers are always computed; whether they can be sent is the runtime's business.
    if (this.headers && !this.runtime.supportsHeaders && this.onHeadersUnsupported) {
      try {
        this.onHeadersUnsupported(this.headers);
      } catch {
        // Reporting is best-effort; it must not prevent the connect.
      }
    }

    const constructorOptions: Record<string, unknown> = { maxPayload: this.maxFrameBytes };
    if (this.headers && this.runtime.supportsHeaders) {
      constructorOptions.headers = { ...this.headers };
    }

    let socket: SocketLike;
    try {
      // `protocols` is `undefined` on purpose: the Quinoa endpoint takes no subprotocol, and passing
      // an empty array is what undici expects for "none".
      socket = new this.runtime.factory(target, undefined, constructorOptions);
    } catch (error) {
      this.lastErrorValue = error;
      this.currentState = 'closed';
      this.closeDispatched = true;
      throw error;
    }

    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const settle = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        this.settleConnect = null;
        this.clearOpenTimer();
        if (error === undefined) resolve();
        else reject(error);
      };
      this.settleConnect = settle;

      const bindings: SocketBindings = {
        onOpen: () => {
          if (generation !== this.generation) return;
          try {
            this.currentState = 'open';
            this.clearOpenTimer();
            this.emit('open');
            settle();
          } catch (error) {
            settle(error);
          }
        },
        onMessage: (event) => {
          if (generation !== this.generation) return;
          try {
            this.handleMessage(event);
          } catch (error) {
            // Never rethrow out of an EventTarget listener.
            this.lastErrorValue = error;
          }
        },
        onClose: (event) => {
          if (generation !== this.generation) return;
          try {
            const info = this.handleClose(event);
            // A close before `open` means the connect attempt failed.
            settle(
              new Error(
                `Socket to ${this.endpointValue} closed before it opened (code ${info.code}` +
                  `${info.reason ? `, reason ${JSON.stringify(info.reason)}` : ''}).`,
              ),
            );
          } catch (error) {
            settle(error);
          }
        },
        onError: (event) => {
          if (generation !== this.generation) return;
          // The error event carries no useful payload in either implementation, and a close event
          // always follows it, so record it and let `onClose` do the reporting.
          this.lastErrorValue = event;
        },
      };

      this.bindings = bindings;
      socket.addEventListener('open', bindings.onOpen);
      socket.addEventListener('message', bindings.onMessage);
      socket.addEventListener('close', bindings.onClose);
      socket.addEventListener('error', bindings.onError);

      this.openTimer = setTimeout(() => {
        const error = new Error(
          `Socket to ${this.endpointValue} did not open within ${this.openTimeoutMs}ms.`,
        );
        this.lastErrorValue = error;
        try {
          this.manualClose = false;
          socket.close();
        } catch {
          // Ignore: the socket is already unusable.
        }
        settle(error);
      }, this.openTimeoutMs);
      // Do not keep the Node event loop alive purely for the open timeout.
      unrefTimer(this.openTimer);
    });
  }

  /**
   * Write one frame.
   *
   * Throws when the socket is not open. The common core already behaves this way on a closed
   * transport, and it converts the throw into a rejected command handle, so this throw is the
   * contract the caller can rely on.
   */
  send(raw: string): void {
    const socket = this.socket;
    if (socket === null || this.currentState !== 'open') {
      throw new Error(`Cannot send: transport is ${this.currentState}, not open.`);
    }
    socket.send(raw);
  }

  /**
   * Close the socket, marking the close as local so it cannot be mistaken for a drop.
   *
   * Idempotent, and safe to call from inside a `close` handler. Code `1000` ("normal closure",
   * {@link CloseCode.Normal}) is used by default because `analyzeClose` maps it to `stop`, which is
   * precisely what a deliberate shutdown should produce even if some caller forgets `wasManual`.
   */
  close(code = 1000, reason = 'client disconnect'): void {
    this.manualClose = true;
    this.clearOpenTimer();

    const socket = this.socket;
    if (socket === null) {
      this.currentState = 'closed';
      return;
    }
    if (socket.readyState === WS_CONNECTING || socket.readyState === WS_OPEN) {
      this.currentState = 'closing';
      try {
        socket.close(code, reason);
      } catch (error) {
        this.lastErrorValue = error;
        // The close event will not arrive if `close()` itself failed, so finish the transition here,
        // so the client is not left believing it still has a socket.
        this.handleClose({ code, reason, wasClean: false });
      }
      return;
    }
    this.currentState = 'closed';
  }

  onMessage(handler: (raw: string) => void): Unsubscribe {
    return this.on('message', handler);
  }

  onOpen(handler: () => void): Unsubscribe {
    return this.on('open', handler);
  }

  onClose(handler: (info: TransportCloseInfo) => void): Unsubscribe {
    return this.on('close', handler);
  }

  /**
   * The transport's failure policy: record, do not log.
   *
   * `lastError` is the documented diagnostic a host reads after a session dies, and a subscribing core
   * that threw is the kind of thing it exists to report. This is one of the two policies that
   * differ from `Emitter`'s silent default (`HeadlessClient` logs).
   */
  protected override onListenerError(_event: keyof TransportEvents, error: unknown): void {
    this.lastErrorValue = error;
  }

  /**
   * Tear the transport down for good: close the socket it owns, detach every listener, and settle a
   * `connect()` that is still in flight.
   *
   * This is the hard path, for an owner that is itself going away, as opposed to {@link close}, the
   * graceful path a caller uses when it wants the close reported. So it does *not* notify close
   * subscribers: re-entering an owner that is mid-teardown with a close event is how you get a reconnect
   * scheduled for a client that no longer exists.
   *
   * It does close the socket. This transport *owns* that socket (the bootstrapped client, by contrast,
   * borrows the game's), so dropping the reference without closing it would leave the server holding a
   * session whose events nothing is reading, a leak whose only symptom is on the server's side.
   *
   * Idempotent.
   */
  dispose(): void {
    this.clearOpenTimer();

    // Before the listeners go: a connect that has not settled is waiting on this socket's own events.
    this.settleConnect?.(
      new Error(`The transport to ${this.endpointValue} was disposed before the socket opened.`),
    );

    const socket = this.socket;
    this.manualClose = true;
    // Invalidate the generation as well as detaching: `detachSocket` may not be able to remove a
    // listener from every adapter, and its generation guard is what makes such a leftover harmless.
    this.generation += 1;
    this.closeDispatched = true;
    this.detachSocket();

    if (socket !== null && (socket.readyState === WS_CONNECTING || socket.readyState === WS_OPEN)) {
      try {
        socket.close(1000, 'transport disposed');
      } catch (error) {
        // The socket was already unusable, so there is nothing left to close. The reference is dropped
        // either way, which is all this side can still do about it.
        this.lastErrorValue = error;
      }
    }

    this.clear();
    this.currentState = 'closed';
  }

  // ------------------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------------------

  /**
   * Handle one inbound frame.
   *
   * Keepalives are answered and swallowed; everything else is forwarded verbatim, **unless** it is over
   * the byte cap, in which case it is dropped and the socket is closed with `1009`. Note the reply is
   * the bare `pong` string in **both** quoting cases. The doc's own reference handler does the same,
   * and §1.7 is explicit that no JSON wrapper is used.
   */
  private handleMessage(event: SocketMessageEventLike): void {
    const raw = decodeSocketPayload(event);
    if (raw === null) {
      // A binary or undecodable frame. The protocol is text-only (§1.2), so this is not a frame we
      // are allowed to guess about.
      return;
    }

    if (isKeepalivePing(raw)) {
      try {
        this.send(KEEPALIVE_PONG);
      } catch (error) {
        // The socket went away between the ping arriving and the reply. The ensuing close event is
        // the real signal.
        this.lastErrorValue = error;
      }
      return;
    }

    // `utf8ByteLength` stops counting at the first byte over the cap, so `bytes` is *where* the cap was
    // crossed, a lower bound on the frame's size rather than its true size. Saying "of N bytes" here
    // would claim a measurement this check never makes.
    const bytes = utf8ByteLength(raw, this.maxFrameBytes);
    if (bytes > this.maxFrameBytes) {
      this.lastErrorValue = new Error(
        `Inbound frame exceeded the ${this.maxFrameBytes}-byte cap at byte ${bytes}.`,
      );
      // Not a manual close: `1009` ("message too big") is a peer fault, so
      // `analyzeClose` must be free to classify it as reconnect-worthy rather than as a local stop.
      this.manualClose = false;
      try {
        this.socket?.close(1009, 'message too big');
      } catch {
        // The socket is already unusable; the close event will settle the state.
      }
      return;
    }

    this.emit('message', raw);
  }

  /**
   * Serialise a close event and dispatch it exactly once per socket generation.
   *
   * Idempotent: a second call (the open-timeout path closing a socket that then also fires `close`)
   * updates the state but does not re-notify subscribers, so the owning client can never see two close
   * events for one socket and schedule two reconnects.
   */
  private handleClose(event: SocketCloseEventLike): TransportCloseInfo {
    const info: TransportCloseInfo = {
      // `1006` is the spec's "closed abnormally, no close frame"; both implementations report it for
      // an abrupt drop, and `analyzeClose` treats it as reconnect-worthy rather than a normal stop.
      code: typeof event.code === 'number' ? event.code : 1006,
      reason: typeof event.reason === 'string' ? event.reason : '',
      wasClean: event.wasClean === true,
      wasManual: this.manualClose,
    };

    const alreadyDispatched = this.closeDispatched;
    this.closeDispatched = true;
    this.clearOpenTimer();
    this.currentState = 'closed';
    this.detachSocket();

    if (!alreadyDispatched) this.emit('close', info);

    return info;
  }

  private detachSocket(): void {
    const socket = this.socket;
    const bindings = this.bindings;
    this.socket = null;
    this.bindings = null;
    if (socket === null || bindings === null) return;
    try {
      socket.removeEventListener('open', bindings.onOpen);
      socket.removeEventListener('message', bindings.onMessage);
      socket.removeEventListener('close', bindings.onClose);
      socket.removeEventListener('error', bindings.onError);
    } catch {
      // Some adapters do not implement removeEventListener fully; the generation guard already makes
      // a stale event harmless, so this is cleanup only.
    }
  }

  private clearOpenTimer(): void {
    if (this.openTimer !== null) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
  }
}
