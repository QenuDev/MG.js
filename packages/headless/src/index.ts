/**
 * `@mg.js/headless`: the standalone Magic Garden client.
 *
 * The whole package in one import:
 *
 * ```ts
 * import { HeadlessClient, GuestAuthProvider } from '@mg.js/headless';
 *
 * const client = new HeadlessClient({ auth: new GuestAuthProvider({ name: 'Bot' }) });
 * await client.start();
 * await client.waitUntilReady();
 * await client.actions.harvestCrop({ slot: 0 });
 * console.log(client.store.get('/data/players/0/coins'));
 * ```
 *
 * It re-exports nothing from `@mg.js/common`: consumers that need the action types, the
 * close-code enum or the state helpers should import them from `@mg.js/common` directly, so there is
 * one source of truth for the protocol vocabulary and no accidental duplicate identity.
 *
 * Zero runtime dependencies. The default WebSocket is `globalThis.WebSocket` (Node >= 22); the only
 * runtime dependency in the dependency graph is `@mg.js/common`. The `ws` package is a devDependency
 * used by the mock server in `tests/fixtures/mock-server.ts`, and optionally at runtime as an *adapter*
 * when the caller asks for it; see `transport/runtime.ts` for why the built-in cannot set headers.
 */

export type {
  AnonymousUserStyle,
  AnonymousUserStyleEncoding,
  AuthContribution,
  AuthProvider,
  CookieAuthProviderOptions,
  GuestAuthProviderOptions,
} from './auth/index.js';
// Auth: same rule, same reason.
export {
  ANONYMOUS_USER_STYLE_PARAM,
  buildAnonymousUserStyle,
  CookieAuthProvider,
  GuestAuthProvider,
  MC_JWT_COOKIE,
  StaticAuthProvider,
  toCookieHeader,
} from './auth/index.js';
export type {
  HeadlessClientEvents,
  HeadlessClientOptions,
  HeadlessCloseEvent,
  HeadlessReport,
} from './client.js';
// The main class.
export { appendAuthQuery, HANDSHAKE_ACTIONS, HANDSHAKE_GAME_NAME, HeadlessClient } from './client.js';
// Session acquisition (documented) and validation (executable).
export { MgConfigError } from './errors.js';
export type {
  BackoffContext,
  BackoffPlan,
  ReconnectPolicyOptions,
} from './reconnect.js';
// Backoff.
export {
  classifyClose,
  computeBackoff,
  DEFAULT_RECONNECT_POLICY,
  ReconnectPolicy,
} from './reconnect.js';
export type { RoomSocketConnectOptions, RoomSocketOptions, RoomSocketReport } from './room-socket.js';
// The documented standalone entry point from the API reference: `RoomSocket`.
export { RoomSocket } from './room-socket.js';
export type { SessionProbeOptions, SessionProbeResult } from './session.js';
export {
  buildDiscordOAuthUrl,
  buildProbeCookie,
  DISCORD_CLIENT_ID,
  OAUTH_BOOTSTRAP_COOKIES,
  OAUTH_REDIRECT_URI,
  OAUTH_SCOPES,
  oauthBootstrapCookies,
  probeSession,
  SESSION_COOKIE_NAME,
  sessionProbePath,
  validateCookieHeaderValue,
} from './session.js';
export type {
  AcquireWebSocketOptions,
  BuildConnectHeadersOptions,
  ConnectHeaders,
  SocketLike,
  StandaloneTransportOptions,
  WebSocketFactory,
  WebSocketRuntime,
  WebSocketRuntimeKind,
} from './transport/index.js';
// The transport, for hosts that want to drive it directly or assert on it. Re-exported from the folder
// barrel so the root entry and `@mg.js/headless/transport` can never disagree about what it contains.
export {
  acquireWebSocketRuntime,
  buildConnectHeaders,
  DEFAULT_ORIGIN,
  DESKTOP_CHROME_UA,
  decodeSocketPayload,
  NoWebSocketError,
  originQueryHint,
  StandaloneTransport,
} from './transport/index.js';
export type {
  ResolvedVersion,
  RoomVersionSourceOptions,
  VersionResolverOptions,
  VersionSource,
} from './version.js';
// Version discovery: the 4710 cure, room-scoped when a room is named.
export {
  extractVersion,
  RoomVersionSource,
  roomPageVersion,
  VersionResolver,
  VersionUnavailableError,
} from './version.js';
