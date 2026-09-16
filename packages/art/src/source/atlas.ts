/**
 * The game's atlas: the packs, the frames in them, and the image the frames are pixels in.
 *
 * Three things about the shape of this data decide the code below, and all three were measured rather than
 * assumed (`docs/mgjs-art-sources.md` §2, and the capture under `fixtures/atlas/`):
 *
 *   - The manifest names each atlas once per resolution. Only one of those pairs is a starting point, and
 *     the two must not be mixed, because a frame's rect is in the pixels of the image it belongs to.
 *   - The manifest names six atlas packs; the chain from the first reaches ten, because a pack names the
 *     rest of its own set in `meta.related_multi_packs` -- as bare filenames, resolved beside the pack that
 *     named them, which is the pack's own directory and not the asset root.
 *   - The image is not in the manifest at all: the `atlas-textures` bundle is empty, and the only pointer is
 *     the pack's own `meta.image`, a relative path that resolves beside `/version/`, not under it.
 */

import { HttpError } from '@mg.js/common/catalog';

import { type FrameBox, frameBox } from '../model.js';

import { type ArtSourceOptions, bytes, GAME_ORIGIN, json } from './http.js';
import { asArray, asString, record } from './read.js';

/** The alias the manifest names the sprite atlas by. The game's own string, not one this package made up. */
const SPRITE_ALIAS = 'atlases/sprites-0.json';

/**
 * The resolution the walk starts at, and the only one it walks.
 *
 * The manifest offers each alias at `resolution: 1` and `resolution: 2`, and `meta.related_multi_packs`
 * chains within a resolution: `sprites-2x-0` reaches the 2x set, `sprites-1x-0` the 1x one. A frame's rect
 * is stated in its own image's pixels, so a walk that took a 1x frame and a 2x image would place it at half
 * the size it should be. The consumer's loader picks 2 the same way (`garden-viewer/server.mjs`,
 * `sources.find((source) => source?.resolution === 2)`).
 */
const SPRITE_RESOLUTION = 2;

/**
 * The frame map `atlasPacks` answers, and the packs it was read from.
 *
 * The packs are here because `atlasImage` takes one and nothing else publishes it: the manifest names the
 * first pack as a path relative to `/version/<v>/assets/`, the rest are bare filenames inside the packs
 * themselves, and the walk that read them is the only thing that ever knew the resolved URLs. A caller that
 * wants the game's own pixels -- the whole reason `/source` exists -- would otherwise have to write
 * `atlases/sprites-2x-0.json` down and resolve it against an origin it does not own.
 *
 * Still a `ReadonlyMap`, so every caller that only wants frames is unchanged; `packs` is an own property and
 * not an entry, so the map still answers exactly the frames it did before.
 */
export interface AtlasPacks extends ReadonlyMap<string, FrameBox> {
  /**
   * The URL of every pack the walk read, in the order it read them.
   *
   * `packs[0]` is the pack the manifest itself names -- the resolution-2 sprite atlas the walk starts at, and
   * the one `atlasImage` is handed for the image those frames are drawn from. The rest are the siblings that
   * pack's `meta.related_multi_packs` reaches, each with its own `meta.image`: a frame from one of those is a
   * rect in *that* pack's image, which is why the URL is a list rather than one string.
   */
  readonly packs: readonly string[];
}

/**
 * Every frame of the sprite atlas, keyed as the game keys it, at resolution 2.
 *
 * The walk is a queue rather than a fixed list because the set is not in the manifest: pack 0 names packs
 * 1 to 3, and each of those names the others back, so the reachable set is what the game's own pointers say
 * it is. A pack read once is never read again, which is what makes the back-edges terminate.
 *
 * The values are `frameBox(frame)` -- the drawn size, the divisor and the anchor -- rather than the pack's
 * raw frame records. Everything else a frame states (`rotated`, `trimmed`, `spriteSourceSize`, the rect
 * itself) belongs to the codec, which is the entry that has to read pixels.
 *
 * The resolved URL of each pack is kept as it is walked (`AtlasPacks.packs`), because `atlasImage` takes a
 * pack URL and this walk is the only place the relative names in the manifest and in `related_multi_packs`
 * are ever turned into one.
 */
