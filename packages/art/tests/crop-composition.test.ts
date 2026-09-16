/**
 * A crop's picture as a recipe, against the picture the viewer composes today.
 *
 * The viewer's server rasterises a mutated crop (`server.mjs:566-618`) and the page draws that picture
 * inside the box the server states. The recipe is the same picture turned inside out, so the test has two
 * kinds of claim and they are different:
 *
 *   - The consumer's own numbers, ported rather than rewritten: the box measured for `Clover` (`top: -18.6`,
 *     `103.1` tall, `script.test.mjs:1857-1859`), the wash a frosted and amber-lit clover is drawn through
 *     (`rgb(190, 100, 40)` at `.5`, `server.test.mjs:228-248`), and the bands the consumer's raster order is
 *     built from (`server.mjs:922-924`: `-1` for a decal, `20 + order` for a picture, `30 + order` for an
 *     over-mutation).
 *   - The picture itself. `fixtures/crop-composition/` holds what the viewer's own `composeCrop` drew for
 *     `Clover` wearing `Frozen,Ambershine`, and the three layer images it drew that picture from. The
 *     recipe is rasterised here with the package's codec over those layer images and compared pixel for
 *     pixel, so the claim is that the two are the same picture rather than that two sets of numbers are
 *     close. Swapping the two mutation pictures is compared too, because an equality that a wrong order
 *     also satisfies proves nothing.
 *
 * The tables are `data/1176.json`'s and the frames are the capture's, at art 1192: that is the pair the
 * viewer composed with, since its tables are its own transcription of the game and its frames come from the
 * live atlas. Every table value these cases read -- the anchor table, the over-set, the mutation order, the
 * scale caps -- is the value `mutation-placement.test.ts` already measures against the same frames.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseArtData } from '../src/bundle/data.ts';
import { type CropLayer, type CropRecipe, type CropTables, cropComposition } from '../src/crop.ts';
import { boxOf, type FrameBox, frameBox } from '../src/model.ts';
import { decodePng, drawOver, type PngImage, scaled, washArt } from '../src/node/png.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, '../fixtures/crop-composition');

const data = parseArtData(readFileSync(resolve(here, '../data/1176.json'), 'utf8'));
const tables: CropTables = data.tables;

/** The atlas frames the capture wrote, as the frames a recipe reads: `frameBox` of each stated frame. */
const frames: Readonly<Record<string, FrameBox>> = (() => {
  const stated = JSON.parse(readFileSync(resolve(FIXTURES, 'frames.json'), 'utf8')) as {
    frames: Readonly<Record<string, unknown>>;
  };
  return Object.fromEntries(Object.entries(stated.frames).map(([key, frame]) => [key, frameBox(frame)]));
})();

/** One captured picture, decoded to its pixels. */
const picture = (name: string): PngImage => decodePng(readFileSync(resolve(FIXTURES, `${name}.png`)));

/** A value a test is about to use, or a failure naming what was missing. */
function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(what);
  return value;
}

/**
 * One rasterisation of a recipe, the way the viewer composes it (`server.mjs:594-615`).
 *
 * The canvas is the box at the art's own resolution, each layer's rectangle is placed by the box's own
 * origin, and the art is drawn through its wash while a mutation's picture is drawn at its drawn size --
 * scaled up when the sprite the caller holds is not already that size, which is the consumer's own rule
 * (`server.mjs:606-608`).
 */
function rasterise(recipe: CropRecipe, pixels: Readonly<Record<string, PngImage>>): PngImage {
  const width = Math.max(1, Math.round(recipe.box.width * recipe.pixelRatio));
  const height = Math.max(1, Math.round(recipe.box.height * recipe.pixelRatio));
  const canvas: PngImage = { width, height, pixels: new Uint8Array(width * height * 4) };
  const across = (x: number) => Math.round((x - recipe.box.left) * recipe.pixelRatio);
  const down = (y: number) => Math.round((y - recipe.box.top) * recipe.pixelRatio);
  for (const layer of recipe.layers) {
    const image = pixels[layer.sprite];
    if (image === undefined) throw new Error(`the fixture holds no pixels for ${layer.sprite}`);
    if (layer.kind === 'art') {
      const washed = washArt(image, layer.washes);
      drawOver(canvas, washed, across(layer.left), down(layer.top));
      continue;
    }
    const want = {
      width: Math.max(1, Math.round(layer.width * recipe.pixelRatio)),
      height: Math.max(1, Math.round(layer.height * recipe.pixelRatio)),
    };
    const sized =
      image.width === want.width && image.height === want.height
        ? image
        : scaled(image, want.width, want.height);
    drawOver(canvas, sized, across(layer.left), down(layer.top));
  }
  return canvas;
}

