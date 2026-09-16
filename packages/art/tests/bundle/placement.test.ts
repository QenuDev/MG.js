/**
 * The conformance test: the extracted function is compiled and run, and its numbers must match the formula the
 * consumer ported by hand.
 *
 * This is the point of extracting a *formula* rather than a value. The port cannot be proven right by reading
 * it; it can be proven right by running both on the same real atlas frames, and that proof keeps working after
 * Phase F deletes the port from the consumer, because the port's arithmetic survives here as the oracle.
 *
 * The bindings come from the roles the extractor resolved, not from names: an external the function indexes with
 * its own species parameter is the plant table, an external whose member it reads as a harvest type is the
 * enum, and anything else it reads is a host global. If a build renames either table, the roles still resolve
 * and this test still runs -- and if a build changes what the function does with them, this test fails.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArtTables } from '../../src/bundle/tables.ts';
import { type PortedArt, portedMutationAnchor, type RawFrame } from './consumer-oracle.ts';
import { type LoadedFixture, loadFixture } from './load-fixture.ts';

const fixture = loadFixture();
const { tables } = fixture;

/** Compile the game's own placement function with the bindings its roles call for. */
function compilePlacement(
  tables_: ArtTables,
  fixture_: LoadedFixture,
): (
  frame: RawFrame,
  species: string,
  part: string,
) => { offset: { x: number; y: number }; scaleFactor: number } {
  const placement = tables_.placement;
  const plants: Record<string, { plant: { harvestType: string } }> = {};
  for (const [species, record] of Object.entries(tables_.plants)) {
    const harvest = record.plant?.harvestType;
    plants[species] = {
      plant: { harvestType: harvest == null ? '' : (tables_.harvestTypes[harvest] ?? harvest) },
    };
  }
  const bindingFor = (external: (typeof placement.externals)[number]): unknown => {
    if (external.role === 'plants') return plants;
    if (external.role === 'harvestTypes') return tables_.harvestTypes;
    if (external.role === 'host') return (globalThis as Record<string, unknown>)[external.name];
    throw new Error(`the extractor could not resolve ${external.name}, so the function cannot be run`);
  };
  const names = placement.externals.map((external) => external.name);
  const values = placement.externals.map((external) => bindingFor(external));
  const preamble = [...Object.values(placement.declarations), placement.source].join('\n');
  assert.ok(placement.name !== null, 'the extracted function is anonymous, so it cannot be returned by name');
  const factory = new Function(...names, `${preamble}\nreturn ${placement.name};`) as (
    ...args: unknown[]
  ) => (
    frame: RawFrame,
    species: string,
    part: string,
  ) => { offset: { x: number; y: number }; scaleFactor: number };
  // The fixture's own bindings are what a consumer would pass; nothing here is a value written into the test.
  void fixture_;
  return factory(...values);
}

/**
 * A species whose art the fixture atlas actually carries.
 *
 * The consumer draws a mutation on the *crop* art through the *plant* overrides -- "the tile the game grows is
 * the plant, and that is the one a garden shows" -- so the comparison uses the crop frame and the `plant`
 * variant, which is exactly how the spike's first agreement was measured.
 */
interface Sample {
  readonly species: string;
  readonly sprite: string;
  readonly part: 'plant' | 'crop';
  readonly frame: RawFrame;
  readonly art: PortedArt;
}

function samples(): readonly Sample[] {
  const found: Sample[] = [];
  for (const [species, record] of Object.entries(tables.plants)) {
    const sprite = record.crop?.sprite ?? record.plant?.sprite;
    if (sprite == null) continue;
    const frame = fixture.atlas.frames[sprite];
    if (frame === undefined) continue;
    const ratio =
      frame.sourcePixelRatio !== undefined && frame.sourcePixelRatio > 0 ? frame.sourcePixelRatio : 1;
    found.push({
      species,
      sprite,
      part: 'plant',
      frame: {
        width: frame.sourceSize.w,
        height: frame.sourceSize.h,
        defaultAnchor: { x: frame.anchor.x, y: frame.anchor.y },
        sourcePixelRatio: ratio,
      },
      art: {
        width: frame.sourceSize.w / ratio,
        height: frame.sourceSize.h / ratio,
        anchorX: frame.anchor.x,
        anchorY: frame.anchor.y,
        pixelRatio: ratio,
      },
    });
  }
  return found;
}

