/**
 * Cancellable waits: `ReconnectPolicy.sleep` must be abortable, and a superseded delay must honour the
 * declared `maxDelayMs`.
 *
 * Both halves are I5 ("every wait has a deadline") defects that only show up under a real timer, which
 * is why this file uses wall-clock bounds instead of a fake clock: `sleep` is a bare `setTimeout` and
 * the bug is precisely that nothing can cut it short. The bound in the first test is far
 * below the 60 s plan delay, so a passing test proves the wait was *cancelled*, not that the
 * machine happened to be fast.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ReconnectConfig } from '@mg.js/common';
import { analyzeClose, CloseCode } from '@mg.js/common';

import type { BackoffPlan } from '../src/reconnect.js';
import { computeBackoff, DEFAULT_RECONNECT_POLICY, ReconnectPolicy } from '../src/reconnect.js';

/** The policy with jitter neutralised, so the clamp assertions are exact. */
const FLAT: ReconnectConfig = { ...DEFAULT_RECONNECT_POLICY };

/** A plan that would park for a minute, long enough that an elapsing timer is unmistakable. */
const LONG_PLAN: BackoffPlan = {
  delayMs: 60_000,
  attempt: 1,
  coldStartFast: false,
  superseded: false,
  capped: true,
  rawDelayMs: 60_000,
  reason: 'test',
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('ReconnectPolicy.sleep: abortable waits', () => {
  it('resolves an aborted sleep immediately', async () => {
    const controller = new AbortController();
    const sleep = ReconnectPolicy.sleep(LONG_PLAN, controller.signal);
    controller.abort();

    const t0 = Date.now();
    const outcome = await Promise.race([
      sleep.then(() => 'resolved' as const),
      delay(200).then(() => 'timeout' as const),
    ]);
    const elapsed = Date.now() - t0;

    assert.equal(outcome, 'resolved', 'an abort must settle the sleep, not leave it to the 60 s timer');
    assert.ok(elapsed < 50, `an aborted sleep resolved after ${elapsed}ms; the plan delay was 60000ms`);
  });

  it('resolves immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const t0 = Date.now();
    await ReconnectPolicy.sleep(LONG_PLAN, controller.signal);
    const elapsed = Date.now() - t0;

    assert.ok(elapsed < 50, `an already-aborted sleep waited ${elapsed}ms; the plan delay was 60000ms`);
  });

  it('does not resolve an unaborted sleep early', async () => {
    const controller = new AbortController();
    let settled = false;
    const sleep = ReconnectPolicy.sleep({ ...LONG_PLAN, delayMs: 5000 }, controller.signal).then(() => {
      settled = true;
    });

    await delay(50);
    assert.equal(settled, false, 'the sleep resolved before its delay elapsed');

    // Leave no timer behind: cut the wait short so the test file exits promptly.
    controller.abort();
    await sleep;
    assert.equal(settled, true);
  });
});

describe('computeBackoff: superseded closes honour the cap', () => {
  it('clamps a superseded delay to maxDelayMs after jitter', () => {
    const plan = computeBackoff(
      { ...FLAT, maxDelayMs: 60_000, supersededBaseDelayMs: 30_000 },
      {
        attempt: 4,
        // 4250 without "heartbeat" in the reason is a real supersede.
        close: analyzeClose(CloseCode.UserSessionSuperseded, 'newer user session', false),
        coldStart: false,
        // `random: 1` is the worst case for the jitter multiply: factor 1.25.
        random: 1,
      },
    );

    assert.equal(plan.superseded, true);
    assert.equal(plan.capped, true);
    assert.equal(
      plan.delayMs,
      60_000,
      `a capped plan reported delayMs ${plan.delayMs}; the declared maxDelayMs is 60000`,
    );
  });
});
