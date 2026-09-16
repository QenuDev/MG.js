/**
 * The seven shapes, measured on the captured v1176 build.
 *
 * Every number here is the extractor's own output, not a value written into the package: the assertions exist so
 * that a build that moves one of them fails a test rather than drawing a wrong picture. `tests/bundle/full-bundle`
 * runs the same predicates over the game's 121 real chunks and asserts they agree with what the fixture says.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spritePathsOf } from '../../src/bundle/validate.ts';
import { ICON_ANCHORS, MUTATION_SCALE_CAP, TALL_DECAL_SCALE, TALL_PLANTS } from './consumer-oracle.ts';
import { loadFixture } from './load-fixture.ts';

const fixture = loadFixture();
const { tables, evidence } = fixture;

/** A record lookup that fails the test rather than returning `undefined` under `noUncheckedIndexedAccess`. */
function entry<T>(record: Readonly<Record<string, T>>, key: string): T {
  const value = record[key];
  assert.ok(value !== undefined, `expected a table entry named ${key}`);
  return value;
}

void test('the sprite-name table is 583 backtick paths across thirteen categories', () => {
  const categories = Object.fromEntries(
    Object.entries(tables.spriteNames).map(([category, members]) => [category, Object.keys(members).length]),
  );
  assert.deepEqual(categories, {
    Animation: 30,
    Decor: 103,
    Effect: 1,
    Item: 30,
    Mutation: 12,
    MutationOverlay: 5,
    Object: 34,
    Pet: 11,
    PetCosmetic: 24,
    Plant: 109,
    Seed: 63,
    Ui: 157,
    Winter: 4,
  });
  const paths = spritePathsOf(tables.spriteNames);
  assert.equal(paths.length, 583);
  assert.equal(new Set(paths).size, 583, 'sprite paths are unique');
  assert.deepEqual(Object.keys(tables.spriteNames), [
    'Animation',
    'Decor',
    'Effect',
    'Item',
    'Mutation',
    'MutationOverlay',
    'Object',
    'Pet',
    'PetCosmetic',
    'Plant',
    'Seed',
    'Ui',
    'Winter',
  ]);

  // The leaves are backtick literals and nothing else: a reader that projected only quoted strings would
  // report a table with zero paths, which is why the coverage counts the syntax it saw.
  assert.equal(evidence.spriteNames.coverage.counts['templateLiterals'], 583);
  assert.equal(evidence.spriteNames.coverage.counts['quotedStrings'], 0);
  assert.equal(evidence.spriteNames.coverage.counts['leavesThatAreNotSpritePaths'], 0);
  assert.equal(evidence.spriteNames.coverage.counts['categories'], 13);
});

void test('the mutation art table is eleven mutations, nine washes and two materials', () => {
  const art = tables.mutationArt;
  assert.equal(Object.keys(art).length, 11);
  assert.equal(evidence.mutationArt.coverage.counts['valuesWithATint'], 9);
  assert.equal(evidence.mutationArt.coverage.counts['valuesThatAreMaterials'], 2);

  const wet = entry(art, 'Wet');
  assert.deepEqual(wet.tint, { color: 'rgb(50, 180, 200)', alpha: 0.25 });
  assert.equal(wet.material, false);
  assert.equal(wet.iconSprite, 'sprite/mutation/Wet');
  assert.equal(wet.groundSprite, 'sprite/mutation/Puddle');
  assert.equal(wet.overlaySprite, 'sprite/mutation-overlay/WetTallPlant');
  assert.equal(wet.overlayFromBottom, false);

  // Gold and Rainbow are the mutations the consumer knew as a hardcoded pair: they construct a filter with no
  // colour literal at all, which is the game's own way of saying "this one is a shader".
  assert.equal(entry(art, 'Gold').material, true);
  assert.equal(entry(art, 'Rainbow').material, true);
  assert.equal(entry(art, 'Gold').tint, null);
  assert.deepEqual(
    Object.entries(art)
      .filter(([, mutation]) => mutation.material)
      .map(([name]) => name)
      .sort(),
    ['Gold', 'Rainbow'],
  );

  // `overlayFromBottom` is stated by exactly two mutations in this build, and it is read rather than guessed.
  assert.deepEqual(
    Object.entries(art)
      .filter(([, mutation]) => mutation.overlayFromBottom)
      .map(([name]) => name)
      .sort(),
    ['Thundercharged', 'Thunderstruck'],
  );

  // Order is the game's own key order, which is the stacking order the model draws with.
  assert.deepEqual(Object.keys(art).slice(0, 3), ['Rainbow', 'Gold', 'Wet']);
  assert.deepEqual(
    Object.values(art).map((mutation) => mutation.order),
    Object.keys(art).map((_, index) => index),
  );

  for (const [name, mutation] of Object.entries(art)) {
    assert.ok(
      mutation.tint !== null || mutation.material,
      `${name} is neither a wash nor a material, so nothing could draw it`,
    );
    if (mutation.tint !== null) {
      assert.ok(mutation.tint.alpha !== null, `${name} states a colour with no alpha`);
    }
  }
});

