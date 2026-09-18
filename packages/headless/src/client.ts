/**
 * `HeadlessClient`, the standalone Magic Garden client.
 *
 * WHAT IT IS
 * ----------
 * One object that opens its own WebSocket, authenticates, handshakes, answers keepalives, reconnects
 * intelligently, and exposes the whole `@mg.js/common` action and state surface. It composes four
 * pieces rather than reimplementing any of them:
 *
 *   - {@link StandaloneTransport}: the socket (raw strings in and out, keepalives consumed).
 *   - `ClientCore` from `@mg.js/common`: envelopes, sequencing, ack correlation, state application.
 *   - An `AuthProvider`: the cookie or guest contribution to the connect URL/headers.
 *   - {@link VersionResolver} + {@link ReconnectPolicy}: the `4710` cure and the backoff.
 *
 * No coexistence logic exists here: nothing else is on this socket, so no
 * renumbering hook, no shared command counter, and no "am I the only writer?" question. The
 * bootstrapped package is where all of that lives.
 *
 * THE HANDSHAKE, AND THE ONE ORDERING QUESTION IN IT
 * -------------------------------------------------
 * Recon §1.6 gives the handshake as a diagram:
 *
 *   ```
 *   client    on open, sends:
 *             { scopePath: ["Room"], type: "VoteForGame", gameName: "Quinoa" }
 *             { scopePath: ["Room"], type: "SetSelectedGame", gameName: "Quinoa" }
 *   server    replies:   { type: "Welcome", selfPlayerId, executedCommandSequence, fullState }
 *   ```
 *
 * and §1.6 adds the constraint that makes the ordering non-obvious:
 *
 *   > "Nothing else needs to happen before `Welcome` arrives, don't send gameplay commands before it,
 *   > since the command-sequence counter isn't seeded yet and every one would be rejected as
 *   > `invalid_sequence`."
 *
 * Those two sentences are consistent only under one reading, and this class implements it:
 * **the two handshake frames are sent before `Welcome` (the diagram says so), and they must not be
 * gameplay commands (the constraint says so).** They are not: §2.1 places both in the room scope,
 * `["Room"]`, and §7 lists `VoteForGame` → `SetSelectedGame` → `RestartGame` as room-scoped. Room-scoped
 * frames are sent flat, carry no `commandSequence` (§8.1: "Only **wrapped** commands carry
 * `commandSequence`"), and therefore cannot be rejected as `invalid_sequence`.
 *
 * For that reason the handshake is built with `buildRoomFrame` (see `handshake.ts`) and written straight
 * to the transport, **not** through `ClientCore.send()`: the core's `send()` refuses to run before
 * `Welcome` by design (`MgNotReadyError`) and would make the documented handshake impossible. Routing
 * around the readiness gate is safe here *only* because these two frames are room-scoped; the moment a
 * Quinoa-scoped frame is added to the handshake it must go through `send()` after `Welcome` instead.
 * The order between the two is required too: the API reference documents `voteForGame()` as "Send on
 * open, before `setSelectedGame()`", so a test asserts the sequence.
 *
 * A `Welcome` whose `executedCommandSequence` is missing still marks the client ready: `ClientCore`
 * seeds the sequencer only when the field is a number, and refusing to become ready over a missing seed
 * would be worse than starting from 1. The server rejects a bad sequence explicitly, so it is
 * recoverable, whereas a client that never becomes ready is not.
 *
 * RECONNECT: WHAT EACH DISPOSITION ACTUALLY DOES
 * ----------------------------------------------
 * `analyzeClose()` owns the classification; this class owns the four concrete behaviours §1.8 requires:
 *
 *   - `refetch-version` (`4710`): {@link VersionResolver.refresh} is started **before** the reconnect is
 *     scheduled, because reconnecting with the version that just got us closed is the documented endless
 *     loop. The retry then calls `resolve()`, which observes the refreshed value.
 *   - `reconnect-slow` (`4250`/`4300`): the retry is scheduled on the longer superseded base delay and
 *     the next connect sets `reclaimSupersededSession=true` (literal `true`, never `false`, per §1.4) and
 *     increments `clientConnectionAttempt`.
 *   - `reconnect-bounded` (`4800`): retries are capped, so a bad cookie cannot be hammered forever.
 *   - `stop`: no reconnect. `stop()` and a normal `1000` close both land here.
 *
 * THE STORE SURVIVES A RECONNECT
 * ------------------------------
 * A fresh `ClientCore` is built per connection, because that is the only way to attach a new transport
 * (`attachTransport()` is private and its listeners are only released by `stop()`). That used to mean the
 * **`store` object identity changed on every reconnect**, so a caller who cached
 * `const store = client.store` held a detached, never-again-updated object.
 *
 * `ClientCoreOptions.store` exists for this, and `openConnection` now uses it: the previous core's store
 * is carried into the next attempt ({@link previousStore}), so the identity a caller cached keeps
 * receiving patches. `Welcome` still calls `replaceRoot` on it, so the state is rebuilt in place rather
 * than merged into a stale tree.
 */

import type {
  ClientEvents,
  CloseAnalysis,
  GameActions,
  Logger,
  LoggerOptions,
  MgError,
  ObservableStore,
  StateReader,
  TransportCloseInfo,
  Unsubscribe,
  WelcomeMessage,
} from '@mg.js/common';
import {
  ClientCore,
  CommandSequencer,
  createLogger,
  Emitter,
  MgNotReadyError,
  summarizeError,
  toMgError,
  unrefTimer,
} from '@mg.js/common';
import { GuestAuthProvider } from './auth/guest.js';
import type { AuthProvider } from './auth/types.js';
import type { HeadlessClientEvents, HeadlessReport } from './client-events.js';
import type { HeadlessClientOptions } from './client-options.js';
import { buildAttemptUrl, joinHost } from './connect-url.js';
import { MgConfigError } from './errors.js';
import type { BackoffPlan } from './reconnect.js';
import { classifyClose, ReconnectPolicy } from './reconnect.js';
import { buildConnectHeaders, DEFAULT_ORIGIN } from './transport/headers.js';
import type { WebSocketFactory } from './transport/runtime.js';
import { acquireWebSocketRuntime } from './transport/runtime.js';
import { StandaloneTransport } from './transport/standalone.js';
import type { ResolvedVersion } from './version.js';
import { VersionResolver } from './version.js';

export type { HeadlessClientEvents, HeadlessCloseEvent, HeadlessReport } from './client-events.js';
export type { HeadlessClientOptions } from './client-options.js';
export { appendAuthQuery } from './connect-url.js';

