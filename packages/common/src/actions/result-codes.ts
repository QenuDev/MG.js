/**
 * `QuinoaCommandResult` codes.
 *
 * The doc's verbatim table lists: `invalid_message`, `invalid_sequence`, `no_slot`, `rate_limited`,
 * `not_ackable`, `handler_error`, plus `commandType:"unknown"` when the server could not parse the
 * action at all.
 *
 * `DroppedStale` is special and is the reason this file has behaviour: the API reference marks it as a
 * client-side inference rather than a wire value. The server never sends it. A client has to notice
 * that a command it sent was overtaken by a later `executedCommandSequence` and synthesise the
 * rejection itself, otherwise a dropped command looks like a pending one forever.
 */

/** Every code that can appear in `QuinoaCommandResult.code`, plus the one we synthesise. */
export enum ResultCode {
  /** The server could not parse the action. The most common symptom of sending a wrapped action flat. */
  InvalidMessage = 'invalid_message',
  /** The command sequence was not `executedCommandSequence + 1`. Poisons every later command until resynced. */
  InvalidSequence = 'invalid_sequence',
  /** No free slot for the operation. */
  NoSlot = 'no_slot',
  /** Rate limit or cooldown hit. */
  RateLimited = 'rate_limited',
  /** The action is not permitted to be acknowledged. */
  NotAckable = 'not_ackable',
  /** The server-side handler threw. */
  HandlerError = 'handler_error',
  /**
   * Only ever a client-side inference. The server never sends it.
   *
   * Synthesised when the server's own `executedCommandSequence` has advanced past a command we sent
   * without ever acknowledging it.
   */
  DroppedStale = 'dropped_stale',
  /** `commandType` is the literal string `"unknown"`. */
  UnknownCommandType = 'unknown_command_type',
}

/** Narrow an arbitrary wire string to a known code, or `null`. */
export function parseResultCode(code: string | undefined): ResultCode | null {
  if (!code) return null;
  const values = Object.values(ResultCode) as string[];
  return values.includes(code) ? (code as ResultCode) : null;
}

/**
 * A parsed command rejection.
 *
 * Note that `InvalidSequence` is the only code with a defined recovery: jump the sequencer forward to
 * the server's frontier plus one. Everything else is the caller's problem to retry or abandon.
 */
export interface CommandRejection {
  code: ResultCode | null;
  /** The raw code string as received, when it was not one we recognise. */
  rawCode?: string;
  /** The `commandType` the server reported. `"unknown"` means it could not parse our action. */
  commandType: string;
  /** True when the server did not recognise the action at all. */
  isUnknownCommandType: boolean;
  /** True when the sequencer must be resynced to frontier + 1. */
  requiresSequenceResync: boolean;
  /** True when the action may have been sent in the wrong form. */
  suggestsWrongForm: boolean;
  message: string;
}

/**
 * Interpret a failed `QuinoaCommandResult`.
 *
 * `suggestsWrongForm` is the useful bit: `invalid_message` together with `commandType: "unknown"`
 * is the documented signature of sending a wrapped action flat, and the documented remedy is
 * "try wrapping it".
 */
export function interpretRejection(commandType: string, code: string | undefined): CommandRejection {
  const parsed = parseResultCode(code);
  const isUnknownCommandType = commandType === 'unknown';
  const suggestsWrongForm = parsed === ResultCode.InvalidMessage || (isUnknownCommandType && !code);

  let message: string;
  switch (parsed) {
    case ResultCode.InvalidMessage:
      message =
        `Server rejected "${commandType}" as invalid_message. If this action should be wrapped, ` +
        'flip its form via FormRegistry.setActionForm(name, "wrapped").';
      break;
    case ResultCode.InvalidSequence:
      message =
        'Command sequence was not executedCommandSequence + 1. Resync the sequencer to the ' +
        "server's frontier + 1. Every later command fails until you do.";
      break;
    case ResultCode.NoSlot:
      message = `Server reported no_slot for "${commandType}".`;
      break;
    case ResultCode.RateLimited:
      message = `Server rate-limited "${commandType}".`;
      break;
    case ResultCode.NotAckable:
      message = `"${commandType}" is not ackable.`;
      break;
    case ResultCode.HandlerError:
      message = `Server-side handler error for "${commandType}".`;
      break;
    case ResultCode.DroppedStale:
      message = `"${commandType}" was dropped as stale.`;
      break;
    default:
      message = isUnknownCommandType
        ? `Server did not recognise the action (commandType "unknown"). This is the documented ` +
          'signature of sending a wrapped action flat. Try wrapping it.'
        : `Command "${commandType}" was rejected${code ? ` with code "${code}"` : ''}.`;
      break;
  }

  const rejection: CommandRejection = {
    code: parsed,
    commandType,
    isUnknownCommandType,
    requiresSequenceResync: parsed === ResultCode.InvalidSequence,
    suggestsWrongForm,
    message,
  };
  if (code !== undefined && parsed === null) rejection.rawCode = code;
  return rejection;
}
