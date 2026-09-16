/**
 * The washes a crop's art is drawn through, against the mirror's own composition.
 *
 * The package used to state one wash: the worn mutation with the highest table order. The game does not do
 * that. It picks the mutation *group* that washes last -- `Growth`, then `Hydro`, then `Lunar`, in the order
 * each group first appears in the mutation table -- and washes the art through **every** mutation of that
 * group, in the table's own order. The two rules agree when the crop wears mutations of two groups, and they
 * disagree in the two cases below, which is why the older rule survived its own tests.
 *
 * The outside answer is `fixtures/crop-wash/`: the community mirror's own composition of each case
 * (`/assets/sprites/composed`) beside the plain sprite the art is drawn from. The mirror is a second
 * implementation of the game's wash, so it is evidence rather than a restatement -- and its composition is
 * the art's own size for these cases (the capture refuses a case where it is not), which is what makes the
 * comparison pixel for pixel.
 *
 * Only the **foot** of the crop is compared. A mutation's own picture is placed differently by the mirror
 * than by this package -- the package places it from the game's anchor table, the mirror from its own -- so
 * above the foot the two pictures differ for a reason this file is not about. The bottom 15% of the art is
 * below the mutation pictures of these three species, so there the only thing drawn is the crop's own art
 * under the washes it wears. The counts are the measurement the fix was made from: 119, 3235 and 1094 opaque
 * pixels, every one of them the winning washes mixed into the art and **none** of them either wash alone.
 *
 * The tables are `data/1176.json`'s and the pixels are the capture's, at art 1192 -- the pair the mirror
 * composed with, since its sprites are the game's own. `fixtures/capture-crop-wash.mjs` is the recorded
 * recipe for the files below and is never run by `npm test`.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseArtData } from '../src/bundle/data.ts';
import { type CropLayer, type CropRecipe, type CropTables, cropComposition } from '../src/crop.ts';
import { type FrameBox, frameBox } from '../src/model.ts';
import { decodePng, type PngImage, washArt } from '../src/node/png.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, '../fixtures/crop-wash');

const data = parseArtData(readFileSync(resolve(here, '../data/1176.json'), 'utf8'));
const tables: CropTables = data.tables;

/** The atlas frames the capture wrote, as the frames a recipe reads: `frameBox` of each stated frame. */
const frames: Readonly<Record<string, FrameBox>> = (() => {
  const stated = JSON.parse(readFileSync(resolve(FIXTURES, 'frames.json'), 'utf8')) as {
    frames: Readonly<Record<string, unknown>>;
  };
  return Object.fromEntries(Object.entries(stated.frames).map(([key, frame]) => [key, frameBox(frame)]));
})();

const provenance = JSON.parse(readFileSync(resolve(FIXTURES, 'provenance.json'), 'utf8')) as {
  capturedFrom: { artVersion: string };
  cases: Readonly<
    Record<
      string,
      {
        species: string;
        mutations: readonly string[];
        art: string;
        size: readonly [number, number];
        artSha256: string;
        composedSha256: string;
      }
    >
  >;
};

/** A value a test is about to use, or a failure naming what was missing. */
function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(what);
  return value;
}

/** One captured picture, decoded to its pixels, checked against the digest the capture recorded. */
function picture(caseName: string, which: 'art' | 'composed'): PngImage {
  const bytes = readFileSync(resolve(FIXTURES, `${caseName}.${which}.png`));
  const recorded = required(provenance.cases[caseName], `the provenance states no case ${caseName}`);
  const digest = which === 'art' ? recorded.artSha256 : recorded.composedSha256;
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    digest,
    `the captured ${which} picture is the bytes the provenance records`,
  );
  return decodePng(bytes);
}

/**
 * What the mirror's picture is at the foot of the art, against one candidate list of washes.
 *
 * The region is the bottom 15% of the art (`y >= floor(height * 0.85)`), where the mutation pictures of
 * these species stop short, and only the art's own fully opaque pixels are counted. A channel may differ by
 * two: the mirror and `washArt` round a mix differently, which is the tolerance the consumer's own ported
 * test carries (`server.test.mjs:244`).
 */
