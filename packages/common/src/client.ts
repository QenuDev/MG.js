/**
 * The shared client core.
 *
 * Owns everything that is identical between the two clients: envelope construction, sequence
 * numbering, ack correlation, state application, and the readiness gate. The only thing it does not
 * own is the socket, which arrives as a {@link Transport}.
 *
 * Ack correlation deserves the explanation. The protocol gives one feedback channel
 * (`QuinoaCommandResult`) and, in the documented payload, no `requestId` to correlate it with. So this
 * class offers three explicit modes and never overstates what it knows:
 *
 *   - `'strict'`: settle only on a matching `requestId`. Commands that are never echoed settle as
 *     unconfirmed. Correct when a build echoes ids; honest about it when it does not.
 *   - `'fifo'` (default): match by action name and send order. Results are flagged
 *     `confirmed: false, matchMethod: 'fifo'`, because ordering is probable, not proof.
 *   - `'none'`: never correlate; every handle settles from the frontier ledger or the timeout.
 *
 * In all three modes the sequence frontier is tracked, and that is what makes the synthesized
 * `dropped_stale` outcome possible at all.
 */

import { GameActions } from './actions/game-actions.js';
import type { CommandResult, CommandSender } from './actions/handle.js';
import { CommandHandle, failureResult } from './actions/handle.js';
import type { FormRegistry } from './actions/registry.js';
import { defaultFormRegistry, getActionSpec } from './actions/registry.js';
import { interpretRejection } from './actions/result-codes.js';
import { CommandSequencer } from './actions/sequencer.js';
import type { ClientCloseEvent, ClientReport } from './client-contract.js';
import { Emitter } from './emitter.js';
import type { MgError } from './errors.js';
import {
  MgCommandRejectedError,
  MgCommandUnconfirmedError,
  MgConfigError,
  MgNotReadyError,
  summarizeError,
  toMgError,
} from './errors.js';
import type { Logger } from './log.js';
import { createNullLogger } from './log.js';
import { asSequence, extractFrontier, extractPatches, parseFrame, serializeFrame } from './protocol/codec.js';
import { buildFrame } from './protocol/envelope.js';
import { randomUuid } from './protocol/id.js';
import type {
  FullState,
  InboundMessage,
  OutboundFrame,
  Patch,
  PongMessage,
  QuinoaCommandResultMessage,
  WelcomeMessage,
} from './protocol/wire.js';
import { StateReader } from './state/reader.js';
import type { StateChange } from './state/store.js';
import { emptyStateTree, ObservableStore } from './state/store.js';
import type { LifecycleTimeouts, Transport } from './transport/seam.js';
import { DEFAULT_LIFECYCLE_TIMEOUTS } from './transport/seam.js';
import type { Unsubscribe } from './unsubscribe.js';
import { MG_VERSION } from './version.js';

/** How aggressively to correlate results with the commands that produced them. */
export type AckMode = 'strict' | 'fifo' | 'none';

/**
 * Events the client core emits.
 *
 * Declared as a type alias rather than an interface on purpose: TypeScript gives implicit index
 * signatures to type aliases of object types but not to interfaces, and the {@link Emitter} generic
 * needs one.
 */
export type ClientEvents = {
  welcome: [WelcomeMessage];
  partialState: [{ patches: readonly Patch[]; message: InboundMessage }];
  state: [StateChange];
  /** A command was acknowledged or rejected with a correlatable result. */
  commandResult: [{ result: CommandResult; message: QuinoaCommandResultMessage }];
  /** The server's frontier advanced past a command we sent, which never executed. */
  droppedStale: [{ action: string; sequence: number; requestId: string }];
  /** A frame we could not parse. Never fatal. */
  unparsed: [{ raw: string }];
  /**
   * An inbound frame larger than `MAX_FRAME_BYTES`, dropped unparsed.
   *
   * `bytes` is the byte offset at which the cap was first exceeded, a lower bound on the frame's size,
   * not its true size (see `utf8ByteLength`). The payload carries that offset and the limit, and **not the
   * frame**: retaining the bytes we just refused would defeat the ceiling.
   *
   * This event bounds only what *this core* parses. An attachment that parses a frame before handing it to
   * the core must apply the same cap itself, or it is the one holding a hostile frame. The bootstrapped raw
   * socket is exactly that path, and `attach/raw-socket.ts` bounds its scrape with `MAX_FRAME_BYTES` before
   * its `JSON.parse`. Where the core's drop really is the whole defence is the headless transport's browser
   * or undici socket: it ignores the constructor's `maxPayload`, so `StandaloneTransport.handleMessage`
   * checks and closes with `1009` before this can fire, whereas the bootstrapped core cannot close the host
   * game's socket. That asymmetry is deliberate.
   */
  oversizedFrame: [{ bytes: number; limit: number }];
  /** An inbound type this package does not model. */
  unknownMessage: [{ type: string; raw: Record<string, unknown> }];
  close: [ClientCloseEvent];
  open: [];
  /** The client is ready to accept gameplay commands. */
  ready: [];
};

