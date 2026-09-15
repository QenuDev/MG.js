/**
 * `BootstrappedClient`: the in-page client, assembled.
 *
 * ## What this class is
 *
 * It is the composition point. Everything it does is delegated: the realm bridge to `page/`, the socket
 * attachment to `attach/`, the protocol to `@mg.js/common`'s `ClientCore`, the render layer to `render/`, the
 * atom bridge to `jotai/bridge.ts`, the catalogue to `live-catalog/object-keys-source.ts`, and coexistence to
 * `coexistence/`. This file's job is to wire those together in the one order that works and to expose one
 * object a mod can hold.
 *
 * ## The five configuration decisions, and why each one is what it is
 *
 *   1. **`autoHandledKeepalive: false`.** The host game answers the bare-string keepalive on its own socket.
 *      If we answered it too the server would see two pongs per ping, and the *game* would be
 *      the one whose liveness check we were impersonating. The option exists for this case: its own
 *      docstring says headless passes `false` "and the bootstrapped transport must not, because the host game
 *      answers it."
 *
 *   2. **`getFrontier`.** Supplying a frontier reader is how the shared core is told to build a
 *      `FrontierAnchoredStrategy` rather than a `MonotonicStrategy`, because `ClientCore`'s constructor
 *      checks `options.getFrontier` and, when present, constructs `new CommandSequencer({ getFrontier })`,
 *      whose own constructor swaps in the frontier-anchored strategy. That is the sequencing policy a socket
 *      shared with the game requires (see `coexistence/renumber.ts`).
 *
 *   3. **`ackMode: 'fifo'`** (the default, stated explicitly here so it is visible). The protocol's result
 *      payload carries no `requestId` in the documented build, so `'strict'` would settle nothing and `'none'`
 *      would throw away the correlation the server does give. `'fifo'` matches by action and order and flags
 *      every result `confirmed: false`, which is honest about what it knows.
 *
 *   4. **`kind: 'attached'`,** enforced by {@link AttachedTransport}: no reconnect logic, no `close()` on the
 *      host's socket, and every inbound frame delivered non-exclusively.
 *
 *   5. **Renumbering installed as the outbound rewriter,** not as a second hook. The transport sends *through*
 *      the game's send path, so one hook on that path covers our frames and the game's alike: one chooser.
 *
 * ## `start()` is idempotent and cross-realm safe
 *
 * Two copies of this bundle can be in one page (the userscript plus a mod that imports the library). Each has
 * its own module instance, so a module-scoped flag would be `false` in both. The registry in `page/namespace.ts` lives
 * on the *page*, so the second `start()` sees the first one's claim, increments the refcount, and reuses the
 * installed hooks (`claimInstall`). `stop()` decrements and only tears down at zero.
 */

import type {
  CatalogSource,
  ClientCoreOptions,
  ClientEvents,
  Emitter,
  Logger,
  MgError,
  MgErrorSummary,
  ObservableStore,
  StateChange,
  Unsubscribe,
  WelcomeMessage,
} from '@mg.js/common';
import {
  CatalogClient,
  ClientCore,
  ConsoleLogSink,
  createLogger,
  MgTransportError,
  PlatformApiSource,
  extractFrontier as readWelcomeFrontier,
  SOURCE_FAILURE_CODE,
  summarizeError,
  toMgError,
} from '@mg.js/common';
import { AttachedTransport } from './attach/attached-transport.js';
import type { Attachment, AttachmentReport } from './attach/detect.js';
// Aliased because the client's own method takes the contract's name (`waitForAttachment`): an unqualified
// module call inside that method would read like recursion to anyone skimming it.
import {
  waitForAttachment as attachToHost,
  createEmptySink,
  watchForRoomConnection,
} from './attach/detect.js';
import { BUNDLE_VERSION } from './build-info.js';
import { attemptTeardown } from './coexistence/brand.js';
import { asEnvelope, parseEnvelope } from './coexistence/envelope.js';
import { applyRenumbering, Renumberer } from './coexistence/renumber.js';
import type { AttachmentFacts, BootstrappedReport, BootstrapReport } from './diagnostics.js';
import { buildDetail, buildReport, errorSummaries, resolveAttachmentReport } from './diagnostics.js';
import { JotaiBridge } from './jotai/bridge.js';
import type { BundleCaptureHandle } from './live-catalog/object-keys-source.js';
import { captureCatalogBundle } from './live-catalog/object-keys-source.js';
import type { getNamespace } from './page/namespace.js';
import {
  claimInstall,
  deleteNamespace,
  emitNamespaceEvent,
  peekNamespace,
  releaseInstall,
} from './page/namespace.js';
import type { PageRealm } from './page/realm.js';
import { getPage, hasPage, requirePage } from './page/realm.js';
import type { RenderFacade } from './render/facade.js';
import { createRenderFacade } from './render/facade.js';
import type { PixiCaptureHandle } from './render/pixi.js';
import { PixiStage } from './render/pixi.js';
import { probeStorage } from './storage/backends.js';
import type { TypedStorage } from './storage/typed.js';
import { createStorage } from './storage/typed.js';
import type { StorageOptions } from './storage/types.js';

/** Options for {@link BootstrappedClient}. */
export interface BootstrappedClientOptions {
  /** Log sink. Defaults to the console. */
  logger?: Logger;
  /** Storage overrides. */
  storage?: StorageOptions;
  /** How long to wait for the game to expose a connection. Default 20000 ms. */
  attachTimeoutMs?: number;
  /** Force an attachment path. `'none'` starts the client detached, useful for tests and read-only mods. */
  forceAttachment?: AttachmentReport['kind'];
  /**
   * How long to keep watching for `MagicCircle_RoomConnection` after attaching to the raw socket, in ms.
   *
   * Default `90_000`. `0` disables the watch; use it for a strictly passive observer that wants no
   * room-object hooks. Ignored when {@link forceAttachment} is set, because an explicit choice
   * is not second-guessed.
   */
  roomUpgradeTimeoutMs?: number;
  /** Poll interval for the upgrade watch, in ms. Default `500`. */
  roomUpgradeIntervalMs?: number;
  /** The room-socket URL filter for the fallback path. */
  urlFilter?: string;
  /**
   * Which built-in features to install. Every feature is on by default; set one to `false` to skip it.
   *
   * One positive switch per feature, replacing the five negative `disableX` flags (Phase 4.5). The class's
   * own {@link BootstrapReport} reports the same five positively (`render: { enabled }`, ...), so a caller
   * reading the report and a caller writing the options now speak one polarity.
   */
  features?: BootstrappedFeatures;
  /** A page realm override, for tests. */
  page?: PageRealm;
  /** Notified whenever the renderer is recreated (WebGL context loss). */
  onRendererRecreated?: () => void;
}