function foot(plain: PngImage, composed: PngImage, washes: readonly string[]): { same: number; of: number } {
  assert.deepEqual(
    [plain.width, plain.height],
    [composed.width, composed.height],
    'the mirror composes these cases at the art’s own size',
  );
  const washed = washArt(plain, washes);
  const from = Math.floor(plain.height * 0.85);
  let same = 0;
  let of = 0;
  for (let y = from; y < plain.height; y += 1) {
    for (let x = 0; x < plain.width; x += 1) {
      const at = (y * plain.width + x) * 4;
      if (plain.pixels[at + 3] !== 255) continue;
      of += 1;
      const one = [0, 1, 2].every(
        (channel) => Math.abs((composed.pixels[at + channel] ?? 0) - (washed.pixels[at + channel] ?? 0)) <= 2,
      );
      if (one) same += 1;
    }
  }
  return { same, of };
}

/** The recipe for one case, the art layer, or a failure naming what the tables were missing. */
function artOf(species: string, mutations: readonly string[]): { recipe: CropRecipe; art: CropLayer } {
  const recipe = required(
    cropComposition(species, mutations, tables, frames),
    `${species} is a species the tables state and the atlas holds`,
  );
  const art = required(
    recipe.layers.find((layer) => layer.kind === 'art'),
    'the recipe has an art layer',
  );
  return { recipe, art };
}

/**
 * The wash this package used to state: the worn mutation of the highest table order, alone.
 *
 * Read off the tables here rather than out of the package, because it is the rule being ruled out -- a test
 * that asked the package for the old answer could not tell a fix from a rename.
 */
function oneTintOf(mutations: readonly string[]): readonly string[] {
  const worn = mutations
    .map((name) => ({ name, art: tables.mutationArt[name] }))
    .filter((one) => one.art !== undefined && one.art.material !== true && one.art.tint != null)
    .sort((left, right) => (left.art?.order ?? 0) - (right.art?.order ?? 0));
  const highest = worn[worn.length - 1];
  if (highest === undefined) return [];
  const colour = (required(highest.art, 'a worn mutation').tint?.color ?? '').match(/[0-9.]+/g) ?? [];
  const alpha = required(highest.art, 'a worn mutation').tint?.alpha ?? 1;
  return [`rgba(${colour[0]}, ${colour[1]}, ${colour[2]}, ${alpha})`];
}

void test('a crop wearing two mutations of one group is washed by both, in table order', () => {
  // `Frozen` (order 4) and `Thunderstruck` (order 5) are both `Hydro` and no later group is worn, so both
  // washes are mixed, frost first. The old rule stated `Thunderstruck` alone, and looking at either alone
  // gets 0 of the 119 pixels the pair gets.
  const { art } = artOf('Clover', ['Frozen', 'Thunderstruck']);
  assert.deepEqual(
    art.washes,
    ['rgba(100, 130, 220, 0.5)', 'rgba(16, 141, 163, 0.4)'],
    'both Hydro washes, in the mutation table’s own order',
  );

  const name = 'clover-frozen-thunderstruck';
  const plain = picture(name, 'art');
  const composed = picture(name, 'composed');
  assert.deepEqual(foot(plain, composed, art.washes), { same: 119, of: 119 }, '119 of 119 pixels, stacked');
  for (const alone of art.washes) {
    assert.deepEqual(
      foot(plain, composed, [alone]),
      { same: 0, of: 119 },
      `the picture is not ${alone} alone`,
    );
  }
});

void test('the group that washes last wins, not the mutation with the highest table order', () => {
  // `Thundercharged` is the mutation table's last row (order 10) and is `Hydro`; `Ambershine` is `Lunar`,
  // which washes after `Hydro`. The old rule picked `Thundercharged` and matched none of the foot.
  const { art } = artOf('Beet', ['Ambershine', 'Thundercharged']);
  assert.deepEqual(art.washes, ['rgba(190, 100, 40, 0.5)'], 'the amber Lunar wash alone');

  const name = 'beet-ambershine-thundercharged';
  const plain = picture(name, 'art');
  const composed = picture(name, 'composed');
  assert.deepEqual(foot(plain, composed, art.washes), { same: 3235, of: 3235 }, '3235 of 3235 pixels');
  assert.deepEqual(
    foot(plain, composed, oneTintOf(['Ambershine', 'Thundercharged'])),
    { same: 0, of: 3235 },
    'and none of them the table’s last row, which is the rule the package used to state',
  );
});

