/**
 * The captured fixture set, shared by the node tests.
 *
 * Everything here reads `packages/art/fixtures/`, which was written by `fixtures/build-fixtures.mjs` from
 * the live game (see `fixtures/README.md` and `fixtures/provenance.json`). Nothing here touches the network,
 * and nothing here holds a game value: the frame rects, the source sizes and the atlas dimensions all come
 * out of the captured pack metadata or the captured KTX2 header.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { AtlasFrame, FrameRect } from '../../dist/node/index.js';

export const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));

export interface FixtureFrame {
  slug: string;
  crop: FrameRect;
  blockColumns: number;
  blockRows: number;
  cropKtx2Bytes: number;
  cropKtx2Sha256: string;
  rawUastcBytes: number;
  zstdBytes: number;
  oracle: {
    url: string;
    pngBytes: number;
    pngSha256: string;
    rgbaBytes: number;
    file: string;
    gzipBytes: number;
    sha256: string;
  };
}

export interface Provenance {
  capturedFrom: { origin: string; community: string; gameVersion: string; manifest: string };
  pack: { url: string; file: string; bytes: number; sha256: string; frames: number };
  atlas: {
    url: string;
    bytes: number;
    sha256: string;
    vkFormat: number;
    typeSize: number;
    width: number;
    height: number;
    layerCount: number;
    faceCount: number;
    levelCount: number;
    supercompressionScheme: number;
    level0: { byteOffset: number; byteLength: number; uncompressed: number };
    uastcBlockBytes: number;
    uastcBlockEdge: number;
  };
  /**
   * The vendored transcoder's own record: both files with their byte counts and digests, the upstream commit
   * they were taken from, and where the licence is.
   *
   * It has to be in this interface for `assets.test.ts` to read it, which is how the two halves stay in step:
   * the test recomputes the digests and asserts they are the ones `provenance.json` records.
   */
  transcoder: {
    files: { file: string; bytes: number; sha256: string }[];
    source: string;
    licence: string;
  };
  frames: Record<string, FixtureFrame>;
}

export const provenance = JSON.parse(readFileSync(`${FIXTURES}provenance.json`, 'utf8')) as Provenance;

/** One atlas pack's metadata, exactly as the game served it. */
export const pack = JSON.parse(readFileSync(`${FIXTURES}${provenance.pack.file}`, 'utf8')) as {
  meta: { image: string; size: { w: number; h: number }; scale: string | number };
  frames: Record<string, AtlasFrame & { anchor?: FrameRect; visualBaselineY?: number }>;
};

/** The frames this fixture set captured, keyed by the game's own frame key. */
export const captured = Object.entries(provenance.frames);

export function fixtureFrame(key: string): FixtureFrame {
  const entry = provenance.frames[key];
  if (!entry)
    throw new Error(`no fixture for ${key}; captured: ${Object.keys(provenance.frames).join(', ')}`);
  return entry;
}

/** The frame as the game's own pack states it. */
export function frameOn(key: string): AtlasFrame {
  const frame = pack.frames[key];
  if (!frame) throw new Error(`${provenance.pack.url} states no frame ${key}`);
  return frame;
}

export function cropKtx2(key: string): Uint8Array {
  return readFileSync(`${FIXTURES}${fixtureFrame(key).slug}.crop.ktx2`);
}

/** The community API's PNG of the same sprite, as raw RGBA. The tolerance test's only outside reference. */
export function oracleRgba(key: string): Uint8Array {
  return new Uint8Array(gunzipSync(readFileSync(`${FIXTURES}${fixtureFrame(key).oracle.file}`)));
}

/**
 * The same frame, moved into the coordinates of the crop that contains it.
 *
 * The crop is a block-aligned window onto the atlas -- UASTC blocks are 4x4, so a frame's blocks are only
 * addressable on a 4-pixel grid -- and the window's origin is a fixture fact, recorded in `provenance.json`.
 * The frame itself is not touched: only its origin moves.
 */
export function frameInCrop(key: string): AtlasFrame {
  const frame = frameOn(key);
  const { crop } = fixtureFrame(key);
  return { ...frame, frame: { ...frame.frame, x: frame.frame.x - crop.x, y: frame.frame.y - crop.y } };
}

export interface Comparison {
  /** How many of the four channels differ at all. */
  differing: number;
  /** The largest single-channel difference, 0..255. */
  worst: number;
  mean: number;
  channels: number;
}

/** A channel-by-channel comparison of two RGBA buffers of the same pixel dimensions. */
export function compare(ours: Uint8Array, oracle: Uint8Array): Comparison {
  if (ours.byteLength !== oracle.byteLength) {
    throw new Error(`cannot compare ${ours.byteLength} bytes with ${oracle.byteLength}`);
  }
  let differing = 0;
  let worst = 0;
  let total = 0;
  for (let i = 0; i < ours.byteLength; i += 1) {
    // `noUncheckedIndexedAccess`: a typed array's index is `number | undefined` even inside its own bounds.
    const delta = Math.abs((ours[i] ?? 0) - (oracle[i] ?? 0));
    if (delta !== 0) differing += 1;
    if (delta > worst) worst = delta;
    total += delta;
  }
  return { differing, worst, mean: total / ours.byteLength, channels: ours.byteLength };
}

/**
 * The measured tolerance for the oracle comparison.
 *
 * Not a guess: transcoding the same frame out of the game's own atlas and out of this block-aligned crop
 * gives a worst single-channel difference of 5 against the community API's PNG of that sprite (152 of
 * 131,072 channels differ at all, mean 0.0013), because that PNG was not produced by this transcoder build.
 * The untrimmed frame beside it agrees byte for byte.
 */
export const ORACLE_TOLERANCE = 5;
