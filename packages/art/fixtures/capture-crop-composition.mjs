/**
 * Rebuild `packages/art/fixtures/crop-composition/` from the live game and the live viewer.
 *
 * This is not a test and it is not shipped (`package.json`'s `files` excludes the `*.mjs` here). It is the
 * recorded recipe for the captured pixels the offline crop-composition test reads, so a reader can check
 * what each file is and regenerate it after a game version moves. It is never run by `npm test`.
 *
 * What it writes:
 *
 *   - `frames.json`      the atlas frames of the arts the recipe places, exactly as the game's own pack
 *                        serves them, keyed by the game's key form. The test hands these in as the atlas the
 *                        recipe reads, so the frames and the composition below are one capture of one state
 *                        of the game rather than two.
 *   - `composed.png`     what the viewer's own `composeCrop` draws for `Clover` wearing `Frozen,Ambershine`,
 *                        fetched from its `/api/sprite` route with the server running. This is the stored
 *                        composition the recipe's rasterisation is compared against, and it is the viewer's
 *                        own output rather than a re-implementation of it.
 *   - `art.png`, `frozen.png`, `amberlit.png`
 *                        the three layer images the viewer composed that picture from, fetched through the
 *                        same route one request at a time. A recipe is a description, so the pixels have to
 *                        come from somewhere; these are the pixels the viewer drew, which is what makes the
 *                        comparison exact rather than tolerant.
 *   - `provenance.json`  every URL, byte count and digest behind the above, and the art version they were
 *                        read at, checked against the game's own index so a regeneration cannot silently
 *                        capture a different build.
 *
 * Usage:
 *   node fixtures/capture-crop-composition.mjs
 *
 * The viewer is read-only: this starts its server, asks it for four pictures and stops it. `MG_VIEWER` names
 * the checkout when it is not the sibling of this worktree's root.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const VIEWER = process.env.MG_VIEWER ?? resolve(REPO, '../../garden-viewer');
const OUT = resolve(HERE, 'crop-composition');

const GAME = 'https://magicgarden.gg';
const COMMUNITY = 'https://mg-api.ariedam.fr';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0';

/** The species and the mutations the stored composition is of. The consumer's own case. */
const SPECIES = 'Clover';
const MUTATIONS = ['Frozen', 'Ambershine'];

/**
 * The species whose own art the tests also place: `Carrot` is a patch whose plant and crop are different
 * pictures, and `Bamboo` is a patch the game draws tall, so its mutations pool as a decal under the art
 * rather than drawing over it. Their frames are captured beside the composition's because a recipe reads the
 * atlas it was handed, and one capture of one state of the game keeps every case in step.
 */
const SPECIES_READ = ['Clover', 'Carrot', 'Bamboo'];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fetchBytes(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * The art version the viewer reads its atlas at.
 *
 * Not `/platform/v1/version`: the viewer's own `loadSpriteIndex` takes the version off the community
 * index's sprite URLs (`server.mjs:131`), and the atlas it composes against is that version's. Reading the
 * same number here is what keeps the frames below the frames the composition was drawn with.
 */
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

/** Every frame of the atlas at one version, walked the way the viewer walks it. */
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

/** The sprite paths the crop recipe reaches: every species' two arts and every mutation's art and ground. */
function neededKeys() {
  const data = JSON.parse(readFileSync(resolve(HERE, '../data/1176.json'), 'utf8'));
  const tables = data.tables;
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

/** The viewer, running, with the URL it printed. Read-only: brought up, asked four questions, stopped. */
async function startViewer() {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: VIEWER,
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const found = /garden viewer: (http:\/\/[^\s]+)/.exec(output);
    if (found !== null) return { child, url: found[1] };
    if (child.exitCode !== null) break;
    await new Promise((settle) => setTimeout(settle, 100));
  }
  child.kill('SIGKILL');
  throw new Error(`the viewer did not start: ${output}`);
}

const version = await artVersion();
const frames = await atlasFrames(version);
const keys = neededKeys();
const missing = keys.filter((key) => frames[key] === undefined);
if (missing.length > 0) throw new Error(`the atlas states no frame for: ${missing.join(', ')}`);

const { child, url } = await startViewer();
let pictures;
try {
  const ask = async (query) => {
    const bytes = await fetchBytes(`${url}/api/sprite?${query}`);
    return { query, bytes, digest: sha256(bytes) };
  };
  pictures = {
    composed: await ask(`kind=plant&id=${SPECIES}&variant=plant&mutations=${MUTATIONS.join(',')}`),
    art: await ask(`kind=plant&id=${SPECIES}&variant=plant`),
    frozen: await ask('kind=mutation&id=Frozen'),
    amberlit: await ask('kind=mutation&id=Amberlit'),
  };
} finally {
  child.kill('SIGTERM');
  await once(child, 'exit').catch(() => {});
}

mkdirSync(OUT, { recursive: true });
writeFileSync(
  resolve(OUT, 'frames.json'),
  `${JSON.stringify(
    {
      note: 'The atlas frames the crop composition was drawn with, as the game served them. Written by capture-crop-composition.mjs; the tests read this file and never the network.',
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
writeFileSync(resolve(OUT, 'composed.png'), pictures.composed.bytes);
writeFileSync(resolve(OUT, 'art.png'), pictures.art.bytes);
writeFileSync(resolve(OUT, 'frozen.png'), pictures.frozen.bytes);
writeFileSync(resolve(OUT, 'amberlit.png'), pictures.amberlit.bytes);
writeFileSync(
  resolve(OUT, 'provenance.json'),
  `${JSON.stringify(
    {
      note: "Written by capture-crop-composition.mjs. The composition is the viewer's own composeCrop output; the three layer images are the pixels it drew, fetched through the same route.",
      capturedFrom: { origin: GAME, community: COMMUNITY, viewer: url, artVersion: version },
      case: { species: SPECIES, mutations: MUTATIONS, variant: 'plant' },
      pictures: Object.fromEntries(
        Object.entries(pictures).map(([name, picture]) => [
          name,
          { query: picture.query, bytes: picture.bytes.length, sha256: picture.digest },
        ]),
      ),
    },
    null,
    2,
  )}\n`,
);

console.log(`captured ${SPECIES} + ${MUTATIONS.join(',')} at art ${version} -> ${OUT}`);
