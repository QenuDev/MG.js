/**
 * The schemas the game declares for its kinds, as a table: the seven item kinds, the four tile kinds, the crop a
 * plant slot holds, and the pet base with its two variants.
 *
 * The values asserted here are the extractor's own output rather than a list written down twice, and the last
 * test is the property `art:sync --check` depends on: a run over the committed fixture and a run over the game's
 * own chunks produce the same bytes. That test needs the capture, so it skips by name when this machine has none,
 * exactly as `tests/bundle/full-bundle` does.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { serializeArtData } from '../../src/bundle/data.ts';
import { artDataFor, extractArtTables } from '../../src/bundle/extract.ts';
import type { ArtTables, DeclaredField, KindSchemas, SchemaArm } from '../../src/bundle/tables.ts';
import { projectChunk } from '../../src/bundle/tools/typescript-reader.ts';
import { validateTables } from '../../src/bundle/validate.ts';
import {
  extractTexts,
  loadFixture,
  newestShippedVersion,
  shippedFixtureDirectory,
  textsOf,
} from './load-fixture.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');

/** The newest shipped version is the one `art:sync` writes and `--check` regenerates. */
const version = newestShippedVersion();
const fixture = loadFixture(shippedFixtureDirectory(version));

/**
 * Where this workspace keeps the captured build the newest fixture was cut from. Both layouts are listed because
 * the capture sits beside the monorepo rather than beside the worktree that holds it.
 */
const CANDIDATES =
  process.env['MG_ART_BUNDLE_DIR'] === undefined
    ? [
        resolve(repoRoot, '../mgafk-pi/json', `bundle-${version}-0`),
        resolve(repoRoot, '../../mgafk-pi/json', `bundle-${version}-0`),
      ]
    : [process.env['MG_ART_BUNDLE_DIR']];

const bundle = CANDIDATES.find((candidate) => existsSync(candidate));
const where = bundle === undefined ? '' : ` (${bundle})`;
const missing =
  bundle === undefined
    ? `no captured v${version} bundle on this machine (looked in ${CANDIDATES.join(', ')}) - set MG_ART_BUNDLE_DIR`
    : false;

/** The table the assertions read, failing rather than reaching through `undefined`. */
function schemas(): KindSchemas {
  const table = fixture.tables.kindSchemas;
  assert.ok(table !== undefined, 'the extraction states no kindSchemas table');
  return table;
}

/** One arm of the table, by the id a record names it with. */
function arm(table: KindSchemas, id: string): SchemaArm {
  const found = table.arms[id];
  assert.ok(found !== undefined, `the table records no arm named ${id}`);
  return found;
}

/** One field of an arm, by the game's own spelling. */
function field(arm_: SchemaArm, name: string): DeclaredField {
  const found = arm_.fields.find((candidate) => candidate.name === name);
  assert.ok(found !== undefined, `the arm declares no field named ${name}`);
  return found;
}

/** The tile half's failure for a doctored table, or `undefined` when it was accepted. */
function tileFailure(tables: ArtTables) {
  return validateTables(tables, fixture.atlas.frameKeys).find(
    (failure) => failure.table === 'kindSchemas' && failure.check.includes('tile kind'),
  );
}

/** The table with one member of the tile family changed, without touching any other table. */
function withTiles(change: {
  readonly tiles?: Readonly<Record<string, readonly string[]>>;
  readonly tileTypes?: Readonly<Record<string, string>>;
}): ArtTables {
  const table = schemas();
  return {
    ...fixture.tables,
    kindSchemas: {
      ...table,
      tiles: change.tiles ?? table.tiles,
      tileTypes: change.tileTypes ?? table.tileTypes,
    },
  };
}

void test('the table names the seven item kinds and the four tile kinds, beside the crop and the pet', () => {
  const table = schemas();
  assert.deepEqual(Object.keys(table.items).sort(), [
    'Decor',
    'Egg',
    'Pet',
    'Plant',
    'Produce',
    'Seed',
    'Tool',
  ]);
  assert.equal(table.items['Tool']?.length, 2, 'the tool kind is a union of two schemas');
  // The tile family is keyed by the *member* each arm states, and `tileTypes` carries the lowercase literals the
  // other enum assigns, so only the family says which enum an entry belongs to.
  assert.deepEqual(Object.keys(table.tiles).sort(), ['Crystal', 'Decor', 'Egg', 'Plant']);
  assert.deepEqual(table.tileTypes, {
    Crystal: 'crystal',
    Decor: 'decor',
    Egg: 'egg',
    Plant: 'plant',
  });
  for (const ids of Object.values(table.tiles)) {
    assert.equal(ids.length, 1, 'a tile kind is one schema');
  }
  assert.equal(table.pets.variants.length, 2, 'the pet schema states two variants');
  assert.equal(table.crops.length, 1, 'a plant slot holds one crop schema');
});

