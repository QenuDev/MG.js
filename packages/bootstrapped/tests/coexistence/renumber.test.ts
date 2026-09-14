/**
 * Coexistence unit tests.
 *
 * ## Why these are pure and DOM-free
 *
 * The renumbering state machine and the brand protocol are the two highest-consequence pieces of code in this
 * package: a mistake in either produces a *silently* dead connection, which is the worst possible failure mode
 * because the player cannot tell a broken mod from a broken game. So both were written with no
 * DOM, no socket and no page access, and these tests exercise them directly with plain objects.
 *
 * No part of `src/` touches `window` at module load, and that is what makes importing it here possible. This
 * test file is itself a regression guard on that property.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommandSequencer, extractFrontier } from '@mg.js/common';
import { readWelcomeFrontier } from '../../src/client.ts';
import type { Branded, PreviousFn } from '../../src/coexistence/brand.ts';
import {
  attemptTeardown,
  brandLabelOf,
  brandWrapper,
  classifySlot,
  installHook,
  isBranded,
  MARKER_KEY,
  restoreSlot,
} from '../../src/coexistence/brand.ts';
import {
  applyRenumbering,
  asEnvelope,
  installRenumberHook,
  MAX_REMEMBERED_IDS,
  Renumberer,
} from '../../src/coexistence/renumber.ts';

// --------------------------------------------------------------------------------------
// brand / classifySlot / restoreSlot
// --------------------------------------------------------------------------------------

void test('classifySlot reports clean for an absent slot', () => {
  const target: Record<string, unknown> = {};
  assert.equal(classifySlot(target, 'send'), 'clean');
});

void test('classifySlot reports clean for a non-function, because it is not a hook', () => {
  // A non-function is not a wrapper we could chain to or preserve, so "write something here" is the right
  // answer. The caller's captured `previous` is what preserves the oddity if it wants to.
  const target: Record<string, unknown> = { send: 42 };
  assert.equal(classifySlot(target, 'send'), 'clean');
});

void test('classifySlot ignores an inherited function, so a prototype method is not a conflict', () => {
  // `WebSocket.prototype.send` is *inherited* as seen from a socket instance. Treating an
  // inherited function as occupied would make every first install look like a conflict.
  class Base {
    send(): string {
      return 'original';
    }
  }
  const instance = new Base();
  assert.equal(classifySlot(instance, 'send'), 'clean');
  assert.equal(Object.hasOwn(instance, 'send'), false);
});

void test('classifySlot reports foreign for an unbranded function and never claims it', () => {
  const target: Record<string, unknown> = { send: () => undefined };
  assert.equal(classifySlot(target, 'send'), 'foreign');
});

void test('classifySlot reports mine only for our own brand', () => {
  const mine = brandWrapper(() => undefined, 'test.send');
  assert.equal(classifySlot({ send: mine } as Record<string, unknown>, 'send'), 'mine');

  // Someone else's marker is not ours, so their wrapper stays foreign. That is what makes us chain onto it
  // rather than replace it.
  const theirs = Object.assign(() => undefined, { __someOtherModWrapped: true });
  assert.equal(classifySlot({ send: theirs } as Record<string, unknown>, 'send'), 'foreign');
});

void test('brandWrapper is non-enumerable and carries its label', () => {
  // `brandWrapper` preserves the callable type and brands it by intersection, so the marker is only
  // readable through `Branded`.
  const fn: Branded<() => undefined> = brandWrapper(() => undefined, 'room.sendMessage');
  assert.equal(isBranded(fn), true);
  assert.equal(brandLabelOf(fn), 'room.sendMessage');
  assert.equal(fn[MARKER_KEY], true);
  // Non-enumerable matters: a `{...spread}` copy of the object holding the function must not lose the brand,
  // and a JSON serialisation of the owner must not grow a stray property.
  assert.deepEqual(Object.keys(fn), []);
});

void test('brandWrapper returns a non-function untouched rather than throwing', () => {
  assert.equal(brandWrapper(undefined as unknown as object, 'x'), undefined);
  assert.equal(isBranded(undefined), false);
  assert.equal(brandLabelOf(undefined), null);
});

void test('restoreSlot puts the original back when the slot still holds our wrapper', () => {
  const original = (): string => 'original';
  const wrapper = brandWrapper((): string => 'wrapper', 'slot');
  const target: Record<string, unknown> = { send: wrapper };

  assert.equal(restoreSlot(target, 'send', original, wrapper), true);
  assert.equal(target['send'], original);
});

void test('restoreSlot refuses when somebody wrapped our wrapper after us', () => {
  // This is the bug that only shows up as "the other mod's feature randomly stops working after mine
  // unloads": blindly restoring our captured original would erase *their* hook too.
  const original = (): string => 'original';
  const ours = brandWrapper((): string => 'ours', 'slot');
  const theirs = brandWrapper((): string => 'theirs', 'their-slot');
  const target: Record<string, unknown> = { send: theirs };

  assert.equal(restoreSlot(target, 'send', original, ours), false);
  assert.equal(target['send'], theirs, "the other mod's hook must survive our teardown");
});

void test('restoreSlot deletes an own property that did not exist before we installed', () => {
  // Assigning `undefined` instead of deleting would leave an own property shadowing the prototype, which
  // breaks the object it was installed on.
  const wrapper = brandWrapper(() => undefined, 'slot');
  const target: Record<string, unknown> = { send: wrapper };

  assert.equal(restoreSlot(target, 'send', undefined, wrapper), true);
  assert.equal('send' in target, false);
});

void test('installHook chains onto a foreign wrapper instead of replacing it', () => {
  const calls: string[] = [];
  const foreign = (value: unknown): void => {
    calls.push(`foreign:${String(value)}`);
  };
  const target: Record<string, unknown> = { send: foreign };

  const installed = installHook({
    target,
    key: 'send',
    label: 'test.send',
    wrap: (previous) =>
      function wrapper(this: unknown, value: unknown): void {
        calls.push('ours');
        // `previous` is a `PreviousFn`: callable through its type, so no escape is needed. This test covers
        // the runtime half of that claim, and it fails if chaining stops forwarding the call.
        if (previous !== undefined) previous.call(this, value);
      },
  });

  assert.equal(installed.outcome, 'installed');
  (target['send'] as (v: unknown) => void)('x');
  assert.deepEqual(calls, ['ours', 'foreign:x']);

  assert.equal(installed.release(), true);
  assert.equal(target['send'], foreign);
});

void test('PreviousFn: a wrapper chains onto another wrapper, forwarding `this`, args and result', () => {
  const seenThis: unknown[] = [];
  const hops: string[] = [];
  const receiver = { name: 'receiver' };
  const target: Record<string, unknown> = {};
  // Captured so the test can call the installed wrapper without casting the slot value: `wrap` runs during
  // the install below, and `installHook` writes the very same (branded) function object into the slot.
  let wrapper: ((this: unknown, first: unknown, second: unknown) => string) | undefined;

  const base = function base(this: unknown, first: unknown, second: unknown): string {
    seenThis.push(this);
    hops.push('base');
    return `${String(first)}/${String(second)}`;
  };
  // A foreign mod's wrapper, installed before ours and unbranded: the shape `installHook` must chain onto.
  // Typing it `PreviousFn` pins that the new name is a usable hook signature and that a plain function is
  // assignable to it.
  const foreignPrevious: PreviousFn = base;
  const foreignWrapper = function foreignWrapper(this: unknown, first: unknown, second: unknown): string {
    return `<${String(foreignPrevious.call(this, first, second))}>`;
  };
  target['send'] = foreignWrapper;

  const installed = installHook({
    target,
    key: 'send',
    label: 'test.send',
    wrap: (previous) => {
      wrapper = function ours(this: unknown, first: unknown, second: unknown): string {
        seenThis.push(this);
        hops.push('ours');
        // No cast and no `Reflect` indirection: `previous` is callable through its type, at any arity.
        return `[${String(previous?.call(this, first, second))}]`;
      };
      return wrapper;
    },
  });

  assert.equal(installed.outcome, 'installed');
  assert.equal(
    wrapper?.call(receiver, 'a', 'b'),
    '[<a/b>]',
    'the result is forwarded back through both hops',
  );
  assert.deepEqual(seenThis, [receiver, receiver], 'each hop forwards the same `this` unchanged');
  assert.deepEqual(hops, ['ours', 'base']);

  assert.equal(installed.release(), true);
  assert.equal(target['send'], foreignWrapper);
});

void test('installHook reuses our own wrapper rather than stacking', () => {
  const target: Record<string, unknown> = {};
  let wrapCount = 0;
  const first = installHook({
    target,
    key: 'send',
    label: 'test.send',
    wrap: () => {
      wrapCount += 1;
      return () => undefined;
    },
  });
  const second = installHook({
    target,
    key: 'send',
    label: 'test.send',
    wrap: () => {
      wrapCount += 1;
      return () => undefined;
    },
  });

  assert.equal(first.outcome, 'installed');
  assert.equal(second.outcome, 'reused');
  assert.equal(wrapCount, 1, 'a second install must not build a second wrapper');
  // The reused handle must not claim ownership of the restore.
  assert.equal(second.release(), false);
  assert.equal(first.release(), true);
});

void test('attemptTeardown continues past a throwing step', () => {
  let reached = false;
  assert.equal(
    attemptTeardown('boom', () => {
      throw new Error('boom');
    }),
    false,
  );
  assert.equal(
    attemptTeardown('after', () => {
      reached = true;
    }),
    true,
  );
  assert.equal(reached, true);
});

// --------------------------------------------------------------------------------------
// Renumberer, the pure state machine
// --------------------------------------------------------------------------------------

/** Build a `QuinoaCommand` envelope. */
function envelope(sequence: number, requestId = 'game-1'): Record<string, unknown> {
  return {
    scopePath: ['Room', 'Quinoa'],
    type: 'QuinoaCommand',
    requestId,
    commandSequence: sequence,
    command: { type: 'HarvestCrop' },
  };
}

