/**
 * Error taxonomy: one hierarchy, so a caller branches on type rather than on message text.
 *
 * The hierarchy mirrors the four things that actually go wrong: the *connection* failed (close codes),
 * a *command* failed (`QuinoaCommandResult` codes), a *frame* could not be parsed, and the *caller's own
 * configuration* is wrong. `MgError.disposition` says what a caller should do about it, so a retry loop
 * can ask one question of any failure instead of switching on every concrete class.
 *
 * ## One root, and why it is asserted
 *
 * `headless/src/errors.ts` used to declare a second root (`MgConfigError extends Error`) because this
 * package had no `MgConfigError` yet. The documented way to tell "a failure of ours" from "anything
 * else" is `isMgError`, and it answered `false` for every headless config error, so a classifying caller
 * misclassified it. `MgConfigError` is defined here now and headless re-exports it. That is the only
 * shape in which the identity assertion (`isMgError(new MgConfigError('x')) === true`) can hold.
 *
 * ## Where the summaries live
 *
 * {@link summarizeError} and {@link toMgError} are runtime functions, so they live here rather than in
 * `client-contract.ts`, because that module is types-only, and `common/tests/client-contract.test.ts`
 * asserts that importing it emits no runtime code. A summary type belongs to the contract; the code that
 * produces one belongs with the errors it reads.
 */

import type { CommandRejection } from './actions/result-codes.js';
import type { MgErrorSummary } from './client-contract.js';
import { CloseCode } from './protocol/close-codes.js';
import { redactCredentialString } from './redact.js';

/**
 * What a caller should do about a failure.
 *
 *  - `fatal`  : stop; retrying the same way cannot help until something changes.
 *  - `retry`  : the same attempt may succeed later (a socket dropped, an HTTP request failed).
 *  - `ignore` : the failure is expected and survivable (a frame this build cannot parse).
 */
export type MgErrorDisposition = 'fatal' | 'retry' | 'ignore';

/** Base class for everything this package throws. */
export class MgError extends Error {
  /** Stable machine-readable code. */
  readonly code: string;
  /** What a caller should do about it. Defaults to `fatal`. */
  readonly disposition: MgErrorDisposition;

  constructor(
    message: string,
    code: string,
    disposition: MgErrorDisposition = 'fatal',
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.disposition = disposition;
    if (options && 'cause' in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    // Restore the prototype chain: TypeScript's ES2022 output can break `instanceof` otherwise.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The socket closed, or could not be opened at all. */
export class MgConnectionError extends MgError {
  readonly closeCode: number | null;
  readonly closeReason: string;

  constructor(
    message: string,
    options: { closeCode?: number | null; closeReason?: string; cause?: unknown } = {},
  ) {
    super(message, 'connection_closed', 'fatal', { cause: options.cause });
    this.closeCode = options.closeCode ?? null;
    this.closeReason = options.closeReason ?? '';
  }
}

/** The client build is stale. Re-fetch the game version, then reconnect. */
export class MgVersionExpiredError extends MgConnectionError {
  constructor(closeReason = '') {
    super(
      'Version expired (close code 4710): the game build this client connected with is stale. ' +
        'Re-fetch the current version before reconnecting, or the server will close you again.',
      { closeCode: CloseCode.VersionExpired, closeReason },
    );
  }
}

/** Authentication failed: a bad/expired `mc_jwt` cookie, or no usable identity. */
export class MgAuthError extends MgConnectionError {
  constructor(message: string, closeReason = '') {
    super(message, { closeCode: CloseCode.AuthFailed, closeReason });
  }
}

/** The session was superseded by another connection for the same identity. */
export class MgSupersededError extends MgConnectionError {
  constructor(code: number, closeReason = '') {
    super(`Session superseded (close code ${code}).`, { closeCode: code, closeReason });
  }
}

/**
 * The server rejected a command.
 *
 * Carries the structured {@link CommandRejection} so callers can distinguish "wrong form" from
 * "wrong sequence" from "rate limited" without re-parsing strings.
 */
export class MgCommandRejectedError extends MgError {
  readonly rejection: CommandRejection;
  readonly action: string;
  readonly requestId: string | null;

  constructor(rejection: CommandRejection, action: string, requestId: string | null = null) {
    super(rejection.message, 'command_rejected');
    this.rejection = rejection;
    this.action = action;
    this.requestId = requestId;
  }
}

/**
 * A command's fate could not be determined.
 *
 * This exists because the protocol cannot always answer. The documented
 * `QuinoaCommandResult` payload carries no `requestId`, so unless a build echoes one, a client cannot
 * prove which command an ack belongs to. Rather than pretend, the action layer rejects with this, because
 * the command may have executed.
 */
export class MgCommandUnconfirmedError extends MgError {
  readonly action: string;
  readonly requestId: string;
  readonly sequence: number;

  constructor(action: string, requestId: string, sequence: number) {
    super(
      `Command "${action}" (requestId ${requestId}, sequence ${sequence}) was not confirmed. ` +
        'It may or may not have executed; the protocol does not guarantee a correlatable ack.',
      'command_unconfirmed',
    );
    this.action = action;
    this.requestId = requestId;
    this.sequence = sequence;
  }
}

/** A command was silently overtaken by the server's own frontier and never executed. */
export class MgCommandDroppedError extends MgError {
  readonly action: string;
  readonly sequence: number;

  constructor(action: string, sequence: number) {
    super(
      `Command "${action}" (sequence ${sequence}) was dropped as stale: the server's frontier ` +
        'advanced past it without acknowledging it.',
      'command_dropped_stale',
    );
    this.action = action;
    this.sequence = sequence;
  }
}

/** A command was sent before the client was ready to send one. */
export class MgNotReadyError extends MgError {
  constructor(message = 'The client has not received Welcome yet; the sequence counter is not seeded.') {
    super(message, 'not_ready');
  }
}

/**
 * The server sent something this client could not parse.
 *
 * Disposition `ignore`: an unparseable frame is explicitly non-fatal. `ClientCore` records it as
 * `unparsed` and keeps reading, so a retry loop must not treat one as a reason to reconnect.
 */
export class MgProtocolError extends MgError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, 'protocol_error', 'ignore', options);
  }
}

