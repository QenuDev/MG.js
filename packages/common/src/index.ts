/**
 * `@mg.js/common`: the shared core of magicgarden.js.
 *
 * Everything in here is runtime-agnostic and dependency-free. It knows the Quinoa wire protocol, how to
 * build every documented action, how to hold and patch the game's state, how to sequence commands, and
 * how to fetch the game's domain catalogues, but it never opens a socket and never touches a DOM.
 *
 * Both concrete clients implement the {@link Transport} seam and get all of the above for free:
 *
 *   - `@mg.js/headless`     (opens its own WebSocket and drives the protocol standalone).
 *   - `@mg.js/bootstrapped` (attaches to the game's own live connection inside the page, and adds the
 *                            Pixi/Rive render layer, the jotai bridge and coexistence handling).
 */

export * from './actions/index.js';
export * from './catalog/index.js';
export type { AckMode, ClientCoreOptions, ClientCoreReport, ClientEvents } from './client.js';
export { ClientCore } from './client.js';
export * from './client-contract.js';
export type { EventMap, Listener } from './emitter.js';
export { Emitter } from './emitter.js';
export type { MgErrorDisposition, MgTransportKind } from './errors.js';
export {
  isMgError,
  MgAuthError,
  MgCommandDroppedError,
  MgCommandRejectedError,
  MgCommandUnconfirmedError,
  MgConfigError,
  MgConnectionError,
  MgError,
  MgNotReadyError,
  MgProtocolError,
  MgSupersededError,
  MgTransportError,
  MgVersionExpiredError,
  summarizeError,
  toMgError,
} from './errors.js';
export type { Logger, LoggerOptions, LogLevel, LogRecord, LogSink } from './log.js';
export {
  ConsoleLogSink,
  createLogger,
  createNullLogger,
  MemoryLogSink,
  MultiLogSink,
} from './log.js';
export type { PollClock, PollOptions, PollUntilOptions, WatchUntilOptions } from './poll.js';
export { pollUntil, unrefTimer, watchUntil } from './poll.js';
export * from './protocol/index.js';
export type { RedactOptions } from './redact.js';
export { REDACTED, redactCredential, redactCredentialString } from './redact.js';
export * from './state/index.js';
export * from './transport/index.js';
export type { Unsubscribe } from './unsubscribe.js';
export { MG_VERSION } from './version.js';