void test('asEnvelope only accepts QuinoaCommand frames', () => {
  assert.notEqual(asEnvelope(envelope(1)), null);
  // A room frame also has a `type`, and some future frame could carry a `commandSequence` for an unrelated
  // reason, and gating on the name is what stops us renumbering it.
  assert.equal(asEnvelope({ type: 'RoomFrame', commandSequence: 4 }), null);
  assert.equal(asEnvelope('{"type":"QuinoaCommand"}'), null);
  assert.equal(asEnvelope(null), null);
});

void test('passive phase tracks the highest sequence and leaves frames byte-identical', () => {
  const r = new Renumberer();
  assert.equal(r.owns, false);

  const frames = [envelope(7), envelope(3), envelope(9), envelope(8)];
  for (const frame of frames) {
    const result = r.rewrite(frame);
    assert.equal(result.action, 'observed');
    // Referential identity, not deep equality: "every byte is untouched vanilla behavior until the first time
    // you actually act."
    assert.equal(result.frame, frame);
  }
  assert.equal(r.highest, 9);
  assert.equal(r.next, 10);
  assert.equal(r.owns, false);
});

void test('the claim happens on the first injected command and takes the counter', () => {
  const r = new Renumberer();
  r.observe(envelope(4));
  assert.equal(r.owns, false);

  const claimed = r.claimNext();
  assert.equal(claimed, 5);
  assert.equal(r.owns, true);
  assert.equal(r.next, 6);
});

