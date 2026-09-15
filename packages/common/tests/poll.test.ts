/**
 * `pollUntil`, the one deadline poll, and `watchUntil`, the cancellable watch built on it.
 *
 * The five loops these replace disagreed about the only question that matters: what the end of the window
 * *means* (resolve a fallback / reject / call back / fall silent / never). The merge makes the loop
 * agnostic and pushes the meaning to the call site, so most of the assertions below are about the two
 * knobs that encode the disagreement: `firstAttempt` (now, or after one interval?) and `onTimeout`
 * (an answer, a throw, or silence?). The stop's totality is what lets `watchUntil` be a
 * cancellable watch rather than an uncancellable promise.
 *
 * No real time and no timer global: the scheduler is injected, which is the reason this module can live
 * in `common` at all.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { PollClock } from '../src/poll.ts';
import { pollUntil, unrefTimer, watchUntil } from '../src/poll.ts';

/** A scheduler the test drives by hand: `runNext()` fires the tick with the smallest `at`. */
function fakeClock(start = 0): PollClock & {
  runNext: () => boolean;
  readonly pending: number;
} {
  const queue: Array<{ at: number; callback: () => void; handle: unknown }> = [];
  let now = start;
  let nextHandle = 0;
  return {
    schedule: (callback: () => void, delayMs: number): unknown => {
      const handle = nextHandle++;
      queue.push({ at: now + delayMs, callback, handle });
      return handle;
    },
    cancelSchedule: (handle: unknown): void => {
      const index = queue.findIndex((queued) => queued.handle === handle);
      if (index >= 0) queue.splice(index, 1);
    },
    now: (): number => now,
    /** Advance to the next queued tick, never past the one with the smallest `at`, and fire it. */
    runNext(): boolean {
      queue.sort((a, b) => a.at - b.at);
      const next = queue.shift();
      if (next === undefined) return false;
      now = next.at;
      next.callback();
      return true;
    },
    get pending(): number {
      return queue.length;
    },
  };
}

// --------------------------------------------------------------------------------------
// pollUntil: the end of the window is the caller's answer
// --------------------------------------------------------------------------------------

void test('pollUntil answers the first non-null attempt and stops scheduling', async () => {
  const clock = fakeClock();
  let calls = 0;
  const promise = pollUntil<string>({
    attempt: () => (++calls >= 3 ? 'ready' : null),
    timeoutMs: 1_000,
    intervalMs: 100,
    ...clock,
  });
  for (let i = 0; i < 5; i += 1) clock.runNext();
  assert.equal(await promise, 'ready');
  assert.equal(calls, 3);
  assert.equal(clock.pending, 0, 'nothing stays scheduled after the answer');
});

void test('a closed window resolves null and calls onTimeout exactly once', async () => {
  const clock = fakeClock();
  let calls = 0;
  const seen: number[] = [];
  const promise = pollUntil<string>({
    attempt: () => {
      calls += 1;
      return null;
    },
    timeoutMs: 200,
    intervalMs: 100,
    ...clock,
    onTimeout: (attempts) => {
      seen.push(attempts);
      return null;
    },
  });
  for (let i = 0; i < 5; i += 1) clock.runNext();
  assert.equal(await promise, null, 'giving up is an answer, not a rejection');
  assert.equal(calls, 3, 'ticks at 0, 100 and 200 ms; the third closes the window');
  assert.deepEqual(seen, [3], 'onTimeout runs once, with the attempt count');
  assert.equal(clock.pending, 0, 'a closed window schedules nothing further');
});

void test("onTimeout's return value is the closed window's answer", async () => {
  const clock = fakeClock();
  const promise = pollUntil<string>({
    attempt: () => null,
    timeoutMs: 0,
    intervalMs: 100,
    ...clock,
    onTimeout: () => 'the fallback',
  });
  assert.equal(await promise, 'the fallback');
});

void test("pollUntil is total: an attempt that throws is the caller's problem, not a hung promise", async () => {
  // Documents the boundary rather than assuming it: `pollUntil` does not swallow `attempt`'s throw, so a
  // site that needs a total loop must not let `attempt` throw. `getCtors`'s attempt does not catch; its
  // derivation returns `null` for a stage it cannot read (`bootstrapped/src/render/ctors.ts:855-869`),
  // which is how that site stays total without a `try`.
  await assert.rejects(
    pollUntil<never>({
      attempt: () => {
        throw new Error('boom');
      },
      timeoutMs: 1,
      intervalMs: 1,
      ...fakeClock(),
    }),
    /boom/,
  );
});

