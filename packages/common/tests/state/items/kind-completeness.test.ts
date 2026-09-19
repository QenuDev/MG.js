/**
 * The completeness gate: what the game declares for a kind, against what this library exposes.
 *
 * ## Why this file exists
 *
 * `tests/state/reader.test.ts` was titled "a player carries the whole inventory, and every kind of item
 * reads its own fields", walked all seven kinds, and asserted only shared fields: the pet fixture 100 lines
 * above already carried `xp`, `hunger`, `targetScale` and `abilities`, and no assertion could see them. A
 * test that lists the fields a human remembered is a test that agrees with the model. This one does not list
 * them: it reads the field lists out of the game's own extraction, reads the library's own arms through the
 * real readers, and compares the two.
 *
 * ## The two sides
 *
 * **Declared** is `kindSchemas` in `packages/art/data/<newest>.json` — the table Task 0's predicate cut from
 * the game's client bundle. A family maps a kind to the arms its union arm names, and an arm maps to its own
 * fields plus the arms it spreads, so the field list is a walk. The file is read **by path** and not through
 * `@mg.js/art`, because `common` must not depend on `art`; `art:sync --check` in the root `verify` already
 * proves the committed file is that extraction. The newest shipped version is resolved the way
 * `packages/art/tests/bundle/load-fixture.ts` resolves it, so a version bump does not silently stop testing.
 * A missing file or a table without `kindSchemas` **throws rather than skips**: `docs/DESIGN.md` I8 says a
 * gate must be able to fail, and a vanished table is the loudest failure this one can have.
 *
 * **Exposed** is `Object.keys` of a real read — `toInventoryItem`, `toTile`, `toCrop`, `toPet` — on the
 * game's own sample records, quoted below from the reader tests that already read them. Nothing here is a
 * hand-built echo of the model: the comparison is between two independently produced lists.
 *
 * ## The two directions
 *
 * The forward direction is `declared ⊆ exposed`: a field the game declares that this library does not expose
 * is the hole §1.1 found (a pet's `xp`, `hunger`, `targetScale`, `abilities`). The converse is
 * `exposed ⊆ declared`, with the allowance below: a field this library exposes that the game does not declare
 * for that kind is the same defect seen from the other side.
 *
 * ## The renames, which are not gaps
 *
 * Four fields are exposed under this library's own name for the game's field, and each is documented where
 * the exposed name is declared. They are stated here so that the comparison can see the field at all:
 *
 *     petSpecies -> species   InventoryItemBase.species, PetFields.species (a pet's species)
 *     slots      -> crops     InventoryItemBase.crops (a potted plant's crops; Plant's arm declares slots)
 *     slots      -> plots     TileBase.plots (a tile's crops; the plant tile arm declares slots)
 *     slotId     -> id        Crop.id (the crop's own id, which the schema spells slotId)
 *
 * An alias is only a rename: the game declares the field and the library reads it. Anything else — a declared
 * field with no exposed counterpart, or an exposed field the game does not declare and the allowance below
 * does not name — is a real gap and fails here.
 *
 * ## The allowance, one entry per family
 *
 * The library legitimately exposes fields the schema does not declare, because they are the view's own or
 * derived rather than read. They are named exactly, per family, with their reason, and the family's computed
 * extra fields are asserted **equal** to that list: the list cannot grow without a real new field behind it,
 * and a new exposed field cannot appear without a decision about it. See {@link FIELD_ALLOWANCE}.
 *
 * ## I8: the gate can fail
 *
 * The forward direction was shown red by deleting `hunger` from `readPet` and by adding a field name to the
 * extracted arm; the converse was shown red by adding a field to a kind reader that its arm does not declare.
 * Those runs are recorded in the task report, not here.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ItemKind } from '../../../src/state/items/base.js';
import { ITEM_KINDS, ITEM_READERS } from '../../../src/state/items/registry.js';
import { StateRecord, toCrop, toInventoryItem, toPet, toTile } from '../../../src/state/reader.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The committed extraction, four directories up: `tests/state/items` -> `packages/art/data`. */
const DATA_DIR = resolve(HERE, '../../../../art/data');

