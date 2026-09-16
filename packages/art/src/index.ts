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
 * Nothing is exported yet: the model lands one commit at a time, each with the consumer test it has to
 * keep passing.
 */

export {};
