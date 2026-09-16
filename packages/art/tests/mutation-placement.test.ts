/**
 * Placing a mutation on a species' art: the consumer's own cases, and the game's own function run against the
 * port the package publishes.
 *
 * Three things are checked, and they are different kinds of claim:
 *
 *   - The consumer's cases, ported rather than rewritten: the stated per-part anchors of `Carrot` and `Leek`
 *     (`server.mjs:851,870`, measured in `script.test.mjs:1865`), the moonlit mutation the server composes on
 *     a clover (`server.test.mjs:197-248`), and the decal a tall plant gets in place of a mutation's art
 *     (`server.mjs:902,914-930`). The expected numbers are the consumer's, quoted with the line they are on.
 *   - That the model holds no game value of its own: the tall set is the display table's answer, not a list
 *     of names, and the reference tile is the extracted table's, not a second copy of `REFERENCE_TILE_PX`.
 *   - That the port *is* the game's arithmetic: `data/1176.json` carries the assembled source of the game's
 *     own placement function, so this file compiles it and runs both on every captured frame the atlas
 *     fixture holds, comparing the offset and the scale factor. That is the conformance test the plan puts in
 *     this commit, and it keeps working after Phase F deletes the consumer's copy.
 *
 * The frames that are not in the committed atlas fixture are quoted whole from the 2x captures the viewer
 * reads (`.logs/atlas-2x-0.json`, `:2.json`, `:3.json`), as `tests/model.test.ts` quotes its own.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseArtData } from '../src/bundle/data.ts';
import { type FrameBox, frameBox, REFERENCE_TILE_PX } from '../src/model.ts';
import { mutationStack } from '../src/mutation.ts';
import { type MutationArtwork, mutationAnchor, mutationPlacement } from '../src/placement.ts';
import { type FixtureFrame, loadFixture } from './bundle/load-fixture.ts';
import { compilePlacement, rawFrame } from './bundle/placement-function.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** The tables `art:sync` wrote for this game version, read the way a consumer reads them. */
const tables = parseArtData(readFileSync(resolve(here, '../data/1176.json'), 'utf8')).tables;

/** The captured atlas, which is the frames the conformance below is measured on. */
const fixture = loadFixture();

/** A frame of the captured atlas by the game's own key, which is the only way this file names one. */
function captured(sprite: string): FixtureFrame {
  const frame = fixture.atlas.frames[sprite];
  if (frame === undefined) throw new Error(`the atlas fixture does not hold ${sprite}`);
  return frame;
}

/** `sprite/plant/Bamboo`, quoted from `.logs/atlas-2x-0.json`: a tall plant's own art, 281x1280 raw. */
const BAMBOO: FixtureFrame = {
  frame: { x: 8, y: 8, w: 251, h: 1280 },
  rotated: false,
  trimmed: true,
  spriteSourceSize: { x: 22, y: 0, w: 251, h: 1280 },
  sourceSize: { w: 281, h: 1280 },
  anchor: { x: 0.519573, y: 0.964063 },
  sourcePixelRatio: 2,
  visualBaselineY: 0.98125,
};

/** `sprite/mutation/Amberlit`, quoted from `.logs/atlas-2x-2.json`: the art `Ambershine` is drawn as. */
const AMBERLIT: FixtureFrame = {
  frame: { x: 2195, y: 2875, w: 381, h: 312 },
  rotated: false,
  trimmed: true,
  spriteSourceSize: { x: 36, y: 4, w: 381, h: 312 },
  sourceSize: { w: 468, h: 329 },
  anchor: { x: 0.5, y: 0.82006 },
  sourcePixelRatio: 2,
  visualBaselineY: 0.8632218844984803,
};

/** `sprite/mutation/Puddle`, quoted from `.logs/atlas-2x-2.json`: the decal `Wet` pools at a tall foot. */
const PUDDLE: FixtureFrame = {
  frame: { x: 3110, y: 436, w: 451, h: 304 },
  rotated: false,
  trimmed: true,
  spriteSourceSize: { x: 5, y: 7, w: 451, h: 304 },
  sourceSize: { w: 464, h: 314 },
  anchor: { x: 0.49061, y: 0.506944 },
  sourcePixelRatio: 2,
  visualBaselineY: 0.8885350318471338,
};

