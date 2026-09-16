/**
 * A plant's whole picture as a recipe: the consumer's own cases, ported.
 *
 * The page composes a plant from its parts today (`page.html:1398-1502`) and stacks them with its own CSS
 * z-indices; the recipe is the same assembly with the game's own order instead of the page's, and the cases
 * below are the ones the page's tests measure:
 *
 *   - DawnCelestial's art is split, and the front layer is drawn over the crop and only once the plant has
 *     matured (`script.test.mjs:676-723`). The page's test asserts the element order and that the front layer
 *     is the plant's own frame about the plant's own anchor; both are asserted here, on the layers.
 *   - a plant wears its second art only while the weather it names is the one running, over the plant and
 *     under the crops (`script.test.mjs:733-787`). The window arithmetic itself -- `startsAt <= at < endsAt`
 *     -- is the caller's clock and is not ported: the recipe is handed the answer, so "a weather that has not
 *     started yet" arrives as `weather: null` and draws no overlay.
 *   - a mutation does not change how large a crop is drawn (`script.test.mjs:600-660`): the crop's own part is
 *     its frame either way, and the composed picture hangs off that frame rather than being it.
 *
 * The numbers are the consumer's own measured metrics, quoted from `PLANT_PICTURES`
 * (`script.test.mjs:1830-1886`) rather than re-measured: they are the frames the page holds, and a recipe
 * handed them must place the parts where the page places them.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseArtData } from '../src/bundle/data.ts';
import { type CropTables, cropComposition } from '../src/crop.ts';
import { type FrameBox, frameBox } from '../src/model.ts';
import {
  PLANTER_POT,
  type PlantArt,
  type PlantCrop,
  type PlantLayer,
  type PlantRecipe,
  type PotArt,
  plantPicture,
} from '../src/plant.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** One art as the page's metrics state it: the size and the anchor the atlas gave it. */
const frame = (width: number, height: number, anchorX: number, anchorY: number): FrameBox => ({
  width,
  height,
  pixelRatio: 1,
  anchorX,
  anchorY,
});

/** A value a test is about to use, or a failure naming what was missing. */
function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(what);
  return value;
}

/** One named layer, or a failure: the cases below are about particular parts of the picture. */
function layerOf(recipe: PlantRecipe, kind: PlantLayer['kind']): PlantLayer {
  return required(
    recipe.layers.find((layer) => layer.kind === kind),
    `the picture has no ${kind} layer: ${recipe.layers.map((layer) => layer.kind).join(', ')}`,
  );
}

/** The parts of the picture, in the order they are drawn. The order is the claim in half of these cases. */
const kinds = (recipe: PlantRecipe): PlantLayer['kind'][] => recipe.layers.map((layer) => layer.kind);

/** The species of the tile, as the page's own metrics state it. */
const DawnCelestial: PlantArt = {
  // `script.test.mjs:1874-1883`: the one species in the game whose art is split in two, and a species with
  // the second art the celestials wear while their weather runs. Both extra arts are the plant's own size.
  plant: { sprite: 'sprite/plant/DawnCelestialPlant', frame: frame(596, 596, 0.5, 0.87) },
  crop: { sprite: 'sprite/plant/DawnCelestialCrop', frame: frame(102.5, 102.5, 0.497561, 0.0634146) },
  harvestType: 'Multiple',
  topmost: { sprite: 'sprite/plant/DawnCelestialPlatformTopmostLayer', frame: frame(596, 596, 0.5, 0.87) },
  active: {
    sprite: 'sprite/plant/DawnCelestialPlantActive',
    frame: frame(596, 596, 0.5, 0.87),
    weather: 'Dawn',
  },
};

/** The two patch species, whose plant and crop arts differ so a patch is visible in the recipe. */
const Clover: PlantArt = {
  plant: { sprite: 'sprite/plant/CloverThreeLeaf', frame: frame(58, 84.5, 0.491379, 0.934911) },
  crop: { sprite: 'sprite/plant/CloverThreeLeaf', frame: frame(58, 84.5, 0.491379, 0.934911) },
  harvestType: 'Single',
};

