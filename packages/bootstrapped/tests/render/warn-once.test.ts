/**
 * `createWarnOnce`: one implementation, one memo per caller.
 *
 * ## Why the memo is per caller and not shared
 *
 * Three render modules grew the same helper (`graphics.ts`, `rive.ts`, `world.ts`), each with its own
 * `Set` and its own exported reset. The implementation is what had three homes; the *memo* must stay per
 * caller, because collapsing the three into one shared `Set` would make `resetWarnOnce()` in
 * `graphics.ts` silence a warning in `world.ts` for the rest of the process, a behaviour change no test
 * would catch and no reader would expect. The second test below is the one that fails when the three memos
 * are collapsed into a single shared `Set`.
 *
 * ## Why the message is an argument and not derived from the key
 *
 * The three callers key differently (`graphics` on the whole message, `rive` on `operation:name`,
 * `world` on `operation`) and format differently (`[mg.js] Rive setTextRunValue failed`,
 * `[mg.js] WorldScene addSprite failed`). Deriving the text from the key would change two of the three
 * consoles, so the key and the text are separate arguments and every existing string is reproduced
 * exactly.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWarnOnce } from '../../src/render/warn-once.ts';

/** Capture `console.warn` for the duration of `body`, then restore it. */
function captureWarnings(body: () => void): unknown[][] {
  const lines: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]): void => {
    lines.push(args);
  };
  try {
    body();
  } finally {
    console.warn = original;
  }
  return lines;
}

void test('createWarnOnce logs the first key once and stays silent afterwards', () => {
  const warn = createWarnOnce();
  const lines = captureWarnings(() => {
    warn('addSprite', 'WorldScene addSprite failed', 'first');
    warn('addSprite', 'WorldScene addSprite failed', 'second');
    warn('removeSprite', 'WorldScene removeSprite failed', 'third');
  });
  assert.deepEqual(lines, [
    ['[mg.js] WorldScene addSprite failed (further occurrences suppressed)', 'first'],
    ['[mg.js] WorldScene removeSprite failed (further occurrences suppressed)', 'third'],
  ]);

  const afterReset = captureWarnings(() => {
    warn.reset();
    warn('addSprite', 'WorldScene addSprite failed', 'fourth');
  });
  assert.deepEqual(
    afterReset,
    [['[mg.js] WorldScene addSprite failed (further occurrences suppressed)', 'fourth']],
    'reset forgets every key',
  );
});

void test('two warn-once memos are independent, including their resets', () => {
  // The mutation this kills: replacing the `createWarnOnce` factory's per-call `Set` with one module-level
  // `Set` shared by every memo. Under that refactor `b('k', ...)` below is suppressed because `a` already saw
  // `'k'`, and `a.reset()` clears `b`'s key as well, so the run emits two lines instead of three, and the
  // reset stops being private. The old form of this test (`a` emits, `a.reset()`, then `b` emits) passed
  // against that refactor, so it could not pin the per-caller invariant it claimed to.
  const a = createWarnOnce();
  const b = createWarnOnce();
  const lines = captureWarnings(() => {
    a('k', 'a failed', 1);
    b('k', 'b failed', 2);
    a.reset();
    a('k', 'a failed', 3);
    b('k', 'b failed', 4);
  });
  assert.deepEqual(
    lines,
    [
      ['[mg.js] a failed (further occurrences suppressed)', 1],
      ['[mg.js] b failed (further occurrences suppressed)', 2],
      ['[mg.js] a failed (further occurrences suppressed)', 3],
    ],
    'each memo emits once per key, and a reset in one memo must not silence or un-silence another',
  );
});