/** `sprite/mutation/Wet`, quoted from `.logs/atlas-2x-3.json`: a mutation that states a ground decal. */
const WET: FixtureFrame = {
  frame: { x: 338, y: 8, w: 287, h: 220 },
  rotated: false,
  trimmed: true,
  spriteSourceSize: { x: 8, y: 4, w: 287, h: 220 },
  sourceSize: { w: 310, h: 226 },
  anchor: { x: 0.5, y: 0.486726 },
  sourcePixelRatio: 2,
  visualBaselineY: 0.8982300884955752,
};

/** `Wet`, as a caller that has resolved its art and its decal hands it over. */
const WET_ART: MutationArtwork = {
  sprite: 'sprite/mutation/Wet',
  ...frameBox(WET),
  ground: { id: 'sprite/mutation/Puddle', ...frameBox(PUDDLE) },
};

/** `Ambershine`, whose own name is not the art it draws: `server.mjs:921` draws the resolved art's name. */
const AMBERSHINE_ART: MutationArtwork = {
  sprite: 'sprite/mutation/Amberlit',
  ...frameBox(AMBERLIT),
  ground: null,
};

void test('the committed data file and the fixture extraction are the same tables', () => {
  // Not a formality: the frames below are the fixture's and the tables above are the committed file's, so a
  // version drift between them would silently measure the arithmetic of one game against another's art.
  assert.deepEqual(fixture.tables, tables);
});

void test("the model's reference tile is the extracted table's, not a second copy of the constant", () => {
  // `REFERENCE_TILE_PX` landed in the model before the extractor found the table that states the same number
  // (`scale.referenceTilePx`, from the chunk's declared tile). The placement reads the table; this says the
  // published constant and the table still agree, and a build that moves the tile fails here rather than
  // quietly drawing mutations at the old size.
  assert.equal(REFERENCE_TILE_PX, tables.scale.referenceTilePx);
  assert.equal(tables.scale.cap, 0.75);
  assert.equal(tables.scale.tallDecalMultiplier, 2);
});

void test('a species states its anchor per part, and the plant is the part a patch is drawn as', () => {
  // `Carrot: {x: {crop: 0.5}, y: {plant: 0.6, crop: 0.42}}` (`server.mjs:851`). A garden draws a
  // single-harvest species as its plant art (`server.mjs:396`, `:471`), and the consumer reads every stated
  // number for the plant (`:944`), which is what this asks about. The frame is the one `script.test.mjs:1865`
  // measures: 95.5x119 logical, anchored 42.4% across.
  const plant = mutationAnchor(
    'Carrot',
    'sprite/plant/BabyCarrot',
    frameBox(captured('sprite/plant/BabyCarrot')),
    'Single',
    tables,
  );
  // No plant value is stated across, so the art's own anchor stands -- and that is the game's reading too.
  assert.equal(plant.x, 0.424084);
  assert.equal(plant.y, 0.6);
  assert.equal(plant.scale, 95.5 / 256);

  // The seed and the picked crop of the same species are different art, and the game pairs the art with the
  // part it reads the overrides for. Asking about the crop art is therefore a different question with a
  // different answer -- 0.5 across and 0.42 down (`server.mjs:851`) -- which the consumer's port cannot state
  // because it reads `.plant` whatever art it was handed. A single-harvest species draws the plant art, so the
  // two agree everywhere the consumer asks; the model answers the game's question.
  const crop = mutationAnchor(
    'Carrot',
    'sprite/plant/Carrot',
    frameBox(captured('sprite/plant/Carrot')),
    'Single',
    tables,
  );
  assert.equal(crop.x, 0.5);
  assert.equal(crop.y, 0.42);

  // `Leek: {y: {plant: 0.55}, scale: {plant: 0.7}}` (`server.mjs:870`): the scale is stated per part as well,
  // and multiplies the cap rather than replacing it.
  const leek = mutationAnchor(
    'Leek',
    'sprite/plant/BabyLeek',
    frameBox(captured('sprite/plant/BabyLeek')),
    'Single',
    tables,
  );
  assert.equal(leek.y, 0.55);
  assert.equal(leek.scale, tables.scale.cap * 0.7);
});

