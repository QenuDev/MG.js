/**
 * A crop's picture as a recipe: the box it is drawn in, and the layers in the order they are drawn.
 *
 * The viewer's server rasterises a mutated crop (`garden-viewer/server.mjs:566-618`) because the page could
 * not place it the same way the server did, and a picture cannot be resized without fitting the crop inside
 * it to a size that is not the crop's. This file turns that composition inside out: it answers the same
 * question with a description rather than with pixels, so either side of a consumer can draw the picture and
 * both draw the same one.
 *
 * Four things are read, and each has one home:
 *
 *   - which art the crop is drawn from, and the harvest type that decides it, from the plant table. A patch
 *     is drawn as its species' *plant* art -- what stands on the tile is the plant, and the picked crop's
 *     art is what it is picked as -- and every other species is drawn as its crop's.
 *   - where a mutation's picture lands and how large it is, from `mutationPlacement`, which is arithmetic
 *     over the game's own anchor table, scale cap, reference tile and tall-decal multiplier.
 *   - the band each layer is drawn in, from `mutationStack`: a tall plant's decal pools under the art (the
 *     game's own `zIndex = -1`), an over-mutation's picture is drawn above every other (`zIndex = 10`), and
 *     the rest keep the mutation table's own order. The three numbers this file states are the consumer's
 *     raster bands for a flat canvas -- `-1`, `20 + order`, `30 + order` (`server.mjs:922-924`) -- and they
 *     are not published: the recipe is an ordered list, and the order is the whole answer.
 *   - the wash the art is drawn through, from `mutationArt`: `rgba(...)` for the mutation the crop wears, and
 *     `null` when it wears none or wears one the game hands to a shader.
 *
 * Nothing here is a transcribed game value. The tables arrive as the caller's own record (`ArtTables`
 * satisfies `CropTables` as it stands), the atlas arrives as the frames the caller resolved with
 * `resolveSprite`, and every remaining number is arithmetic over those two.
 */

import { type ArtBox, boxOf } from './model.js';
import { type MutationArtRecord, mutationArt, mutationStack } from './mutation.js';
import {
  type MutationArtwork,
  mutationAnchor,
  mutationPlacement,
  type PlacementTables,
} from './placement.js';
import { resolveSprite, type SpriteFrames } from './sprite.js';

/**
 * The member of the game's harvest-type enum that a plant grown as a patch is.
 *
 * The enum's member names are the game's (`harvestTypes` maps each to the literal it stands for, and
 * `data/1176.json` states `Single: 'Single'`), and the plant table states the same member per species. The
 * consumer spells it the same way (`server.mjs:572`), and it is what decides which of a species' two arts a
 * crop is drawn from.
 */
const PATCH_MEMBER = 'Single';

/** A mutation's art as the game's table states it, without the name its own table keys it by. */
export type StatedMutationArt = Omit<MutationArtRecord, 'name'>;

/**
 * A species' part as the plant table states it: its art, and the harvest type the plant block names.
 *
 * Wider than `placement.ts`'s own `PlantPart` by exactly the field a composition reads and a placement does
 * not: which art a crop is drawn from is the plant block's answer, and the extractor's records carry both
 * fields on the same part.
 */
export interface StatedPlantPart {
  readonly sprite?: string | null;
  readonly harvestType?: string | null;
}

/** A species as the plant table states it: the two parts a crop can be drawn from. */
export interface StatedSpeciesRecord {
  readonly plant?: StatedPlantPart | null;
  readonly crop?: StatedPlantPart | null;
}

/**
 * The tables a composition reads, in the shape `packages/art/data/<version>.json` states them.
 *
 * Every field is a field of that record narrowed to what a composition reads, so a caller can hand in the
 * whole `tables` object rather than a subset it built: the placement tables, the plant table read for its
 * harvest type rather than only for its art, the mutation art keyed by the mutation's own name, and the
 * game's over-set, which is what makes an over-mutation's band.
 */
export interface CropTables extends Omit<PlacementTables, 'plants'> {
  /** Per species, the two arts a crop is drawn from and the harvest type that chooses between them. */
  readonly plants: Readonly<Record<string, StatedSpeciesRecord>>;
  /** Mutation name -> the art the game states for it. The key is the name the over-set is stated in. */
  readonly mutationArt: Readonly<Record<string, StatedMutationArt>>;
  /** The mutations the game draws above the crop rather than in the table's own order. */
  readonly overMutations: readonly string[];
}

