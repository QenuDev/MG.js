/**
 * The second shipped version, and what the extractor had to learn to read it.
 *
 * `@mg.js/art` publishes `artDataVersions()` and `readArtData(version)` so a caller names the version it wants,
 * and the package shipped exactly one build for as long as the game did not move. When it moved, the live sync
 * refused -- correctly -- because the mutation art table had stopped stating its crop wash in a field called
 * `filters`: the game renamed that field to `colorOverlay` and repacked the colour from an `rgb(...)` string into
 * an integer `0xRRGGBB`. The predicate was describing a shape that no longer existed, and it said so.
 *
 * These tests are the evidence for how that was answered. The output did not change -- the tables 1192 extracts
 * are the tables 1176 extracted, field for field -- so the predicate learned a spelling rather than the model
 * learning a new value. And the invariant that could have been quietly weakened instead is checked directly: a
 * table with no wash field at all is still refused, and a wash stating a number this extractor cannot read is
 * refused rather than counted as a material.
 */

import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ExtractionError } from '../../src/bundle/extract.ts';
import { planSync } from '../../src/bundle/tools/sync.ts';
import {
  chunkText,
  extractTexts,
  loadFixture,
  shippedDataText,
  shippedFixtureDirectory,
  shippedVersions,
  textsOf,
} from './load-fixture.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');

/** The build the extractor was written against, and the build the game moved to. */
const FIRST = '1176';
const SECOND = '1192';

const first = loadFixture(shippedFixtureDirectory(FIRST));
const second = loadFixture(shippedFixtureDirectory(SECOND));

void test('every shipped version is exactly what its own committed fixture extracts to, offline', async () => {
  const versions = shippedVersions();
  assert.ok(
    versions.length >= 2,
    `the package ships ${versions.length} version(s), so a second one is not covered`,
  );

  for (const version of versions) {
    const directory = shippedFixtureDirectory(version);
    const plan = await planSync({
      repoRoot,
      args: { bundle: directory, origin: 'https://magicgarden.gg' },
      log: () => {},
    });
    assert.equal(plan.gameVersion, version, `${version}'s fixture states a different version`);
    assert.equal(plan.source, 'fixture');
    assert.equal(
      plan.serialized,
      shippedDataText(version),
      `data/${version}.json is not what its own fixture extracts to, so the published tables have drifted`,
    );
    // The atlas a fixture carries is the one its tables were validated against, so the check is real.
    assert.ok(plan.frameKeys.length > 0, `${version}'s fixture carries no atlas frames`);
  }
});

void test('the tables the second version extracts are the first ones, so the game changed its spelling', () => {
  // Everything but the placement function, whose *source* is the game's own minified text and so is spelled
  // differently by every build. The values are the game's art, and the game did not change them.
  const unchanged = [
    'spriteNames',
    'mutationRecords',
    'plants',
    'displayFlags',
    'anchors',
    'harvestTypes',
    'iconFills',
    'itemTypes',
    'scale',
    'overMutations',
  ] as const;
  for (const table of unchanged) {
    assert.deepEqual(
      second.tables[table],
      first.tables[table],
      `${table} changed between ${FIRST} and ${SECOND}, which is a change of art rather than of spelling`,
    );
  }
  assert.deepEqual(
    second.tables.mutationArt,
    first.tables.mutationArt,
    'the mutation art table changed, so the wash was misread rather than respelled',
  );
  assert.deepEqual(second.tables.overMutations, first.tables.overMutations);
  // The one table that does differ is the extracted function's own text, and it differs in the minifier's names.
  assert.notEqual(second.tables.placement.source, first.tables.placement.source);
});

void test('the second build states the wash as a packed integer where the first states an rgb() string', () => {
  // The bytes the two builds actually wrote, so the equality above is not read as "both were strings".
  assert.match(
    chunkText(first, 'LayoutMotionController-CwhDlPns.js'),
    /Wet:\{filters:new [A-Za-z_$][\w$]*\(\{color:`rgb\(50, 180, 200\)`,alpha:\.25\}\)/,
    'the 1176 fixture no longer states the wash as an rgb() string in a `filters` construction',
  );
  assert.match(
    chunkText(second, 'resources-D_3Zwcn-.js'),
    /Wet:\{colorOverlay:\{color:3323080,alpha:\.25\}/,
    'the 1192 fixture no longer states the wash as a packed 0xRRGGBB integer on `colorOverlay`',
  );

  // 3323080 is 0x32B4C8, which is the rgb(50, 180, 200) the earlier build wrote; the whole table reads back the
  // same way, which is what the decode in the predicate is for.
  const nine = [
    ['Wet', 'rgb(50, 180, 200)'],
    ['Chilled', 'rgb(100, 160, 210)'],
    ['Frozen', 'rgb(100, 130, 220)'],
    ['Thunderstruck', 'rgb(16, 141, 163)'],
    ['Dawnlit', 'rgb(209, 70, 231)'],
    ['Ambershine', 'rgb(190, 100, 40)'],
    ['Dawncharged', 'rgb(140, 80, 200)'],
    ['Ambercharged', 'rgb(170, 60, 25)'],
    ['Thundercharged', 'rgb(60, 200, 165)'],
  ] as const;
  for (const [mutation, colour] of nine) {
    assert.equal(second.tables.mutationArt[mutation]?.tint?.color, colour, `${mutation} decoded wrongly`);
    assert.equal(
      first.tables.mutationArt[mutation]?.tint?.color,
      colour,
      `${mutation} in ${FIRST} disagrees`,
    );
  }
  // And the two keys the game now states no wash for at all are still materials, not dropped.
  assert.deepEqual(
    Object.entries(second.tables.mutationArt)
      .filter(([, art]) => art.material)
      .map(([name]) => name)
      .sort(),
    ['Gold', 'Rainbow'],
  );
});

void test('a table whose wash field is gone is still refused, rather than matched by its sprite fields', () => {
  // The gate exists to tell this table from any other object literal full of sprites. Remove the wash and what
  // is left is exactly such an object, so a predicate widened to "carries art fields" would accept it here.
  const withoutWash = textsOf(second).map((chunk) => ({
    file: chunk.file,
    text: chunk.text.replace(/colorOverlay:\{color:\d+,alpha:[\d.]+\},?/g, ''),
  }));
  assert.throws(
    () => extractTexts(withoutWash),
    (error: unknown) => {
      assert.ok(error instanceof ExtractionError, `expected an ExtractionError, saw ${String(error)}`);
      assert.equal(error.predicate, 'mutation-art-table');
      assert.match(error.message, /nothing in the chunks matched the shape/);
      return true;
    },
  );
});

void test('a wash stating a number this extractor cannot read is refused, not counted as a material', () => {
  // 0x1000000 is one past the top of the range the game's own consumer validates. Reading it as "no colour" is
  // how a wash would silently become a material, which is the failure this check exists to make loud.
  const outOfRange = textsOf(second).map((chunk) => ({
    file: chunk.file,
    text: chunk.text.replace(/colorOverlay:\{color:3323080,/, 'colorOverlay:{color:16777216,'),
  }));
  assert.throws(
    () => extractTexts(outOfRange),
    (error: unknown) => {
      assert.ok(error instanceof ExtractionError, `expected an ExtractionError, saw ${String(error)}`);
      assert.equal(error.predicate, 'mutation-art-table');
      assert.match(error.message, /not a packed 0xRRGGBB integer/);
      assert.match(error.message, /16777216|colour overlays state a colour/);
      return true;
    },
  );
});