const Carrot: PlantArt = {
  plant: { sprite: 'sprite/plant/BabyCarrot', frame: frame(95.5, 119, 0.424084, 0.756303) },
  crop: { sprite: 'sprite/plant/Carrot', frame: frame(193, 96, 0.298251, 0.990885) },
  harvestType: 'Single',
};

const ART: Readonly<Record<string, PlantArt | undefined>> = { Clover, Carrot, DawnCelestial };

/** The pot, as the page's metrics state it (`script.test.mjs:1885`). */
const POT: PotArt = { sprite: 'sprite/item/PlanterPot', frame: frame(170, 164, 0.5, 0.5) };

/** The crop the celestial cases stand on the tile: the payload's own place and growth (`script.test.mjs:682`). */
const dawnCrop: PlantCrop = { species: 'DawnCelestial', x: -0.015, y: -0.53, rotation: 0, scale: 2.5 };

void test('a celestial plant draws its front layer over the crop, and only once it has matured', () => {
  const matured = required(
    plantPicture({ species: 'DawnCelestial', crops: [dawnCrop], mature: true, weather: null }, ART),
    'the species and its crops are in hand',
  );
  assert.deepEqual(kinds(matured), ['plant', 'crop', 'topmost'], 'the front is drawn last');
  const body = layerOf(matured, 'plant');
  const topmost = layerOf(matured, 'topmost');
  for (const side of ['left', 'top', 'width', 'height'] as const) {
    assert.equal(
      topmost[side],
      body[side],
      `the front layer is the plant's own frame, ${side}: the game copies the body's place onto it`,
    );
  }
  assert.equal(
    topmost.sprite,
    'sprite/plant/DawnCelestialPlatformTopmostLayer',
    'and it is the layer the species names rather than the plant again',
  );

  const growing = required(
    plantPicture({ species: 'DawnCelestial', crops: [dawnCrop], mature: false, weather: null }, ART),
    'a plant still growing is still a picture',
  );
  assert.deepEqual(kinds(growing), ['plant', 'crop'], 'a plant still growing has no front layer');
});

void test('a plant draws the art its weather brings out, over the plant and under the crops', () => {
  const draw = (weather: string | null): PlantRecipe =>
    required(
      plantPicture({ species: 'DawnCelestial', crops: [dawnCrop], mature: true, weather }, ART),
      `${weather} is a weather a caller can state`,
    );

  const dawn = draw('Dawn');
  assert.deepEqual(kinds(dawn), ['plant', 'active', 'crop', 'topmost'], 'over the plant and under the crops');
  assert.equal(
    layerOf(dawn, 'active').sprite,
    'sprite/plant/DawnCelestialPlantActive',
    'the art is the one the species names for that weather',
  );

  // Another weather leaves the plant as it was, and so does nothing running at all -- which is what a caller
  // reports for a weather that has not started yet, since the window is its own clock to resolve.
  assert.deepEqual(kinds(draw('Rain')), ['plant', 'crop', 'topmost'], 'another weather changes nothing');
  assert.deepEqual(kinds(draw(null)), ['plant', 'crop', 'topmost'], 'and neither is nothing running');
});

