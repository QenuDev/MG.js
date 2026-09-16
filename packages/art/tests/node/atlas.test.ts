/**
 * The whole atlas, when this workspace has a copy of it.
 *
 * This is the spike's comparison, turned into a test: transcode the game's own 4,856,876-byte KTX2, crop a
 * frame out of it, and hold the result against the community API's PNG of the same sprite. It proves the
 * two things the captured crops cannot prove on their own -- that the game's real file decodes at all, and
 * that a block-aligned crop of it is bit-for-bit the same picture as the whole thing.
 *
 * It is skipped, loudly, when no copy is on disk, because the alternative is a 4.8 MB fixture in git or a
 * test that needs a socket. `fixtures/README.md` says where to put the file and what it must hash to.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeKtx2, frameBytes, readKtx2Header } from '../../dist/node/index.js';
import {
  captured,
  compare,
  cropKtx2,
  fixtureFrame,
  frameOn,
  ORACLE_TOLERANCE,
  oracleRgba,
  provenance,
} from './fixture-files.js';

const PACKAGE = fileURLToPath(new URL('../..', import.meta.url));
const NAME = 'atlas-2x-0.ktx2';
const CANDIDATES = [
  process.env.MG_ART_ATLAS,
  // The workspace this package is developed in keeps its scratch copies outside the repo; `.logs/` is
  // gitignored. The first of these is the worktree's parent, the second its grandparent.
  resolve(PACKAGE, '.logs/art-atlas-fixtures', NAME),
  resolve(PACKAGE, '../../../../.logs/art-atlas-fixtures', NAME),
  resolve(PACKAGE, '../../../.logs/art-atlas-fixtures', NAME),
].filter((candidate): candidate is string => typeof candidate === 'string');

const atlasPath = CANDIDATES.find((candidate) => existsSync(candidate));

void test('the game’s own atlas decodes to the same frames the captured crops do', async (t) => {
  if (!atlasPath) {
    console.warn(
      `\n[mg.js] SKIPPING the full-atlas test: no copy of the game's atlas at\n  ${CANDIDATES.join('\n  ')}\n` +
        `  Fetch ${provenance.atlas.url}\n  ${provenance.atlas.bytes} bytes, sha256 ${provenance.atlas.sha256}\n` +
        '  and point MG_ART_ATLAS at it. Tests never fetch it themselves.\n',
    );
    t.skip('no local copy of the game atlas');
    return;
  }

  const bytes = readFileSync(atlasPath);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    provenance.atlas.sha256,
    `${atlasPath} is not the atlas these fixtures were captured from`,
  );

  // Everything that describes the atlas is read out of its own header before it is decoded.
  const header = readKtx2Header(bytes);
  assert.equal(header.pixelWidth, provenance.atlas.width, 'width');
  assert.equal(header.pixelHeight, provenance.atlas.height, 'height');
  assert.equal(header.levelCount, provenance.atlas.levelCount, 'level count');
  assert.equal(header.supercompressionScheme, provenance.atlas.supercompressionScheme, 'supercompression');
  assert.equal(header.vkFormat, provenance.atlas.vkFormat, 'vkFormat');
  assert.equal(header.faceCount, provenance.atlas.faceCount, 'face count');

  const started = Date.now();
  const atlas = await decodeKtx2(bytes);
  const decoded = Date.now() - started;
  assert.equal(atlas.width, header.pixelWidth, 'the decode agrees with the header');
  assert.equal(atlas.height, header.pixelHeight, 'the decode agrees with the header');
  assert.equal(atlas.rgba.byteLength, header.pixelWidth * header.pixelHeight * 4, 'RGBA length');
  console.log(
    `  transcoded ${atlas.width}x${atlas.height} in ${decoded} ms ` +
      `(${(atlas.rgba.byteLength / 1024 / 1024).toFixed(1)} MiB of RGBA)`,
  );

  for (const [key] of captured) {
    const entry = fixtureFrame(key);
    // The frame's rect as the pack states it, in the atlas's own coordinates: nothing is shifted here.
    const pixels = frameBytes(frameOn(key), atlas);
    const oracle = oracleRgba(key);
    const result = compare(pixels, oracle);
    assert.ok(
      result.worst <= ORACLE_TOLERANCE,
      `${key}: worst channel delta ${result.worst} exceeds ${ORACLE_TOLERANCE} ` +
        `(${result.differing} of ${result.channels} channels differ, mean ${result.mean.toFixed(4)})`,
    );

    // The crop is a window onto the same blocks, so it has to decode to the same pixels -- not merely close
    // to them. This is what makes the captured fixtures trustworthy when the atlas is not around.
    const cropAtlas = await decodeKtx2(cropKtx2(key));
    assert.equal(cropAtlas.width, entry.crop.w, `${key}: crop width`);
    assert.equal(cropAtlas.height, entry.crop.h, `${key}: crop height`);
    const region = new Uint8Array(cropAtlas.rgba.byteLength);
    for (let y = 0; y < entry.crop.h; y += 1) {
      const from = ((entry.crop.y + y) * atlas.width + entry.crop.x) * 4;
      region.set(atlas.rgba.subarray(from, from + entry.crop.w * 4), y * entry.crop.w * 4);
    }
    assert.deepEqual(
      cropAtlas.rgba,
      region,
      `${key}: the ${entry.crop.w}x${entry.crop.h} crop is the same blocks as the atlas region it was cut from`,
    );
  }
});