/** Which band of the picture a layer is: the crop's own art, or a mutation's picture. */
export type CropLayerKind = 'art' | 'mutation';

/**
 * One layer of a crop's picture: what to draw, and where, in the crop art's own pixels.
 *
 * `left`, `top`, `width` and `height` are in the art's own drawn pixels -- the same space `mutationPlacement`
 * answers in -- so a caller that draws at a different resolution multiplies them by `pixelRatio` rather than
 * reading a second set of numbers. The layer's sprite is the path the atlas is keyed by, which is what a
 * caller fetches the pixels with.
 */
export interface CropLayer {
  readonly kind: CropLayerKind;
  /** The sprite path the layer's pixels come from, in the game's own key form. */
  readonly sprite: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** True when the layer is the decal that pools under a tall plant rather than a picture over the art. */
  readonly decal: boolean;
  /** True when it is one of the game's over-mutations, drawn above every other mutation picture. */
  readonly over: boolean;
  /** The mutation's own name, or `null` on the art layer. */
  readonly mutation: string | null;
  /** The wash the art is drawn through, as `rgba(...)`, or `null`. Only the art layer carries one. */
  readonly tint: string | null;
  /** True when the crop wears a mutation the game hands to a shader, so no plain sprite makes this picture. */
  readonly material: boolean;
}

/** A crop's whole picture: the box it is drawn in, and the layers in the order they are drawn. */
export interface CropRecipe {
  readonly species: string;
  /** The art the crop itself is drawn from, in the game's own key form. */
  readonly art: string;
  /** The species' plant harvest type, which is what decided that art. */
  readonly harvestType: string;
  /** The box the picture is drawn in, in the art's own pixels: the art plus every mutation's reach. */
  readonly box: ArtBox;
  /** The resolution the picture is composed at, which is the crop art's own pixel ratio. */
  readonly pixelRatio: number;
  /** The layers, in the order they are drawn: decals, the art, then the pictures over it. */
  readonly layers: readonly CropLayer[];
}

/**
 * A mutation's art as a placement reads it: its own picture and, when the game states one, its ground decal.
 *
 * `null` when the atlas the caller handed in states neither art, because then there is nothing to draw and
 * therefore nothing to place. The consumer answers a missing sprite with a zero-sized picture
 * (`server.mjs:427-428`), which still reaches into the box at the mutation's own anchor; a recipe says
 * "nothing" instead, because a point at a size nobody has is not a picture.
 */
function artworkOf(record: MutationArtRecord, frames: SpriteFrames): MutationArtwork | null {
  const icon = record.iconSprite == null ? null : resolveSprite(frames, record.iconSprite);
  const ground = record.groundSprite == null ? null : resolveSprite(frames, record.groundSprite);
  const piece = icon ?? ground;
  if (piece === null) return null;
  return {
    sprite: record.iconSprite ?? null,
    width: piece.width,
    height: piece.height,
    anchorX: piece.anchorX,
    anchorY: piece.anchorY,
    ground: ground === null || record.groundSprite == null ? null : { id: record.groundSprite, ...ground },
  };
}

/**
 * The band a mutation's picture is drawn in, as the consumer rasterises it.
 *
 * Not published, because the recipe is an ordered list and its order is the answer. It is stated so the sort
 * has a name: a decal pools under the art, an over-mutation is drawn above the rest whatever the table says,
 * and everything else keeps the mutation table's own order.
 */
function bandOf(placed: { decal: boolean }, stack: { over: boolean; order: number }): number {
  if (stack.over) return 30 + stack.order;
  return placed.decal ? -1 : 20 + stack.order;
}

/**
 * The picture of one crop wearing some mutations: the box, and the layers in the order they are drawn.
 *
 * `species` is the plant table's key and `mutations` are the mutation names the crop carries; names the
 * table does not state, or whose art the atlas does not hold, are not pictures and are left out rather than
 * drawn as nothing. `mutationArt` is keyed by the mutation's own name, which is also the name the over-set
 * is stated in, so the band of each picture is read rather than guessed.
 *
 * `null` when the tables state no art for the species, or the atlas the caller handed in holds no frame for
 * it: with no art there is no box to draw the mutations into.
 *
 * The box is the art unioned with **every** mutation the tables state, not only the ones this crop wears --
 * which is the consumer's own choice (`server.mjs:466-469`) and what lets one picture be placed whatever a
 * crop turns out to carry. A crop wearing nothing is still a picture: one layer, its own art.
 */
