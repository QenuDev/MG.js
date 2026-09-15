/**
 * Renumber-on-send: one sequence chooser on a socket shared by several writers.
 *
 * ## The failure this exists to prevent
 *
 * The protocol gives commands a per-connection sequence number, and the server's tolerance for getting it
 * wrong is asymmetric in the worst possible way:
 *
 *   - a **duplicate** number is dropped without a word;
 *   - a **gap** is `invalid_sequence`, and then *every later command fails* until the connection resyncs.
 *
 * Now put two writers on the socket. The game has "its own module-private counter that has no idea your
 * commands exist" (recon §19). The moment a mod injects one command, both counters have claimed the same
 * number for different things. The user-visible symptom, as the companion mod's own notes describe it, is
 * one gap and then a connection that "looks frozen". That is the bug users report when they run two mods
 * at once.
 *
 * ## The documented answer, in three parts
 *
 * §19 gives three techniques and they compose:
 *
 *   1. **Renumber everything on the way out.** Stay a passive observer while you have sent nothing: watch
 *      the game's own `commandSequence` values go by and track the highest one seen. Once *you* inject a
 *      command you own the counter, and every subsequent outgoing envelope, including the game's own, is
 *      rewritten to the next number from your counter before it hits the wire. §19's words for the result
 *      are "one chooser, no collisions, and every byte is untouched vanilla behavior until the first time
 *      you actually act."
 *   2. **Anchor to the server's own frontier.** Read the server's confirmed `executedCommandSequence` before
 *      stamping; jump forward when it has run past us; heal backward on `invalid_sequence`. This "survives a
 *      second mod doing its own renumbering on the same socket: a desync costs at most the one command that
 *      tripped it, not every command after."
 *   3. **Never re-intercept your own traffic.** "detect your own previously-built envelopes (a request-id
 *      set you populate yourself) so you don't re-intercept or re-number your own outgoing traffic."
 *
 * {@link Renumberer} is parts 1-3 as one pure state machine. It has **no DOM dependency, no socket
 * dependency, and no page access**. This is on purpose: it is the highest-consequence logic in the
 * package, and it must be unit-testable without a browser (see `tests/coexistence/renumber.test.ts`).
 * The socket patch in `attach/raw-socket.ts` is a thin shell over it.
 *
 * ## Why the "nothing sent yet" phase matters more than it looks
 *
 * The temptation is to take the counter immediately and always renumber. That would be a *bug*: before we
 * send anything, renumbering the game's own frames means we are rewriting traffic in a way we have no
 * reason to, and if our numbering is wrong we have broken a session we were not even using. The passive
 * phase is the difference between "a mod that is loaded" and "a mod that is loaded and doing something".
 * The recon states it as a design principle: "every byte is untouched vanilla behavior until the first time
 * you actually act."
 */

import { asSequence } from '@mg.js/common';

import type { InstalledHook } from './brand.js';
import { brandWrapper, classifySlot, installHook, restoreSlot } from './brand.js';
import type { CommandEnvelope } from './envelope.js';
import { asEnvelope, parseEnvelope } from './envelope.js';

// The envelope predicate and its pre-parse gate have one home now (`envelope.ts`, which documents why).
// These re-exports keep working every caller that reached them through this module, including the package's
// public `exports` surface.
export type { CommandEnvelope } from './envelope.js';
export { asEnvelope } from './envelope.js';

/** What {@link Renumberer.observe} should be called with. */
export interface ObserveResult {
  /** True when a sequence number was extracted and considered. */
  sawSequence: boolean;
  /** The number seen, when there was one. */
  sequence: number | null;
  /** True when this frame carried a requestId we recognised as ours. */
  isOurs: boolean;
  /** True when the highest-seen value advanced. */
  advanced: boolean;
}

/** What {@link Renumberer.rewrite} did. */
export interface RewriteResult {
  /**
   * The frame to put on the wire.
   *
   * Identical (by reference) to the input when nothing needed changing. That is the common case in the
   * passive phase, and keeping it referentially identical means a caller can cheaply detect "we did not
   * touch this".
   */
  frame: unknown;
  /** What happened. */
  action: /** We are passive: the game number was recorded and the frame is untouched. */
    | 'observed'
    /** We own the counter and rewrote the envelope. */
    | 'renumbered'
    /** The frame was ours and already stamped correctly; untouched. */
    | 'ours'
    /** Not a `QuinoaCommand` envelope, or not an object: untouched. */
    | 'passthrough';
  /** The sequence written, when `action` is `'renumbered'` or `'ours'`. */
  sequence: number | null;
}

