/**
 * The raw-socket fallback path.
 *
 * ## When this runs
 *
 * `attach/detect.ts` prefers `MagicCircle_RoomConnection` (§4) and falls back here when that object is
 * absent or has lost the pieces the transport needs. The recon is explicit that the fallback must exist:
 * "Treat every field here as present-but-possibly-renamed, feature-detect before relying on any one of them,
 * and keep a raw-socket fallback path (the previous two sections) for whichever piece your current target
 * build doesn't expose."
 *
 * This path is strictly worse and the reasons are worth stating, because they explain every awkward thing
 * about it:
 *
 *   - We see **strings**, not parsed messages, so every inbound frame has to be tested and parsed here.
 *   - We have **no Welcome subscription of the game's own**, so a reconnect is invisible: a new socket object
 *     appears and the old subscriptions die with the old one. Everything has to be re-attached per socket.
 *     What this path *does* offer is a replay: the last scraped `Welcome` is kept and handed to a handler
 *     that subscribes after it arrived (Phase 7 Task 7.3), which is the same contract the room path's
 *     `subscribeToWelcome` provides from a stand-in. A reconnect still delivers a fresh event when the new
 *     socket scrapes one, and the replay covers the window in between.
 *   - We must **identify the right socket**. The page opens several (assets, telemetry, the room), and the
 *     companion mod's notes record the bug when it got this wrong: "noting them all let a later one -
 *     anything at all - take the place of the game connection and quietly carry our commands nowhere."
 *
 * ## Why the constructor is replaced rather than `WebSocket.prototype.send` patched
 *
 * Patching the prototype would intercept sends but give us no way to *find* the live instance, and the
 * transport needs an instance to send on. Replacing the constructor captures the instance at the moment it is
 * created, which, as the companion's comment puts it, is "the one place that cannot miss the first frame".
 *
 * The replacement preserves the prototype chain and the static surface (`CONNECTING`/`OPEN`/`CLOSING`/`CLOSED`)
 * so that the game's own `socket instanceof WebSocket` checks and `WebSocket.OPEN` comparisons keep working.
 * Getting that wrong produces an immediate, total breakage rather than a subtle one, which is at least honest.
 *
 * ## The URL filter
 *
 * `/api/rooms/` is the room socket. It is a *documented-by-observation* string (the recon records the
 * companion's own filter), not a protocol fact, so it is an option with that default rather than a constant.
 *
 * ## Scraping
 *
 * Without `lastDistributedRoomPublication` there is no synchronous frontier read, so the frontier has to come
 * out of inbound frames. Doing that naively means `JSON.parse`-ing every frame, which the recon records as
 * the mistake that made a previous implementation janky: "Scanning the big frames for substrings they cannot
 * contain is what turned this hook into a per-frame cost heavy enough to be felt as jank." So the scraper
 * gates on `data.length` first (O(1)), then on a substring (O(n) but allocation-free), and only then parses.
 */

import { asSequence, MAX_FRAME_BYTES, utf8ByteLength } from '@mg.js/common';

import { brandWrapper, classifySlot, installHook, restoreSlot } from '../coexistence/brand.js';
import type { PageRealm } from '../page/realm.js';
import { getPage } from '../page/realm.js';
import type { AttachedSink, WelcomeEvent } from './room-connection.js';

/** The page global replaced to capture sockets. */
export const WEBSOCKET_KEY = 'WebSocket';

/** The default room-URL filter. See the module header for why it is configurable. */
export const DEFAULT_ROOM_URL_FILTER = '/api/rooms/';

/**
 * Frames shorter than this cannot be a `Welcome` (which carries a full state snapshot) or a `RoomFrame`
 * with patches. The check is a micro-optimisation with a real effect at frame rate, because it avoids the
 * substring scan below.
 */
const MIN_INTERESTING_FRAME_LENGTH = 24;

/** The substring that identifies a `Welcome` without parsing. */
const WELCOME_MARKER = '"selfPlayerId"';

/** The substring that identifies a gap-free frontier read without parsing. */
const FRONTIER_MARKER = '"executedCommandSequence"';

/** A `WebSocket`-shaped instance, as far as this module uses it. */
export interface SocketLike {
  send: (data: unknown) => void;
  close?: (code?: number, reason?: string) => void;
  addEventListener?: (type: string, listener: (event: unknown) => void, options?: unknown) => void;
  removeEventListener?: (type: string, listener: (event: unknown) => void) => void;
  readyState?: number;
  url?: string;
  [key: string]: unknown;
}

