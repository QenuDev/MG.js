/**
 * `RoomSocket`: the documented standalone entry point.
 *
 * The API reference describes this class specifically as the layer "to implement directly if you are not
 * running inside the game's own page (e.g. a standalone or native client). See `RoomConnection` for the
 * friendlier, page-only alternative."
 *
 * That is the split this monorepo already has:
 *
 *   - `@mg.js/bootstrapped` is the `RoomConnection` side: it attaches to a socket the host game owns.
 *   - **this class is the `RoomSocket` side**: it owns its own WebSocket.
 *
 * It is a **facade, not a second implementation**. Every behaviour delegates to `HeadlessClient`, which
 * already composes the standalone transport, auth providers, version discovery, reconnect policy and the
 * shared `ClientCore`. The value of the facade is *doc fidelity*: a caller who read the API reference
 * finds the class name, properties, methods and four events it promises. Nothing is duplicated, so
 * nothing can drift.
 *
 * ## The documented divergences, all intentional
 *
 *   - **`start()` is async.** The reference types the verb as synchronously returning the `wss://` URL, but
 *     a real standalone client may have to resolve the game version first, which is the documented cure
 *     for the `4710`/`4700` loop and cannot be expressed synchronously. It still resolves to the connect
 *     URL, so the contract holds.
 *   - **`stop()` is async**, because closing a socket and releasing its listeners is not instantaneous and
 *     the reference's `void` would hide that.
 *   - **The verbs are `start`/`stop`, not `connect`/`disconnect`/`destroy`.** `docs/DESIGN.md` §3.2 wants
 *     one verb pair across the four client-shaped classes so a caller can be written against two of them;
 *     `destroy()` and `disconnect()` were the same fact at two strengths and are now one total `stop()`.
 *   - **`send()` takes `object | string`.** The reference's `send(payload: object)` is preserved; the
 *     string case is added so the bare-string keepalive is expressible, which the reference's own handler
 *     code explicitly deals with.
 *   - **The client is constructed on the first `start()`**, not in the constructor, because the
 *     reference puts room/version/credentials on the connect call while `HeadlessClient` takes them at
 *     construction. Constructing lazily is the only way to honour the documented signature without
 *     keeping two parallel option objects.
 *
 * The reference's `RoomSocketEvents` typedef names four events: `welcome`, `partialState`,
 * `commandResult`, `close`. All four have `on*` subscriptions below. The `on(event, handler)` escape
 * hatch also exposes the core's `open`, `ready`, `state`, `droppedStale`, `unparsed` and
 * `unknownMessage` events, which that typedef omits entirely, plus the client's own `reconnect`,
 * `stopped` and `confirmationRequired`. The facade inherits the reconnect policy, so it has to be able
 * to report it.
 */

import type {
  ClientEvents,
  CommandSequencer,
  ConnectOptions as CommonConnectOptions,
  Emitter,
  QuinoaCommandResultMessage,
  TransportCloseInfo,
  Unsubscribe,
  WelcomeMessage,
} from '@mg.js/common';
import { buildConnectUrl, MgConfigError } from '@mg.js/common';
import type { HeadlessClientEvents, HeadlessClientOptions, HeadlessReport } from './client.js';
import { HeadlessClient } from './client.js';

/**
 * Everything {@link RoomSocket.report} publishes: the underlying client's report, plus this facade's own
 * diagnostic: the queue depth, which the client knows nothing about.
 */
export interface RoomSocketReport extends HeadlessReport {
  /** How many pre-start subscriptions are still queued for the next `start()`. */
  queuedSubscriptionCount: number;
}

/**
 * The events only a `ClientCore` can emit, in one place.
 *
 * `on()` spans both event maps, so it has to know which surface emits a name at runtime. `open`, `ready`
 * and `close` exist on both and are **not** listed here: a core is replaced by every
 * reconnect attempt, so a subscription bound to the current core stops reaching a caller the moment the
 * socket reconnects. `HeadlessClient` re-emits all three from its own stable emitter, so
 * they survive a reconnect (Phase 2.7 Part A). The remaining names have no stable counterpart, because
 * they really are per-core by nature.
 */