/**
 * The built-in features {@link BootstrappedClient} can install, each on by default.
 *
 * `undefined` means "install it"; only an explicit `false` skips it. The defaults are stated per field
 * because they are not uniform in *effect*: a skipped feature is simply absent, but `platformCatalog`
 * makes a network request of its own, which is the one a caller most often wants to turn off.
 */
export interface BootstrappedFeatures {
  /**
   * Install the outbound renumbering hook. Default **on**. A mod that sends commands must never be off
   * by accident, so only an explicitly passive observer should turn it off.
   */
  renumbering?: boolean;
  /** Install the jotai bridge. Default **on**. */
  jotai?: boolean;
  /** Install the catalogue capture hook. Default **on**. */
  catalog?: boolean;
  /**
   * Include the live platform-API catalogue source. Default **on**, because shops and weather exist
   * *only* there: the developers moved them off the socket onto `/platform/v1/*`. Turn it off for a mod
   * that must make no network requests of its own.
   */
  platformCatalog?: boolean;
  /** Install the Pixi init-hook capture. Default **on**. */
  render?: boolean;
}

export type { BootstrappedReport, BootstrapReport } from './diagnostics.js';
export type { RenderFacade } from './render/facade.js';

/**
 * The client.
 *
 * Constructed synchronously (so a mod can hold it immediately) but **started and attached**
 * asynchronously. See {@link BootstrappedClient.waitForAttachment}. That split is forced by
 * `@run-at document-start`: at construction the game has created nothing, so an attachment cannot be made
 * yet, but a mod's module-level code wants an object now.
 */
export class BootstrappedClient {
  /**
   * The shared protocol core.
   *
   * Replaced by {@link start} after a {@link stop}: `ClientCore.stop()` is one-way (it releases the
   * transport subscription made in the constructor, and `start()` refuses), so a restart has to build a
   * new core rather than revive the old one.
   */
  private coreValue: ClientCore;
  /**
   * The attached transport.
   *
   * Replaced alongside the core. `AttachedTransport.close()` latches `closed`, after which `attachSink()`
   * refuses forever, so a restart needs a fresh transport as much as a fresh core.
   */
  private transportValue: AttachedTransport;
  /** The renumbering state machine, whether or not its hook is installed. */
  readonly renumberer: Renumberer;
  /** Persistence. */
  readonly storage: TypedStorage;

  /**
   * The jotai bridge, or `null` when disabled or after a `stop()` released it.
   *
   * Mutable like `coreValue`/`transportValue`: `release()` is one-way (it takes the page hook out and
   * `JotaiBridge` has no reinstall), so a restart must build a fresh bridge, not hand back the released
   * one. A released bridge must not stay reachable through {@link jotai}.
   */
  private jotaiValue: JotaiBridge | null;

  /** The jotai bridge, or `null` when disabled or after a `stop()` has released it. */
  get jotai(): JotaiBridge | null {
    return this.jotaiValue;
  }

  /** The shared protocol core. See {@link coreValue} for why it is replaced on a restart. */
  get core(): ClientCore {
    return this.coreValue;
  }

  /** The attached transport. See {@link transportValue} for why it is replaced on a restart. */
  get transport(): AttachedTransport {
    return this.transportValue;
  }

  private readonly logger: Logger;
  private readonly options: BootstrappedClientOptions;
  private readonly page: PageRealm | null;
  private readonly detachers: Unsubscribe[] = [];

  private attachment: Attachment | null = null;
  private attachmentPromise: Promise<Attachment> | null = null;
  /**
   * The most recent failure of this client's *own* wiring, as a typed {@link MgError}, or `null`.
   *
   * {@link lastError} used to be the core's error and nothing else. A sink the transport refuses is not a
   * core failure (the core never saw a frame), so it had nowhere honest to go and was discarded; the
   * client then reported a healthy attachment over a transport with nothing wired to receive frames. This
   * slot is the other half of {@link lastError} and is the reason that accessor is no longer a pure
   * passthrough. Cleared on a fresh {@link start}, like the core's own error.
   */
  private attachErrorValue: MgError | null = null;
  /** Cancels the room-connection upgrade watch, once one is running. */
  private roomUpgradeStop: (() => void) | null = null;
  /**
   * A binding kept alive past an upgrade because it owns the outbound renumbering seam.
   *
   * See {@link upgradeAttachment}: when the socket path attached first, its hook is the only seam that sees
   * every outbound frame, so it outlives the observation switch and must be released at teardown.
   */
  private sendSeam: Attachment | null = null;
  private catalogHandle: BundleCaptureHandle | null = null;
  private captureHandle: PixiCaptureHandle | null = null;
  private ownsClaim = false;
  private installed = false;
  private uninstalled = false;
  /** The five built-in features, resolved once so every read states the same (positive) polarity. */
  private readonly features: Required<BootstrappedFeatures>;

  /** The render facade is created once, up front, so `client.render.stage` is usable before attachment. */
  readonly render: RenderFacade;

  constructor(options: BootstrappedClientOptions = {}) {
    this.options = options;
    this.features = {
      renumbering: options.features?.renumbering !== false,
      jotai: options.features?.jotai !== false,
      catalog: options.features?.catalog !== false,
      platformCatalog: options.features?.platformCatalog !== false,
      render: options.features?.render !== false,
    };
    this.page = options.page ?? getPage();
    this.logger =
      options.logger ?? createLogger({ sink: new ConsoleLogSink(), level: 'info', namespace: 'mg.js' });

    this.storage = createStorage({
      ...(options.storage ?? {}),
      ...(this.page !== null ? { page: this.page } : {}),
    });
    this.renumberer = new Renumberer({ label: 'bootstrapped' });
    const session = this.createSession();
    this.transportValue = session.transport;
    this.coreValue = session.core;

    this.jotaiValue = this.features.jotai
      ? new JotaiBridge(this.page !== null ? { page: this.page } : {})
      : null;

    // Thunks, not values: the capture handle is installed by `start()` and the jotai bridge is released on
    // `stop()`, both long after this line runs. See `render/facade.ts`.
    this.render = createRenderFacade({
      captureHandle: () => this.captureHandle,
      jotai: () => this.jotai,
    });
  }

