/**
 * Coexistence with other mods: branded identity-guarded hooks, the envelope predicate, and
 * renumber-on-send.
 *
 * `src/index.ts` re-exports this barrel wholesale (Phase 5 Task 5.6a).
 */

export type {
  Branded,
  InstalledHook,
  InstallHookOptions,
  InstallOutcome,
  PreviousFn,
  SlotClass,
} from './brand.js';
export {
  attemptTeardown,
  brandLabelOf,
  brandWrapper,
  classifySlot,
  installHook,
  isBranded,
  MARKER_KEY,
  MARKER_LABEL_KEY,
  restoreSlot,
} from './brand.js';
export type {
  CommandEnvelope,
  InstallRenumberHookOptions,
  ObserveResult,
  RenumbererOptions,
  RenumberHookHandle,
  RenumberHookReason,
  RenumberStats,
  RewriteResult,
  SendSlot,
} from './renumber.js';
export {
  applyRenumbering,
  asEnvelope as asCommandEnvelope,
  installRenumberHook,
  MAX_REMEMBERED_IDS,
  Renumberer,
} from './renumber.js';