import { writeAdmission, writeHandshake } from './handshake.js';

export { HANDSHAKE_ACTIONS, HANDSHAKE_GAME_NAME } from './handshake.js';

/**
 * The standalone client.
 *
 * One instance is one *session* (one `documentId`), which may span many connections. `start()` may be
 * called again after a close, or left to the automatic reconnect.
 */
export class HeadlessClient extends Emitter<HeadlessClientEvents> {
  private readonly authProvider: AuthProvider;
  private readonly resolver: VersionResolver;
  private readonly policy: ReconnectPolicy;
  private readonly logger: Logger;
  private readonly factoryOption: WebSocketFactory | undefined;
  private readonly preferAdapter: boolean;
  private readonly originOption: string;
  private readonly userAgentOption: string | undefined;
  private readonly hostOption: string | undefined;
  private readonly roomOption: string | undefined;
  private readonly tlsOption: boolean;
  private readonly ackModeOption: 'strict' | 'fifo' | 'none' | undefined;
  private readonly requireHeadersForAuth: boolean;
  private readonly openTimeoutMs: number | undefined;
  private readonly reconnectEnabled: boolean;

  private core: ClientCore | null = null;
  private activeTransport: StandaloneTransport | null = null;
  /**
   * The store the last core populated, carried into the next attempt.
   *
   * `store` object identity is what a caller caches, so a reconnect must reuse it rather than build a
   * fresh one. It is *not* emptied when an attempt fails before a core is built: the store outlives a
   * failed retry.
   */
  private previousStore: ObservableStore | null = null;
  private coreDetachers: Unsubscribe[] = [];
  private documentId = '';
  private currentUrl = '';
  private currentRoom = '';
  private currentVersion = '';
  private connectionAttemptValue = 0;
  /** Set when the next connect should send `reclaimSupersededSession=true`. */
  private reclaimSupersededNext = false;
  /**
   * The close that was superseded and refused, held so a caller can confirm it later.
   *
   * It is the *close info* rather than a flag because the confirmation has to be classified the same way
   * as the original was, reason string included, since the heartbeat disambiguation depends on it.
   */
  private pendingSupersession: TransportCloseInfo | null = null;
  private localShutdown = false;
  private closedByTransport = false;
  private reconnectTask: Promise<void> | null = null;
  /**
   * A plan that arrived while a reconnect task was already running.
   *
   * A pre-open failure inside `openConnection` is routed through `handleSyntheticClose` → `handleClose`
   * → `afterClose` → {@link scheduleReconnect} *from inside that very task*, so the call finds
   * `reconnectTask` non-null. Dropping the plan there is what made `willReconnect: true` a lie: the task
   * then unwound and nulled itself and nothing was left to retry. Parking it lets the task's `finally`
   * start the next attempt instead.
   */
  private parkedReconnect: { plan: BackoffPlan; analysis: CloseAnalysis } | null = null;
  /**
   * Cancels the backoff a scheduled reconnect is parked in.
   *
   * This is **not** `readonly`: an aborted signal is permanent, so {@link start} installs a fresh
   * controller for a client that connects again after a shutdown. Without this, `stop()` awaited
   * the whole delay, up to `maxDelayMs` (60 s by default), before it would even start closing the socket.
   */
  private reconnectAbort = new AbortController();
  private connectTask: Promise<void> | null = null;
  private stoppedReason: string | null = null;
  /**
   * Why the version could not be re-resolved after a `4710`/`4700`, if it could not.
   *
   * `4710` is the one close whose remedy is another network call, and when that call fails there is
   * nothing left to retry *with*: the cached version is the one the server just rejected. Carrying the
   * failure lets the pending retry stop honestly instead of replaying the same close forever. Cleared by
   * a fresh {@link start} and at the top of every attempt, never set from the payload (I4: untrusted data
   * does not become a message).
   */
  private versionRefreshFailure: string | null = null;
  private versionInfo: ResolvedVersion | null = null;
  private openedAt: number | null = null;
  private lastErrorValue: unknown = null;
  /** Set when a connect was refused because the runtime cannot carry the auth headers. */
  private headersBlockedValue = false;

  constructor(options: HeadlessClientOptions = {}) {
    super();

    const loggerOptions: LoggerOptions = {
      namespace: options.namespace ?? 'mg:headless',
      level: options.logLevel ?? 'warn',
      ...(options.logSink !== undefined ? { sink: options.logSink } : {}),
    };
    this.logger = options.logger ?? createLogger(loggerOptions);

    this.authProvider = options.auth ?? new GuestAuthProvider();
    this.reconnectEnabled = options.reconnect?.enabled ?? true;
    this.policy = new ReconnectPolicy({
      config: { ...options.reconnect, enabled: this.reconnectEnabled },
    });
    this.originOption = options.origin ?? DEFAULT_ORIGIN;
    this.userAgentOption = options.userAgent;
    this.hostOption = joinHost(options.host, options.port);
    this.roomOption = options.room;
    this.tlsOption = options.tls ?? true;
    this.ackModeOption = options.ackMode;
    // Default true, see `requireHeadersForAuth`. A silent credential downgrade produces an
    // unexplained 4840 from the server, which is far harder to diagnose than a thrown error here.
    this.requireHeadersForAuth = options.requireHeadersForAuth ?? true;
    this.openTimeoutMs = options.openTimeoutMs;
    this.factoryOption = options.webSocketFactory;
    this.preferAdapter = options.preferWebSocketAdapter ?? false;

    if (options.versionResolver !== undefined) {
      this.resolver = options.versionResolver;
    } else {
      // A pinned `version` seeds the cache as `initialVersion`; it does not replace the rest of
      // `versionOptions`, so a caller can pin the first attempt and still supply a source/TTL for any
      // refetch a `4710` forces.
      this.resolver = new VersionResolver({
        ...options.versionOptions,
        // A named room's build is what this connection needs, not the newest build in the game: rooms are
        // updated one at a time, and a room that has not rolled refuses the newest build with `4710` however
        // often the platform endpoint is re-read. Only the resolver's own default source uses this, so a
        // caller who supplied a source or a fetcher keeps it.
        ...(options.versionOptions?.room === undefined &&
        options.room !== undefined &&
        options.room.length > 0
          ? { room: options.room }
          : {}),
        ...(options.version !== undefined && options.version.length > 0
          ? { initialVersion: options.version }
          : {}),
      });
    }
  }