/** Diagnostics, because this is the kind of code that needs to explain itself in a bug report. */
export interface RenumberStats {
  /** True once we have injected a command and taken the counter. */
  owns: boolean;
  /** The highest sequence seen while passive. `-1` when none has been seen. */
  highestSeen: number;
  /** The next number we would write. */
  next: number;
  /** Frames rewritten by us. */
  renumbered: number;
  /** Frames recognised as ours and left alone. */
  oursSeen: number;
  /** Times we jumped forward to the frontier. */
  forwardJumps: number;
  /** Times an `invalid_sequence` healed us backward. */
  backwardHeals: number;
  /** Times the game's frame was passed through untouched. */
  passthroughs: number;
}

/** Options for {@link Renumberer}. */
export interface RenumbererOptions {
  /**
   * Live reader for the server's confirmed frontier.
   *
   * §19 part 2. Backed in the real client by
   * `lastDistributedRoomPublication.executedCommandSequence` (see `attach/room-connection.ts`). `null` from
   * the reader means "no evidence right now", which is not the same as zero and must not be treated as it.
   */
  getFrontier?: () => number | null | undefined;
  /** Starting sequence, when a `Welcome` was already seen. Default: no knowledge. */
  executedCommandSequence?: number;
  /**
   * A label for the branded send wrapper. Passed through to `brand.ts` for diagnostics.
   */
  label?: string;
}

/**
 * The renumbering state machine.
 *
 * Pure: it never touches a socket, a page, or a global. Feed it outbound frames with {@link rewrite} and the
 * numbers it should treat as already-executed with {@link observeFrontier}.
 */
export class Renumberer {
  private ownsCounter = false;
  private highestSeen = -1;
  private nextValue = 1;
  private frontier: number | null;
  private readonly getFrontier: (() => number | null | undefined) | undefined;

  /** Request ids we generated. The set is what makes part 3 of §19 possible. */
  private readonly ownRequestIds = new Set<string>();

  private renumberedCount = 0;
  private oursSeenCount = 0;
  private forwardJumps = 0;
  private backwardHeals = 0;
  private passthroughCount = 0;

  constructor(options: RenumbererOptions = {}) {
    this.getFrontier = options.getFrontier;
    // One rule for what counts as a sequence, shared with every other frontier read: a fractional seed is
    // malformed input, and reading it as one would make `nextValue` `3.5`, a number no counter compares.
    const seed = asSequence(options.executedCommandSequence);
    if (seed !== null) {
      this.highestSeen = seed;
      this.nextValue = seed + 1;
      this.frontier = seed;
    } else {
      this.frontier = null;
    }
  }

  /** True once we have injected a command and own the counter. */
  get owns(): boolean {
    return this.ownsCounter;
  }

  /** The highest sequence observed while passive. */
  get highest(): number {
    return this.highestSeen;
  }

  /** The next sequence our counter would produce. */
  get next(): number {
    return this.nextValue;
  }

  /** The frontier from the last read, or `null`. */
  get knownFrontier(): number | null {
    return this.frontier;
  }

  /** Full diagnostics. */
  get stats(): RenumberStats {
    return {
      owns: this.ownsCounter,
      highestSeen: this.highestSeen,
      next: this.nextValue,
      renumbered: this.renumberedCount,
      oursSeen: this.oursSeenCount,
      forwardJumps: this.forwardJumps,
      backwardHeals: this.backwardHeals,
      passthroughs: this.passthroughCount,
    };
  }

  /**
   * Register a requestId as ours.
   *
   * Call this the moment an envelope is built, *before* it is sent. That is what lets {@link isOurs}
   * recognise the frame when it comes back through the send path we are wrapping. Without that, we would
   * renumber our own command twice, the "don't re-intercept your own traffic" failure.
   *
   * Bounded: the set keeps at most {@link MAX_REMEMBERED_IDS} entries, oldest out. An unbounded set would be
   * a slow leak in a long session; a small one is sufficient because a frame passes through the send path
   * within the same tick.
   */
  remember(requestId: string): void {
    if (requestId === '') return;
    if (this.ownRequestIds.has(requestId)) this.ownRequestIds.delete(requestId);
    this.ownRequestIds.add(requestId);
    while (this.ownRequestIds.size > MAX_REMEMBERED_IDS) {
      const oldest = this.ownRequestIds.values().next();
      if (oldest.done === true) break;
      this.ownRequestIds.delete(oldest.value);
    }
  }

