/**
 * The reconnect policy.
 *
 * The shape is not invented here: `ReconnectConfig` in `@mg.js/common` carries it verbatim from the
 * protocol recon, which reports what all three reference projects broadly agree on:
 *
 *   > "exponential from a small base (~1.5s), doubling per attempt, capped around 60s, plus jitter so
 *   > many clients don't retry in lockstep. Superseded closes get a longer base delay (order of 30s)
 *   > since retrying instantly just gets superseded again. A brand-new session's very first attempt
 *   > gets a handful of fast retries."
 *
 * Two rules in here matter rather than being cosmetic, and both come from §1.8's close-code table:
 *
 *   1. **A superseded close (`4250`/`4300`) must NOT be retried quickly.** The doc's own reasoning:
 *      "Retrying instantly just gets superseded again." So the base delay switches to
 *      `supersededBaseDelayMs` (default 30s), and the resulting `reclaimSupersededSession=true` on the
 *      next connect is what actually makes the retry succeed. See `HeadlessClient`.
 *   2. **A stale build (`4710`) must re-resolve the version before reconnecting.** That is not a delay
 *      decision at all, so the disposition (not this file) owns it; the delay for a `4710` is
 *      an ordinary first-step backoff.
 *
 * The disposition itself is **never re-derived here**. `analyzeClose(code, reason, wasManual)` from the
 * common package is the single source of truth for "what should happen after this close", including the
 * documented `4300`/heartbeat-reason disambiguation ("check the reason string doesn't say `heartbeat`
 * before treating it as a real supersede"). This file only turns a disposition into a *delay* and an
 * attempt budget, and it is written so the delay sequence is a pure function that can be asserted
 * without a socket.
 *
 * WHERE THIS GOES BEYOND WHAT IS DOCUMENTED, AND WHY THAT IS SAFE
 * --------------------------------------------------------------
 * The protocol doc says nothing about whether a successful connection should reset the attempt
 * counter. This implementation resets it **only after a `Welcome` has actually been received**, and
 * the alternative was worse: resetting on a bare socket `open` lets a server that accepts and
 * immediately drops connections keep the client in a tight loop forever, because every attempt would
 * look like a fresh session. `Welcome` is the protocol's own definition of a session having started
 * (§1.6: "the connection is now 'welcomed'"), so it is the honest boundary. The doc's
 * `coldStartFastRetries` is *not* per-session-cycle here for the same reason: it is "a brand-new
 * session's" allowance, and a session begins at `Welcome`.
 */

import type { CloseAnalysis, ReconnectConfig, TransportCloseInfo } from '@mg.js/common';
import { analyzeClose, DEFAULT_RECONNECT as DEFAULT_RECONNECT_POLICY } from '@mg.js/common';

/**
 * The default policy, taken from its one home rather than restated.
 *
 * This used to be a literal copy of `DEFAULT_RECONNECT` under a comment claiming the two "cannot
 * drift". A copy under a cannot-drift comment is the one thing that certainly can: the seven values
 * agreed only because a person kept them in step. Re-exporting the object also makes its identity
 * assertable, as `tests/reconnect.test.ts` now does.
 *
 * It is imported under this name and re-exported rather than written as a direct re-export-from clause
 * against `@mg.js/common`: such a clause introduces no local binding, and this module merges the object
 * into every `ReconnectPolicy` instance, so it needs one.
 */
export { DEFAULT_RECONNECT_POLICY };

/**
 * The context a delay is computed from.
 *
 * Small and primitive so the function is trivially testable and so callers cannot smuggle
 * an unrelated policy decision in through it.
 */
export interface BackoffContext {
  /**
   * 1-based attempt number. Attempt 1 is the *first* connection; the first reconnect is attempt 2.
   *
   * This matches `ConnectOptions.connectionAttempt`, which the protocol defines as "`1` for the first
   * connection with this `documentId`, incrementing by one per retry" (§1.4), so the same number is
   * used for the URL and for the backoff, and the two can never disagree.
   */
  attempt: number;
  /** The classification of the close that triggered this retry. */
  close: CloseAnalysis | null;
  /**
   * True when no `Welcome` has been received for this document id yet.
   *
   * Only a brand-new session gets the fast retries; see the file header.
   */
  coldStart: boolean;
  /** Injected randomness in `[0, 1)`: `Math.random` in production, a constant in tests. */
  random?: number | undefined;
}

