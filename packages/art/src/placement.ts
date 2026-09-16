/**
 * Where a mutation's art lands on a species' own art, and how large it is drawn.
 *
 * A mutation is an effect rather than a badge: a clover's frost has to land on its leaves, and the leaves are
 * not the middle of the art. So the game states, per species, a fraction of the crop's art that a mutation
 * centres on, sizes the mutation by the species' art against the reference tile, caps that, and multiplies it
 * again when the plant is one the game draws tall.
 *
 * None of those numbers is written here. `anchors`, `plants`, `harvestTypes`, `displayFlags` and `scale`
 * arrive as the `tables` argument, in the shape `packages/art/data/<version>.json` states them, and every one
 * of them has a row in `docs/art-provenance.md` naming the predicate that found it and the game's own
 * declaration it was read from. The constants that remain are numbers the game's own function states, and each
 * says which declared number it is.
 *
 * Why the tables are an argument rather than a table written down: this entry imports nothing at runtime
 * (`tests/purity.test.ts` holds the built file to that), so it cannot read the data file, and values copied
 * out of the bundle are the transcribed constants the extractor exists to remove. `mutationStack` takes the
 * game's over-set as an argument for the same reason, and the plan's own signature for these two functions
 * gained the same argument -- the four names in front of it are what it is called with, and the shape it
 * reads is what a caller already has in hand after `art:sync`.
 *
 * The consumer's port of this arithmetic is `garden-viewer/server.mjs:914-931` (`mutationPlacement`) and
 * `:940-953` (`mutationAnchor`), and its measured values are the tests beside this file. The game's own
 * function is *also* in hand -- `data/1176.json` carries the assembled source of the function that does this
 * -- so `tests/mutation-placement.test.ts` runs both on the captured atlas frames and compares them; that is
 * what says the port is faithful rather than merely different.
 */

import { type FrameBox, PLACEMENT_ANCHOR_Y } from './model.js';

/** A number the game's anchor table states for a species, or the numbers it states per part for one. */
export type StatedAnchor = number | { readonly [part: string]: number | StatedAnchor };

/** One part of a species as the plant table states it. Only the art is read here. */
export interface PlantPart {
  readonly sprite?: string | null;
}

/** A species as the plant table states it: the part whose art is the plant's own is what `plant` names. */
export interface SpeciesRecord {
  readonly plant?: PlantPart | null;
}

/** The display flags the table states per sprite. Only the tall flag turns a placement. */
export interface DisplayFlags {
  readonly isTallPlant?: boolean;
}

/** The game's own numbers for how large a mutation's art is drawn: the cap, the tile, and the decal's own. */
export interface ScaleCaps {
  readonly cap: number;
  readonly referenceTilePx: number;
  readonly tallDecalMultiplier: number;
}

/**
 * The tables a placement reads, in the shape `packages/art/data/<version>.json` states them.
 *
 * A caller hands in the record it holds rather than a subset it built: the data file's `tables` satisfies
 * this as it stands, because every field here is one of that record's own fields narrowed to the part a
 * placement reads. Nothing in this file writes one of them down.
 */
export interface PlacementTables {
  /** Per species, where a mutation centres on the art: a number, or numbers per part. */
  readonly anchors: Readonly<Record<string, StatedAnchor>>;
  /** Per species, the plant's own art, which is what says which part an art handed in is drawn as. */
  readonly plants: Readonly<Record<string, SpeciesRecord>>;
  /** Member -> the literal the game's harvest-type enum assigns it. */
  readonly harvestTypes: Readonly<Record<string, string>>;
  /** Per sprite path, the game's display flags. */
  readonly displayFlags: Readonly<Record<string, DisplayFlags>>;
  /** The cap, the tile it is taken against, and the multiplier a tall plant's decal is drawn at. */
  readonly scale: ScaleCaps;
}

/**
 * How much taller than wide an art has to be for the game to call it a tall patch.
 *
 * The game's own placement function states it once, as `height > width * 1.5`, and it changes which vertical
 * fallback a single-harvest species gets. It is not the display flag -- the table of which plants are *drawn*
 * tall -- which answers a different question and can answer it differently: `FavaBean` is tall art the table
 * does not draw tall, and `StarweaverPlatform` is drawn tall art the aspect test would not call tall.
 */
