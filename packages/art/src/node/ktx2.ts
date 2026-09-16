/**
 * KTX2 to RGBA, and an atlas frame out of it.
 *
 * The game publishes each atlas as a KTX2 whose payload is UASTC -- `vkFormat = 0`, one byte per pixel,
 * `supercompressionScheme = 2` (Zstandard) -- which is not a format Node reads. The pixels come out through
 * the vendored Basis Universal transcoder in `assets/`, and only through it: nothing here invents a pixel,
 * a rect or a size.
 *
 * Two halves, and the split matters:
 *
 *   - `readKtx2Header` / `decodeKtx2` read the file. Every number that describes the atlas -- its width and
 *     height, its level count, its supercompression -- is read out of the KTX2 header rather than passed in
 *     or assumed.
 *   - `frameSize` / `frameBytes` cut one frame out of a decoded atlas, honouring `trimmed`,
 *     `spriteSourceSize` and `rotated` the way the game's own packs state them.
 *
 * `node:fs` and `node:zlib` are the reasons this file is in `@mg.js/art/node` and not in the model.
 */

import { readFileSync } from 'node:fs';
import { loadBasisTranscoder } from './basis.js';

/** The KTX2 identifier, `«KTX 20»\r\n\x1A\n` -- twelve bytes, no BOM, nothing before it. */
const IDENTIFIER = '\u00abKTX 20\u00bb\r\n\u001a\n';

/** `cTFRGBA32`, the transcoder's own name for "give me 8-bit RGBA". */
const RGBA32 = 'cTFRGBA32';

/** A rect in a pack's coordinates. The four numbers every atlas frame states. */
export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One frame of an atlas pack, as the game publishes it.
 *
 * Only `frame` is required. `sourceSize` and `spriteSourceSize` are optional because the game's own parser
 * defaults them, and a consumer that reads a pack from elsewhere may meet a frame that omits them.
 */
export interface AtlasFrame {
  frame: FrameRect;
  rotated?: boolean;
  trimmed?: boolean;
  spriteSourceSize?: FrameRect;
  sourceSize?: { w: number; h: number };
}

/** One mip level's place in the file, as the level index states it. */
export interface Ktx2Level {
  byteOffset: number;
  byteLength: number;
  uncompressedByteLength: number;
}

/** The KTX2 header, read rather than assumed. */
export interface Ktx2Header {
  vkFormat: number;
  typeSize: number;
  pixelWidth: number;
  pixelHeight: number;
  pixelDepth: number;
  layerCount: number;
  faceCount: number;
  levelCount: number;
  supercompressionScheme: number;
  dfdByteOffset: number;
  dfdByteLength: number;
  kvdByteOffset: number;
  kvdByteLength: number;
  sgdByteOffset: number;
  sgdByteLength: number;
  /** One entry per level, in level order (level 0 first), whatever order the bytes sit in the file. */
  levels: Ktx2Level[];
}