void test("once we own the counter, the game's own frames are renumbered too", () => {
  const r = new Renumberer();
  r.observe(envelope(10));
  assert.equal(r.claimNext(), 11);

  // The game had its own idea of the next number; ours wins, because one chooser is the whole point.
  const gameFrame = envelope(11, 'game-2');
  const result = r.rewrite(gameFrame);
  assert.equal(result.action, 'renumbered');
  assert.equal(result.sequence, 12);
  assert.equal((result.frame as Record<string, unknown>)['commandSequence'], 12);
  // The input must not be mutated: some builds build an envelope once and re-send it on retry.
  assert.equal(gameFrame['commandSequence'], 11);
  assert.equal(r.next, 13);
});

void test('our own frames are never renumbered twice', () => {
  const r = new Renumberer();
  r.observe(envelope(10));
  const mine = r.claimNext();
  assert.equal(mine, 11);
  r.remember('mine-1');

  const ourFrame = envelope(mine, 'mine-1');
  const result = r.rewrite(ourFrame);
  assert.equal(result.action, 'ours');
  assert.equal(result.sequence, 11);
  assert.equal(result.frame, ourFrame);
  // No second number was consumed, so the sequence has no hole. A hole is `invalid_sequence`, which
  // breaks every later command.
  assert.equal(r.next, 12);
  assert.equal(r.stats.renumbered, 0);
});