  // ------------------------------------------------------------------------------------
  // Accessors
  // ------------------------------------------------------------------------------------

  /** The live action surface: every documented action, typed. */
  get actions(): GameActions {
    return this.requireCore('actions').actions;
  }

  /**
   * The live state tree for the current session.
   *
   * The **same object** across a reconnect: `openConnection` hands the previous core's store to the next
   * one, so caching this reference is safe (see the class header). It is still read from the live core, so
   * the accessor stays correct if a future client ever starts a new session.
   */
  get store(): ObservableStore {
    return this.requireCore('store').store;
  }

  /** Named reads over the store: `state.self?.garden`, `state.room.players`, `state.room.chat`. */
  get state(): StateReader {
    return this.requireCore('state').state;
  }

  /** Room state: players, chat, host. `fullState.data` (§6.1). */
  get room(): unknown {
    return this.requireCore('room').store.room;
  }

  /** Game state: garden, inventory, shops, weather. `fullState.child.data` (§6.1). */
  get game(): unknown {
    return this.requireCore('game').store.game;
  }

  /** The server-assigned player id from the latest `Welcome`, or `null`. */
  get selfPlayerId(): string | null {
    return this.core?.selfPlayerId ?? null;
  }

  /** True once `Welcome` has been received for the *current* connection. */
  get isReady(): boolean {
    return this.core?.isReady ?? false;
  }

  /** The transport, when one exists. */
  get transport(): StandaloneTransport | null {
    return this.activeTransport;
  }

  /** The most recent `Welcome` payload, or `null`. */
  /**
   * The command-sequence counter, or `null` before the first connection.
   *
   * Exposed because the API reference documents it as a public readonly property on `RoomSocket`
   * ("The command-sequence counter this socket seeds from every incoming Welcome"), and
   * `@mg.js/headless`'s `RoomSocket` facade has to be able to surface it. `null` rather than throwing,
   * so a caller can inspect it before connecting.
   */
  get sequencer(): CommandSequencer | null {
    return this.core?.sequencer ?? null;
  }

  get welcome(): WelcomeMessage | null {
    return this.core?.welcome ?? null;
  }

  /** The `wss://` URL of the current (or most recent) connection. */
  get url(): string {
    return this.currentUrl;
  }

  /** The room slug this session is pinned to. Generated on the first connect when not supplied. */
  get roomSlug(): string {
    return this.currentRoom;
  }

  /** The `clientDocumentId` for this session, stable across every reconnect attempt. */
  get sessionDocumentId(): string {
    return this.documentId;
  }

  /**
   * The attempt number of the current (or most recent) connect attempt, the number that attempt carries
   * on the wire as `clientConnectionAttempt`.
   *
   * It counts attempts that were begun, not sockets that opened, because it is also the budget the
   * reconnect policy spends; `1` is the first attempt with this `documentId`, and it increments per retry
   * (§1.4).
   */
  get connectionAttempt(): number {
    return this.connectionAttemptValue;
  }

  /** The game version last used to build a connect URL. */
  get version(): string {
    return this.currentVersion;
  }

  /** The auth provider in use. */
  get auth(): AuthProvider {
    return this.authProvider;
  }

  /** Why the client has stopped retrying, when it has. */
  get stopped(): string | null {
    return this.stoppedReason;
  }

  /**
   * The most recent failure, as the shared {@link MgError}, or `null`.
   *
   * The field is `unknown` (that is the only honest type a `catch` binding has) and it is normalized here,
   * on read, exactly as `ClientCore` does. That means the accessor, `report.errors` and `isMgError` all
   * agree about the same failure instead of one of them reporting a raw throw.
   *
   * Replaced the pre-4.3 `error: unknown` accessor: a caller branching on `isMgError(client.error)` could
   * not narrow anything.
   */
  get lastError(): MgError | null {
    return this.lastErrorValue === null ? null : toMgError(this.lastErrorValue, 'connect_failed');
  }

  /**
   * True while a connect attempt or a scheduled reconnect is in flight.
   *
   * A re-entrant plan parked behind a running reconnect is covered by the same expression, so no separate
   * `parkedReconnect` clause is needed: a park is only ever written while its owning task is still
   * non-null, so `reconnectTask !== null` already answers for it. (The one instant where it does not,
   * between the task's `finally` clearing the reference and draining the park, is synchronous, so no
   * caller can observe it.)
   */
  get isConnecting(): boolean {
    return this.connectTask !== null || this.reconnectTask !== null;
  }

  /**
   * True while a scheduled retry is in flight: running its backoff, opening its socket, or about to be
   * started.
   *
   * A re-entrant plan parked behind the running task needs no clause of its own for the same reason
   * {@link isConnecting} needs none: a park is only written while that task is non-null, and it is
   * drained inside that task's `finally`.
   *
   * The honest half of `close`'s `willReconnect`. That event reports what the *policy* decided at close
   * time; this reports whether the chain is actually still alive, so a host can tell "a retry is coming"
   * from "the plan was dropped and the client is now silent". `false` is therefore meaningful together
   * with {@link stopped}: it is either a deliberate stop or a spent budget.
   */
  get willReconnect(): boolean {
    return this.reconnectTask !== null;
  }

  /**
   * How many reconnect attempts this session has made.
   *
   * Derived from the one attempt number rather than kept as a second counter: it is
   * `connectionAttempt` counted from the attempt the session started on, so the two can never drift. It is
   * exposed directly because the facade over this client (`RoomSocket`) has to be able to report it
   * without parsing a diagnostics bag.
   */
  get reconnectAttempt(): number {
    return this.policy.retriesMade(this.connectionAttemptValue);
  }

  /**
   * True when the last connect attempt could not send the headers its auth provider requires.
   *
   * The observable half of failing closed: {@link start} rejects with an {@link MgConfigError} whose
   * message says what to change, and this stays `true` afterwards, so a caller that only kept the error,
   * or caught it somewhere far away, can still tell *why* the session never became ready. It is cleared
   * by the next attempt that *can* carry the provider's contribution, not on entry to every attempt, so
   * an automatic retry that is about to be refused for the same reason cannot blank the answer while the
   * caller reads it.
   */
  get headersBlocked(): boolean {
    return this.headersBlockedValue;
  }

  /** How many seconds the current connection has been open, or `null`. */
  get uptimeSeconds(): number | null {
    return this.openedAt === null ? null : (Date.now() - this.openedAt) / 1000;
  }

