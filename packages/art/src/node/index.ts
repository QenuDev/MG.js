/**
 * `@mg.js/art/node`: pixels.
 *
 * Three jobs, all of which need something the pure entry must not have:
 *
 *   - KTX2 to RGBA, through the Basis Universal transcoder that ships in `assets/`. The game publishes its
 *     atlas as KTX2 with Zstandard supercompression and UASTC payload, which is not a format Node reads.
 *   - frame cropping: an atlas frame's rect out of the decoded atlas.
 *   - the PNG codec, so a consumer can decode a sprite, composite layers and encode a result without
 *     reaching for a native image library.
 *
 * `node:zlib` and `node:fs` are the whole reason this is a separate entry rather than part of the model.
 *
 * The codec has landed. The PNG half is not here yet: it comes with the commit that moves it out of the
 * viewer, with the viewer's tests as the proof the move was faithful.
 */

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
