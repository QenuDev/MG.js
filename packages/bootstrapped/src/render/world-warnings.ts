/**
 * Warn-once, and the error handler the world scene reports through.
 *
 * Split out of `world.ts` (Phase 5 Task 5.7c). One memo and one handler for the whole render layer, which
 * is what `warn-once.ts`'s factory is for.
 */

import { createWarnOnce } from './warn-once.js';
import type { Restore } from './world-scene.js';

/**
 * Replace a method with a no-op, recording the original for restore.
 *
 * Uses a plain assignment rather than `defineProperty` on purpose: the game's tile views are ordinary
 * objects with prototype methods, and the recorded `wasAbsent` flag tells the restore whether to delete
 * the own property (unshadowing the prototype) or put the original back. Getting that wrong would leave a
 * permanent own-property no-op shadowing the prototype `draw` after every teardown.
 */
export function recordAndWrapNoop(
  restores: Restore[],
  target: Record<string, unknown>,
  key: string,
): boolean {
  const wasAbsent = !Object.hasOwn(target, key);
  const original = target[key];
  if (typeof original !== 'function') return false;
  const wrapper = function suppressed(): void {
    // Intentionally a no-op: the documented behaviour is to suppress the game's own tile redraw.
  };
  // `applied` is the wrapper itself, so `exit()` can tell "still our no-op" from "someone replaced it".
  restores.push({ target, key, value: original, wasAbsent, applied: wrapper });
  target[key] = wrapper;
  return true;
}

/** Set a property, recording its previous value so {@link WorldScene.exit} can restore it. */
export function recordAndSet(
  restores: Restore[],
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): boolean {
  if (target[key] === value) return false;
  const wasAbsent = !Object.hasOwn(target, key);
  // `applied` is what we are about to write, so a later foreign write makes the restore a no-op.
  restores.push({ target, key, value: target[key], wasAbsent, applied: value });
  target[key] = value;
  return true;
}

/**
 * Warn once per operation string. See the note in `graphics.ts` for why once and not every frame.
 *
 * The implementation is `warn-once.ts`'s; the memo is this module's.
 */
const warn = createWarnOnce();

export function defaultWorldErrorHandler(operation: string, error: unknown): void {
  warn(operation, `WorldScene ${operation} failed`, error);
}

/** Clear the warn-once memo. Exported for tests. */
export function resetWorldWarnings(): void {
  warn.reset();
}