/** A computed retry decision. */
export interface BackoffPlan {
  /** Milliseconds to wait before the next attempt. */
  delayMs: number;
  /** The attempt number this delay precedes (i.e. `attempt`). */
  attempt: number;
  /** True when the fast cold-start window applied, so no backoff was applied at all. */
  coldStartFast: boolean;
  /** True when `supersededBaseDelayMs` was used as the base. */
  superseded: boolean;
  /** True when the raw exponential step exceeded `maxDelayMs` and was capped. */
  capped: boolean;
  /** The un-jittered, uncapped exponential step, for logging and tests. */
  rawDelayMs: number;
  /** Human-readable justification, for logs. */
  reason: string;
}

/**
 * Compute the delay before the next connection attempt.
 *
 * Pure: same inputs, same output (given the same `random`). This is the function the unit tests assert
 * against, and the only place a delay is ever calculated.
 *
 * Order of decisions, and why this order:
 *   1. **Superseded wins over cold start.** A supersede is an identity conflict; retrying in 50ms
 *      either loses the race again or (worse) supersedes whoever won. The delay is the fix.
 *   2. **Cold start**: no backoff at all for the first `coldStartFastRetries` attempts of a session.
 *      The doc is explicit that these are "fast, un-backed-off attempts"; applying a delay here would
 *      make the setting meaningless.
 *   3. **Ordinary exponential backoff**, then jitter, then the `maxDelayMs` clamp.
 *
 * @throws {RangeError} for an attempt number below 1, or for a policy whose delays are negative. Both
 *   are programming errors and returning a nonsense delay would hide them inside a reconnect loop.
 */
export function computeBackoff(config: ReconnectConfig, context: BackoffContext): BackoffPlan {
  if (!Number.isFinite(context.attempt) || context.attempt < 1) {
    throw new RangeError(`Backoff attempt must be a finite number >= 1, received ${context.attempt}.`);
  }
  if (config.baseDelayMs < 0 || config.maxDelayMs < 0 || config.supersededBaseDelayMs < 0) {
    throw new RangeError('Reconnect delays must not be negative.');
  }

  const superseded = context.close?.isSuperseded === true;
  const random = clampUnit(context.random ?? Math.random());

  if (superseded) {
    const base = Math.max(config.supersededBaseDelayMs, 0);
    // Same convention as the ordinary branch below: attempt 1 is the connection that was superseded, so
    // the *first* superseded retry (attempt 2) uses the superseded base itself, not twice it. Doubling
    // then reaches the 60s ceiling at attempt 3, which is the "order of 30s, then back off" cadence the
    // doc describes rather than "60s, then 60s".
    const raw = base * 2 ** Math.max(0, context.attempt - 2);
    const capped = raw > config.maxDelayMs;
    const bounded = Math.min(raw, config.maxDelayMs);
    return {
      // Jitter first, then clamp. That is the same order as the ordinary branch below, and for the same
      // reason: clamping only the pre-jitter value makes `maxDelayMs` a lie (with the default
      // `jitter: 0.25`, a documented 60s cap yields 75s). `capped` is already `true` here, so an
      // unclamped result would contradict the field below as well.
      delayMs: Math.min(
        config.maxDelayMs,
        Math.max(0, Math.round(bounded * jitterFactor(config.jitter, random))),
      ),
      attempt: context.attempt,
      coldStartFast: false,
      superseded: true,
      capped,
      rawDelayMs: raw,
      reason:
        context.close?.reason ??
        'Session superseded: a longer base delay is required, and the retry must set reclaimSupersededSession=true.',
    };
  }

  if (context.coldStart && context.attempt <= Math.max(0, config.coldStartFastRetries)) {
    return {
      delayMs: 0,
      attempt: context.attempt,
      coldStartFast: true,
      superseded: false,
      capped: false,
      rawDelayMs: 0,
      reason: `Cold-start fast retry ${context.attempt}/${config.coldStartFastRetries}: no Welcome has been received yet, so retry immediately.`,
    };
  }

  // Attempt 1 is the first connection and is never itself a retry; the first retry is attempt 2 and
  // must use the *base* delay, not 2x it. Hence `attempt - 2`.
  const step = Math.max(0, context.attempt - 2);
  const raw = config.baseDelayMs * 2 ** step;
  const capped = raw > config.maxDelayMs;
  const bounded = Math.min(raw, config.maxDelayMs);

  return {
    // Jitter is applied and *then* clamped. The other order, clamp and then multiply by `1 ± jitter`, makes
    // `maxDelayMs` a lie: with the default `jitter: 0.25` a documented 60s cap yields up to 75s, so a caller
    // who set it for server-politeness gets 25% more than they asked for. Both reference clients have the
    // clamp-then-jitter shape (`RoomClient.kt` even adds a flat +1000ms over its cap); this is the fix.
    delayMs: Math.min(
      config.maxDelayMs,
      Math.max(0, Math.round(bounded * jitterFactor(config.jitter, random))),
    ),
    attempt: context.attempt,
    coldStartFast: false,
    superseded: false,
    capped,
    rawDelayMs: raw,
    reason: context.close?.reason ?? `Exponential backoff step ${step} from ${config.baseDelayMs}ms base.`,
  };
}