  /**
   * One JSON-safe snapshot: the contract's axes plus this client's connection bookkeeping.
   *
   * `started` reads "a connection attempt has been made and no `stop()` has ended it", which is the
   * honest analogue of the core's own flag, and no separate `started` boolean exists to drift from it.
   * `socketsSeen` is the attempt counter (`clientConnectionAttempt`), the only attempt count this client
   * keeps and the same one `connectionAttempt` reports, and `renumbering` is always `false` because only
   * the page-attached client renumbers.
   */
  get report(): HeadlessReport {
    return {
      kind: 'headless',
      started: !this.localShutdown && (this.connectTask !== null || this.connectionAttemptValue > 0),
      ready: this.isReady,
      selfPlayerId: this.selfPlayerId,
      attachment: null,
      socketsSeen: this.connectionAttemptValue,
      renumbering: false,
      errors: this.lastErrorValue === null ? [] : [summarizeError(this.lastErrorValue)],
      version: this.currentVersion,
      documentId: this.documentId,
      connectionAttempt: this.connectionAttemptValue,
      versionFresh: this.versionInfo?.fresh ?? null,
      url: this.currentUrl,
      reconnectAttempt: this.policy.retriesMade(this.connectionAttemptValue),
      willReconnect: this.willReconnect,
      coldStart: this.policy.coldStart,
      stopped: this.stoppedReason,
      core: this.core?.report ?? null,
    };
  }

  /** The lifecycle events, addressed the same way on every client. */
  get events(): Emitter<HeadlessClientEvents> {
    // This class *is* the emitter, so this is an alias rather than a second bus, the same arrangement
    // `ClientCore` documents for itself.
    return this;
  }

  // ------------------------------------------------------------------------------------
  // Events
  // ------------------------------------------------------------------------------------

  /**
   * `on` / `once` / `off` / `emit` / `listenerCount` / `clear` are inherited from {@link Emitter}.
   *
   * Only the failure policy is the client's own: a throwing subscriber is logged, because a host that
   * watched a session die wants the reason in its log rather than nowhere. `Emitter` isolates the throw
   * for every other subscriber either way.
   */
  protected override onListenerError(event: keyof HeadlessClientEvents, error: unknown): void {
    this.logger.error(`listener for "${String(event)}" threw`, error);
  }

  /**
   * Every event name this client can emit.
   *
   * Exists so a host (or a test) can subscribe to *everything* without maintaining its own list, which
   * keeps a credential-leak assertion ("nothing I received contains this token") provable rather than
   * aspirational.
   */
  eventNames(): readonly (keyof HeadlessClientEvents)[] {
    return [
      'open',
      'ready',
      'close',
      'confirmationRequired',
      'reconnect',
      'stopped',
      'headers-dropped',
    ] as const;
  }

  /**
   * Subscribe to a core event (`welcome`, `partialState`, `state`, `commandResult`, `unparsed`, and others).
   *
   * The subscription is bound to the *current* connection's core, so it must be re-established after a
   * reconnect. `client.on('ready')` is the reconnect-stable alternative for the common case.
   */
  onCore<TKey extends keyof ClientEvents>(
    event: TKey,
    listener: (...args: ClientEvents[TKey]) => void,
  ): Unsubscribe {
    const core = this.requireCore('event subscription');
    const detach = core.on(event as never, listener as never);
    this.coreDetachers.push(detach);
    return detach;
  }

  // ------------------------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------------------------

  /**
   * Resolve the version, build the URL, open the socket and send the handshake.
   *
   * Resolves once the socket is open (the handshake has been written); it does **not** wait for
   * `Welcome`. Call {@link waitUntilReady} for that. Splitting the two is deliberate: a caller who
   * wants to observe the raw handshake must be able to, and a host that wants "connected and usable" is
   * one `await waitUntilReady()` away.
   *
   * A second call while an attempt is still in flight returns that attempt's promise. A call once a
   * session is live is a new *connection* in the same session: it supersedes the old one outright, which
   * is the behaviour the reconnect tests pin. Only the first half is `MgClient.start()`'s documented
   * idempotence, and this client keeps its superseding call on purpose.
   */
  async start(): Promise<void> {
    if (this.connectTask !== null) return this.connectTask;
    this.localShutdown = false;
    // A fresh `start()` supersedes any reconnect still parked in its backoff, so that plan is cancelled
    // outright before the new session's controller is installed: aborting the old signal wakes its sleep,
    // and the task's own supersession check stops the stale attempt from running. Without this, the parked
    // sleep kept the old signal, woke after the backoff, and its tear-down (`openConnection` →
    // `detachTransport`) destroyed the healthy connection this call had just installed.
    this.reconnectAbort.abort();
    this.parkedReconnect = null;
    // A fresh controller per session: the previous shutdown aborted the old signal for good, and a
    // reconnect scheduled after this connect must be cancellable again.
    this.reconnectAbort = new AbortController();
    this.stoppedReason = null;
    this.versionRefreshFailure = null;
    this.reclaimSupersededNext = false;
    // A fresh `start()` is a caller-driven decision in its own right, so a supersession left waiting for
    // confirmation is no longer the thing being decided about.
    this.pendingSupersession = null;

    const task = this.openConnection(0).finally(() => {
      this.connectTask = null;
    });
    this.connectTask = task;
    return task;
  }

  /** Resolves once `Welcome` has arrived for the current connection, or rejects on timeout. */
  async waitUntilReady(): Promise<void> {
    return this.requireCore('waitUntilReady').waitUntilReady();
  }

