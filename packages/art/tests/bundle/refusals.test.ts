/**
 * What the extractor refuses, and how loudly.
 *
 * The plan's trade is stated plainly: a new asset needs no code, and a new *shape* needs one predicate. The
 * failure mode that trade accepts is a loud one -- so these tests are not about the happy path, they are about
 * the message somebody reads when the game refactors a table. Each refusal has to name the predicate and what it
 * saw, and a candidate the atlas cannot confirm has to be refused rather than quietly shortened.
 *
 * Every input here is the committed fixture with one thing changed, so these are tests of the shipped predicates
 * rather than of a synthetic chunk that could drift from the real thing.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExtractionError } from '../../src/bundle/extract.ts';
import { plantSpritesOf, spritePathsOf, validateTables } from '../../src/bundle/validate.ts';
import { extractTexts, loadFixture, textsOf } from './load-fixture.ts';

const fixture = loadFixture();
const { tables } = fixture;

function changed(
  predicate: (chunk: { file: string; text: string }) => string,
): readonly { file: string; text: string }[] {
  return textsOf(fixture).map((chunk) => ({ file: chunk.file, text: predicate(chunk) }));
}

void test('an unchanged fixture is confirmed by the atlas, which is the positive control for what follows', () => {
  assert.deepEqual(validateTables(tables, fixture.atlas.frameKeys), []);
});

void test('a chunk with the sprite-name table removed fails, naming the predicate and what it saw', () => {
  const withoutTable = changed((chunk) =>
    chunk.text
      .split('\n')
      .filter((line) => (line.match(/`sprite\//g) ?? []).length <= 100)
      .join('\n'),
  );
  assert.throws(
    () => extractTexts(withoutTable),
    (error: unknown) => {
      assert.ok(error instanceof ExtractionError, `expected an ExtractionError, saw ${String(error)}`);
      assert.equal(error.predicate, 'sprite-name-table');
      assert.match(error.message, /sprite-name-table/);
      assert.match(error.message, /looked for/);
      assert.match(error.message, /nothing in the chunks matched the shape/);
      assert.deepEqual(error.saw, [], 'nothing matched, so there is nothing to describe');
      return true;
    },
  );
});

void test('a flags table whose keys stop resolving through the name table is refused', () => {
  // Rename the last member of every computed key, which keeps the table's shape and breaks its references: the
  // predicate's invariant is that every key resolves to a sprite path, and now none of them do.
  const broken = changed((chunk) =>
    chunk.text.replace(/\[([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*)\]/g, '[$1Missing]'),
  );
  assert.throws(
    () => extractTexts(broken),
    (error: unknown) => {
      assert.ok(error instanceof ExtractionError, `expected an ExtractionError, saw ${String(error)}`);
      assert.equal(error.predicate, 'display-flag-table');
      assert.ok(error.saw.length > 0, 'the refusal has to say what it saw');
      assert.match(error.message, /keys do not resolve to a sprite path/);
      return true;
    },
  );
});

void test('two tables of the same shape are refused rather than guessed between', () => {
  const doubled = changed((chunk) => {
    const line = chunk.text
      .split('\n')
      .find((candidate) => (candidate.match(/`sprite\//g) ?? []).length > 100);
    if (line === undefined) return chunk.text;
    return `${chunk.text}${line.replace(/^(const|let|var)\s+[A-Za-z_$][\w$]*/, '$1 SecondSpriteTable')}\n`;
  });
  assert.throws(
    () => extractTexts(doubled),
    (error: unknown) => {
      assert.ok(error instanceof ExtractionError, `expected an ExtractionError, saw ${String(error)}`);
      assert.equal(error.predicate, 'sprite-name-table');
      assert.match(error.message, /matched 2 tables/);
      assert.equal(error.saw.length, 2);
      return true;
    },
  );
});

void test('a sprite path the atlas does not carry is a validation failure that names the path', () => {
  const victim = spritePathsOf(tables.spriteNames)[0];
  assert.ok(victim !== undefined, 'the name table is empty');
  const frames = fixture.atlas.frameKeys.filter((key) => key !== victim);
  const failures = validateTables(tables, frames);
  const failure = failures.find((candidate) => candidate.table === 'spriteNames');
  assert.ok(failure !== undefined, 'a missing frame was accepted');
  assert.equal(failure.check, 'sprite-name-table: every path is a frame the atlas has');
  assert.ok(failure.saw.includes(victim), `the failure does not name ${victim}: ${failure.saw.join(', ')}`);
  assert.match(failure.detail, /1 of 583 sprite paths are not atlas frames/);
});

void test('a sprite the plant table names but the name table does not state is refused', () => {
  const strayed = {
    ...tables,
    plants: {
      ...tables.plants,
      Carrot: { seed: null, plant: null, crop: { sprite: 'sprite/plant/NotAThing', harvestType: null } },
    },
  };
  const failure = validateTables(strayed, fixture.atlas.frameKeys).find(
    (candidate) => candidate.table === 'plants',
  );
  assert.ok(failure !== undefined, 'a plant sprite the name table does not state was accepted');
  assert.ok(failure.saw.includes('sprite/plant/NotAThing'));
});

void test('a plant sprite is confirmed by the atlas through the name table, so the two checks compose', () => {
  const frames = new Set(fixture.atlas.frameKeys);
  const unconfirmed = [...plantSpritesOf(tables.plants), ...spritePathsOf(tables.spriteNames)].filter(
    (path) => !frames.has(path),
  );
  assert.deepEqual(unconfirmed, []);
});

void test('a display-flag key the name table does not state is refused', () => {
  const strayed = {
    ...tables,
    displayFlags: {
      ...tables.displayFlags,
      'sprite/plant/NotAThing': { isTallPlant: false, isNarrowDisplay: false },
    },
  };
  const failure = validateTables(strayed, fixture.atlas.frameKeys).find(
    (candidate) => candidate.table === 'displayFlags',
  );
  assert.ok(failure !== undefined, 'a flag key outside the name table was accepted');
  assert.ok(failure.saw.includes('sprite/plant/NotAThing'));
});

void test('the refusals are errors, not empty results: a caller cannot mistake one for a short table', () => {
  const withoutTable = changed((chunk) =>
    chunk.text
      .split('\n')
      .filter((line) => (line.match(/`sprite\//g) ?? []).length <= 100)
      .join('\n'),
  );
  let caught: unknown = null;
  try {
    extractTexts(withoutTable);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ExtractionError);
  assert.ok(caught.looksFor.length > 0);
  assert.ok(caught.invariant.length > 0);
  assert.ok(caught instanceof Error && caught.stack !== undefined);
});