  /**
   * Build the transport + core pair that makes one session live.
   *
   * Called from the constructor, and again from {@link start} after a {@link stop}. A restart has to build
   * a fresh pair because both halves are one-way: `ClientCore.stop()` releases the transport listeners it
   * made in its constructor and `start()` then refuses, and `AttachedTransport.close()` latches `closed`,
   * after which `attachSink()` refuses forever. Reviving either object is impossible by construction.
   *
   * `store`, when supplied, is the previous core's store, carried across so a caller who cached
   * `const store = client.store` keeps receiving patches. `ClientCore.stop()` documents that rule.
   */
  private createSession(store?: ObservableStore): { transport: AttachedTransport; core: ClientCore } {
    // The transport starts over an empty sink and is re-pointed at the real one when attachment succeeds.
    // `ClientCore` takes its transport in the constructor and has no way to swap it later, so it must be
    // built here, next to the core it belongs to.
    // An empty sink, not `null`, so `ClientCore` can be constructed before the game has created anything:
    // `state` derives from `sink.canSend()`, so this is what makes the pre-attachment state honestly
    // `'connecting'` rather than optimistically `'open'`. See `createEmptySink`.
    const transport = new AttachedTransport({ sink: createEmptySink(), endpoint: 'attached:pending' });

    const core = new ClientCore({
      transport,
      logger: this.logger,
      ackMode: 'fifo',
      // (2) A frontier reader is how the core is told to build a FrontierAnchoredStrategy.
      getFrontier: () => this.readFrontier(),
      // (1) The host game answers the keepalive; we must not.
      autoHandledKeepalive: false,
      ...(store !== undefined ? { store } : {}),
    } satisfies ClientCoreOptions);

    return { transport, core };
  }

  /**
   * Subscribe the client's own listeners on the core's emitter.
   *
   * Called from {@link start} rather than the constructor, and that placement is required: `stop()`
   * goes through `core.stop()`, which releases *every* listener on that emitter (its own teardown rule),
   * and `this.detachers` is spliced with it. Registering once in the constructor would therefore leave a
   * restarted client silently deaf: it would keep attaching, keep renumbering and log nothing. Wiring on
   * every `start()` keeps the pair symmetric, and the `detachers` list is what makes it non-accumulating:
   * a second `start()` after a `stop()` starts from an empty list.
   */
  private wireCoreListeners(): void {
    this.detachers.push(
      this.core.on('welcome', (message: WelcomeMessage) => {
        // Seed both counters from the same fact, so they cannot disagree about where the session started.
        const frontier = readWelcomeFrontier(message);
        if (frontier !== null) {
          this.renumberer.observeFrontier(frontier);
          this.logger.debug('sequencer seeded from Welcome', { executedCommandSequence: frontier });
        }
      }),
    );
    this.detachers.push(
      this.core.on('state', (change: StateChange) => {
        this.logger.trace('state change', { version: change.version, paths: change.changedPaths.length });
      }),
    );
  }

  // ------------------------------------------------------------------------------------
  // Accessors mirroring ClientCore, so a mod only needs one object
  // ------------------------------------------------------------------------------------

  /** The game's typed action surface: `actions.harvestCrop(...)`, and so on. */
  get actions(): ClientCore['actions'] {
    return this.core.actions;
  }

  /** The live state store. */
  get store(): ClientCore['store'] {
    return this.core.store;
  }

  /** Named reads over the store: `state.self?.garden`, `state.room.players`, `state.room.chat`. */
  get state(): ClientCore['state'] {
    return this.core.state;
  }

  /** Room state: players, chat, host. */
  get room(): unknown {
    return this.core.room;
  }

  /** Game state: garden, inventory, shops, weather. */
  get game(): unknown {
    return this.core.game;
  }

  /** The server-assigned player id, or `null` while the session has not revealed it. */
  get selfPlayerId(): string | null {
    // Read-time fallback, not only a welcome-time one. The id becomes knowable *after* the
    // welcome that announced the session, because the socket seam learns it by scraping the wire, and the
    // game's own welcome may have fired before this client existed. Resolving once, at welcome time, would
    // miss it and leave the badge reading `ready · no id` forever. See `resolveSelfPlayerId`.
    return this.core.selfPlayerId ?? this.resolveSelfPlayerId();
  }

  /** True once `Welcome` has arrived and commands may be sent. */
  get isReady(): boolean {
    return this.core.isReady;
  }

  /**
   * The catalogue client, over whatever sources were recovered, or `null` when disabled or released.
   *
   * Mutable like `jotaiValue`: the sources read the bundle capture, and `stop()` disposes that capture,
   * so the client left behind is one over a corpse: it still answers `sourceIds` and still resolves
   * `load()`, which makes it a silent failure rather than an inert one. `start()` rebuilds the
   * capture and the client together, so a restart gets a live catalogue rather than the released one.
   */
  get catalog(): CatalogClient | null {
    return this.catalogClient;
  }

  private catalogClient: CatalogClient | null = null;

  /** Which attachment path won, or `null` before {@link waitForAttachment} resolves. */
  get attachmentKind(): AttachmentReport['kind'] | null {
    return this.attachment?.kind ?? null;
  }

  /**
   * The full attachment report, or `null` before {@link waitForAttachment} resolves.
   *
   * The same resolved value `report.detail.attachment` carries; this is the nullable view of it, kept
   * because a caller that has to tell "no attachment yet" from "attached with nothing found" reads this
   * one, while the report's own `attachment` slot always carries a shape (a `kind: 'none'` placeholder
   * before the first attempt). Both go through {@link resolveAttachmentReport}, so they cannot disagree.
   *
   * Two fields are resolved against the *live* bindings rather than the stored snapshot, because both were
   * observed lying on a real session:
   *
   *   - `renumberingInstalled`: after an upgrade the rewriter stays on the retained socket seam, so the
   *     room binding's own report says `false` while renumbering is in fact active. The badge showed
   *     `renumbering: false` on a session that was numbering frames.
   *   - `socketsSeen`: a sample taken when the report was built, which is before the game has opened its
   *     socket; and after an upgrade the counter lives on the retained seam, not on the room binding.
   *
   * A diagnostic that reports `0` or `false` while the thing it describes is provably happening is worse
   * than no diagnostic, because it sends the reader looking in the wrong place.
   */
  get attachmentReport(): AttachmentReport | null {
    return this.resolveAttachmentReport();
  }

  /** The live-resolved attachment snapshot, shared by {@link attachmentReport} and {@link report}. */
  private resolveAttachmentReport(): AttachmentReport | null {
    return resolveAttachmentReport(toAttachmentFacts(this.attachment), toAttachmentFacts(this.sendSeam));
  }