void test('the same failure on Cacao: Dawnlit’s Lunar wash, not Thundercharged’s Hydro one', () => {
  const { art } = artOf('Cacao', ['Dawnlit', 'Thundercharged']);
  assert.deepEqual(art.washes, ['rgba(209, 70, 231, 0.5)'], 'the dawn Lunar wash alone');

  const name = 'cacao-dawnlit-thundercharged';
  const plain = picture(name, 'art');
  const composed = picture(name, 'composed');
  assert.deepEqual(foot(plain, composed, art.washes), { same: 1094, of: 1094 }, '1094 of 1094 pixels');
  assert.deepEqual(
    foot(plain, composed, oneTintOf(['Dawnlit', 'Thundercharged'])),
    { same: 0, of: 1094 },
    'and none of them the Hydro row the old rule reached',
  );
});

void test('the group order is the mutation table’s, derived rather than written down', () => {
  // The three cases above need each group's place in the order, and the table is where it comes from: the
  // order each group first appears in `mutationArt` is `Growth` (Rainbow, order 0), `Hydro` (Wet, order 2)
  // and `Lunar` (Dawnlit, order 6). The records are the ones the extractor writes, one per mutation.
  const firstAppearance = Object.keys(tables.mutationArt)
    .sort((left, right) => (tables.mutationArt[left]?.order ?? 0) - (tables.mutationArt[right]?.order ?? 0))
    .map((name) => tables.mutationRecords[name]?.group)
    .filter((group): group is string => typeof group === 'string');
  assert.deepEqual(
    [...new Set(firstAppearance)],
    ['Growth', 'Hydro', 'Lunar'],
    'each group where the mutation table first states it',
  );

  // And the winning group is the last of them the crop wears, not the group of the highest row: the order
  // `Hydro` is stated at is 2, `Lunar`'s is 6, and `Thundercharged`'s row (10) belongs to `Hydro`.
  assert.equal(tables.mutationArt['Thundercharged']?.order, 10, 'the table’s last row is Hydro');
  assert.equal(tables.mutationRecords['Thundercharged']?.group, 'Hydro');
  assert.equal(tables.mutationRecords['Dawnlit']?.group, 'Lunar');
  assert.equal(tables.mutationArt['Wet']?.order, 2, 'Hydro first appears at Wet, order 2');
  assert.equal(tables.mutationArt['Dawnlit']?.order, 6, 'Lunar first appears at Dawnlit, order 6');
});

void test('a mutation whose art the caller’s atlas lacks still washes the art it is worn with', () => {
  // The wash is a table value, not a frame: the game mixes it whatever the caller happens to hold. A crop
  // wearing `Frozen` and `Thunderstruck` is washed by both even when no frame for the lightning is in hand --
  // the picture of the lightning is what is missing, not the colour.
  const { art } = artOf('Clover', ['Frozen', 'Thunderstruck']);
  const withoutLightning = Object.fromEntries(
    Object.entries(frames).filter(
      ([key]) => key !== 'sprite/mutation/Thunderstruck' && key !== 'sprite/mutation/ThunderstruckGround',
    ),
  );
  const recipe = required(
    cropComposition('Clover', ['Frozen', 'Thunderstruck'], tables, withoutLightning),
    'the art is still frame the atlas holds',
  );
  const artLayer = required(
    recipe.layers.find((layer) => layer.kind === 'art'),
    'the recipe has an art layer',
  );
  assert.deepEqual(
    artLayer.washes,
    ['rgba(100, 130, 220, 0.5)', 'rgba(16, 141, 163, 0.4)'],
    'the two Hydro washes the crop wears',
  );
  assert.deepEqual(artLayer.washes, art.washes, 'the same two washes as when every frame is in hand');
  assert.deepEqual(
    recipe.layers.filter((layer) => layer.kind === 'mutation').map((layer) => layer.mutation),
    ['Frozen'],
    'while the picture the atlas cannot draw is left out',
  );
});