void test('an unrelated requestId is treated as foreign, not as ours', () => {
  const r = new Renumberer();
  r.remember('mine-1');
  assert.equal(r.isOurs('mine-1'), true);
  assert.equal(r.isOurs('mine-2'), false);
  assert.equal(r.isOurs(42), false);
});

void test('remembered ids are bounded, so a long session does not leak', () => {
  const r = new Renumberer();
  for (let index = 0; index < MAX_REMEMBERED_IDS + 50; index += 1) r.remember(`id-${index}`);
  assert.equal(r.rememberedIds.length, MAX_REMEMBERED_IDS);
  // Oldest out: the most recent ids are the ones a frame could still come back with.
  assert.equal(r.isOurs(`id-${MAX_REMEMBERED_IDS + 49}`), true);
  assert.equal(r.isOurs('id-0'), false);
});

void test('the frontier reader is consulted before every stamp and jumps us forward', () => {
  // A second mod renumbered independently, so the server has run past our counter.
  let frontier = 5;
  const r = new Renumberer({ getFrontier: () => frontier });
  r.observe(envelope(3));
  assert.equal(r.peekNext(), 6);

  frontier = 40;
  assert.equal(r.claimNext(), 41, 'claiming must reconcile with the live frontier, not a stale one');
  assert.equal(r.stats.forwardJumps >= 1, true);
});

void test('the frontier is monotonic and a stale lower value is ignored', () => {
  const r = new Renumberer();
  r.observeFrontier(50);
  r.observeFrontier(7);
  assert.equal(r.knownFrontier, 50);
  assert.equal(r.next, 51);
});

void test('a missing frontier is not zero', () => {
  // `FrontierAnchoredStrategy` treats `null` as "no evidence" and 0 as "the server has executed through zero".
  // Conflating them makes the first stamp of a session a guess.
  const r = new Renumberer({ getFrontier: () => null });
  assert.equal(r.knownFrontier, null);
  assert.equal(r.next, 1);
});

void test('healing after invalid_sequence moves the counter down on explicit evidence', () => {
  const r = new Renumberer();
  r.observe(envelope(60));
  r.claimNext();
  assert.equal(r.next, 62);

  // The server rejected our number. A desync costs at most the one command that tripped it.
  r.healAfterInvalidSequence(9);
  assert.equal(r.next, 10);
  assert.equal(r.stats.backwardHeals, 1);
});

void test('a reseed after reconnect returns to the passive phase', () => {
  const r = new Renumberer();
  r.observe(envelope(20));
  r.claimNext();
  assert.equal(r.owns, true);

  // A reconnect restarts the server's numbering. Carrying our counter across that boundary would gap
  // immediately, so the state resets and the next command takes the counter again.
  r.reseed(0);
  assert.equal(r.owns, false);
  assert.equal(r.next, 1);
});

