/**
 * Attachment detection: room connection first, raw socket second, and a report either way.
 *
 * ## Why a report rather than a silent choice
 *
 * Which path won is the single most useful fact about a bootstrapped session. The two paths have different
 * failure modes. The room path loses reconnects invisibly if the game swaps the object, and the raw-socket
 * path loses them too because a new socket is a new instance with new listeners. A bug report that says
 * "commands stopped after a while" is diagnosable in seconds with "attachment: raw-socket, 3 sockets seen" and
 * unanswerable without it.
 *
 * §4's gap note is equally direct: the docs give "no version map, no detection recipe beyond `?? null`, and no
 * fallback ordering. It also does not say whether the object is available before the first `Welcome` or only
 * after." So the ordering is ours, it is documented here, and it is reported rather than assumed.
 *
 * ## The order, and why
 *
 *   1. **`MagicCircle_RoomConnection`**, when it exposes both a send path and an observation path. Four
 *      documented advantages (§4), all of which are work this code does not have to do.
 *   2. **Raw socket**, when the object is absent or unusable. Everything the room path gave us for free has to
 *      be rebuilt, so it is second.
 *   3. **Nothing.** `'none'` is a real answer: the transport then holds an empty sink and reports
 *      `state: 'idle'`, which is much better than a transport that pretends to be connected.
 *
 * ## Why detection is re-run rather than cached
 *
 * The room object may not exist at `document-start` (we start there on purpose). The recon's gap note
 * says the docs never state when it appears. Detection is therefore a *function of the current page*,
 * cheap enough to re-evaluate (a handful of `typeof` checks), and re-evaluated on demand. A cache would
 * pin us to whichever answer was true before the game had finished starting.
 */

import { pollUntil, watchUntil } from '@mg.js/common';
import type { PageRealm } from '../page/realm.js';
import { getPage } from '../page/realm.js';
import type { RawSocketBinding } from './raw-socket.js';
import { bindRawSocket, DEFAULT_ROOM_URL_FILTER, installOutboundRewriter } from './raw-socket.js';
import type { AttachedSink, RoomConnectionBinding } from './room-connection.js';
import {
  bindRoomConnection,
  describeRoomConnection,
  isRoomConnectionUsable,
  readRoomConnection,
} from './room-connection.js';

/** Which attachment path is in play. */
export type AttachmentKind = 'room-connection' | 'raw-socket' | 'none';

/** What was found, in the order the decision was made. */
export interface AttachmentReport {
  kind: AttachmentKind;
  /** Per-field presence for `MagicCircle_RoomConnection`, or `{ present: false }`. */
  roomConnection: Record<string, boolean>;
  /** Why the room path was rejected, when it was. */
  roomConnectionRejected: string | null;
  /** Sockets observed passing through the `WebSocket` replacement, when that path is active. */
  socketsSeen: number;
  /** The URL filter used to identify the room socket. */
  urlFilter: string;
  /** The page realm was available. */
  hasPage: boolean;
  /** The renumbering rewriter was installed on the outbound path. */
  renumberingInstalled: boolean;
}

/** A live attachment. */
export interface Attachment {
  readonly kind: AttachmentKind;
  readonly sink: AttachedSink;
  readonly report: AttachmentReport;
  /** The room-connection binding, when that path won. */
  readonly room: RoomConnectionBinding | null;
  /** The raw-socket binding, when that path won. */
  readonly socket: RawSocketBinding | null;
  /**
   * Install the coexistence renumberer's outbound rewriter.
   *
   * Passed in rather than imported so this module does not depend on `coexistence/renumber.ts`: the rewriter
   * is a policy, and `client.ts` is where policy belongs.
   */
  setOutboundRewriter(rewriter: ((data: unknown) => unknown) | null): boolean;
  /** Tear down whichever binding won. Never closes a socket. */
  release(): void;
}

/** Options for {@link detectAttachment}. */
export interface DetectAttachmentOptions {
  /** Page realm. Defaults to `realm.getPage()`. Exported for tests. */
  page?: PageRealm | null;
  /** Override the room-socket URL filter for the fallback path. */
  urlFilter?: string;
  /** Force a path, skipping detection. Used by tests and by a caller that knows its build. */
  force?: AttachmentKind;
  /** Notified when a foreign hook was found in a slot we wanted. Diagnostic. */
  onForeignHook?: (slot: string) => void;
  /**
   * Resolve `selfPlayerId` from outside the attach layer.
   *
   * Passed through to the room binding, which needs it because the id is not in the state tree: the room
   * object publishes only state to its welcome subscribers. The client supplies a reader backed by the
   * socket seam's scrape of the wire.
   */
  selfPlayerIdResolver?: () => string | null;
}

/**
 * A sink that reports itself unavailable and does nothing.
 *
 * Chosen over `null` so that `AttachedTransport` needs no special case for "nothing attached", and over
 * throwing so that a page with no game connection (a test page, a mod loaded on the wrong URL) still
 * constructs cleanly.
 */