const CORE_EVENT_NAMES: ReadonlySet<string> = new Set([
  'welcome',
  'partialState',
  'state',
  'commandResult',
  'droppedStale',
  'unparsed',
  'oversizedFrame',
  'unknownMessage',
]);

/**
 * The two event maps folded into one, with a union payload where a name exists on both.
 *
 * `ClientEvents & HeadlessClientEvents` would intersect them instead, which turns `close` into
 * `TransportCloseInfo & HeadlessCloseEvent`, a value that can never exist. The union is what the
 * runtime actually delivers: `close` is `TransportCloseInfo` from a core route and the annotated
 * `HeadlessCloseEvent` from the client.
 * @internal
 */
export type RoomSocketEventSurface = {
  [TKey in keyof ClientEvents | keyof HeadlessClientEvents]: TKey extends keyof ClientEvents
    ? TKey extends keyof HeadlessClientEvents
      ? ClientEvents[TKey] | HeadlessClientEvents[TKey]
      : ClientEvents[TKey]
    : TKey extends keyof HeadlessClientEvents
      ? HeadlessClientEvents[TKey]
      : never;
};

/**
 * Options for {@link RoomSocket.start}.
 *
 * Mirrors the reference's `ConnectOptions` typedef. The reference also carries a `cookie` field for the
 * `mc_jwt` credential; that is expressed as an `AuthProvider` on the constructor instead, because a
 * cookie is only one of the two documented authentication paths, and the other one, anonymous guest, needs
 * no credential at all.
 */
export interface RoomSocketConnectOptions {
  /** A known-good version. Omit to resolve it from the platform API. */
  version?: string | undefined;
  /** Room slug. Omit for a private room of your own, per the field guide. */
  room?: string | undefined;
  /** Overrides the instance host for this connection. */
  host?: string | undefined;
  /** Overrides the instance reconnect policy for this connection. */
  reconnect?: HeadlessClientOptions['reconnect'];
}

/**
 * Options for constructing a {@link RoomSocket}.
 *
 * Aliased to {@link HeadlessClientOptions} rather than re-declared, so a new option on the client is
 * immediately available here and cannot be forgotten.
 */
export type RoomSocketOptions = HeadlessClientOptions;

/**
 * Owns the room connection's raw WebSocket.
 *
 * ```ts
 * const socket = new RoomSocket({ auth: new CookieAuthProvider(process.env.MC_JWT!) });
 * socket.onWelcome((msg) => console.log('playerId:', msg.selfPlayerId));
 * const url = await socket.start({ room: 'abcde12345' });
 * await socket.waitUntilReady();
 * ```
 */
export class RoomSocket {
  private readonly options: RoomSocketOptions;
  private client: HeadlessClient | null = null;
  private lastUrl = '';
  private readonly pendingSubscriptions: ((client: HeadlessClient) => void)[] = [];

  constructor(options: RoomSocketOptions = {}) {
    this.options = options;
  }