void test('a non-QuinoaCommand frame passes through untouched in both phases', () => {
  const r = new Renumberer();
  const roomFrame = { scopePath: ['Room'], type: 'SendChatMessage', message: 'hi' };
  assert.equal(r.rewrite(roomFrame).action, 'passthrough');
  r.claimNext();
  assert.equal(r.rewrite(roomFrame).action, 'passthrough');
  assert.equal(r.rewrite('a string').action, 'passthrough');
  assert.equal(r.rewrite(null).action, 'passthrough');
});

void test('a frontier reader that throws does not stop stamping', () => {
  const r = new Renumberer({
    getFrontier: () => {
      throw new Error('half-torn-down room connection');
    },
  });
  assert.equal(r.claimNext(), 1);
});

void test('a fractional Welcome frontier seeds neither counter, so they cannot disagree', () => {
  // The audit's headline scenario, and the reason Phase 3.5 exists. `bootstrapped/src/client.ts` seeds the
  // renumberer from `readWelcomeFrontier(message)` on the `welcome` event, while `ClientCore.handleWelcome`
  // seeds the core sequencer from the same `Welcome`, under a comment promising both are seeded "from the
  // same fact, so they cannot disagree about where the session started". With two readers they did: the core
  // took `2.5` and the renumberer refused it, so the core's next value was `3.5` and the renumberer's was
  // `1`. One gap, and the protocol fails every later command too.
  const welcome = { type: 'Welcome', executedCommandSequence: 2.5, selfPlayerId: 'p' };

  assert.equal(
    readWelcomeFrontier(welcome),
    extractFrontier(welcome),
    'one fact, one reader: the two clients must not disagree about what the Welcome said',
  );
  assert.equal(extractFrontier(welcome), null, 'a fraction is malformed input, not a frontier');

  // These are the two production shapes: `if (seed !== null) this.sequencer.seed(seed)` in
  // `common/src/client.ts`, and `if (frontier !== null) this.renumberer.observeFrontier(frontier)` in
  // `bootstrapped/src/client.ts`. With one reader refusing the value, neither counter can move.
  const core = new CommandSequencer();
  const renumberer = new Renumberer();
  const frontier = extractFrontier(welcome);
  if (frontier !== null) core.seed(frontier);
  if (frontier !== null) renumberer.observeFrontier(frontier);
  assert.equal(core.peek(), 1, 'the core counter stays at the seed');
  assert.equal(renumberer.next, 1, 'and the renumberer stays at the same seed, not 3.5');

  // Belt and braces: the two entry points this test reaches both refuse a fraction handed over directly.
  // `seed` throws, `observeFrontier` ignores. (The remaining caller-supplied routes, `resync`, the
  // strategy constructors and `reseed`, are pinned in `common/tests/sequencer.test.ts`; this test does not
  // touch them.)
  assert.throws(() => core.seed(2.5), RangeError, 'the core sequencer refuses a fractional seed');
  renumberer.observeFrontier(2.5);
  assert.equal(renumberer.next, 1, 'the renumberer refuses a fraction as firmly as the core does');
});

// --------------------------------------------------------------------------------------
// The socket shell over the state machine
// --------------------------------------------------------------------------------------

void test('applyRenumbering leaves non-string and short frames alone', () => {
  const r = new Renumberer();
  const binary = new Uint8Array([1, 2, 3]);
  assert.equal(applyRenumbering(binary, r), binary);
  assert.equal(applyRenumbering('{"a":1}', r), '{"a":1}');
  // Not a QuinoaCommand: the O(1) length gate and the substring gate both reject before any parse.
  const patches = JSON.stringify({ type: 'RoomFrame', patches: [] });
  assert.equal(applyRenumbering(patches, r), patches);
});

void test('applyRenumbering observes while passive and rewrites once we own the counter', () => {
  const r = new Renumberer();
  const incoming = JSON.stringify(envelope(4));

  // Passive: returned by value, and it advanced the high-water mark.
  assert.equal(applyRenumbering(incoming, r), incoming);
  assert.equal(r.highest, 4);

  r.claimNext();
  const gameFrame = JSON.stringify(envelope(5, 'game-2'));
  const rewritten = applyRenumbering(gameFrame, r);
  assert.notEqual(rewritten, gameFrame);
  const parsed = JSON.parse(String(rewritten)) as { commandSequence: number };
  assert.equal(parsed.commandSequence, 6);
});

