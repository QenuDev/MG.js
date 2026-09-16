/**
 * `ICON_FILL` and `iconArt`: what an inventory entry draws, and how much of its icon box it fills.
 *
 * The published table is the page's own table (`page.html:1203`) and it is asserted here against both the
 * literal the page holds and the extraction `data/1176.json` carries, because the point of moving it into the
 * package is that it stops being a number a page transcribed. `iconArt` then answers the two things a caller
 * with an entry has to know: which sprite the game draws it from, and -- for a potted plant, whose icon is an
 * assembled picture rather than one sprite -- that there is no single sprite to draw.
 *
 * The resolution is the game's own tables': a species part comes from the plant record, a bare id comes from
 * the sprite-name table, and a name the table states twice is refused rather than guessed between, which is
 * the same rule the extractor follows.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseArtData } from '../src/bundle/data.ts';
import { ICON_FILL, iconArt } from '../src/icon.ts';
import { type FrameBox, frameBox } from '../src/model.ts';
import { loadFixture } from './bundle/load-fixture.ts';

const here = dirname(fileURLToPath(import.meta.url));

const data = parseArtData(readFileSync(resolve(here, '../data/1176.json'), 'utf8'));
const { tables } = data;

/** The captured atlas, as boxes keyed the game's own way. */
const fixture = loadFixture();
const frames: Record<string, FrameBox> = {};
for (const [path, frame] of Object.entries(fixture.atlas.frames)) frames[path] = frameBox(frame);

void test('`ICON_FILL` is the page`s table, typed, and the extraction agrees with it value for value', () => {
  // The page's own literal (`page.html:1203`), which the export replaces rather than reinterprets.
  assert.deepEqual(ICON_FILL, { Seed: 1, Produce: 0.4, Plant: 0.6, Tool: 1, Egg: 1, Decor: 1, Pet: 1 });

  const extracted = Object.fromEntries(
    Object.entries(tables.iconFills).map(([kind, entry]) => [kind, entry.fill]),
  );
  assert.deepEqual(extracted, ICON_FILL, 'the published table disagrees with the extraction');
});

void test('the table records how each share was stated, so four defaults do not read as four statements', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(tables.iconFills).map(([kind, entry]) => [kind, entry.source])),
    {
      Seed: 'fit-default',
      Produce: 'stated',
      Plant: 'stated',
      Tool: 'fit-default',
      Egg: 'fit-default',
      Decor: 'fit-default',
      Pet: 'bake-frame',
    },
  );
});

void test('a seed and a produce entry draw the species` seed and crop art, and the fill is the kind`s', () => {
  const withArt = { plants: tables.plants, spriteNames: tables.spriteNames, frames };
  const seed = iconArt({ itemType: 'Seed', species: 'Aloe' }, withArt);
  assert.deepEqual(seed, { fill: 1, kind: 'sprite', sprite: 'sprite/seed/Aloe', frame: null });
  // The captured atlas ships examples, not every frame: a sprite it does not hold answers `null` for the frame
  // rather than a box this package built, which is `resolveSprite`'s own rule.
  assert.equal(frames['sprite/seed/Aloe'], undefined);

  // `Tomato` the crop is not `SproutVine` the plant that grows it, so the two entries draw different art.
  const produce = iconArt({ itemType: 'Produce', species: 'Carrot' }, withArt);
  assert.deepEqual(produce, {
    fill: 0.4,
    kind: 'sprite',
    sprite: 'sprite/plant/Carrot',
    frame: frames['sprite/plant/Carrot'],
  });
  assert.notEqual(produce.frame, undefined, 'the captured atlas holds this frame');

  const plant = iconArt({ itemType: 'Produce', species: 'Tomato' }, { plants: tables.plants });
  assert.equal(plant.sprite, 'sprite/plant/Tomato');
  assert.equal(plant.frame, null, 'no atlas was given, so there is no frame to answer with');
});

void test('a bare id is read from the game`s name table, across the categories that state it', () => {
  const withArt = { spriteNames: tables.spriteNames };
  assert.equal(
    iconArt({ itemType: 'Tool', toolId: 'WateringCan' }, withArt).sprite,
    'sprite/item/WateringCan',
  );
  assert.equal(iconArt({ itemType: 'Egg', eggId: 'CommonEgg' }, withArt).sprite, 'sprite/pet/CommonEgg');
  assert.equal(
    iconArt({ itemType: 'Decor', decorId: 'Birdhouse' }, withArt).sprite,
    'sprite/decor/Birdhouse',
  );

  for (const [itemType, fill] of [
    ['Tool', 1],
    ['Egg', 1],
    ['Decor', 1],
  ] as const) {
    const art = iconArt({ itemType }, withArt);
    assert.equal(art.fill, fill);
    assert.equal(art.kind, 'sprite');
  }
});

void test('a name two categories state is refused rather than picked between', () => {
  // `Aloe` is a plant and a seed, and the two are different sprites; a caller asking by a bare id has not said
  // which kind of thing it means, so the answer is `null` rather than the first category to match.
  assert.equal(
    iconArt({ itemType: 'Tool', toolId: 'Aloe' }, { spriteNames: tables.spriteNames }).sprite,
    null,
  );
  assert.equal(
    iconArt({ itemType: 'Tool', toolId: 'NotAThing' }, { spriteNames: tables.spriteNames }).sprite,
    null,
  );
});

void test('a potted plant`s icon is an assembled picture, not a sprite called `Plant`', () => {
  const art = iconArt(
    { itemType: 'Plant', species: 'Aloe' },
    { plants: tables.plants, spriteNames: tables.spriteNames },
  );
  assert.deepEqual(art, { fill: 0.6, kind: 'picture', sprite: null, frame: null });
  // The name a caller might reach for -- `sprite/item/Plant` -- is not a sprite the game states.
  assert.equal(tables.spriteNames['Item']?.['Plant'], undefined);
});

void test('a pet`s icon is a baked portrait, which is why its 1 is not a stated share', () => {
  const art = iconArt({ itemType: 'Pet', species: 'Dog' }, { spriteNames: tables.spriteNames });
  assert.deepEqual(art, { fill: 1, kind: 'baked', sprite: null, frame: null });
});

void test('a kind the table does not name keeps the fit` own default rather than inventing a share', () => {
  const art = iconArt({ itemType: 'Crystal' }, {});
  assert.deepEqual(art, { fill: 1, kind: 'sprite', sprite: null, frame: null });
  // The fit's own default, which is also what the page does today when its table has no row for a kind.
  assert.equal(art.fill, 1);
});

void test('the extraction`s own table can be handed in, so the share follows the game version the caller read', () => {
  const art = iconArt({ itemType: 'Produce', species: 'Tomato' }, { fills: { Produce: { fill: 0.5 } } });
  assert.equal(art.fill, 0.5);
  const fallback = iconArt({ itemType: 'Produce', species: 'Tomato' }, {});
  assert.equal(fallback.fill, 0.4);
});