  /**
   * Build the connect URL and open the WebSocket.
   *
   * The version is resolved first when one was not pinned: connecting with a stale build is closed with
   * `4710 VersionExpired` (or `4700 VersionMismatch`), and the documented remedy is to re-fetch the
   * current version *before* reconnecting, and doing it before the first attempt avoids the round trip.
   *
   * @returns the `wss://` URL that was opened, for logging/debugging. The reference's `connect()` promised
   *   that return value, so `start()` keeps it rather than answering `void` like the contract's own verb.
   * @throws {MgConfigError} when this socket has already been started, which is a caller mistake about
   *   this object's lifecycle, not a transport fault.
   */
  async start(options: RoomSocketConnectOptions = {}): Promise<string> {
    if (this.client !== null) {
      throw new MgConfigError(
        'RoomSocket.start() has already been called. A RoomSocket owns one connection; construct a ' +
          'new RoomSocket for a new one.',
      );
    }

    const merged: HeadlessClientOptions = { ...this.options };
    if (options.version !== undefined) merged.version = options.version;
    if (options.room !== undefined) merged.room = options.room;
    if (options.host !== undefined) merged.host = options.host;
    if (options.reconnect !== undefined) merged.reconnect = options.reconnect;

    const client = new HeadlessClient(merged);
    this.client = client;

    try {
      await client.start();
    } catch (error) {
      // A first start that fails has not produced a connection, so the guard above must keep its real
      // meaning ("already started") and a retry must be possible. Before this, `this.client` was left
      // set on failure and every later `start()` threw "already been called" although no connection had
      // ever been made (audit 05 §5). Everything the failed attempt allocated is released here, including
      // a reconnect chain it may have scheduled.
      this.client = null;
      try {
        await client.stop();
      } catch {
        // Best effort: the caller needs the original connect failure, not a teardown error.
      }
      throw error;
    }

    // Attach anything a caller wired up before starting. This MUST happen after `start()` resolves,
    // because `HeadlessClient` only creates its `ClientCore` (and therefore its event surface) during
    // start: subscribing any earlier throws.
    //
    // It is still safe for `welcome`, and that is not a race: `start()` resolves once the socket is
    // open and the handshake has been written, and is documented *not* to wait for `Welcome`. So
    // subscriptions a caller registered before `start()` are attached strictly before `Welcome`
    // arrives, which is the guarantee the reference's construct -> subscribe -> start usage
    // pattern needs.
    for (const attach of this.pendingSubscriptions.splice(0)) attach(client);

    this.lastUrl = client.url;
    return this.lastUrl;
  }

  /**
   * Tear the socket down: release the queued subscriptions, then close it with code 1000.
   *
   * The manual marker is what suppresses the automatic reconnect a server-initiated close would trigger.
   * Without it a shutdown would immediately reconnect. `HeadlessClient` classifies its own
   * close as `stop` for that reason, and its `stop()` is total, so this one is too.
   *
   * Absorbs the old `disconnect()`/`destroy()` pair: both released the queue and both delegated to a
   * client teardown, and the only difference was how much of the client survived, which is not a
   * distinction a caller could act on.
   */
  async stop(reason?: string): Promise<void> {
    // Released *before* the early return below. A socket that subscribed and never started has no
    // client to release its queued handlers from, and the detacher a caller received only sets a
    // `cancelled` flag, so without this the queue is an unbounded retention of closures with no
    // reclamation path at all (audit 05 §5).
    this.pendingSubscriptions.length = 0;
    if (this.client === null) return;
    await this.client.stop(reason);
  }