// --------------------------------------------------------------------------------------
// firstAttempt: the timing the merge must not silently change
// --------------------------------------------------------------------------------------

void test("firstAttempt: 'afterInterval' waits one interval before the first attempt", () => {
  const clock = fakeClock();
  let calls = 0;
  const delays: number[] = [];
  pollUntil<boolean>({
    attempt: () => {
      calls += 1;
      return null;
    },
    timeoutMs: 1_000,
    intervalMs: 40,
    schedule: (callback, delayMs) => {
      delays.push(delayMs);
      return clock.schedule(callback, delayMs);
    },
    now: clock.now,
    firstAttempt: 'afterInterval',
  });
  assert.equal(calls, 0, 'a caller that already probed once must not probe again in the same frame');
  assert.deepEqual(delays, [40], 'the first attempt is scheduled at the interval, not at zero');
  clock.runNext();
  assert.equal(calls, 1);
});

void test('the default first attempt runs immediately, before anything is scheduled', () => {
  const clock = fakeClock();
  let calls = 0;
  const delays: number[] = [];
  pollUntil<boolean>({
    attempt: () => {
      calls += 1;
      return null;
    },
    timeoutMs: 1_000,
    intervalMs: 40,
    schedule: (callback, delayMs) => {
      delays.push(delayMs);
      return clock.schedule(callback, delayMs);
    },
    now: clock.now,
  });
  assert.equal(calls, 1, 'a caller that has not tried yet must not wait a whole interval to answer');
  assert.deepEqual(delays, [40]);
  clock.runNext();
  assert.equal(calls, 2);
});

// --------------------------------------------------------------------------------------
// watchUntil: a stop the caller can actually hold
// --------------------------------------------------------------------------------------

void test('the stop cancels a pending tick', () => {
  const clock = fakeClock();
  let calls = 0;
  const stop = watchUntil<never>({
    attempt: () => {
      calls += 1;
      return null;
    },
    timeoutMs: 1_000,
    intervalMs: 10,
    firstAttempt: 'afterInterval',
    ...clock,
  });
  assert.equal(clock.pending, 1);
  stop();
  assert.equal(clock.pending, 0, 'stop must cancel the tick it queued');
  clock.runNext();
  assert.equal(calls, 0, 'and the cancelled tick must not run');
});

void test('a stop from inside attempt suppresses the delivery', () => {
  const clock = fakeClock();
  const found: string[] = [];
  const stop = watchUntil<string>({
    attempt: () => {
      // The leak the old `watchForRoomConnection` had to guard by hand: a value produced after the stop.
      stop();
      return 'too late';
    },
    onFound: (value) => found.push(value),
    timeoutMs: 1_000,
    intervalMs: 10,
    firstAttempt: 'afterInterval',
    ...clock,
  });
  clock.runNext();
  assert.deepEqual(found, [], 'a caller that stopped is never handed a value afterwards');
});

void test('watchUntil calls onFound once and then stops scheduling', () => {
  const clock = fakeClock();
  const found: string[] = [];
  let calls = 0;
  watchUntil<string>({
    attempt: () => (++calls === 2 ? 'ready' : null),
    onFound: (value) => found.push(value),
    timeoutMs: 1_000,
    intervalMs: 10,
    firstAttempt: 'afterInterval',
    ...clock,
  });
  for (let i = 0; i < 5; i += 1) clock.runNext();
  assert.deepEqual(found, ['ready']);
  assert.equal(calls, 2);
  assert.equal(clock.pending, 0);
});

void test('an infinite window keeps ticking until the caller stops it', () => {
  // `AttachedTransport`'s readiness poll: a level observer, not a deadline poll. It must never time out,
  // and it must still be stoppable, which is the half of I5 that applies to it.
  const clock = fakeClock();
  let calls = 0;
  const stop = watchUntil<never>({
    attempt: () => {
      calls += 1;
      return null;
    },
    timeoutMs: Number.POSITIVE_INFINITY,
    intervalMs: 10,
    firstAttempt: 'afterInterval',
    ...clock,
  });
  for (let i = 0; i < 50; i += 1) clock.runNext();
  assert.equal(calls, 50, 'an infinite window never closes on its own');
  assert.equal(clock.pending, 1);
  stop();
  assert.equal(clock.pending, 0);
});