/**
 * One schema arm: its own field names plus the arms it spreads, which the walk resolves.
 *
 * The extraction also records each field's required flag and the arm's declaration letter; this gate compares
 * *names*, so it reads neither, and reads nothing it does not use (`docs/DESIGN.md` §5).
 */
interface SchemaArm {
  readonly spreads: readonly string[];
  readonly fields: readonly string[];
}

/** The `kindSchemas` table, to the shape `packages/art/src/bundle/tables.ts` states it. */
interface KindSchemas {
  readonly items: Readonly<Record<string, readonly string[]>>;
  readonly tiles: Readonly<Record<string, readonly string[]>>;
  readonly tileTypes: Readonly<Record<string, string>>;
  readonly crops: readonly string[];
  readonly pets: {
    readonly base: readonly string[];
    readonly variants: readonly string[];
  };
  readonly arms: Readonly<Record<string, SchemaArm>>;
}

/**
 * The newest version `packages/art/data` ships, which is the one `art:sync` writes and `--check` regenerates.
 *
 * Resolved the way `packages/art/tests/bundle/load-fixture.ts` resolves it — every `.json`, name-sorted, last
 * one — rather than hardcoded, so a version bump moves this gate with the pipeline instead of leaving it
 * measuring a version that is no longer shipped.
 */
function newestVersion(): string {
  const versions = readdirSync(DATA_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
  const newest = versions.at(-1);
  if (newest === undefined) throw new Error('packages/art/data ships no kind-schema table');
  return newest;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One field of a parsed object, failing loudly rather than reading `undefined`. */
function fieldIn(value: unknown, field: string, what: string): unknown {
  if (!isObject(value)) throw new Error(`${what} is not an object, so it states no ${field}`);
  if (!Object.hasOwn(value, field)) throw new Error(`${what} states no ${field}`);
  return value[field];
}

function stringIn(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what} is not a string`);
  return value;
}

function stringsIn(value: unknown, what: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${what} is not an array of strings`);
  }
  return value;
}

function stringMapIn(value: unknown, what: string): Readonly<Record<string, string>> {
  if (!isObject(value)) throw new Error(`${what} is not an object`);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new Error(`${what}.${key} is not a string`);
    out[key] = entry;
  }
  return out;
}

function armListMapIn(value: unknown, what: string): Readonly<Record<string, readonly string[]>> {
  if (!isObject(value)) throw new Error(`${what} is not an object`);
  const out: Record<string, readonly string[]> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = stringsIn(entry, `${what}.${key}`);
  return out;
}