  /**
   * One JSON-safe snapshot: the contract's axes, plus the page-shaped diagnostic as `detail`.
   *
   * BREAKING (4.4): this used to be a *method* of the same name, so `client.report()` is now a
   * `ClientReport`, not a `BootstrapReport`. The old payload is `client.report.detail`.
   */
  get report(): BootstrappedReport {
    return buildReport(
      {
        started: this.isInstalled,
        ready: this.core.isReady,
        // Read from the same accessor the caller uses, so the report and `selfPlayerId` cannot disagree (I6).
        selfPlayerId: this.selfPlayerId,
        attachmentKind: this.attachmentKind,
        socketsSeen: this.attachment?.report.socketsSeen ?? 0,
        renumberingInstalled: this.resolveAttachmentReport()?.renumberingInstalled === true,
        version: this.core.report.version,
        // The same failure `lastError` reports, listed first, so the diagnostic surface and the accessor
        // cannot disagree about the most recent failure (I6).
        errors: this.errorSummaries(),
      },
      this.buildDetail(),
    );
  }

  /**
   * Every failure this client can report, most recent first: its own wiring error (when there is one) and
   * then whatever the core recorded. `report.errors` and {@link lastError} read the same two slots.
   */
  private errorSummaries(): MgErrorSummary[] {
    return errorSummaries(this.attachErrorValue, this.core.report.errors);
  }

  /** The page-shaped snapshot: the body the pre-4.4 `report()` method had, unchanged in content. */
  private buildDetail(): BootstrapReport {
    const ctors = PixiStage.tryGetCtors();
    return buildDetail({
      // The resolved snapshot, not `this.attachment?.report`: the stored one goes stale on an upgrade.
      attachment: this.resolveAttachmentReport(),
      ctorsRecovered: ctors !== null,
      render: {
        enabled: this.captureHandle !== null,
        initFired: this.captureHandle?.active === true || PixiStage.stage !== null,
      },
      jotai: {
        enabled: this.jotai !== null,
        atomsSeen: this.jotai?.atomCount ?? 0,
        setCaptured: this.jotai?.ready === true,
      },
      catalog: {
        enabled: this.catalogHandle !== null,
        tables: this.catalogHandle === null ? [] : [...this.catalogHandle.capture.tables.keys()],
      },
      renumbering: {
        enabled: this.attachment?.report.renumberingInstalled === true,
        owns: this.renumberer.owns,
        highestSeen: this.renumberer.highest,
      },
      storage: {
        backend: this.storage.backend,
        durable: this.storage.durable,
        roundTrips: probeStorage(this.storage),
      },
      hasPage: this.page !== null,
    });
  }

  /**
   * The lifecycle events, addressed exactly as every other client addresses them.
   *
   * Zero-copy: this *is* the shared core's emitter. The core already emits `open`, `ready`, `close`,
   * `welcome`, `state` and the rest, so a second bus would be a second thing to keep in step, and before
   * 4.4 a mod had to reach through `client.core.on` to hear any of it. The client adds no events of its own;
   * `attached` and `attachment-upgraded` are namespace events (`page/namespace.ts`), not core events.
   */
  get events(): Emitter<ClientEvents> {
    return this.core;
  }

  /**
   * The most recent failure, as the shared {@link MgError}, or `null`.
   *
   * Two sources, most recent first: this client's own wiring failure (a sink the transport refused, see
   * {@link attachErrorValue}) outranks the core's transport failure, because it is the newer one and the
   * one that explains why no frame ever reached the core. Until 4.5's attach-refusal fix this delegated
   * straight to `this.core.lastError`, and a bootstrapped-side failure had nowhere to be seen.
   */
  get lastError(): MgError | null {
    return this.attachErrorValue ?? this.core.lastError;
  }

  /** Whether {@link start} has run and {@link stop} has not. */
  get isInstalled(): boolean {
    return this.installed && !this.uninstalled;
  }

  // ------------------------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------------------------