/** Options for {@link ClientCore}. */
export interface ClientCoreOptions {
  transport: Transport;
  /** Overrides the sequence strategy; defaults are chosen from the transport kind. */
  sequencer?: CommandSequencer;
  /** Defaults to `'fifo'`. See the class comment for why. */
  ackMode?: AckMode;
  logger?: Logger;
  timeouts?: Partial<LifecycleTimeouts>;
  forms?: FormRegistry;
  /**
   * An existing store to populate, instead of a fresh one.
   *
   * WHY THIS EXISTS: a client that reconnects has to build a new `ClientCore`, because the only way to
   * attach a different transport is to construct a new core, because `attachTransport()` is private and only
   * `stop()` releases the old listeners. Without this option that means a **new store object per
   * reconnect**, so a caller who cached `const store = client.store` before a reconnect holds a dead
   * store: it stops receiving patches, with no error and no indication why.
   *
   * Passing the previous core's store across a reconnect keeps that reference live and keeps every
   * subscription attached. `Welcome` then arrives on the same store via `replaceRoot`, exactly as it
   * does on a first connection.
   *
   * Omit it and a fresh store is created, which is right for a first connection.
   */
  store?: ObservableStore;
  /**
   * Live reader for the server's confirmed frontier, used by the frontier-anchored strategy.
   * The bootstrapped client supplies one backed by `lastDistributedRoomPublication`.
   */
  getFrontier?: () => number | null | undefined;
  /**
   * Whether to answer the bare-string keepalive. The headless transport does this itself and passes
   * `false`; the bootstrapped transport must not, because the host game answers it.
   */
  autoHandledKeepalive?: boolean;
  /**
   * The version this core reports, for `report.version`.
   *
   * Defaults to `MG_VERSION`. A platform client that resolved the server's build version itself (the
   * headless client's `VersionResolver`) passes what it resolved, so `report` names the version the
   * connection actually used rather than the package's own.
   */
  version?: string;
}

/**
 * The `id` a `Ping` frame will carry, or `undefined` for every other frame.
 *
 * Read off the built frame rather than off the action's params: the frame is what goes on the wire and
 * what the `Pong` will answer, so a form override that drops or renames `id` is reflected here instead
 * of being assumed away. A non-numeric `id` is not evidence: `Pong.id` is typed `number`, so there is
 * nothing it could match.
 */
function readPingId(frame: OutboundFrame): number | undefined {
  const id = (frame as { id?: unknown }).id;
  return typeof id === 'number' ? id : undefined;
}

/** Everything {@link ClientCore.report} publishes: the shared contract axes, plus the core's own. */
export interface ClientCoreReport extends ClientReport {
  ackMode: AckMode;
  pending: number;
  state: ObservableStore['stats'];
  sequencer: { lastIssued: number; frontier: number | null };
}

/**
 * A pending command awaiting settlement.
 *
 * `pingId` exists because a `Ping` is the one action the protocol answers directly rather than through
 * `QuinoaCommandResult`: `GameActions.ping` puts an id on the *flat* frame (it never reaches the
 * envelope, so nothing echoes our `requestId` there), and the `Pong` carries that number back. Matching
 * by it is therefore the only correlation the ping path has.
 */
interface PendingCommand {
  requestId: string;
  action: string;
  sequence: number;
  pingId?: number;
  resolve: (result: CommandResult) => void;
  reject: (error: unknown) => void;
  /** Resolves the `settled` promise, which never rejects. */
  settle: (result: CommandResult | null) => void;
  timer: ReturnType<typeof setTimeout> | null;
  done: boolean;
}

/**
 * The runtime-agnostic client core.
 *
 * Not usually constructed directly. `@mg.js/headless` and `@mg.js/bootstrapped` each build one and
 * expose a client-shaped API over it.
 */
export class ClientCore extends Emitter<ClientEvents> implements CommandSender {
  readonly store: ObservableStore;
  /**
   * The named reads over {@link store}: `client.state.self?.garden` rather than a JSON Pointer.
   *
   * One instance per client, so a mod can hold it across a reload. See `state/reader.ts` for why the
   * accessors exist.
   */
  readonly state: StateReader;
  readonly actions: GameActions;
  readonly sequencer: CommandSequencer;
  readonly transport: Transport;
  readonly forms: FormRegistry;

