/**
 * Command sequencing.
 *
 * "The server numbers commands per connection. `Welcome.executedCommandSequence` is the last command
 * number the server has executed; the next one you send must be that value plus one."
 *
 * Two failure modes, both silent:
 *   - a *duplicate* sequence number is dropped without a word;
 *   - a *gap* produces `invalid_sequence`, and then **every later command fails too** until resynced.
 *
 * The two clients need different policies, so the counter is shared and the policy is a
 * strategy:
 *
 *   - {@link MonotonicStrategy}: the headless case. We are the only writer on the socket, so a
 *     plain incrementing counter is correct and cheapest.
 *   - {@link FrontierAnchoredStrategy}: the bootstrapped case. The game has its own module-private
 *     counter and no idea we exist; the moment we send one command, both counters have silently
 *     claimed the same number for different things. So we read the server's own confirmed frontier
 *     before stamping, jump forward when it has run ahead of us, and heal backward when the server
 *     tells us we gapped.
 */

import { asSequence, isCanonicalSequence } from '../protocol/codec.js';
import { ResultCode } from './result-codes.js';

/**
 * The sequence rule, that a sequence is a non-negative integer, has one home: {@link isCanonicalSequence} in
 * `protocol/codec.ts`, the wire-contract layer and the module that reads a frontier off the wire. This
 * re-export keeps the name `protocol/index.ts` and the strategies below already publish, on the same
 * function object, so there is still one implementation of the rule and no second one beside it.
 */
export { isCanonicalSequence };

/** A command that has been stamped and sent but not yet accounted for. */
export interface OutstandingCommand {
  sequence: number;
  action: string;
  requestId: string;
  sentAt: number;
  /** Filled in once the command is acknowledged, rejected, or inferred dropped. */
  settled: boolean;
}

/** The policy a sequencer delegates its numbering decisions to. */
export interface SequenceStrategy {
  /** The next sequence number to stamp, without consuming it. */
  peek(): number;
  /**
   * Claim the next sequence number.
   *
   * @param action The action being sent, for diagnostics.
   * @param isOwn Whether the frame is ours (true) or the host game's own traffic (false, only ever
   *   observed by the bootstrapped send-hook).
   */
  take(action: string, isOwn: boolean): number;
  /** The server reported it has executed up to this sequence number. */
  observeFrontier(frontier: number): void;
  /** A command came back `invalid_sequence`; heal to the given frontier (or the last known one). */
  healAfterInvalidSequence(frontier?: number): void;
  /** Re-seed from a fresh `Welcome`. A non-canonical value is ignored. */
  reseed(executedCommandSequence: number): void;
  /**
   * Un-issue the most recently taken number, which never reached the wire.
   *
   * Implementations must refuse if anything was issued after it.
   */
  rollbackLast(sequence: number): void;
  /** The highest sequence number handed out. */
  readonly lastIssued: number;
  /** The highest frontier the server has confirmed, or `null` before any observation. */
  readonly frontier: number | null;
}

/**
 * Plain counter, seeded once from `Welcome`, that never falls behind the server's own frontier.
 *
 * Correct whenever this client is the only writer on the socket, which is the headless case, since
 * there is no host game and no other mod.
 *
 * It still honours the frontier, and that is not belt-and-braces. `executedCommandSequence` is the
 * server telling us authoritatively "I have already executed up to N". If our next number is at or
 * below N, that number has been used: sending it produces a *duplicate*, which the server drops
 * without a word. So the counter jumps forward to `frontier + 1` rather than assuming it is still in
 * step. A lost ack, a dropped outbound frame, or a command the server executed but we never counted
 * would all otherwise strand us one number behind, silently, forever.
 *
 * The distinction from {@link FrontierAnchoredStrategy} is not *whether* it jumps but *when it looks*:
 * this one only reacts to frontiers it has actually observed in the frame stream, while that one
 * consults a live external reader before every single stamp.
 */
export class MonotonicStrategy implements SequenceStrategy {
  private nextValue: number;
  private lastIssuedValue: number;
  private frontierValue: number | null = null;
  /** Number of times we jumped forward because the confirmed frontier had reached us. */
  private forwardJumps = 0;

