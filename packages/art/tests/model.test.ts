/**
 * The frame and box arithmetic, against the consumer's own measured values.
 *
 * Every expected number here was read out of `garden-viewer` rather than chosen:
 *
 *   - the frames are the atlas's own records, from `.logs/atlas-2x-*.json` (the 2x packs the viewer reads),
 *     quoted whole so a reader can see which fields the arithmetic uses and which it ignores;
 *   - the sizes and ratios a frame produces are what `garden-viewer/server.test.mjs:93-95` and `:115-121`
 *     assert about the tomato and the carrot;
 *   - the shares `placePart` and `fitPicture` return are what `garden-viewer/script.test.mjs:2223-2240`,
 *     `:2494-2496` and `:2568-2613` assert about a pot against a vine, a crop against its plant, and a crop
 *     anchored at the bottom of its art against the same crop anchored at the top.
 *
 * The three anchor defaults get a test each, because they are three different questions and the plan says
 * so: a frame with no anchor is drawn about its middle, a placement with no vertical anchor lands at 0.4,
 * and a plant's own art is drawn about its foot at 1. Collapsing any two of them moves the picture.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  boxOf,
  extentOf,
  fitPicture,
  frameBox,
  PLACEMENT_ANCHOR_Y,
  placePart,
  REFERENCE_TILE_PX,
} from '../src/index.js';

/** The atlas's own frame records, quoted from `.logs/atlas-2x-3.json`, `.logs/atlas-2x-2.json` and `.logs/atlas-2x-0.json`. */
const TOMATO = {
  frame: { x: 1018, y: 2654, w: 169, h: 152 },
  rotated: false,
  trimmed: true,
  spriteSourceSize: { x: 7, y: 6, w: 169, h: 152 },
  sourceSize: { w: 184, h: 164 },
  anchor: { x: 0.5, y: 1 },
  sourcePixelRatio: 2,
  visualBaselineY: 0.9146341463414634,
};
const SPROUT_VINE = {
  frame: { x: 2103, y: 177, w: 244, h: 225 },
  rotated: false,
  trimmed: false,
  spriteSourceSize: { x: 0, y: 0, w: 244, h: 225 },
  sourceSize: { w: 244, h: 225 },
  anchor: { x: 0.504098, y: 0.826667 },
  visualBaselineY: 0.9422222222222222,
};
const CARROT = {
  frame: { x: 2446, y: 3211, w: 377, h: 188 },
  rotated: false,
  trimmed: true,
  spriteSourceSize: { x: 5, y: 4, w: 377, h: 188 },
  sourceSize: { w: 386, h: 192 },
  anchor: { x: 0.298251, y: 0.990885 },
  sourcePixelRatio: 2,
  visualBaselineY: 0.9947916666666666,
};
const NOTIFY_FLAG = {
  frame: { x: 1361, y: 2970, w: 185, h: 83 },
  rotated: false,
  trimmed: true,
  spriteSourceSize: { x: 0, y: 28, w: 185, h: 83 },
  sourceSize: { w: 256, h: 128 },
  anchor: { x: 0.5, y: 0.5 },
  visualBaselineY: 0.8046875,
};

void test('a frame is drawn at its source size over its source pixel ratio', () => {
  // server.test.mjs:92-95 -- "a tomato's crop art is 184 pixels and is drawn at 92 of them, because its
  // frame says its pixels are twice as fine".
  const tomato = frameBox(TOMATO);
  assert.deepEqual(tomato, { width: 92, height: 82, pixelRatio: 2, anchorX: 0.5, anchorY: 1 });
  assert.equal(tomato.pixelRatio, 2, 'and its frame states how fine its pixels are, which the offset needs');

  // server.test.mjs:104-105 -- the vine's 82.7% anchor is what leaves the plant standing in its pot.
  const vine = frameBox(SPROUT_VINE);
  assert.deepEqual(vine, {
    width: 244,
    height: 225,
    pixelRatio: 1,
    anchorX: 0.504098,
    anchorY: 0.826667,
  });
  assert.ok(
    Math.abs(vine.anchorY - 0.826667) < 0.0001,
    `the plant is anchored 82.7% down its art, got ${vine.anchorY}`,
  );

  // server.test.mjs:115-121 -- a carrot's crop art is 386 pixels and is drawn at 193, anchored near its base.
  const carrot = frameBox(CARROT);
  assert.deepEqual(carrot, { width: 193, height: 96, pixelRatio: 2, anchorX: 0.298251, anchorY: 0.990885 });
  assert.ok(carrot.anchorY > 0.9, 'a carrot crop is drawn about a point near its base');
});