  /**
   * Start the client: claim the page hooks, wire the core, begin attaching.
   *
   * Idempotent, and cross-realm safe: the claim lives in `page/namespace.ts`'s page-scoped namespace, so a second
   * load reuses the hooks rather than double-starting them. A second call is a no-op that resolves.
   *
   * Asynchronous for one reason: the page check is a *rejection* rather than a synchronous throw, so the
   * userscript's startup can report it on a promise instead of around a `try`. Nothing in the body awaits
   * before the hooks are taken, so `start()` has taken them by the time its promise settles.
   *
   * `installed` is set **after** the last fallible step, so a `start()` that throws part-way does not
   * report itself as started (`report.started` is `false`, and a retry is possible).
   *
   * A start after a stop is a real restart: the previous core was stopped and its transport closed, so a
   * fresh pair is built here (see {@link createSession}) and the caller's store survives it. Every other
   * one-way resource is rebuilt with it: the Pixi capture and the catalogue below, and the jotai bridge,
   * which `stop()` released and cleared.
   */
  async start(): Promise<void> {
    if (this.installed) return;
    // A fresh start has not failed yet: the core carrying the previous session's error is replaced below,
    // and this client's own attach error must not outlive the session it described. `lastError` is "the
    // most recent failure", not "a failure that ever happened".
    this.attachErrorValue = null;
    // A previous `stop()` latched `uninstalled` *and* left a stopped core behind. Rebuild the session
    // before clearing the latch: the core and transport are one-way, so without this the restart would
    // re-attach to the page and then never become ready. The store is carried over, so a caller holding
    // `client.store` keeps its subscriptions across the restart.
    if (this.uninstalled) {
      const session = this.createSession(this.coreValue.store);
      this.transportValue = session.transport;
      this.coreValue = session.core;
      // One-way like the core: `stop()` released the page hook and cleared the field, so a restart must
      // build a fresh bridge or `report.detail.jotai` advertises one the client does not have.
      if (this.features.jotai) {
        this.jotaiValue = new JotaiBridge(this.page !== null ? { page: this.page } : {});
      }
    }
    // The claim below is a new one: the teardown that releases it has to be allowed to run. Left set, it
    // makes the next `stop()` a no-op, so the namespace `claimInstall` just created stays on the page with
    // nobody left to remove it.
    this.uninstalled = false;

    this.ownsClaim = true;
    const page = this.page ?? requirePage();
    const outcome = claimInstall(page);

    // Every step from here to `installed = true` runs with a claim held, and any of them can throw: a logger
    // that fails, a hostile page during the Pixi capture, a bundle capture that rejects. The claim has to go
    // back if one does. `start()`'s re-entry guard is `if (this.installed) return` and `installed` is still
    // false at that point, so without this a *retry* claims a second time while `stop()` releases exactly
    // one. N failed starts therefore leave N-1 claims, and the namespace outlives the client that made them.
    try {
      this.wireCoreListeners();
      this.logger.info('mg.js starting', {
        outcome,
        version: BUNDLE_VERSION,
        storage: this.storage.backend,
        storageDurable: this.storage.durable,
        page: hasPage(),
      });

      if (!probeStorage(this.storage)) {
        this.logger.warn('storage did not round-trip; settings will not persist', {
          backend: this.storage.backend,
        });
      }

      // The catalogue hook must be installed as early as possible: it can only see a table while the game is
      // enumerating it, and the game reads its catalogues once during start-up.
      //
      // Two sources, because neither covers the other:
      //   - the captured bundle is the only *authoritative* source for the game's own entity tables (plants,
      //     pets, items...), and it exists only in-page;
      //   - the platform API is the only source for shops and weather, since the developers moved those off the
      //     socket and onto `https://magicgarden.gg/platform/v1/*`. A mod running on that origin can call it
      //     directly, as reference mods do (AriesMod reads `/platform/v1/version`).
      //
      // Order does not matter: each source advertises only what it actually captured, so `CatalogClient`
      // never asks the bundle source for weather. The bundle goes first only because in-page data is fresher
      // for the categories they could both theoretically supply.
      if (this.features.catalog) {
        this.catalogHandle = captureCatalogBundle(this.page !== null ? { page: this.page } : {});
        const sources: CatalogSource[] = [this.catalogHandle.source()];
        if (this.features.platformCatalog) {
          sources.push(new PlatformApiSource());
        }
        // The failure is recorded in `DomainCatalog.errors` by `CatalogClient` whether or not this callback
        // exists; wiring it here makes the failure *timely*: a `warn` in the page console instead of
        // a silent "missing" that a caller may only notice a reload later.
        this.catalogClient = new CatalogClient({
          sources,
          onSourceError: (sourceId, kind, error) =>
            this.logger.warn('catalog source failed', {
              sourceId,
              kind,
              error: summarizeError(toMgError(error, SOURCE_FAILURE_CODE)),
            }),
        });
      }

      // The Pixi init hooks, likewise: `@run-at document-start` is the whole reason we can wrap them at all.
      if (this.features.render) {
        this.captureHandle = PixiStage.capture({
          ...(this.page !== null ? { page: this.page } : {}),
          onEvent: (event) => {
            if (!event.wasRecreation) return;
            // A WebGL context loss after backgrounding rebuilds the renderer and the stage (recon §2.7).
            // Every node a mod held is now dead, and every world scene's layers are gone.
            //
            // Recovery stays the caller's, and Phase 7 Task 7.4 made that a real choice rather than a gap:
            // the primitive is `WorldScene.rebuild()`, which unwinds the dead tree and enters the new one.
            // This layer does not call it for you, because it does not retain the scenes it hands out:
            // `render.worldScene` is a factory, and a client that kept every scene it ever created would
            // hold them for the life of the page with no moment at which to let one go. A mod that holds
            // its scene rebuilds it here; one that let the reference drop has nothing to rebuild, which is
            // the honest answer.
            this.logger.warn('the renderer was recreated (WebGL context loss); mod-owned nodes are stale');
            try {
              this.options.onRendererRecreated?.();
            } catch (error) {
              this.logger.warn('onRendererRecreated threw', { error });
            }
          },
        });
      }

      // Begin attaching, but do not block: `start()` resolves as soon as the hooks are claimed, so a
      // document-start script is not kept waiting on a 20 s attachment window. `waitForAttachment()` is the
      // call that waits, and `kind: 'none'` is a legitimate answer to it.
      void this.waitForAttachment().catch((error: unknown) => {
        this.logger.error('attachment failed', { error });
      });

      // After every fallible step: see the method doc. `report.started` reads this.
      this.installed = true;
    } catch (error) {
      this.releaseClaim();
      throw error;
    }
  }

  /**
   * Give back this client's claim on the page namespace, if it holds one.
   *
   * Shared by {@link stop} and by {@link start}'s failure path, so the refcount policy has one home: release
   * the claim, run every teardown the release hands back, and remove the namespace only when nobody else is
   * home (`deleteNamespace` is the primitive; the refcount is the policy).
   *
   * `getPage()` rather than `requirePage()`: a client that never started, or whose realm is gone, has no
   * claim of its own to release, and that is not an error worth rejecting over.
   *
   * `ownsClaim` is cleared, which makes a *failed* start retryable without double-claiming: the flag
   * is set before the fallible steps, so leaving it set would let a second release give away a claim this
   * client no longer holds.
   */
  private releaseClaim(): void {
    if (!this.ownsClaim) return;
    this.ownsClaim = false;
    const page = this.page ?? getPage();
    if (page === null) return;

    const teardowns = releaseInstall(page);
    for (const teardown of teardowns) {
      attemptTeardown('namespace teardown', teardown);
    }
    const namespace = peekNamespace(page);
    if (namespace !== null && namespace.refCount === 0) {
      attemptTeardown('namespace removal', () => {
        deleteNamespace(page);
      });
    }
  }