void test("the fields are the game's own spelling, and requiredness is the game's own optional wrapper", () => {
  const table = schemas();
  const base = arm(table, table.pets.base[0] ?? '');
  assert.ok(
    base.fields.some((candidate) => candidate.name === 'petSpecies'),
    'the pet base is not spelled the way the game spells it',
  );
  const plant = arm(table, table.items['Plant']?.[0] ?? '');
  assert.ok(
    plant.fields.some((candidate) => candidate.name === 'slots'),
    'the plant schema is not spelled the way the game spells it',
  );

  // The two pet variants differ in exactly the extras' optionality, which is what makes the wrapper readable.
  const variants = table.pets.variants.map((id) => arm(table, id));
  const required = variants.find((candidate) => field(candidate, 'sourceEggId').required);
  const optional = variants.find((candidate) => !field(candidate, 'sourceEggId').required);
  assert.ok(required !== undefined, 'no pet variant requires the egg it came from');
  assert.ok(optional !== undefined, 'no pet variant makes the egg it came from optional');
  // Which variant the item union actually models, rather than only that two exist: plan §1 point 2.
  assert.equal(
    field(arm(table, table.items['Pet']?.[0] ?? ''), 'sourceEggId').required,
    true,
    'the item union is built on the variant that requires the outfit extras',
  );

  const crop = arm(table, table.crops[0] ?? '');
  assert.equal(field(crop, 'species').required, true);
  assert.equal(field(crop, 'x').required, false, 'the crop position is optional');

  // A tile states its own `objectType`, and a decor's mounted crop is optional through the same wrapper.
  const decor = arm(table, table.tiles['Decor']?.[0] ?? '');
  assert.equal(field(decor, 'objectType').required, true);
  assert.equal(field(decor, 'mountedCrop').required, false, 'a decor need not have a crop mounted');
});

void test('the undoctored table passes the witness, which is the positive control', () => {
  assert.deepEqual(validateTables(fixture.tables, fixture.atlas.frameKeys), []);
});

void test('the tile witness fails on an arm member the object-type enum does not assign', () => {
  // The two readings are the union's arms (which produce `tiles`) and the enum declaration (which produces
  // `tileTypes`). This doctors the first, so the two genuinely disagree; the predicate cannot prevent it,
  // because it does not require them to agree.
  const failure = tileFailure(withTiles({ tiles: { ...schemas().tiles, Bush: ['ka'] } }));
  assert.ok(failure !== undefined, 'a tile kind the enum assigns no literal was accepted');
  assert.ok(failure.saw.includes('Bush: the object-type enum assigns it no literal'), failure.saw.join(', '));
});

void test('the tile witness fails on an enum member that has no schema', () => {
  // This is the direction a two-armed subset accepted as "the tile union" would trip: the enum assigns a member
  // the arms never named.
  const failure = tileFailure(withTiles({ tileTypes: { ...schemas().tileTypes, Bush: 'bush' } }));
  assert.ok(failure !== undefined, 'an enum member with no schema was accepted');
  assert.ok(failure.saw.includes('Bush: the enum assigns bush, which has no schema'), failure.saw.join(', '));
});

void test('the tile witness fails on a literal that is not the lowercase objectType', () => {
  const failure = tileFailure(withTiles({ tileTypes: { ...schemas().tileTypes, Plant: 'Plant' } }));
  assert.ok(failure !== undefined, 'a capitalised objectType was accepted');
  assert.ok(failure.saw.includes('Plant: Plant is not lowercase'), failure.saw.join(', '));
});

void test('the tile witness fails on a literal that belongs to the item enum', () => {
  // The plan's §1 point 3 / §7 S3: the item enum is not the tile enum, and a consumer passes `itemType` strings.
  const failure = tileFailure(withTiles({ tileTypes: { ...schemas().tileTypes, Plant: 'Seed' } }));
  assert.ok(failure !== undefined, 'an item-type literal was accepted as an objectType');
  assert.ok(failure.saw.includes('Plant: Seed is an item-type literal'), failure.saw.join(', '));
});

void test('a build whose tile enum assigns a member no arm states is refused by validation, not by the predicate', () => {
  // The falsifiable-on-pipeline-output case: the enum is doctored in the *chunk*, the predicate still reads a
  // table (it does not require the arms and the enum to agree), and the witness is what refuses the result. A
  // check the predicate enforced would never reach this point.
  const mutated = textsOf(fixture).map((chunk) =>
    chunk.file === 'worldDepthSortKey-BXUHHrP0.js'
      ? {
          ...chunk,
          text: chunk.text.replace('e.Crystal=`crystal`,e}({})', 'e.Crystal=`crystal`,e.Bush=`bush`,e}({})'),
        }
      : chunk,
  );
  const { tables } = extractTexts(mutated);
  assert.ok(tables.kindSchemas !== undefined, 'the predicate refused a table it can still read');
  const failure = tileFailure(tables);
  assert.ok(failure !== undefined, 'the arms and the enum were allowed to disagree');
  assert.ok(failure.saw.includes('Bush: the enum assigns bush, which has no schema'), failure.saw.join(', '));
});

void test(`the fixture and the game's own chunks state the same tables, byte for byte${where}`, {
  skip: missing,
}, () => {
  if (bundle === undefined) return;
  const chunks = readdirSync(bundle)
    .filter((name) => name.endsWith('.js'))
    .map((name) => projectChunk(name, readFileSync(resolve(bundle, name), 'utf8')));
  const live = extractArtTables(chunks);
  assert.ok(live.tables.kindSchemas !== undefined, "the game's own chunks state no kind schemas");

  // The property `--check` asserts: evidence read from the fixture is translated back to the game's bytes, so a
  // run over the cut and a run over the bundle have to serialise to the same document.
  const fromFixture = artDataFor(
    { tables: fixture.tables, evidence: fixture.evidence },
    { gameVersion: version, artVersion: version },
  );
  const fromBundle = artDataFor(live, { gameVersion: version, artVersion: version });
  assert.equal(serializeArtData(fromFixture), serializeArtData(fromBundle));
});
