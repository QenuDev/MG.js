/**
 * One client contract: the single description of a client, whichever platform it runs on.
 *
 * DESIGN §3.2 wants the four client-shaped classes (`ClientCore`, `HeadlessClient`,
 * `BootstrappedClient`, `RoomSocket`) to agree on four axes: one verb pair (`start`/`stop`), one
 * lifecycle event namespace with one payload shape, one identity accessor that is `string | null` and
 * never a placeholder, and one JSON-safe diagnostic surface (`report`). At HEAD each class answered
 * those axes differently: `connect`/`disconnect`/`destroy`, `install`/`uninstall`, `stats` versus
 * `report()`, and `playerId` returning `''` before the first `Welcome`, so no caller could be written
 * against two of them.
 *
 * ## Why this module emits nothing
 *
 * It is a *type* module. The contract is a description, not a base class: an abstract
 * class here would hand every client a runtime supertype and a constructor shape none of them shares,
 * and `ClientCore` is an `Emitter` subclass while `RoomSocket` is not. `common/tests/client-contract.test.ts`
 * asserts that importing this module produces an empty namespace, so the line stays held.
 *
 * ## Why `common/src/client-contract.ts` and not DESIGN's `common/src/client/contract.ts`
 *
 * DESIGN §3.2 names `client/contract.ts`, but §3.1's folder rule (a folder needs at least two modules
 * or a published subpath) forbids a one-module folder, and §3.3's target tree keeps `client.ts` bare
 * and lists no `client/` folder. The rule and the tree win; the DESIGN correction belongs in Phase 8.
 *
 * ## Why `close` carries a wrapper rather than the info itself
 *
 * `ClientCore` emits the bare `TransportCloseInfo`, while `HeadlessClient` emits
 * `{ info, analysis, willReconnect }`. Wrapping the core's payload in `{ info }` is what lets
 * `HeadlessCloseEvent extends ClientCloseEvent`: one event name, one shape, extra fields *added*,
 * never renamed. That is §3.2's own rule for a platform client.
 */

import type { Emitter } from './emitter.js';
import type { MgError } from './errors.js';
import type { TransportCloseInfo } from './transport/seam.js';

/**
 * The JSON-safe description of a failure: what `report.errors` carries and what a caller may print.
 *
 * `message` is redacted by the producer (I3), not by this type, because a summary is by definition a
 * thing that gets stored and shared.
 */
export interface MgErrorSummary {
  /** The class name, e.g. `'MgProtocolError'`. */
  readonly name: string;
  /** The stable `code` a caller branches on, e.g. `'protocol_error'`. */
  readonly code: string;
  /** A human-readable message, already redacted. */
  readonly message: string;
}

/** Which client answered: the shared core, the standalone socket client, or the page-attached one. */
export type ClientKind = 'common' | 'headless' | 'bootstrapped';

/**
 * One JSON-safe diagnostic snapshot, whatever the platform.
 *
 * Every axis is present on every client; an axis a platform cannot answer reports its honest empty
 * value rather than being omitted, so a caller can branch on one shape.
 */
export interface ClientReport {
  readonly kind: ClientKind;
  readonly started: boolean;
  readonly ready: boolean;
  /**
   * The server's id for this client, or `null` before it is known. This is the same value the
   * `selfPlayerId` accessor carries, so the diagnostic snapshot and the accessor cannot disagree (I6).
   */
  readonly selfPlayerId: string | null;
  /** Bootstrapped only: the attachment kind. `null` elsewhere and before the first attempt. */
  readonly attachment: string | null;
  readonly socketsSeen: number;
  readonly renumbering: boolean;
  readonly errors: readonly MgErrorSummary[];
  readonly version: string;
}

/**
 * The `close` payload, shared by every client.
 *
 * A wrapper so a platform client can spread this into a wider payload (`{ ...event, analysis }`)
 * without renaming the event or moving `info`.
 */
export interface ClientCloseEvent {
  readonly info: TransportCloseInfo;
}

/**
 * The lifecycle events every client emits, with the same names and the same payload shapes.
 *
 * `open` and `ready` carry nothing here; a platform client that has something to say about them adds an
 * event of its own rather than widening these.
 */
export type MgClientEvents = {
  open: [];
  ready: [];
  close: [ClientCloseEvent];
};

/**
 * What a client is, from the outside.
 *
 * `TEvents` is the client's own event map, which must extend {@link MgClientEvents}, so a platform
 * client can add events but never rename or reshape the shared three.
 */
export interface MgClient<TEvents extends MgClientEvents> {
  /**
   * Begin connecting and attaching.
   *
   * The contract promises only that the first call begins the session. What a **second** call does is
   * not promised, because the four implementers answer it differently and each answer is
   * right for its shape. An interface that documented only one of them was the defect this comment fixed:
   *
   *   - `ClientCore` and `BootstrappedClient`: idempotent. A second call while running is a no-op. After
   *     `stop()` they differ: `ClientCore.start()` throws an {@link MgConfigError} (a stopped core has
   *     released its transport listeners and is one-way), while `BootstrappedClient.start()` builds a
   *     fresh core and transport and restarts.
   *   - `HeadlessClient`: a second call while an attempt is in flight returns that attempt's promise, but
   *     a call once a session is live **supersedes** it. The old connection is replaced by a new one in
   *     the same session. That is the documented way to force a fresh connect.
   *   - `RoomSocket`: throws an {@link MgConfigError}. A `RoomSocket` owns exactly one connection;
   *     construct a new one for a new connection.
   *
   * A caller that needs one behaviour across every client must therefore not lean on idempotency; it must
   * either construct a new client or branch on the concrete type.
   */
  start(): Promise<void>;
  /** Tear everything down. `reason` is for logs, not for the wire. */
  stop(reason?: string): Promise<void>;
  /** The lifecycle events, addressed the same way on every client. */
  readonly events: Emitter<TEvents>;
  readonly isReady: boolean;
  /** The server's id for us, or `null` before it is known. Never a placeholder (I6). */
  readonly selfPlayerId: string | null;
  /** The most recent failure, or `null`. */
  readonly lastError: MgError | null;
  /** A fresh JSON-safe snapshot. */
  readonly report: ClientReport;
}
