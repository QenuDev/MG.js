/**
 * The codec, against captured fixtures, offline.
 *
 * Every expected value here is read: the frame rects and source sizes come out of the captured pack metadata
 * (`sprites-2x-0.pack.json`, the game's own response), the atlas dimensions out of the captured KTX2 header,
 * and the pixels are compared against the community API's PNG of the same sprite, captured beside them. The
 * one class of value this file writes down is a synthetic frame rect for the rotated branch, and it says so
 * where it does: the game publishes no rotated frame to read.
 *
 * The full 4,856,876-byte atlas is not here. `atlas.test.ts` uses it when the workspace has a copy and skips
 * loudly when it does not.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AtlasFrame, decodeKtx2, frameBytes, frameSize, readKtx2Header } from '../../dist/node/index.js';
import {
  captured,
  compare,
  cropKtx2,
  fixtureFrame,
  frameInCrop,
  frameOn,
  ORACLE_TOLERANCE,
  oracleRgba,
  pack,
  provenance,
} from './fixture-files.js';

const TRIMMED = 'sprite/animation/NotifyFlag-0';
const UNTRIMMED = 'sprite/ui/Thumbtack';

void test('the header of each captured crop is read, and states the size it was cut at', () => {
  for (const [key, entry] of captured) {
    const header = readKtx2Header(cropKtx2(key));
    const where = `${key} (${entry.slug}.crop.ktx2)`;
    assert.equal(header.pixelWidth, entry.crop.w, `${where}: width`);
    assert.equal(header.pixelHeight, entry.crop.h, `${where}: height`);
    assert.equal(header.levelCount, 1, `${where}: one level`);
    assert.equal(header.faceCount, 1, `${where}: one face`);
    assert.equal(header.layerCount, 0, `${where}: not an array texture`);
    // The crop keeps the game's own format: same vkFormat, same block size, same supercompression.
    assert.equal(header.vkFormat, provenance.atlas.vkFormat, `${where}: vkFormat`);
    assert.equal(header.typeSize, provenance.atlas.typeSize, `${where}: typeSize`);
    assert.equal(header.supercompressionScheme, provenance.atlas.supercompressionScheme, `${where}: supercompression`);
    // The level index the header carries has to describe the bytes actually there.
    const level = header.levels[0];
    assert.equal(level.byteOffset + level.byteLength, entry.cropKtx2Bytes, `${where}: level 0 ends the file`);
    assert.equal(level.uncompressedByteLength, entry.rawUastcBytes, `${where}: level 0 inflates to the crop's blocks`);
  }
});

void test('the header reader refuses a buffer that is not a KTX2 file', () => {
  assert.throws(() => readKtx2Header(new Uint8Array(8)), /a KTX2 header is 80 bytes; this is 8/);
  assert.throws(() => readKtx2Header(new Uint8Array(80)), /not a KTX2 file/);
  // A real header with a level index that runs off the end of the file is refused too, rather than read.
  const truncated = cropKtx2(UNTRIMMED).subarray(0, 96);
  assert.throws(() => readKtx2Header(truncated), /does not fit/);
});

void test('decoding a captured crop gives the dimensions its header states, twice the same, with no network', async () => {
  const globalFetch = globalThis.fetch;
  // The decode must not need the network at all: the transcoder's wasm ships beside it in `assets/`.
  globalThis.fetch = () => {
    throw new Error('the decode reached for the network');
  };
  try {
    for (const [key, entry] of captured) {
      const atlas = await decodeKtx2(cropKtx2(key));
      assert.equal(atlas.width, entry.crop.w, `${key}: width`);
      assert.equal(atlas.height, entry.crop.h, `${key}: height`);
      assert.equal(atlas.rgba.byteLength, entry.crop.w * entry.crop.h * 4, `${key}: RGBA length`);

      const again = await decodeKtx2(cropKtx2(key));
      assert.deepEqual(again.rgba, atlas.rgba, `${key}: the same bytes decode the same way twice`);
    }
  } finally {
    globalThis.fetch = globalFetch;
  }
});

void test('a trimmed frame comes back at its source size, padded transparent, and matches the oracle', async () => {
  const entry = fixtureFrame(TRIMMED);
  const frame = frameOn(TRIMMED);
  const source = frame.sourceSize;
  const sprite = frame.spriteSourceSize;
  assert.ok(source && sprite, `${TRIMMED} is the trimmed fixture, so it must state both sizes`);
  assert.equal(frame.trimmed, true, `${TRIMMED} is the trimmed fixture`);

  const atlas = await decodeKtx2(cropKtx2(TRIMMED));
  const pixels = frameBytes(frameInCrop(TRIMMED), atlas);
  const oracle = oracleRgba(TRIMMED);

  assert.deepEqual(frameSize(frame), { width: source.w, height: source.h }, `${TRIMMED}: drawn size`);
  assert.equal(
    oracle.byteLength,
    source.w * source.h * 4,
    `${TRIMMED}: the captured oracle is the frame's source size, not its trimmed size`,
  );
  assert.equal(pixels.byteLength, oracle.byteLength, `${TRIMMED}: our frame is the same shape as the oracle`);

  const result = compare(pixels, oracle);
  assert.ok(
    result.worst <= ORACLE_TOLERANCE,
    `${TRIMMED}: worst channel delta ${result.worst} exceeds the measured tolerance ${ORACLE_TOLERANCE} ` +
      `(${result.differing} of ${result.channels} channels differ, mean ${result.mean.toFixed(4)})`,
  );

  // The packer's padding is restored as transparent pixels, and they are exactly the pixels outside the
  // trimmed rect: a frame placed at the wrong offset would still match the oracle's non-transparent pixels
  // in shape, but not in position.
  let opaqueOutside = 0;
  for (let y = 0; y < source.h; y += 1) {
    for (let x = 0; x < source.w; x += 1) {
      const inside = x >= sprite.x && x < sprite.x + sprite.w && y >= sprite.y && y < sprite.y + sprite.h;
      if (!inside && pixels[(y * source.w + x) * 4 + 3] !== 0) opaqueOutside += 1;
    }
  }
  assert.equal(opaqueOutside, 0, `${TRIMMED}: ${opaqueOutside} opaque pixels outside the trimmed rect`);
});

void test('an untrimmed frame is the region it states, byte for byte', async () => {
  const frame = frameOn(UNTRIMMED);
  assert.equal(frame.trimmed, false, `${UNTRIMMED} is the untrimmed fixture`);

  const atlas = await decodeKtx2(cropKtx2(UNTRIMMED));
  const rect = frameInCrop(UNTRIMMED).frame;
  const pixels = frameBytes(frameInCrop(UNTRIMMED), atlas);

  assert.deepEqual(frameSize(frame), { width: rect.w, height: rect.h }, `${UNTRIMMED}: drawn size`);
  assert.equal(pixels.byteLength, rect.w * rect.h * 4, `${UNTRIMMED}: RGBA length`);

  // Read out of the decoded atlas by a different route -- one row at a time, no pixel loop -- so that a
  // mistake in the crop's arithmetic cannot agree with itself.
  const region = new Uint8Array(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y += 1) {
    const from = (y * atlas.width + rect.x) * 4;
    region.set(atlas.rgba.subarray(from, from + rect.w * 4), y * rect.w * 4);
  }
  assert.deepEqual(pixels, region, `${UNTRIMMED}: the frame is the region, unwrapped`);

  // And the game's own PNG of that sprite agrees with it exactly: no tolerance needed on this one.
  const result = compare(pixels, oracleRgba(UNTRIMMED));
  assert.equal(
    result.differing,
    0,
    `${UNTRIMMED}: ${result.differing} channels differ from the oracle, worst ${result.worst}`,
  );
});

void test('a rotated frame is turned back counter-clockwise out of its transposed storage', async () => {
  const atlas = await decodeKtx2(cropKtx2(UNTRIMMED));
  assert.equal(atlas.width, 32);
  assert.equal(atlas.height, 56);

  // No frame the game publishes is rotated -- measured, 0 of the 1,105 frames across the five packs this
  // workspace holds -- so this rect is synthetic. Its pixels are not: they are the captured crop's own.
  // TexturePacker stores a rotated sprite 90 degrees clockwise, which is what the fork's extractor turns
  // back with `sharp(...).extract(...).rotate(270)`, and that is the convention asserted here.
  const sprite = { w: 16, h: 24 };
  // The pack states the sprite's own size; the pixels sit turned, so the region in the atlas is transposed.
  const rect = { x: 4, y: 8, w: sprite.w, h: sprite.h };
  const stored = { x: rect.x, y: rect.y, w: rect.h, h: rect.w };
  const rotatedFrame: AtlasFrame = { frame: rect, rotated: true, trimmed: false, sourceSize: sprite };

  // Expected, built the other way round: walk the stored region and send each pixel where the rotation
  // puts it. A transpose, a flip or an off-by-one would not agree with the loop under test.
  const expected = new Uint8Array(sprite.w * sprite.h * 4);
  for (let v = 0; v < stored.h; v += 1) {
    for (let u = 0; u < stored.w; u += 1) {
      const from = ((stored.y + v) * atlas.width + stored.x + u) * 4;
      const x = v;
      const y = stored.w - 1 - u;
      expected.set(atlas.rgba.subarray(from, from + 4), (y * sprite.w + x) * 4);
    }
  }

  assert.deepEqual(
    frameSize(rotatedFrame),
    { width: sprite.w, height: sprite.h },
    'a rotated frame draws at its source size',
  );
  assert.deepEqual(frameBytes(rotatedFrame, atlas), expected, 'the frame is the stored region turned back');

  // The same rect read unrotated is a different picture, so the branch above is not the identity.
  const plain = frameBytes({ ...rotatedFrame, rotated: false }, atlas);
  assert.notDeepEqual(plain, expected, 'a rotated frame is not the untransposed region');

  // Rotated and trimmed at once: the turn happens first, then the sprite is placed at its stated offset.
  const trimmedRotated: AtlasFrame = {
    frame: rect,
    rotated: true,
    trimmed: true,
    spriteSourceSize: { x: 2, y: 3, w: sprite.w, h: sprite.h },
    sourceSize: { w: 20, h: 28 },
  };
  const padded = frameBytes(trimmedRotated, atlas);
  assert.equal(padded.byteLength, 20 * 28 * 4, 'rotated and trimmed: the source size');
  for (let i = 0; i < padded.byteLength; i += 4) {
    const x = (i / 4) % 20;
    const y = Math.floor(i / 4 / 20);
    const inside = x >= 2 && x < 18 && y >= 3 && y < 27;
    if (!inside) assert.equal(padded[i + 3], 0, `rotated and trimmed: (${x},${y}) should be padding`);
  }
  const placed = new Uint8Array(sprite.w * sprite.h * 4);
  for (let y = 0; y < sprite.h; y += 1) {
    const from = ((3 + y) * 20 + 2) * 4;
    placed.set(padded.subarray(from, from + sprite.w * 4), y * sprite.w * 4);
  }
  assert.deepEqual(placed, expected, 'rotated and trimmed: the same sprite, at its stated offset');
});

void test('a frame that does not fit what it is read from is refused', async () => {
  const atlas = await decodeKtx2(cropKtx2(UNTRIMMED));

  assert.throws(
    () => frameBytes({ frame: { x: 28, y: 0, w: 8, h: 8 } }, atlas),
    /frame rect 8x8 at 28,0 lies outside the 32x56 atlas/,
  );
  // Rotated, the same rect reads a region the atlas does not have: the stored region's width is the frame's
  // height. Untransposed it fits, so the check is about the region actually read, not about the rect alone.
  assert.doesNotThrow(() => frameBytes({ frame: { x: 0, y: 0, w: 10, h: 40 } }, atlas));
  assert.throws(
    () => frameBytes({ frame: { x: 0, y: 0, w: 10, h: 40 }, rotated: true }, atlas),
    /frame rect 10x40 at 0,0 \(rotated\) lies outside the 32x56 atlas/,
  );
  assert.throws(
    () =>
      frameBytes(
        {
          frame: { x: 0, y: 0, w: 8, h: 8 },
          trimmed: true,
          spriteSourceSize: { x: 30, y: 0, w: 8, h: 8 },
          sourceSize: { w: 32, h: 56 },
        },
        atlas,
      ),
    /does not fit its 32x56 sourceSize at 30,0/,
  );
  assert.throws(
    () => frameBytes({ frame: { x: 0, y: 0, w: 8, h: 8 } }, { width: 4, height: 4, rgba: new Uint8Array(8) }),
    /decoded atlas is 8 bytes, but 4x4 RGBA is 64/,
  );
});

void test('a frame that states no sourceSize draws at its stated size', () => {
  assert.deepEqual(frameSize({ frame: { x: 0, y: 0, w: 12, h: 34 } }), { width: 12, height: 34 });
  assert.deepEqual(
    frameSize({ frame: { x: 0, y: 0, w: 12, h: 34 }, sourceSize: { w: 20, h: 20 } }),
    { width: 20, height: 20 },
    'a stated sourceSize wins over the rect',
  );
});

void test('the fixtures this file reads are the ones the provenance describes', () => {
  // A regenerated fixture set cannot quietly point these tests at different sprites: the two captured frames
  // are the ones the captured pack states, and each one sits inside the crop captured for it.
  assert.deepEqual(Object.keys(provenance.frames).sort(), [TRIMMED, UNTRIMMED].sort());
  for (const [key, entry] of captured) {
    assert.ok(pack.frames[key], `the captured pack states ${key}`);
    const moved = frameInCrop(key).frame;
    assert.ok(moved.x >= 0 && moved.y >= 0, `${key}: the crop starts at or before the frame`);
    assert.ok(
      moved.x + moved.w <= entry.crop.w && moved.y + moved.h <= entry.crop.h,
      `${key}: the frame is inside the crop captured for it`,
    );
  }
});