  /** True when a requestId is one we generated. */
  isOurs(requestId: unknown): boolean {
    return typeof requestId === 'string' && this.ownRequestIds.has(requestId);
  }

  /** Every remembered id. Diagnostics and tests. */
  get rememberedIds(): string[] {
    return [...this.ownRequestIds];
  }

  /**
   * Record the server's confirmed frontier.
   *
   * Monotonic: a lower value is ignored, because `executedCommandSequence` is a *lower bound* on what the
   * server has executed and a stale frame (a `RoomFrame` that overtook a `Welcome`, or a replay) must not
   * drag our counter backwards. Only {@link healAfterInvalidSequence} may move it down, and only on explicit
   * server evidence.
   */
  observeFrontier(frontier: number | null | undefined): void {
    // The one rule, so a fractional scraped frontier is "no evidence" rather than a counter of `3.5`.
    const checked = asSequence(frontier);
    if (checked === null) return;
    if (this.frontier === null || checked > this.frontier) {
      this.frontier = checked;
    }
    if (checked > this.highestSeen) this.highestSeen = checked;
    if (checked >= this.nextValue) {
      // The frontier has run past us. §19 part 2: "jump forward to frontier+1". Only relevant once we own
      // the counter, but tracking it regardless keeps `peekNext` honest.
      if (this.ownsCounter) this.forwardJumps += 1;
      this.nextValue = checked + 1;
    }
  }

  /**
   * Take ownership of the counter and return the next number.
   *
   * This is the "first time *you* inject a command" moment, and it is the *only* transition into the active
   * phase. Returns the number to stamp on the injected frame.
   */
  claimNext(): number {
    if (!this.ownsCounter) {
      this.ownsCounter = true;
      // On claim, reconcile with the live frontier before producing a number. Without this, a mod that
      // loaded ten seconds ago would immediately emit a duplicate of a number the game has already used.
      this.pullFrontier();
    }
    return this.take();
  }

  /**
   * Inspect an outbound frame without changing it.
   *
   * The passive-phase half of part 1: "watch the game's own `commandSequence` values go by and track the
   * highest one seen."
   */
  observe(frame: unknown): ObserveResult {
    const envelope = asEnvelope(frame);
    if (envelope === null) {
      return { sawSequence: false, sequence: null, isOurs: false, advanced: false };
    }

    const isOurs = this.isOurs(envelope.requestId);
    if (isOurs) this.oursSeenCount += 1;

    // Our own frames do not advance the passive high-water mark either: they are already accounted for by
    // our own counter, and folding them back in would make the two counters fight.
    if (isOurs) {
      return { sawSequence: false, sequence: null, isOurs: true, advanced: false };
    }

    const sequence = asSequence(envelope.commandSequence);
    if (sequence === null) {
      return { sawSequence: false, sequence: null, isOurs: false, advanced: false };
    }

    const advanced = sequence > this.highestSeen;
    if (advanced) {
      this.highestSeen = sequence;
      // While passive, the game's number IS the counter position; stay exactly one behind it. Once we own
      // the counter, the game's frames are about to be rewritten by us, so its numbers are irrelevant.
      if (!this.ownsCounter) this.nextValue = sequence + 1;
    }
    return { sawSequence: true, sequence, isOurs: false, advanced };
  }

