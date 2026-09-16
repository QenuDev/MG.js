/**
 * A plant's whole picture as a recipe: the pot, the platform it grows on, the body, the art its weather
 * brings out, the crops standing on it, and the part of the plant that draws in front of them.
 *
 * The order is the game's own, and it is the reason this is a function rather than a list: the bundle's
 * renderers each state the `zIndex` they are drawn at, and the ladder they form is what makes a plant look
 * like a plant -- a pot behind everything, a growing plant's platform under it, the plant's body, an overlay
 * over the body and under the crops, the crops themselves, and the front layer over every one of them.
 * Measured off the game's own chunk, each rung with the renderer that states it:
 *
 *   - `pot -20`                 `label:'PlanterPot', zIndex:-20`
 *   - `immature platform -10`   `label:'ImmatureSprite', zIndex:-10`, drawn while the plant is still growing
 *   - `body 0`                  `sortableChildren:!0, zIndex:0` on the plant body
 *   - `celestial overlay 1`     `label:'CelestialActiveOverlay', zIndex:1` and `CelestialActiveAnimation`
 *   - `mounted crop 2`          `this.displayObject.zIndex=2` on the crop mount
 *   - `topmost 100`             `label:'TopLayerFeature', zIndex:100`, the part drawn in front of the crops
 *
 * (`.logs/art-sync-spike/analysis/motion-tables.txt` §7 has the needle, the byte range and the enclosing
 * source of each of those.) The two rungs between the crops and the front layer -- a tall plant's mutation
 * decal at -1 and the over-mutations' icons at 10 -- are not here: a mutation is composed into the crop's own
 * picture by `cropComposition`, so the picture this file places is one layer where the game places three.
 *
 * What is *not* in the bundle's ladder and is read from the atlas instead is every geometry: a part is drawn
 * at its own frame's size about its own frame's anchor. The one art whose anchor is not the atlas's is the
 * pot -- the game's own pot sprite states `anchor:{x:.5, y:.2}` so its rim stands around the plant's foot,
 * while the atlas frame states the middle of its art -- and that default lives here, named.
 *
 * The names are arguments, not values: `immatureSprite`, `activeState.sprite` and `topmostLayerSprite` are
 * fields of a plant record the game states and this package's extracted table does not carry, so a caller
 * hands them in. So are the two things only a caller's clock can answer: whether the tile has matured, and
 * which weather is running. The recipe is a function of its arguments and reads no clock of its own.
 */

import type { CropRecipe } from './crop.js';
import { type ArtBox, extentOf, type FrameBox, type PlacedPart, REFERENCE_TILE_PX } from './model.js';

/** One art of a plant's picture, with the sprite path a caller fetches its pixels by. */
export interface PlantArtwork {
  /** The sprite path, in the game's own key form: what the atlas is keyed by. */
  readonly sprite: string;
  /** The frame the art is drawn at, which is where its size, ratio and anchor come from. */
  readonly frame: FrameBox;
}

/** The art a plant wears while the weather it names is the weather that is running. */
export interface PlantOverlay extends PlantArtwork {
  /** The weather this art asks for, as the game's record states it. */
  readonly weather: string;
}

/**
 * One species' art, as a picture of it needs them.
 *
 * Everything a recipe reads is a frame the caller resolved: the body's art, the picked crop's art, and the
 * three arts only some species state. A species that states none of the last three is three fields shorter,
 * not three empty frames.
 */
export interface PlantArt {
  /** The plant's own art: the body, or -- for a patch -- the art a crop of this species is drawn as. */
  readonly plant: PlantArtwork;
  /** The picked crop's art, which is what a crop standing on a plant of another species is drawn as. */
  readonly crop: PlantArtwork;
  /** The species' harvest type, which is what says whether it is grown as a patch. */
  readonly harvestType: string;
  /**
   * The platform a plant that has not matured is drawn on, or `null` when the species states none.
   *
   * The one art whose anchor is worth stating: the game's renderer puts it on the body's own container at
   * the origin and gives it no anchor of its own (`Js`: `new j({label:'immature-sprite', texture:r,
   * position:{x:0,y:0}, alpha:0})`), so this recipe draws it at its own frame's anchor -- which on the one
   * species in the game that states one is the same anchor as the body's, so nothing observable turns on
   * the reading today.
   */
  readonly immature?: PlantArtwork | null;
  /** The art worn while the weather it names runs, or `null` when the species states none. */
  readonly active?: PlantOverlay | null;
  /** The part of the plant drawn in front of the crops, or `null` when the species states none. */
  readonly topmost?: PlantArtwork | null;
}

/**
 * The pot every potted plant stands in.
 *
 * Its own anchor is the game's, not the atlas frame's: the game's pot sprite is constructed with
 * `anchor:{x:.5, y:.2}` so that the pot's rim stands around the plant's foot rather than the pot being
 * centred on it, and the frame the atlas states says only where the pot's art is. A caller that states its
 * own anchor is drawn by it.
 */
export interface PotArt extends PlantArtwork {
  readonly anchorX?: number;
  readonly anchorY?: number;
}

