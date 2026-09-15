/**
 * Command handles: what an action method returns.
 *
 * The protocol does not give us a clean request/response. All 103 reference methods return `void`,
 * `QuinoaCommandResult` is the only feedback channel, and the documented result payload carries **no**
 * `requestId`, so there is no specified way to correlate an ack to the command that caused it.
 *
 * This type is built to be honest about that rather than paper over it:
 *
 *   - `confirmed` is `true` only when the server actually echoed our `requestId`.
 *   - Under the default `fifo` ack mode a result can match by action name and ordering, and is then
 *     reported with `confirmed: false` and `matchMethod: 'fifo'`.
 *   - A command the server silently overtook is reported as `droppedStale`, a synthesized code the
 *     server never sends.
 *
 * So `await handle` never lies: it resolves with a result you can inspect, and rejects only when the
 * command is known to have failed or its fate is unknown.
 */

import type { CommandRejection, ResultCode } from './result-codes.js';

/** How a result was matched to the command that produced it. */
export type AckMatchMethod =
  /** The server echoed our `requestId`. The only proof the protocol offers. */
  | 'requestId'
  /** Matched by action name and send order. Probable, not proven. */
  | 'fifo'
  /** No correlation attempted (`ackMode: 'none'`). */
  | 'none'
  /** Inferred from the server's sequence frontier, not from any ack. */
  | 'frontier';

/** The outcome of one command. */
export interface CommandResult {
  /** The action wire string. */
  action: string;
  /** The correlation id we stamped into the envelope. */
  requestId: string;
  /** The sequence number we stamped. */
  sequence: number;
  /** Whether the server reported success. */
  ok: boolean;
  /**
   * True only when the outcome is trustworthy.
   *
   * `requestId` matching is trustworthy. `fifo` matching is a probable guess, not proof, so this is
   * false in that case, and callers who care should check it.
   */
  confirmed: boolean;
  /** How this result was matched to the command. */
  matchMethod: AckMatchMethod;
  /** The structured rejection, when `ok` is false. */
  rejection?: CommandRejection;
  /** The raw `QuinoaCommandResult`, when one was received. */
  raw?: unknown;
}

/** The two ways a handle can settle without a usable ack. */
export type CommandFailureReason = 'unconfirmed' | 'dropped-stale';

/**
 * A pending command.
 *
 * Thenable, so `await actions.harvestCrop({ slot: 3 })` works directly.
 *
 * ## Why the result promise is internally marked handled
 *
 * Most commands are fire-and-forget: a caller writes `void actions.teleport({x, y})` and never looks at
 * the handle. If `result` rejected unobserved, every such call would surface as an
 * `unhandledRejection`, which is noisy in a page console and fatal under `--unhandled-rejections=strict`.
 *
 * But silently swallowing failures would be worse, because the protocol's default ack mode cannot
 * prove much and a caller needs to be able to find out.
 *
 * So this attaches a no-op `.catch()` to `result` at construction. That marks the promise as handled
 * for the runtime's purposes, while `await handle`, `handle.result.catch(...)` and `handle.settled` all
 * still observe the real outcome. Fire-and-forget stops being noisy; explicit error handling still
 * works. `handle.settled` is the better choice for a caller who wants the outcome without exceptions.
 */
export class CommandHandle implements PromiseLike<CommandResult> {
  readonly action: string;
  readonly requestId: string;
  readonly sequence: number;
  /** Resolves with the outcome, or rejects on a known failure. */
  readonly result: Promise<CommandResult>;
  /** Settles when the command is acknowledged, rejected, or written off. Never rejects. */
  readonly settled: Promise<CommandResult | null>;

  constructor(
    action: string,
    requestId: string,
    sequence: number,
    result: Promise<CommandResult>,
    settled: Promise<CommandResult | null>,
  ) {
    this.action = action;
    this.requestId = requestId;
    this.sequence = sequence;
    this.result = result;
    this.settled = settled;

    // See the class comment: marks `result` handled without consuming the rejection. A later
    // `await`/`.catch()` on the same promise still receives it.
    void result.catch(() => {});
  }

  // Being thenable is the entire point of this class: `await actions.harvestCrop({ slot: 3 })` is the
  // documented way to read the outcome. The rule exists to catch a *non*-promise that accidentally
  // becomes awaitable (and so can hang a caller); here it is deliberate, documented on the class, and
  // covered by tests, so it is suppressed at this one site rather than turned off repo-wide.
  // biome-ignore lint/suspicious/noThenProperty: deliberate thenable; see the class comment.
  then<TResult1 = CommandResult, TResult2 = never>(
    onfulfilled?: ((value: CommandResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.result.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<CommandResult | TResult> {
    return this.result.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<CommandResult> {
    return this.result.finally(onfinally);
  }
}

/** Anything that can turn an action + params into a handle. Implemented by the client core. */
export interface CommandSender {
  /**
   * Send one action.
   *
   * @throws {MgNotReadyError} when the client has not received `Welcome` and the sequencer is unseeded.
   */
  send(action: string, params?: Record<string, unknown>): CommandHandle;
}

/** Helper for building a rejection-bearing failure result. */
export function failureResult(
  action: string,
  requestId: string,
  sequence: number,
  rejection: CommandRejection,
  raw?: unknown,
): CommandResult {
  const result: CommandResult = {
    action,
    requestId,
    sequence,
    ok: false,
    confirmed: true,
    matchMethod: 'requestId',
    rejection,
  };
  if (raw !== undefined) result.raw = raw;
  return result;
}

/** Re-export for convenience at call sites that switch on the code. */
export type { ResultCode };