export function createEmptySink(): AttachedSink {
  return {
    kind: 'none',
    canSend: () => false,
    sendRaw: () => false,
    onFrame: () => () => {
      // No frames will ever arrive.
    },
    onWelcome: () => () => {
      // No welcome will ever arrive.
    },
    readFrontier: () => null,
    detach: () => {
      // Nothing attached.
    },
  };
}

/**
 * Choose and bind an attachment path.
 *
 * Re-runnable: each call produces a fresh binding, and calling it twice without releasing leaks a hook, so
 * `client.ts` holds exactly one and refuses a second `install()`.
 */
export function detectAttachment(options: DetectAttachmentOptions = {}): Attachment {
  const page = options.page ?? getPage();
  const urlFilter = options.urlFilter ?? DEFAULT_ROOM_URL_FILTER;
  const roomConnection = describeRoomConnection(page);
  const hasPage = page !== null;

  const roomUsable =
    options.force === undefined ? isRoomConnectionUsable(page) : options.force === 'room-connection';
  const wantRoom = options.force === 'room-connection' || (options.force === undefined && roomUsable);

  if (wantRoom && hasPage) {
    const room = bindRoomConnection({
      page,
      ...(options.selfPlayerIdResolver !== undefined
        ? { selfPlayerIdResolver: options.selfPlayerIdResolver }
        : {}),
      ...(options.onForeignHook !== undefined
        ? { onForeignHook: (method: string) => options.onForeignHook?.(`room.${method}`) }
        : {}),
    });
    return {
      kind: 'room-connection',
      room,
      socket: null,
      sink: room.sink(),
      report: {
        kind: 'room-connection',
        roomConnection,
        roomConnectionRejected: null,
        socketsSeen: 0,
        urlFilter,
        hasPage,
        renumberingInstalled: false,
      },
      setOutboundRewriter(rewriter) {
        if (rewriter === null) {
          room.setOutboundRewriter(null);
          return true;
        }
        // The room path hands the game a parsed object, so the rewriter works on objects directly, with no
        // serialise/re-parse round trip, the whole benefit of this path.
        room.setOutboundRewriter(rewriter);
        return true;
      },
      release() {
        room.release();
      },
    };
  }

  const rejected =
    options.force === 'raw-socket'
      ? null
      : roomConnection['present'] === true
        ? 'the object is present but exposes neither a usable send path nor an observation path'
        : 'the page does not expose MagicCircle_RoomConnection';

  if ((options.force === 'raw-socket' || options.force === undefined) && hasPage) {
    const socket = bindRawSocket({
      page,
      urlFilter,
      ...(options.onForeignHook !== undefined
        ? { onForeignHook: () => options.onForeignHook?.('WebSocket') }
        : {}),
    });
    const report: AttachmentReport = {
      kind: 'raw-socket',
      roomConnection,
      roomConnectionRejected: rejected,
      socketsSeen: socket.socketCount,
      urlFilter,
      hasPage,
      renumberingInstalled: false,
    };
    return {
      kind: 'raw-socket',
      room: null,
      socket,
      sink: socket.sink(),
      report,
      setOutboundRewriter(rewriter) {
        if (rewriter === null) return false;
        return installOutboundRewriter(socket, rewriter);
      },
      release() {
        socket.release();
      },
    };
  }

  return {
    kind: 'none',
    room: null,
    socket: null,
    sink: createEmptySink(),
    report: {
      kind: 'none',
      roomConnection,
      roomConnectionRejected: rejected ?? 'detection was forced to nothing',
      socketsSeen: 0,
      urlFilter,
      hasPage,
      renumberingInstalled: false,
    },
    setOutboundRewriter() {
      return false;
    },
    release() {
      // Nothing was bound.
    },
  };
}

/**
 * Poll until an attachment becomes possible.
 *
 * Needed because of `@run-at document-start`: we start before the game has created anything, so
 * at that moment the answer is legitimately `'none'` and will become `'room-connection'` a few hundred
 * milliseconds later. Without this, a document-start userscript would attach to nothing and stay that way.
 *
 * The poll is bounded and cheap (`isRoomConnectionUsable` is a handful of `typeof` checks), and it stops as
 * soon as it succeeds.
 *
 * ## What this function does *not* do
 *
 * It answers "what can I use now", and returns the first thing that works, including the raw-socket fallback,
 * which is available at `document-start`. It does **not** wait for the room object, because that object is
 * created lazily and takes seconds to appear (see {@link watchForRoomConnection} for the evidence); waiting
 * would leave the mod dead for those seconds and `transport.state` at `'idle'`.
 *
 * The consequence is that on a page where the object has not been built yet, this returns `'raw-socket'` and
 * *does not reconsider*. Promoting to the documented path later is `watchForRoomConnection`'s job, and the
 * client starts it immediately after this returns.
 */