void test('a patch is its crops, drawn with the species’ plant art, and the pot stands behind them', () => {
  // Carrot's two arts differ, so which one a crop is drawn with is visible: a patch is drawn as the plant.
  // The payload's own order is by depth, deepest first, and the recipe is expected to reorder it.
  const crops: PlantCrop[] = [
    { species: 'Carrot', x: 0.459, y: 0.192, rotation: 0, scale: 1, depth: 11 },
    { species: 'Carrot', x: -0.14, y: -0.336, rotation: 0, scale: 1, depth: 6 },
  ];
  const recipe = required(
    plantPicture({ species: 'Carrot', crops, mature: true, weather: null }, ART, POT),
    'Carrot and the pot are in hand',
  );
  assert.deepEqual(kinds(recipe), ['pot', 'crop', 'crop'], 'a patch has no body, and the pot is behind all');
  const planted = recipe.layers.filter((layer) => layer.kind === 'crop');
  assert.deepEqual(
    planted.map((layer) => layer.sprite),
    ['sprite/plant/BabyCarrot', 'sprite/plant/BabyCarrot'],
    'every crop of a patch is drawn with the species’ plant art rather than with what it is picked as',
  );
  assert.deepEqual(
    planted.map((layer) => layer.width),
    [95.5, 95.5],
    'at that art’s own size, since the crops state no growth',
  );
  // The place is the payload's offset in tile units from the plant's anchor — a patch has no art to take a
  // middle from — and the crop hangs from its own frame's anchor, which is the foot of its art. The two are
  // in the payload's depth order, shallow first, so the crop further down the tile covers the one behind it.
  assert.deepEqual(
    planted.map((layer) => Math.round(layer.left * 1000) / 1000),
    [-76.34, 77.004],
    'the crops are laid out by their offsets and stacked by the payload’s own depth',
  );

  const pot = layerOf(recipe, 'pot');
  assert.deepEqual(
    {
      left: pot.left,
      top: Math.round(pot.top * 10) / 10,
      width: pot.width,
      height: pot.height,
    },
    { left: -85, top: -32.8, width: 170, height: 164 },
    'and the pot is anchored a fifth of the way down its own height, not at its atlas anchor',
  );
  // The assembled picture is as big as both of them together, so the box holds the pot as well as the plant.
  assert.equal(recipe.box.left, pot.left, 'the pot reaches furthest left, so the box holds it');
});

void test('a plant still growing is drawn on its platform, under the body and the crops', () => {
  // The page has no case for this one: it never draws a species' `immatureSprite`, so there is nothing to
  // port and this case is the game's own record instead. `ImmatureSpriteRenderer` requires `immatureSprite`,
  // is created only for a multi-harvest species, and is drawn at `zIndex:-10` -- under the body and fading
  // out as the plant matures (`.logs/art-sync-spike/analysis/motion-tables.txt` §7, the renderer's needle).
  const withPlatform: Readonly<Record<string, PlantArt | undefined>> = {
    ...ART,
    DawnCelestial: {
      ...DawnCelestial,
      immature: { sprite: 'sprite/plant/DawnCelestialPlatform', frame: frame(596, 596, 0.5, 0.87) },
    },
  };

  const growing = required(
    plantPicture(
      { species: 'DawnCelestial', crops: [dawnCrop], mature: false, weather: null },
      withPlatform,
      POT,
    ),
    'a plant still growing is still a picture',
  );
  assert.deepEqual(
    kinds(growing),
    ['pot', 'immature', 'plant', 'crop'],
    'the platform is under the body, and the pot is under both of them',
  );
  assert.equal(
    layerOf(growing, 'immature').sprite,
    'sprite/plant/DawnCelestialPlatform',
    'and it is the art the species states rather than the body again',
  );

  const matured = required(
    plantPicture(
      { species: 'DawnCelestial', crops: [dawnCrop], mature: true, weather: null },
      withPlatform,
      POT,
    ),
    'and so is a plant that has grown up',
  );
  assert.deepEqual(
    kinds(matured),
    ['pot', 'plant', 'crop', 'topmost'],
    'once it has matured the platform is gone and the front layer has taken its place at the other end',
  );
});