/**
 * Whether a close should be acted on at all.
 *
 * Thin wrapper over `analyzeClose` so callers cannot forget the `wasManual` argument, the one that
 * turns "the server dropped us" into "we asked for this" and stops a clean `disconnect()` from
 * triggering a reconnect.
 *
 * `supersedeConfirmed` is threaded rather than left to the caller because it is the one input that turns
 * a refused reconnect into an allowed one, and it should reach `analyzeClose` by one route only.
 */
export function classifyClose(
  info: TransportCloseInfo,
  options: { localShutdown?: boolean; supersedeConfirmed?: boolean } = {},
): CloseAnalysis {
  const wasManual = info.wasManual || options.localShutdown === true;
  return analyzeClose(info.code, info.reason, wasManual, {
    ...(options.supersedeConfirmed !== undefined ? { supersedeConfirmed: options.supersedeConfirmed } : {}),
  });
}

/** `1 ± jitter`, so the delay is scaled by a factor in `[1 - jitter, 1 + jitter]`. */
function jitterFactor(jitter: number, random: number): number {
  const amount = Math.min(Math.max(jitter, 0), 1);
  return 1 - amount + 2 * amount * random;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  // `random` is documented as `[0, 1)`, but accepting 1 keeps the factor at its upper bound rather
  // than overshooting it.
  return value > 1 ? 1 : value;
}

/** Options for {@link ReconnectPolicy}. */
export interface ReconnectPolicyOptions {
  /** Partial policy; anything omitted falls back to {@link DEFAULT_RECONNECT_POLICY}. */
  config?: Partial<ReconnectConfig> | undefined;
  /** Injected randomness, for deterministic tests. Defaults to `Math.random`. */
  random?: (() => number) | undefined;
}

/**
 * Stateful companion to {@link computeBackoff}: tracks the attempt budget for one document id and
 * hands out delays.
 *
 * Holds no timers and no socket: it is a bookkeeper, so its decisions can be asserted in isolation.
 *
 * It does **not** own the attempt number. `HeadlessClient` writes
 * `clientConnectionAttempt` into the connect URL (§1.4), so `HeadlessClient` owns that integer and hands
 * it back here; one owner is what keeps the URL and the backoff from drifting apart. What this class keeps
 * is where the current *session* began: a bookmark the budgets are counted from, reset on `Welcome`.
 */
export class ReconnectPolicy {
  readonly config: ReconnectConfig;

  private readonly random: () => number;
  /**
   * The attempt number of the first connection of the current session, or `0` before any `Welcome`.
   *
   * Set only by {@link markEstablished}. It is a bookmark, not a counter: the attempt number itself is
   * owned by the client.
   */
  private sessionFirstAttemptValue = 0;
  private coldStartValue = true;

  constructor(options: ReconnectPolicyOptions = {}) {
    this.config = { ...DEFAULT_RECONNECT_POLICY, ...options.config };
    this.random = options.random ?? Math.random;
  }

  /** True while no `Welcome` has been received for this document id. */
  get coldStart(): boolean {
    return this.coldStartValue;
  }

  /**
   * How many connection attempts the current session has made by the time attempt `connectionAttempt` is
   * reached.
   *
   * `connectionAttempt` is the §1.4 `clientConnectionAttempt` number of an attempt, the same integer the
   * URL carries. Before any `Welcome` the session begins at attempt 1; after one, it begins at the attempt
   * that was welcomed. This is the budget quantity and never a number that goes on the wire, so it is a
   * count of `attempt`s rather than an attempt number.
   */
  sessionAttempts(connectionAttempt: number): number {
    const first = this.sessionFirstAttemptValue === 0 ? 1 : this.sessionFirstAttemptValue;
    return Math.max(0, connectionAttempt - first + 1);
  }

  /** How many retries the current session has made by the time attempt `connectionAttempt` is reached. */
  retriesMade(connectionAttempt: number): number {
    return Math.max(0, this.sessionAttempts(connectionAttempt) - 1);
  }

