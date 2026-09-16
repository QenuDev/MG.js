/**
 * Rebuild `packages/art/fixtures/crop-wash/` from the live game and the live mirror.
 *
 * This is not a test and it is not shipped (`package.json`'s `files` carries neither `fixtures/` nor this
 * file). It is the recorded recipe for the pixels `crop-wash.test.ts` reads offline: a reader can check what
 * each file is and regenerate it after a game version moves. It is never run by `npm test`.
 *
 * What it writes:
 *
 *   - `frames.json`            the atlas frames of the arts the three recipes place, exactly as the game's
 *                              own pack serves them, keyed by the game's key form.
 *   - `<case>.art.png`         the plain sprite the crop's own art is drawn from, at the art's own
 *                              resolution, as the community mirror serves it.
 *   - `<case>.composed.png`    the mirror's own composition of that art wearing the case's mutations
 *                              (`/assets/sprites/composed`). This is the outside answer the recipe is
 *                              compared against: it is the mirror's implementation of the game's wash rule,
 *                              not this package's, which is what makes the comparison evidence.
 *   - `provenance.json`        every URL, byte count and digest behind the above, the art version they were
 *                              read at, and the two facts the comparison needs: that the composed picture is
 *                              the art's own size (a mirror composition fitted to another size could not be
 *                              compared pixel for pixel) and that its pixels are the game's PNG.
 *
 * Usage:
 *   node fixtures/capture-crop-wash.mjs
 *   npx biome check --write fixtures/crop-wash
 *
 * The second line is not optional: the JSON here is `JSON.stringify`'s, and `npm run lint` is `biome check .`
 * over the whole tree, so a regenerated fixture is unformatted until biome has seen it. `provenance.json` is
 * the one that shows it, because its arrays of scalars are short enough that biome inlines them.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, 'crop-wash');

const GAME = 'https://magicgarden.gg';
const COMMUNITY = 'https://mg-api.ariedam.fr';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0';

/**
 * The three cases the recipe is measured on.
 *
 * Each is a species and a pair of mutations, and each is a pair the old table-order rule answered wrongly
 * or cannot answer: `Frozen` and `Thunderstruck` are both `Hydro` and are washed together, while
 * `Ambershine`/`Dawnlit` (`Lunar`) beat `Thundercharged` (`Hydro`) only when the winner is the group that
 * washes last rather than the table's last row.
 */
const CASES = [
  { name: 'clover-frozen-thunderstruck', species: 'Clover', mutations: ['Frozen', 'Thunderstruck'] },
  { name: 'beet-ambershine-thundercharged', species: 'Beet', mutations: ['Ambershine', 'Thundercharged'] },
  { name: 'cacao-dawnlit-thundercharged', species: 'Cacao', mutations: ['Dawnlit', 'Thundercharged'] },
];