/** One crop standing on the plant, as the garden payload states where it is. */
export interface PlantCrop {
  readonly species: string;
  /** Its place across the tile, in tile units from the plant's own middle. */
  readonly x: number;
  /** Its place down the tile, in the same units. */
  readonly y: number;
  /** How far it is turned, in degrees, about the anchor its own frame names. */
  readonly rotation?: number;
  /** How large its art is drawn, growth and all. A crop that states none is drawn at its art's own size. */
  readonly scale?: number;
  /**
   * Where it stands in the stack of crops on one tile, which is the game's own crop `zIndex` without the
   * band the crops share: `Math.round((offset.y + 1) * 10)` on a patch and `2 + slotId` on a plant. The
   * caller's payload already carries it, and the layers come back sorted by it.
   */
  readonly depth?: number;
  /**
   * The picture the crop wears, from `cropComposition`, or `null` when it wears none.
   *
   * A composition is bigger than the crop: it holds the room a mutation's art reaches around it. The crop is
   * still laid out on its own frame and the composition hangs off it, which is what keeps a mutation from
   * changing how large a crop looks.
   */
  readonly composition?: CropRecipe | null;
}

/** What a plant's picture is of: the species, the crops on it, and the two things a caller's clock decides. */
export interface PlantScene {
  /** The plant table's key for the species standing on the tile. */
  readonly species: string;
  /** The crops standing on it, in the order the payload states. */
  readonly crops?: readonly PlantCrop[];
  /**
   * Whether the tile has matured.
   *
   * The game shows a plant's celestial arts and its front layer only once it has, and fades its growing
   * platform out as it does. The window itself is the caller's: it has the clock and the `maturedAt` the
   * payload carries, and this recipe is handed the answer rather than reading a clock of its own.
   */
  readonly mature: boolean;
  /** The weather running now, as the caller resolved it, or `null` when it cannot say. */
  readonly weather?: string | null;
}

/** Which part of a plant a layer is. */
export type PlantLayerKind = 'pot' | 'immature' | 'plant' | 'active' | 'crop' | 'topmost';

/**
 * One layer of a plant's picture: what to draw, where, and what it hangs.
 *
 * The rectangle is in the sprites' own pixels, in the space the plant's own anchor is the origin of -- the
 * point every part of a plant is pinned by. `turn` is degrees about the layer's own anchor, which for a crop
 * is the point it is pinned to its plant by rather than its middle. The box a layer's composition is drawn in
 * is `composition.box`, in the crop art's own pixels.
 */
export interface PlantLayer extends PlacedPart {
  readonly kind: PlantLayerKind;
  readonly sprite: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** The share of the layer's own width its turning is about. */
  readonly anchorX: number;
  /** The share of the layer's own height. */
  readonly anchorY: number;
  /** How far it is turned, in degrees. */
  readonly turn: number;
  /** The crop's own composed picture, on a crop layer that wears one, and `null` on every other layer. */
  readonly composition: CropRecipe | null;
}

/** A plant's whole picture: the box every part of it occupies, and the layers in the order they are drawn. */
export interface PlantRecipe {
  readonly species: string;
  readonly box: ArtBox;
  readonly layers: readonly PlantLayer[];
}

/** The pot's own anchor as the game states it, on the sprite its renderer constructs. */
const POT_ANCHOR_X = 0.5;
const POT_ANCHOR_Y = 0.2;

/** A crop that states no scale of its own is drawn at its art's own size, not at nothing. */
const UNIT_SCALE = 1;

/**
 * The picture of one plant: the pot, the platform it grows on, the body, the art its weather brings out, the
 * crops standing on it, and the part drawn in front of them -- in the game's own order.
 *
 * `art` is keyed by species and holds every species this picture needs, which is not only the one standing
 * on the tile: each crop's art is the *crop's* species, so a plant with another species growing on it needs
 * both. `pot` is the one pot sprite, or `null` for a plant in the ground.
 *
 * `null` when the tile's species states no art this caller holds, and `null` when there is nothing to draw:
 * a patch with no crops and no pot is a picture of nothing rather than an empty box.
 *
 * A single-harvest species is the patch: it has no body of its own, and its crops are drawn with *its* plant
 * art -- what stands on the tile is the plant, and the harvested crop's art is what it is picked as. Every
 * other species is drawn as a body with its crops' own art on top.
 */