  constructor(executedCommandSequence = 0) {
    // The one rule, at the caller boundary: a fraction is malformed input and reads as "no seed", exactly
    // as `Renumberer.reseed` reads it. Without this, `new MonotonicStrategy(2.5)` started at `3.5` and
    // `take()` recorded `3.5` in the ledger; only `buildFrame`'s gate stopped it at the wire.
    const seed = asSequence(executedCommandSequence) ?? 0;
    this.nextValue = seed + 1;
    this.lastIssuedValue = seed;
  }

  /** Pull our next number up to just past the confirmed frontier, when it has reached us. */
  private syncToFrontier(): void {
    if (this.frontierValue !== null && this.frontierValue >= this.nextValue) {
      this.nextValue = this.frontierValue + 1;
      this.forwardJumps += 1;
    }
  }

  peek(): number {
    this.syncToFrontier();
    return this.nextValue;
  }

  take(): number {
    this.syncToFrontier();
    const value = this.nextValue;
    this.nextValue += 1;
    this.lastIssuedValue = value;
    return value;
  }

  observeFrontier(frontier: number): void {
    if (!isCanonicalSequence(frontier)) return;
    if (this.frontierValue === null || frontier > this.frontierValue) {
      this.frontierValue = frontier;
    }
  }

  healAfterInvalidSequence(frontier?: number): void {
    // A caller-supplied frontier is untrusted in the same way the wire's is, so it goes through the one
    // rule: a non-canonical argument is "no evidence" and the last confirmed frontier stands, rather than
    // healing the counter onto `2.5`.
    const target = asSequence(frontier) ?? this.frontierValue;
    if (target === null) return;
    this.nextValue = target + 1;
  }

  reseed(executedCommandSequence: number): void {
    const seed = asSequence(executedCommandSequence);
    if (seed === null) return;
    this.nextValue = seed + 1;
    this.lastIssuedValue = seed;
    this.frontierValue = seed;
  }

  rollbackLast(sequence: number): void {
    // Only if this really is the newest number, and the frontier has not moved past it.
    if (this.lastIssuedValue !== sequence) return;
    if (this.frontierValue !== null && this.frontierValue >= sequence) return;
    this.nextValue = sequence;
    this.lastIssuedValue = sequence - 1;
  }

  get lastIssued(): number {
    return this.lastIssuedValue;
  }

  get frontier(): number | null {
    return this.frontierValue;
  }

  /** Diagnostics: how often the forward correction fired. */
  get stats(): { forwardJumps: number } {
    return { forwardJumps: this.forwardJumps };
  }
}

/**
 * Frontier-anchored counter for a socket shared with the host game and possibly other mods.
 *
 * Before stamping, consult `getFrontier()`. If the server has already confirmed a sequence at or
 * past our next number, jump to `frontier + 1`; otherwise we would send a duplicate, which is
 * dropped silently. On `invalid_sequence`, resync down to `frontier + 1` immediately: "a desync
 * costs at most the one command that tripped it, not every command after it."
 *
 * The asymmetry is deliberate: the frontier is a *lower* bound on what the server has executed, so
 * jumping forward is safe and healing backward is only ever done on explicit server evidence.
 */
export class FrontierAnchoredStrategy implements SequenceStrategy {
  private nextValue: number;
  private lastIssuedValue: number;
  private frontierValue: number | null;
  private readonly getFrontier: (() => number | null | undefined) | undefined;
  /** Number of times we jumped forward because the frontier had run past us. */
  private forwardJumps = 0;
  /** Number of times we healed backward after an invalid_sequence. */
  private backwardHeals = 0;

  constructor(
    options: {
      executedCommandSequence?: number;
      /** Live reader for the server's confirmed frontier. Called before every stamp. */
      getFrontier?: () => number | null | undefined;
    } = {},
  ) {
    // The same caller-boundary gate as `MonotonicStrategy`: a fractional `executedCommandSequence` is not a
    // frontier, so it is treated as absent (`frontierValue` stays `null`, "no evidence") rather than making
    // the first stamp `3.5`.
    const seed = asSequence(options.executedCommandSequence);
    this.nextValue = (seed ?? 0) + 1;
    this.lastIssuedValue = seed ?? 0;
    this.frontierValue = seed;
    this.getFrontier = options.getFrontier;
  }

