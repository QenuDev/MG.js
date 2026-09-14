/**
 * The transport seam.
 *
 * This is the only thing the two clients have to implement, and it is why the protocol core is
 * written once. The bootstrapped client attaches to the game's own socket and observes its frames;
 * the headless client owns its socket outright. Above this interface, neither case exists.
 *
 * A transport deals in **raw strings**: frames go out exactly as the caller serialised them, and come
 * in exactly as the server sent them. Parsing, keepalive handling and framing are left out by design:
 * the bootstrapped transport must not consume the host game's keepalives, while the headless
 * one must. That difference belongs to the transport, not to the shared core.
 */

import type { Unsubscribe } from '../unsubscribe.js';

/** How a transport relates to the connection it carries. */
export type TransportKind =
  /** We opened the socket ourselves. Closing it is our decision and our responsibility. */
  | 'standalone'
  /** We attached to a socket someone else owns. Closing it would break the host. */
  | 'attached';

/** Why a transport closed. */
export interface TransportCloseInfo {
  code: number;
  reason: string;
  /** True when the local side initiated the close. */
  wasClean: boolean;
  /** True when this client called `close()` itself. */
  wasManual: boolean;
}

/** Current connection state of a transport. */
export type TransportState = 'idle' | 'connecting' | 'open' | 'closing' | 'closed';

/**
 * The minimal surface the shared client core needs.
 *
 * Small by design: five members. Everything richer, such as reconnect policy, sequencing and state sync,
 * is built on top in portable code.
 */
export interface Transport {
  /** Whether we own the socket or are riding someone else's. */
  readonly kind: TransportKind;

  /** Current state. */
  readonly state: TransportState;

  /**
   * Send one already-serialised frame.
   *
   * Implementations must not mutate the string. In the bootstrapped case this route passes *through*
   * the game's own send path, so that any coexistence hook installed on it sees our frames like any
   * other. That is how the renumbering hook keeps one consistent counter.
   */
  send(raw: string): void;

  /**
   * Close the connection.
   *
   * For an `attached` transport this detaches listeners and releases hooks rather than closing the
   * host's socket, so the host game keeps running.
   */
  close(code?: number, reason?: string): void;

  /** A raw inbound frame. Not called for keepalives the transport consumed itself. */
  onMessage(handler: (raw: string) => void): Unsubscribe;

  /** The transport became usable (socket open, or the host's socket was discovered). */
  onOpen(handler: () => void): Unsubscribe;

  /** The transport stopped being usable. */
  onClose(handler: (info: TransportCloseInfo) => void): Unsubscribe;
}

/** Optional richer surface a transport may expose for diagnostics. */
export interface ObservableTransport extends Transport {
  /** The URL or pseudo-URL this transport is carrying, for logs. */
  readonly endpoint: string;
  /** Why we are not open yet, when we are not. */
  readonly lastError: unknown;
}

/**
 * How long to wait for each lifecycle step, in ms.
 *
 * Defaults come from the protocol doc: the server drops an unresponsive client "after roughly 30
 * seconds of silence", so everything waiting on the server resolves well inside that.
 */
export interface LifecycleTimeouts {
  /** How long to wait for the socket to open. Default 20000. */
  openMs: number;
  /** How long to wait for `Welcome` after the handshake is sent. Default 15000. */
  welcomeMs: number;
  /** How long an unacknowledged command stays pending before being treated as unconfirmed. Default 10000. */
  commandAckMs: number;
}

export const DEFAULT_LIFECYCLE_TIMEOUTS: LifecycleTimeouts = {
  openMs: 20_000,
  welcomeMs: 15_000,
  commandAckMs: 10_000,
};
