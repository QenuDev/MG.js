/**
 * The backoff sequence, as a pure function.
 *
 * `computeBackoff` is the only place a reconnect delay is ever calculated, so these tests are the whole
 * specification of the retry cadence. The properties that matter are the ones the protocol recon states:
 * exponential from `baseDelayMs`, doubling, capped at `maxDelayMs`, jittered, with a longer base after a
 * supersede and no delay at all during a brand-new session's fast retries.
 *
 * `random: 0.5` is used wherever a deterministic number is needed: the jitter factor is
 * `1 - jitter + 2·jitter·random`, which is exactly `1` at `random = 0.5`, so the delay equals the raw
 * exponential step. That keeps the assertions about doubling and capping readable instead of
 * full of ±25% arithmetic.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ReconnectConfig } from '@mg.js/common';
import { analyzeClose, CloseCode, DEFAULT_RECONNECT } from '@mg.js/common';

import {
  classifyClose,
  computeBackoff,
  DEFAULT_RECONNECT_POLICY,
  ReconnectPolicy,
} from '../src/reconnect.js';

/** The policy with jitter neutralised, so assertions are exact. */
const FLAT: ReconnectConfig = { ...DEFAULT_RECONNECT_POLICY };

describe('computeBackoff: ordinary closes', () => {
  it('uses the base delay for the first retry, not twice it', () => {
    // Attempt 1 is the connection that just failed; the retry is attempt 2 and must use baseDelayMs.
    const plan = computeBackoff(
      { ...FLAT, coldStartFastRetries: 0 },
      { attempt: 2, close: analyzeClose(CloseCode.GoingAway, '', false), coldStart: false, random: 0.5 },
    );
    assert.equal(plan.delayMs, 1500);
    assert.equal(plan.capped, false);
    assert.equal(plan.superseded, false);
  });

  it('doubles per attempt up to the cap', () => {
    const config: ReconnectConfig = { ...FLAT, coldStartFastRetries: 0 };
    const delay = (attempt: number): number =>
      computeBackoff(config, { attempt, close: null, coldStart: false, random: 0.5 }).delayMs;

    assert.deepEqual([2, 3, 4, 5, 6, 7].map(delay), [1500, 3000, 6000, 12_000, 24_000, 48_000]);
    // 96s is above the 60s ceiling, so it clamps.
    assert.equal(delay(8), 60_000);
    assert.equal(delay(20), 60_000);
  });

  it('reports capping rather than silently truncating', () => {
    const plan = computeBackoff(
      { ...FLAT, coldStartFastRetries: 0 },
      { attempt: 9, close: null, coldStart: false, random: 0.5 },
    );
    assert.equal(plan.capped, true);
    assert.equal(plan.rawDelayMs, 1500 * 2 ** 7);
    assert.equal(plan.delayMs, 60_000);
  });

  it('scales by 1 ± jitter around the raw step', () => {
    const config: ReconnectConfig = { ...FLAT, coldStartFastRetries: 0 };
    const context = { attempt: 3, close: null, coldStart: false };

    const low = computeBackoff(config, { ...context, random: 0 }).delayMs;
    const mid = computeBackoff(config, { ...context, random: 0.5 }).delayMs;
    const high = computeBackoff(config, { ...context, random: 1 }).delayMs;

    assert.equal(mid, 3000);
    assert.equal(low, Math.round(3000 * 0.75));
    assert.equal(high, Math.round(3000 * 1.25));
    assert.ok(low < mid && mid < high);
  });

  it('never produces a negative delay, even for jitter > 1', () => {
    const plan = computeBackoff(
      { ...FLAT, jitter: 5, coldStartFastRetries: 0 },
      { attempt: 2, close: null, coldStart: false, random: 0 },
    );
    assert.ok(plan.delayMs >= 0);
  });
});