/** Where a transport failure happened. `state` is the store's own wait deadline, not a wire peer. */
export type MgTransportKind = 'socket' | 'http' | 'state';

/**
 * The connection (or an HTTP request over it) failed, and the same attempt may succeed later.
 *
 * A bare `Error` here was indistinguishable by type from a caller mistake (`MgProtocolError`), which is
 * the branch `isMgError`/`instanceof` exists to make. `kind` says which transport produced it.
 */
export class MgTransportError extends MgError {
  readonly kind: MgTransportKind;

  constructor(
    message: string,
    kind: MgTransportKind = 'socket',
    options: { code?: string; cause?: unknown } = {},
  ) {
    super(message, options.code ?? 'transport_failure', 'retry', { cause: options.cause });
    this.kind = kind;
  }
}

/**
 * The caller's configuration is wrong, so no request is worth dispatching.
 *
 * `config_invalid` is the general default; the auth paths pass the narrower, stable
 * `'config_invalid_token'` explicitly because a caller may already branch on it.
 */
export class MgConfigError extends MgError {
  constructor(message: string, code = 'config_invalid') {
    super(message, code, 'fatal');
  }
}

/** Type guard for anything this package throws. */
export function isMgError(value: unknown): value is MgError {
  return value instanceof MgError;
}

/**
 * Normalize anything thrown into an {@link MgError}, preserving the message and the cause.
 *
 * `unknown` is the only honest type a `catch` binding has; this is where it becomes branchable. A value
 * that is already an `MgError` is returned unchanged, so wrapping is idempotent.
 */
export function toMgError(value: unknown, fallbackCode: string): MgError {
  if (isMgError(value)) return value;
  if (value instanceof Error) return new MgError(value.message, fallbackCode, 'fatal', { cause: value });
  return new MgError(String(value), fallbackCode, 'fatal', { cause: value });
}

/**
 * The JSON-safe description of a failure: what `report.errors` carries and what a caller may print.
 *
 * Total: it never throws, whatever it is handed, including `null`, `undefined` and a primitive. It is
 * also credential-safe, because the message goes through {@link redactCredentialString}. A caller may not
 * branch on `message`, so the class name and the stable `code` are read defensively even from an object
 * that is not an `Error`.
 */
export function summarizeError(error: unknown): MgErrorSummary {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  const code = isMgError(error) ? error.code : readStringCode(error);
  return { name, code: code ?? 'unknown', message: redactCredentialString(message) };
}

/** `error.code` when the value is a non-null object carrying a string one, else `null`. */
function readStringCode(error: unknown): string | null {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}
