/**
 * The events and reports a {@link HeadlessClient} emits and publishes.
 *
 * Split out of `client.ts` (Phase 5 Task 5.5b) so that file describes behaviour instead of contracts.
 * `client.ts` re-exports all three, so neither `@mg.js/headless` nor any internal import path changes.
 */

import type {
  ClientCloseEvent,
  ClientCoreReport,
  ClientReport,
  CloseAnalysis,
  MgClientEvents,
} from '@mg.js/common';
import type { BackoffPlan } from './reconnect.js';

/**
 * The clear-close event payload: the contract's wrapper plus this client's own classification.
 *
 * `info` lives on {@link ClientCloseEvent}, so the field a caller destructures keeps its name while the
 * event becomes the same event every other client emits. The extra fields are *added*, never renamed.
 */
export interface HeadlessCloseEvent extends ClientCloseEvent {
  analysis: CloseAnalysis;
  /** True only when a retry was actually scheduled. */
  willReconnect: boolean;
}

/**
 * Events a {@link HeadlessClient} emits: the contract's three, plus this client's own.
 *
 * Declared as a type alias rather than an interface on purpose: TypeScript gives implicit index
 * signatures to type aliases of object types but not to interfaces, and the {@link Emitter} generic
 * (`TEvents extends EventMap`, i.e. `Record<string, unknown[]>`) needs one. The same reason
 * `ClientEvents` documents for itself in `@mg.js/common`.
 *
 * `Omit` of the contract's `close` and then a re-declaration of it is what makes `close` a *widening*
 * of `ClientCloseEvent` rather than a second, incompatible event. An intersection would have produced
 * `{ info } & HeadlessCloseEvent`, and a caller could not have used either type alone.
 */
export type HeadlessClientEvents = Omit<MgClientEvents, 'close'> & {
  /** The socket opened. */
  open: [];
  /** `Welcome` arrived; the client is ready to accept gameplay commands. */
  ready: [];
  /** The socket closed, with `analyzeClose`'s classification attached. */
  close: [HeadlessCloseEvent];
  /**
   * The session was superseded by another connection, and nothing will reconnect until a person decides.
   *
   * Kept separate from `stopped`, because this one is recoverable and the caller is the only one who
   * can recover it. See {@link HeadlessClient.confirmSupersededReconnect}.
   */
  confirmationRequired: [{ analysis: CloseAnalysis }];
  /** A retry was scheduled, after `plan.delayMs`. */
  reconnect: [{ plan: BackoffPlan; analysis: CloseAnalysis; url: string }];
  /** No further retries will be attempted, with the reason. */
  stopped: [{ reason: string }];
  /**
   * The runtime cannot send headers, so the intended headers were dropped. Only the names survive, never
   * the values.
   *
   * A caller that wants to report or branch on the degradation needs to know *which* headers it is
   * losing, and does not need their values. Nothing in this payload can carry a credential, which is the
   * point.
   *
   * The deprecated `headersUnsupported` name that sat beside this one carried a redacted copy of the bag
   * and was removed in Phase 4.3: two names for one fact, one of which existed only for handlers written
   * against the pre-redaction shape.
   */
  'headers-dropped': [{ headerNames: string[]; runtime: string }];
};

/**
 * Everything {@link HeadlessClient.report} publishes: the contract's axes, plus this client's own.
 *
 * `core` is the current `ClientCore`'s report, or `null` before the first attempt built one: the whole
 * per-core diagnostic surface, reachable through one typed field instead of a
 * `Record<string, unknown>` a caller has to probe.
 */
export interface HeadlessReport extends ClientReport {
  /** `clientDocumentId` for this session, stable across every reconnect attempt. */
  documentId: string;
  /** The attempt number last written into the connect URL, and the socket count this client has seen. */
  connectionAttempt: number;
  /** How many retries the reconnect policy has made for this session. */
  reconnectAttempt: number;
  /** `null` until the first resolution; `false` means the cached version was reused. */
  versionFresh: boolean | null;
  /** The `wss://` URL of the current (or most recent) connection. */
  url: string;
  /** True while a scheduled retry is actually in flight. */
  willReconnect: boolean;
  /** True while the policy is still in its cold-start fast-retry window. */
  coldStart: boolean;
  /** Why the client stopped retrying, when it has. */
  stopped: string | null;
  /** The live core's own report, or `null` before a core exists. */
  core: ClientCoreReport | null;
}
