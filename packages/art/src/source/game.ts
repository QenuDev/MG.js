/**
 * The game's version: the one number every other URL in this entry is built from.
 *
 * Kept apart from the atlas because it is a different route with a different lifetime -- the version route
 * is a two-field answer that changes when the game is deployed, while a pack is a few hundred kilobytes
 * that changes when the art is repacked -- and because a caller that already has a catalogue has this
 * number from `common`'s `PlatformApiSource` and should not have to ask for it twice.
 */

import { HttpError } from '@mg.js/common/catalog';

import { type ArtSourceOptions, GAME_ORIGIN, json } from './http.js';
import { record } from './read.js';

/** The game's own version route. */
const VERSION_URL = `${GAME_ORIGIN}/platform/v1/version`;

/**
 * The art version the game states, as the string it states it in.
 *
 * `{"version":"1189"}` is the whole answer. The value is returned as the string it arrived as, because every
 * URL below is built by pasting it into a path and `1189` and `"1189"` are the same path either way -- but a
 * number would silently lose a leading zero if the game ever published one.
 *
 * A body that states no version is an {@link HttpError} rather than an empty string: an empty version builds
 * `/version//assets/manifest.json`, which 404s with a message about the manifest rather than about the route
 * that was actually wrong.
 */
export async function gameVersion(options: ArtSourceOptions = {}): Promise<string> {
  const payload = await json<unknown>(VERSION_URL, options);
  const version = record(payload)?.version;
  if (typeof version !== 'string' || version === '') {
    throw new HttpError(
      `The version route answered ${JSON.stringify(version)} rather than a version string.`,
      { url: VERSION_URL },
    );
  }
  return version;
}
