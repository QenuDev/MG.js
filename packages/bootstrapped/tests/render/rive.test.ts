/**
 * `isArtboardLike`: the structural fallback must agree with `ctors.ts`'s `isRiveLike`.
 *
 * ## The bug this exists for
 *
 * "Is this value a Rive artboard host?" had three answers in the tree. `render/ctors.ts`'s `isRiveLike`
 * tested `rive`/`artboard`/`stateMachine`; `render/world.ts`'s private `isRiveHostLike` tested the same
 * three keys; `render/rive.ts`'s `isArtboardLike` structural fallback tested only `stateMachine` and
 * `rive`. So a node carrying only an `artboard` property was a Rive host to two modules and not to the
 * third, and the third is the one that decides whether `wrapArtboard` accepts it.
 *
 * That is a correctness bug rather than duplication: the direction of the fix is unambiguous (take the
 * wider, documented, tested set), and the assertion below fails on the old code while the
 * `setTextRunValue` route continues to work exactly as before.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isArtboardLike } from '../../src/render/rive.ts';

void test('isArtboardLike accepts an artboard-only node through the structural fallback', () => {
  // The drift this pins: the fallback at rive.ts:398 tested two of `isRiveLike`'s three keys, so an
  // artboard-only node was rejected by `wrapArtboard` while two other modules called it a Rive host.
  assert.equal(isArtboardLike({ artboard: {} }), true, 'an artboard-only node is a Rive host');
  assert.equal(isArtboardLike({ stateMachine: {} }), true);
  assert.equal(isArtboardLike({ rive: {} }), true);
  assert.equal(isArtboardLike({}), false);
  assert.equal(isArtboardLike({ text: 'hi' }), false, 'a Pixi Text is not a Rive host');
});

void test('isArtboardLike keeps the documented method route ahead of the structural one', () => {
  // The fallback widening must not disturb the primary signal §2.8 documents.
  assert.equal(isArtboardLike({ setTextRunValue: (): void => undefined }), true);
  assert.equal(isArtboardLike({ setBooleanInput: (): void => undefined }), true);
  assert.equal(isArtboardLike({ fireTrigger: (): void => undefined }), true);
});
