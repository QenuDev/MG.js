/** The typed action surface, the registry that describes it, and the handles it returns. */

export { GAME_ACTION_METHOD_COUNT, GameActions } from './game-actions.js';
export type { AckMatchMethod, CommandFailureReason, CommandResult, CommandSender } from './handle.js';
export { CommandHandle, failureResult } from './handle.js';
export * from './params.js';
export type { ActionCategory, ActionSpec, FormRegistryOptions } from './registry.js';
export {
  ACTION_NAMES,
  ACTION_SPECS,
  defaultFormRegistry,
  FLAT_ALLOWLIST,
  FormRegistry,
  getActionSpec,
  scopeForForm,
} from './registry.js';
export type { CommandRejection } from './result-codes.js';
export { interpretRejection, parseResultCode, ResultCode } from './result-codes.js';
export type { CommandSequencerOptions, OutstandingCommand, SequenceStrategy } from './sequencer.js';
export {
  CommandSequencer,
  FrontierAnchoredStrategy,
  MAX_REPORTED_STALE,
  MonotonicStrategy,
} from './sequencer.js';