export async function waitForAttachment(
  options: DetectAttachmentOptions & {
    timeoutMs?: number;
    intervalMs?: number;
    /** Timer injection for tests. */
    schedule?: (callback: () => void, delayMs: number) => unknown;
  } = {},
): Promise<Attachment> {
  const immediate = detectAttachment(options);
  if (immediate.kind !== 'none' || options.force !== undefined) return immediate;
  immediate.release();

  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 250;
  const schedule =
    options.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const page = options.page ?? getPage();

  return await pollUntil<Attachment>({
    attempt: () => {
      const candidate = detectAttachment({ ...options, page });
      if (candidate.kind !== 'none') return candidate;
      candidate.release();
      return null;
    },
    // Deferred: `detectAttachment` was already tried immediately above (`:278-280`), so a synchronous
    // first retry would repeat the same failing probe in the same frame.
    firstAttempt: 'afterInterval',
    timeoutMs,
    intervalMs,
    schedule,
    // Hand back the empty attachment rather than rejecting: a mod loaded on a page that will never have
    // the object should still start, and its `transport.state` will say `'idle'` honestly.
    onTimeout: () => detectAttachment({ ...options, page }),
  });
}

/** Options for {@link watchForRoomConnection}. */
export interface WatchForRoomConnectionOptions {
  /** Page realm. Defaults to `realm.getPage()`. */
  page?: PageRealm | null;
  /** Override the room-socket URL filter, for the fallback attempt each tick. */
  urlFilter?: string;
  /**
   * How long to keep looking, in ms. Default `90_000`.
   *
   * The default is not arbitrary. `MagicCircle_RoomConnection` is created *lazily* by the game, in the
   * body of `static getInstance()`, where it assigns to `window.MagicCircle_RoomConnection`.
   * The first `getInstance()` call comes from the room subsystems the game constructs after it joins
   * (the avatar manager, chat, and the shop announcers all take it as a field initializer or a default
   * parameter). So the object appears seconds after `document-start`, not at it. The companion mod polls for
   * it 180 times at 500 ms intervals, which is where 90 s comes from.
   */
  timeoutMs?: number;
  /** Poll interval, in ms. Default `500`. */
  intervalMs?: number;
  /** Timer injection for tests. */
  schedule?: (callback: () => void, delayMs: number) => unknown;
  /** Called once, when the window closes with the object still absent. */
  onTimeout?: () => void;
  /** Timer cancellation injection for tests. */
  cancelSchedule?: (handle: unknown) => void;
}

/**
 * Watch for `MagicCircle_RoomConnection` to appear, and hand back a binding when it does.
 *
 * ## Why this exists separately from {@link waitForAttachment}
 *
 * `waitForAttachment` resolves on the first candidate whose `kind` is not `'none'`, and the raw-socket path
 * binds successfully at `document-start` because it only needs `page.WebSocket`. Since the room object is
 * created *seconds later*, the first attempt always wins with the fallback and the preferred path is never
 * probed again, so the room path is rejected for the life of the page. That was a real, user-visible bug: the
 * status badge read "the page does not expose MagicCircle_RoomConnection" on a page that had been running the
 * game for minutes.
 *
 * So the two needs are split. {@link waitForAttachment} answers "what can I use *now*" and stays fast;
 * this function answers "has the better path shown up *yet*" and is meant to be started afterwards, so a mod
 * works from the first frame and still ends up on the documented path once the game builds it.
 *
 * ## Why it re-runs `detectAttachment` instead of forcing the room path
 *
 * `detectAttachment({ force: 'room-connection' })` returns a binding *unconditionally*, even when the object
 * is absent, which would upgrade to a sink that can never do anything. Polling for presence with
 * {@link hasRoomConnection} and then running detection with its normal preference order means the upgrade
 * only happens when there is a usable object, and the fallback ordering stays in one place.
 *
 * @returns a cancellation function. Calling it stops the poll and suppresses a pending callback.
 */
export function watchForRoomConnection(
  onFound: (attachment: Attachment) => void,
  options: WatchForRoomConnectionOptions = {},
): () => void {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const intervalMs = options.intervalMs ?? 500;
  const schedule =
    options.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const cancelSchedule =
    options.cancelSchedule ??
    ((handle: unknown) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });

  return watchUntil<Attachment>({
    attempt: () => {
      const page = options.page ?? getPage();

      if (hasRoomConnection(page)) {
        const candidate = detectAttachment({
          ...(options.page !== undefined ? { page: options.page } : {}),
          ...(options.urlFilter !== undefined ? { urlFilter: options.urlFilter } : {}),
        });
        if (candidate.kind === 'room-connection') return candidate;
        // Present but unusable (no send path, or no observation path). Release the fallback we just built
        // and keep looking: a build that exposes a partial object often finishes wiring it a frame or two
        // later.
        candidate.release();
      }
      return null;
    },
    // The room object is created lazily, seconds after `document-start`, so the first probe waits one
    // interval rather than binding hooks in the very frame the mod started.
    firstAttempt: 'afterInterval',
    timeoutMs,
    intervalMs,
    schedule,
    cancelSchedule,
    onFound,
    // The window closing is this caller's meaning: it reports "the object never appeared" once.
    onTimeout: () => {
      options.onTimeout?.();
    },
  });
}

/**
 * Whether the page currently exposes the room connection object at all.
 *
 * Exposed separately from {@link detectAttachment} because a caller that only wants to decide whether to wait
 * should not have to bind hooks to find out.
 */
export function hasRoomConnection(page: PageRealm | null = getPage()): boolean {
  return readRoomConnection(page) !== null;
}