const TALL_ART_ASPECT = 1.5;

/**
 * The member of the game's harvest-type enum that a plant grown as a patch is.
 *
 * The literal it stands for is read from the `harvestTypes` table rather than written here
 * (`data/1176.json` states `Single: 'Single'`), and the plant table states the same value per species
 * (`plants.Clover.plant.harvestType`), which is what a caller passes as `harvestType`.
 */
const PATCH_MEMBER = 'Single';

/** The factor an art is drawn at when the species states no scale of its own. */
const UNIT_SCALE = 1;

/** One field out of a stated anchor value, or `undefined` when the value is a bare number. */
function fieldOf(stated: StatedAnchor | undefined, field: string): number | StatedAnchor | undefined {
  if (stated === null || typeof stated !== 'object') return undefined;
  return stated[field];
}

/**
 * One number the anchor table states, read for one part.
 *
 * The table states either a number (`Rose: {y: 0.16}`) or a number per part (`Leek: {y: {plant: 0.55}}` for
 * the plant and the picked crop), and this is the game's own reader of it: a number is the number, an object
 * is indexed by the part, and anything else is `undefined` so the caller's own fallback stands. A value that
 * is neither -- the table states nothing for this species, or states an object where a number belongs -- is
 * `undefined` rather than a number this package made up.
 */
function pick(stated: StatedAnchor | undefined, field: string, part: string): number | undefined {
  const value = fieldOf(stated, field);
  if (typeof value === 'number') return value;
  const perPart = fieldOf(value, part);
  return typeof perPart === 'number' ? perPart : undefined;
}

/**
 * Which of a species' two arts the art handed in is drawn as: the plant's own, or the crop's.
 *
 * The game chooses the art and the part in one expression -- the plant's art is the plant part only when the
 * species is grown as a single-harvest patch, and every other art is the crop's -- so the art alone says which
 * of a species' per-part numbers apply. The three species that state per-part numbers (`Carrot`,
 * `Dawnbreaker`, `Leek`) are all single-harvest and each states a different art for its plant and its crop,
 * which is why one art is enough to tell them apart. A species whose plant and crop are the same art
 * (`Clover`, `Snowdrop`) is read as its plant, which is the art a garden draws it as; the two parts agree on
 * every such species today, so the reading costs nothing and names the thing being drawn.
 */
function partOf(species: string, artName: string, single: boolean, tables: PlacementTables): string {
  const plantArt = tables.plants[species]?.plant?.sprite;
  return single && plantArt !== undefined && plantArt !== null && plantArt === artName ? 'plant' : 'crop';
}

/** The point of a species' art a mutation centres on, and the scale it is drawn at. */
export interface MutationAnchor {
  /** The share of the crop art's width the mutation's own anchor is put at. */
  readonly x: number;
  /** The share of the crop art's height, which is the share the game's own default is stated in. */
  readonly y: number;
  /** The factor the mutation's art is drawn at, before a tall plant's decal multiplier. */
  readonly scale: number;
  /** Whether the art is one the game draws tall, which is what makes a tall plant's mutation a decal. */
  readonly tall: boolean;
}

/**
 * Where a mutation's picture goes on one species' crop art, and how large it is drawn.
 *
 * `art` is the frame the crop itself is drawn from -- what `frameBox` returns for its atlas frame -- and every
 * number follows from it: the game centres the mutation on a stated fraction of that art rather than on the
 * art's middle, and sizes it by the smaller side of that art against the reference tile, capped so a large
 * crop's effect does not grow with it.
 *
 * `artName` is the art's own name in the game's key form, `sprite/<category>/<Name>`: the atlas is keyed by it
 * and the display table is keyed by it, and it is also what says which part this art is. `harvestType` is the
 * species' own plant harvest type (`plants.<species>.plant.harvestType`), which decides both the vertical
 * fallback and the part.
 */