  /**
   * Rewrite an outbound frame's sequence number.
   *
   * The whole decision, in order:
   *
   *   1. Not a `QuinoaCommand` envelope, or not an object → `'passthrough'`, byte-identical, by reference.
   *   2. A frame whose requestId **is ours** → `'ours'`: already stamped by us when it was built, so
   *      rewriting it would consume a second number for one command. This is §19's part 3 and it is checked
   *      *before* the ownership test, because our own frames exist in both phases.
   *   3. Passive phase → `'observed'`: record the number, return the frame untouched. §19 part 1's promise:
   *      "every byte is untouched vanilla behavior until the first time you actually act."
   *   4. Active phase → `'renumbered'`: stamp the next number from *our* counter, including on the game's own
   *      frames. This is the part §19 describes as "rewrite every subsequent outgoing envelope, including the
   *      game's own" (quoted at the top of this file), and it is what leaves one chooser.
   *
   * Returns a **new** object rather than mutating the input. Mutating would be marginally cheaper, but the
   * input may be a live object the game still holds a reference to (some builds build the envelope once and
   * send it repeatedly on retry), and mutating that would silently change the game's own retry payload.
   */
  rewrite(frame: unknown): RewriteResult {
    const envelope = asEnvelope(frame);
    if (envelope === null) {
      this.passthroughCount += 1;
      return { frame, action: 'passthrough', sequence: null };
    }

    if (this.isOurs(envelope.requestId)) {
      const sequence = asSequence(envelope.commandSequence);
      return { frame, action: 'ours', sequence };
    }

    if (!this.ownsCounter) {
      this.observe(frame);
      return { frame, action: 'observed', sequence: asSequence(envelope.commandSequence) };
    }

    const sequence = this.take();
    const rewritten: CommandEnvelope = { ...envelope, commandSequence: sequence };
    this.renumberedCount += 1;
    return { frame: rewritten, action: 'renumbered', sequence };
  }

  /**
   * Heal after the server rejects a command as `invalid_sequence`.
   *
   * §19 part 2: "If a command comes back rejected as `invalid_sequence`, resync down to frontier+1
   * immediately." Called with the frontier at the moment of rejection when the caller has a fresher value
   * than ours.
   *
   * The asymmetry against {@link observeFrontier} is the whole point: jumping *forward* is always safe
   * because the frontier is a lower bound; healing *backward* is only done on this explicit server evidence,
   * because a stale frontier read would otherwise make us re-send numbers the server has already executed.
   */
  healAfterInvalidSequence(frontier?: number | null): void {
    // A caller-supplied frontier is untrusted in the same way the wire's is. `resyncSequence`
    // passes whatever a rejection handler read, so it goes through the one rule too. A non-canonical value
    // is "no evidence" and leaves our current frontier standing, rather than healing to `2.5 + 1`.
    const target = asSequence(frontier) ?? this.frontier;
    if (target === null) return;
    this.frontier = target;
    if (this.nextValue !== target + 1) this.backwardHeals += 1;
    this.nextValue = target + 1;
  }

  /**
   * Reseed from a fresh `Welcome`.
   *
   * A reconnect restarts the server's numbering. Carrying the old counter across that boundary would gap
   * immediately, so the state resets to the passive phase. That also means the next command we inject
   * takes the counter again, which is the intended behavior.
   */
  reseed(executedCommandSequence: number): void {
    const seed = asSequence(executedCommandSequence);
    if (seed === null) return;
    this.ownsCounter = false;
    this.highestSeen = seed;
    this.nextValue = seed + 1;
    this.frontier = seed;
  }

  /** The number {@link take} would produce, without consuming it. Consults the live frontier first. */
  peekNext(): number {
    this.pullFrontier();
    return this.nextValue;
  }

  private take(): number {
    this.pullFrontier();
    const value = this.nextValue;
    this.nextValue += 1;
    if (value > this.highestSeen) this.highestSeen = value;
    return value;
  }

  /**
   * Consult the injected frontier reader.
   *
   * Called before every stamp rather than once at install, because the frontier moves every frame and a
   * stamp based on a stale read is the duplicate the server drops silently.
   */
  private pullFrontier(): void {
    if (this.getFrontier === undefined) return;
    let value: number | null | undefined;
    try {
      value = this.getFrontier();
    } catch {
      // A frontier reader that throws (a half-torn-down room connection) must not stop us from stamping.
      return;
    }
    this.observeFrontier(value);
  }
}

/**
 * How many of our own request ids to remember.
 *
 * 256 is far more than the one-tick window actually needs, and small enough that the membership test stays
 * free. The bound exists so a long-lived session cannot leak one string per command forever.
 */
export const MAX_REMEMBERED_IDS = 256;

// --------------------------------------------------------------------------------------
// The socket shell
// --------------------------------------------------------------------------------------

/** The minimal `WebSocket.prototype`-shaped surface the shell needs. */
export interface SendSlot {
  send: (data: unknown) => void;
}

