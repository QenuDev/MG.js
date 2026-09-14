/**
 * Warn at most once per key, in one implementation.
 *
 * ## Why one factory and not one shared memo
 *
 * The failure paths that use this run at frame rate; a `console.warn` per frame is its own performance
 * problem and it also buries the *first* occurrence, which is the only informative one. Three modules
 * grew the same helper (`graphics.ts`, `rive.ts`, `world.ts`), each with its own memo and its own
 * exported reset.
 *
 * The memo stays **per caller** (the factory), because collapsing them into one shared `Set` would make
 * `resetWarnOnce()` in `graphics.ts` silence a warning in `world.ts` for the rest of the process. That is a
 * behaviour change no test would catch and no reader would expect. What had three homes was the
 * *implementation*, and that is what this module owns.
 *
 * ## Why the message is a parameter and not derived from the key
 *
 * The three callers key differently (`graphics` keys on the whole message, `rive` on
 * `operation:name`, `world` on `operation`) and format differently (`[mg.js] Rive setTextRunValue
 * failed`, `[mg.js] WorldScene addSprite failed`). Deriving the text from the key would change two of
 * the three consoles, so the key and the text are separate arguments and every existing string is
 * reproduced exactly.
 */

/** A warn-once function with its own reset. */
export interface WarnOnce {
  /** Log `message` and `error` the first time `key` is seen; stay silent for every later `key`. */
  (key: string, message: string, error: unknown): void;
  /** Forget every key. */
  reset(): void;
}

/** Create an independent warn-once memo. One per module, so one module's reset cannot silence another's. */
export function createWarnOnce(): WarnOnce {
  const seen = new Set<string>();
  const call = ((key: string, message: string, error: unknown): void => {
    if (seen.has(key)) return;
    seen.add(key);
    try {
      console.warn(`[mg.js] ${message} (further occurrences suppressed)`, error);
    } catch {
      // No console available.
    }
  }) as WarnOnce;
  call.reset = (): void => {
    seen.clear();
  };
  return call;
}