void test('a frame with no sourcePixelRatio draws at its stated size rather than NaN', () => {
  // atlas-2x-0.json -- NotifyFlag-0 is one of the 803 of 1,229 frames with no sourcePixelRatio
  // (docs/mgjs-art-sources.md, field-presence table). The viewer's own fallback is server.mjs:221-222.
  const flag = frameBox(NOTIFY_FLAG);
  assert.deepEqual(flag, { width: 256, height: 128, pixelRatio: 1, anchorX: 0.5, anchorY: 0.5 });
  assert.ok(Number.isFinite(flag.width) && Number.isFinite(flag.height), 'not NaN and not undefined');

  // The same statement made of the arithmetic rather than of one frame.
  assert.deepEqual(frameBox({ sourceSize: { w: 40, h: 20 } }), {
    width: 40,
    height: 20,
    pixelRatio: 1,
    anchorX: 0.5,
    anchorY: 0.5,
  });
  // A ratio of zero or a negative one is not a divisor; the frame is drawn at its stated size instead.
  assert.equal(frameBox({ sourceSize: { w: 40, h: 20 }, sourcePixelRatio: 0 }).width, 40);
  assert.equal(frameBox({ sourceSize: { w: 40, h: 20 }, sourcePixelRatio: -2 }).width, 40);
});

void test('a frame with no anchor is drawn about its middle, which is not the other two defaults', () => {
  const box = frameBox({ sourceSize: { w: 10, h: 10 } });
  assert.equal(box.anchorX, 0.5);
  assert.equal(box.anchorY, 0.5);
  // The middle is the frame's default. A placement's default vertical anchor is 0.4 (the game's own, read
  // at server.mjs:947) and a plant's own art defaults to its foot at 1 (server.mjs:349-351). Three
  // questions, three numbers, and the test exists so that folding them together is a failing test.
  assert.notEqual(PLACEMENT_ANCHOR_Y, box.anchorY);
  assert.notEqual(1, box.anchorY);
});

void test('a record that states no source size draws at nothing rather than at a guessed size', () => {
  assert.deepEqual(frameBox({}), { width: 0, height: 0, pixelRatio: 1, anchorX: 0.5, anchorY: 0.5 });
  assert.deepEqual(frameBox({ sourceSize: { w: '184', h: null } }).width, 0);
  assert.deepEqual(frameBox(undefined), {
    width: 0,
    height: 0,
    pixelRatio: 1,
    anchorX: 0.5,
    anchorY: 0.5,
  });
});

void test('the reference tile is the 256 the scale cap is taken against', () => {
  // garden.mjs:186 and page.html:1254 each state it, and server.mjs:951-952 divides by it unnamed:
  // `Math.min(MUTATION_SCALE_CAP, Math.min(art.width, art.height) / 256)`.
  assert.equal(REFERENCE_TILE_PX, 256);
});

