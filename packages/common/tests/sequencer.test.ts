/**
 * Command sequencing, including the two documented correction paths.
 *
 * The doc's framing is the reason these tests exist: a duplicate sequence is dropped silently, and a
 * gap poisons every later command. So the forward jump (frontier ran past us) and the backward heal
 * (server told us we gapped) matter to correctness, and both are easy to get subtly wrong.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CommandSequencer,
  FrontierAnchoredStrategy,
  isCanonicalSequence,
  MAX_REPORTED_STALE,
  MonotonicStrategy,
} from '../src/actions/sequencer.js';
// The public-surface copy of the bound, reached the way a consumer reaches it: through the package root,
// which re-exports `protocol/index.js`. The direct import below is what the behavioural tests use; this
// one is here so the re-export is asserted rather than assumed (a bare re-export is invisible to `tsc -b`
// and to any test that only imports the module).
import { MAX_REPORTED_STALE as MAX_REPORTED_STALE_PUBLIC } from '../src/index.js';

describe('MonotonicStrategy', () => {
  it('seeds the next value from executedCommandSequence + 1', () => {
    const strategy = new MonotonicStrategy(41);
    assert.equal(strategy.peek(), 42);
    assert.equal(strategy.take(), 42);
    assert.equal(strategy.take(), 43);
    assert.equal(strategy.lastIssued, 43);
  });

  it('starts at 1 for a fresh connection', () => {
    const strategy = new MonotonicStrategy(0);
    assert.equal(strategy.take(), 1);
  });

  it('heals to a supplied frontier on invalid_sequence', () => {
    const strategy = new MonotonicStrategy(10);
    strategy.take();
    strategy.take();
    assert.equal(strategy.peek(), 13);
    strategy.healAfterInvalidSequence(99);
    assert.equal(strategy.peek(), 100);
  });

  it('ignores a heal with no frontier evidence', () => {
    const strategy = new MonotonicStrategy(10);
    strategy.take();
    strategy.healAfterInvalidSequence();
    assert.equal(strategy.peek(), 12, 'must not rewind without evidence');
  });

  it('treats a fractional constructor seed as no seed, not as 3.5', () => {
    // The constructor is a caller boundary. Before the one rule reached it, `new MonotonicStrategy(2.5)`
    // started at `3.5` and `take()` put that straight into the outstanding ledger; only `buildFrame`'s gate
    // stopped it before the wire, as a throw from a frame the caller believed was valid.
    const strategy = new MonotonicStrategy(2.5);
    assert.equal(strategy.peek(), 1, 'a malformed seed is no evidence, so the counter starts at 1');
    assert.equal(strategy.take(), 1);
    assert.equal(strategy.lastIssued, 1);
  });

  it('does not heal to a fractional frontier while a real one stands', () => {
    const strategy = new MonotonicStrategy(0);
    strategy.observeFrontier(9);
    assert.equal(strategy.peek(), 10);
    strategy.healAfterInvalidSequence(2.5);
    assert.equal(strategy.peek(), 10, 'malformed evidence is no evidence: the known frontier stands');
  });

  it('tracks the highest frontier it has seen, never a lower one', () => {
    const strategy = new MonotonicStrategy(0);
    strategy.observeFrontier(10);
    strategy.observeFrontier(5);
    assert.equal(strategy.frontier, 10);
  });

  it('jumps forward past a confirmed frontier that has already reached it', () => {
    // `executedCommandSequence` means "I have already executed up to N". Issuing a number at or below
    // N is a duplicate, which the server drops without a word. So the counter must never fall behind.
    const strategy = new MonotonicStrategy(10);
    strategy.observeFrontier(25);
    assert.equal(strategy.peek(), 26);
    assert.equal(strategy.take(), 26);
    assert.equal(strategy.stats.forwardJumps, 1);
  });

  it('does not jump when the frontier is behind it', () => {
    const strategy = new MonotonicStrategy(10);
    strategy.take();
    strategy.take();
    strategy.observeFrontier(5);
    assert.equal(strategy.peek(), 13);
    assert.equal(strategy.stats.forwardJumps, 0);
  });
});

describe('FrontierAnchoredStrategy', () => {
  it('jumps forward when the server frontier has run past our next number', () => {
    // This is the multi-mod case: another writer renumbered independently and the server is already
    // ahead of us. Sending our stale next number would be a silent duplicate.
    const strategy = new FrontierAnchoredStrategy({ executedCommandSequence: 10, getFrontier: () => 25 });
    assert.equal(strategy.peek(), 26);
    assert.equal(strategy.take(), 26);
    assert.equal(strategy.stats.forwardJumps, 1);
  });

  it('reads the live frontier before every stamp', () => {
    let frontier = 10;
    const strategy = new FrontierAnchoredStrategy({
      executedCommandSequence: 10,
      getFrontier: () => frontier,
    });
    assert.equal(strategy.take(), 11);
    frontier = 30;
    assert.equal(strategy.take(), 31, 'must consult the live frontier, not a cached one');
  });

  it('does not jump when the frontier is behind us', () => {
    const strategy = new FrontierAnchoredStrategy({ executedCommandSequence: 10, getFrontier: () => 4 });
    assert.equal(strategy.take(), 11);
    assert.equal(strategy.stats.forwardJumps, 0);
  });

  it('heals backward immediately on invalid_sequence', () => {
    // "a desync costs at most the one command that tripped it, not every command after it"
    const strategy = new FrontierAnchoredStrategy({ executedCommandSequence: 10 });
    strategy.take();
    strategy.take();
    assert.equal(strategy.peek(), 13);
    strategy.healAfterInvalidSequence(50);
    assert.equal(strategy.peek(), 51);
    assert.equal(strategy.stats.backwardHeals, 1);
  });

  it('tolerates a frontier reader that returns null', () => {
    const strategy = new FrontierAnchoredStrategy({ executedCommandSequence: 3, getFrontier: () => null });
    assert.equal(strategy.take(), 4);
  });

  it('reseeds cleanly on reconnect', () => {
    const strategy = new FrontierAnchoredStrategy({ executedCommandSequence: 10 });
    strategy.take();
    strategy.reseed(100);
    assert.equal(strategy.peek(), 101);
    assert.equal(strategy.lastIssued, 100);
    assert.equal(strategy.frontier, 100);
  });

  it('treats a fractional executedCommandSequence as no evidence', () => {
    const strategy = new FrontierAnchoredStrategy({ executedCommandSequence: 2.5 });
    assert.equal(strategy.frontier, null, 'a fraction is malformed input, not a frontier');
    assert.equal(strategy.peek(), 1);
    assert.equal(strategy.take(), 1);
  });

  it('ignores a fractional reseed rather than moving the counter to 3.5', () => {
    const strategy = new FrontierAnchoredStrategy({ executedCommandSequence: 10 });
    strategy.take();
    const before = strategy.peek();
    strategy.reseed(2.5);
    assert.equal(strategy.peek(), before, 'a malformed reseed leaves the counter where it was');
    assert.equal(strategy.frontier, 10);
  });
});

describe('CommandSequencer', () => {
  it('upgrades to frontier anchoring when a frontier reader is supplied', () => {
    // The bootstrapped client passes getFrontier; it must not silently get a monotonic counter.
    const sequencer = new CommandSequencer({ getFrontier: () => 77 });
    assert.ok(sequencer.activeStrategy instanceof FrontierAnchoredStrategy);
    assert.equal(sequencer.take('WaterPlant', 'r1'), 78);
  });

  it('stays monotonic when no frontier reader is supplied', () => {
    const sequencer = new CommandSequencer();
    assert.ok(sequencer.activeStrategy instanceof MonotonicStrategy);
  });

  it('seed() refuses a non-canonical value', () => {
    // `seed` is a caller boundary, not a wire path: a fractional or negative value is a programming error,
    // and silently turning it into `3.5` poisons every subsequent command. Fail loudly instead.
    const sequencer = new CommandSequencer();
    assert.throws(() => sequencer.seed(2.5), RangeError);
    assert.throws(() => sequencer.seed(-1), RangeError);
  });

  it('isCanonicalSequence names the only sequence numbers the wire allows', () => {
    // This is the one rule every frontier read goes through (Phase 3.5 converges the remaining
    // `Number.isFinite` copies onto it), so its boundary is pinned here rather than inferred.
    for (const value of [0, 1, 1157, Number.MAX_SAFE_INTEGER]) {
      assert.equal(isCanonicalSequence(value), true, `${value} is a valid sequence`);
    }
    const rejected: unknown[] = [
      2.5,
      -1,
      -0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '7',
      null,
      undefined,
      {},
    ];
    for (const value of rejected) {
      assert.equal(isCanonicalSequence(value), false, `${String(value)} is not a valid sequence`);
    }
  });

  it('records outstanding commands and settles them by requestId', () => {
    const sequencer = new CommandSequencer();
    sequencer.seed(0);
    const sequence = sequencer.take('WaterPlant', 'req-a');
    assert.equal(sequence, 1);
    assert.equal(sequencer.pending.length, 1);

    const settled = sequencer.settle('req-a', { ok: true });
    assert.equal(settled?.sequence, 1);
    assert.equal(sequencer.pending.length, 0);
  });

  it('does not record a foreign frame as outstanding', () => {
    // The bootstrapped send-hook sees the host game's own traffic; those must not enter our ledger.
    const sequencer = new CommandSequencer();
    sequencer.take('WaterPlant', 'foreign', false);
    assert.equal(sequencer.pending.length, 0);
  });

  it('synthesizes DroppedStale when the frontier passes an unanswered command', () => {
    // The server never sends `dropped_stale`. The API reference calls it "a client-side inference".
    // This is that inference.
    const sequencer = new CommandSequencer();
    sequencer.seed(0);
    sequencer.take('WaterPlant', 'req-a');
    sequencer.take('HarvestCrop', 'req-b');

    const { dropped } = sequencer.observeFrontier(1);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0]?.requestId, 'req-a');
    assert.equal(dropped[0]?.action, 'WaterPlant');
  });

  it('ignores a non-canonical frontier for the ledger, exactly as it does for the counter', () => {
    // The canonical rule (Phase 2.8) shuts the *counter* gate on untrusted input, but the reconciliation
    // loop used to run on the raw value: a fractional `RoomFrame.executedCommandSequence` could not move
    // the counter yet still overtook a live, legitimate command and reported it `dropped_stale`.
    const sequencer = new CommandSequencer();
    sequencer.seed(10);
    assert.equal(sequencer.take('WaterPlant', 'req-live'), 11, 'the live command holds sequence 11');
    assert.equal(sequencer.peek(), 12);

    const { dropped } = sequencer.observeFrontier(11.5);
    assert.deepEqual(dropped, [], 'a fraction is not a frontier and must not overtake a command');
    assert.equal(sequencer.pending.length, 1, 'the live command is still outstanding');
    assert.equal(sequencer.frontier, 10, 'the counter gate stays shut');

    // The same value as a canonical integer still reconciles: this is the inference, not a blanket veto.
    assert.equal(sequencer.observeFrontier(11).dropped.length, 1);
    assert.equal(sequencer.pending.length, 0);
  });

  it('reports each dropped command only once', () => {
    const sequencer = new CommandSequencer();
    sequencer.seed(0);
    sequencer.take('WaterPlant', 'req-a');
    assert.equal(sequencer.observeFrontier(1).dropped.length, 1);
    assert.equal(sequencer.observeFrontier(2).dropped.length, 0);
  });

  it('does not report a settled command as dropped', () => {
    const sequencer = new CommandSequencer();
    sequencer.seed(0);
    sequencer.take('WaterPlant', 'req-a');
    sequencer.settle('req-a', { ok: true });
    assert.equal(sequencer.observeFrontier(5).dropped.length, 0);
  });

  it('heals the counter when a command comes back invalid_sequence', () => {
    const sequencer = new CommandSequencer();
    sequencer.seed(0);
    sequencer.take('WaterPlant', 'req-a');
    assert.equal(sequencer.peek(), 2);
    sequencer.settle('req-a', { ok: false, code: 'invalid_sequence' }, 40);
    assert.equal(sequencer.peek(), 41);
  });

  it('heals the counter for the ResultCode spelling too', () => {
    const sequencer = new CommandSequencer();
    sequencer.seed(0);
    sequencer.take('WaterPlant', 'req-a');
    sequencer.settle('req-a', { ok: false, code: 'invalid_sequence' }, 12);
    assert.equal(sequencer.peek(), 13);
  });

  it('clears the ledger on reseed, so a reconnect cannot produce phantom drops', () => {
    const sequencer = new CommandSequencer();
    sequencer.seed(0);
    sequencer.take('WaterPlant', 'req-a');
    sequencer.seed(50);
    assert.equal(sequencer.pending.length, 0);
    assert.equal(sequencer.peek(), 51);
    assert.equal(sequencer.observeFrontier(60).dropped.length, 0);
    // And the frontier that just arrived is still honoured for the next stamp.
    assert.equal(sequencer.peek(), 61);
  });

  it('sweeps commands that aged out inside a pending command timeout', () => {
    const sequencer = new CommandSequencer({ staleAfterMs: 1000 });
    sequencer.seed(0);
    sequencer.take('WaterPlant', 'req-a');
    assert.equal(sequencer.sweepStale(Date.now()).length, 0);
    const dropped = sequencer.sweepStale(Date.now() + 2000);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0]?.requestId, 'req-a');
  });

  it('resync forces the next number from an explicit frontier', () => {
    const sequencer = new CommandSequencer();
    sequencer.seed(0);
    sequencer.take('WaterPlant', 'req-a');
    sequencer.resync(9);
    assert.equal(sequencer.peek(), 10);
  });

  it('resync ignores a fractional frontier instead of healing to 3.5', () => {
    // `resync` is a caller-supplied frontier, and a malformed one is no evidence. That matches the reading
    // `Renumberer.healAfterInvalidSequence` takes (coexistence/renumber.ts). Before the gate, this set the
    // next value to `3.5` and `take()` recorded `3.5` as outstanding.
    const sequencer = new CommandSequencer();
    sequencer.resync(2.5);
    assert.equal(sequencer.peek(), 1, 'the counter must not move onto a fraction');
    const issued = sequencer.take('WaterPlant', 'req-fractional');
    assert.equal(issued, 1);
    assert.deepEqual(
      sequencer.pending.map((command) => command.sequence),
      [1],
      'the outstanding ledger holds canonical sequence numbers only',
    );
  });

  it('bounds the reported-stale ledger, forgetting the oldest first', () => {
    // `reportedStale` only exists to stop a repeat inference, but without a bound it grew for the whole
    // life of a connection (I5). The bound is proved by exceeding it: `total` is five past the limit, and
    // the *oldest* records are the ones gone.
    const total = MAX_REPORTED_STALE + 5;
    assert.equal(
      MAX_REPORTED_STALE_PUBLIC,
      MAX_REPORTED_STALE,
      'the bound must be the same value through the public surface as in the module',
    );
    const fill = (): CommandSequencer => {
      // `staleAfterMs: 0` makes every command immediately sweepable, so the ledger fills without a
      // frontier, and that is what leaves the counter free to be rewound below.
      const sequencer = new CommandSequencer({ staleAfterMs: 0 });
      sequencer.seed(0);
      for (let index = 0; index < total; index += 1) {
        sequencer.take('WaterPlant', `req-${index}`);
      }
      assert.equal(sequencer.sweepStale().length, total, 'every aged command is swept exactly once');
      return sequencer;
    };

    const evicted = fill();
    assert.equal(evicted.reportedStaleCount, MAX_REPORTED_STALE, 'the ledger must stop at its bound');

    // Eviction order is observable: re-issuing a sequence and passing the frontier reports it again only
    // if it was forgotten. Sequence 1 is the oldest of `total`, so it must have been evicted.
    evicted.resync(0);
    evicted.take('WaterPlant', 'replay-oldest');
    assert.equal(
      evicted.observeFrontier(1).dropped.length,
      1,
      'the oldest reported sequence must be the one forgotten',
    );

    const retained = fill();
    assert.equal(retained.reportedStaleCount, MAX_REPORTED_STALE);
    // The oldest sequence that still fits (total - MAX + 1) is remembered...
    retained.resync(total - MAX_REPORTED_STALE);
    retained.take('WaterPlant', 'replay-boundary');
    assert.equal(
      retained.observeFrontier(total - MAX_REPORTED_STALE + 1).dropped.length,
      0,
      'the boundary sequence is still within the bound and must be remembered',
    );
    // ...and so is the newest, so the bound drops history rather than the whole ledger.
    retained.resync(total - 1);
    retained.take('WaterPlant', 'replay-newest');
    assert.equal(
      retained.observeFrontier(total).dropped.length,
      0,
      'the newest reported sequence must still be remembered',
    );
  });
});