  /**
   * Tear the client down: suppress reconnect, close the socket, stop the core, release every listener.
   *
   * Total and idempotent: a second call cannot leave half a teardown behind or overwrite the reason the
   * first one recorded. It absorbs what used to be three separate verbs (`disconnect`, `destroy` and
   * their ordering rules): the close is issued as code `1000` from this side, which `analyzeClose`
   * classifies as `stop`, so even a caller that ignores the result cannot get a reconnect loop out of a
   * clean shutdown, and the transport, its listeners and this client's own listeners are released too.
   * That last part is what the old `destroy()` added on top of `disconnect()`.
   *
   * @param reason Recorded as {@link stopped} and passed to the core. For logs, not for the wire.
   */
  async stop(reason = 'Stopped by this client.'): Promise<void> {
    if (this.localShutdown) return;
    this.localShutdown = true;
    // Before the wait below, not after it: `awaitReconnect()` is the call that used to park here
    // for the remaining backoff, so the cancel has to happen first.
    this.reconnectAbort.abort();
    this.stoppedReason = reason;
    // A deliberate shutdown answers the question a pending supersession was asking, so stop reporting one:
    // `awaitingSupersedeConfirmation` must not outlive the client's own decision to stop.
    this.pendingSupersession = null;
    await this.awaitReconnect();

    const transport = this.activeTransport;
    if (transport !== null) {
      // Observe the close event before detaching, so a `on('close')` handler sees the deliberate
      // shutdown. The wait is bounded: a socket that never answers is the case the transport's
      // own fallback exists for, and `stop()` must not be able to hang.
      const closed = new Promise<void>((resolve) => {
        const off = transport.onClose(() => {
          off();
          resolve();
        });
        // Through `unrefTimer`, not `.unref?.()`: the helper is the one home for this check (DESIGN §5) and
        // is strictly stronger, since `?.()` guards a nullish *receiver* while `unrefTimer` catches a
        // throwing `unref`. The inline form also only compiled because `@types/node` won the `setTimeout`
        // overload here; under the DOM overload the handle is a `number` and it is a hard type error.
        unrefTimer(setTimeout(resolve, 300));
      });
      transport.close(1000, 'client disconnect');
      await closed;
    }

    this.clearCoreDetachers();
    await this.core?.stop(reason);
    this.core = null;
    this.openedAt = null;
    // The half that only `destroy()` used to do: the transport, its listeners and the client's own event
    // listeners go too, so no reference to this session survives the call.
    this.activeTransport?.dispose();
    this.activeTransport = null;
    this.clear();
  }

  // ------------------------------------------------------------------------------------
  // Connection internals
  // ------------------------------------------------------------------------------------

