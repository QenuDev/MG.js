/**
 * The icon-box fill table, measured on the captured v1176 build.
 *
 * The fill is not a table the game writes down: the fit function that scales a rendered item into the game's
 * **256x256** icon frame destructures `sizeRatio = 1`, so four of the seven kinds get their share from that
 * default; the inventory renderer's item-kind switch states a share on two of its branches; and a pet is baked
 * to a frame around its own portrait, which is a share of 1 by construction. This file holds the extraction to
 * all three, per kind, rather than letting seven figures look like seven statements.
 *
 * The other half is the witness: the game's own item-type string enum, read from a different chunk, must name
 * exactly the kinds the switch routes -- that is the cross-check `validate.ts` runs, and it is why the enum is
 * a table rather than a note.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadFixture } from './load-fixture.ts';

const fixture = loadFixture();
const { tables } = fixture;

void test('the seven kinds carry the share their route states, and how it was stated', () => {
  assert.deepEqual(tables.iconFills, {
    Seed: { fill: 1, source: 'fit-default' },
    Produce: { fill: 0.4, source: 'stated' },
    Plant: { fill: 0.6, source: 'stated' },
    Tool: { fill: 1, source: 'fit-default' },
    Egg: { fill: 1, source: 'fit-default' },
    Decor: { fill: 1, source: 'fit-default' },
    Pet: { fill: 1, source: 'bake-frame' },
  });
});

void test('only two of the seven shares are stated, and the table says which two', () => {
  const bySource = { stated: 0, 'fit-default': 0, 'bake-frame': 0 };
  for (const entry of Object.values(tables.iconFills)) bySource[entry.source] += 1;
  assert.deepEqual(bySource, { stated: 2, 'fit-default': 4, 'bake-frame': 1 });
  assert.equal(tables.iconFills['Produce']?.source, 'stated');
  assert.equal(tables.iconFills['Plant']?.source, 'stated');
  assert.equal(tables.iconFills['Pet']?.source, 'bake-frame');
});

void test('the item-type enum names the same seven kinds, with its own literals', () => {
  assert.deepEqual(tables.itemTypes, {
    Seed: 'Seed',
    Produce: 'Produce',
    Plant: 'Plant',
    Tool: 'Tool',
    Pet: 'Pet',
    Egg: 'Egg',
    Decor: 'Decor',
  });
});

void test('the fills are proposed by one chunk and confirmed by the enum in another', () => {
  assert.equal(fixture.evidence.iconFills.chunk, 'LayoutMotionController-CwhDlPns.js');
  assert.equal(fixture.evidence.itemTypes.chunk, 'quinoaPredictionAtoms-ptrrFeF6.js');
  assert.notEqual(fixture.evidence.iconFills.chunk, fixture.evidence.itemTypes.chunk);
});

void test('the evidence measures the shape: one fit, one builder, one router, seven kinds', () => {
  const counts = fixture.evidence.iconFills.coverage.counts;
  assert.equal(counts['itemTypes'], 7);
  assert.equal(counts['statedShares'], 2);
  assert.equal(counts['defaultShares'], 4);
  assert.equal(counts['bakeFrames'], 1);
  assert.equal(counts['fitFunctions'], 1);
  assert.equal(counts['builderFunctions'], 1);
  assert.equal(counts['canvasLiteralCalls'], 1);
  assert.equal(counts['routerFunctions'], 1);
});

void test('every fill is in (0, 1], which is the fit the 256 frame can draw', () => {
  for (const [kind, entry] of Object.entries(tables.iconFills)) {
    assert.ok(entry.fill > 0 && entry.fill <= 1, `${kind} fills ${entry.fill} of the box`);
  }
});

void test('the enum is a declaration the fixture keeps, read from the enum body rather than the switch', () => {
  const declaration = fixture.evidence.itemTypes.declaration;
  assert.ok(declaration !== null, 'the enum evidence names no declaration');
  for (const file of fixture.manifest.files) {
    if (file.chunk !== fixture.evidence.itemTypes.chunk) continue;
    assert.ok(
      file.cuts.some((cut) => cut.declaration === declaration),
      `the enum fixture holds no cut for ${declaration}`,
    );
  }
  const counts = fixture.evidence.itemTypes.coverage.counts;
  assert.equal(counts['membersRequestedByTheIconTable'], 7);
  assert.equal(counts['membersAssignedInThisChunk'], 7);
  assert.equal(counts['membersWithConflictingLiterals'], 0);
});