  private readonly logger: Logger;
  private readonly timeouts: LifecycleTimeouts;
  private readonly ackMode: AckMode;
  private readonly pending = new Map<string, PendingCommand>();
  /** FIFO queues of pending request ids, keyed by action, for `ackMode: 'fifo'`. */
  private readonly fifoByAction = new Map<string, string[]>();
  private readonly detachers: Unsubscribe[] = [];
  private readyState = false;
  private selfPlayerIdValue: string | null = null;
  private welcomeValue: WelcomeMessage | null = null;
  private lastErrorValue: MgError | null = null;
  /**
   * Every in-flight {@link waitUntilReady} wait, so {@link stop} can settle all of them.
   *
   * Each entry rejects one outstanding wait and unregisters itself, so a wait is settled exactly once
   * whether it ends by `Welcome`, by its own timeout or by a stop.
   *
   * The timers used to be local to their promises and reachable from nothing else, and this field held
   * only the *most recent* wait: a core stopped while two callers were waiting left the earlier promise
   * armed for the rest of its timeout, and that live timer held the Node event loop open for just as long.
   */
  private readonly readyWaits = new Set<(error: Error) => void>();
  private readonly getFrontierOption: (() => number | null | undefined) | undefined;
  private readonly autoHandledKeepalive: boolean;
  private readonly versionOption: string;
  private started = false;
  private stopped = false;
  /**
   * The session's transport has closed, so this core is one-way.
   *
   * The transport seam is constructor-only, so a close ends the only session this core can have: a late
   * `Welcome` is a stray frame from a dead socket, not the start of a new session. Both platform clients
   * agree, and each builds a new core for the next attempt rather than reviving this one.
   */
  private closed = false;
  /** The reason {@link stop} was called with, read back through {@link stopReason}. */
  private stoppedReason: string | null = null;

  constructor(options: ClientCoreOptions) {
    super();
    this.transport = options.transport;
    this.logger = options.logger ?? createNullLogger();
    this.forms = options.forms ?? defaultFormRegistry;
    this.ackMode = options.ackMode ?? 'fifo';
    this.timeouts = { ...DEFAULT_LIFECYCLE_TIMEOUTS, ...options.timeouts };
    this.getFrontierOption = options.getFrontier;
    this.autoHandledKeepalive = options.autoHandledKeepalive ?? false;
    this.versionOption = options.version ?? MG_VERSION;

    // Reuse a caller-supplied store so subscriptions survive a reconnect. See `ClientCoreOptions.store`.
    this.store = options.store ?? new ObservableStore({ initial: emptyStateTree() });
    this.state = StateReader.of(this.store);
    // The frontier-anchored strategy is what the bootstrapped client needs, because the host game has
    // its own module-private counter on the same socket. A caller supplying a frontier reader is
    // asking for exactly that, so honour it rather than silently handing back a monotonic counter.
    this.sequencer =
      options.sequencer ??
      new CommandSequencer(this.getFrontierOption ? { getFrontier: this.getFrontierOption } : {});
    this.actions = new GameActions(this);

    this.attachTransport();
  }

  // ------------------------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------------------------

  private attachTransport(): void {
    this.detachers.push(
      this.transport.onOpen(() => {
        this.emit('open');
      }),
    );

    this.detachers.push(this.transport.onMessage((raw) => this.handleRawFrame(raw)));

    this.detachers.push(
      this.transport.onClose((info) => {
        // First thing, before any event can re-enter this core: the session is over. See {@link closed}.
        this.closed = true;
        this.readyState = false;
        // INVARIANT I6: `selfPlayerId` and `welcome` are two accessors for one fact, so they are cleared
        // together. A `Welcome` describes a session that has ended the moment the socket closes; leaving
        // it standing is what let `client.welcome?.selfPlayerId` name a player who was no longer
        // connected while `client.selfPlayerId` said `null`.
        this.selfPlayerIdValue = null;
        this.welcomeValue = null;
        this.rejectAllPending(info.wasManual ? 'transport closed' : 'connection lost');
        this.emit('close', { info });
      }),
    );
  }

  /**
   * Begin the session.
   *
   * Honest bookkeeping, not a second connection. The transport seam is constructor-only:
   * {@link attachTransport} runs in the constructor and there is no way to hand this core a different
   * transport, so there is nothing left to open by the time a caller can call this. What `start()` does
   * is record that a start was performed, and that is what makes {@link stop}'s teardown irreversible: a
   * stopped core refuses to start again rather than pretending a detached core is a live one.
   *
   * @throws {MgConfigError} when the core has already been stopped. A stopped core has released its
   *   transport listeners and cannot get them back; a caller who wants a new session constructs a new
   *   core, which is also the only way to attach a new transport.
   */
  async start(): Promise<void> {
    if (this.stopped) {
      throw new MgConfigError('This ClientCore was stopped; construct a new one to start again.');
    }
    this.started = true;
  }