/** How two pictures of the same size differ, channel by channel. */
function differences(
  ours: PngImage,
  theirs: PngImage,
): { pixels: number; channels: number; differing: number; worst: number; mean: number } {
  assert.deepEqual(
    [ours.width, ours.height],
    [theirs.width, theirs.height],
    'two pictures can only be compared at one size',
  );
  let differing = 0;
  let worst = 0;
  let total = 0;
  for (let at = 0; at < ours.pixels.length; at += 1) {
    const delta = Math.abs((ours.pixels[at] ?? 0) - (theirs.pixels[at] ?? 0));
    if (delta !== 0) differing += 1;
    if (delta > worst) worst = delta;
    total += delta;
  }
  return {
    pixels: ours.width * ours.height,
    channels: ours.pixels.length,
    differing,
    worst,
    mean: total / ours.pixels.length,
  };
}

/** The three layer images the captured composition was drawn from. */
const captured: Readonly<Record<string, PngImage>> = {
  'sprite/plant/CloverThreeLeaf': picture('art'),
  'sprite/mutation/Frozen': picture('frozen'),
  'sprite/mutation/Amberlit': picture('amberlit'),
};

/** The recipe for the case the capture is of. */
function cloverWearingFrozenAndAmbershine(): CropRecipe {
  return required(
    cropComposition('Clover', ['Frozen', 'Ambershine'], tables, frames),
    'Clover is a species the tables state and the atlas holds',
  );
}

void test("a crop's box is its art unioned with every mutation the game states, not only the ones it wears", () => {
  const recipe = cloverWearingFrozenAndAmbershine();
  // The consumer's own measured box for Clover, to the tenth of a pixel (`script.test.mjs:1857-1859`).
  assert.equal(Math.round(recipe.box.left * 10) / 10, 0, 'the art reaches no further left than itself');
  assert.equal(Math.round(recipe.box.top * 10) / 10, -18.6, 'and the tallest mutation reaches above it');
  assert.equal(Math.round(recipe.box.width * 10) / 10, 58, 'which is the art, 58 pixels across');
  assert.equal(Math.round(recipe.box.height * 10) / 10, 103.1, 'and 103.1 tall');

  // Not the box of what this crop wears: the frost and the aura both land inside the art, and the mutation
  // that reaches 18.6 pixels above it is one this crop does not carry. The box is the species', which is
  // what lets one picture be placed whatever a crop turns out to wear.
  const worn = boxOf(recipe.layers);
  assert.ok(
    worn.top > recipe.box.top,
    `the worn pictures reach ${worn.top}, the box reaches ${recipe.box.top}: a box per species, not per set`,
  );
});

void test('the layers are the raster order: a decal, the art it pools under, then the pictures over it', () => {
  const recipe = cloverWearingFrozenAndAmbershine();
  assert.deepEqual(
    recipe.layers.map((layer) => [layer.kind, layer.mutation, layer.decal, layer.over]),
    [
      ['art', null, false, false],
      ['mutation', 'Frozen', false, false],
      ['mutation', 'Ambershine', false, true],
    ],
    'the art is drawn first, then the pictures over it',
  );

  // The order is the consumer's bands, read from the game's own table rather than written here: a decal is
  // -1, a picture is 20 + the table's order, and an over-mutation is 30 + it (`server.mjs:922-924`). The
  // amber aura is one of the game's four over-mutations, so it is drawn above the frost it is worn with
  // whatever the table's order says.
  const bands = recipe.layers
    .filter((layer) => layer.kind === 'mutation')
    .map((layer) => {
      const order = tables.mutationArt[layer.mutation ?? '']?.order ?? 0;
      return layer.over ? 30 + order : layer.decal ? -1 : 20 + order;
    });
  assert.deepEqual(bands, [24, 37], 'the frost is 20 + 4 and the amber aura is 30 + 7');
});

void test('a tall plant’s mutation pools under the art instead of drawing over it', () => {
  // Bamboo is a patch the game draws tall (`displayFlags['sprite/plant/Bamboo'].isTallPlant`), so a mutation
  // that states a ground art is drawn as that decal -- at twice the size, which `mutationPlacement` answers
  // and its own test measures -- and under the plant rather than over it.
  const recipe = required(
    cropComposition('Bamboo', ['Wet'], tables, frames),
    'Bamboo is a species the tables state and the atlas holds',
  );
  assert.deepEqual(
    recipe.layers.map((layer) => [layer.kind, layer.sprite, layer.decal, layer.over]),
    [
      ['mutation', 'sprite/mutation/Puddle', true, false],
      ['art', 'sprite/plant/Bamboo', false, false],
    ],
    'the puddle is drawn before the plant it pools under',
  );
});

void test('a patch is drawn from its species’ plant art, and a crop from its crop art', () => {
  // Carrot states two different pictures for its parts: `sprite/plant/Carrot` is what it is picked as and
  // `sprite/plant/BabyCarrot` is what stands on the tile, and a patch is what stands there.
  const recipe = required(
    cropComposition('Carrot', [], tables, frames),
    'Carrot is a species the tables state and the atlas holds',
  );
  assert.equal(recipe.art, tables.plants['Carrot']?.plant?.sprite, 'the plant’s own art, not the crop’s');
  assert.equal(recipe.harvestType, 'Single', 'because the species is grown as a patch');
  assert.deepEqual(
    recipe.layers.map((layer) => layer.sprite),
    [tables.plants['Carrot']?.plant?.sprite],
    'and a crop wearing nothing is still a picture of its own art',
  );
});