describe('computeBackoff: superseded closes', () => {
  it('switches to the longer superseded base', () => {
    const plan = computeBackoff(
      { ...FLAT, coldStartFastRetries: 0 },
      {
        // 4300 without "heartbeat" in the reason is a real supersede, so 30s replaces 1.5s.
        attempt: 2,
        close: analyzeClose(CloseCode.SupersededByNewerSession, 'newer user session', false),
        coldStart: false,
        random: 0.5,
      },
    );
    assert.equal(plan.superseded, true);
    assert.equal(plan.delayMs, 30_000);
    assert.equal(plan.coldStartFast, false);
  });

  it('beats the cold-start fast path, because retrying instantly gets superseded again', () => {
    const plan = computeBackoff(
      { ...FLAT, coldStartFastRetries: 3 },
      {
        attempt: 1,
        close: analyzeClose(CloseCode.Superseded, '', false),
        coldStart: true,
        random: 0.5,
      },
    );
    assert.equal(plan.coldStartFast, false);
    assert.equal(plan.delayMs, 30_000);
  });

  it('does not treat a heartbeat supersede as a real super session', () => {
    // §1.8: "check the reason string doesn't say `heartbeat` before treating it as a real supersede".
    const analysis = analyzeClose(CloseCode.SupersededByNewerSession, 'heartbeat', false);
    assert.equal(analysis.isSuperseded, false);
    const plan = computeBackoff(
      { ...FLAT, coldStartFastRetries: 0 },
      { attempt: 2, close: analysis, coldStart: false, random: 0.5 },
    );
    assert.equal(plan.superseded, false);
    assert.equal(plan.delayMs, 1500);
  });
});

describe('computeBackoff: cold start', () => {
  it('allows the configured number of un-backed-off attempts', () => {
    const config: ReconnectConfig = { ...FLAT, coldStartFastRetries: 3 };
    const plans = [1, 2, 3].map((attempt) =>
      computeBackoff(config, { attempt, close: null, coldStart: true, random: 0.5 }),
    );
    for (const plan of plans) {
      assert.equal(plan.coldStartFast, true);
      assert.equal(plan.delayMs, 0);
    }
  });

  it('falls back to normal backoff once the window closes', () => {
    const config: ReconnectConfig = { ...FLAT, coldStartFastRetries: 3 };
    const plan = computeBackoff(config, { attempt: 4, close: null, coldStart: true, random: 0.5 });
    assert.equal(plan.coldStartFast, false);
    // Attempt 4 => step 2 => 1500 * 4.
    assert.equal(plan.delayMs, 6000);
  });

  it('applies no fast retries when the session was already established', () => {
    const config: ReconnectConfig = { ...FLAT, coldStartFastRetries: 3 };
    const plan = computeBackoff(config, { attempt: 2, close: null, coldStart: false, random: 0.5 });
    assert.equal(plan.coldStartFast, false);
    assert.equal(plan.delayMs, 1500);
  });
});

describe('computeBackoff: input validation', () => {
  it('rejects an attempt number below 1', () => {
    assert.throws(() => computeBackoff(FLAT, { attempt: 0, close: null, coldStart: true }), RangeError);
    assert.throws(() => computeBackoff(FLAT, { attempt: NaN, close: null, coldStart: true }), RangeError);
  });

  it('rejects negative delays in a policy', () => {
    assert.throws(
      () => computeBackoff({ ...FLAT, baseDelayMs: -1 }, { attempt: 2, close: null, coldStart: false }),
      RangeError,
    );
  });
});

describe('classifyClose', () => {
  it('turns a manual close into stop, the disposition that suppresses reconnect', () => {
    const analysis = classifyClose({ code: 1000, reason: '', wasClean: true, wasManual: true });
    assert.equal(analysis.disposition, 'stop');
    assert.equal(analysis.shouldReconnect, false);
  });

  it('treats a local shutdown as manual even when the transport disagrees', () => {
    const analysis = classifyClose(
      { code: 1006, reason: 'socket died', wasClean: false, wasManual: false },
      { localShutdown: true },
    );
    assert.equal(analysis.disposition, 'stop');
  });

  it('routes 4710 to a version refetch and 4400 to an immediate reconnect', () => {
    const stale = classifyClose({ code: 4710, reason: '', wasClean: true, wasManual: false });
    assert.equal(stale.disposition, 'refetch-version');
    assert.equal(stale.requiresVersionRefetch, true);

    const idle = classifyClose({ code: 4400, reason: '', wasClean: true, wasManual: false });
    assert.equal(idle.disposition, 'reconnect');
    assert.equal(idle.requiresVersionRefetch, false);
  });
});