export function cropComposition(
  species: string,
  mutations: readonly string[],
  tables: CropTables,
  frames: SpriteFrames,
): CropRecipe | null {
  const record = tables.plants[species];
  const harvestType = record?.plant?.harvestType ?? '';
  const part = harvestType === tables.harvestTypes[PATCH_MEMBER] ? record?.plant : record?.crop;
  const artPath = part?.sprite ?? null;
  if (artPath === null) return null;
  const art = resolveSprite(frames, artPath);
  if (art === null) return null;

  const anchor = mutationAnchor(species, artPath, art, harvestType, tables);
  const reach: ArtBox[] = [{ left: 0, top: 0, width: art.width, height: art.height }];
  const placeable = new Map<
    string,
    {
      readonly placed: ReturnType<typeof mutationPlacement>;
      readonly stack: ReturnType<typeof mutationStack>;
      readonly drawing: ReturnType<typeof mutationArt>;
    }
  >();
  for (const [name, stated] of Object.entries(tables.mutationArt)) {
    const mutation: MutationArtRecord = { ...stated, name };
    const artwork = artworkOf(mutation, frames);
    if (artwork === null) continue;
    const placed = mutationPlacement(artwork, anchor, art, tables);
    reach.push({ left: placed.left, top: placed.top, width: placed.width, height: placed.height });
    placeable.set(name, {
      placed,
      stack: mutationStack(mutation, tables.overMutations),
      drawing: mutationArt(mutation),
    });
  }

  const worn = mutations
    .map((name) => ({ name, one: placeable.get(name) }))
    .filter((pair): pair is { name: string; one: NonNullable<typeof pair.one> } => pair.one !== undefined);
  // A material is a filter the game hands to a shader rather than a colour: there is no wash to mix, and the
  // art it is worn over is not a picture this recipe can describe -- the consumer asks the API to compose
  // those two (`server.mjs:586-590`), and `material` says so rather than pretending a plain sprite is it.
  // Read off the mutation's own name rather than off the placements, because a material states no art at all
  // and is therefore never placed.
  const material = mutations.some((name) => {
    const stated = tables.mutationArt[name];
    return stated !== undefined && mutationArt({ ...stated, name }).material;
  });
  const washes = worn.filter((pair) => !pair.one.drawing.material && pair.one.drawing.tint !== null);
  // A crop carries at most one mutation of each group, and of the ones that wash it, the game's own table
  // order is what the consumer reaches by group (Growth, Hydro, Lunar) -- measured: a frosted and amber-lit
  // clover comes back as the amber wash alone (`server.mjs:645-652`, `server.test.mjs:228-248`), and the
  // Lunar mutations are the table's last four. `null` when nothing washes it, which is not a black wash.
  const highest = washes.reduce((top, pair) => Math.max(top, pair.one.stack.order), Number.NEGATIVE_INFINITY);
  const tint = material
    ? null
    : (washes.find((pair) => pair.one.stack.order === highest)?.one.drawing.tint ?? null);

  const under: CropLayer[] = [];
  const above: CropLayer[] = [];
  const banded = worn
    .map((pair) => ({ ...pair, band: bandOf(pair.one.placed, pair.one.stack) }))
    .sort((left, right) => left.band - right.band);
  for (const { name, one, band } of banded) {
    if (one.placed.sprite === null) continue;
    const layer: CropLayer = {
      kind: 'mutation',
      sprite: one.placed.sprite,
      left: one.placed.left,
      top: one.placed.top,
      width: one.placed.width,
      height: one.placed.height,
      decal: one.placed.decal,
      over: one.stack.over,
      mutation: name,
      tint: null,
      material: false,
    };
    (band < 0 ? under : above).push(layer);
  }

  // The art is the origin of the box and wears the wash: the consumer draws every decal first, then the art
  // washed once, then everything above it (`server.mjs:611-615`).
  const artLayer: CropLayer = {
    kind: 'art',
    sprite: artPath,
    left: 0,
    top: 0,
    width: art.width,
    height: art.height,
    decal: false,
    over: false,
    mutation: null,
    tint,
    material,
  };
  return {
    species,
    art: artPath,
    harvestType,
    box: boxOf(reach),
    pixelRatio: art.pixelRatio,
    layers: [...under, artLayer, ...above],
  };
}