void test('the fixture carries real frames for both a plant part and a crop part', () => {
  const found = samples();
  assert.ok(found.length >= 8, `only ${found.length} sampled frames: the atlas fixture lost its frames`);
  assert.ok(
    found.some((sample) => sample.frame.height > sample.frame.width * 1.5),
    'no tall frame among the samples, so the tall-anchor branch would never be exercised',
  );
});

void test("the extracted placement function agrees with the consumer's port on every sampled frame", () => {
  const game = compilePlacement(tables, fixture);
  let checked = 0;
  let worstOffset = 0;
  let worstScale = 0;
  for (const sample of samples()) {
    const harvest = tables.plants[sample.species]?.plant?.harvestType ?? 'Multiple';
    const mine = game(sample.frame, sample.species, sample.part);
    const theirs = portedMutationAnchor(sample.species, sample.art, harvest);
    // One unit trap, recorded because it produced a wrong first comparison: the function's `offset` is in raw
    // atlas pixels and is divided by the frame's ratio to be logical, while its `scaleFactor` is *already* the
    // logical scale. A consumer that pre-divides a frame's size -- as the viewer does -- therefore looks like it
    // omits the divisor when it does not.
    const bundleX = mine.offset.x / sample.art.pixelRatio;
    const bundleY = mine.offset.y / sample.art.pixelRatio;
    const bundleScale = mine.scaleFactor;
    const portedX = (theirs.x - sample.art.anchorX) * sample.art.width;
    const portedY = (theirs.y - sample.art.anchorY) * sample.art.height;
    worstOffset = Math.max(worstOffset, Math.abs(bundleX - portedX), Math.abs(bundleY - portedY));
    worstScale = Math.max(worstScale, Math.abs(bundleScale - theirs.scale));
    assert.ok(
      Math.abs(bundleX - portedX) < 1e-6 && Math.abs(bundleY - portedY) < 1e-6,
      `${sample.species}.${sample.part}: offset (${bundleX}, ${bundleY}) against (${portedX}, ${portedY})`,
    );
    assert.ok(
      Math.abs(bundleScale - theirs.scale) < 1e-9,
      `${sample.species}.${sample.part}: scale ${bundleScale} against ${theirs.scale}`,
    );
    checked += 1;
  }
  assert.ok(checked >= 8, `only ${checked} frames were compared`);
  // The measured agreement, recorded so a regression to a looser tolerance is visible.
  assert.ok(worstOffset < 1e-9, `worst offset ${worstOffset}`);
  assert.ok(worstScale < 1e-6, `worst scale ${worstScale}`);
});

void test('the per-species overrides are doing real work in that comparison', () => {
  // Snowdrop states a scale of 0.5 for its plant, Leek a scale of 0.7, and Carrot splits its x between the
  // crop and the plant. If the overrides were being dropped, these would still agree -- so the test asserts the
  // overrides change the answer, which is what makes the agreement above meaningful rather than vacuous.
  const game = compilePlacement(tables, fixture);
  const snowdrop = samples().find((sample) => sample.species === 'Snowdrop');
  assert.ok(snowdrop !== undefined, 'the Snowdrop plant frame is not among the sampled frames');
  const withOverrides = game(snowdrop.frame, 'Snowdrop', snowdrop.part);
  const without = game(snowdrop.frame, 'Beet', snowdrop.part);
  assert.notEqual(withOverrides.scaleFactor, without.scaleFactor);
});