  /**
   * Send a pre-built message verbatim.
   *
   * "Prefer `GameActions`' methods over calling this directly; they handle envelope wrapping and
   * command-sequence numbering for you." This goes straight to the transport, and that is what "verbatim"
   * means: no envelope wrapping, no sequence stamping. An object is serialised; a string is passed
   * through untouched, which is how the bare `"pong"` keepalive is expressed.
   */
  send(payload: object | string): void {
    const transport = this.requireClient('send').transport;
    if (transport === null) throw new Error('RoomSocket.send() called before the socket opened.');
    transport.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  /** Resolves once `Welcome` has arrived. */
  async waitUntilReady(): Promise<void> {
    await this.requireClient('waitUntilReady').waitUntilReady();
  }

  // ------------------------------------------------------------------------------------
  // Documented properties
  // ------------------------------------------------------------------------------------

  /** The room slug currently connected (or last connected) to. */
  get room(): string {
    return this.client?.roomSlug ?? this.options.room ?? '';
  }

  /**
   * This session's player id, or `null` before the server assigns one.
   *
   * `null` rather than `''` before the first `Welcome`, because "the connect URL never carries a
   * client-chosen id": the server assigns it and reports it back on `Welcome.selfPlayerId`. An empty
   * string is a *value*, and a caller cannot tell it apart from an id that was never assigned (I6).
   */
  get selfPlayerId(): string | null {
    return this.client?.selfPlayerId ?? null;
  }

  /**
   * The reference-shaped alias for {@link selfPlayerId}: one spelling of the same resolved value.
   *
   * The API reference calls this property `playerId`, and the reference's own typedef names it, so the
   * name stays until Phase 5's rename pass. It answers the same value as `selfPlayerId`, `null`
   * included: a second name is not allowed to be a second answer.
   */
  get playerId(): string | null {
    return this.selfPlayerId;
  }

  /**
   * The command-sequence counter this socket seeds from every incoming `Welcome`.
   *
   * `null` before `start()`.
   */
  get sequencer(): CommandSequencer | null {
    return this.client?.sequencer ?? null;
  }

  /** The typed 72-method action surface the reference models separately as `GameActions`. */
  get actions(): HeadlessClient['actions'] {
    return this.requireClient('actions').actions;
  }

  /** The observable state tree: the reference's `state` package. */
  get store(): HeadlessClient['store'] {
    return this.requireClient('store').store;
  }

  /** Room state: players, chat, host. */
  get roomState(): unknown {
    return this.requireClient('roomState').room;
  }

  /** Game state: garden, inventory, shops, weather. */
  get gameState(): unknown {
    return this.requireClient('gameState').game;
  }

  /** True once `Welcome` has arrived and the sequencer is seeded. */
  get isReady(): boolean {
    return this.client?.isReady ?? false;
  }

  /** The `wss://` URL that was opened, for logging/debugging. */
  get url(): string {
    return this.client?.url ?? this.lastUrl;
  }

  /** The client this facade delegates to, for anything the documented surface does not cover. */
  get underlying(): HeadlessClient {
    return this.requireClient('underlying');
  }

  /**
   * One JSON-safe snapshot: the underlying client's report, plus this facade's own queue depth.
   *
   * Non-null and complete before `start()` too. The client does not exist yet, so every axis reports its
   * honest empty value (nothing started, no id, no errors) rather than the whole snapshot being absent.
   * A caller reading `report` should not have to branch on whether the socket was ever started.
   */
  get report(): RoomSocketReport {
    return {
      ...(this.client?.report ?? this.unstartedReport()),
      queuedSubscriptionCount: this.pendingSubscriptions.length,
    };
  }

  /**
   * The lifecycle events of the underlying client, or `null` before `start()`.
   *
   * The client's emitter rather than a second bus owned by this facade: `open`, `ready` and
   * `close` are re-emitted by `HeadlessClient` from its own stable emitter precisely so they survive a
   * reconnect, and `ClientCore` is replaced on every attempt. The generic {@link on} escape hatch spans
   * the core's per-connection events as well; this accessor is the contract-shaped view of the stable
   * ones. `null` is the honest answer before a client exists, since there is nothing to subscribe to yet,
   * and {@link on} is the pre-start route a caller should use.
   */
  get events(): Emitter<HeadlessClientEvents> | null {
    return this.client?.events ?? null;
  }

  /** The snapshot of a socket that has never been started. */
  private unstartedReport(): Omit<RoomSocketReport, 'queuedSubscriptionCount'> {
    return {
      kind: 'headless',
      started: false,
      ready: false,
      selfPlayerId: null,
      attachment: null,
      socketsSeen: 0,
      renumbering: false,
      errors: [],
      version: this.options.version ?? '',
      documentId: '',
      connectionAttempt: 0,
      reconnectAttempt: 0,
      versionFresh: null,
      url: this.lastUrl,
      willReconnect: false,
      coldStart: false,
      stopped: null,
      core: null,
    };
  }

  /**
   * How many reconnect attempts the client's policy has made for this session.
   *
   * `0` before the first `Welcome` and after every reconnect that is welcomed: `markEstablished()` is
   * the only thing that clears the policy's counter, so a server that accepts and immediately drops
   * connections cannot keep the client in a fast loop.
   */
  get reconnectAttempt(): number {
    return this.client?.reconnectAttempt ?? 0;
  }

  /**
   * True while a scheduled retry is actually in flight (running its backoff or opening its socket).
   *
   * This is the honest half of the `close` event's `willReconnect`, which reports what the policy decided
   * at close time. `false` together with {@link onStopped} having fired means "given up", not "quiet".
   */
  get willReconnect(): boolean {
    return this.client?.willReconnect ?? false;
  }

  /**
   * How many pre-start subscriptions are queued for the next `start()`.
   *
   * Exposed so the queue's release on teardown is assertable rather than a comment; `0` is the healthy
   * value for a socket that has started (the queue is drained into the client) or been torn down.
   */
  get queuedSubscriptionCount(): number {
    return this.pendingSubscriptions.length;
  }

  // ------------------------------------------------------------------------------------
  // Events: the four the reference documents
  // ------------------------------------------------------------------------------------

  /** The first message after a successful connect, and again after every reconnect. */
  onWelcome(handler: (message: WelcomeMessage) => void): Unsubscribe {
    return this.on('welcome', handler);
  }

  /** A batch of JSON-Patch operations, with `RoomFrame` normalised into the same shape. */
  onPartialState(handler: (event: ClientEvents['partialState'][0]) => void): Unsubscribe {
    return this.on('partialState', handler);
  }

  /** Acknowledges (or rejects) a previously-sent `QuinoaCommand` envelope. */
  onCommandResult(
    handler: (event: {
      result: ClientEvents['commandResult'][0]['result'];
      message: QuinoaCommandResultMessage;
    }) => void,
  ): Unsubscribe {
    return this.on('commandResult', handler);
  }

  /**
   * Any close, with the raw code and reason.
   *
   * Delivers the same {@link TransportCloseInfo} this method always has, but from the client's stable
   * `close` emitter rather than the current core's, so it keeps firing after a reconnect. A caller who
   * wants `analyzeClose`'s classification alongside the raw info can use the generic
   * `on('close', handler)`, which delivers the annotated `{ info, analysis, willReconnect }`.
   */
  onClose(handler: (info: TransportCloseInfo) => void): Unsubscribe {
    if (this.client !== null) return attachClose(this.client, handler);

    let detach: Unsubscribe | null = null;
    let cancelled = false;
    this.pendingSubscriptions.push((client) => {
      if (cancelled) return;
      detach = attachClose(client, handler);
    });
    return () => {
      cancelled = true;
      detach?.();
    };
  }

  // ------------------------------------------------------------------------------------
  // Events the facade inherits: it delegates the reconnect policy, so it must report it
  // ------------------------------------------------------------------------------------

  /** A retry was scheduled, after `plan.delayMs`. */
  onReconnect(handler: (event: HeadlessClientEvents['reconnect'][0]) => void): Unsubscribe {
    return this.on('reconnect', handler);
  }

  /** No further retries will be attempted, with the reason. */
  onStopped(handler: (event: HeadlessClientEvents['stopped'][0]) => void): Unsubscribe {
    return this.on('stopped', handler);
  }

  /** The session was superseded by another connection and needs a person's confirmation to reclaim. */
  onConfirmationRequired(
    handler: (event: HeadlessClientEvents['confirmationRequired'][0]) => void,
  ): Unsubscribe {
    return this.on('confirmationRequired', handler);
  }

  // ------------------------------------------------------------------------------------
  // The rest of the core's events, via the documented escape hatch
  // ------------------------------------------------------------------------------------

  /** The socket opened. */
  onOpen(handler: () => void): Unsubscribe {
    return this.on('open', handler);
  }

  /** The client became ready to accept gameplay commands. */
  onReady(handler: () => void): Unsubscribe {
    return this.on('ready', handler);
  }

  /** Any state change, with the pointers that moved. */
  onState(handler: (change: ClientEvents['state'][0]) => void): Unsubscribe {
    return this.on('state', handler);
  }

  /** A command the server silently overtook, the synthesized `dropped_stale` case. */
  onDroppedStale(
    handler: (event: { action: string; sequence: number; requestId: string }) => void,
  ): Unsubscribe {
    return this.on('droppedStale', handler);
  }

  /**
   * Generic subscription, for any core event **or** any event `HeadlessClient` adds on top of it.
   *
   * Accepts subscriptions before `start()`: the detacher is registered against the client once it
   * exists, so a caller can wire up handlers first and connect second, which is the natural order.
   *
   * `open`, `ready` and `close` exist on both surfaces and route to the client's stable emitters, so they
   * survive a reconnect like {@link onReconnect} does. This method delivers the annotated
   * `{ info, analysis, willReconnect }`; {@link onClose} is the convenience form that delivers the raw
   * info alone. Use {@link onReconnect}, {@link onStopped} and {@link onConfirmationRequired} for the
   * events that have no core counterpart.
   */
  on<TKey extends keyof RoomSocketEventSurface>(
    event: TKey,
    handler: (...args: RoomSocketEventSurface[TKey]) => void,
  ): Unsubscribe {
    if (this.client !== null) return attachTo(this.client, event, handler);

    let detach: Unsubscribe | null = null;
    let cancelled = false;
    this.pendingSubscriptions.push((client) => {
      if (cancelled) return;
      detach = attachTo(client, event, handler);
    });
    return () => {
      cancelled = true;
      detach?.();
    };
  }

  /**
   * The documented static `RoomSocket.buildConnectUrl(options)`.
   *
   * "Pure URL builder, split out from the connect call so it can be unit tested or reused by a client that
   * wants to open the socket itself. Every query value is JSON-encoded, quotes included."
   */
  static buildConnectUrl(options: CommonConnectOptions): string {
    return buildConnectUrl(options);
  }

  private requireClient(what: string): HeadlessClient {
    if (this.client === null) {
      throw new Error(
        `RoomSocket.${what} is not available before start(). The client is constructed on the first ` +
          'start() call so that the documented start(options) signature can be honoured.',
      );
    }
    return this.client;
  }
}

/**
 * Bind {@link RoomSocket.onClose}'s raw-info handler to the client's stable `close` emitter.
 *
 * The client emits `{ info, analysis, willReconnect }`; `onClose` has always promised the raw
 * `TransportCloseInfo`, so this is where the annotation is dropped. The subscription itself is the
 * stable one, so it stays alive across a reconnect.
 */
function attachClose(client: HeadlessClient, handler: (info: TransportCloseInfo) => void): Unsubscribe {
  return client.on('close', ({ info }) => handler(info));
}

/**
 * Attach one handler to the surface that emits the event.
 *
 * The two `HeadlessClient` subscriptions have different shapes and that is the reason this dispatch
 * exists rather than one cast: `onCore` is bound to the *current* connection's core, while `on` is stable
 * across reconnects. A caller reaching for `reconnect`/`stopped` is asking about the reconnect lifecycle,
 * so it has to land on the latter. The same now goes for `open`/`ready`/`close`: a core is replaced on
 * every attempt, so binding them to one would end their delivery at the first reconnect.
 */
function attachTo<TKey extends keyof RoomSocketEventSurface>(
  client: HeadlessClient,
  event: TKey,
  handler: (...args: RoomSocketEventSurface[TKey]) => void,
): Unsubscribe {
  if (CORE_EVENT_NAMES.has(event)) {
    return client.onCore(
      event as keyof ClientEvents,
      handler as (...args: ClientEvents[keyof ClientEvents]) => void,
    );
  }
  return client.on(
    event as keyof HeadlessClientEvents,
    handler as (...args: HeadlessClientEvents[keyof HeadlessClientEvents]) => void,
  );
}