function declaredNamesIn(value: unknown, what: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not an array of fields`);
  return value.map((entry, index) =>
    stringIn(fieldIn(entry, 'name', `${what}[${index}]`), `${what}[${index}].name`),
  );
}

function armsIn(value: unknown): Readonly<Record<string, SchemaArm>> {
  if (!isObject(value)) throw new Error('kindSchemas.arms is not an object');
  const arms: Record<string, SchemaArm> = {};
  for (const [id, arm] of Object.entries(value)) {
    arms[id] = {
      spreads: stringsIn(fieldIn(arm, 'spreads', `kindSchemas.arms.${id}`), `kindSchemas.arms.${id}.spreads`),
      fields: declaredNamesIn(
        fieldIn(arm, 'fields', `kindSchemas.arms.${id}`),
        `kindSchemas.arms.${id}.fields`,
      ),
    };
  }
  return arms;
}

/**
 * The committed extraction, read once at load.
 *
 * A parse that cannot find the table throws here, at module load, so the file's tests fail rather than pass
 * vacuously. It does not import `@mg.js/art`: this is a test-only read of a committed file in the monorepo.
 */
function readKindSchemas(): KindSchemas {
  const version = newestVersion();
  const parsed: unknown = JSON.parse(readFileSync(resolve(DATA_DIR, `${version}.json`), 'utf8'));
  const tables = fieldIn(parsed, 'tables', `packages/art/data/${version}.json`);
  const table = fieldIn(tables, 'kindSchemas', `packages/art/data/${version}.json tables`);
  const what = 'kindSchemas';
  const pets = fieldIn(table, 'pets', what);
  return {
    items: armListMapIn(fieldIn(table, 'items', what), `${what}.items`),
    tiles: armListMapIn(fieldIn(table, 'tiles', what), `${what}.tiles`),
    tileTypes: stringMapIn(fieldIn(table, 'tileTypes', what), `${what}.tileTypes`),
    crops: stringsIn(fieldIn(table, 'crops', what), `${what}.crops`),
    pets: {
      base: stringsIn(fieldIn(pets, 'base', `${what}.pets`), `${what}.pets.base`),
      variants: stringsIn(fieldIn(pets, 'variants', `${what}.pets`), `${what}.pets.variants`),
    },
    arms: armsIn(fieldIn(table, 'arms', what)),
  };
}

const kindSchemas = readKindSchemas();

/** A field this library exposes under a different name than the schema spells it. */
interface Rename {
  readonly declared: string;
  readonly exposed: string;
}

/** The item side's two renames, both of which the base's own comments state (`state/items/base.ts`). */
const ITEM_RENAMES: readonly Rename[] = [
  { declared: 'petSpecies', exposed: 'species' },
  { declared: 'slots', exposed: 'crops' },
];

/** The tile side's rename: the plant tile arm's `slots` is `TileBase.plots` (`entities.ts`). */
const TILE_RENAMES: readonly Rename[] = [{ declared: 'slots', exposed: 'plots' }];

/** The crop schema's `slotId` is the crop's own `id` (`Crop.id`). */
const CROP_RENAMES: readonly Rename[] = [{ declared: 'slotId', exposed: 'id' }];

/** The pet family's rename, the same one the item side states: `aa` declares `petSpecies`. */
const PET_RENAMES: readonly Rename[] = [{ declared: 'petSpecies', exposed: 'species' }];

/** The four families the gate measures, one entry each in the allowance. */
type Family = 'items' | 'tiles' | 'crops' | 'pets';

/**
 * The fields a family legitimately exposes although the game's schema does not declare them, each with its
 * reason. The family's own computed extra fields are asserted equal to this list, so it cannot grow silently.
 *
 * - `items` — the base surface. The per-kind converse is scoped to the kind's own reader (plan §6), and this
 *   is the one converse that covers the shared base: every field the base exposes must be declared by *some*
 *   kind, or be one of these three.
 *   - `entityPath`, `record`: the view's own address and escape hatch (`StateView`, `InventoryItemBase`).
 *   - `hasLife`: derived — whether `remainingActiveSeconds` is present — not a field any arm declares
 *     (`readInventoryItemBase`).
 * - `tiles` — the tile base and the derived readings.
 *   - `entityPath`, `record`: the view's own (`TileBase`).
 *   - `id`: the tile's key in its map; the save states a tile's number by keying the map, not in the schema.
 *   - `tileType`: which of the garden's two maps the tile was read from — the save says it by keying, not in
 *     the schema.
 *   - `plantedAt`, `maturedAt`, `plots`: declared by the plant and egg arms only, carried on the tile base
 *     for every arm because a tile's own fields are read the same way whichever kind it is (`toTile`'s own
 *     comment, the rule `ac7bcb5` set).
 *   - `hasLife`: derived from whether `remainingActiveSeconds` is present (`CrystalTile.hasLife`).
 * - `crops` — the derived readings and the view's own.
 *   - `entityPath`, `record`: the view's own (`Crop`).
 *   - `positioned`: derived — whether the save stated a position at all (`toCrop`).
 *   - `ready`, `remainingMs`: derived from `endTime` against the reader's clock (`toCrop`).
 * - `pets` — the view's own, and nothing else: `PetFields` is exactly the `aa`/`Ca`/`wa` list.
 *   - `entityPath`, `record`: the view's own (`Pet`).
 */
const FIELD_ALLOWANCE = {
  items: ['entityPath', 'hasLife', 'record'],
  tiles: ['entityPath', 'hasLife', 'id', 'maturedAt', 'plantedAt', 'plots', 'record', 'tileType'],
  crops: ['entityPath', 'positioned', 'ready', 'record', 'remainingMs'],
  pets: ['entityPath', 'record'],
} satisfies Readonly<Record<Family, readonly string[]>>;

/** One kind's arms from a family record, failing loudly when the extraction names a kind it has no arm for. */
function armsFor(
  family: Readonly<Record<string, readonly string[]>>,
  member: string,
  what: string,
): readonly string[] {
  const arms = family[member];
  if (arms === undefined) throw new Error(`the extraction states no ${what} named ${member}`);
  return arms;
}

/** A kind's declared field names: each arm's own, then each spread base's, none twice, in the game's order. */
function declaredFields(armIds: readonly string[]): readonly string[] {
  const names: string[] = [];
  const visit = (id: string): void => {
    const arm = kindSchemas.arms[id];
    if (arm === undefined) throw new Error(`the extraction names arm ${id} but states no such arm`);
    for (const name of arm.fields) if (!names.includes(name)) names.push(name);
    for (const spread of arm.spreads) visit(spread);
  };
  for (const id of armIds) visit(id);
  return names;
}

/**
 * The pet family's declared field list: the shared base, plus what each variant adds on its own.
 *
 * The variants' `spreads` are deliberately not walked: `Ca`/`wa` spread `Sa`, which declares `itemType` —
 * the *item* discriminant. A pet in a slot is not an item, so `toPet`'s carrier has no `itemType`, and
 * walking that spread would report the carrier missing a field its schema does not have (`state/items/pet.ts`
 * states the split: `aa` is the base, `Sa` adds the item discriminant, the variants add the three extras).
 */
function declaredPetFields(): readonly string[] {
  const names = [...declaredFields(kindSchemas.pets.base)];
  for (const variant of kindSchemas.pets.variants) {
    const arm = kindSchemas.arms[variant];
    if (arm === undefined)
      throw new Error(`the extraction names pet variant ${variant} but states no such arm`);
    for (const name of arm.fields) if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** The name this library exposes a declared field under, which is the field itself unless it was renamed. */
function exposedName(renames: readonly Rename[], declared: string): string {
  return renames.find((rename) => rename.declared === declared)?.exposed ?? declared;
}

/** The schema's name for an exposed field, which is the field itself unless it was renamed. */
function declaredName(renames: readonly Rename[], exposed: string): string {
  return renames.find((rename) => rename.exposed === exposed)?.declared ?? exposed;
}

/** The declared fields the library does not expose, which is the hole this gate was built for. */
function unexposed(
  declared: readonly string[],
  exposed: readonly string[],
  renames: readonly Rename[],
): string[] {
  return declared.filter((name) => !exposed.includes(exposedName(renames, name)));
}

/** The exposed fields the game does not declare for the same kind, which is the same defect from the other side. */
function undeclared(
  declared: readonly string[],
  exposed: readonly string[],
  renames: readonly Rename[],
): string[] {
  return exposed.filter((name) => !declared.includes(declaredName(renames, name)));
}

/** The names in `names` that `allowed` does not state, sorted, so a family-wide allowance can be a superset. */
function beyondAllowance(names: readonly string[], allowed: readonly string[]): string[] {
  return names.filter((name) => !allowed.includes(name));
}

/**
 * One inventory entry per kind, the game's own sample records.
 *
 * Quoted from `tests/state/reader.test.ts`'s inventory fixture (the real garden read out of the bundle), one
 * entry per kind, with the second `Tool` variant because it is the one that declares `remainingActiveSeconds`.
 * Only `petSpecies` matters to `toPet`, and only `itemType` picks the arm here; the rest is what makes these
 * real records rather than objects shaped to please the model.
 */
const ITEM_SAMPLES = {
  Seed: { itemType: 'Seed', species: 'Clover', quantity: 12 },
  Produce: { itemType: 'Produce', id: 'crop_1', species: 'Tomato', size: 75, mutations: ['Gold'] },
  Plant: {
    itemType: 'Plant',
    id: 'plant_1',
    species: 'Rose',
    slots: [{ slotId: 0, species: 'Rose', startTime: 0, endTime: 60_000, size: 60, mutations: [] }],
    plantedAt: 0,
    maturedAt: 60_000,
  },
  Tool: { itemType: 'Tool', id: 'tool_1', toolId: 'RainPotion', quantity: 1, remainingActiveSeconds: 0 },
  Pet: {
    itemType: 'Pet',
    id: 'pet_bag',
    petSpecies: 'Fox',
    name: 'Rusty',
    xp: 10,
    hunger: 50,
    mutations: [],
    targetScale: 1,
    abilities: [],
  },
  Egg: { itemType: 'Egg', eggId: 'SnowEgg', quantity: 3 },
  Decor: { itemType: 'Decor', decorId: 'Fence', quantity: 4 },
} satisfies Readonly<Record<ItemKind, Record<string, unknown>>>;

/**
 * One tile per arm the extraction names, keyed by the *member* the tile enum spells, quoted from
 * `tests/state/reader.test.ts`'s four-arm garden fixture. The record's `objectType` is the lowercase literal
 * `kindSchemas.tileTypes` maps the member to, which the tile test asserts beside the arm it selects.
 */
const TILE_SAMPLES: Readonly<Record<string, Record<string, unknown> | undefined>> = {
  Plant: {
    objectType: 'plant',
    species: 'Clover',
    slots: [{ species: 'Clover', startTime: 0, endTime: 1_000, size: 50, slotId: 0 }],
    plantedAt: 0,
    maturedAt: 1_000,
  },
  Egg: { objectType: 'egg', eggId: 'SnowEgg', plantedAt: 0, maturedAt: 60_000 },
  Decor: {
    objectType: 'decor',
    decorId: 'MarblePedestal',
    rotation: 90,
    mountedCrop: { species: 'Tomato', startTime: 0, endTime: 2_000, size: 75, x: 0.1, y: -0.2, slotId: 3 },
  },
  Crystal: { objectType: 'crystal', crystalType: 'Hunger', remainingActiveSeconds: 1_440 },
};

/** The crop sample, the richest slot in the reader fixture: it states every optional `ga` field. */
const CROP_SAMPLE = {
  species: 'Strawberry',
  startTime: 0,
  endTime: 20_000,
  size: 62,
  mutations: ['Gold', 'Wet'],
  x: 3,
  y: 4,
  rotation: 90,
  flipped: false,
  preserved: true,
  slotId: 7,
} satisfies Record<string, unknown>;

/** The pet sample: the game's own `aa`/`Ca` record, quoted from the pet reader test. */
const PET_SAMPLE = {
  id: 'pet_1',
  petSpecies: 'SnowFox',
  name: 'Frost',
  xp: 1_483_200,
  hunger: 185,
  mutations: ['Rainbow'],
  targetScale: 1.03125,
  abilities: ['DawnCoinFinder', 'RainbowGranter', 'DawnbinderBoost'],
  sourceEggId: 'SnowEgg',
  abilityCooldowns: { DawnCoinFinder: 30 },
  equippedCosmetics: { hat: 'Ballcap' },
} satisfies Record<string, unknown>;

/** The member -> tile record lookup, failing loudly when the extraction names a member with no sample here. */
function tileSampleFor(member: string): Record<string, unknown> {
  const sample = TILE_SAMPLES[member];
  if (sample === undefined)
    throw new Error(`the extraction names tile ${member}, which this file has no record for`);
  return sample;
}

/** The exposed fields of one tile member that its arm does not declare. */
function tileExtras(member: string): string[] {
  const sample = tileSampleFor(member);
  const literal = kindSchemas.tileTypes[member];
  if (typeof literal !== 'string') {
    throw new Error(`the extraction states no object-type literal for tile ${member}`);
  }
  assert.equal(sample['objectType'], literal, `${member} reads the literal the tile enum maps it to`);
  const declared = declaredFields(armsFor(kindSchemas.tiles, member, 'tile'));
  const exposed = Object.keys(toTile(1, sample, 0, '/garden/tileObjects/1', 'Dirt'));
  return undeclared(declared, exposed, TILE_RENAMES);
}

void test('the extraction and the library name the same item kinds', () => {
  // `ITEM_KINDS` is read here on purpose (`DESIGN.md` §5, no inert surface): the plan's §10 names this gate
  // as what keeps it from being surface. The comparison also means a kind the game has gained, which the
  // library has no arm for, is a failure here rather than a silent `OtherItem` in a consumer.
  assert.deepEqual(
    [...ITEM_KINDS].sort(),
    Object.keys(kindSchemas.items).sort(),
    'every kind the game declares is a kind the library registers, and the other way round',
  );
});

for (const kind of ITEM_KINDS) {
  void test(`${kind}: every declared field is exposed, and its own reader reads nothing else`, () => {
    const declared = declaredFields(armsFor(kindSchemas.items, kind, 'item kind'));
    const item = toInventoryItem(ITEM_SAMPLES[kind], '/items/0');
    assert.deepEqual(
      unexposed(declared, Object.keys(item), ITEM_RENAMES),
      [],
      `${kind}: a field the game declares is not on the arm`,
    );

    // The converse, scoped the way plan §6 scopes it: the fields the kind's own reader produces, which are
    // the arm's own fields and not the base's shared surface. A name there that the arm does not declare is
    // as wrong as a missing one.
    const own = Object.keys(ITEM_READERS[kind](new StateRecord(ITEM_SAMPLES[kind])));
    assert.deepEqual(
      undeclared(declared, own, ITEM_RENAMES),
      [],
      `${kind}: the kind reader reads a field the game does not declare for it`,
    );
  });
}

void test('every field the item base exposes is declared by some kind, or is the view’s own or derived', () => {
  // The base is one object every arm is built from, so its fields are exposed on all seven arms at once and
  // neither direction above sees a field added to it: the forward check only asks that declared fields are
  // exposed, and the per-kind converse only sees the kind's own reader. This closes that door: the base's
  // surface must be a field some kind declares (through the renames), or one of the three named as derived
  // or the view's own. A field added to `readInventoryItemBase` fails here.
  const declaredEverywhere = ITEM_KINDS.flatMap((kind) =>
    declaredFields(armsFor(kindSchemas.items, kind, 'item kind')),
  );
  const base = Object.keys(toInventoryItem({}, '/items/base'));
  assert.deepEqual(
    undeclared(declaredEverywhere, base, ITEM_RENAMES).sort(),
    [...FIELD_ALLOWANCE.items].sort(),
    'the item base exposes a field no kind declares and the allowance does not name',
  );
});

for (const member of Object.keys(kindSchemas.tiles).sort()) {
  void test(`tile ${member}: every declared field is exposed, and only the allowance is not declared`, () => {
    const declared = declaredFields(armsFor(kindSchemas.tiles, member, 'tile kind'));
    const exposed = Object.keys(toTile(1, tileSampleFor(member), 0, '/garden/tileObjects/1', 'Dirt'));
    assert.deepEqual(
      unexposed(declared, exposed, TILE_RENAMES),
      [],
      `tile ${member}: a field the game declares is not on the arm`,
    );
    assert.deepEqual(
      beyondAllowance(undeclared(declared, exposed, TILE_RENAMES), FIELD_ALLOWANCE.tiles),
      [],
      `tile ${member}: the arm exposes a field the game does not declare and the allowance does not name`,
    );
  });
}

void test('the tile family exposes exactly the allowance, and every allowed name is real', () => {
  // The union across the four arms is what pins the allowance: dropping a name the family no longer exposes
  // fails, and adding one no arm produces fails too. The allowance cannot grow silently.
  const union = new Set(Object.keys(kindSchemas.tiles).flatMap((member) => tileExtras(member)));
  assert.deepEqual(
    [...union].sort(),
    [...FIELD_ALLOWANCE.tiles].sort(),
    'the fields the tile arms expose without the game declaring them are exactly the allowance',
  );
});

void test('crop: every declared field is exposed, and only the derived fields are not declared', () => {
  const declared = declaredFields(kindSchemas.crops);
  const crop = toCrop(CROP_SAMPLE, 0, '/garden/tileObjects/30/slots/0');
  const exposed = Object.keys(crop);
  assert.deepEqual(
    unexposed(declared, exposed, CROP_RENAMES),
    [],
    'a field the game declares for a crop is not on the crop',
  );
  assert.deepEqual(
    undeclared(declared, exposed, CROP_RENAMES).sort(),
    [...FIELD_ALLOWANCE.crops].sort(),
    'the crop exposes a field the game does not declare and the allowance does not name',
  );
});

void test('pet: every declared field is exposed, and only the view’s own are not declared', () => {
  const declared = declaredPetFields();
  const pet = toPet(PET_SAMPLE, '/userSlots/0/data/petSlots/0');
  assert.ok(pet !== null, 'the sample states the petSpecies that makes it a pet');
  const exposed = Object.keys(pet);
  assert.deepEqual(
    unexposed(declared, exposed, PET_RENAMES),
    [],
    'a field the game declares for a pet is not on the slot carrier',
  );
  assert.deepEqual(
    undeclared(declared, exposed, PET_RENAMES).sort(),
    [...FIELD_ALLOWANCE.pets].sort(),
    'the pet carrier exposes a field the game does not declare and the allowance does not name',
  );
});

void test('the allowance is exactly these names, one entry per family', () => {
  // Pinned as literals so a new allowance name is a decision recorded here, not a line that made a failure
  // go away. Each name's reason is in the `FIELD_ALLOWANCE` block above.
  assert.deepEqual(FIELD_ALLOWANCE.items, ['entityPath', 'hasLife', 'record']);
  assert.deepEqual(FIELD_ALLOWANCE.tiles, [
    'entityPath',
    'hasLife',
    'id',
    'maturedAt',
    'plantedAt',
    'plots',
    'record',
    'tileType',
  ]);
  assert.deepEqual(FIELD_ALLOWANCE.crops, ['entityPath', 'positioned', 'ready', 'record', 'remainingMs']);
  assert.deepEqual(FIELD_ALLOWANCE.pets, ['entityPath', 'record']);
});

void test('the rename lists are exactly these entries, one list per family', () => {
  // A rename is allowed only where it is the library's own name for the same wire field: the schema declares
  // a field, the library exposes it under the name its own type's comment gives it, and the forward direction
  // still checks that it is exposed. It is never a declared field with no exposed counterpart — that is the
  // hole this file exists for, and no alias may excuse it.
  //
  // Pinned contents and order, as the allowance is pinned above, so a rename is not the second escape hatch a
  // future author can widen silently: adding an entry to excuse a mismatch is editing this test, where each
  // list's reason sits beside it (`ITEM_RENAMES` and friends) rather than in a diff that touches no test.
  assert.deepEqual(ITEM_RENAMES, [
    { declared: 'petSpecies', exposed: 'species' },
    { declared: 'slots', exposed: 'crops' },
  ]);
  assert.deepEqual(TILE_RENAMES, [{ declared: 'slots', exposed: 'plots' }]);
  assert.deepEqual(CROP_RENAMES, [{ declared: 'slotId', exposed: 'id' }]);
  assert.deepEqual(PET_RENAMES, [{ declared: 'petSpecies', exposed: 'species' }]);
});