/** The species whose own arts the recipes read: the three above, for the plant/crop choice. */
const SPECIES_READ = ['Clover', 'Beet', 'Cacao'];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fetchBytes(url) {
  const response = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function isPng(bytes) {
  return bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

/** The art version the mirror's sprite index states, by the `?v=` every sprite URL carries. */
async function artVersion() {
  const index = JSON.parse((await fetchBytes(`${COMMUNITY}/assets/sprites`)).toString('utf8'));
  const found = new Set();
  for (const category of Object.values(index.sprites ?? {})) {
    for (const sprite of Array.isArray(category) ? category : []) {
      const url = typeof sprite === 'string' ? sprite : sprite?.url;
      const version = typeof url === 'string' ? new URL(url).searchParams.get('v') : null;
      if (version !== null && version !== '') found.add(version);
    }
  }
  if (found.size !== 1) throw new Error(`the sprite index states ${found.size} versions: ${[...found]}`);
  return [...found][0];
}

/** Every frame of the atlas at one version, walked the way the mirror's loader walks it. */
async function atlasFrames(version) {
  const at = (path) => `${GAME}/version/${version}/assets/${path}`;
  const manifest = JSON.parse((await fetchBytes(at('manifest.json'))).toString('utf8'));
  let first = null;
  for (const bundle of manifest.bundles ?? []) {
    for (const asset of bundle.assets ?? []) {
      const aliases = Array.isArray(asset.alias) ? asset.alias : [asset.alias];
      if (!aliases.includes('atlases/sprites-0.json')) continue;
      const sources = Array.isArray(asset.src) ? asset.src : [asset.src];
      first = (sources.find((source) => source?.resolution === 2) ?? sources[0])?.src ?? null;
    }
  }
  if (first === null) throw new Error('the manifest states no sprite atlas');

  const packs = [first];
  const frames = {};
  for (let index = 0; index < packs.length; index += 1) {
    const pack = JSON.parse((await fetchBytes(at(packs[index]))).toString('utf8'));
    Object.assign(frames, pack.frames ?? {});
    const directory = packs[index].includes('/')
      ? `${packs[index].slice(0, packs[index].lastIndexOf('/'))}/`
      : '';
    for (const related of pack.meta?.related_multi_packs ?? []) {
      const path = `${directory}${related}`;
      if (!packs.includes(path)) packs.push(path);
    }
  }
  return frames;
}

/** The sprite path a species' crop is drawn from: its plant art on a patch, its crop art otherwise. */
function artPathFor(tables, species) {
  const record = tables.plants[species];
  if (record === undefined) throw new Error(`the tables state no species ${species}`);
  const patch = record.plant?.harvestType === tables.harvestTypes.Single;
  const part = patch ? record.plant : record.crop;
  if (part?.sprite === undefined || part.sprite === null) {
    throw new Error(`the tables state no art for ${species}`);
  }
  return part.sprite;
}

/** The sprite paths the recipes reach: every mutation's art and ground, and the three species' parts. */
function neededKeys(tables) {
  const keys = new Set();
  for (const art of Object.values(tables.mutationArt)) {
    if (art?.iconSprite) keys.add(art.iconSprite);
    if (art?.groundSprite) keys.add(art.groundSprite);
  }
  for (const name of SPECIES_READ) {
    const species = tables.plants[name];
    for (const part of ['plant', 'crop']) {
      const sprite = species?.[part]?.sprite;
      if (sprite) keys.add(sprite);
    }
  }
  return [...keys].sort();
}

const data = JSON.parse(readFileSync(resolve(HERE, '../data/1176.json'), 'utf8'));
const version = await artVersion();
const frames = await atlasFrames(version);
const keys = neededKeys(data.tables);
const missing = keys.filter((key) => frames[key] === undefined);
if (missing.length > 0) throw new Error(`the atlas states no frame for: ${missing.join(', ')}`);

mkdirSync(OUT, { recursive: true });
writeFileSync(
  resolve(OUT, 'frames.json'),
  `${JSON.stringify(
    {
      note: 'The atlas frames the crop wash cases are drawn with, as the game served them. Written by capture-crop-wash.mjs; the tests read this file and never the network.',
      sources: {
        origin: GAME,
        artVersion: version,
        manifest: `${GAME}/version/${version}/assets/manifest.json`,
      },
      frames: Object.fromEntries(keys.map((key) => [key, frames[key]])),
    },
    null,
    2,
  )}\n`,
);

const pictures = {};
for (const one of CASES) {
  const art = artPathFor(data.tables, one.species);
  const composedUrl = `${COMMUNITY}/assets/sprites/composed?key=${encodeURIComponent(art)}&mutations=${encodeURIComponent(one.mutations.join(','))}`;
  const artUrl = `${COMMUNITY}/assets/sprites/${art.replace('sprite/plant/', 'plants/')}.png`;
  const composed = await fetchBytes(composedUrl);
  const plain = await fetchBytes(artUrl);
  if (!isPng(composed) || !isPng(plain)) throw new Error(`a picture for ${one.name} was not a PNG`);

  // The width and height out of the PNG's own IHDR, which is the only header that states them here.
  const size = (bytes) => [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  const [composedWidth, composedHeight] = size(composed);
  const [artWidth, artHeight] = size(plain);
  if (composedWidth !== artWidth || composedHeight !== artHeight) {
    throw new Error(
      `the mirror composed ${one.name} at ${composedWidth}x${composedHeight} against the art's ` +
        `${artWidth}x${artHeight}: the two cannot be compared pixel for pixel, so this case is refused ` +
        'rather than captured.',
    );
  }

  writeFileSync(resolve(OUT, `${one.name}.art.png`), plain);
  writeFileSync(resolve(OUT, `${one.name}.composed.png`), composed);
  pictures[one.name] = {
    species: one.species,
    mutations: one.mutations,
    art,
    size: [artWidth, artHeight],
    artUrl,
    composedUrl,
    artBytes: plain.length,
    composedBytes: composed.length,
    artSha256: sha256(plain),
    composedSha256: sha256(composed),
  };
}

writeFileSync(
  resolve(OUT, 'provenance.json'),
  `${JSON.stringify(
    {
      note: "Written by capture-crop-wash.mjs. Each composed picture is the mirror's own composition at /assets/sprites/composed; each art picture is the mirror's own sprite for the same art path. Both are the art's own size, which is what the pixel comparison needs.",
      capturedFrom: { origin: GAME, community: COMMUNITY, artVersion: version },
      cases: pictures,
    },
    null,
    2,
  )}\n`,
);

console.log(`captured ${CASES.length} crop wash cases at art ${version} -> ${OUT}`);