/** How an {@link installRenumberHook} call resolved. */
export type RenumberHookReason =
  /** This call wrote the live wrapper, and it owns the restore. */
  | 'installed'
  /**
   * The slot already held our wrapper and the machine behind it was reachable from this module instance,
   * so it was adopted. Nothing was written.
   */
  | 'reused'
  /**
   * The slot already held our wrapper, but the machine behind it was installed by a *different* copy of
   * this module (a userscript plus an importing mod is the realistic case), so it is not addressable
   * here. Nothing was written and nothing was constructed.
   */
  | 'already-installed';

/** A live renumbering hook. */
export interface RenumberHookHandle {
  /**
   * The state machine, so a caller can read `stats` or drive `healAfterInvalidSequence`.
   *
   * `null` only for `reason: 'already-installed'`. A handle never carries a machine that no wrapper feeds:
   * handing one back is what made a second install silently number into a void (I1).
   */
  readonly renumberer: Renumberer | null;
  /** Undo the patch, identity-guarded. `false` when this call did not write the live wrapper. */
  release(): boolean;
  /**
   * Whether the live wrapper is in the slot.
   *
   * This describes the *slot*, not {@link renumberer}: it is `true` for a `'reused'` install (the machine
   * is the live one) and for an `'already-installed'` install (there is no machine here to expose), and it
   * goes `false` the moment the wrapper that owns the restore releases it.
   */
  readonly active: boolean;
  /** Why this call did or did not install. See {@link RenumberHookReason}. */
  readonly reason: RenumberHookReason;
  /** The inner install, for diagnostics. */
  readonly install: InstalledHook;
}

/** Options for {@link installRenumberHook}. */
export interface InstallRenumberHookOptions {
  /** The object holding `send` (usually `WebSocket.prototype`). */
  target: SendSlot;
  /** The key to patch. Default `'send'`. */
  key?: string;
  /**
   * The state machine to drive. One is created when omitted.
   *
   * Ignored when the slot already holds our live wrapper: that machine is adopted instead, because exactly
   * one may be live (I1). `reason` says which happened.
   */
  renumberer?: Renumberer;
  /** Options for a state machine created here. */
  options?: RenumbererOptions;
}

/**
 * The live machine behind every wrapper *this module instance* installed, so a second install can adopt it.
 *
 * Keyed by the wrapper the slot holds, because `brand.ts` brands the wrapper and carries no payload: the
 * function in the slot is the only handle on the machine that survives into the next install call. A
 * `WeakMap`, so a wrapper that is no longer installed is collected along with its machine.
 *
 * This is instance-local on purpose. Two copies of this module do not share it, so a slot that is
 * `'mine'` but absent from here resolves to the explicit `'already-installed'` handle rather than to a
 * fabricated machine.
 */
const liveMachines = new WeakMap<object, Renumberer>();

/**
 * The handle for a slot that already holds a wrapper of ours: adopt, never construct.
 *
 * Two callers arrive here: the pre-check that saw our own brand, and the rarer case where `classifySlot`
 * reads the *own* slot as clean (a prototype member) while `installHook` finds the inherited wrapper
 * branded and reports `'reused'`.
 *
 * `install.release()` is `brand.ts`'s `'reused'` release, always `false`, because the caller that did not
 * write the slot must not erase the one that did.
 */
function adoptInstalledHook(target: SendSlot, key: string, install: InstalledHook): RenumberHookHandle {
  const wrapper = install.wrapper;
  const live = typeof wrapper === 'function' ? liveMachines.get(wrapper) : undefined;
  return {
    renumberer: live ?? null,
    install,
    reason: live === undefined ? 'already-installed' : 'reused',
    get active(): boolean {
      return (target as unknown as Record<string, unknown>)[key] === install.wrapper;
    },
    release(): boolean {
      return install.release();
    },
  };
}

