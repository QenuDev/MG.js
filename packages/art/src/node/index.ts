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
 * Nothing is exported yet -- the codec lands with the tests it moves from the viewer.
 */

export {};