  /**
   * One connect attempt.
   *
   * @param delayMs Backoff already applied by the caller before invoking this. Logged only: the waiting
   *   itself happens in {@link scheduleReconnect}, so a manual `start()` never sleeps.
   */
  private async openConnection(delayMs: number): Promise<void> {
    // The attempt number, incremented **here** before any fallible step, because it is both the §1.4
    // `clientConnectionAttempt` written into the URL (step 4) and the integer the reconnect policy budgets
    // against. It used to be assigned only once the URL was about to be built (after version resolution
    // and auth), which gave the two halves different numbers: a plan could consume budget without an
    // attempt ever starting, and an attempt could fail before consuming any. One increment per attempt
    // begun makes the URL number, `plan.attempt`, the backoff input and the budget the same integer.
    this.connectionAttemptValue += 1;
    const attempt = this.connectionAttemptValue;
    // The controller whose session this attempt belongs to, captured by identity. A later `start()`
    // aborts it *and* installs a fresh one, which is the "a deliberate new session has replaced
    // this attempt" signal; `stop()` aborts without replacing, so it is not supersession and stays
    // on the {@link abandonIfShuttingDown} path (where the deliberate close must still be classified and
    // reported). See {@link isSuperseded}.
    const attemptAbort = this.reconnectAbort;
    // A new attempt retires the last failed refresh: the version was re-resolved (or pinned) again on the
    // way here, so the answer belongs to the attempt that just ended. A refresh still in flight is a
    // separate matter: it is tagged with its own session and ignored when it settles, so this clear
    // cannot be undone by a late rejection from a session a newer `start()` has replaced.
    this.versionRefreshFailure = null;
    // Tear down whatever the previous attempt left behind before allocating anything new.
    this.detachTransport();
    this.clearCoreDetachers();
    // Keep the previous core's store alive across the reconnect (audit 03 F1). `ClientCore` accepts a
    // caller-supplied store for this, and without one the client built a brand-new store per
    // attempt: a caller who cached `const store = client.store` held a detached object that silently
    // stopped receiving patches. The `??` keeps the *first* store if this attempt fails before building a
    // core, so a chain of failed retries cannot lose it.
    this.previousStore = this.core?.store ?? this.previousStore;
    await this.core?.stop('new connection attempt');
    this.core = null;
    this.closedByTransport = false;

    try {
      // 1. Version. `4710` is the documented reason this exists (§9); a `refetch-version` close clears
      //    the cache in the close handler before this runs.
      const resolved = await this.resolver.resolveDetailed();
      if (this.isSuperseded(attemptAbort)) return;
      this.versionInfo = resolved;
      this.currentVersion = resolved.version;
      this.logger.debug('resolved version', {
        version: this.currentVersion,
        source: this.versionInfo.source,
        fresh: this.versionInfo.fresh,
        delayMs,
      });

      // 2. Credentials for this attempt. Per-attempt on purpose: a token may have rotated, and §3 makes
      //    auth a connect-time decision rather than a message.
      const auth = await this.authProvider.prepare();
      if (this.isSuperseded(attemptAbort)) return;

      // 3. Attempt bookkeeping. `attempt` was assigned at the top of this method, before version
      //    resolution, so it counts every attempt that began; `clientNavigationType` is `"navigate"` on the
      //    first attempt of the session and `"reload"` on every retry (§1.4).
      const isReload = attempt > 1;
      const reclaim = this.reclaimSupersededNext;
      this.reclaimSupersededNext = false;

      // 4. URL. `buildConnectUrlDetailed` is the common package's single implementation of the §1.3
      //    encoding rule, and `buildAttemptUrl` adds the auth provider's query on top and hands back
      //    the `documentId` and `room` the server assigns on the first attempt.
      const attemptUrl = buildAttemptUrl({
        host: this.hostOption,
        version: this.currentVersion,
        room: this.roomOption,
        documentId: this.documentId,
        connectionAttempt: attempt,
        isReload,
        reclaimSuperseded: reclaim,
        authQuery: auth.query,
      });

      this.documentId = attemptUrl.documentId;
      this.currentRoom = attemptUrl.room;
      this.currentUrl = attemptUrl.url;

      // 5. Headers. Always computed; applied only if the runtime can carry them.
      const headers = buildConnectHeaders({
        origin: this.originOption,
        ...(this.userAgentOption !== undefined ? { userAgent: this.userAgentOption } : {}),
        extra: auth.headers,
      });

      const wantHeaders = this.factoryOption !== undefined || this.authProvider.authenticated;
      const runtime = await acquireWebSocketRuntime({
        factory: this.factoryOption,
        preferAdapter: this.preferAdapter || (wantHeaders && this.factoryOption === undefined),
      });

      // The last await before anything observable is allocated. A `stop()` *or* a superseding
      // `start()` that landed while the version/auth/runtime work was in flight must stop the attempt
      // here, before a socket or a core can be installed on a client the caller already closed or
      // replaced. (No transport exists yet, hence `null`.) Supersession is checked first because it must
      // not touch state a newer attempt now owns, and `abandonIfShuttingDown` clears shared references.
      if (this.isSuperseded(attemptAbort) || this.abandonIfShuttingDown(null)) return;

      if (!runtime.supportsHeaders && this.authProvider.authenticated) {
        // Fail closed, and make the reason observable two ways: the throw below, and `headersBlocked`.
        // It is set *before* the throw so a caller that only kept the error object, or caught it far
        // from here, can still ask the client why the session never became ready.
        this.headersBlockedValue = true;
        const message =
          `AuthProvider "${this.authProvider.id}" needs headers, but ${runtime.description} cannot ` +
          'send them. Supply `webSocketFactory` (for example the `ws` package) or set ' +
          '`preferWebSocketAdapter: true` with `ws` installed.';
        if (this.requireHeadersForAuth) throw new MgConfigError(message);
        this.logger.warn(message);
      } else {
        // This attempt can carry whatever the provider contributes, so the previous refusal no longer
        // describes the client. Cleared *here* rather than at the top of the attempt on purpose: a fresh
        // attempt that is about to be refused for the same reason must not blank the reason a caller is
        // reading: `headersBlocked` exists so the answer outlives the throw, and a retry chain makes the
        // window between "attempt started" and "refused again" real instead of instantaneous.
        this.headersBlockedValue = false;
        if (runtime.kind === 'node-ws-adapter') {
          // Important to say out loud: the adapter was reached through a *runtime* import, so which
          // implementation carries the socket depends on what happens to be resolvable from this process,
          // not on anything this package declares. A caller debugging header behaviour needs to know
          // which of the two they got.
          this.logger.info('using the dynamically imported ws adapter for this connection', {
            description: runtime.description,
          });
        }
      }

      // 6. Socket.
      const transport = new StandaloneTransport({
        runtime,
        headers,
        ...(this.openTimeoutMs !== undefined ? { openTimeoutMs: this.openTimeoutMs } : {}),
        ...(this.tlsOption ? {} : { scheme: 'ws' as const }),
        onHeadersUnsupported: (dropped) => {
          // I3: the dropped bag is where the credential lives, so nothing raw is allowed past this line,
          // and only the names cross it at all. The deprecated `headersUnsupported` name that used to
          // carry a redacted copy of the bag was removed in Phase 4.3; `headers-dropped` is the one
          // report, and names are all a caller needs to branch on the degradation.
          this.emit('headers-dropped', {
            headerNames: Object.keys(dropped),
            runtime: runtime.description,
          });
        },
      });
      this.activeTransport = transport;

      const core = new ClientCore({
        transport,
        sequencer: new CommandSequencer(),
        ackMode: this.ackModeOption ?? 'fifo',
        logger: this.logger.child('core'),
        // The transport answers the bare-string keepalive itself (`transport/standalone.ts`), so the core
        // must not try as well. The common package documents this exact arrangement.
        autoHandledKeepalive: false,
        // The previous attempt's store, so a caller's cached `client.store` keeps receiving patches across
        // a reconnect. `undefined` on the first connection, which makes the core create one.
        store: this.previousStore ?? undefined,
      });
      this.core = core;

      this.logger.info('connecting', {
        url: this.currentUrl,
        attempt,
        isReload,
        reclaimSuperseded: reclaim,
        auth: this.authProvider.id,
        runtime: runtime.kind,
        headersApplied: runtime.supportsHeaders,
        version: this.currentVersion,
      });

      this.coreDetachers.push(
        transport.onOpen(() => {
          // A superseded attempt's socket is not this session's: announcing it would report a session the
          // caller has already replaced.
          if (this.isSuperseded(attemptAbort)) return;
          // Guarded: the open handler must never throw into the socket's EventTarget.
          try {
            this.openedAt = Date.now();
            // Admission first: the server admits a socket by the `SocketOpened` frame and closes it with
            // `AdmissionTimedOut` (4410) if it never arrives. The §1.6 vote frames go out on `ready`
            // instead, because they are the game's business once the session exists.
            writeAdmission(transport, this.logger);
            this.emit('open');
          } catch (error) {
            this.logger.error('handshake failed', error);
            try {
              transport.close(1000, 'handshake failed');
            } catch {
              // Nothing left to do; the close event will settle the state.
            }
          }
        }),
      );

      this.coreDetachers.push(
        core.on('ready', () => {
          // A superseded attempt's `Welcome` belongs to a session the caller has replaced, so it must not
          // clear the *current* session's attempt budget or announce readiness.
          if (this.isSuperseded(attemptAbort)) return;
          // `Welcome` is the protocol's definition of a session having started (§1.6), and it is the
          // only thing that resets the session budget. The attempt number it arrived on is what the
          // policy records, so the reset is anchored to the connection that actually started the session.
          this.policy.markEstablished(this.connectionAttemptValue);
          // The session exists, so the vote frames that put a caller into the engine's own scope can go —
          // this is where the game's own client writes them. A failure here is logged, not fatal: the room
          // state a garden reader wants is already arriving.
          try {
            writeHandshake(transport, this.logger);
          } catch (error) {
            this.logger.error('handshake failed', error);
          }
          this.emit('ready');
        }),
      );

      this.coreDetachers.push(
        core.on('close', ({ info }) => {
          // A superseded attempt's socket is not this session's. Classifying its close could emit
          // `willReconnect: true` for a session that no longer exists and park a plan whose first act is
          // `detachTransport()`, that is, tear down the replacement connection. `stop()` aborts the
          // controller without replacing it, so a deliberate close still reaches `handleClose`.
          if (this.isSuperseded(attemptAbort)) return;
          this.handleClose(info);
        }),
      );

      await transport.connect(this.currentUrl);
      // The attempt can have been superseded *while the socket was opening*. A newer `start()` has
      // already detached this transport and installed its own, so only this attempt's own socket is
      // disposed here, and never the shared references, which now belong to the newer session.
      if (this.isSuperseded(attemptAbort)) {
        transport.dispose();
        return;
      }
      // The second window: `stop()` landed *while the socket was opening*. An open/`ready`/`close`
      // event may already have been handled from this transport, but leaving it installed (and the core
      // attached to it) is the leak: a live socket on a client whose `stop()` has returned.
      if (this.abandonIfShuttingDown(transport)) return;
      this.closedByTransport = false;
    } catch (error) {
      this.lastErrorValue = error;
      this.logger.error('connect attempt failed', error, {
        url: this.currentUrl,
        attempt: this.connectionAttemptValue,
      });
      // A superseded attempt reports nothing: synthesising its close would emit `willReconnect: true` for
      // a session the caller has replaced, and the plan it parks would be drained into a retry whose
      // `openConnection` starts by `detachTransport()`-ing the healthy replacement connection.
      if (!this.closedByTransport && !this.isSuperseded(attemptAbort)) {
        // No socket close was observed (the constructor threw, the version could not be resolved, the
        // runtime refused). Synthesise one so there is exactly one reconnect path.
        this.closedByTransport = true;
        this.handleSyntheticClose(error);
      }
      throw error;
    }
  }

