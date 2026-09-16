/**
 * Resolving a plant's part to the sprite the game draws it from, and that sprite to the frame the atlas states.
 *
 * The three ways the naming is not guessable are the three cases here, and each is checked against the
 * consumer rather than against an idea of the naming:
 *
 *   - `Clover` -> `CloverThreeLeaf`: a species is often not its atlas name, and `Tomato` the picked crop is
 *     not `SproutVine` the plant that grows it. The consumer says so at `server.mjs:102-103` and `:140-141`
 *     and answers it from an index it fetches; the game's own plant table states it per part.
 *   - `Ambershine` -> `Amberlit`: a mutation is drawn from art that is not named after it, which the consumer
 *     states twice (`server.mjs:437` and `:921`) and the mutation table states as its own record.
 *   - `Hunger` -> `HungerCrystal`: the one case the extracted tables cannot answer for the caller. The game
 *     *builds* that name (its crystal's label is the base name plus `Crystal`), and no table this package reads
 *     maps the item id to it -- so what the game's sprite-name table can do is refuse a name that is not a
 *     sprite, which is exactly what the consumer's candidate list cannot do.
 *
 * The expected frames are the consumer's own measurements (`script.test.mjs:1855`, `:1864-1870`), taken from
 * the captured atlas the fixture holds, so the arithmetic and the art are the same two things the consumer
 * measures.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseArtData } from '../src/bundle/data.ts';
import { type FrameBox, frameBox } from '../src/model.ts';
import { resolveSprite, spriteName } from '../src/sprite.ts';
import { loadFixture } from './bundle/load-fixture.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** The tables `art:sync` wrote for this game version, read the way a consumer reads them. */
const tables = parseArtData(readFileSync(resolve(here, '../data/1176.json'), 'utf8')).tables;

/** The captured atlas, which is the frames a resolved name is checked against. */
const fixture = loadFixture();

/** The captured frames as boxes, by the game's own key, which is what `resolveSprite` answers from. */
const frames: Record<string, FrameBox> = {};
for (const [path, frame] of Object.entries(fixture.atlas.frames)) frames[path] = frameBox(frame);

/** One category of the name table, or a failure naming the category the game's build does not have. */
function names(category: string): Readonly<Record<string, string>> {
  const byName = tables.spriteNames[category];
  assert.ok(byName !== undefined, `the game's name table has no ${category} category`);
  return byName;
}

void test('`Clover` is drawn from `CloverThreeLeaf`: a species part is read, not built', () => {
  // `plants.Clover` states all three of its arts, and two of them are the same art: a clover grows into the
  // art it is picked as. The consumer reaches the same answer by asking an index for `plants/Clover`
  // (`server.mjs:690-692`), because `Clover` is not the atlas name of anything.
  const clover = tables.plants['Clover'];
  assert.equal(spriteName(clover, 'plant'), 'sprite/plant/CloverThreeLeaf');
  assert.equal(spriteName(clover, 'crop'), 'sprite/plant/CloverThreeLeaf');
  assert.equal(spriteName(clover, 'seed'), 'sprite/seed/Clover');

  // The case the consumer calls out by name: the vine a tomato grows on is not the tomato, and the two parts
  // are different sprites of different sizes.
  const tomato = tables.plants['Tomato'];
  assert.equal(spriteName(tomato, 'plant'), 'sprite/plant/SproutVine');
  assert.equal(spriteName(tomato, 'crop'), 'sprite/plant/Tomato');

  // A part a record does not state, and a record that is not one, are `null` rather than a name this package
  // made up.
  assert.equal(spriteName({ plant: null }, 'plant'), null);
  assert.equal(spriteName({ plant: { harvestType: 'Single' } }, 'plant'), null);
  assert.equal(spriteName(null, 'plant'), null);
  assert.equal(spriteName(clover, 'topmostLayerSprite'), null);
});

void test('`Ambershine` is drawn from `Amberlit`: a mutation states all three of its arts', () => {
  // The mutation's own record and its art table state the same resolved art, which is what makes the naming
  // readable from either: `mutationRecords.Ambershine.sprite` is the `sprite` and `mutationArt` states the
  // `iconSprite` the consumer draws (`server.mjs:437`, `:921`).
  assert.equal(spriteName(tables.mutationArt['Ambershine'], 'iconSprite'), 'sprite/mutation/Amberlit');
  assert.equal(spriteName(tables.mutationRecords['Ambershine'], 'sprite'), 'sprite/mutation/Amberlit');

  // `Wet` states all three: the art over the crop, the decal that pools at a tall plant's foot, and the
  // overlay that climbs the plant. The consumer holds the same three (`server.mjs:734-738`).
  const wet = tables.mutationArt['Wet'];
  assert.equal(spriteName(wet, 'iconSprite'), 'sprite/mutation/Wet');
  assert.equal(spriteName(wet, 'groundSprite'), 'sprite/mutation/Puddle');
  assert.equal(spriteName(wet, 'overlaySprite'), 'sprite/mutation-overlay/WetTallPlant');

  // `Gold` and `Rainbow` are materials rather than pictures, and their records state no art at all: `null`,
  // never a sprite named after the mutation.
  assert.equal(spriteName(tables.mutationArt['Gold'], 'iconSprite'), null);
  assert.equal(spriteName(tables.mutationArt['Rainbow'], 'groundSprite'), null);
});