/** A whole atlas in memory: level 0, layer 0, face 0, as RGBA. */
export interface DecodedAtlas {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/**
 * The KTX2 header of `bytes`.
 *
 * Throws when the identifier is wrong or the declared level index does not fit in the file. That refusal is
 * the point: every other number here comes from these bytes, so a file that is not a KTX2 must fail here
 * rather than produce a plausible-looking 0x0 atlas.
 */
export function readKtx2Header(bytes: Uint8Array): Ktx2Header {
  if (bytes.byteLength < 80) {
    throw new Error(`a KTX2 header is 80 bytes; this is ${bytes.byteLength}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const identifier = new TextDecoder('latin1').decode(bytes.subarray(0, 12));
  if (identifier !== IDENTIFIER) {
    throw new Error(`not a KTX2 file: identifier is ${JSON.stringify(identifier)}`);
  }

  const u32 = (offset: number) => view.getUint32(offset, true);
  const u64 = (offset: number) => Number(view.getBigUint64(offset, true));

  const levelCount = u32(40);
  if (80 + levelCount * 24 > bytes.byteLength) {
    throw new Error(`KTX2 header declares ${levelCount} levels, which does not fit in ${bytes.byteLength} bytes`);
  }

  const levels: Ktx2Level[] = [];
  for (let level = 0; level < levelCount; level += 1) {
    const at = 80 + level * 24;
    levels.push({
      byteOffset: u64(at),
      byteLength: u64(at + 8),
      uncompressedByteLength: u64(at + 16),
    });
  }

  return {
    vkFormat: u32(12),
    typeSize: u32(16),
    pixelWidth: u32(20),
    pixelHeight: u32(24),
    pixelDepth: u32(28),
    layerCount: u32(32),
    faceCount: u32(36),
    levelCount,
    supercompressionScheme: u32(44),
    dfdByteOffset: u32(48),
    dfdByteLength: u32(52),
    kvdByteOffset: u32(56),
    kvdByteLength: u32(60),
    sgdByteOffset: u64(64),
    sgdByteLength: u64(72),
    levels,
  };
}

/**
 * Transcode a KTX2's level 0, layer 0, face 0 to RGBA.
 *
 * The dimensions come from the header, and are checked against the transcoder's own reading of the same
 * file: a disagreement means one of the two is wrong, and a caller who draws with the wrong width should
 * be told rather than handed a plausible buffer.
 */
export async function decodeKtx2(bytes: Uint8Array): Promise<DecodedAtlas> {
  const header = readKtx2Header(bytes);
  const transcoder = await loadBasisTranscoder();
  const file = new transcoder.KTX2File(bytes);
  try {
    if (!file.isValid()) throw new Error('the transcoder refused this KTX2 file');
    if (file.getWidth() !== header.pixelWidth || file.getHeight() !== header.pixelHeight) {
      throw new Error(
        `header says ${header.pixelWidth}x${header.pixelHeight}, the transcoder says ` +
          `${file.getWidth()}x${file.getHeight()}`,
      );
    }
    if (!file.startTranscoding()) throw new Error('the transcoder could not start transcoding this KTX2 file');

    const format = transcoder.transcoder_texture_format[RGBA32].value;
    const rgba = new Uint8Array(file.getImageTranscodedSizeInBytes(0, 0, 0, format));
    // decodeFlags 0, then -1,-1: the transcoder's own defaults for alpha and the channel order.
    if (!file.transcodeImage(rgba, 0, 0, 0, format, 0, -1, -1)) throw new Error('transcoding level 0 failed');

    if (rgba.byteLength !== header.pixelWidth * header.pixelHeight * 4) {
      throw new Error(
        `level 0 transcoded to ${rgba.byteLength} bytes, but ${header.pixelWidth}x${header.pixelHeight} ` +
          'RGBA is ' +
          `${header.pixelWidth * header.pixelHeight * 4}`,
      );
    }
    return { width: header.pixelWidth, height: header.pixelHeight, rgba };
  } finally {
    file.close();
    file.delete();
  }
}

/** `decodeKtx2` for a file on disk. Nothing is cached: a caller who wants a cache owns it. */
export async function decodeKtx2File(path: string): Promise<DecodedAtlas> {
  return decodeKtx2(readFileSync(path));
}

/**
 * The size a frame is drawn at: `sourceSize` when the frame states one, else the frame's own rect.
 *
 * This is the size half of the model's `frameBox`, which lives in the pure entry and lands with its own
 * commit. It is repeated here for now because cropping cannot be written without it.
 */
export function frameSize(frame: AtlasFrame): { width: number; height: number } {
  return {
    width: frame.sourceSize?.w ?? frame.frame.w,
    height: frame.sourceSize?.h ?? frame.frame.h,
  };
}

/**
 * A frame's RGBA, cut out of a decoded atlas.
 *
 * `trimmed` frames carry their crop's offset in `spriteSourceSize`, and the padding the packer removed comes
 * back as transparent pixels, so the result is always `frameSize(frame)` pixels: width * height * 4 bytes,
 * row-major, top row first.
 *
 * `rotated` frames are stored 90 degrees clockwise in the atlas, so the stored region is the sprite
 * transposed -- the region's width is the sprite's height -- and the pixels are turned back 90 degrees
 * counter-clockwise here. That is what TexturePacker's `rotated` means and what the fork's own extractor
 * does with `sharp(...).extract(...).rotate(270)`, which is the only in-repo implementation of this branch.
 * It is unexercised by the game itself: measured, zero of the 1,105 frames across the five packs this
 * workspace holds have `rotated: true`.
 *
 * Throws when the frame does not fit the atlas it is read from. A pack and an atlas that disagree is a loud
 * failure, not a shorter picture.
 */
export function frameBytes(frame: AtlasFrame, atlas: DecodedAtlas): Uint8Array {
  const rect = frame.frame;
  const rotated = frame.rotated === true;
  const { width, height } = frameSize(frame);

  if (atlas.rgba.byteLength !== atlas.width * atlas.height * 4) {
    throw new Error(
      `decoded atlas is ${atlas.rgba.byteLength} bytes, but ${atlas.width}x${atlas.height} RGBA is ` +
        `${atlas.width * atlas.height * 4}`,
    );
  }

  // The region the frame occupies in the atlas. A rotated frame is stored turned, so its stored width is the
  // sprite's height.
  const storedWidth = rotated ? rect.h : rect.w;
  const storedHeight = rotated ? rect.w : rect.h;
  if (rect.x < 0 || rect.y < 0 || rect.x + storedWidth > atlas.width || rect.y + storedHeight > atlas.height) {
    throw new Error(
      `frame rect ${rect.w}x${rect.h} at ${rect.x},${rect.y}${rotated ? ' (rotated)' : ''} lies outside the ` +
        `${atlas.width}x${atlas.height} atlas`,
    );
  }

  // Once un-rotated, the sprite is storedWidth x storedHeight the other way round.
  const drawnWidth = rotated ? storedHeight : storedWidth;
  const drawnHeight = rotated ? storedWidth : storedHeight;

  // Where the trimmed sprite lands inside its stated source size.
  const trimmed = frame.trimmed === true;
  const source = frame.spriteSourceSize;
  const offsetX = trimmed && source ? source.x : 0;
  const offsetY = trimmed && source ? source.y : 0;
  if (offsetX < 0 || offsetY < 0 || offsetX + drawnWidth > width || offsetY + drawnHeight > height) {
    throw new Error(
      `frame ${rect.w}x${rect.h} does not fit its ${width}x${height} sourceSize at ${offsetX},${offsetY}`,
    );
  }

  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < drawnHeight; y += 1) {
    for (let x = 0; x < drawnWidth; x += 1) {
      // (x, y) in the sprite and (x, y) in the atlas are the same point until the frame is rotated; a
      // rotated frame is read transposed, and the column counts down so the turn is counter-clockwise.
      const fromX = rect.x + (rotated ? storedWidth - 1 - y : x);
      const fromY = rect.y + (rotated ? x : y);
      const from = (fromY * atlas.width + fromX) * 4;
      const to = ((offsetY + y) * width + offsetX + x) * 4;
      pixels.set(atlas.rgba.subarray(from, from + 4), to);
    }
  }
  return pixels;
}