  /**
   * Describe the delay before the attempt numbered `attempt`, which is the number that attempt will carry
   * in its connect URL.
   *
   * The number is a parameter, not a counter this class owns: the client writes it into the URL, so the
   * client is the only honest owner. Call once per connect, immediately before opening the socket.
   */
  nextAttempt(close: CloseAnalysis | null, attempt: number): BackoffPlan {
    return computeBackoff(this.config, {
      attempt,
      close,
      coldStart: this.coldStartValue,
      random: this.random(),
    });
  }

  /**
   * Mark the session as established, recording the attempt number it was established on.
   *
   * Called on `Welcome`, the protocol's own definition of "this connection is a session" (§1.6). This is
   * the *only* thing that resets the session budget (and it clears cold start), so a server that accepts
   * and immediately drops connections cannot keep the client in a fast loop: those drops all belong to the
   * session that has not been welcomed yet.
   */
  markEstablished(connectionAttempt: number): void {
    this.sessionFirstAttemptValue = connectionAttempt;
    this.coldStartValue = false;
  }

  /**
   * Whether another connection attempt is allowed under `maxAttempts`, given the number of the attempt
   * that just closed.
   *
   * `maxAttempts` is a cap on **total** attempts in a session, the initial connection included, because
   * that is the only reading under which the number in the config is the number of connections a caller
   * will see on the wire. (`@mg.js/common` describes it as a "hard cap on consecutive attempts"; with
   * `maxAttempts: 3` this client therefore makes exactly three connections: the first, plus two retries.)
   *
   * The budget counts attempts that were actually begun, because the number comes from the client's own
   * per-attempt counter: a plan the client discards before opening a socket does not consume it.
   */
  canRetry(connectionAttempt: number): boolean {
    return this.sessionAttempts(connectionAttempt) < this.config.maxAttempts;
  }

  /**
   * Plan the retry after a close, or refuse it.
   *
   * `connectionAttempt` is the §1.4 number of the connection that just closed, so the plan returned is for
   * attempt `connectionAttempt + 1`, the same integer the client will write into that attempt's URL.
   *
   * Returns `null` when the policy says stop: reconnect disabled, `analyzeClose` said `stop` (manual
   * close or normal closure), the disposition is `refresh` (a page-level staleness a socket retry cannot
   * fix, which is the bootstrapped client's problem, surfaced rather than looped), or a budget is
   * exhausted.
   *
   * The budget is checked against the attempt that *would* be made, **before** the plan is handed out, so
   * the last permitted retry is scheduled and the next one refused: `maxAttempts` attempts in
   * total, never one more.
   */
  planRetry(close: CloseAnalysis, connectionAttempt: number): BackoffPlan | null {
    if (!this.config.enabled) return null;
    if (!close.shouldReconnect) return null;
    if (close.disposition === 'refresh') return null;
    if (!this.canRetry(connectionAttempt)) return null;

    const prospective = connectionAttempt + 1;

    // A bounded disposition (`4800`, auth failure) must not be retried forever: the doc's own words are
    // "don't hammer a bad cookie forever". `maxAttempts` is the caller's hard cap; this is the policy's
    // own smaller one, and it has its own setting (`boundedRetryCap`) so widening the cold-start window
    // cannot widen this one: the two policies the old single field served really are independent now.
    if (close.isBounded && this.retriesMade(prospective) > Math.max(1, this.config.boundedRetryCap)) {
      return null;
    }

    return this.nextAttempt(close, prospective);
  }

  /**
   * Sleep for a plan's delay.
   *
   * The timer is **not** `unref()`ed. A pending reconnect is real outstanding work: if the
   * process has nothing else to do, exiting instead of reconnecting would look like a crash-loop
   * bug. (`StandaloneTransport`'s *open timeout* is unref'd, because waiting for a socket that will
   * never open must not by itself hold the process up.)
   *
   * `signal`, when supplied, cuts the wait short: a shutdown must not serve out a backoff that can reach
   * `maxDelayMs` (60 s by default). It **resolves rather than rejects** on abort, because every caller
   * already re-checks its own shutdown flag on the next line; rejecting would only add a catch arm that
   * has nothing new to say.
   *
   * The abort listener is removed on *both* paths. A signal is long-lived (one `AbortController` covers
   * every retry of a session), so a listener left behind per attempt would accumulate for the lifetime of
   * the client.
   */
  static async sleep(plan: BackoffPlan, signal?: AbortSignal): Promise<void> {
    const delayMs = plan.delayMs;
    if (delayMs <= 0) return;
    if (signal?.aborted) return;
    await new Promise<void>((resolve) => {
      // Re-checked inside the executor as well: aborting between the guard above and the listener
      // registration below would otherwise leave the wait to run its full course.
      if (signal?.aborted) {
        resolve();
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, delayMs);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