void test("`Hunger` -> `HungerCrystal`: the name is the game's, and the table refuses one it does not have", () => {
  // The consumer's crystal candidates are `items/${id}Crystal`, `items/${id}CrystalShard` and `${id}Crystal`
  // (`server.mjs:698-700`), built by appending and tried in turn. The game does the same building -- its
  // crystal's label is the base name plus `Crystal` -- and what the extracted tables add is the answer to
  // whether the built name is a sprite the atlas has. No table this package reads maps an item id to that
  // name, so the building stays the game's (or the caller's) and the table is what confirms it; this case is
  // therefore ported as far as the confirmation, and says so rather than inventing the mapping.
  const items = names('Item');
  assert.equal(spriteName({ name: 'HungerCrystal' }, 'name', items), 'sprite/item/HungerCrystal');
  assert.equal(spriteName({ name: 'HungerCrystalShard' }, 'name', items), 'sprite/item/HungerCrystalShard');
  // The guess without the suffix is not a sprite, which is the failure the consumer's list cannot detect.
  assert.equal(spriteName({ name: 'Hunger' }, 'name', items), null);
  assert.equal(items['Hunger'], undefined);
  // And a name is only resolvable through a table: without one, this package will not build a path from it.
  assert.equal(spriteName({ name: 'HungerCrystal' }, 'name'), null);
});

void test('a bare name is resolved in the category the caller names, because a name is not unique', () => {
  // `Aloe` is both a plant and a seed, so the category is the caller's to know -- it knows whether it is
  // asking about a plant in a pot or a seed in a bag -- and the two categories answer differently.
  assert.equal(spriteName({ name: 'Aloe' }, 'name', names('Plant')), 'sprite/plant/Aloe');
  assert.equal(spriteName({ name: 'Aloe' }, 'name', names('Seed')), 'sprite/seed/Aloe');
  assert.notEqual(names('Plant')['Aloe'], names('Seed')['Aloe']);

  // Every name the table states resolves to the path it states, under the category that states it: 583 leaves
  // across 13 categories, which is the table the extractor validated against the atlas.
  let checked = 0;
  for (const [category, byName] of Object.entries(tables.spriteNames)) {
    for (const [name, path] of Object.entries(byName)) {
      assert.equal(spriteName({ name }, 'name', byName), path, `${category}/${name}`);
      checked += 1;
    }
  }
  assert.equal(checked, 583, 'the name table lost leaves, so this walk is not the whole table');
});

void test('a plant block states the art it grows into and the layer it draws over its crops', () => {
  // `immatureSprite`, `activeState.sprite` and `topmostLayerSprite` are stated by the game's plant block
  // rather than by the tables this package extracts, so they are read off whatever record a caller holds: the
  // part is the path, or it is an object that holds the art under `sprite`. The three paths here are the
  // game's own, from the name table, and the atlas fixture holds every one of them.
  const block = {
    immatureSprite: 'sprite/plant/BabyCarrot',
    activeState: { sprite: 'sprite/plant/DawnCelestialPlantActive', weatherRequirement: 'Dawn' },
    topmostLayerSprite: 'sprite/plant/DawnCelestialPlatformTopmostLayer',
  };
  for (const part of ['immatureSprite', 'activeState', 'topmostLayerSprite']) {
    const path = spriteName(block, part);
    assert.ok(path !== null, `${part} states no art`);
    assert.ok(fixture.atlas.frameKeys.includes(path), `${path} is not a frame the game published`);
  }
  assert.equal(spriteName(block, 'activeState'), 'sprite/plant/DawnCelestialPlantActive');
});

void test('`resolveSprite` answers the frame for a key, and null for anything that is not one', () => {
  // The consumer's own clover, measured: 116x169 raw at twice the tile's ratio, so 58x84.5 logical, anchored
  // 49.1% across and 93.5% down (`script.test.mjs:1854-1856`).
  const clover = resolveSprite(frames, 'sprite/plant/CloverThreeLeaf');
  assert.ok(clover !== null);
  assert.deepEqual(clover, { width: 58, height: 84.5, pixelRatio: 2, anchorX: 0.491379, anchorY: 0.934911 });

  // One species' crop art and its plant art are different frames, measured in `script.test.mjs:1864-1870`.
  assert.deepEqual(resolveSprite(frames, 'sprite/plant/Carrot'), {
    width: 193,
    height: 96,
    pixelRatio: 2,
    anchorX: 0.298251,
    anchorY: 0.990885,
  });
  assert.deepEqual(resolveSprite(frames, 'sprite/plant/BabyCarrot'), {
    width: 95.5,
    height: 119,
    pixelRatio: 2,
    anchorX: 0.424084,
    anchorY: 0.756303,
  });

  // The map `atlasPacks` returns answers the same thing as a capture's JSON object, without either having to
  // be turned into the other.
  assert.deepEqual(resolveSprite(new Map(Object.entries(frames)), 'sprite/plant/CloverThreeLeaf'), clover);

  // A sprite the game publishes that this capture holds no frame for is `null` -- `HungerCrystal` is a key in
  // the name table and in the atlas's frame keys, and a caller still cannot draw it from this capture.
  assert.ok(fixture.atlas.frameKeys.includes('sprite/item/HungerCrystal'));
  assert.equal(resolveSprite(frames, 'sprite/item/HungerCrystal'), null);
  // A name is not a key this package builds, which is what keeps the two functions' jobs apart.
  assert.equal(resolveSprite(frames, 'CloverThreeLeaf'), null);
  assert.equal(resolveSprite(frames, ''), null);

  // And every frame the capture does hold comes back for its own key.
  for (const path of Object.keys(fixture.atlas.frames)) {
    assert.ok(resolveSprite(frames, path) !== null, `${path} did not resolve`);
  }
});
