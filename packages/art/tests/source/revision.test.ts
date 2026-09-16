/**
 * The revision, proved to change when its inputs change and to hold still when they do not.
 *
 * The case that matters is the one the viewer got wrong twice: a picture's pixels depend on something the
 * version number does not move for -- a species' art, a mutation's layer, the order two of them stack -- and a
 * cached picture that survives that change is served as if it were current. So every test here changes exactly
 * one thing about a realistic input and asserts the revision moved.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { contentRevision } from '../../src/source/revision.ts';

/** What the viewer keys its sprite cache with today, plus the inputs the plan wants folded into it. */
const inputs = () => ({
  artVersion: '1192',
  parts: [
    { art: 'CloverThreeLeaf', frame: { x: 1361, y: 2970, w: 185, h: 83 }, scale: 1 },
    { art: 'Wet', mutation: true, frame: { x: 44, y: 12, w: 64, h: 64 }, scale: 0.75 },
  ],
});

void test('the same inputs give the same revision', () => {
  assert.equal(contentRevision(inputs()), contentRevision(inputs()));
});

void test('a changed art version changes the revision', () => {
  const before = contentRevision(inputs());
  const after = contentRevision({ ...inputs(), artVersion: '1193' });
  assert.notEqual(before, after);
});

void test('a changed mutation art name changes the revision', () => {
  const before = contentRevision(inputs());
  const mutated = inputs();
  const parts = [...(mutated.parts as { art: string }[])];
  parts[1] = { ...parts[1], art: 'Chilled' };
  const after = contentRevision({ ...mutated, parts });
  assert.notEqual(before, after);
});

void test('a changed atlas frame changes the revision', () => {
  const before = contentRevision(inputs());
  const moved = inputs();
  const parts = [...(moved.parts as { frame: { x: number } }[])];
  parts[0] = { ...parts[0], frame: { ...parts[0]?.frame, x: 1362 } };
  assert.notEqual(before, contentRevision({ ...moved, parts }));
});

void test('the order two layers stack in is part of the revision', () => {
  // Built from `inputs()` twice rather than by casting the first one's parts to `unknown[]`: the cast
  // typechecked inside this file and failed `tsconfig.tests.json`, which is the project that sees every
  // test file. A cast that hides the element type is exactly what a second project notices and one
  // project does not.
  const forward = inputs();
  const reversed = { ...inputs(), parts: [...inputs().parts].reverse() };
  assert.notEqual(contentRevision(forward), contentRevision(reversed));
});

void test('a key order is not a value', () => {
  const one = contentRevision({ artVersion: '1192', frame: { x: 1, y: 2 } });
  const other = contentRevision({ frame: { y: 2, x: 1 }, artVersion: '1192' });
  assert.equal(one, other);
});

void test('an absent field and an undefined one are the same input', () => {
  assert.equal(
    contentRevision({ artVersion: '1192', overlay: undefined }),
    contentRevision({ artVersion: '1192' }),
  );
});

void test('a string that looks like a number is not that number', () => {
  assert.notEqual(contentRevision({ id: '1' }), contentRevision({ id: 1 }));
});

void test('a comma inside a string is not a boundary between two', () => {
  // The case a naive `join(',')` gets wrong, and the reason every string is quoted before it is hashed.
  assert.notEqual(contentRevision(['a,b']), contentRevision(['a', 'b']));
});

void test('a revision is sixteen hex characters', () => {
  assert.match(contentRevision(inputs()), /^[0-9a-f]{16}$/);
});

void test('an input that cannot key a cache is refused rather than hashed', () => {
  // `String(NaN)` collides with the string "NaN" and `String(() => {})` collides with every other function,
  // so a revision built from either would not change when the value did -- the one failure this file exists
  // to prevent. Both are only reachable through a cast, which is exactly why they are worth a test.
  assert.throws(() => contentRevision({ scale: Number.NaN }), /cannot key a cache/);
  assert.throws(() => contentRevision({ scale: Number.POSITIVE_INFINITY }), /cannot key a cache/);
  assert.throws(() => contentRevision({ art: (() => 'Clover') as unknown as string }), /cannot key a cache/);
});