/** The `WebSocket` constructor surface we must preserve. */
export interface WebSocketLike {
  new (url: string, protocols?: unknown): SocketLike;
  prototype?: unknown;
  CONNECTING?: number;
  OPEN?: number;
  CLOSING?: number;
  CLOSED?: number;
  [key: string]: unknown;
}

/** The scrape result from one inbound frame. */
export interface ScrapeResult {
  selfPlayerId: string | null;
  executedCommandSequence: number | null;
  /** True when the frame looked like a `Welcome`. */
  wasWelcome: boolean;
}

/**
 * The socket registrar.
 *
 * Holds the discovered instances and the listeners the transport subscribes through. One registrar per page
 * (enforced through the brand marker on the replaced constructor), so two loads of this bundle share one
 * captured instance rather than each holding a different one.
 */
export interface RawSocketBinding {
  readonly kind: 'raw-socket';
  /** The most recent room socket, or `null` before one is opened. */
  socket(): SocketLike | null;
  /** Whether a usable room socket is currently open. */
  isOpen(): boolean;
  /** The frontier scraped from inbound frames, or `null`. */
  readFrontier(): number | null;
  /** The self player id scraped from `Welcome`, or `null`. */
  readSelfPlayerId(): string | null;
  /** The sink `attach/attached-transport.ts` consumes. */
  sink(): AttachedSink;
  /** Restore `window.WebSocket` (identity-guarded) and drop every listener. */
  release(): void;
  /** Whether our replacement is still installed. */
  readonly active: boolean;
  /** How many sockets have passed through the replacement. Diagnostics. */
  readonly socketCount: number;
}

/** Options for {@link bindRawSocket}. */
export interface BindRawSocketOptions {
  /** Page realm. Defaults to `realm.getPage()`. Exported for tests. */
  page?: PageRealm | null;
  /** Override the room-URL filter. */
  urlFilter?: string;
  /** Notified when a foreign replacement of `WebSocket` is found. Diagnostic. */
  onForeignHook?: () => void;
}

/** Scrape the identity and frontier out of one inbound frame. Pure and exported for tests. */
export function scrapeFrame(data: unknown): ScrapeResult {
  const empty: ScrapeResult = { selfPlayerId: null, executedCommandSequence: null, wasWelcome: false };
  if (typeof data !== 'string') return empty;
  // O(1) gate first: most frames are small patch batches.
  if (data.length < MIN_INTERESTING_FRAME_LENGTH) return empty;
  const maybeWelcome = data.includes(WELCOME_MARKER);
  const maybeFrontier = data.includes(FRONTIER_MARKER);
  if (!maybeWelcome && !maybeFrontier) return empty;

  // The shared ceiling, applied *here* as well as in the core. This path sees the frame before the core
  // does, so a bound that lives only in the core would still leave this `JSON.parse` (and the whole frame
  // it hands back) reachable with an over-cap frame. A byte count, not `data.length`, for the same reason
  // the codec gives: `length` is UTF-16 code units and under-counts non-ASCII frames.
  if (utf8ByteLength(data, MAX_FRAME_BYTES) > MAX_FRAME_BYTES) return empty;

  // Only now is parsing worth it.
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return empty;
  }
  if (parsed === null || typeof parsed !== 'object') return empty;
  const record = parsed as Record<string, unknown>;

  const rawId = record['selfPlayerId'];
  const selfPlayerId = typeof rawId === 'string' && rawId !== '' ? rawId : null;
  // The scraped sequence goes through the one rule like every other frontier read: `null` here keeps
  // a fractional value in an untrusted frame from ever reaching a counter.
  const executedCommandSequence = asSequence(record['executedCommandSequence']);

  return {
    selfPlayerId,
    executedCommandSequence,
    wasWelcome: selfPlayerId !== null,
  };
}

/**
 * Bind to the room socket by replacing `window.WebSocket`.
 *
 * Idempotent across loads through the brand marker on the replaced constructor: a second call finds our own
 * replacement already installed, reuses the registrar it carries, and only adds listeners.
 */
