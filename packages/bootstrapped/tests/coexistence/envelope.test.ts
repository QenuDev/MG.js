/**
 * The `QuinoaCommand` envelope predicate has exactly one home.
 *
 * ## The bug this exists for
 *
 * "Is this outbound frame a `QuinoaCommand` envelope?" was answered in three places across two files.
 * `coexistence/renumber.ts` and `client.ts` each defined their own `asEnvelope`, and each carried its own
 * copy of the "length, then substring, then parse" pre-parse gate. `client.ts`'s copy was justified in a
 * comment as keeping "the two modules independent", which was untrue: `client.ts` already imported
 * `Renumberer` from `renumber.ts`, so the copy bought no independence at all.
 *
 * Three copies of a wire predicate are three chances to disagree about what the protocol means, and the
 * disagreement would be *silent*: a frame one copy renumbers and another leaves alone is a sequence
 * violation the player experiences as a dead session with no error. Two of the copies were byte-identical
 * when this test was written. That is the reason no behavioural test could have caught the drift that
 * had not happened yet.
 *
 * ## Why the assertions are structural
 *
 * So the first test asserts **function identity** rather than behaviour. A fourth copy cannot be added
 * without failing it, because a copy is a different function object. That is the property the fix exists
 * to guarantee, and it is the only assertion here that fails on the code as it was.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyRenumberingToString,
  asEnvelope as asEnvelopeFromClient,
  parseEnvelope as parseEnvelopeFromClient,
} from '../../src/client.ts';
import { asEnvelope, parseEnvelope } from '../../src/coexistence/envelope.ts';
import {
  applyRenumbering,
  asEnvelope as asEnvelopeFromRenumber,
  Renumberer,
} from '../../src/coexistence/renumber.ts';

void test('every consumer reaches the same predicate object', () => {
  assert.equal(
    asEnvelopeFromClient,
    asEnvelope,
    'client.ts must re-export the one predicate, not define one',
  );
  assert.equal(asEnvelopeFromRenumber, asEnvelope, 'renumber.ts must re-export the one predicate');
  assert.equal(parseEnvelopeFromClient, parseEnvelope, 'client.ts must re-export the one pre-parse gate');
  assert.equal(
    applyRenumberingToString,
    applyRenumbering,
    'the string path is the same function as the object path, not a second copy of it',
  );
});

void test('asEnvelope accepts a QuinoaCommand object, by reference, and nothing else', () => {
  const frame = { type: 'QuinoaCommand', commandSequence: 3, requestId: 'r' };
  assert.equal(asEnvelope(frame), frame, 'the frame itself is handed back, not a copy of it');

  assert.equal(asEnvelope({ type: 'RoomFrame', commandSequence: 3 }), null, 'a sequence alone is not enough');
  assert.equal(asEnvelope('{"type":"QuinoaCommand"}'), null, 'a string is not a parsed envelope');
  assert.equal(asEnvelope(null), null);
  assert.equal(asEnvelope(undefined), null);
  assert.equal(asEnvelope(['QuinoaCommand']), null, 'an array carrying the type name is not an envelope');
  assert.equal(asEnvelope({ type: 'QuinoaCommandResult' }), null);
});

void test('parseEnvelope refuses anything that is not a plausible envelope, without parsing it', () => {
  assert.equal(parseEnvelope(null), null);
  assert.equal(parseEnvelope(42), null);
  assert.equal(parseEnvelope(''), null);
  // Too short to contain the marker, so the O(n) substring scan is never reached.
  assert.equal(parseEnvelope('{"a":1}'), null);
  assert.equal(parseEnvelope('{"type":"RoomFrame","commandSequence":1}'), null);
  // Carries the marker but is not JSON: the parse is attempted and its failure is swallowed.
  assert.equal(parseEnvelope('{"type":"QuinoaCommand"'), null);

  const raw = '{"type":"QuinoaCommand","commandSequence":7}';
  assert.deepEqual(parseEnvelope(raw), { type: 'QuinoaCommand', commandSequence: 7 });
});

void test('applyRenumberingToString consumes no number for a frame it built itself', () => {
  const renumberer = new Renumberer({ label: 'envelope-owner' });
  const raw = '{"type":"QuinoaCommand","commandSequence":4,"requestId":"ours-1"}';
  renumberer.remember('ours-1');

  // This is the characterisation test for the deleted `isOurs` guard. `rewrite()` checks ownership itself
  // and answers `'ours'`, and the caller only rewrites on `'renumbered'`, so removing the caller's guard
  // is behaviour-preserving, and this pins the behaviour that guard was there to protect: our own frame is
  // returned byte-identical and the counter does not move.
  const before = renumberer.peekNext();
  assert.equal(applyRenumberingToString(raw, renumberer), raw);
  assert.equal(renumberer.peekNext(), before, 'our own frame must not consume a sequence number');
});