void test('a moonlit mutation is drawn as the art its own name does not state, above the lower quarter', () => {
  // `server.test.mjs:197-248` composes `Frozen,Ambershine` on a clover and measures the amber wash at `.5`
  // below the mutation pictures -- "both mutations' pictures are anchored in its upper part -- a clover's
  // frost lands on its leaves". The wash itself is `mutation.test.ts`'s case; what belongs to this layer is
  // where the picture lands, and that it lands on the art's stated point rather than on its middle.
  const clover = frameBox(captured('sprite/plant/CloverThreeLeaf'));
  const icon = mutationAnchor('Clover', 'sprite/plant/CloverThreeLeaf', clover, 'Single', tables);
  assert.equal(icon.x, 0.491379); // `Clover` states no across value, so the frame's own anchor (measured: `script.test.mjs:1855`)
  assert.equal(icon.y, 0.3); // `Clover: {y: 0.3}` (`server.mjs:855`)
  assert.equal(icon.tall, false); // a clover is not one of the arts the display table draws tall

  const placed = mutationPlacement(AMBERSHINE_ART, icon, clover, tables);
  assert.equal(placed.sprite, 'sprite/mutation/Amberlit');
  assert.equal(placed.decal, false);
  // The measured part of the case: nothing the mutation draws reaches the lower quarter of the art, which is
  // why the wash there is the crop's own pixels and one colour mixed.
  assert.ok(
    placed.top + placed.height < clover.height * 0.75,
    `the mutation's picture reaches into the lower quarter: ${placed.top + placed.height}`,
  );
  // And it is one of the game's over-mutations, which is the "moonlit" in the case: the band it stacks in is
  // the game's own, read from the extracted over-set rather than from a list written down here.
  assert.equal(
    mutationStack({ name: 'Ambershine', ...tables.mutationArt['Ambershine'] }, tables.overMutations).over,
    true,
  );
});

void test('a tall plant gets the ground decal at twice the size instead of the mutation art', () => {
  // No consumer test draws a tall plant wearing a mutation -- `script.test.mjs`'s pictures are a clover, a
  // tomato, a strawberry, a rose and the celestials -- so this case is ported from the consumer's own
  // `mutationPlacement` (`server.mjs:914-930`): a tall plant gets `piece.id` (`:922`), the ground art, at
  // `TALL_DECAL_SCALE` (`:902`) times the icon's scale (`:917`), and it pools under the crop.
  const bamboo = frameBox(BAMBOO);
  const icon = mutationAnchor('Bamboo', 'sprite/plant/Bamboo', bamboo, 'Single', tables);
  assert.equal(icon.tall, true); // `sprite/plant/Bamboo` is `isTallPlant` in the game's display table
  assert.equal(icon.y, 0.964063); // tall single-harvest art hangs from its own anchor rather than at 0.4
  assert.equal(icon.scale, 140.5 / 256);

  const decal = mutationPlacement(WET_ART, icon, bamboo, tables);
  assert.equal(decal.sprite, 'sprite/mutation/Puddle');
  assert.equal(decal.decal, true);
  // Twice the size, and the multiplier is the table's own -- the consumer holds the same 2 as a constant.
  assert.equal(tables.scale.tallDecalMultiplier, 2);
  assert.ok(Math.abs(decal.width - frameBox(PUDDLE).width * icon.scale * 2) < 1e-9);
  // A decal pools at the foot: it is wider than the art it is drawn under, and it reaches past the foot.
  assert.ok(decal.left < 0, `the decal does not reach past the art: ${decal.left}`);
  assert.ok(
    decal.top + decal.height > bamboo.height,
    `the decal does not pool past the foot: ${decal.top + decal.height}`,
  );

  // The same mutation on a plant that is not drawn tall keeps its own art at its own scale.
  const clover = frameBox(captured('sprite/plant/CloverThreeLeaf'));
  const short = mutationAnchor('Clover', 'sprite/plant/CloverThreeLeaf', clover, 'Single', tables);
  const own = mutationPlacement(WET_ART, short, clover, tables);
  assert.equal(own.sprite, 'sprite/mutation/Wet');
  assert.equal(own.decal, false);
});

