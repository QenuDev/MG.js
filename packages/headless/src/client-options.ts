/**
 * What a caller may configure on a {@link HeadlessClient}.
 *
 * Split out of `client.ts` (Phase 5 Task 5.5b). Types only, by design: the defaults live in the
 * constructor beside the code that applies them, so a documented default cannot drift from the one the
 * client actually uses.
 */

import type { Logger, LogLevel, LogSink, ReconnectConfig } from '@mg.js/common';
import type { AuthProvider } from './auth/index.js';
import type { WebSocketFactory } from './transport/index.js';
import type { VersionResolver, VersionResolverOptions } from './version.js';

/** Options for {@link HeadlessClient}. */
export interface HeadlessClientOptions {
  /**
   * Host without scheme, optionally including a port. Default `magicgarden.gg`.
   *
   * The port is carried inside the host string because that is the only shape `ConnectOptions.host`
   * accepts, and the connect URL is `wss://<host>/version/<v>/...`, so a port is part of `<host>`.
   */
  host?: string | undefined;
  /**
   * Convenience for a host that carries its own port: `port: 8080` with `host: '127.0.0.1'` produces
   * `127.0.0.1:8080`. Ignored when the host already contains a colon.
   */
  port?: number | undefined;
  /**
   * Use `wss://` (the default). Set `false` only for a local or reverse-proxied plaintext endpoint.
   *
   * The URL is always *built* as `wss://` because that is what §1.3 documents; this changes the scheme
   * handed to the socket.
   */
  tls?: boolean | undefined;
  /** Room slug. Omit for a private room of your own (§1.4). */
  room?: string | undefined;
  /**
   * A known-good game version. When supplied, no version fetch happens at all.
   *
   * Use this for offline tests or a pinned deployment. Without it, the client needs either
   * {@link versionResolver} or a live `magicgarden.gg/platform/v1/version` request.
   */
  version?: string | undefined;
  /** A custom resolver, the seam the `4710` integration test injects a fake through. */
  versionResolver?: VersionResolver | undefined;
  /** Where the version comes from, when neither of the above is supplied. */
  versionOptions?: VersionResolverOptions | undefined;
  /**
   * Auth. Defaults to {@link GuestAuthProvider}, anonymous with no credentials.
   *
   * A cookie provider needs a header-capable runtime; see {@link requireHeadersForAuth}.
   */
  auth?: AuthProvider | undefined;
  /** Partial reconnect policy; anything omitted falls back to `DEFAULT_RECONNECT` (which is `DEFAULT_RECONNECT_POLICY`, the same object). `enabled: false` is the one way to disable automatic reconnect. */
  reconnect?: Partial<ReconnectConfig> | undefined;
  /** Ack correlation mode for `ClientCore`. Default `'fifo'`; see that class for why. */
  ackMode?: 'strict' | 'fifo' | 'none' | undefined;
  /** A logger, or options to build one. Defaults to a `warn`-level `mg:headless` logger. */
  logger?: Logger | undefined;
  /** Convenience override for the logger namespace. Default `mg:headless`. */
  namespace?: string | undefined;
  /** Convenience override for the logger level. Default `warn`. */
  logLevel?: LogLevel | undefined;
  /** Convenience override for the log sink. */
  logSink?: LogSink | undefined;
  /** The page origin presented at connect time. Default `https://magicgarden.gg`. */
  origin?: string | undefined;
  /** Overrides the pinned desktop-Chrome `User-Agent`. */
  userAgent?: string | undefined;
  /**
   * An injected WebSocket constructor.
   *
   * The one way to get real `Origin`/`User-Agent`/`Cookie` headers without this package depending on
   * `ws`: pass `import('ws').WebSocket`. See `transport/runtime.ts`.
   */
  webSocketFactory?: WebSocketFactory | undefined;
  /** Try a runtime `import('ws')` when headers are needed and none were injected. */
  preferWebSocketAdapter?: boolean | undefined;
  /**
   * Fail the connect instead of proceeding without headers. **Defaults to `true`.**
   *
   * WHY THE DEFAULT IS `true`: for a cookie-authenticated connection the `Cookie: mc_jwt=<jwt>` header
   * *is* the session. It is the only credential the game accepts, and there is no other authentication
   * step. Node's built-in `WebSocket` silently ignores request headers, so a downgrade would send a
   * connection with no credential at all and the server would close it with a bare
   * **`4840 SessionExpired`**, with nothing in the client's own logs to explain why.
   *
   * That is not hypothetical: it is the failure this package was debugged through. Failing
   * loudly at connect time, naming the runtime and the fix, is strictly better than a close code the
   * caller has no way to interpret.
   *
   * Set `false` only to attempt an unauthenticated connection with an authenticated provider on
   * purpose, which no known build accepts.
   */
  requireHeadersForAuth?: boolean | undefined;
  /** How long to wait for the socket to open, in ms. Default 20000. */
  openTimeoutMs?: number | undefined;
}