  /**
   * Resolve once an attachment was attempted.
   *
   * @returns the attachment. `kind: 'none'` is a legitimate answer for a page with no game connection, and is
   *   not an error.
   */
  async waitForAttachment(): Promise<Attachment> {
    if (this.attachment !== null) return this.attachment;
    if (this.attachmentPromise !== null) return await this.attachmentPromise;

    this.attachmentPromise = (async (): Promise<Attachment> => {
      const attachment = await attachToHost({
        ...(this.page !== null ? { page: this.page } : {}),
        ...(this.options.forceAttachment !== undefined ? { force: this.options.forceAttachment } : {}),
        ...(this.options.urlFilter !== undefined ? { urlFilter: this.options.urlFilter } : {}),
        ...(this.options.attachTimeoutMs !== undefined ? { timeoutMs: this.options.attachTimeoutMs } : {}),
        // Where our own identity actually lives. The game's `Welcome` handler does `t(g, e.selfPlayerId)`
        // and then publishes only `cloneForDistribution(e.fullState)` to its subscribers, so the state tree
        // never carries the id and the room callback cannot supply it. The socket seam can.
        selfPlayerIdResolver: () => this.resolveSelfPlayerId(),
      });
      // The sink goes in *before* the attachment is adopted, and the answer is not discarded.
      // `attachSink()` returns `false` when it did not attach: the transport is closed (a `stop()` that
      // raced the attach window) or this exact sink is already in place. Adopting the binding anyway is how
      // the client could report a healthy attachment while nothing was wired to receive a frame: the
      // silent-failure class I7 removes. Nothing was wired, so the binding is released unobserved, the
      // typed reason is recorded, and the wait rejects rather than resolving with a corpse.
      if (!this.transport.attachSink(attachment.sink)) {
        attachment.release();
        throw this.refuseAttachment(attachment);
      }
      this.attachment = attachment;

      // (5) One renumbering hook on the host's own send path, covering our frames and the game's alike.
      if (this.features.renumbering && attachment.kind === 'room-connection') {
        const installed = attachment.setOutboundRewriter((payload: unknown) =>
          this.rewriteOutboundObject(payload),
        );
        attachment.report.renumberingInstalled = installed;
      } else if (this.features.renumbering && attachment.kind === 'raw-socket') {
        const installed = attachment.setOutboundRewriter((data: unknown) =>
          applyRenumbering(data, this.renumberer),
        );
        attachment.report.renumberingInstalled = installed;
      }

      this.logger.info('mg.js attached', attachment.report as unknown as Record<string, unknown>);
      emitNamespaceEvent('attached', [attachment.report], this.page);

      // Attaching to the raw socket is the right thing to do *now* and the wrong thing to keep forever.
      // `MagicCircle_RoomConnection` is a lazily-created singleton: the game assigns it on the first
      // `getInstance()` call, which comes from the room subsystems it builds after joining. It is therefore
      // absent at `document-start` and present seconds later. Without this watch, the first attempt wins
      // with the fallback and the documented path is never reconsidered. See `watchForRoomConnection`.
      this.startRoomConnectionWatch(attachment);

      return attachment;
    })();

    return await this.attachmentPromise;
  }

  /**
   * Record a sink the transport refused, and build the typed error the caller sees.
   *
   * The sink is *released by the caller* before this runs: the transport never took it, so the binding has
   * nothing observing it and leaving it live would leak the page hooks it installed.
   *
   * The error is both returned (so the caller can reject with it) and kept in {@link attachErrorValue} (so
   * {@link lastError} and `report.errors` carry it too). A caller that only polls the diagnostic surface
   * must see the same failure as one that awaited the attach.
   */
  private refuseAttachment(attachment: Attachment): MgTransportError {
    const error = new MgTransportError(
      `The transport refused the ${attachment.kind} sink (state: ${this.transport.state}); ` +
        'nothing is wired to receive frames.',
      'socket',
      { code: 'sink_not_attached' },
    );
    this.attachErrorValue = error;
    this.logger.error('mg.js attachment refused by the transport', {
      kind: attachment.kind,
      transport: this.transport.state,
    });
    return error;
  }

  /**
   * The one source that answers on the shipped build: what the attached socket seam scraped off the wire.
   *
   * `selfPlayerId` is not in the state tree and the room object never hands it to a subscriber. The game's
   * `Welcome` handler reads it off the *message* (`t(g, e.selfPlayerId)`) and then publishes only
   * `cloneForDistribution(e.fullState)`, so neither the welcome callback nor any patch carries it.
   *
   * The socket does. `scrapeFrame` in `attach/raw-socket.ts` watches every inbound frame for
   * `"selfPlayerId"`, and the seam that records the result is {@link sendSeam}, retained across the
   * raw-socket → room-connection upgrade, so it keeps answering for the rest of the session. `sockets seen:
   * 1` in a report is the tell that this seam is present.
   *
   * An id that arrives after the welcome is still picked up because the id is read here on every read,
   * which a welcome-time-only resolution missed on a live run. An absent or released seam answers `null`,
   * which a caller reports as "not known yet" rather than as an error. A session is perfectly usable
   * while we do not know who we are.
   */
  private resolveSelfPlayerId(): string | null {
    const seam = this.sendSeam;
    if (seam === null) return null;
    try {
      return seam.socket?.readSelfPlayerId() ?? null;
    } catch {
      // A binding that has been released cannot answer; there is nothing else to ask.
      return null;
    }
  }

  /**
   * Keep an eye out for `MagicCircle_RoomConnection`, and promote to it when it appears.
   *
   * Only started when the raw-socket path won and the caller did not force a path: an explicit
   * `forceAttachment` is a decision, and second-guessing it would make the option unusable for the tests and
   * diagnostics that rely on it.
   */
  private startRoomConnectionWatch(attachment: Attachment): void {
    if (attachment.kind !== 'raw-socket') return;
    if (this.options.forceAttachment !== undefined) return;

    const timeoutMs = this.options.roomUpgradeTimeoutMs ?? 90_000;
    if (timeoutMs <= 0) return;

    this.roomUpgradeStop = watchForRoomConnection(
      (next) => {
        this.roomUpgradeStop = null;
        this.upgradeAttachment(next);
      },
      {
        ...(this.page !== null ? { page: this.page } : {}),
        ...(this.options.urlFilter !== undefined ? { urlFilter: this.options.urlFilter } : {}),
        timeoutMs,
        ...(this.options.roomUpgradeIntervalMs !== undefined
          ? { intervalMs: this.options.roomUpgradeIntervalMs }
          : {}),
        onTimeout: () => {
          this.roomUpgradeStop = null;
          this.logger.debug('room connection never appeared; staying on the raw socket', { timeoutMs });
        },
      },
    );
  }