void test('the tall set is the display table answer to a flag, not a list of fifteen names in the model', () => {
  const entries = Object.entries(tables.displayFlags);
  assert.ok(entries.length >= 100, `only ${entries.length} display flags, which cannot be the whole table`);
  const tall = entries.filter(([, flags]) => flags.isTallPlant === true);
  assert.equal(tall.length, 15, 'the game draws fifteen arts tall in this build');
  const clover = frameBox(captured('sprite/plant/CloverThreeLeaf'));
  for (const [artName, flags] of entries) {
    const anchor = mutationAnchor('Clover', artName, clover, 'Single', tables);
    assert.equal(anchor.tall, flags.isTallPlant === true, `${artName} is drawn tall or not by the table`);
  }
  // The one thing this can assert that a table-reading loop cannot: flip a flag the consumer's transcribed
  // list does not take, and the model follows the table rather than the list.
  const flipped = {
    ...tables,
    displayFlags: { ...tables.displayFlags, 'sprite/plant/CloverThreeLeaf': { isTallPlant: true } },
  };
  assert.equal(
    mutationAnchor('Clover', 'sprite/plant/CloverThreeLeaf', clover, 'Single', flipped).tall,
    true,
  );
});

void test("the port agrees with the game's own function on every captured frame", () => {
  const game = compilePlacement(tables);
  let checked = 0;
  let worstOffset = 0;
  let worstScale = 0;
  for (const sample of capturedArt()) {
    const mine = mutationAnchor(sample.species, sample.sprite, sample.art, sample.harvestType, tables);
    const theirs = game(rawFrame(sample.frame, sample.art.pixelRatio), sample.species, sample.part);
    // The unit: the game's offset is in raw atlas pixels and its scale factor is already logical, while the
    // port reads `frameBox`, which has divided. `placement-function.ts` says why that divisor is real.
    const offsetX = theirs.offset.x / sample.art.pixelRatio;
    const offsetY = theirs.offset.y / sample.art.pixelRatio;
    const portedX = (mine.x - sample.art.anchorX) * sample.art.width;
    const portedY = (mine.y - sample.art.anchorY) * sample.art.height;
    worstOffset = Math.max(worstOffset, Math.abs(offsetX - portedX), Math.abs(offsetY - portedY));
    worstScale = Math.max(worstScale, Math.abs(theirs.scaleFactor - mine.scale));
    assert.ok(
      Math.abs(offsetX - portedX) < 1e-9 && Math.abs(offsetY - portedY) < 1e-9,
      `${sample.species} ${sample.part} (${sample.sprite}): offset (${offsetX}, ${offsetY}) against (${portedX}, ${portedY})`,
    );
    assert.ok(
      Math.abs(theirs.scaleFactor - mine.scale) < 1e-9,
      `${sample.species} ${sample.part} (${sample.sprite}): scale ${theirs.scaleFactor} against ${mine.scale}`,
    );
    checked += 1;
  }
  assert.ok(checked >= 20, `only ${checked} captured frames were compared, so the agreement is thin`);
  assert.ok(
    capturedArt().some((sample) => sample.part === 'plant') &&
      capturedArt().some((sample) => sample.part === 'crop'),
    'both parts have to be exercised, or the per-part overrides are never read',
  );
  // The measured agreement, recorded so a regression to a looser tolerance is visible.
  assert.equal(worstOffset, 0, `worst offset ${worstOffset}`);
  assert.equal(worstScale, 0, `worst scale ${worstScale}`);
});

/** One captured frame, with the part the game draws it as. */
interface CapturedArt {
  readonly species: string;
  readonly sprite: string;
  readonly part: 'plant' | 'crop';
  readonly harvestType: string;
  readonly art: FrameBox;
  readonly frame: FixtureFrame;
}

/**
 * Every art of every species the atlas fixture actually captured, with the part the game draws it as.
 *
 * The game chooses the art and the part together -- "the plant's sprite when the part is the plant and the
 * species is single-harvest, the crop's sprite otherwise" -- so the art alone says which of a species'
 * per-part numbers apply, and the part this asks the game about is the one that pairing names.
 */
function capturedArt(): readonly CapturedArt[] {
  const found: CapturedArt[] = [];
  for (const [species, record] of Object.entries(tables.plants)) {
    const harvestType = record.plant?.harvestType ?? '';
    const single = harvestType === tables.harvestTypes['Single'];
    for (const part of ['plant', 'crop'] as const) {
      const sprite = record[part]?.sprite;
      if (sprite === null || sprite === undefined) continue;
      const frame = fixture.atlas.frames[sprite];
      if (frame === undefined) continue;
      const drawn = single && sprite === record.plant?.sprite ? 'plant' : 'crop';
      found.push({ species, sprite, part: drawn, harvestType, art: frameBox(frame), frame });
    }
  }
  return found;
}