export function mutationAnchor(
  species: string,
  artName: string,
  art: FrameBox,
  harvestType: string,
  tables: PlacementTables,
): MutationAnchor {
  const stated = tables.anchors[species];
  const single = harvestType === tables.harvestTypes[PATCH_MEMBER];
  const part = partOf(species, artName, single, tables);
  // Across, a species that states nothing is drawn on the art's own anchor -- the point a placement refers
  // to -- and the three species that state an across value for one part only (`Carrot`) fall back here too.
  const x = pick(stated, 'x', part) ?? art.anchorX;
  // Down, a single-harvest patch whose art is tall hangs from its own anchor; everything else lands at the
  // game's own 0.4, which is the model's `PLACEMENT_ANCHOR_Y` and not a value this file chose.
  const short = single && art.height > art.width * TALL_ART_ASPECT ? art.anchorY : PLACEMENT_ANCHOR_Y;
  const y = pick(stated, 'y', part) ?? short;
  const smaller = Math.min(art.width, art.height);
  const scale =
    Math.min(tables.scale.cap, smaller / tables.scale.referenceTilePx) *
    (pick(stated, 'scale', part) ?? UNIT_SCALE);
  return { x, y, scale, tall: tables.displayFlags[artName]?.isTallPlant === true };
}

/** The ground art a tall plant's mutation is drawn as, with the name a caller fetches its pixels by. */
export interface DecalArtwork {
  /** The art the mutation's `groundSprite` names, in whatever form the caller fetches it by. */
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly anchorX: number;
  readonly anchorY: number;
}

/** A mutation's own art, resolved to the frame it is drawn from, and the decal a tall plant gets instead. */
export interface MutationArtwork {
  /**
   * The art the mutation's `iconSprite` names, which is not always the mutation's own: `Ambershine` draws
   * `sprite/mutation/Amberlit`, and the table is what says so.
   */
  readonly sprite: string | null;
  readonly width: number;
  readonly height: number;
  /** Which point of the art is put on the crop: the atlas anchor, not its middle. */
  readonly anchorX: number;
  readonly anchorY: number;
  /** The decal that pools at a tall plant's foot, or `null` when the mutation states none. */
  readonly ground?: DecalArtwork | null;
}

/** The rectangle a mutation's art is drawn into, in the crop art's own pixels. */
export interface MutationPlacement {
  /** The art's own name, which is what a caller fetches the pixels by. */
  readonly sprite: string | null;
  /** True when the art is the decal that pools under a tall plant rather than the mutation's own art. */
  readonly decal: boolean;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where one mutation's picture lands on a crop, in the crop art's own pixels.
 *
 * `icon` is what `mutationAnchor` answered for the species; `mutation` is the mutation's own art and, when it
 * states one, the decal a tall plant gets in its place, both already resolved to their frames against the
 * atlas the caller holds. A tall plant gets that decal at the multiplier the `scale` table states instead of
 * the mutation's own art, and a mutation that states no decal keeps its own.
 *
 * What is *not* here is the draw order: which band the picture sits in -- under the crop, over it, at the
 * game's own over-mutation z-index -- is `mutationStack`'s answer, from the game's own stack table, and the
 * consumer composes the two into the raster order its own composed picture needs. The one thing this function
 * says about order is `decal`, because that is a property of the rectangle: the decal pools at the foot
 * instead of landing on the art.
 */
export function mutationPlacement(
  mutation: MutationArtwork,
  icon: MutationAnchor,
  art: FrameBox,
  tables: PlacementTables,
): MutationPlacement {
  const ground = mutation.ground ?? null;
  const decal = icon.tall && ground !== null;
  const piece: MutationArtwork | DecalArtwork = decal && ground !== null ? ground : mutation;
  const scale = icon.scale * (icon.tall ? tables.scale.tallDecalMultiplier : UNIT_SCALE);
  const width = piece.width * scale;
  const height = piece.height * scale;
  return {
    sprite: decal && ground !== null ? ground.id : mutation.sprite,
    decal,
    left: icon.x * art.width - piece.anchorX * width,
    top: icon.y * art.height - piece.anchorY * height,
    width,
    height,
  };
}