void test('a part placed in a box keeps the share of the box it was given', () => {
  // script.test.mjs:2223-2240 -- the pot's art is 170 by 164 against the plant's 244 by 225, and the pot's
  // share of the plant's picture has to be exactly that ratio. The page places the plant inside the picture
  // of the plant and its crops, then places the pot against the assembled whole; those are two boxes and the
  // pot's share of the whole is its placement's share multiplied by the picture's share of it.
  const picture = { left: 0, top: 0, width: 244, height: 225 }; // the vine's frame, as the picture's box
  const pot = { width: 170, height: 164 }; // server.mjs:495 -- the pot every potted plant stands in
  const inWhole = (part: { width: number; height: number }) => {
    const placed = placePart({ left: 0, top: 0, ...part }, extentOf([picture]));
    const fitted = fitPicture(picture, { width: 100, height: 100 });
    return { width: placed.width * fitted.width, height: placed.height * fitted.height };
  };
  const potInWhole = inWhole(pot);
  const plantInWhole = inWhole(picture);
  assert.ok(Math.abs(potInWhole.width / plantInWhole.width - 170 / 244) < 0.01, 'across');
  assert.ok(Math.abs(potInWhole.height / plantInWhole.height - 164 / 225) < 0.01, 'down');

  // script.test.mjs:2494-2496 -- a tomato's crop is 92 across against its plant's 244: "92 against 244:
  // the art the server sends, which is the frame's pixels at its own pixel ratio." Both are placed in the
  // plant's own box, as the page places them in one picture.
  const crop = frameBox(TOMATO);
  const vine = frameBox(SPROUT_VINE);
  const inThePlant = extentOf([{ left: 0, top: 0, ...vine }]);
  const cropShare = placePart({ left: 0, top: 0, ...crop }, inThePlant);
  const plantShare = placePart({ left: 0, top: 0, ...vine }, inThePlant);
  assert.ok(
    Math.abs(cropShare.width / plantShare.width - 92 / 244) < 0.01,
    "the crop is drawn at the plant's own ratio",
  );
  assert.equal(
    boxOf([
      { left: 0, top: 0, ...crop },
      { left: 0, top: 0, ...vine },
    ]).width,
    244,
    'and the plant is the wider of the two, so it sets the box',
  );
});

void test('a turned part is measured around its corners, and placed at its own share', () => {
  // script.test.mjs:1268-1290 measures a turned crop's extent the same way: corners and all, "rather than
  // around where they were put". A part twice as wide as it is tall, turned a quarter about its middle:
  const turned = { left: 100, top: 50, width: 100, height: 50, anchorX: 0.5, anchorY: 0.5, turn: 90 };
  const extent = extentOf([turned]);
  assert.equal(Math.round(extent.width), 50, 'the turned part reaches 50 across');
  assert.equal(Math.round(extent.height), 100, 'and 100 down');
  assert.equal(Math.round(extent.minX), 125, 'measured from the corner it actually reaches');
  assert.equal(Math.round(extent.minY), 25);

  // A crop is turned about its own anchor, "which is where it is pinned to the plant, not about its middle"
  // (page.html:1313-1316). The placement states that origin, and states none for a part that does not turn.
  const aboutItsFoot = placePart(
    { left: 0, top: 0, width: 92, height: 82, anchorX: 0.5, anchorY: 1, turn: 45 },
    extentOf([{ left: 0, top: 0, width: 92, height: 82 }]),
  );
  assert.equal(aboutItsFoot.transformOriginX, 0.5);
  assert.equal(aboutItsFoot.transformOriginY, 1);

  const straight = placePart(
    { left: 0, top: 0, width: 92, height: 82, anchorY: 1 },
    extentOf([{ left: 0, top: 0, width: 92, height: 82 }]),
  );
  assert.equal(straight.transformOriginX, null);
  assert.equal(straight.transformOriginY, null);
});