// --------------------------------------------------------------------------------------
// The one-home assertions: a second copy is a second end-of-window meaning
// --------------------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Every `.ts` under `dir`, recursively, built with `path.join(dir, entry.name)`.
 *
 * Hand-rolled rather than `readdirSync(dir, { recursive: true })` + `Dirent.parentPath`: `recursive` needs
 * Node 20.1 and `parentPath` needs Node 20.12, while the root `engines.node` promises `>=20`.
 */
function collectTsFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectTsFiles(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
}

/** Every `.ts` under the three packages' `src` trees, as absolute paths. A copy has to live in one. */
function everySourceFile(): string[] {
  const out: string[] = [];
  for (const pkg of ['common', 'headless', 'bootstrapped']) {
    collectTsFiles(join(repoRoot, 'packages', pkg, 'src'), out);
  }
  return out;
}

/** The same, plus every `tests` tree: two of the deadline loops this phase deleted lived in test helpers. */
function everySourceOrTestFile(): string[] {
  const out: string[] = [];
  for (const pkg of ['common', 'headless', 'bootstrapped']) {
    collectTsFiles(join(repoRoot, 'packages', pkg, 'src'), out);
    collectTsFiles(join(repoRoot, 'packages', pkg, 'tests'), out);
  }
  return out;
}

const POLL_MODULE = join(repoRoot, 'packages', 'common', 'src', 'poll.ts');

void test('exactly one file in `packages/*/src` declares the poll helpers', () => {
  const declaring = everySourceFile().filter((file) =>
    /^\s*export function (?:pollUntil|unrefTimer|watchUntil)\b/m.test(readFileSync(file, 'utf8')),
  );
  assert.deepEqual(
    declaring.map((file) => file.slice(repoRoot.length + 1)),
    ['packages/common/src/poll.ts'],
    'a second declaration is a second end-of-window meaning',
  );
});

