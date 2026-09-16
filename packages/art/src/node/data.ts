/**
 * `packages/art/data/<version>.json`, read from the package that ships it.
 *
 * That file is the game's tables -- the mutation art and its wash, the per-species anchors, the plant table,
 * the over-set, the placement function -- and it is the one thing a consumer needs before `cropComposition`
 * or `mutationPlacement` can answer anything. `parseArtData` turns its text into the record; what was
 * missing was the text: the file is inside the package, and `package.json` publishes no path to it.
 *
 * The caller names a *version*, never a directory or a filename. `artDataVersions` is what the installed
 * package actually carries, and `readArtData` refuses a version that is not one of them -- so the path is
 * never built out of a caller's string, which is what would let `../../../etc/passwd` be read by a function
 * that looks like it reads game tables.
 *
 * ## Why this is on `./node` and not on `.` or `./bundle`
 *
 * It reads a file from disk, so it needs `node:fs`, which is exactly what those two entries promise not to
 * have (`tests/purity.test.ts` builds `dist/` and follows every specifier). Between the two entries that do
 * import something, this one is `./node`: `./source` exists for the network and this reads no network. The
 * four entries stay four, and the exports map keeps the one subpath a file reader lives on.
 */

import { readdirSync, readFileSync } from 'node:fs';

import { type ArtData, ArtDataError, parseArtData } from '../bundle/index.js';

/**
 * The directory the tables ship in, resolved from this module's own URL.
 *
 * `src/node/data.ts` and `dist/node/data.js` are both two directories below the package root, so the same
 * relative path lands on `<package>/data/` whether a caller runs the sources through a loader or the built
 * files, and whether the package is installed or checked out.
 */
const DATA_DIRECTORY = new URL('../../data/', import.meta.url);

/** The suffix every table file carries; the version is the name without it. */
const SUFFIX = '.json';

/**
 * The game versions the installed package ships tables for, in name order.
 *
 * A consumer that has a newer atlas than this package's tables -- or an older one -- can say so from here
 * instead of reading a directory it should not have to know, and `readArtData` answers the same list when it
 * refuses a version.
 */
export function artDataVersions(): readonly string[] {
  return readdirSync(DATA_DIRECTORY)
    .filter((name) => name.endsWith(SUFFIX))
    .map((name) => name.slice(0, -SUFFIX.length))
    .sort();
}

/**
 * One shipped version's tables, checked against the contract `parseArtData` states.
 *
 * A version this package does not ship is refused before any path is built, naming the versions it does --
 * `undefined`-by-readFileSync would report a missing file the caller cannot act on, and a caller-built path
 * is the one thing that must not reach `readFileSync`.
 */
export function readArtData(version: string): ArtData {
  const shipped = artDataVersions();
  if (!shipped.includes(version)) {
    throw new ArtDataError(
      `@mg.js/art ships no tables for game version ${JSON.stringify(version)}` +
        (shipped.length === 0 ? '; it ships no tables at all' : `; it ships ${shipped.join(', ')}`),
      version,
    );
  }
  return parseArtData(readFileSync(new URL(`../../data/${version}${SUFFIX}`, import.meta.url), 'utf8'));
}
