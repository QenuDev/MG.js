/**
 * The game's own placement function, compiled so a test can run it.
 *
 * This is the point of extracting a *formula* rather than a value: the mathematics the model ports by hand
 * cannot be shown right by reading it, only by running both on the same real atlas frames. Two tests do that
 * -- `placement.test.ts` against the consumer's own port, and `mutation-placement.test.ts` against the port
 * the package publishes -- so the compiling lives here rather than in either of them.
 *
 * The bindings come from the roles the extractor resolved, not from names: an external the function indexes
 * with its own species parameter is the plant table, an external whose member it reads as a harvest type is
 * the enum, and anything else it reads is a host global. If a build renames either table, the roles still
 * resolve and these tests still run -- and if a build changes what the function does with them, they fail.
 */

import assert from 'node:assert/strict';
import type { ArtTables } from '../../src/bundle/tables.ts';
import type { RawFrame } from './consumer-oracle.ts';
import type { FixtureFrame } from './load-fixture.ts';

/** The compiled function: a frame as its chunk reads one, a species, and which part is being drawn. */
export type GamePlacement = (
  frame: RawFrame,
  species: string,
  part: string,
) => { offset: { x: number; y: number }; scaleFactor: number };

/** Compile the game's own placement function with the bindings its roles call for. */
export function compilePlacement(tables: ArtTables): GamePlacement {
  const placement = tables.placement;
  const plants: Record<string, { plant: { harvestType: string } }> = {};
  for (const [species, record] of Object.entries(tables.plants)) {
    const harvest = record.plant?.harvestType;
    plants[species] = {
      plant: { harvestType: harvest == null ? '' : (tables.harvestTypes[harvest] ?? harvest) },
    };
  }
  const bindingFor = (external: (typeof placement.externals)[number]): unknown => {
    if (external.role === 'plants') return plants;
    if (external.role === 'harvestTypes') return tables.harvestTypes;
    if (external.role === 'host') return (globalThis as Record<string, unknown>)[external.name];
    throw new Error(`the extractor could not resolve ${external.name}, so the function cannot be run`);
  };
  const names = placement.externals.map((external) => external.name);
  const values = placement.externals.map((external) => bindingFor(external));
  const preamble = [...Object.values(placement.declarations), placement.source].join('\n');
  assert.ok(placement.name !== null, 'the extracted function is anonymous, so it cannot be returned by name');
  const factory = new Function(...names, `${preamble}\nreturn ${placement.name};`) as (
    ...args: unknown[]
  ) => GamePlacement;
  return factory(...values);
}

/**
 * A frame as the game's own function reads one: the atlas's *raw* pixels, its anchor, and its ratio.
 *
 * The unit is the trap this helper exists to close. The function's `offset` comes back in the atlas's own
 * pixels -- a tomato crop's art is 184 of them and is drawn at 92 -- while a port that reads `frameBox` has
 * already divided by the ratio, so its offset is logical. The divisor is real and this is the one place it is
 * stated, rather than in each comparison that could quietly forget it.
 */
export function rawFrame(frame: FixtureFrame, pixelRatio: number): RawFrame {
  return {
    width: frame.sourceSize.w,
    height: frame.sourceSize.h,
    defaultAnchor: { x: frame.anchor.x, y: frame.anchor.y },
    sourcePixelRatio: pixelRatio,
  };
}