void test('a mutation does not change how large a crop is drawn, it hangs off the crop’s frame', () => {
  // The composition is commit 6's own recipe for this species, from the capture's atlas frames, so the two
  // recipes compose rather than being asserted against each other by hand.
  const data = parseArtData(readFileSync(resolve(here, '../data/1176.json'), 'utf8'));
  const stated = JSON.parse(
    readFileSync(resolve(here, '../fixtures/crop-composition/frames.json'), 'utf8'),
  ) as { frames: Readonly<Record<string, unknown>> };
  const atlas = Object.fromEntries(Object.entries(stated.frames).map(([key, one]) => [key, frameBox(one)]));
  const composition = required(
    cropComposition('Clover', ['Frozen', 'Ambershine'], data.tables as CropTables, atlas),
    'Clover wearing the frost and the amber aura is a picture',
  );

  const crop: PlantCrop = { species: 'Clover', x: 0, y: 0, rotation: 0, scale: 1, composition };
  const recipe = required(
    plantPicture({ species: 'Clover', crops: [crop], mature: true, weather: null }, ART),
    'Clover is in hand',
  );
  const drawn = layerOf(recipe, 'crop');
  assert.equal(drawn.width, Clover.plant.frame.width, 'the part is the crop’s own frame, not the picture’s');
  assert.equal(drawn.height, Clover.plant.frame.height, 'either way');
  assert.equal(drawn.composition, composition, 'and the composed picture is carried rather than applied');
  assert.ok(
    composition.box.top < 0,
    'the box reaches above the art, so a renderer draws the picture above the frame rather than pushing it down',
  );
});

/**
 * The pot's name and the anchor it is placed by are the game's, and a consumer can read them instead of
 * writing them down.
 *
 * Both used to be private here: `plantPicture` placed an anchor-less pot by an internal constant, and the
 * name of the sprite was the consumer's to know. A consumer that draws a potted plant needs exactly these two
 * things and has the atlas for the rest of it, so the value is published — and this test is what keeps the
 * published one and the one the recipe actually uses from drifting apart, which would be worse than not
 * publishing it at all: a page would draw a pot the recipe does not place.
 *
 * The name is checked against the game's own item table rather than against a second copy of itself, so it is
 * a game value and not one of ours.
 */
void test('the pot’s published name and anchor are the ones the recipe places it by', () => {
  const crops: PlantCrop[] = [{ species: 'Carrot', x: 0, y: 0, rotation: 0, scale: 1 }];
  const potted = (extra: Partial<PotArt>): PlantRecipe =>
    required(
      plantPicture({ species: 'Carrot', crops, mature: true, weather: null }, ART, {
        sprite: PLANTER_POT.sprite,
        frame: frame(170, 164, 0.5, 0.5),
        ...extra,
      }),
      'Carrot and the pot are in hand',
    );

  // A pot that states no anchor is placed by the published one, both in the rectangle that puts its art in the
  // picture and in the anchor the layer reports: the two are the pair a renderer turns a frame with.
  const stated = layerOf(potted({}), 'pot');
  assert.deepEqual(
    [stated.anchorX, stated.anchorY],
    [PLANTER_POT.anchorX, PLANTER_POT.anchorY],
    'the layer is drawn by the published anchor',
  );
  assert.deepEqual(
    [stated.left, stated.top],
    [-PLANTER_POT.anchorX * 170, -PLANTER_POT.anchorY * 164],
    'and the rectangle is that anchor applied to the pot’s own frame',
  );

  // A caller that states its own anchor is drawn by it, which is the other half of the contract: publishing
  // the game's value must not take the choice away from a caller that has a reason to differ.
  const own = layerOf(potted({ anchorX: 0.25, anchorY: 0.75 }), 'pot');
  assert.deepEqual([own.anchorX, own.anchorY], [0.25, 0.75], 'a stated anchor wins');

  // The name is the game's: it is a key of the item sprite table the bundle states, which is the table the
  // consumer resolves a sprite path through.
  const data = parseArtData(readFileSync(resolve(here, '../data/1176.json'), 'utf8'));
  const item = required(data.tables.spriteNames.Item, 'the item sprite table');
  assert.ok(PLANTER_POT.sprite in item, `the game’s item table states ${PLANTER_POT.sprite}`);
});
