/**
 * `@mg.js/art/source`: the game's assets, fetched, cached and revisioned.
 *
 * `common/catalog` fetches records; this fetches pictures and the numbers that describe them -- the game
 * version, the atlas packs and their frames, the atlas image itself -- and gives a caller one value that
 * says which revision of all of it is in hand, so a consumer can tell whether a redraw is needed.
 *
 * `fetch` and `now` are injected rather than reached for, so the tests here need no socket and a TTL is a
 * value a test can move. The timeout, byte cap and redirect policy come from `fetchJson` in
 * `@mg.js/common/catalog` rather than being re-grown.
 *
 * The fetchers themselves land with their offline fixture tests. What is here already is the revision, which
 * needs neither a socket nor a clock: it is arithmetic over the inputs a picture was composed from.
 */

export type { RevisionInput } from './revision.js';
export { contentRevision } from './revision.js';