  /** The close path for both a real socket close and a failed connect attempt. */
  private handleClose(info: TransportCloseInfo): void {
    this.closedByTransport = true;
    this.openedAt = null;

    // `localShutdown` is belt-and-braces on top of the transport's `wasManual`, so a `stop()`
    // whose close frame races the transport's own teardown still cannot schedule a reconnect.
    const analysis = classifyClose(info, { localShutdown: this.localShutdown });
    this.logger.info('closed', {
      code: info.code,
      reason: info.reason,
      wasClean: info.wasClean,
      wasManual: info.wasManual,
      disposition: analysis.disposition,
      explanation: analysis.reason,
    });

    const plan = this.localShutdown ? null : this.policy.planRetry(analysis, this.connectionAttemptValue);

    this.emit('close', { info, analysis, willReconnect: plan !== null });
    this.afterClose(info, analysis, plan);
  }

  /**
   * Everything that follows classification, shared by the first pass and by a confirmed supersession.
   *
   * Split out so that confirming does not re-emit `close` for a close the caller has already been told about.
   */
  private afterClose(info: TransportCloseInfo, analysis: CloseAnalysis, plan: BackoffPlan | null): void {
    if (analysis.requiresVersionRefetch && !this.localShutdown) {
      // §9: reconnecting with the version that just got us closed is the documented endless `4710`
      // loop. Start the refresh now so it overlaps the backoff; the retry awaits `resolve()` again and
      // will observe the fresh value either way.
      //
      // `refresh()` is strict (Task 2.7): it no longer falls back to the cached value, so a rejection
      // here means there is *no* version to retry with. That is recorded rather than logged and dropped;
      // see the check in `scheduleReconnect`'s task.
      //
      // The refresh is tagged with the session that started it. A newer `start()` replaces
      // `reconnectAbort`, and a refresh that outlives its own session must not be able to say anything
      // about the one that replaced it: the failure below reads `versionRefreshFailure`, which a newer
      // session's own successful refresh has already cleared.
      const refreshSession = this.reconnectAbort;
      void this.resolver.refresh().then(
        (resolved) => {
          this.logger.info('version re-resolved after 4710', {
            previous: this.currentVersion,
            version: resolved.version,
          });
          if (this.reconnectAbort !== refreshSession) return;
          this.versionInfo = resolved;
          // A success is evidence, so it retires any earlier failure from this same session. Leaving it
          // standing would let one failed probe of an endpoint that then recovered stop the reconnect.
          this.versionRefreshFailure = null;
        },
        (error: unknown) => {
          // The message names the close code and the resolver's own failure only. The payload that
          // produced it is untrusted input and never becomes part of a message (I4).
          const message = error instanceof Error ? error.message : 'unknown error';
          if (this.reconnectAbort !== refreshSession) {
            this.logger.debug('ignoring a version refresh failure from a superseded session', {
              error,
            });
            return;
          }
          this.versionRefreshFailure = `Could not re-resolve the game version after close ${info.code}: ${message}`;
          this.logger.warn('version refresh after 4710 failed; not retrying with a rejected version', {
            error,
          });
        },
      );
    }

    if (plan === null) {
      if (!this.localShutdown && analysis.requiresConfirmation) {
        // A supersession. `analyzeClose` refused the reconnect on purpose: the game's developers warn
        // that two clients reclaiming one identity in turn lose each other's session and nothing gets
        // saved, and that it is "only safe to do so with explicit confirmation from the player". This
        // is where the decision stops and a human has to pick it up.
        this.pendingSupersession = info;
        this.stoppedReason = analysis.reason;
        this.emit('confirmationRequired', { analysis });
        this.logger.warn('session superseded; reconnecting only with explicit confirmation', {
          reason: analysis.reason,
          confirmWith: 'confirmSupersededReconnect()',
        });
        return;
      }
      if (!this.localShutdown && analysis.shouldReconnect) {
        const attemptsMade = this.policy.sessionAttempts(this.connectionAttemptValue);
        const reason = this.policy.canRetry(this.connectionAttemptValue)
          ? `Reconnect refused: disposition "${analysis.disposition}" (${analysis.reason})`
          : `Reconnect budget exhausted after ${attemptsMade} attempts.`;
        this.stoppedReason = reason;
        this.emit('stopped', { reason });
        this.logger.warn('not reconnecting', { reason, attempt: this.connectionAttemptValue });
      }
      return;
    }

    // `reclaimSupersededSession=true` is required by §1.4 for the next connect after a real supersede.
    if (analysis.isSuperseded) this.reclaimSupersededNext = true;

    this.scheduleReconnect(plan, analysis);
  }

  /**
   * Reconnect a superseded session, now that a person has confirmed it.
   *
   * The protocol cannot tell two clients apart, so reclaiming is inherently a *choice between players*:
   * whoever reclaims takes the session from whoever holds it. That is why nothing here is automatic, and why
   * this is the only route to `reclaimSupersededSession=true`.
   *
   * @returns `false` when there is nothing waiting to be confirmed, or when the reconnect budget is spent.
   *   Both are reported the same way so a caller cannot read "nothing to confirm" as "reconnecting".
   */
  confirmSupersededReconnect(): boolean {
    const info = this.pendingSupersession;
    if (info === null || this.localShutdown) return false;
    this.pendingSupersession = null;

    const analysis = classifyClose(info, {
      localShutdown: this.localShutdown,
      supersedeConfirmed: true,
    });
    const plan = this.policy.planRetry(analysis, this.connectionAttemptValue);
    if (plan === null) {
      this.stoppedReason = `Reconnect refused: disposition "${analysis.disposition}" (${analysis.reason})`;
      this.emit('stopped', { reason: this.stoppedReason });
      return false;
    }

    this.logger.info('superseded reconnect confirmed by the caller', { code: analysis.code });
    this.afterClose(info, analysis, plan);
    return true;
  }

