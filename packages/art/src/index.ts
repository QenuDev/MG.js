/**
 * `@mg.js/art`: what the library knows about drawing a garden.
 *
 * Values in, values out. This entry imports nothing at runtime -- no `node:`, no DOM globals, no other
 * package -- which is what lets a browser load the built file directly, with no bundler, and what
 * `tests/purity.test.ts` asserts against `dist/` rather than trusting this comment.
 *
 * The other three entries exist because they do need something this one must not have:
 *
 *   - `@mg.js/art/bundle`  predicates over a parsed game chunk. Still imports nothing: the parser is the
 *                          caller's (the sync tool uses TypeScript, which this monorepo already has).
 *   - `@mg.js/art/source`  the network: the game's version, its atlas packs and their frames, the atlas
 *                          image, and the caches. Imports `@mg.js/common/catalog`.
 *   - `@mg.js/art/node`    the pixels: KTX2 to RGBA through the vendored Basis transcoder, frame cropping
 *                          and the PNG codec. Imports `node:zlib` and `node:fs`.
 *
 * The model lands one commit at a time, each with the consumer test it has to keep passing. `model.ts` holds
 * a frame's drawn size and anchor and the box arithmetic a picture's parts are placed with; `mutation.ts`
 * holds what a mutation draws with -- its wash, its icon, the band it stacks in and the art it lays on a tall
 * plant -- with the mutation record as an argument rather than as a table written down here; `placement.ts`
 * holds where a mutation lands on a species' own art and how large it is drawn, with the game's own tables as
 * an argument for the same reason; `sprite.ts` holds which sprite the game draws a thing from, and turns that
 * name into the frame the atlas states for it.
 */

export type {
  CropLayer,
  CropLayerKind,
  CropRecipe,
  CropTables,
  StatedMutationArt,
  StatedPlantPart,
  StatedSpeciesRecord,
} from './crop.js';
export { cropComposition } from './crop.js';
export type {
  ArtBox,
  AtlasFrame,
  FrameBox,
  PartExtent,
  PartPlacement,
  PictureFit,
  PictureSpace,
  PlacedPart,
} from './model.js';
export {
  boxOf,
  extentOf,
  fitPicture,
  frameBox,
  PLACEMENT_ANCHOR_Y,
  placePart,
  REFERENCE_TILE_PX,
} from './model.js';
export type {
  MutationArtRecord,
  MutationDrawing,
  MutationStack,
  MutationTint,
  OverlayArt,
} from './mutation.js';
export { mutationArt, mutationOverlayArt, mutationStack } from './mutation.js';
export type {
  DecalArtwork,
  DisplayFlags,
  MutationAnchor,
  MutationArtwork,
  MutationPlacement,
  PlacementTables,
  PlantPart,
  ScaleCaps,
  SpeciesRecord,
  StatedAnchor,
} from './placement.js';
export { mutationAnchor, mutationPlacement } from './placement.js';
export type { SpriteFrames, SpriteNameMap } from './sprite.js';
export { resolveSprite, spriteName } from './sprite.js';