void test('a crop anchored at the bottom of its art lands a crop lower than one anchored at the top', () => {
  // script.test.mjs:2568-2613 draws the same plant and the same crop twice, once with the frame's own
  // anchor at the bottom and once at the top, and checks "that the crop is a full crop-height lower in the
  // second" -- "which is exactly what anchoring means, and what centring the crop would not do". The anchors
  // and sizes are that test's own picture fixture: a tomato's 244x225 plant art and its 92x82 crop art.
  //
  // Where the crop is *put* is not this function's question. The page gets that coordinate from the server's
  // placement, which resolves the anchor into a y (`cropPlacement` in `garden.mjs`, commit 7's
  // `plantPicture`). What `placePart` is asked is the last step: a crop put one crop-height lower, and
  // turned about the opposite end of its own art, comes out one crop-height lower as a share of the box.
  const plant = { left: 0, top: 0, width: 244, height: 225 };
  const inBox = extentOf([plant]);
  const height = 82;
  const slot = 40; // the crop's own top edge with its anchor at the top of its art
  const crop = (top: number, anchorY: number) => ({ left: 0, top, width: 92, height, anchorX: 0.5, anchorY });

  const bottom = placePart(crop(slot + height, 1), inBox);
  const top = placePart(crop(slot, 0), inBox);
  assert.ok(bottom.height > 0 && top.height > 0, 'both crops are drawn');
  assert.ok(
    Math.abs(bottom.top - top.top - bottom.height) < 1e-12,
    `the crop put one crop-height lower is one crop-height lower in the box ` +
      `(${bottom.top.toFixed(3)} against ${top.top.toFixed(3)})`,
  );
  // Neither crop turns, and the page only states a turning origin for a crop that does (`turn !== 0` at
  // page.html:1313), so a part that does not turn must not carry an origin a caller could rotate by.
  assert.equal(bottom.transformOriginX, null);
  assert.equal(bottom.transformOriginY, null);

  // A share of a box is the part over the box: 82/225 is a crop's share of the plant it is drawn on, and the
  // plant's own part is the whole of it.
  assert.equal(inBox.width, 244);
  assert.equal(inBox.height, 225);
  assert.ok(Math.abs(bottom.height - 82 / 225) < 1e-12, "the crop's share of the plant's art");
  assert.ok(Math.abs(top.width - 92 / 244) < 1e-12, "the crop's width against the plant's art");
});

void test('a box with no width or height gives its parts nothing rather than NaN', () => {
  const nothing = placePart(
    { left: 10, top: 10, width: 20, height: 20 },
    { minX: 0, minY: 0, width: 0, height: 0 },
  );
  assert.deepEqual(nothing, {
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    transformOriginX: null,
    transformOriginY: null,
  });
  assert.deepEqual(extentOf([]), { minX: 0, minY: 0, width: 0, height: 0 });
  assert.deepEqual(boxOf([]), { left: 0, top: 0, width: 0, height: 0 });
});

void test('a picture keeps its own shape in the room it is given', () => {
  // page.html:1506-1515 -- "A picture fitted into the box it is given, centred, keeping its own shape
  // whatever the box's." A clover's picture is wider than it is tall; a potted tomato's is taller.
  const wide = fitPicture({ left: 0, top: 0, width: 244, height: 225 }, { width: 100, height: 100 });
  assert.ok(Math.abs(wide.width - 1) < 0.0001, 'the longer side takes the whole of its axis');
  assert.ok(
    Math.abs(wide.height - 225 / 244) < 0.0001,
    'and the shorter side the same fraction of the other',
  );

  const tall = fitPicture({ left: 0, top: 0, width: 170, height: 244 }, { width: 100, height: 100 });
  assert.ok(Math.abs(tall.height - 1) < 0.0001);
  assert.ok(Math.abs(tall.width - 170 / 244) < 0.0001);

  // A room that is not square has no consumer to port: the page fits every picture into a square, and this
  // is the package's own answer -- one factor for both axes, never a stretch, so a square picture in a 2:1
  // room is half as wide as the room and as tall as it.
  const boxed = fitPicture({ left: 0, top: 0, width: 100, height: 100 }, { width: 300, height: 150 });
  assert.deepEqual(boxed, { width: 0.5, height: 1 });
  // With no room stated, the room is square, which is the box the page gives every picture today.
  assert.deepEqual(fitPicture({ left: 0, top: 0, width: 244, height: 225 }).height, 225 / 244);
  // And a picture with nothing in it is drawn at nothing rather than at a division by zero.
  assert.deepEqual(fitPicture({ left: 0, top: 0, width: 0, height: 10 }), { width: 0, height: 0 });
});

void test('an extent and a box agree about the same parts', () => {
  // `extentOf` measures from a part's drawn corners and `boxOf` unions placements; the picture's own box is
  // the same rectangle either way, which is what lets the page place a recipe's parts by its box.
  const parts = [
    { left: -12, top: -30, width: 92, height: 82 },
    { left: 40, top: -60, width: 290, height: 232 },
  ];
  const extent = extentOf(parts);
  const box = boxOf(parts);
  assert.deepEqual(box, { left: extent.minX, top: extent.minY, width: extent.width, height: extent.height });
  assert.deepEqual(box, { left: -12, top: -60, width: 342, height: 232 });
});