export function bindRawSocket(options: BindRawSocketOptions = {}): RawSocketBinding {
  const page = options.page ?? getPage();
  const urlFilter = options.urlFilter ?? DEFAULT_ROOM_URL_FILTER;

  // Registrar state. Shared with a previous load's replacement when one exists (see below).
  const frameHandlers = new Set<(raw: string) => void>();
  const welcomeHandlers = new Set<(event: WelcomeEvent) => void>();

  let current: SocketLike | null = null;
  let frontier: number | null = null;
  let selfPlayerId: string | null = null;
  /**
   * The last scraped `Welcome`, so a subscriber that arrives after the session started still learns it.
   *
   * The room path replays a stand-in built from the current state (`room-binding.ts`); this path has the real
   * event, so it keeps the one it saw. Cleared by `release()`: a released binding has no socket and no session,
   * and replaying into it would hand a caller an event for a binding that is gone.
   */
  let lastWelcome: WelcomeEvent | null = null;
  let socketCount = 0;
  let released = false;

  let releaseCtor: (() => boolean) | null = null;

  const noteFrontier = (value: number | null): void => {
    if (value === null) return;
    if (frontier === null || value > frontier) frontier = value;
  };

  /** Read a socket's `url`, tolerating a getter that throws. */
  const socketUrl = (socket: SocketLike, args: unknown[]): string => {
    try {
      if (typeof socket.url === 'string') return socket.url;
    } catch {
      // Fall through to the constructor argument.
    }
    const first = args[0];
    return typeof first === 'string' ? first : '';
  };

  /**
   * Every listener this binding added, so `release()` can take them back.
   *
   * They used to be left in place. Clearing `frameHandlers`/`welcomeHandlers` hid that: no subscriber could
   * fire, but the game's own socket still invoked our `message` listener on every frame, which is per-frame
   * work plus a retained closure holding this whole binding for the life of the page. DESIGN §6 I2 ("take
   * nothing without restoring it") applies to a listener exactly as much as to a global.
   */
  const socketListeners: Array<{
    socket: SocketLike;
    type: string;
    listener: (event: unknown) => void;
  }> = [];

  /** Attach per-instance listeners. Idempotent per socket via an own-property flag. */
  const attach = (socket: SocketLike, args: unknown[]): void => {
    if (socket === null || typeof socket !== 'object') return;
    // A released binding must not attach to anything. `release()` restores the constructor, but a page (or the
    // game) that captured the replacement before the release can still construct through it, and without this
    // guard that path re-took listeners and re-counted sockets on a binding that is supposed to be gone.
    if (released) return;
    const record = socket as Record<string, unknown>;
    if (record['__mgjsSocketAttached'] === true) return;
    record['__mgjsSocketAttached'] = true;
    socketCount += 1;

    current = socket;

    // The room socket is the one worth remembering. Every socket the page opens passes through here, so
    // noting them all would let an unrelated one take the place of the game connection.
    if (!socketUrl(socket, args).includes(urlFilter)) return;

    if (typeof socket.addEventListener === 'function') {
      // Named rather than inline so `release()` can pass the identical reference to `removeEventListener`.
      const onMessage = (event: unknown): void => {
        const data = (event as { data?: unknown } | null)?.data;
        const scraped = scrapeFrame(data);
        if (scraped.executedCommandSequence !== null) noteFrontier(scraped.executedCommandSequence);
        if (scraped.selfPlayerId !== null) {
          selfPlayerId = scraped.selfPlayerId;
          const event_: WelcomeEvent = {
            state: null,
            executedCommandSequence: scraped.executedCommandSequence,
            publishedAtServerMs: null,
            selfPlayerId: scraped.selfPlayerId,
          };
          lastWelcome = event_;
          for (const handler of [...welcomeHandlers]) {
            try {
              handler(event_);
            } catch {
              // A consumer's failure must not break the game's own listener.
            }
          }
        }
        if (typeof data !== 'string') return;
        for (const handler of [...frameHandlers]) {
          try {
            handler(data);
          } catch {
            // As above.
          }
        }
      };

      // No `open`/`close` subscriptions are exposed: the `Transport` seam's open/close events are derived by
      // the transport itself (from `canSend()` and from a frame arriving), and a second, socket-level source
      // of the same facts would be a way for the two to disagree. Only the `current` pointer needs the close
      // event, so that is all this listener does.
      const onClose = (): void => {
        if (current === socket) current = null;
      };

      socket.addEventListener('message', onMessage);
      socket.addEventListener('close', onClose);
      socketListeners.push({ socket, type: 'message', listener: onMessage });
      socketListeners.push({ socket, type: 'close', listener: onClose });
    }

    // Hook `send` on the instance using the branded, chained, identity-guarded installer, so that a mod
    // which patched the prototype before us is still called and a mod that patches the instance after us
    // still sees our frames.
    hookInstanceSend(socket);
  };

  /**
   * Wrap an instance's `send`.
   *
   * Instance-level rather than prototype-level because that is the object we captured, and because patching
   * the prototype would also intercept the page's unrelated sockets. `brand.ts`'s `installHook` gives the
   * three-way classification for free: a slot already carrying our brand is reused, a foreign wrapper is
   * chained onto, and a clean slot is written.
   */
  const hookInstanceSend = (socket: SocketLike): void => {
    const target = socket as unknown as Record<string, unknown>;
    const existing = target['send'];
    if (typeof existing !== 'function') return;
    if (classifySlot(socket as object, 'send') === 'mine') return;
    if (classifySlot(socket as object, 'send') === 'foreign') options.onForeignHook?.();

    const original = existing as (data: unknown) => void;
    // `installHook` is used for the classification and restore; the wrapper body is where this path's
    // renumbering seam goes, so the hook is installed here rather than in `detect.ts`.
    const installed = installHook({
      target: socket as unknown as object,
      key: 'send',
      label: 'rawSocket.send',
      wrap: (previous) =>
        function interceptedSocketSend(this: unknown, data: unknown): unknown {
          // A rewrite failure must never drop the game's frame. `coexistence/renumber.ts` wraps its own hook
          // for this reason ("a duplicate sequence is dropped by the server, whereas a *missing*
          // frame desyncs the game"), but this path calls the rewriter directly, so the promise has to be
          // kept here as well: a throw would otherwise escape into the host's own `send` and the frame would
          // never leave the browser. Sending the original is the safe answer (I7).
          let result: unknown;
          try {
            result = rewriteForCoexistence(data);
          } catch {
            result = data;
          }
          if (previous !== undefined) {
            return previous.call(this, result);
          }
          return original.call(this, result);
        },
    });
    const wrapper = installed.wrapper;
    sendRestores.push(() => restoreSlot(socket as object, 'send', original, wrapper));
  };

  /**
   * The renumbering seam on this path.
   *
   * The renumbering state machine lives in `coexistence/renumber.ts` and is installed on the socket by
   * `applyRenumberingFrame` when a caller provides one. Registering it here as a mutable hook rather than
   * importing `renumber.ts` keeps this module's dependency surface to one direction (`attach` → `coexistence`)
   * and lets `detect.ts` decide whether renumbering is wanted at all.
   */
  let rewriteForCoexistence: (data: unknown) => unknown = (data) => data;
  const sendRestores: Array<() => boolean> = [];

  /** Install the coexistence rewriter. Called by `detect.ts`/`client.ts`, not by callers directly. */
  function setOutboundRewriter(rewriter: (data: unknown) => unknown): void {
    rewriteForCoexistence = rewriter;
  }

  // ---- Replace the constructor ------------------------------------------------------------------

  const WebSocketCtor = page === null ? null : (page[WEBSOCKET_KEY] as unknown);
  let installed: unknown = null;

  if (page !== null && typeof WebSocketCtor === 'function') {
    const Original = WebSocketCtor as WebSocketLike;
    if (classifySlot(page, WEBSOCKET_KEY) === 'mine') {
      // A previous load already replaced it. Reuse the existing replacement's registrar rather than stacking:
      // its `attach` already runs, so our listeners are simply added to what it feeds. There is no clean way
      // to reach into it, so the new binding observes only sockets created after this call, which is correct
      // for a reload (the game opens a fresh socket) and honest about the limitation.
      options.onForeignHook?.();
      releaseCtor = null;
    } else {
      if (classifySlot(page, WEBSOCKET_KEY) === 'foreign') options.onForeignHook?.();

      const Replacement = function MgjsWebSocket(this: unknown, ...args: unknown[]): SocketLike {
        // `Reflect.construct` so the original's prototype and `new.target` semantics are preserved. The
        // original is typed as a plain constructor rather than cast to `Function`: that is what the variadic
        // overload of `Reflect.construct` accepts anyway, and it says what we mean: the arguments are a
        // spread of `unknown[]`, which no DOM constructor's own signature can express.
        const Constructible = Original as unknown as new (...args: unknown[]) => unknown;
        const socket = Reflect.construct(Constructible, args) as SocketLike;
        try {
          attach(socket, args);
        } catch {
          // Capturing must never break the game's own socket construction.
        }
        return socket;
      } as unknown as WebSocketLike;

      // The prototype chain and the static constants, both required for the game's own checks to keep
      // working. `Object.setPrototypeOf` on the function makes `Replacement.CONNECTING` resolve through the
      // original; assigning `.prototype` makes `socket instanceof WebSocket` true.
      try {
        Object.setPrototypeOf(Replacement, Original);
        if (Original.prototype !== undefined) Replacement.prototype = Original.prototype;
      } catch {
        // A frozen original. The construction still works; only the static lookups degrade.
      }

      const branded = brandWrapper(Replacement as unknown as (...a: never[]) => unknown, 'WebSocket');
      page[WEBSOCKET_KEY] = branded;
      installed = branded;
      releaseCtor = () => restoreSlot(page, WEBSOCKET_KEY, Original, branded);
    }
  }

  const sink: AttachedSink = {
    kind: 'raw-socket',

    canSend: () => {
      const socket = current;
      if (socket === null) return false;
      // `WebSocket.OPEN === 1`. Read off the original constructor through the replacement's prototype chain
      // when available, so a build with a non-standard constant still works.
      const open = resolveOpenConstant(WebSocketCtor);
      try {
        return socket.readyState === open;
      } catch {
        return false;
      }
    },

    sendRaw(raw: string): boolean {
      const socket = current;
      if (socket === null || typeof socket.send !== 'function') return false;
      try {
        socket.send(raw);
        return true;
      } catch {
        return false;
      }
    },

    onFrame: (handler) => {
      frameHandlers.add(handler);
      return () => {
        frameHandlers.delete(handler);
      };
    },

    onWelcome: (handler) => {
      welcomeHandlers.add(handler);
      // A late subscriber still learns the session: the game's socket exists before a mod usually attaches, so
      // a handler registered after the `Welcome` was scraped would otherwise wait for a session that has
      // already started. The replay is synchronous by design: the room path's `subscribeToWelcome` replays
      // the same way, so a caller can write `if (ready) ...` on the line after subscribing under either
      // attachment path.
      const replayed = lastWelcome;
      if (replayed !== null) {
        try {
          handler(replayed);
        } catch {
          // A subscriber's failure is its own, exactly as in the dispatch loop above.
        }
      }
      return () => {
        welcomeHandlers.delete(handler);
      };
    },

    readFrontier: () => frontier,

    detach(): void {
      // Nothing sink-local; the binding owns the hooks. See the same note on the room-connection sink.
    },
  };

  const binding: RawSocketBinding = {
    kind: 'raw-socket',
    socket: () => current,
    isOpen: () => sink.canSend(),
    readFrontier: () => frontier,
    readSelfPlayerId: () => selfPlayerId,
    sink: () => sink,
    get active(): boolean {
      if (page === null) return false;
      return installed !== null && page[WEBSOCKET_KEY] === installed;
    },
    get socketCount(): number {
      return socketCount;
    },
    release(): void {
      if (released) return;
      released = true;
      // Reverse order and identity-guarded, so a mod that wrapped our instance `send` keeps its hook.
      for (const restore of sendRestores.splice(0).reverse()) {
        try {
          restore();
        } catch {
          // Teardown must complete.
        }
      }
      // The listeners this binding took, given back. The guard in `attach` (which checks `released`) covers the
      // case where a socket is constructed through the replacement after this point.
      for (const { socket, type, listener } of socketListeners.splice(0)) {
        try {
          socket.removeEventListener?.(type, listener);
        } catch {
          // As above.
        }
      }
      try {
        releaseCtor?.();
      } catch {
        // As above.
      }
      releaseCtor = null;
      frameHandlers.clear();
      welcomeHandlers.clear();
      lastWelcome = null;
      // By design, `current` is left alone and the socket is NOT closed. Closing the host game's socket is
      // the one thing an attached transport must never do.
    },
  };

  // Expose the rewriter seam on the binding without widening the public interface: `detect.ts` owns the
  // policy, this module owns the mechanism.
  (binding as RawSocketBinding & { setOutboundRewriter?: typeof setOutboundRewriter }).setOutboundRewriter =
    setOutboundRewriter;

  return binding;
}

/**
 * Install a renumbering rewriter on a raw-socket binding.
 *
 * A separate function rather than part of `bindRawSocket`'s options so that `attach/detect.ts` can decide,
 * after measuring the environment, whether coexistence rewriting is wanted, and so that `raw-socket.ts` does
 * not have to import `coexistence/renumber.ts` and its state machine into the fallback path's module graph.
 */
export function installOutboundRewriter(
  binding: RawSocketBinding,
  rewriter: (data: unknown) => unknown,
): boolean {
  const target = binding as RawSocketBinding & {
    setOutboundRewriter?: (r: (data: unknown) => unknown) => void;
  };
  if (typeof target.setOutboundRewriter !== 'function') return false;
  target.setOutboundRewriter(rewriter);
  return true;
}

/** Resolve the `OPEN` readyState constant, defaulting to the WebSocket standard's `1`. */
export function resolveOpenConstant(ctor: unknown): number {
  if (ctor !== null && typeof ctor === 'function') {
    const open = (ctor as WebSocketLike).OPEN;
    if (typeof open === 'number' && Number.isFinite(open)) return open;
  }
  return 1;
}