  /**
   * Move a live client from the raw socket onto the game's own room connection.
   *
   * ## Why the raw-socket binding is *kept*, not released
   *
   * The two paths are good at different halves of the job, and the upgrade changes only one of them:
   *
   *   - **Observation** moves to the room object, which is the whole documented advantage (JSON parsing,
   *     a tracked frontier, transparent reconnects, a synchronous state read).
   *   - **Sending and renumbering stay on the socket.** Every outbound frame the game produces ends up in
   *     `currentWebSocket.send()`, including the ones that go through the room object, because
   *     `trySendMessageNow` → `sendOpenMessage` → `devSendDelayLine` → `writeToSocket` → `socket.send()`.
   *     So the socket hook is the one seam that cannot be bypassed, and it is what makes the coexistence
   *     guarantee hold regardless of which layer the game decides to route through this build.
   *
   * Both reference mods patch the socket for this reason. `garden-companion`'s comment is explicit
   * that "sendMessage does not pass the socket send we wrap, so a command sent that way left with no
   * sequence at all", and `MG-AriesMod` wraps `WebSocket.prototype.send` while noting that the game's own
   * counter is module-local and therefore invisible. Hooking only the room object's two methods would mean
   * that any path the game adds, or any it already has that skips them, silently goes unnumbered, and a
   * single unnumbered frame is a gap, which the server answers with `invalid_sequence` for every later
   * command. That is the "connection looks frozen" failure this module exists to prevent.
   *
   * Keeping both would be just as wrong in the other direction: each rewriter consumes a number, so one
   * command rewritten twice leaves a gap. Hence *one* seam, chosen once, and it is the socket whenever the
   * socket was our first attachment.
   *
   * The frontier is carried over explicitly: the raw path's scraped value and the room object's
   * `lastDistributedRoomPublication.executedCommandSequence` are two views of one number, and
   * `observeFrontier` only ever moves the renumberer forward, so this cannot re-issue a number the server
   * has already run.
   */
  private upgradeAttachment(next: Attachment): void {
    const previous = this.attachment;
    if (previous === null || this.uninstalled) {
      next.release();
      return;
    }

    // Order matters, and every step is synchronous so no frame can be sent in between: re-point observation,
    // then adopt the new binding. The old binding is *not* released, by design. See above.
    //
    // The second `attachSink()` call site, and it discards the answer no more than the first: a refused
    // sink means the upgrade did not happen. Keep observing through `previous` (do not adopt `next`, do not
    // move the send seam), release the binding nothing will observe, and record the same typed reason.
    if (!this.transport.attachSink(next.sink)) {
      next.release();
      this.refuseAttachment(next);
      return;
    }
    this.attachment = next;

    if (previous.kind === 'raw-socket') {
      // The socket keeps the send seam. It is still installed, so its rewriter is still live; nothing to do
      // here beyond remembering that this binding must be released at teardown.
      this.sendSeam = previous;
    } else if (this.features.renumbering) {
      // Upgrading between two room bindings (a rebuilt game object): the surviving binding has to own the
      // rewriter, and the old one must give it up or one command would be numbered twice.
      previous.setOutboundRewriter(null);
      previous.release();
      next.report.renumberingInstalled = next.setOutboundRewriter((payload: unknown) =>
        this.rewriteOutboundObject(payload),
      );
    }

    const frontier = next.sink.readFrontier();
    if (frontier !== null) this.renumberer.observeFrontier(frontier);

    this.logger.info('mg.js attachment upgraded', {
      from: previous.kind,
      to: next.kind,
      frontier,
      // Which layer still numbers outbound frames: the single most useful fact to have in a bug report
      // about dropped commands.
      sendSeam: this.sendSeam?.kind ?? next.kind,
      roomConnection: next.report.roomConnection,
    });
    // This is not `'attached'`, by design: a mod that builds its UI on that event would run its setup a
    // second time mid-session. The upgrade is a change of transport, so it gets its own name and leaves the
    // once-per-install meaning of `'attached'` intact.
    emitNamespaceEvent('attachment-upgraded', [next.report], this.page);
  }

  /**
   * Tear everything down. Total: it never rejects and a second call is a no-op.
   *
   * Every step goes through {@link attemptTeardown}, because teardown routinely touches things that are
   * already gone, such as a socket the game closed or a container the renderer destroyed, and a teardown
   * that stops at the first throw leaves the *later* hooks installed forever.
   *
   * The claim release is refcounted: with two loads in a page, the first `stop()` decrements and the last one
   * actually restores. That is what stops an unload in one load from ripping hooks out from under the other.
   *
   * The page is looked up with `getPage()`, never `requirePage()`: a client whose realm has gone away still
   * owns a transport poll and a core, and returning early on a missing page would leave both of them running
   * with no handle left to stop them. Only the namespace steps need a page, and they are skipped when there
   * is none. A client that never started has no claim to release anyway.
   *
   * @param reason Passed to the core's own `stop()` and the transport's close frame. For logs.
   */
  async stop(reason = 'mg.js stopped'): Promise<void> {
    if (this.uninstalled) return;
    this.uninstalled = true;
    this.installed = false;

    if (this.roomUpgradeStop !== null) {
      attemptTeardown('room upgrade watch', this.roomUpgradeStop);
      this.roomUpgradeStop = null;
    }

    for (const detach of this.detachers.splice(0)) {
      attemptTeardown('core listener', detach);
    }

    // Order matters: release the hooks *before* the transport, so a frame arriving during teardown still has a
    // live listener rather than hitting a half-detached transport.
    if (this.captureHandle !== null) {
      attemptTeardown('pixi capture', () => this.captureHandle?.release());
      this.captureHandle = null;
    }
    if (this.catalogHandle !== null) {
      attemptTeardown('catalog capture', () => this.catalogHandle?.dispose());
      this.catalogHandle = null;
      // Released with the capture it was built over, and for the same reason `jotaiValue` is cleared
      // below: a `CatalogClient` left reachable after its capture is disposed answers `sourceIds` and
      // resolves `load()` against nothing, so `client.catalog` would hand out a client that looks usable
      // and is not. `start()` rebuilds both, so a restart gets a live one.
      this.catalogClient = null;
    }
    if (this.jotaiValue !== null) {
      attemptTeardown('jotai bridge', () => this.jotaiValue?.release());
      // Cleared like the capture handles above: a released bridge must not stay reachable through
      // `client.jotai` or count as an enabled feature in `report.detail.jotai`.
      this.jotaiValue = null;
    }
    if (this.attachment !== null) {
      attemptTeardown('attachment', () => this.attachment?.release());
      // The binding has been released, so it must not be handed out again. `waitForAttachment()` memoises it,
      // and a released thing that stays memoised is a client that reports readiness against a corpse: the
      // next `start()` short-circuits on this field and never re-attaches.
      this.attachment = null;
    }
    // The promise is a second memo for the same binding. Left resolved, it hands the same released
    // attachment back once the field above is cleared, and left pending it is a stale 20 s poll loop that
    // the next `waitForAttachment()` would await instead of attaching.
    this.attachmentPromise = null;
    // Released separately because an upgrade can leave the socket binding alive as the send seam while
    // observation moved to the room object; missing this would leak a WebSocket hook with nobody to undo it.
    if (this.sendSeam !== null) {
      attemptTeardown('send seam', () => this.sendSeam?.release());
      this.sendSeam = null;
    }

    // Rule 2, again, at the outer layer: the transport detaches and never closes the host's socket.
    attemptTeardown('transport', () => this.transport.close(1000, `mg.js stopped: ${reason}`));
    attemptTeardown('core stop', () => void this.core.stop(reason));

    this.releaseClaim();
    emitNamespaceEvent('uninstalled', [], this.page);
  }