  /** Pull the live frontier from the injected reader, if the caller supplied one. */
  private currentFrontier(): number | null {
    if (this.getFrontier) {
      const live = this.getFrontier();
      if (isCanonicalSequence(live)) {
        this.observeFrontier(live);
      }
    }
    return this.frontierValue;
  }

  peek(): number {
    const frontier = this.currentFrontier();
    if (frontier !== null && frontier >= this.nextValue) return frontier + 1;
    return this.nextValue;
  }

  take(): number {
    const frontier = this.currentFrontier();
    if (frontier !== null && frontier >= this.nextValue) {
      // The server has already run past our next number, so another writer renumbered independently.
      this.nextValue = frontier + 1;
      this.forwardJumps += 1;
    }
    const value = this.nextValue;
    this.nextValue += 1;
    this.lastIssuedValue = value;
    return value;
  }

  observeFrontier(frontier: number): void {
    if (!isCanonicalSequence(frontier)) return;
    if (this.frontierValue === null || frontier > this.frontierValue) {
      this.frontierValue = frontier;
    }
  }

  healAfterInvalidSequence(frontier?: number): void {
    // As in `MonotonicStrategy`: malformed evidence is no evidence, so the last confirmed frontier stands.
    const target = asSequence(frontier) ?? this.frontierValue;
    if (target === null) return;
    if (target + 1 !== this.nextValue) this.backwardHeals += 1;
    this.nextValue = target + 1;
  }

  reseed(executedCommandSequence: number): void {
    const seed = asSequence(executedCommandSequence);
    if (seed === null) return;
    this.nextValue = seed + 1;
    this.lastIssuedValue = seed;
    this.frontierValue = seed;
  }

  rollbackLast(sequence: number): void {
    if (this.lastIssuedValue !== sequence) return;
    if (this.frontierValue !== null && this.frontierValue >= sequence) return;
    this.nextValue = sequence;
    this.lastIssuedValue = sequence - 1;
  }

  get lastIssued(): number {
    return this.lastIssuedValue;
  }

  get frontier(): number | null {
    return this.frontierValue;
  }

  /** Diagnostics: how often each correction path fired. */
  get stats(): { forwardJumps: number; backwardHeals: number } {
    return { forwardJumps: this.forwardJumps, backwardHeals: this.backwardHeals };
  }
}

/** Options for {@link CommandSequencer}. */
export interface CommandSequencerOptions {
  /** Overrides the strategy. Defaults to a {@link MonotonicStrategy}. */
  strategy?: SequenceStrategy;
  /** Live frontier reader; only meaningful for the frontier-anchored strategy. */
  getFrontier?: () => number | null | undefined;
  /** How long an unacknowledged command stays outstanding before it is inferred dropped, in ms. */
  staleAfterMs?: number;
}

/**
 * How many dropped sequence numbers a {@link CommandSequencer} remembers before it forgets the oldest.
 *
 * The memory exists to stop a *repeat* inference, not to keep a history: a sequence can only be
 * reported while its command is still outstanding, so a few hundred entries cover any plausible burst.
 * Without the cap the map grew for the whole life of a connection, which is the unbounded-growth half of
 * I5 that Task 2.9 closes. Once a sequence falls out, an identically numbered command that is taken
 * again could in principle be reported stale a second time: a bounded cost, accepted by design.
 */
export const MAX_REPORTED_STALE = 1024;

/**
 * Owns the sequence counter, the outstanding-command ledger, and the `DroppedStale` inference.
 *
 * The ledger is what makes `DroppedStale` possible: the server never sends that code, so the only
 * way to know a command was silently overtaken is to compare the frontier against commands we sent
 * and never heard about.
 */
