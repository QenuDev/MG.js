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
 *   - the washes the art is drawn through, from `mutationArt` and the mutation records: the game washes a
 *     crop through every mutation of the group that washes last, and the group order is the mutation table's
 *     own -- where each group first appears. `[]` when the crop wears nothing that washes, or wears a
 *     mutation the game hands to a shader.
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
  /**
   * Mutation name -> the record the game states it in, read for the group it is washed in.
   *
   * The group is the whole reason this is here: the game washes a crop through one *group*, not one mutation,
   * so a wash cannot be chosen from `mutationArt` alone. The records are the extractor's own table
   * (`bundle/tables.ts`'s `MutationRecord`), so the caller hands in the tables it already has.
   */
  readonly mutationRecords: Readonly<Record<string, { readonly group?: string | null }>>;
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
  /**
   * The washes the layer is drawn through, as `rgba(...)`, in the order the game mixes them.
   *
   * Only the art layer carries any. It is the game's *group*, not its top row: a crop wearing two mutations
   * of one group is washed by both, in the mutation table's own order (measured -- see `tests/crop-wash.test.ts`).
   * `[]` on a mutation's own picture, and on the art when nothing washes it or when it wears a material.
   */
  readonly washes: readonly string[];
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
 * The group a mutation is washed in: the record's own group, or the mutation itself when it states none.
 *
 * `mutationRecords` is the extractor's table, keyed by the mutation's name, and every mutation the shipped
 * tables state carries a group. A mutation whose record is missing, or whose group is unstated, is answered
 * as a group of its own rather than as a member of somebody else's: which group it belongs to is not stated,
 * and joining it to one would be a guess.
 */
function washGroupOf(tables: CropTables, name: string): string {
  const stated = tables.mutationRecords[name]?.group;
  return typeof stated === 'string' && stated !== '' ? stated : name;
}

/**
 * The groups the game washes colour in, in the order it washes them: where each first appears in the
 * mutation table.
 *
 * Read rather than written down, and the read is the table's own order (`mutationArt`'s `order`), not the
 * order the record's keys happen to be serialised in. For the committed tables that is `Growth` (`Rainbow`,
 * order 0), `Hydro` (`Wet`, order 2) and `Lunar` (`Dawnlit`, order 6), which is why a Beet wearing
 * `Ambershine` and `Thundercharged` keeps the Lunar wash although `Thundercharged` is the table's last row.
 * The other reading -- a group's place from its own highest row -- is ruled out by that same case: it would
 * put `Hydro` (row 10) after `Lunar` (row 9) and pick the wrong wash for all 3235 pixels.
 */
function washOrder(tables: CropTables): readonly string[] {
  const byTableOrder = Object.entries(tables.mutationArt).sort(
    ([, left], [, right]) => (left.order ?? 0) - (right.order ?? 0),
  );
  const groups: string[] = [];
  for (const [name] of byTableOrder) {
    const group = washGroupOf(tables, name);
    if (!groups.includes(group)) groups.push(group);
  }
  return groups;
}

/**
 * The washes a crop's own art is drawn through: every mutation of the group the game washes last.
 *
 * Read off the mutation tables rather than off the placements, as `material` is: the wash is the game's
 * colour, and it does not stop being mixed because the caller's atlas happens to hold no frame for the
 * mutation's picture. The order within the group is the table's (`order`), which is the order the game
 * mixes them in; `name` breaks a tie, which the committed table has none of.
 *
 * `[]` when the crop wears nothing that washes it, or wears a material -- a filter the game hands to a
 * shader, which is not a colour.
 */
function washesOf(tables: CropTables, mutations: readonly string[], material: boolean): readonly string[] {
  if (material) return [];
  const washing = mutations
    .map((name) => {
      const stated = tables.mutationArt[name];
      if (stated === undefined) return null;
      const drawing = mutationArt({ ...stated, name });
      if (drawing.material || drawing.tint === null) return null;
      return { name, tint: drawing.tint, order: stated.order ?? 0, group: washGroupOf(tables, name) };
    })
    .filter((one): one is { name: string; tint: string; order: number; group: string } => one !== null)
    .sort((left, right) => left.order - right.order || (left.name < right.name ? -1 : 1));
  if (washing.length === 0) return [];
  const order = washOrder(tables);
  const last = washing.reduce((top, one) => Math.max(top, order.indexOf(one.group)), -1);
  return washing.filter((one) => order.indexOf(one.group) === last).map((one) => one.tint);
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
  // The game washes the art with the group it washes last, and with every mutation of it: measured on a
  // clover wearing `Frozen` and `Thunderstruck` (both Hydro) the picture is the two washes stacked -- 119 of
  // 119 opaque pixels below the mutation pictures match that and 0 match either alone -- and on a Beet
  // wearing `Ambershine` and `Thundercharged` it is the Lunar colour alone, 3235 of 3235, where the table's
  // last row is the Hydro one. The answer is a list rather than one tint because a group can be more than one
  // mutation, and its length is the "how many washes" a consumer needs.
  const washes = washesOf(tables, mutations, material);

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
      washes: [],
      material: false,
    };
    (band < 0 ? under : above).push(layer);
  }

  // The art is the origin of the box and wears the washes: the consumer draws every decal first, then the art
  // washed in the game's own order, then everything above it (`server.mjs:611-615`).
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
    washes,
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