  // ------------------------------------------------------------------------------------
  // Coexistence wiring
  // ------------------------------------------------------------------------------------

  /**
   * The frontier reader handed to `ClientCore`.
   *
   * Order of sources, best first:
   *   1. the room connection's `lastDistributedRoomPublication.executedCommandSequence`, which §4 calls
   *      "the command-sequence frontier... already tracked for you", "kept current on every frame";
   *   2. the transport's scraped value (the raw-socket path has no other source);
   *   3. the core's own sequencer, which at least knows what *we* last issued.
   *
   * `null` is returned rather than `0` when nothing is known. That distinction matters:
   * `FrontierAnchoredStrategy` treats `null` as "no evidence" and `0` as "the server has executed through
   * sequence zero", and conflating them would make the first stamp of a session a guess.
   */
  readFrontier(): number | null {
    const attachment = this.attachment;
    if (attachment !== null) {
      const fromSink = attachment.sink.readFrontier();
      if (fromSink !== null) return fromSink;
    }
    const sequencerFrontier = this.core.sequencer.frontier;
    return sequencerFrontier;
  }

  /**
   * Rewrite an outbound frame that is already a parsed object (the room-connection path).
   *
   * Distinct from the string form because the room path's whole advantage is that it "already speak[s] parsed
   * objects instead of JSON strings", so no parse/serialise round trip is needed or wanted.
   *
   * No `isOurs` check here, for the same reason there is none on the string path: `rewrite` performs it and
   * answers `'ours'` with the input frame unchanged, so checking first only restated the machine's own rule.
   */
  private rewriteOutboundObject(payload: unknown): unknown {
    const envelope = asEnvelope(payload);
    if (envelope === null) return payload;
    return this.renumberer.rewrite(envelope).frame;
  }

  // ------------------------------------------------------------------------------------
  // Outbound remembering
  // ------------------------------------------------------------------------------------

  /**
   * Remember a requestId we are about to send.
   *
   * Called from {@link send}, and it exists for §19's part 3: "detect your own previously-built envelopes
   * (a request-id set you populate yourself) so you don't re-intercept or re-number your own outgoing traffic."
   *
   * Why this matters concretely: `send()` hands the frame to the transport, the transport hands it to the
   * host's hooked send path, and the renumbering hook sees it. Without this call the hook would treat our own
   * command as foreign and consume a second sequence number for it, leaving a hole in the sequence, which is
   * `invalid_sequence`, which breaks every later command.
   */
  rememberOutbound(frame: string): void {
    const envelope = parseEnvelope(frame);
    if (envelope === null) return;
    const requestId = envelope.requestId;
    if (typeof requestId !== 'string' || requestId === '') return;
    this.renumberer.remember(requestId);
  }

  /**
   * Send one already-serialised frame, remembering it first.
   *
   * Provided for a caller that has a frame from somewhere other than `ClientCore` (a replayed frame, a
   * fixture). The core's own path goes through `ClientCore.send`, which builds the envelope and hands it to
   * the transport. This method exists so that path is not the only one that can remember an id.
   */
  send(raw: string): void {
    this.rememberOutbound(raw);
    this.transport.send(raw);
  }

  /**
   * Reserve the next sequence number from our counter and claim ownership.
   *
   * Exposed for a mod that builds its own `QuinoaCommand` envelope rather than going through the typed action
   * surface. Calling it takes the counter (see `Renumberer.claimNext`), so a mod that only wants to read the
   * next number should use {@link peekSequence} instead.
   */
  claimSequence(): number {
    return this.renumberer.claimNext();
  }

  /** The next sequence number, without claiming anything. */
  peekSequence(): number {
    return this.renumberer.peekNext();
  }

  /** Report the server's frontier, e.g. after an `invalid_sequence` rejection. */
  resyncSequence(frontier?: number | null): void {
    this.renumberer.healAfterInvalidSequence(frontier ?? this.readFrontier());
  }

  /** The page namespace, for a caller that wants to publish a global. */
  namespace(): ReturnType<typeof getNamespace> | null {
    return peekNamespace(this.page);
  }
}

// --------------------------------------------------------------------------------------
// Re-exports, each from its one home
// --------------------------------------------------------------------------------------

/**
 * The envelope predicate and its pre-parse gate, re-exported from their one home.
 *
 * These used to be defined here as well, on the stated grounds that a local copy kept this module and
 * `coexistence/renumber.ts` independent, which was not true, since this file already imported `Renumberer`
 * from it. Two byte-identical copies disagreed about nothing *yet*, which is the only thing that can be said
 * for them. See `coexistence/envelope.ts`.
 */
export { asEnvelope, parseEnvelope } from './coexistence/envelope.js';
/**
 * The renumbering gate, re-exported from its one home under the name this path gave it.
 *
 * There were two implementations of this, one per attachment path. Once the string copy lost the `isOurs`
 * check that `Renumberer.rewrite` already performs, the two bodies were character-for-character equivalent:
 * `applyRenumbering` takes `unknown` and hands non-strings straight back, so the "string" version was never
 * really a different function. Keeping a second definition would have meant maintaining two copies of one
 * behaviour, so this renames rather than reimplements, and `tests/coexistence/envelope.test.ts` asserts the
 * published name and the canonical one are the same function object.
 */
export { applyRenumbering as applyRenumberingToString } from './coexistence/renumber.js';
/**
 * Read `executedCommandSequence` off a `Welcome`.
 *
 * This is `common`'s `extractFrontier` under the name this package publishes, not a second body beside it:
 * both read the top-level `executedCommandSequence` off a non-null object, and what counts as a sequence is
 * one rule with one home. Two implementations are exactly how the core sequencer came to be seeded from a
 * `Welcome`'s `2.5` while the renumberer refused it, two counters the `welcome` listener below promises
 * are seeded "from the same fact, so they cannot disagree". The name survives (and stays re-exported from
 * `index.ts`) because it is part of this package's public surface.
 */
export { readWelcomeFrontier };

/** The two facts `resolveAttachmentReport` reads from one attachment source. */
function toAttachmentFacts(attachment: Attachment | null): AttachmentFacts | null {
  return attachment === null
    ? null
    : { report: attachment.report, socketCount: attachment.socket?.socketCount ?? null };
}