export class CommandSequencer {
  private strategy: SequenceStrategy;
  private readonly outstanding = new Map<number, OutstandingCommand>();
  private readonly staleAfterMs: number;
  /**
   * Sequence numbers already inferred dropped, so we never report the same one twice.
   *
   * A `Map` rather than a `Set` because it has to be *bounded* (I5): insertion order is the eviction
   * order, so the entry forgotten first is the oldest one. `reportedStaleCount` reports its size.
   */
  private readonly reportedStale = new Map<number, true>();

  constructor(options: CommandSequencerOptions = {}) {
    this.strategy = options.strategy ?? new MonotonicStrategy(0);
    if (options.getFrontier && this.strategy instanceof MonotonicStrategy) {
      // A caller asking for frontier anchoring but passing no strategy gets the useful one.
      this.strategy = new FrontierAnchoredStrategy({ getFrontier: options.getFrontier });
    }
    this.staleAfterMs = options.staleAfterMs ?? 30_000;
  }

  /**
   * Seed from `Welcome.executedCommandSequence`.
   *
   * Also clears the ledger: after a reconnect the server's numbering restarts from its own state, and
   * carrying stale outstanding commands across that boundary would produce phantom `DroppedStale`
   * reports.
   */
  seed(executedCommandSequence: number): void {
    if (!isCanonicalSequence(executedCommandSequence)) {
      throw new RangeError('CommandSequencer.seed expects a non-negative integer sequence.');
    }
    this.strategy.reseed(executedCommandSequence);
    this.outstanding.clear();
    this.reportedStale.clear();
  }

  /**
   * Claim the next sequence number and record it as outstanding.
   *
   * @param action The action wire string, for diagnostics and rejection messages.
   * @param requestId The correlation id stamped into the envelope.
   * @param isOwn False when observing the host game's own traffic through the send-hook.
   */
  take(action: string, requestId: string, isOwn = true): number {
    const sequence = this.strategy.take(action, isOwn);
    if (isOwn) {
      this.outstanding.set(sequence, {
        sequence,
        action,
        requestId,
        sentAt: Date.now(),
        settled: false,
      });
    }
    return sequence;
  }

  /** The sequence number that would be stamped next. */
  peek(): number {
    return this.strategy.peek();
  }

  /** The highest sequence number issued so far. */
  get lastIssued(): number {
    return this.strategy.lastIssued;
  }

  /** The highest confirmed server frontier, or `null`. */
  get frontier(): number | null {
    return this.strategy.frontier;
  }

  /** The live strategy, for diagnostics or a deliberate swap. */
  get activeStrategy(): SequenceStrategy {
    return this.strategy;
  }

  /**
   * Record that the server has executed up to `frontier`, and infer any commands it silently
   * overtook.
   *
   * The protocol doc's third failure mode: a command that is neither acknowledged nor rejected, but simply
   * never happens. If the frontier has passed a sequence we still have outstanding, that command is
   * gone, not pending.
   *
   * A non-canonical value is not a frontier at all, and the loop below must see it exactly as the
   * strategies do. The gate has to live here as well as in each strategy: the loop compares the *raw*
   * argument, so without it a fractional `RoomFrame.executedCommandSequence` (I4) could not move the
   * counter yet would still overtake a live, legitimate command and fail it as `dropped_stale`.
   */
  observeFrontier(frontier: number): { dropped: OutstandingCommand[] } {
    if (!isCanonicalSequence(frontier)) return { dropped: [] };
    this.strategy.observeFrontier(frontier);

    const dropped: OutstandingCommand[] = [];
    for (const entry of this.outstanding.values()) {
      if (!entry.settled && entry.sequence <= frontier) {
        entry.settled = true;
        this.outstanding.delete(entry.sequence);
        if (!this.reportedStale.has(entry.sequence)) {
          this.rememberReportedStale(entry.sequence);
          dropped.push(entry);
        }
      }
    }
    return { dropped };
  }