void test('a material is not a picture and is not washed, so the recipe says so rather than drawing it', () => {
  // Gold and Rainbow are shaders: the game hands them to a filter that states no colour, they state no art,
  // and the consumer asks the API to compose them instead (`server.mjs:586-590`).
  for (const material of ['Gold', 'Rainbow']) {
    const recipe = required(
      cropComposition('Clover', [material], tables, frames),
      `${material} is a mutation the tables state`,
    );
    assert.deepEqual(
      recipe.layers.map((layer) => [layer.kind, layer.mutation]),
      [['art', null]],
      `${material} adds no layer`,
    );
    const art: CropLayer = required(recipe.layers[0], 'the art is the one layer');
    assert.equal(art.material, true, `${material} is a material rather than a colour`);
    assert.deepEqual(art.washes, [], 'so the art is not washed by a colour it does not carry');
  }
});

void test('a species the atlas cannot draw is no picture, rather than a picture of numbers', () => {
  assert.equal(
    cropComposition('Clover', ['Frozen'], tables, {}),
    null,
    'no frame for the art means there is no art to place a mutation on',
  );
  assert.equal(cropComposition('Nonesuch', [], tables, frames), null, 'and no record means no art at all');
});

void test('the recipe rasterises to the picture the viewer composes, pixel for pixel', () => {
  const recipe = cloverWearingFrozenAndAmbershine();
  const composed = picture('composed');
  const ours = rasterise(recipe, captured);

  // The picture is the species' box at the resolution of the art itself, which is the viewer's own rule
  // (`server.mjs:594-595`): Clover's box is 58 by 103.1 and its art is drawn at twice those pixels.
  assert.deepEqual([ours.width, ours.height], [composed.width, composed.height]);
  assert.deepEqual([ours.width, ours.height], [116, 206], '58 and 103.1 at the art’s own ratio of 2');

  // The claim: the two are the same picture.
  const same = differences(ours, composed);
  assert.deepEqual(
    { pixels: same.pixels, channels: same.channels, differing: same.differing, worst: same.worst },
    { pixels: 23_896, channels: 95_584, differing: 0, worst: 0 },
    'every channel of the viewer’s composed picture is the channel this recipe draws',
  );

  // And the equality is a claim about the order: swapping the two mutation pictures changes the pixels,
  // because the frost and the amber aura do overlap on this art. Without this, a recipe that drew them the
  // other way round would pass the comparison above.
  const pictures = recipe.layers.filter((layer) => layer.kind === 'mutation');
  assert.equal(pictures.length, 2, 'the two pictures are what is swapped');
  const art = required(
    recipe.layers.find((layer) => layer.kind === 'art'),
    'the art is the layer between them',
  );
  const swapped = rasterise({ ...recipe, layers: [art, ...pictures.reverse()] }, captured);
  const reordered = differences(swapped, composed);
  assert.ok(
    reordered.differing > 0,
    `drawing the two pictures the other way round changes ${reordered.differing} channels of the picture`,
  );
});

void test('the wash on the art is the amber the viewer measured, alone', () => {
  const recipe = cloverWearingFrozenAndAmbershine();
  const art = required(recipe.layers[0], 'the art is the first layer of this picture');
  assert.equal(art.kind, 'art', 'the art is the layer the wash belongs to');
  assert.deepEqual(
    art.washes,
    ['rgba(190, 100, 40, 0.5)'],
    'the amber filter, at the opacity the game states',
  );

  // The consumer's own measurement, ported (`server.test.mjs:224-248`): a clover wearing a weather mutation
  // and a moonlight one is washed by the moonlight one alone, so the pixels below the mutation pictures are
  // the art mixed with `rgb(190, 100, 40)` at .5 -- not with both washes, which would be a different colour.
  const composed = picture('composed');
  const plain = picture('art');
  const across = Math.round((0 - recipe.box.left) * recipe.pixelRatio);
  const down = Math.round((0 - recipe.box.top) * recipe.pixelRatio);
  const amber = [190, 100, 40];
  let compared = 0;
  let washed = 0;
  for (let y = Math.floor(plain.height * 0.75); y < plain.height; y += 1) {
    for (let x = 0; x < plain.width; x += 1) {
      const source = (y * plain.width + x) * 4;
      if (plain.pixels[source + 3] !== 255) continue;
      compared += 1;
      const target = ((y + down) * composed.width + x + across) * 4;
      const same = [0, 1, 2].every((channel) => {
        const base = plain.pixels[source + channel] ?? 0;
        const mixed = Math.round(base + ((amber[channel] ?? 0) - base) * 0.5);
        return Math.abs((composed.pixels[target + channel] ?? 0) - mixed) <= 2;
      });
      if (same) washed += 1;
    }
  }
  assert.ok(compared > 200, `the art has opaque pixels below the mutation pictures, got ${compared}`);
  assert.ok(
    washed / compared > 0.95,
    `the art below the pictures is the amber colour mixed in at its own opacity: ${washed} of ${compared}`,
  );
});