export function plantPicture(
  scene: PlantScene,
  art: Readonly<Record<string, PlantArt | undefined>>,
  pot?: PotArt | null,
): PlantRecipe | null {
  const record = art[scene.species];
  const body = record?.plant;
  if (record === undefined || body === undefined || !(body.frame.width > 0) || !(body.frame.height > 0)) {
    return null;
  }

  const patch = record.harvestType === 'Single';
  const anchorX = body.frame.anchorX;
  const anchorY = body.frame.anchorY;
  const atPlant = (part: PlantArtwork, kind: PlantLayerKind): PlantLayer => ({
    kind,
    sprite: part.sprite,
    left: -anchorX * part.frame.width,
    top: -anchorY * part.frame.height,
    width: part.frame.width,
    height: part.frame.height,
    anchorX,
    anchorY,
    turn: 0,
    composition: null,
  });

  const layers: PlantLayer[] = [];
  // The platform a plant that has not grown up yet is drawn on, which the game fades out as it matures.
  if (!scene.mature && record.immature != null) {
    const part = record.immature;
    layers.push({
      kind: 'immature',
      sprite: part.sprite,
      left: -part.frame.anchorX * part.frame.width,
      top: -part.frame.anchorY * part.frame.height,
      width: part.frame.width,
      height: part.frame.height,
      anchorX: part.frame.anchorX,
      anchorY: part.frame.anchorY,
      turn: 0,
      composition: null,
    });
  }
  // A patch has no body: it is one crop after another with nothing standing in the middle of them.
  if (!patch) layers.push(atPlant(body, 'plant'));

  // The two arts a species may carry over its body, both drawn at the plant's own anchor and size because
  // the game copies the body's place onto each rather than giving either one of its own. The game shows
  // either only on a plant that has matured, whatever the weather is doing.
  const active =
    scene.mature && record.active != null && record.active.weather === scene.weather ? record.active : null;
  if (active !== null) layers.push(atPlant(active, 'active'));

  // A crop's place is measured from the plant's middle, which is the offset from the plant's anchor to the
  // middle of its art. A patch has no art to take a middle from, so its crops are measured from its anchor.
  const centreX = patch ? 0 : (0.5 - anchorX) * body.frame.width;
  const centreY = patch ? 0 : (0.5 - anchorY) * body.frame.height;
  const crops = (scene.crops ?? [])
    .map((crop) => ({ crop, layer: cropLayer(crop, art, centreX, centreY) }))
    .filter((one): one is { crop: PlantCrop; layer: PlantLayer } => one.layer !== null)
    .sort((left, right) => (left.crop.depth ?? 0) - (right.crop.depth ?? 0))
    .map((one) => one.layer);
  layers.push(...crops);

  // Last, so it is drawn over every crop: this is the part of the plant that stands in front of them.
  if (scene.mature && record.topmost != null) layers.push(atPlant(record.topmost, 'topmost'));

  if (layers.length === 0) return null;

  // The pot is drawn behind everything and is part of the picture's own extent: the assembled thing is as
  // big as both of them together, and the pot neither adds a share to the plant nor takes one away.
  if (pot != null) {
    layers.unshift({
      kind: 'pot',
      sprite: pot.sprite,
      left: -(pot.anchorX ?? POT_ANCHOR_X) * pot.frame.width,
      top: -(pot.anchorY ?? POT_ANCHOR_Y) * pot.frame.height,
      width: pot.frame.width,
      height: pot.frame.height,
      anchorX: pot.anchorX ?? POT_ANCHOR_X,
      anchorY: pot.anchorY ?? POT_ANCHOR_Y,
      turn: 0,
      composition: null,
    });
  }

  // Measured around the parts as they are drawn rather than where they were put, because a crop is turned
  // about its own anchor and reaches outside the rectangle it was laid out in: the picture has to hold all of
  // it, or the top of a fruit is cut off by the box it is put in.
  const extent = extentOf(layers);
  return {
    species: scene.species,
    box: { left: extent.minX, top: extent.minY, width: extent.width, height: extent.height },
    layers,
  };
}

/**
 * One crop's layer, or `null` when its species states no art this caller holds.
 *
 * The crop is laid out on its own frame -- the species' crop art, or its plant art when the crop's species
 * is a patch -- at the frame's own anchor, which for the crops that grow on a plant is the bottom of the
 * art: the fruit stands on the place the plant gives it rather than dangling below it. `composition` is
 * carried through rather than applied: the picture hangs off this frame, so a mutation adds pixels to the
 * edge of a crop and never moves or resizes it.
 */
function cropLayer(
  crop: PlantCrop,
  art: Readonly<Record<string, PlantArt | undefined>>,
  centreX: number,
  centreY: number,
): PlantLayer | null {
  const record = art[crop.species];
  if (record === undefined) return null;
  const patch = record.harvestType === 'Single';
  const part = patch ? record.plant : record.crop;
  const frame = part.frame;
  if (!(frame.width > 0) || !(frame.height > 0)) return null;
  const grown =
    typeof crop.scale === 'number' && Number.isFinite(crop.scale) && crop.scale >= 0
      ? crop.scale
      : UNIT_SCALE;
  const width = frame.width * grown;
  const height = frame.height * grown;
  const atX = centreX + crop.x * REFERENCE_TILE_PX;
  const atY = centreY + crop.y * REFERENCE_TILE_PX;
  return {
    kind: 'crop',
    sprite: part.sprite,
    left: atX - frame.anchorX * width,
    top: atY - frame.anchorY * height,
    width,
    height,
    anchorX: frame.anchorX,
    anchorY: frame.anchorY,
    turn: crop.rotation ?? 0,
    composition: crop.composition ?? null,
  };
}
