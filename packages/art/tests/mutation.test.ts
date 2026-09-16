/**
 * The mutation drawing rules, checked against the game's own table on one side and the consumer's behaviour on
 * the other.
 *
 * Every record below is the game's, read out of `LayoutMotionController-CwhDlPns.js` (`jo`) and quoted in the
 * source comments with the byte range it came from, so a reviewer can go and look. The consumer is the second
 * oracle: `Wet` is `rgb(50, 180, 200)` at `.25` in `garden-viewer/server.mjs:735-736` as well as in the table,
 * and `Ambershine`'s wash is the amber that `server.test.mjs:228-239` measures in composed pixels
 * (`[190, 100, 40]` mixed at `.5`). Where the two agree, the test says so; where the package defines something
 * of its own, the test says that instead.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MutationArtRecord } from '../src/mutation.ts';
import { mutationArt, mutationOverlayArt, mutationStack } from '../src/mutation.ts';

/** `Wet`: `{filters:new To({color:`rgb(50, 180, 200)`,alpha:.25}),iconSprite:R.Wet.sprite,…}`. */
const wet: MutationArtRecord = {
  name: 'Wet',
  order: 2,
  tint: { color: 'rgb(50, 180, 200)', alpha: 0.25 },
  iconSprite: 'Wet',
  groundSprite: 'Puddle',
  overlaySprite: 'WetTallPlant',
};

/** `Ambershine`: the registry reference is `R.Ambershine.sprite` and the art it resolves to is `Amberlit`. */
const ambershine: MutationArtRecord = {
  name: 'Ambershine',
  order: 7,
  tint: { color: 'rgb(190, 100, 40)', alpha: 0.5 },
  iconSprite: 'Amberlit',
};

/** `Thunderstruck`: the only record with all four art fields, and the one that states `overlayFromBottom:!0`. */
const thunderstruck: MutationArtRecord = {
  name: 'Thunderstruck',
  order: 5,
  tint: { color: 'rgb(16, 141, 163)', alpha: 0.4 },
  iconSprite: 'Thunderstruck',
  groundSprite: 'ThunderstruckGround',
  overlaySprite: 'ThunderstruckTallPlant',
  overlayFromBottom: true,
};

/** The game's own over-set: `Ko = new Set(['Dawnlit','Ambershine','Dawncharged','Ambercharged'])`. */
const OVER_MUTATIONS = ['Dawnlit', 'Ambershine', 'Dawncharged', 'Ambercharged'];

void test("a mutation's wash is the colour its filter was constructed with, at the alpha beside it", () => {
  const drawing = mutationArt(wet);
  assert.equal(drawing.tint, 'rgba(50, 180, 200, 0.25)');
  assert.equal(drawing.alpha, 0.25);
});

void test("a mutation's icon is the art its registry reference resolves to, not its own name", () => {
  // The naming that is not guessable: the record is keyed `Ambershine` and draws `Amberlit`.
  assert.equal(mutationArt(ambershine).icon, 'Amberlit');
  assert.equal(mutationArt(wet).icon, 'Wet');
});

void test('Gold and Rainbow carry a material rather than a colour, so there is no wash to mix', () => {
  // `Gold`'s filter is a bare hoisted reference (`{filters:Oo}`) and `Rainbow`'s is
  // `new Ao(xe.Crop)` / `new Ao(xe.TallPlant)`. The consumer knows this today as a hardcoded pair of names
  // (`garden-viewer/server.mjs:589`); here it is what the record says.
  for (const name of ['Gold', 'Rainbow']) {
    const drawing = mutationArt({ name, material: true });
    assert.equal(drawing.tint, null, `${name} must not be given a wash this package made up`);
    assert.equal(drawing.material, true);
  }
});

void test('a filter whose literal states no colour is refused rather than guessed at', () => {
  // A hoisted reference the extractor could not resolve, or a literal that is not a colour: either way there
  // is nothing to mix, and a black wash would tint the crop wrongly rather than not at all.
  const drawing = mutationArt({ name: 'Mystery', tint: { color: 'currentColor', alpha: 0.5 } });
  assert.equal(drawing.tint, null);
  assert.equal(drawing.material, true);
});

void test('a filter that states no alpha is opaque, not transparent', () => {
  // The consumer's own default for a filter stating none (`garden-viewer/server.mjs:832`), and the reading
  // that means "mix none of the stated colour away" rather than "mix all of it away".
  const drawing = mutationArt({ name: 'Plain', tint: { color: 'rgb(1, 2, 3)' } });
  assert.equal(drawing.alpha, 1);
  assert.equal(drawing.tint, 'rgba(1, 2, 3, 1)');
});

void test('the over-mutations are drawn above the crop at the z-index the game gives them', () => {
  for (const name of OVER_MUTATIONS) {
    const stack = mutationStack({ name, order: 0 }, OVER_MUTATIONS);
    assert.equal(stack.over, true, `${name} is one of the game's over-mutations`);
    assert.equal(stack.zIndex, 10);
  }
  for (const name of ['Wet', 'Chilled', 'Frozen', 'Thunderstruck', 'Thundercharged']) {
    const stack = mutationStack({ name, order: 0 }, OVER_MUTATIONS);
    assert.equal(stack.over, false, `${name} keeps the container's own order`);
    assert.equal(stack.zIndex, 0);
  }
});

void test('the stack order is the table position, which is not the same as the alphabet', () => {
  // The game's table stacks them in key order: Rainbow first, Gold second, Wet third. The consumer reaches
  // the same sequence by sorting its transcribed copy by coin multiplier, and the two agree on all eleven.
  const rainbow = mutationStack({ name: 'Rainbow', order: 0 }, OVER_MUTATIONS).order;
  const gold = mutationStack({ name: 'Gold', order: 1 }, OVER_MUTATIONS).order;
  const wetOrder = mutationStack(wet, OVER_MUTATIONS).order;
  assert.ok(
    rainbow < gold && gold < wetOrder,
    `expected Rainbow < Gold < Wet, got ${rainbow}/${gold}/${wetOrder}`,
  );
});

void test('a mutation that states no order keeps zero rather than a position it invented', () => {
  assert.equal(mutationStack({ name: 'Unstated' }, OVER_MUTATIONS).order, 0);
});

void test('the tall-plant split is the ground art, and a record stating none draws over the crop', () => {
  assert.equal(mutationStack(wet, OVER_MUTATIONS).ground, 'Puddle');
  assert.equal(mutationStack(thunderstruck, OVER_MUTATIONS).ground, 'ThunderstruckGround');
  assert.equal(mutationStack({ name: 'Rainbow' }, OVER_MUTATIONS).ground, null);
});

void test('a tall plant gets the ground art at its foot and, for the weather ones, an overlay up it', () => {
  assert.deepEqual(mutationOverlayArt(wet), {
    ground: 'Puddle',
    overlay: 'WetTallPlant',
    fromBottom: false,
  });
  assert.deepEqual(mutationOverlayArt(thunderstruck), {
    ground: 'ThunderstruckGround',
    overlay: 'ThunderstruckTallPlant',
    fromBottom: true,
  });
  // Absent art is `null` rather than an empty string, so a caller cannot accidentally draw a sprite named "".
  assert.deepEqual(mutationOverlayArt({ name: 'Rainbow' }), {
    ground: null,
    overlay: null,
    fromBottom: false,
  });
});