void test('installRenumberHook patches a send slot, renumbers, and restores it', () => {
  const sent: string[] = [];
  const target = {
    send(data: unknown): void {
      sent.push(String(data));
    },
  };
  const original = target.send;

  const hook = installRenumberHook({ target });
  assert.equal(hook.active, true);
  assert.notEqual(target.send, original);
  const machine = hook.renumberer;
  assert.ok(machine, 'a first install must expose the machine its wrapper feeds');

  // Passive: the game's frame goes out untouched.
  machine.observe(envelope(11));
  target.send(JSON.stringify(envelope(12, 'game-2')));
  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0] ?? '{}').commandSequence, 12);

  // Ours: claim, remember, send. Our frame keeps its number; the next game frame follows it.
  const mine = machine.claimNext();
  machine.remember('mine-1');
  target.send(JSON.stringify(envelope(mine, 'mine-1')));
  target.send(JSON.stringify(envelope(13, 'game-3')));

  assert.equal(JSON.parse(sent[1] ?? '{}').commandSequence, mine);
  assert.equal(JSON.parse(sent[2] ?? '{}').commandSequence, mine + 1);

  assert.equal(hook.release(), true);
  assert.equal(target.send, original, 'release must restore the original send');
  assert.equal(hook.active, false);
});

void test('installRenumberHook survives a rewrite failure by sending the original', () => {
  // A throw inside the rewrite must never drop the game's frame: a duplicate sequence is dropped by the
  // server, whereas a *missing* frame desyncs the game.
  const sent: string[] = [];
  const target = {
    send(data: unknown): void {
      sent.push(typeof data === 'string' ? data : String(data));
    },
  };
  const r = new Renumberer({
    getFrontier: () => {
      throw new Error('frontier unavailable');
    },
  });
  const hook = installRenumberHook({ target, renumberer: r });
  const machine = hook.renumberer;
  assert.ok(machine, 'the install must expose the caller-supplied machine');
  assert.equal(machine, r, 'the machine the caller supplied must be the one installed');
  machine.claimNext();

  const frame = JSON.stringify(envelope(99, 'game-9'));
  target.send(frame);
  assert.equal(sent.length, 1);
  // Whatever happened, the frame went out and was never silently dropped.
  assert.equal(JSON.parse(sent[0] ?? '{}').type, 'QuinoaCommand');
});

void test('installRenumberHook restores foreign wrappers rather than erasing them', () => {
  const wrapper = (): void => undefined;
  // Somebody else's hook, installed before us.
  const target: { send: unknown } = { send: wrapper };

  const hook = installRenumberHook({ target: target as { send: (d: unknown) => void } });
  assert.notEqual(target.send, wrapper);
  assert.equal(hook.release(), true);
  assert.equal(target.send, wrapper);
});

// --------------------------------------------------------------------------------------
// I1: one live machine, however many times the hook is installed
// --------------------------------------------------------------------------------------