void test('the display flags are 109 keys and the tall set is the fifteen the consumer holds by hand', () => {
  const flags = tables.displayFlags;
  assert.equal(Object.keys(flags).length, 109);
  assert.equal(evidence.displayFlags.coverage.counts['keysUnresolved'], 0);
  assert.equal(evidence.displayFlags.coverage.counts['isNarrowDisplayTrue'], 30);

  const tall = Object.entries(flags)
    .filter(([, value]) => value.isTallPlant)
    .map(([path]) => path)
    .sort();
  assert.equal(tall.length, 15);
  // The game keys this by art, and the art name is the last segment of the path -- which is exactly how the
  // consumer's TALL_PLANTS spells it.
  assert.deepEqual(
    tall.map((path) => path.split('/').at(-1)),
    [...TALL_PLANTS].sort(),
  );

  // Keys the game states no flags for share one all-false default record; the coverage says how many keys
  // point at it, which is what makes a build that stops sharing it visible.
  assert.equal(
    Object.values(flags).filter((value) => !value.isTallPlant && !value.isNarrowDisplay).length,
    75,
  );
  assert.equal(evidence.displayFlags.coverage.counts['keysPointingAtTheDefault'], 75);
});

void test('the anchors are the twenty-two the consumer holds by hand, number for number', () => {
  const anchors = tables.anchors;
  assert.equal(Object.keys(anchors).length, 22);
  assert.deepEqual(anchors, ICON_ANCHORS);
  assert.equal(evidence.anchors.coverage.counts['keysThatAreNotSpecies'], 0);
});

void test('the scale cap, the reference tile and the tall-decal multiplier come from the formula itself', () => {
  assert.deepEqual(tables.scale, {
    cap: MUTATION_SCALE_CAP,
    referenceTilePx: 256,
    tallDecalMultiplier: TALL_DECAL_SCALE,
  });
  assert.equal(evidence.scale.coverage.counts['capFormulaOccurrences'], 1);
  assert.equal(evidence.scale.coverage.counts['tallDecalCandidates'], 1);
});

void test('the over set is exactly the four Lunar mutations, and they are a subset of the art table', () => {
  assert.deepEqual(tables.overMutations, ['Dawnlit', 'Ambershine', 'Dawncharged', 'Ambercharged']);
  // Cross-checked against a different table: the mutation records state each mutation's group, and the set the
  // layout code tests is exactly that group. Two readings of the same build, and they agree.
  const lunar = Object.entries(tables.mutationRecords)
    .filter(([, record]) => record.group === 'Lunar')
    .map(([name]) => name)
    .sort();
  assert.deepEqual([...tables.overMutations].sort(), lunar);
});

void test('the plant table is 69 species with every part resolved through the name table', () => {
  const plants = tables.plants;
  assert.equal(Object.keys(plants).length, 69);
  assert.equal(evidence.plants.coverage.counts['spriteReferencesUnresolved'], 0);
  const harvestTypes = Object.values(plants)
    .map((record) => record.plant?.harvestType)
    .filter((value): value is string => value != null);
  assert.equal(harvestTypes.filter((value) => value === 'Single').length, 34);
  assert.equal(harvestTypes.filter((value) => value === 'Multiple').length, 35);
  assert.deepEqual(tables.harvestTypes, { Multiple: 'Multiple', Single: 'Single' });

  const carrot = entry(plants, 'Carrot');
  assert.deepEqual(carrot.seed?.sprite, 'sprite/seed/Carrot');
  assert.deepEqual(carrot.plant?.sprite, 'sprite/plant/BabyCarrot');
  assert.deepEqual(carrot.crop?.sprite, 'sprite/plant/Carrot');
  assert.equal(carrot.plant?.harvestType, 'Single');
});

void test("the placement function is the game's own, 923 characters of it, with three local declarations", () => {
  const placement = tables.placement;
  assert.equal(placement.characters, 923);
  assert.equal(evidence.placement.coverage.counts['characters'], 923);
  assert.equal(evidence.placement.coverage.counts['chunkLocalDeclarationsInTheClosure'], 3);
  assert.equal(evidence.placement.coverage.counts['unresolvedExternals'], 0);
  assert.equal(evidence.placement.coverage.counts['returnsAnOffsetAndAScaleFactor'], 1);
  assert.equal(Object.keys(placement.declarations).length, 3);
  assert.match(placement.source, /^function /);
  assert.deepEqual(placement.externals.map((external) => external.role).sort(), [
    'harvestTypes',
    'host',
    'plants',
  ]);
  // Every external is either a host global or a table this extractor found; the host one is the maths.
  const host = placement.externals.find((external) => external.role === 'host');
  assert.equal(host?.name, 'Math');
  assert.equal(host?.from, null);
  const imported = placement.externals.filter((external) => external.from !== null);
  assert.equal(imported.length, 2, 'the two game tables come from the chunk graph, not from thin air');
});

void test('every table carries a predicate, a shape, an invariant and a measurement', () => {
  for (const [id, item] of Object.entries(evidence)) {
    assert.ok(item.predicate.length > 0, `${id} has no predicate`);
    assert.ok(item.looksFor.length > 0, `${id} has no shape description`);
    assert.ok(item.invariant.length > 0, `${id} has no invariant`);
    assert.ok(item.chunk.endsWith('.js'), `${id} does not name the chunk it was read from`);
    assert.ok(Object.keys(item.coverage.counts).length > 0, `${id} carries no measurement`);
  }
});