  /**
   * Record a reported sequence, evicting the oldest record once the bound is reached.
   *
   * Eviction is oldest-first because insertion order is the order the inferences happened, and the
   * oldest inference is the one whose command is least likely to still be outstanding.
   */
  private rememberReportedStale(sequence: number): void {
    this.reportedStale.set(sequence, true);
    if (this.reportedStale.size <= MAX_REPORTED_STALE) return;
    const oldest = this.reportedStale.keys().next();
    if (!oldest.done) this.reportedStale.delete(oldest.value);
  }

  /** How many dropped sequences are still remembered. Bounded by {@link MAX_REPORTED_STALE}. */
  get reportedStaleCount(): number {
    return this.reportedStale.size;
  }

  /**
   * Confirmed the fate of a command.
   *
   * On `invalid_sequence` it also heals the counter, because a gap poisons every later command
   * until it is fixed.
   */
  settle(
    requestId: string,
    outcome: { ok: boolean; code?: string },
    frontier?: number,
  ): OutstandingCommand | null {
    let found: OutstandingCommand | null = null;
    for (const entry of this.outstanding.values()) {
      if (entry.requestId === requestId) {
        found = entry;
        break;
      }
    }
    if (found) {
      found.settled = true;
      this.outstanding.delete(found.sequence);
    }

    if (outcome.code === ResultCode.InvalidSequence || outcome.code === 'invalid_sequence') {
      this.strategy.healAfterInvalidSequence(frontier);
    }

    return found;
  }

  /**
   * Infer commands dropped purely by wall-clock staleness.
   *
   * `observeFrontier` is the reliable signal, but a server that stops advancing (or a socket that
   * dies without a close event) would otherwise leave handles pending forever. This is the backstop.
   */
  sweepStale(now = Date.now()): OutstandingCommand[] {
    const dropped: OutstandingCommand[] = [];
    for (const entry of this.outstanding.values()) {
      if (entry.settled) continue;
      if (now - entry.sentAt < this.staleAfterMs) continue;
      entry.settled = true;
      this.outstanding.delete(entry.sequence);
      this.rememberReportedStale(entry.sequence);
      dropped.push(entry);
    }
    return dropped;
  }

  /**
   * Return to the pre-Welcome starting value.
   *
   * The API reference documents `reset()` alongside `seed()` and `take()`, and is specific about when
   * to use it: "Call on a fresh connection (not a reconnect) or after a close, so a stale sequence from
   * a dead session can never leak into a new one."
   *
   * The starting value is 1: a fresh connection has executed nothing, so the first command is 1. That
   * matches `MonotonicStrategy(0)`.
   */
  reset(): void {
    this.strategy.reseed(0);
    this.outstanding.clear();
    this.reportedStale.clear();
  }

  /**
   * Give back a sequence number that never reached the wire.
   *
   * Needed because a gap poisons every later command: if `take()` is called and then the frame fails to
   * build or the transport throws, the server never sees that number, so our next command would be
   * `frontier + 2` and come back `invalid_sequence`, with every command after it failing too. Rolling
   * back keeps the counter contiguous.
   *
   * Only rolls back when nothing was issued after `sequence`, so it can never rewind over a number that
   * another frame has already used.
   *
   * @returns true when the rollback happened.
   */
  rollback(sequence: number): boolean {
    if (sequence < 0) return false;
    if (this.strategy.lastIssued !== sequence) return false;

    const entry = this.outstanding.get(sequence);
    if (entry) this.outstanding.delete(sequence);
    this.reportedStale.delete(sequence);

    this.strategy.rollbackLast(sequence);
    return true;
  }

  /** Commands sent and not yet accounted for. */
  get pending(): OutstandingCommand[] {
    return [...this.outstanding.values()];
  }

  /**
   * Force the next sequence number, e.g. after an `invalid_sequence` with no frontier available.
   *
   * A non-canonical frontier (a fraction, a negative, `NaN`) is ignored: it is evidence we cannot read, and
   * healing onto it would stamp `2.5 + 1`. `seed` is the stricter boundary: it throws, because there the
   * caller is asserting a session start rather than reporting a rejection.
   */
  resync(frontier: number): void {
    this.strategy.healAfterInvalidSequence(frontier);
  }
}