  /** Whether a supersession is waiting for {@link confirmSupersededReconnect}. */
  get awaitingSupersedeConfirmation(): boolean {
    return this.pendingSupersession !== null;
  }

  /**
   * A failed connect attempt where no close event was ever seen. Synthesised into the same pipeline so
   * there is exactly one reconnect path.
   */
  private handleSyntheticClose(error: unknown): void {
    this.handleClose({
      code: 1006,
      reason: error instanceof Error ? error.message : 'connect attempt failed',
      wasClean: false,
      wasManual: false,
    });
  }

  private scheduleReconnect(plan: BackoffPlan, analysis: CloseAnalysis): void {
    // Checked before parking, not after: a shutdown invalidates the plan outright, and parking is not a
    // way around `stop()`.
    if (this.localShutdown) return;
    if (this.reconnectTask !== null) {
      // A re-entrant call from inside the running task: `openConnection` failed pre-open and routed that
      // failure through `handleClose` → `afterClose` → here. Dropping the plan was what made the `close`
      // event's `willReconnect: true` a lie; park it and let the running task's `finally` start the next
      // attempt.
      this.parkedReconnect = { plan, analysis };
      return;
    }

    const url = this.currentUrl;
    this.logger.warn('reconnecting', {
      delayMs: plan.delayMs,
      attempt: plan.attempt,
      superseded: plan.superseded,
      coldStartFast: plan.coldStartFast,
      disposition: analysis.disposition,
      why: plan.reason,
    });
    this.emit('reconnect', { plan, analysis, url });

    // The controller this plan belongs to, captured by identity so the task can tell whether a later
    // `start()` has superseded it. `stop()` aborts this signal too, so the shutdown
    // check below is kept as a separate expression of intent.
    const planAbort = this.reconnectAbort;
    const task = (async (): Promise<void> => {
      // Resolves early (it does not reject) when the plan is aborted; the guards on the next lines are what
      // turn that into "stop", so the abort needs no catch arm of its own.
      await ReconnectPolicy.sleep(plan, planAbort.signal);
      if (this.localShutdown) return;
      // A newer `start()` supersedes this plan: it aborts this signal, which wakes the sleep just awaited,
      // and installs a fresh controller. Re-checking *after* the await is required, because the abort
      // resolved the sleep rather than stopping the task, so without this the stale attempt would run and
      // its `detachTransport()` would destroy the connection that `start()` had installed.
      if (planAbort.signal.aborted || this.reconnectAbort !== planAbort) return;
      // The version remedy for this close failed while the backoff ran, so this attempt would carry the
      // very build the server just rejected: connect, `4710`, refresh, repeat. That is §9's endless loop,
      // with nothing reported. Stop honestly instead. This check sits *after* the supersession guard above:
      // a plan belonging to a session a newer `start()` has replaced must not emit anything, and the
      // refresh failure it is reading may have landed after that replacement.
      if (analysis.requiresVersionRefetch && this.versionRefreshFailure !== null) {
        this.stoppedReason = this.versionRefreshFailure;
        this.emit('stopped', { reason: this.stoppedReason });
        return;
      }
      try {
        await this.openConnection(plan.delayMs);
      } catch (error) {
        this.logger.debug('reconnect attempt failed', { error });
      }
    })().finally(() => {
      this.reconnectTask = null;
      // Drain after clearing the reference, so the recursive call takes the normal path rather than
      // parking again. A shutdown that landed while this task ran invalidates the parked plan, and a
      // `start()` that superseded it has already cleared `parkedReconnect`.
      const parked = this.parkedReconnect;
      this.parkedReconnect = null;
      if (parked !== null && !this.localShutdown) this.scheduleReconnect(parked.plan, parked.analysis);
    });

    this.reconnectTask = task;
  }

  /** Wait for any scheduled reconnect to finish (used by `disconnect` and by tests). */
  private async awaitReconnect(): Promise<void> {
    const task = this.reconnectTask;
    if (task !== null) {
      try {
        await task;
      } catch {
        // A failed reconnect is already reported through events.
      }
    }
  }

  private detachTransport(): void {
    const transport = this.activeTransport;
    if (transport === null) return;
    transport.dispose();
    this.activeTransport = null;
  }

  /**
   * Whether a newer `start()` has replaced the session this attempt belongs to.
   *
   * The token is the abort controller captured at the top of {@link openConnection}. `start()` aborts
   * that controller and installs a fresh one, so identity answers "has my session been replaced?";
   * `stop()` aborts *without* replacing, which is not supersession: that path must
   * still classify and report the deliberate close, and is handled by {@link abandonIfShuttingDown}.
   */
  private isSuperseded(attemptAbort: AbortController): boolean {
    return this.reconnectAbort !== attemptAbort;
  }

  /**
   * Give up on a connect attempt whose client has since been shut down.
   *
   * `openConnection` spans several awaits, and `stop()` cannot await it without trading its bounded
   * 300 ms close race for an unbounded open timeout. So the attempt checks the shutdown flag itself, at
   * each point where it is about to make something observable, and tears down what it built.
   *
   * `transport` is passed explicitly rather than read from `this.activeTransport`: the check must not be
   * able to dispose a *newer* attempt's socket. `null` means "nothing was created yet".
   *
   * @returns `true` when the caller must stop; the attempt is fully unwound at that point.
   */
  private abandonIfShuttingDown(transport: StandaloneTransport | null): boolean {
    if (!this.localShutdown) return false;
    transport?.dispose();
    // The core was built for this attempt; releasing its listeners and failing its pending commands is
    // part of dropping the socket, not optional cleanup. `stop()` never rejects, so there is nothing to
    // await here, and this method is synchronous because `stop()` cannot await an
    // `openConnection` it is trying to unwind.
    void this.core?.stop('connection attempt abandoned');
    this.core = null;
    this.activeTransport = null;
    this.clearCoreDetachers();
    this.openedAt = null;
    return true;
  }

  private clearCoreDetachers(): void {
    for (const detach of this.coreDetachers.splice(0)) {
      try {
        detach();
      } catch {
        // Ignore: detaching must always complete.
      }
    }
  }

  private requireCore(what: string): ClientCore {
    if (this.core === null) {
      throw new MgNotReadyError(
        `Cannot use "${what}" before start(): no connection has been established yet.`,
      );
    }
    return this.core;
  }
}