/**
 * Patch a `send` slot to renumber outgoing `QuinoaCommand` envelopes.
 *
 * The shell is thin on purpose. All the decisions live in {@link Renumberer}; this function only does
 * three things: gate on the cheap substring test, parse, and delegate. The gate matters: the recon records
 * that an earlier version of the companion mod "scan[ned] the big frames for substrings they cannot contain"
 * and that this "turned this hook into a per-frame cost heavy enough to be felt as jank." So:
 *
 *   1. non-string data is passed straight through (binary frames are never `QuinoaCommand`);
 *   2. a `length` check before `includes`, because the substring test is O(n) and the length test is O(1);
 *   3. `JSON.parse` only for frames that passed both.
 *
 * Install/uninstall use the branded, identity-guarded helpers from `brand.ts`. A second install while our
 * wrapper is present is a no-op (`'reused'`), and a release while somebody has wrapped us leaves their hook
 * in place rather than erasing it.
 *
 * The slot is classified before anything is constructed (I1). A machine built for a slot that already
 * holds ours can never be fed, because the wrapper that would feed it is not rebuilt, so a second install
 * adopts the live machine from {@link liveMachines} instead, or reports `'already-installed'` with
 * `renumberer: null` when the machine belongs to another copy of this module. `active` stays honest either
 * way, because it is computed from the slot rather than decided at install time.
 */
export function installRenumberHook(options: InstallRenumberHookOptions): RenumberHookHandle {
  const { target } = options;
  const key = options.key ?? 'send';
  const slot = target as unknown as Record<string, unknown>;

  // (1) Decide whether the slot is free *before* constructing anything. Building first and asking later is
  //     the bug this function used to have: on `'reused'` the fresh machine is never wrapped, so nothing
  //     feeds it while `active` still reports `true`, so the caller numbers into a void.
  if (classifySlot(target as unknown as object, key) === 'mine') {
    return adoptInstalledHook(target, key, {
      // The same three fields `brand.ts` returns for `'reused'`, mirrored rather than produced by calling
      // `installHook` with a wrapper that must never be built.
      outcome: 'reused',
      wrapper: slot[key],
      release: () => false,
    });
  }

  const renumberer = options.renumberer ?? new Renumberer(options.options);

  const install = installHook({
    target: target as unknown as object,
    key,
    label: `renumber:${key}`,
    wrap: (previous) => {
      const wrapper = function renumberingSend(this: unknown, data: unknown): void {
        let outgoing = data;
        try {
          outgoing = applyRenumbering(data, renumberer);
        } catch {
          // A rewrite failure must never drop the game's frame. Sending the original is the safe answer:
          // a duplicate sequence is dropped by the server, whereas a *missing* frame desyncs the game.
          outgoing = data;
        }
        if (previous !== undefined) {
          previous.call(this, outgoing);
          return;
        }
        // No previous send: nothing to delegate to. This happens only when the slot was empty, which for
        // `WebSocket.prototype.send` means the environment is not a real socket.
      };
      return brandWrapper(wrapper, `renumber:${key}`);
    },
  });

  if (install.outcome !== 'installed') {
    // Reachable because `classifySlot` reads own properties only, while `installHook` reads the value it
    // would chain to: an *inherited* branded `send` classifies as `'clean'` there and as `'reused'` here.
    // The machine just built is dropped, since no wrapper will ever feed it, and the live one is adopted.
    return adoptInstalledHook(target, key, install);
  }

  const wrapper = install.wrapper;
  if (typeof wrapper === 'function') liveMachines.set(wrapper, renumberer);

  return {
    renumberer,
    install,
    reason: 'installed',
    get active(): boolean {
      return slot[key] === install.wrapper;
    },
    release(): boolean {
      return install.release();
    },
  };
}

/**
 * The gate + parse + delegate body, extracted so the shell stays honest about how little it does.
 *
 * The gate itself (non-string, too short, no marker, not JSON, not an envelope) is
 * {@link parseEnvelope}, because the other outbound path needs the identical test and two copies of it would
 * be two chances to disagree. Everything this function decides is what to do with a frame that passed.
 *
 * Exported because it is the piece worth testing directly against a `Renumberer`, without a socket.
 */
export function applyRenumbering(data: unknown, renumberer: Renumberer): unknown {
  const envelope = parseEnvelope(data);
  if (envelope === null) return data;

  const result = renumberer.rewrite(envelope);
  if (result.action === 'renumbered') {
    try {
      return JSON.stringify(result.frame);
    } catch {
      // A frame that will not re-serialise (a circular value a caller attached) is sent unmodified.
      return data;
    }
  }
  return data;
}

/**
 * Classify the send slot, for a caller that wants to know before installing.
 *
 * Re-exported from `brand.ts` so `renumber`'s tests can assert on it without importing two modules, and
 * because the two concepts (is this slot free / mine / someone else's) belong to the same discussion.
 */
export { classifySlot, restoreSlot };