void test('no source or test file outside the poll module still hand-rolls a deadline loop', () => {
  // Anchored on the *shape* of the loop rather than on the spellings this phase happened to delete. The old
  // guard matched `const tick` or `>= timeoutMs|deadline`, so a copy written as `const poll` with `>= endAt`
  // was invisible, and test files were not scanned at all. A deadline loop is a comparison between a clock
  // read (or an elapsed/attempt counter) and a deadline-shaped value; the second clause also catches a bare
  // cursor compared with a deadline in a file that reschedules, whatever the cursor is called.
  const TIME_SOURCE = String.raw`(?:Date\.now\(\)|performance\.now\(\)|(?:\w+\.)?now\(\)|(?:\w+\.)?startedAt\b|(?:\w+\.)?startTime\b|(?:\w+\.)?elapsed\w*|(?:\w+\.)?attempts?\b|(?:\w+\.)?tries\b|\w*[Ww]aited\b)`;
  const DEADLINE = String.raw`\w*(?:[Dd]eadline|[Ee]ndAt|[Ee]ndTime|[Ee]xpir\w*|[Tt]imeout\w*|[Bb]udget\w*|[Mm]axWait\w*|[Rr]emaining\w*)`;
  const CMP = '(?:>=|<=|<|>)';
  const CLOCK_VS_DEADLINE = new RegExp(
    String.raw`${TIME_SOURCE}\s*${CMP}\s*(?:[A-Za-z_$][\w$]*\.)*${DEADLINE}\b` +
      String.raw`|(?:[A-Za-z_$][\w$]*\.)*${DEADLINE}\b\s*${CMP}\s*${TIME_SOURCE}`,
  );
  const CURSOR_VS_DEADLINE = new RegExp(String.raw`[\w$)\]]\s+${CMP}\s+(?:[A-Za-z_$][\w$]*\.)*${DEADLINE}\b`);
  const RESCHEDULES = /(?:setTimeout|setInterval|requestAnimationFrame)\s*\(|\bschedule\s*\(/;
  /** The number of deadline comparisons in `source`, counting lines so a *second* loop in a known file shows. */
  const countLoops = (source: string): number => {
    const reschedules = RESCHEDULES.test(source);
    return source
      .split('\n')
      .filter((line) => CLOCK_VS_DEADLINE.test(line) || (reschedules && CURSOR_VS_DEADLINE.test(line)))
      .length;
  };
  // This file carries the rule's own text (`const tick`, `>= timeoutMs`), so it is not a loop.
  const POLL_TEST = fileURLToPath(import.meta.url);
  const offenders = everySourceOrTestFile()
    .filter((file) => file !== POLL_MODULE && file !== POLL_TEST)
    .map((file) => ({ file: file.slice(repoRoot.length + 1), loops: countLoops(readFileSync(file, 'utf8')) }))
    .filter((entry) => entry.loops > 0)
    .map((entry) => `${entry.file}:${entry.loops}`);
  // The three headless test-local `until` helpers are the known residue from before this phase (they are a
  // task of their own, not deleted here). Pinning each file *and its loop count* keeps the guard's teeth: a
  // new hand-rolled loop, a re-introduced copy of one this phase deleted, or a second loop beside a known
  // one all change this list and fail.
  assert.deepEqual(
    offenders,
    ['packages/headless/tests/reconnect-chain.test.ts:1', 'packages/headless/tests/version-loop.test.ts:2'],
    'a new hand-rolled deadline loop drifts from the poll module',
  );
  // The module itself must still contain the deadline, or the assertion above is vacuous.
  assert.match(readFileSync(POLL_MODULE, 'utf8'), />=\s*options\.timeoutMs\b/);
});

void test('`common/src/poll.ts` names no timer global and no platform API', () => {
  // DESIGN §6 I9: `common` compiles with no DOM and no `node:*`. The scheduler is injected for exactly
  // this reason, so the source text is the assertion, since there is no runtime behaviour to observe.
  //
  // Comments are stripped first: a doc comment that *names* `setTimeout` to explain why it must not be
  // called is not a platform dependency, and asserting on prose would make the guard unable to document
  // the rule it enforces.
  const source = readFileSync(POLL_MODULE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  for (const banned of [
    'setTimeout',
    'setInterval',
    'setImmediate',
    'queueMicrotask',
    'requestAnimationFrame',
    'clearTimeout',
    'window.',
    'document.',
    'node:',
    'Buffer',
  ]) {
    assert.ok(!source.includes(banned), `common/src/poll.ts must not name ${banned} (DESIGN I9)`);
  }
});

// --------------------------------------------------------------------------------------
// unrefTimer: one Node-timer teardown (Task 3.4b, separately rejectable)
// --------------------------------------------------------------------------------------

void test('unrefTimer leaves a browser handle alone and never throws', () => {
  // A browser's timer handle is a number, and a timer-like object may have a hostile `unref`. Two of the
  // copies this replaces called `unref` with no guard at all, so a throwing `unref` took down the caller's
  // teardown path; this asserts the guard the merge adopts.
  assert.doesNotThrow(() => unrefTimer(42));
  assert.doesNotThrow(() => unrefTimer(null));
  assert.doesNotThrow(() => unrefTimer(undefined));
  assert.doesNotThrow(() => unrefTimer({}));
  assert.doesNotThrow(() => unrefTimer({ unref: 'not a function' }));
  assert.doesNotThrow(() =>
    unrefTimer({
      unref: () => {
        throw new Error('unref blew up');
      },
    }),
  );
});

void test('unrefTimer calls unref on the object, with the object as this', () => {
  const calls: string[] = [];
  const timer = {
    unref(this: unknown) {
      calls.push(this === timer ? 'bound' : 'unbound');
    },
  };
  unrefTimer(timer);
  assert.deepEqual(calls, ['bound'], 'an unbound call would throw on a real Node Timeout');
});

void test('the Node-timer teardown is spelled once, apart from the copy Phase 2 Task 2.5 owns', () => {
  const TEARDOWN = /'unref' in|unref\?\.\(\)/;
  const offenders = everySourceFile()
    .filter((file) => file !== POLL_MODULE)
    .filter((file) => TEARDOWN.test(readFileSync(file, 'utf8')))
    .map((file) => file.slice(repoRoot.length + 1));
  assert.deepEqual(offenders, ['packages/headless/src/client.ts'], 'a second teardown drifts from this one');
});
