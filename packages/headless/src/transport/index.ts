/**
 * `@mg.js/headless/transport`: owning a socket.
 *
 * This barrel is the target of the package's `"./transport"` export. The subpath used to point at
 * `client.js`, one member file, which meant the subpath could not reach the runtime capability probe or
 * the header builder. Those are the two things a host driving the transport itself actually needs. A folder
 * barrel is the rule (DESIGN §4.1), and `tests/exports-map.test.ts` asserts it after a build.
 */

export type { BuildConnectHeadersOptions, ConnectHeaders } from './headers.js';
export { buildConnectHeaders, DEFAULT_ORIGIN, DESKTOP_CHROME_UA, originQueryHint } from './headers.js';
export type {
  AcquireWebSocketOptions,
  SocketLike,
  WebSocketFactory,
  WebSocketRuntime,
  WebSocketRuntimeKind,
} from './runtime.js';
export { acquireWebSocketRuntime, decodeSocketPayload, NoWebSocketError } from './runtime.js';
export type { StandaloneTransportOptions } from './standalone.js';
export { StandaloneTransport } from './standalone.js';
