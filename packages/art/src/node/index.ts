/**
 * `@mg.js/art/node`: pixels, and the tables that ship with them.
 *
 * Four jobs, all of which need something the pure entry must not have:
 *
 *   - KTX2 to RGBA, through the Basis Universal transcoder that ships in `assets/`. The game publishes its
 *     atlas as KTX2 with Zstandard supercompression and UASTC payload, which is not a format Node reads.
 *   - frame cropping: an atlas frame's rect out of the decoded atlas, un-rotated and padded back to its
 *     source size when the frame is trimmed.
 *   - the PNG codec, so a consumer can decode a sprite, composite layers and encode a result without
 *     reaching for a native image library. It moved here from the viewer's own `png.mjs`, with the tests
 *     that covered it.
 *   - the tables in `data/<version>.json`: `readArtData` reads the file the package carries and
 *     `artDataVersions` says which versions it carries. That file is the game's own numbers, and a consumer
 *     that has the atlas but not the tables can draw nothing.
 *
 * `node:zlib` and `node:fs` are the reason this is a separate entry rather than part of the model — and
 * they are not the whole list: the vendored Basis transcoder also reaches `node:module`, `node:path` and
 * `node:url`. An earlier version of this comment named the two and read as an enumeration.
 */

export { artDataVersions, readArtData } from './data.js';
export {
  type AtlasFrame,
  type DecodedAtlas,
  decodeKtx2,
  decodeKtx2File,
  type FrameRect,
  frameBytes,
  frameSize,
  type Ktx2Header,
  type Ktx2Level,
  readKtx2Header,
} from './ktx2.js';
export { decodePng, drawOver, encodePng, type PngImage, pngSize, scaled, washArt } from './png.js';