void test('a second install adopts the live machine instead of building a detached one', () => {
  const sent: string[] = [];
  const target = {
    send(data: unknown): void {
      sent.push(String(data));
    },
  };
  const original = target.send;

  const first = installRenumberHook({ target });
  assert.equal(first.active, true);
  const live = first.renumberer;
  assert.ok(live, 'an install must expose the machine its wrapper feeds');

  // A userscript plus an importing mod is the realistic double install. The protocol allows one chooser
  // (I1), so the second call must adopt the live machine: a fresh machine that no wrapper feeds leaves the
  // caller numbering into a void while `active` still says true, and two of them number one command twice.
  const second = installRenumberHook({ target });
  assert.equal(second.install.outcome, 'reused', 'nothing may be written over our own wrapper');
  assert.equal(second.active, true);
  const adopted = second.renumberer;
  assert.ok(adopted, 'the second install must reach the live machine');
  assert.equal(adopted, live, 'the second install must not build a detached machine');
  assert.equal(first.reason, 'installed');
  assert.equal(second.reason, 'reused');

  // One command, one number: the frame leaves once and consumes exactly one sequence from the one machine.
  live.claimNext();
  const nextBefore = live.stats.next;
  const renumberedBefore = live.stats.renumbered;
  target.send(JSON.stringify(envelope(500, 'game-500')));

  assert.equal(sent.length, 1, 'the frame must leave exactly once, not once per wrapper');
  assert.equal(live.stats.renumbered, renumberedBefore + 1, 'exactly one renumbering happened');
  assert.equal(adopted.stats.renumbered, renumberedBefore + 1);
  assert.equal(live.stats.next, nextBefore + 1, 'exactly one sequence number was consumed');
  const wire = JSON.parse(sent[0] ?? '{}') as { commandSequence: number };
  assert.equal(wire.commandSequence, nextBefore);

  // The handle that did not write the slot must not erase it: brand.ts's documented `'reused'` contract,
  // and this is what lets a userscript and an importing mod coexist.
  assert.equal(second.release(), false);
  assert.equal(target.send, second.install.wrapper, 'a reused install leaves the live wrapper alone');
  assert.equal(first.active, true);

  // Releasing the owner takes our brand out of the slot, and the next install is a real one again.
  assert.equal(first.release(), true);
  assert.equal(target.send, original);
  assert.notEqual(classifySlot(target, 'send'), 'mine');
  assert.equal(first.active, false);
  assert.equal(second.active, false, 'active may only be true while the live wrapper is in the slot');

  const third = installRenumberHook({ target });
  assert.equal(third.reason, 'installed');
  const fresh = third.renumberer;
  assert.ok(fresh, 'a fresh install must expose its machine');
  assert.notEqual(fresh, live, 'after a release the next install builds a new machine');
  assert.equal(third.release(), true);
  assert.equal(target.send, original);
});

void test('a branded wrapper this module never installed yields no machine, and is overwritten never', () => {
  // A second *copy* of this module brands its wrapper with the same marker, so `'mine'` is the honest
  // classification, but its machine is unreachable from here. The handle must say so plainly rather than
  // hand back a machine nobody feeds, and it must not release a wrapper it did not write.
  const theirs = brandWrapper(function theirs(this: unknown, data: unknown): void {
    void data;
  }, 'renumber:send');
  const target: { send: unknown } = { send: theirs };

  const hook = installRenumberHook({ target: target as { send: (d: unknown) => void } });
  assert.equal(hook.install.outcome, 'reused');
  assert.equal(hook.reason, 'already-installed');
  assert.equal(hook.renumberer, null, 'there is no machine here to hand back');
  assert.equal(hook.active, true, 'active describes the slot, and the slot still holds our brand');
  assert.equal(target.send, theirs, 'the other copy of the wrapper must be left in place');
  assert.equal(hook.release(), false, 'a handle that did not install must not restore');
  assert.equal(target.send, theirs);
});

void test('an inherited branded send reports already-installed rather than wrapping it again', () => {
  // `classifySlot` reads own properties, because a prototype member is not a conflict; `installHook` reads
  // the value it would chain to. On an inherited branded send the two disagree, so the install reports
  // `'reused'`, and that path must not expose a machine either.
  const theirs = brandWrapper(function theirs(this: unknown, data: unknown): void {
    void data;
  }, 'renumber:send');
  const instance: { send: (data: unknown) => void } = Object.create({ send: theirs });

  assert.equal(classifySlot(instance, 'send'), 'clean');
  const hook = installRenumberHook({ target: instance });
  assert.equal(hook.install.outcome, 'reused');
  assert.equal(hook.reason, 'already-installed');
  assert.equal(hook.renumberer, null);
  assert.equal(hook.active, true);
  assert.equal(Object.hasOwn(instance, 'send'), false, 'nothing may be written to the instance');
  assert.equal(instance.send, theirs);
});