export async function atlasPacks(artVersion: string, options: ArtSourceOptions = {}): Promise<AtlasPacks> {
  if (artVersion === '') {
    throw new TypeError('atlasPacks needs the art version whose manifest it should read');
  }

  // One path style for both kinds of name: the manifest's src and a related pack's filename are both
  // relative to the asset directory, so both are kept that way and resolved only to make the request.
  const assets = `${GAME_ORIGIN}/version/${encodeURIComponent(artVersion)}/assets/`;
  const manifestUrl = `${assets}manifest.json`;
  const first = firstPackPath(await json<unknown>(manifestUrl, options), manifestUrl);

  const frames = new Map<string, FrameBox>();
  const packs: string[] = [];
  const walked = new Set<string>();
  const queue: string[] = [first];

  for (let index = 0; index < queue.length; index += 1) {
    const path = queue[index];
    if (path === undefined || walked.has(path)) continue;
    walked.add(path);

    const url = new URL(path, assets).href;
    packs.push(url);
    const pack = await json<unknown>(url, options);
    for (const [key, frame] of Object.entries(record(record(pack)?.frames) ?? {})) {
      frames.set(key, frameBox(frame));
    }

    // A related pack is a bare filename, so it is resolved beside the pack that named it. That is the
    // pack's own directory -- `atlases/` today, wherever the game moves them tomorrow -- and not the asset
    // root, which is where resolving the same bare name against the manifest would have put it.
    const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    for (const related of asArray(record(record(pack)?.meta)?.related_multi_packs)) {
      const name = asString(related);
      const beside = name === undefined ? undefined : `${directory}${name}`;
      if (beside !== undefined && !walked.has(beside) && !queue.includes(beside)) queue.push(beside);
    }
  }

  // An own property rather than an entry: `for...of`, `frames.get` and `frames.size` see the frames and
  // nothing else, so every caller that only wants them is unchanged.
  return Object.assign(frames, { packs: Object.freeze(packs) });
}

/**
 * A pack's atlas image -- the `.ktx2` its own `meta.image` points at -- as bytes.
 *
 * `pack` is the URL the pack's JSON is at, not its name and not its parsed body, because `meta.image` is
 * relative to the pack that states it the way `related_multi_packs` is: the string on the wire is
 * `../../../../runtime-assets/sprites-2x-0.<hash>.ktx2`, and only a base knows where the four `..` land.
 * It lands beside `/version/`, in `/runtime-assets/` (measured: 200, `image/ktx2`, 4,856,876 bytes,
 * `accept-ranges: bytes`).
 *
 * The whole image is read in one request. The measured `accept-ranges: bytes` is deliberately not used:
 * a range request would save nothing here -- the pack is transcoded whole, and a frame's pixels are
 * cropped out of the decoded image -- while making this function depend on a header, on a server honouring
 * it, and on the number of bytes a range happens to return.
 *
 * The resolved URL is refused unless it is still the game's own origin and under `/runtime-assets/`; a pack
 * that pointed elsewhere would otherwise turn reading game data into a request to a host nobody named.
 */
export async function atlasImage(pack: string | URL, options: ArtSourceOptions = {}): Promise<Uint8Array> {
  const packUrl = new URL(pack);
  const payload = await json<unknown>(packUrl.href, options);
  const stated = asString(record(record(payload)?.meta)?.image);
  if (stated === undefined) {
    throw new HttpError(`The pack at ${packUrl.href} states no meta.image, so it names no atlas to read.`, {
      url: packUrl.href,
    });
  }

  const image = new URL(stated, packUrl);
  if (image.origin !== GAME_ORIGIN || !image.pathname.startsWith('/runtime-assets/')) {
    throw new HttpError(
      `The pack at ${packUrl.href} points at ${image.href}, which is not under ${GAME_ORIGIN}/runtime-assets/.`,
      { url: packUrl.href },
    );
  }
  return bytes(image.href, options);
}

/**
 * The resolution-2 sprite pack the manifest names, as the path the manifest states it by.
 *
 * The manifest's `src` is relative to the asset directory, so the path is returned exactly as written and
 * resolved by the caller: `atlases/sprites-2x-0.json`. A manifest that names the alias without a
 * resolution-2 source is refused rather than falling back to 1x, because the fallback would be a frame map
 * at half scale that looks exactly like a correct one.
 */
function firstPackPath(manifest: unknown, manifestUrl: string): string {
  const named: string[] = [];
  for (const bundle of asArray(record(manifest)?.bundles)) {
    for (const asset of asArray(record(bundle)?.assets)) {
      const aliases = asArray(record(asset)?.alias).map(asString);
      if (!aliases.includes(SPRITE_ALIAS)) continue;
      for (const source of asArray(record(asset)?.src)) {
        const src = asString(record(source)?.src);
        if (src === undefined) continue;
        named.push(src);
        if (record(source)?.resolution === SPRITE_RESOLUTION) return src;
      }
    }
  }
  throw new HttpError(
    `The manifest at ${manifestUrl} names no ${SPRITE_ALIAS} asset at resolution ${SPRITE_RESOLUTION}` +
      (named.length > 0 ? `; it names ${named.join(', ')}.` : '; it names no atlas source at all.'),
    { url: manifestUrl },
  );
}
