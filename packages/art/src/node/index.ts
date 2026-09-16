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
 * The PNG codec is exported here, moved from the viewer's own `png.mjs` with the tests that covered it. The
 * transcoder and the frame cropping land with the atlas work.
 */

export { decodePng, drawOver, encodePng, type PngImage, pngSize, scaled, washArt } from './png.js';