  /**
   * Tear the core down: detach from the transport, settle every readiness wait and fail every pending
   * command.
   *
   * Never throws and is safe to call twice. Declared `async` so that even a caller who ignores the
   * returned promise cannot get a synchronous throw out of teardown.
   *
   * The state tree's subscribers are left alone, whether the caller supplied them or they were created
   * here. Subscriptions outlive the core they were made on by design, because a reconnect hands the same
   * store to the next core and a caller's cached `store` must keep working across it.
   */
  async stop(reason = 'Client stopped.'): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stoppedReason = reason;
    // A `stop()` and a close are the same fact to a reader, so they set the same latch: no inbound frame
    // is part of this core's session any more.
    this.closed = true;
    // A core is live the moment it is constructed (the transport is attached in the constructor), so a
    // `stop()` on a core nobody called `start()` on still ends a session that was running. `started`
    // therefore reads "a start was performed", never "start() was called".
    this.started = true;
    // Settle readiness waits first: they are the promises a caller can be holding across a stop, and
    // `removeAllListeners()` below is not enough to release them. *Every* outstanding wait is settled,
    // not just the latest, because an earlier wait would otherwise stay armed for its full timeout, and
    // its live timer would hold the event loop open until it fired.
    for (const settle of [...this.readyWaits]) {
      settle(new MgNotReadyError('Client was stopped before it became ready.'));
    }
    for (const detach of this.detachers.splice(0)) {
      try {
        detach();
      } catch {
        // Ignore: teardown must always complete.
      }
    }
    this.rejectAllPending('client stopped');
    // The state tree's subscribers are left in place on purpose. `stop()` is not only an end-of-session
    // call: it is also the teardown between two connect attempts, and `HeadlessClient` hands the previous
    // attempt's store to the next core precisely so a caller's cached `store` keeps working. Emptying the
    // store here would kill the subscriptions that arrangement exists to keep. This core's own event
    // listeners are its business and are released on the next line.
    this.removeAllListeners();
    this.readyState = false;
    // A stopped core has no session at all, so the identity pair is cleared together (I6). That is the
    // same rule the close handler applies, because `stop()` and a close are the same fact to a reader.
    this.selfPlayerIdValue = null;
    this.welcomeValue = null;
  }

  // ------------------------------------------------------------------------------------
  // State accessors
  // ------------------------------------------------------------------------------------

  /** True once `Welcome` has arrived and the sequencer is seeded. */
  get isReady(): boolean {
    return this.readyState;
  }

  /** The server-assigned player id, or `null` before the first `Welcome`. */
  get selfPlayerId(): string | null {
    return this.selfPlayerIdValue;
  }

  /**
   * The most recent `Welcome`, or `null`.
   *
   * `null` whenever {@link selfPlayerId} is `null`. A `Welcome` outlives neither a close nor a `stop()`,
   * so the two accessors can never disagree (I6). That is now enforced by dropping inbound frames once
   * {@link closed}. `report.selfPlayerId` reads the same field, so it agrees too: a caller that wants to
   * name the session *after* it ended must have recorded the id while it was live.
   */
  get welcome(): WelcomeMessage | null {
    return this.welcomeValue;
  }

  /** Room state: players, chat, host. */
  get room(): unknown {
    return this.store.room;
  }

  /** Game state: garden, inventory, shops, weather. */
  get game(): unknown {
    return this.store.game;
  }

  /** Why the transport last failed, when it did. */
  get lastError(): MgError | null {
    return this.lastErrorValue;
  }

  /**
   * A fresh, JSON-safe diagnostic snapshot.
   *
   * Supersedes `stats`, which it contains under the same names; `report` is the one diagnostic surface
   * every client answers.
   */
  get report(): ClientCoreReport {
    return {
      kind: 'common',
      started: this.started,
      ready: this.readyState,
      // The same value the `selfPlayerId` accessor reads, from the same field, so `report` can never
      // disagree with it (I6).
      selfPlayerId: this.selfPlayerIdValue,
      attachment: null,
      socketsSeen: 0,
      renumbering: false,
      errors: this.lastErrorValue === null ? [] : [summarizeError(this.lastErrorValue)],
      version: this.versionOption,
      ackMode: this.ackMode,
      pending: this.pending.size,
      state: this.store.stats,
      sequencer: {
        lastIssued: this.sequencer.lastIssued,
        frontier: this.sequencer.frontier,
      },
    };
  }

  /** The lifecycle events, addressed exactly as every other client addresses them. */
  get events(): Emitter<ClientEvents> {
    // This class *is* the emitter, so this is an alias rather than a second bus. A caller written against
    // `MgClient` needs one spelling, and `on`/`once`/`off` stay available beside it.
    return this;
  }

  /** The reason the last {@link stop} was called with, or `null` while the core is live. */
  get stopReason(): string | null {
    return this.stoppedReason;
  }

  /** Resolves once the client is ready, or rejects on timeout. */
  waitUntilReady(timeoutMs = this.timeouts.welcomeMs): Promise<void> {
    if (this.readyState) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let off: Unsubscribe | null = null;
      let timer: ReturnType<typeof setTimeout>;
      // Reject this wait and unregister it. `stop()` calls this for every outstanding wait, and the
      // self-removal is what makes that walk safe: a wait already settled by `Welcome` or by its timeout
      // is no longer in the set, so nothing is rejected twice.
      const fail = (error: Error): void => {
        this.readyWaits.delete(fail);
        clearTimeout(timer);
        off?.();
        reject(error);
      };
      timer = setTimeout(() => {
        fail(new MgNotReadyError(`Client was not ready within ${timeoutMs}ms, no Welcome received.`));
      }, timeoutMs);
      // Not `unref`ed, unlike a disposable one-shot, and that is intentional: a caller awaiting readiness
      // is waiting for this promise to settle, and an `unref`ed timer lets the process exit with the wait
      // still pending (`rejects waitUntilReady on timeout` below pins that down). A *stopped* core no
      // longer holds the loop because `stop()` clears every registered wait's timer outright.
      off = this.once('ready', () => {
        this.readyWaits.delete(fail);
        clearTimeout(timer);
        resolve();
      });
      this.readyWaits.add(fail);
    });
  }

  // ------------------------------------------------------------------------------------
  // Sending
  // ------------------------------------------------------------------------------------

  /**
   * Send one action and return a handle.
   *
   * @throws {MgNotReadyError} before `Welcome`, because the sequence counter is not seeded and the
   *   server would reject every command as `invalid_sequence`. Failing here rather than on the wire is
   *   intentional, since the documented symptom of sending early is a silent failure.
   */
  send(action: string, params: Record<string, unknown> = {}): CommandHandle {
    if (!this.readyState) {
      throw new MgNotReadyError(
        `Cannot send "${action}" before Welcome arrives: the command sequence counter is not seeded, ` +
          'so the server would reject it as invalid_sequence.',
      );
    }

    // Validate the action BEFORE consuming a sequence number. `buildFrame` throws on an unknown
    // action, and taking a number first would leave a gap in the sequence, which the server answers
    // with `invalid_sequence` and then rejects every later command too. Cheap check, real consequence.
    getActionSpec(action);

    const form = this.forms.formOf(action);
    // Only a wrapped action needs a sequence. Taking one lazily keeps flat and room actions from
    // burning numbers they never use.
    const needsSequence = form === 'wrapped';

    // Generate the correlation id here rather than letting `buildFrame` mint one internally, so the
    // ledger and the envelope are guaranteed to agree without a second pass to reconcile them.
    const requestId = randomUuid();
    const sequence = needsSequence ? this.sequencer.take(action, requestId, true) : -1;

    // Typed from `buildFrame`'s own return so the two cannot drift apart.
    let frame: ReturnType<typeof buildFrame>;
    try {
      frame = buildFrame({
        action,
        params,
        registry: this.forms,
        requestId,
        ...(needsSequence ? { commandSequence: sequence } : {}),
      });
    } catch (error) {
      // Nothing reached the wire, so give the number back.
      this.lastErrorValue = toMgError(error, 'client_failure');
      if (needsSequence) this.sequencer.rollback(sequence);
      throw error;
    }

    // `frame` is built by now, so the ping's id is read off the frame that will actually be sent rather
    // than back off `params`, because the wire is the thing the `Pong` will answer.
    const handle = this.createPending(action, requestId, sequence, readPingId(frame));

    try {
      this.transport.send(serializeFrame(frame));
    } catch (error) {
      // Same reasoning: a frame that never left is a gap, not a command. Roll the number back and
      // settle the handle as a transport failure.
      this.lastErrorValue = toMgError(error, 'client_failure');
      if (needsSequence) this.sequencer.rollback(sequence);
      this.settlePending(requestId, {
        action,
        requestId,
        sequence,
        ok: false,
        confirmed: true,
        matchMethod: 'none',
        rejection: interpretRejection(action, 'transport_error'),
      });
      throw error;
    }

    this.logger.trace('sent', { action, form, sequence, requestId });
    return handle;
  }

  /**
   * Send a pre-built frame verbatim, bypassing the action layer.
   *
   * Gated on readiness like {@link send}: a raw frame can be a sequence-bearing `QuinoaCommand`, and one
   * sent before `Welcome` seeds the counter reaches the server as `invalid_sequence`. That refusal is
   * thrown ({@link MgNotReadyError}) and **not** recorded in `lastError`, which reports why the
   * *transport* last failed; that is the rule {@link send} already follows. A transport failure *is* recorded
   * there and re-thrown: this seam's caller must never have a write silently not happen (I8).
   *
   * @throws {MgNotReadyError} before `Welcome`.
   */
  sendRaw(frame: Record<string, unknown>): void {
    if (!this.readyState) {
      throw new MgNotReadyError(
        'Cannot send a raw frame before Welcome arrives: it may carry a command sequence the server ' +
          'has not seeded, and it would be rejected as invalid_sequence.',
      );
    }
    try {
      this.transport.send(serializeFrame(frame));
    } catch (error) {
      this.lastErrorValue = toMgError(error, 'send_failed');
      throw error;
    }
  }

  private createPending(action: string, requestId: string, sequence: number, pingId?: number): CommandHandle {
    const result = new Promise<CommandResult>((resolve, reject) => {
      // The timeout is armed in EVERY ack mode, including `'none'`.
      //
      // `'none'` disables *correlation*, not settlement. A handle whose promise never settles is a
      // footgun, because `await handle` would hang forever, and it leaks the ledger entry. In `'none'` the
      // timeout simply produces an unconfirmed outcome instead of a matched one.
      const timer = setTimeout(() => {
        this.expirePending(requestId);
      }, this.timeouts.commandAckMs);

      const entry: PendingCommand = {
        requestId,
        action,
        sequence,
        resolve,
        reject,
        settle: () => {},
        timer,
        done: false,
      };
      if (pingId !== undefined) entry.pingId = pingId;
      this.pending.set(requestId, entry);

      if (this.ackMode === 'fifo') {
        const queue = this.fifoByAction.get(action) ?? [];
        queue.push(requestId);
        this.fifoByAction.set(action, queue);
      }
    });

    const settled = new Promise<CommandResult | null>((resolve) => {
      const entry = this.pending.get(requestId);
      if (entry) entry.settle = resolve;
      else resolve(null);
    });

    return new CommandHandle(action, requestId, sequence, result, settled);
  }

  /**
   * Settle a pending command.
   *
   * This is the single funnel for settlement, and it settles *both* ledgers: the handle (the caller's
   * promise, `this.pending`) and the sequencer's outstanding entry (the `dropped_stale` inference).
   * Settling only the handle is what reported the same command twice, once as an unconfirmed timeout
   * and once as `dropped_stale`, when a later frontier passed the entry the timeout had left behind,
   * and it left that entry in the sequencer's ledger for the rest of the connection's life. One call
   * site therefore covers the ack path, `expirePending`, `rejectAllPending` and `dropped_stale` alike.
   *
   * The `confirmed` flag is set by the caller's match method, never here; this method only records
   * the outcome.
   */
  private settlePending(requestId: string, result: CommandResult): void {
    const entry = this.pending.get(requestId);
    if (!entry || entry.done) return;
    entry.done = true;
    if (entry.timer !== null) clearTimeout(entry.timer);
    this.pending.delete(requestId);

    // `sequencer.settle` heals the counter for `invalid_sequence`, and a synthesized rejection wants the
    // same treatment, because a failed command is still evidence that the counter gapped.
    const code = result.rejection?.code;
    this.sequencer.settle(
      requestId,
      code === undefined || code === null ? { ok: result.ok } : { ok: result.ok, code },
      this.sequencer.frontier ?? undefined,
    );

    if (this.ackMode === 'fifo') {
      const queue = this.fifoByAction.get(entry.action);
      if (queue) {
        const index = queue.indexOf(requestId);
        if (index >= 0) queue.splice(index, 1);
        if (queue.length === 0) this.fifoByAction.delete(entry.action);
      }
    }

    entry.settle(result);

    if (result.ok) {
      entry.resolve(result);
      return;
    }

    const action = result.action;
    const sequence = result.sequence;
    if (result.rejection) {
      entry.reject(new MgCommandRejectedError(result.rejection, action, requestId));
    } else {
      entry.reject(new MgCommandUnconfirmedError(action, requestId, sequence));
    }
  }

  /** A command aged out without an ack. Report it as unconfirmed, not as failed. */
  private expirePending(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (!entry || entry.done) return;
    this.settlePending(requestId, {
      action: entry.action,
      requestId,
      sequence: entry.sequence,
      ok: false,
      confirmed: false,
      matchMethod: this.ackMode === 'none' ? 'none' : 'fifo',
    });
  }

  private rejectAllPending(reason: string): void {
    for (const requestId of [...this.pending.keys()]) {
      const entry = this.pending.get(requestId);
      if (!entry) continue;
      this.settlePending(requestId, {
        action: entry.action,
        requestId,
        sequence: entry.sequence,
        ok: false,
        confirmed: false,
        matchMethod: 'none',
        rejection: {
          code: null,
          commandType: entry.action,
          isUnknownCommandType: false,
          requiresSequenceResync: false,
          suggestsWrongForm: false,
          message: `Command abandoned: ${reason}.`,
        },
      });
    }
    this.fifoByAction.clear();
  }

  // ------------------------------------------------------------------------------------
  // Inbound
  // ------------------------------------------------------------------------------------

  /**
   * Handle one raw inbound frame.
   *
   * Never throws: an unparseable frame is reported as an event and dropped, and a frame over the byte
   * cap is refused before it is parsed or retained. A wrapper that dies on one odd message is worse than
   * one that logs it.
   *
   * A frame that arrives after the session closed is dropped before it is parsed: the close is permanent
   * for this core ({@link closed}), and a late `Welcome` must not re-open a session that has ended.
   */
  private handleRawFrame(raw: string): void {
    if (this.closed) {
      this.logger.debug('inbound frame after close; dropped', { bytes: raw.length });
      return;
    }

    const parsed = parseFrame(raw);

    switch (parsed.kind) {
      case 'empty':
        return;
      case 'keepalive':
        if (this.autoHandledKeepalive) this.transport.send('pong');
        return;
      case 'oversized':
        // No `raw` in either the log or the event: holding that frame is what we refuse to do.
        //
        // The log field is `atLeastBytes`, not `bytes`, because the value is the offset at which the cap was
        // first exceeded, a lower bound on the frame's size rather than its size (see the `oversizedFrame`
        // type). It was labelled `bytes` here, under a message that reads as an exact measurement, which is a
        // diagnostic that lies in the direction of sounding precise. The event keeps its documented `bytes`.
        this.logger.warn('inbound frame over the cap; dropped unparsed', {
          atLeastBytes: parsed.bytes,
          limit: parsed.limit,
        });
        this.emit('oversizedFrame', { bytes: parsed.bytes, limit: parsed.limit });
        return;
      case 'unparsed':
        this.logger.debug('unparsed frame', { raw: raw.slice(0, 200) });
        this.emit('unparsed', { raw });
        return;
      case 'message':
        break;
    }

    if (!parsed.isKnown) {
      const unknown = parsed.message as { type: string; raw: Record<string, unknown> };
      this.emit('unknownMessage', { type: unknown.type, raw: unknown.raw });
      return;
    }

    const message = parsed.message;

    switch (message.type) {
      case 'Welcome':
        this.handleWelcome(message as WelcomeMessage);
        return;
      case 'PartialState':
      case 'RoomFrame': {
        this.handleStateFrame(message);
        return;
      }
      case 'QuinoaCommandResult':
        this.handleCommandResult(message as QuinoaCommandResultMessage);
        return;
      case 'Pong':
        this.handlePong(message as PongMessage);
        return;
      default:
        return;
    }
  }

  /**
   * Settle the `Ping` this `Pong` answers.
   *
   * A `Ping` is `flat`, so it never enters the `QuinoaCommand` envelope and the server never echoes our
   * `requestId`; the reply is a direct `Pong` carrying the `id` we put on the frame. That id is the
   * correlation, and it is the *only* one, so {@link PendingCommand.pingId} exists.
   *
   * A `Pong` whose id matches nothing is dropped rather than guessed at: settling another pending ping
   * would report one that was never answered as confirmed. A `Pong` with no `id` at all is the one case
   * with no evidence either way, and when exactly one ping is outstanding the server can only have been
   * answering that one; with several outstanding it is left to the ack deadline.
   *
   * `matchMethod: 'requestId'` names *which* correlation was used rather than the literal field it came
   * from: this is proof, not the ordering guess `'fifo'` describes, so `confirmed` is true.
   *
   * `'none'` disables this path with every other correlation, as {@link handleCommandResult} does: no
   * inbound frame settles a handle, so the ping is left to its ack deadline.
   */
  private handlePong(message: PongMessage): void {
    if (this.ackMode === 'none') {
      this.logger.debug('pong ignored (ackMode none)', { id: message.id });
      return;
    }

    const waiting = [...this.pending.values()].filter((entry) => entry.action === 'Ping');
    if (waiting.length === 0) {
      this.logger.debug('Pong with no ping outstanding');
      return;
    }

    let matched: PendingCommand | undefined;
    if (message.id !== undefined) {
      matched = waiting.find((entry) => entry.pingId === message.id);
    } else if (waiting.length === 1) {
      matched = waiting[0];
    }

    if (!matched) {
      this.logger.debug('Pong did not match any outstanding ping', {
        id: message.id,
        outstanding: waiting.length,
      });
      return;
    }

    this.logger.debug('pong', { requestId: matched.requestId, id: message.id });
    this.settlePending(matched.requestId, {
      action: matched.action,
      requestId: matched.requestId,
      sequence: matched.sequence,
      ok: true,
      confirmed: true,
      matchMethod: 'requestId',
      raw: message,
    });
  }

  private handleWelcome(message: WelcomeMessage): void {
    this.welcomeValue = message;
    if (typeof message.selfPlayerId === 'string') {
      this.selfPlayerIdValue = message.selfPlayerId;
      // The reader resolves `state.self` from this, so keep it in step with the accessor.
      this.state.selfPlayerId = message.selfPlayerId;
    }
    // The game anchors its own clock here, from the one message guaranteed to carry a server
    // timestamp. Crop timings are compared against that clock, never against `Date.now()`.
    this.state.anchorClock(message['publishedAtServerMs']);

    // `isReady` means "the sequencer is seeded", not merely "a Welcome arrived". A Welcome whose
    // `executedCommandSequence` is missing or non-canonical seeds nothing on its own, so it must not open
    // the gate: the old `typeof === 'number'` test let `2.5` seed the counter to `3.5` and put an illegal
    // sequence on the wire. Two canonical sources can still seed it: the Welcome's own frontier, else a
    // configured frontier reader (the bootstrapped attachment's), which is evidence for the same fact and
    // is consulted before every stamp anyway. A non-canonical reader value is refused just as firmly, so
    // neither source can smuggle a fractional counter in.
    const frontier = message.executedCommandSequence;
    const seed = asSequence(frontier) ?? asSequence(this.getFrontierOption?.());
    if (seed !== null) {
      this.sequencer.seed(seed);
    } else {
      this.logger.warn('Welcome carried no canonical executedCommandSequence', {
        received: frontier === undefined ? 'undefined' : typeof frontier,
      });
    }

    const fullState = message.fullState as FullState | undefined;
    const root =
      fullState && typeof fullState === 'object'
        ? { ...fullState, data: fullState.data ?? {}, child: fullState.child ?? { data: {} } }
        : emptyStateTree();

    const change = this.store.replaceRoot(root);

    this.readyState = seed !== null;
    this.logger.info('welcome', {
      selfPlayerId: this.selfPlayerIdValue,
      executedCommandSequence: message.executedCommandSequence,
    });

    this.emit('welcome', message);
    this.emit('state', change);
    if (seed !== null) this.emit('ready');
  }

  private handleStateFrame(message: InboundMessage): void {
    // Every frame carries a server timestamp, and the game re-anchors its clock on each one. Doing the
    // same keeps `state.now()` ahead of clock drift over a long session, which matters because crop
    // timings are compared against it rather than against the local clock.
    const clocked = message as { publishedAtServerMs?: unknown };
    this.state.observeClock(clocked.publishedAtServerMs);

    const frontier = extractFrontier(message);
    let dropped: ReturnType<CommandSequencer['observeFrontier']>['dropped'] = [];
    if (frontier !== null) {
      dropped = this.sequencer.observeFrontier(frontier).dropped;
    }

    // Fallback for a `Welcome` that carried no canonical frontier: the gate is still shut, and the first
    // state frame that supplies one seeds the counter and readies the client. `observeFrontier` applies
    // the canonical rule to the counter *and* to the ledger, so a fractional frame frontier can neither
    // open this gate nor fail a live command as stale.
    if (!this.readyState && this.sequencer.frontier !== null) {
      this.readyState = true;
      this.emit('ready');
    }

    for (const entry of dropped) {
      this.logger.warn('command dropped as stale', {
        action: entry.action,
        sequence: entry.sequence,
      });
      this.emit('droppedStale', {
        action: entry.action,
        sequence: entry.sequence,
        requestId: entry.requestId,
      });
      this.settlePending(entry.requestId, {
        action: entry.action,
        requestId: entry.requestId,
        sequence: entry.sequence,
        ok: false,
        confirmed: true,
        matchMethod: 'frontier',
        rejection: interpretRejection(entry.action, 'dropped_stale'),
      });
    }

    const patches = extractPatches(message);
    if (patches.length === 0) return;

    const { result, change } = this.store.applyPatches(patches);
    if (!result.ok) {
      this.logger.debug('some patches failed to apply', {
        failed: result.failed,
        outcomes: result.outcomes.filter((outcome) => !outcome.ok),
      });
    }
    if (result.tolerated.length > 0) {
      this.logger.warn('patch paths needed a /child tolerance fallback', {
        count: result.tolerated.length,
        sample: result.tolerated.slice(0, 3),
      });
    }

    this.emit('partialState', { patches, message });
    this.emit('state', change);
  }

  private handleCommandResult(message: QuinoaCommandResultMessage): void {
    const commandType = typeof message.commandType === 'string' ? message.commandType : 'unknown';
    const echoedRequestId = typeof message.requestId === 'string' ? message.requestId : undefined;

    // `'none'` means exactly that: never correlate. Even an echoed requestId is ignored, because the
    // caller opted out of correlation entirely. Handles still settle from the frontier ledger or the
    // timeout, so nothing hangs.
    if (this.ackMode === 'none') {
      this.logger.debug('command result ignored (ackMode none)', {
        commandType,
        ok: message.ok,
      });
      return;
    }

    // `commandType: "unknown"` means the server could not parse our action. We cannot match it to a
    // specific request, so it is reported against the oldest pending command of any kind.
    let matched: PendingCommand | undefined;
    let matchMethod: CommandResult['matchMethod'] = 'none';

    if (echoedRequestId && this.pending.has(echoedRequestId)) {
      matched = this.pending.get(echoedRequestId);
      matchMethod = 'requestId';
    } else if (this.ackMode === 'fifo') {
      const queue = this.fifoByAction.get(commandType);
      if (queue && queue.length > 0) {
        const nextId = queue[0] as string;
        matched = this.pending.get(nextId);
        matchMethod = 'fifo';
      } else if (commandType === 'unknown') {
        // The server rejected something it could not name; attribute it to the oldest pending command.
        const oldest = [...this.pending.values()].sort((a, b) => a.sequence - b.sequence)[0];
        if (oldest) {
          matched = oldest;
          matchMethod = 'fifo';
        }
      }
    }

    if (!matched) {
      this.logger.debug('command result with no matching pending command', {
        commandType,
        ok: message.ok,
        code: message.code,
      });
      return;
    }

    const rejection = message.ok
      ? undefined
      : interpretRejection(matched.action === commandType ? commandType : matched.action, message.code);

    const result: CommandResult = {
      action: matched.action,
      requestId: matched.requestId,
      sequence: matched.sequence,
      ok: Boolean(message.ok),
      confirmed: matchMethod === 'requestId',
      matchMethod,
      raw: message,
    };
    if (rejection) result.rejection = rejection;

    this.logger.debug('command result', {
      action: matched.action,
      ok: message.ok,
      code: message.code,
      matchMethod,
    });

    this.emit('commandResult', { result, message });
    this.settlePending(matched.requestId, result);

    // If the server rejected the action as unparseable, it is worth surfacing the likely cause.
    if (rejection?.suggestsWrongForm) {
      this.logger.warn(
        `"${matched.action}" may be using the wrong form; try FormRegistry.setActionForm("${matched.action}", "wrapped").`,
      );
    }
  }

  /** Synthesize a failure result; exported for clients that need to inject a rejection. */
  static rejectionResult(action: string, requestId: string, sequence: number, code: string): CommandResult {
    return failureResult(action, requestId, sequence, interpretRejection(action, code));
  }
}