describe('ReconnectPolicy: attempt accounting', () => {
  it('numbers attempts the way the URL does: 1500, 3000, 6000 for the first three retries', () => {
    const policy = new ReconnectPolicy({ random: () => 0.5, config: { coldStartFastRetries: 0 } });
    // `1` is the attempt number of the connection that just closed, the same integer §1.4 writes into
    // that connection's URL; the retry it plans is attempt 2. Successive closes therefore plan attempts
    // 2, 3 and 4, and the documented cadence is 1500, 3000, 6000.
    policy.markEstablished(1);
    const close = analyzeClose(CloseCode.GoingAway, '', false);

    assert.equal(policy.planRetry(close, 1)?.delayMs, 1500);
    assert.equal(policy.planRetry(close, 2)?.delayMs, 3000);
    assert.equal(policy.planRetry(close, 3)?.delayMs, 6000);
  });

  it('caps a bounded disposition with boundedRetryCap, not coldStartFastRetries', () => {
    const policy = new ReconnectPolicy({
      random: () => 0.5,
      config: { coldStartFastRetries: 10, boundedRetryCap: 2 },
    });
    const authClose = analyzeClose(CloseCode.AuthFailed, 'bad jwt', false);
    assert.equal(authClose.isBounded, true);

    // `boundedRetryCap: 2` admits two bounded retries; `coldStartFastRetries: 10` must not widen that.
    assert.notEqual(policy.planRetry(authClose, 1), null);
    assert.notEqual(policy.planRetry(authClose, 2), null);
    assert.equal(policy.planRetry(authClose, 3), null);
  });

  it('counts a session budget that resets only once a session is established', () => {
    const policy = new ReconnectPolicy({
      random: () => 0.5,
      config: { coldStartFastRetries: 2, maxAttempts: 4 },
    });

    // Before any Welcome the session starts at attempt 1, and `coldStartFastRetries: 2` makes attempts 1
    // and 2 un-backed-off, so the first retry, attempt 2, is fast and attempt 3 is not.
    assert.equal(policy.nextAttempt(null, 2).coldStartFast, true);
    assert.equal(policy.nextAttempt(null, 3).coldStartFast, false);
    assert.equal(policy.sessionAttempts(3), 3);
    assert.equal(policy.retriesMade(3), 2);

    // A Welcome means a session actually started: the budget is counted from the attempt that was
    // welcomed, while the URL's attempt number keeps counting.
    policy.markEstablished(1);
    assert.equal(policy.coldStart, false);
    assert.equal(policy.sessionAttempts(1), 1);
    assert.equal(policy.retriesMade(1), 0);
    assert.equal(policy.retriesMade(2), 1);
  });

  it('refuses to retry when reconnect is disabled', () => {
    const policy = new ReconnectPolicy({ config: { enabled: false } });
    assert.equal(policy.planRetry(analyzeClose(CloseCode.GoingAway, '', false), 1), null);
  });

  it('refuses to retry after a stop disposition', () => {
    const policy = new ReconnectPolicy({ random: () => 0.5 });
    assert.equal(policy.planRetry(analyzeClose(1000, '', true), 1), null);
  });

  it('honours maxAttempts as a hard cap on total attempts', () => {
    const policy = new ReconnectPolicy({
      random: () => 0.5,
      config: { maxAttempts: 2, coldStartFastRetries: 0 },
    });
    const close = analyzeClose(CloseCode.GoingAway, '', false);

    // `maxAttempts: 2` means two connections in total: the initial one (attempt 1), plus a single retry.
    // The close of attempt 1 plans attempt 2; the close of attempt 2 is refused.
    const plan = policy.planRetry(close, 1);
    assert.notEqual(plan, null);
    assert.equal(plan?.attempt, 2, 'the plan must carry the number the URL will write');
    assert.equal(policy.planRetry(close, 2), null);
  });

  it('exposes the documented default policy values', () => {
    const policy = new ReconnectPolicy();
    assert.equal(policy.config.baseDelayMs, 1500);
    assert.equal(policy.config.maxDelayMs, 60_000);
    assert.equal(policy.config.jitter, 0.25);
    assert.equal(policy.config.supersededBaseDelayMs, 30_000);
    assert.equal(policy.config.coldStartFastRetries, 3);
    assert.equal(policy.config.boundedRetryCap, 3);
  });
});

describe('DEFAULT_RECONNECT_POLICY: one home, not two literals', () => {
  it('is the common package’s object, re-exported under the headless name', () => {
    // Identity, not deep equality: two objects with the same seven numbers is the state this
    // test exists to forbid, and `assert.deepEqual` would pass on the bug. The old copy's comment
    // claimed the two "cannot drift" while being the one thing that certainly could.
    assert.equal(
      DEFAULT_RECONNECT_POLICY,
      DEFAULT_RECONNECT,
      'DEFAULT_RECONNECT_POLICY must be the one object from @mg.js/common, not a twin of it',
    );
  });
});
