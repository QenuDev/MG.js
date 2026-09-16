/**
 * The PNG operations this entry needs, and nothing else.
 *
 * A consumer composes a mutated crop's picture out of sprite PNGs rather than asking a third-party API to
 * merge them, because a merged picture is not the crop's own size and so cannot be placed on a tile.
 * Composing sprites needs exactly these: read a sprite, write the result, resize a sprite, lay one over
 * another, read the size a file states without decoding it, and filter a wash through the pixels.
 *
 * It is not a general PNG library, and it refuses rather than guesses. The only files it reads are 8-bit
 * RGBA (colour type 6), non-interlaced, with the IDAT payload split across one to fifteen chunks. Anything
 * else is a file this codec cannot have been handed, and every path that cannot be carried out either
 * throws with a message naming what it found or is outside the file entirely — nothing here silently
 * produces a wrong picture.
 */

import { deflateSync, inflateSync } from 'node:zlib';

/**
 * An image as this codec reads and writes it: `width` by `height` pixels, RGBA, straight (not
 * premultiplied) alpha, four bytes per pixel.
 */
export interface PngImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** The eight bytes every PNG begins with, checked before anything else is believed about the file. */
const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A table the PNG specification itself publishes, so it is computed here rather than written out.
 *
 * PNG's CRC is CRC-32/ISO-HDLC — the reflected polynomial 0xedb88320 with the register started and finished
 * inverted — which is not the CRC that `node:zlib` exposes, so it has to be kept here.
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

/**
 * The CRC of a chunk's type and data, which is all of a chunk except its length and the CRC itself.
 *
 * The type comes in as a string and is hashed as its Latin-1 bytes. That is not the same as iterating the
 * string — a generator over text yields *characters*, and one that hashes those is a different function
 * than the same code over a `Buffer`, which is how an encoder and a decoder written from the same source
 * came to disagree about every chunk they exchanged.
 */
function crc32(type: string | Uint8Array, data: Uint8Array): number {
  let crc = -1;
  const bytes = typeof type === 'string' ? Buffer.from(type, 'latin1') : type;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** One chunk: its length, type, data, and the CRC over the last two. */
function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.from(type, 'latin1'), data), data.length + 8);
  return out;
}

/** PNG's own names for its colour types, so a refusal can quote what the file actually is. */
const COLOUR_TYPES: Record<number, string> = {
  0: 'greyscale',
  2: 'truecolour',
  3: 'indexed',
  4: 'greyscale with alpha',
  6: 'RGBA',
};

/**
 * Whether a chunk's own CRC matches its bytes.
 *
 * Checked on every chunk that is used, because a file whose CRC does not match is a file that was cut short
 * or mangled on the way in, and inflating the IDAT of one produces pixels that look plausible and are not.
 */
function chunkChecksOut(type: string, data: Buffer, stated: number): boolean {
  return crc32(type, data) === stated;
}

/**
 * Walk a PNG's chunks, stopping at the end chunk.
 *
 * Yields `{ type, data }` with the type as text, and throws on anything whose CRC does not match — including
 * chunks this file has no use for, since a broken ancillary chunk means the whole file is suspect.
 */
function* readChunks(buffer: Buffer, from: number): Generator<{ type: string; data: Buffer }> {
  let at = from;
  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at);
    const end = at + 12 + length;
    if (end > buffer.length) {
      throw new Error(`PNG chunk at byte ${at} claims ${length} bytes, which runs past the end of the file`);
    }
    const type = buffer.toString('latin1', at + 4, at + 8);
    const data = buffer.subarray(at + 8, at + 8 + length);
    const stated = buffer.readUInt32BE(at + 8 + length);
    if (!chunkChecksOut(type, data, stated)) {
      throw new Error(`PNG ${type} chunk at byte ${at} fails its CRC check`);
    }
    yield { type, data };
    if (type === 'IEND') return;
    at = end;
  }
}

/**
 * The image a PNG holds: `{ width, height, pixels }` with `pixels` a `Uint8Array` of `width*height*4` bytes,
 * RGBA, straight (not premultiplied) alpha.
 */
export function decodePng(buffer: Uint8Array): PngImage {
  if (!(buffer instanceof Uint8Array) || buffer.length < SIGNATURE.length) {
    throw new Error('PNG is too short to be a PNG');
  }
  if (!SIGNATURE.every((byte, index) => buffer[index] === byte)) {
    throw new Error('PNG does not begin with the PNG signature');
  }
  // The chunk walk reads big-endian integers, which is `Buffer`'s method rather than a `Uint8Array`'s. This
  // is a view over the same bytes, not a copy, so a plain `Uint8Array` is read as happily as a `Buffer`.
  const bytes = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  let header: { width: number; height: number } | null = null;
  const idat: Buffer[] = [];
  for (const { type, data } of readChunks(bytes, SIGNATURE.length)) {
    if (type === 'IHDR') {
      if (header !== null) throw new Error('PNG has more than one IHDR');
      if (data.length !== 13)
        throw new Error(`PNG IHDR is ${data.length} bytes, not the 13 the format states`);
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      const depth = data[8] as number;
      const colourType = data[9] as number;
      const interlace = data[12] as number;
      // Both refusals name what the file actually is, because the two allowed values are the only ones this
      // codec ever asks an image host for, so anything else means it was handed the wrong file.
      if (depth !== 8 || colourType !== 6) {
        throw new Error(
          `PNG is ${depth}-bit ${COLOUR_TYPES[colourType] ?? `colour type ${colourType}`}; ` +
            'only 8-bit RGBA (colour type 6) is read',
        );
      }
      if (interlace !== 0) throw new Error('PNG is interlaced; only non-interlaced PNGs are read');
      if (width === 0 || height === 0) throw new Error(`PNG is ${width}x${height}; a PNG cannot be empty`);
      header = { width, height };
    } else if (type === 'IDAT') {
      // Every IDAT chunk is one window on the same zlib stream, so they are joined before inflating.
      idat.push(data);
    }
  }

  if (header === null) throw new Error('PNG has no IHDR chunk');
  if (idat.length === 0) throw new Error('PNG has no IDAT chunk, so it holds no picture');

  const { width, height } = header;
  const pixels = unfilter(deflateInputStream(idat), width, height);
  return { width, height, pixels };
}

/**
 * The size a PNG states in its header, without decoding any of its pixels.
 *
 * An atlas index states a file's URL and nothing about its size, and the size is what the game's proportion
 * maths needs. A PNG states its size in the first twenty-four bytes, so a caller that can make a ranged read
 * pays one small read per file and nothing else: no inflate, and no unfiltering.
 *
 * A header that is not there is refused rather than answered with a size of nothing. `{ width: 0, height: 0 }`
 * is a sentinel a loader may want for a file it could not measure, and it is the loader's decision to make:
 * a codec that returned one would be stating a size no file declared.
 */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (!(bytes instanceof Uint8Array) || bytes.length < 24) {
    const held = bytes instanceof Uint8Array ? `${bytes.length} bytes` : typeof bytes;
    throw new Error(`a PNG states its size in its first 24 bytes, and this is ${held}`);
  }
  if (!SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    throw new Error('PNG does not begin with the PNG signature');
  }
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = header.toString('latin1', 12, 16);
  if (type !== 'IHDR') {
    throw new Error(`PNG states its size in an IHDR chunk, and byte 12 of this file is ${type}`);
  }
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

/** The joined IDAT payload, inflated, with a failure that says which stage went wrong rather than a bare zlib error. */
function deflateInputStream(chunks: Buffer[]): Buffer {
  const compressed = Buffer.concat(chunks);
  let raw: Buffer;
  try {
    raw = inflateSync(compressed);
  } catch (cause) {
    throw new Error(`PNG IDAT does not inflate: ${(cause as Error).message}`);
  }
  return raw;
}

/**
 * Unpack filtered scanlines into pixels, reversing filter types 0–4.
 *
 * The stream is one filter byte and one scanline of `stride` bytes per row, with no padding and no alignment
 * between rows, so a short stream is a truncated picture and reading on regardless would invent pixels.
 */
function unfilter(raw: Buffer, width: number, height: number): Uint8Array {
  const stride = width * 4;
  const expected = (stride + 1) * height;
  if (raw.length !== expected) {
    throw new Error(`PNG pixel data is ${raw.length} bytes; ${width}x${height} unfiltered is ${expected}`);
  }

  const pixels = new Uint8Array(stride * height);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)] as number;
    let at = row * (stride + 1) + 1;
    const out = row * stride;
    for (let index = 0; index < stride; index += 1, at += 1) {
      // The neighbours are the byte `index` back within the row (Sub), the same byte in the row above (Up),
      // and the byte diagonally above and back (Paeth). At the left edge those are the zero left and above
      // that the specification's diagrams start from, which is what `Math.max` here stands for.
      const left = index >= 4 ? (pixels[out + index - 4] as number) : 0;
      const above = row > 0 ? (pixels[out + index - stride] as number) : 0;
      const upperLeft = row > 0 && index >= 4 ? (pixels[out + index - stride - 4] as number) : 0;
      const value = raw[at] as number;
      if (filter === 0) {
        pixels[out + index] = value;
      } else if (filter === 1) {
        pixels[out + index] = (value + left) & 0xff;
      } else if (filter === 2) {
        pixels[out + index] = (value + above) & 0xff;
      } else if (filter === 3) {
        pixels[out + index] = (value + ((left + above) >> 1)) & 0xff;
      } else if (filter === 4) {
        pixels[out + index] = (value + paeth(left, above, upperLeft)) & 0xff;
      } else {
        throw new Error(`PNG scanline ${row} uses filter type ${filter}, and only 0 to 4 exist`);
      }
    }
  }
  return pixels;
}

/** The Paeth predictor: whichever of the three neighbours is closest to `left + above - upperLeft`. */
function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const toLeft = Math.abs(estimate - left);
  const toAbove = Math.abs(estimate - above);
  const toUpperLeft = Math.abs(estimate - upperLeft);
  if (toLeft <= toAbove && toLeft <= toUpperLeft) return left;
  return toAbove <= toUpperLeft ? above : upperLeft;
}

/**
 * The same shape back as a `Buffer`: 8-bit RGBA, non-interlaced, one IDAT chunk, every scanline filtered
 * with type 0.
 *
 * Filter 0 rather than a smarter one is deliberate. A filter exists to make the deflate stage smaller, and
 * this is what the game's own writer emits, but the reason it is worth the bytes here is that a written
 * stream is also a stream this file can read back: a round trip through `decodePng` has to give the pixels
 * that went in, and an unfiltered scanline is the one filter whose inverse is the identity.
 */
export function encodePng(image: PngImage): Buffer {
  const { width, height } = check(image);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: the adaptive set above
  ihdr[12] = 0; // interlace: none

  // The leading zero of each scanline is its filter type, and the rows are laid end to end with nothing
  // between them — the same shape `unfilter` reads back.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw.set(image.pixels.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * `layer` composited over `base`, source-over, with the layer's top-left at (x, y). Mutates `base.pixels`.
 *
 * Straight alpha: `out.a = src.a + dst.a × (1 − src.a)` and
 * `out.rgb = (src.rgb × src.a + dst.rgb × dst.a × (1 − src.a)) / out.a`. Both are carried out in bytes, as
 * the numbers the formula is written in, and rounded once at the end — `out.a` as the byte it will be stored
 * as, so that the division by it is a division by the same value the two terms were weighted with. Dividing
 * by the fraction `128/255` instead is off by one in the last bit, which is enough to make half a green over
 * a red 127 where the arithmetic says 128.
 *
 * (x, y) may be negative, and does: mutation art is anchored at a point inside the crop's art and can
 * overhang the top and the left. The loop is therefore over the *overlap*, not over the layer, so the
 * indices it forms are inside the base by construction and nothing is ever written out of bounds. A source
 * pixel of alpha 0 is skipped outright, which is the same picture as compositing it and costs less.
 */
export function drawOver(base: PngImage, layer: PngImage, x: number, y: number): void {
  check(base);
  check(layer);

  const fromX = Math.max(0, Math.floor(x));
  const fromY = Math.max(0, Math.floor(y));
  const toX = Math.min(base.width, Math.floor(x) + layer.width);
  const toY = Math.min(base.height, Math.floor(y) + layer.height);

  for (let targetY = fromY; targetY < toY; targetY += 1) {
    const sourceY = targetY - Math.floor(y);
    for (let targetX = fromX; targetX < toX; targetX += 1) {
      const sourceX = targetX - Math.floor(x);
      const source = (sourceY * layer.width + sourceX) * 4;
      const target = (targetY * base.width + targetX) * 4;

      if (layer.pixels[source + 3] === 0) continue;
      const sourceAlpha = layer.pixels[source + 3] as number;
      const targetAlpha = base.pixels[target + 3] as number;
      const kept = 255 - sourceAlpha;
      // Both halves of the formula carried in bytes rather than in the fractions they stand for, which is
      // what makes it exact. `weight` is what the colour below is out of — `out.a` and the 255 it is a byte
      // of — and `alpha` is the byte that will be stored. Rounding the divisor to `alpha` instead loses up to
      // half a unit of it, and a channel sits close enough to a half-way point for that to be the difference
      // between two neighboring colours. Folding the 255s wrongly is worse still: an extra factor turns a
      // partial-alpha layer into byte-truncated noise, which is a speckle rather than ice.
      const weight = sourceAlpha * 255 + targetAlpha * kept;
      const alpha = Math.round(weight / 255);
      // An alpha of nothing makes the colour meaningless, and dividing by it would give NaN; any colour at
      // all draws as nothing there, so it is pinned to zero rather than left to the arithmetic.
      if (alpha === 0) {
        base.pixels[target] = 0;
        base.pixels[target + 1] = 0;
        base.pixels[target + 2] = 0;
        base.pixels[target + 3] = 0;
        continue;
      }
      for (let channel = 0; channel < 3; channel += 1) {
        // The layer's colour by its own alpha, and the base's by its own alpha and by what the layer left of
        // it: `src.rgb × src.a × 255 + dst.rgb × dst.a × (1 − src.a)`, over `out.a × 255`.
        const over =
          (layer.pixels[source + channel] as number) * sourceAlpha * 255 +
          (base.pixels[target + channel] as number) * targetAlpha * kept;
        base.pixels[target + channel] = Math.round(over / weight);
      }
      base.pixels[target + 3] = alpha;
    }
  }
}

/**
 * The image scaled to the given size: an area average when shrinking, interpolation when growing.
 *
 * The two directions are different operations and are kept different. Shrinking has to be an average of the
 * whole source area each target pixel covers — point sampling a crop's art down to a tile drops whole rows
 * of it, and a checkerboard comes out as whichever colour the sample happened to land on rather than grey.
 * Growing has nothing to average, so it interpolates.
 *
 * Both directions weight colour by alpha and divide it back out. Averages and interpolations are taken on
 * premultiplied values, where a transparent pixel's colour cannot drag its neighbours towards black: there
 * is no such thing as the colour of a pixel that is not there. That is only true of the arithmetic, though —
 * both the input and the result are straight alpha, as the interface says.
 */
export function scaled(image: PngImage, width: number, height: number): PngImage {
  check(image);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`cannot scale to ${width}x${height}; a size is a whole positive number of pixels`);
  }
  if (width === image.width && height === image.height) {
    // Copied rather than handed back, so that a caller which writes to the result of a no-op resize does not
    // find itself mutating the picture it passed in.
    return { width, height, pixels: image.pixels.slice() };
  }

  const pixels = new Uint8Array(width * height * 4);
  const columns = shrinkRegions(image.width, width);
  const rows = shrinkRegions(image.height, height);
  const growing = width > image.width || height > image.height;

  for (let targetY = 0; targetY < height; targetY += 1) {
    for (let targetX = 0; targetX < width; targetX += 1) {
      const target = (targetY * width + targetX) * 4;
      if (growing) {
        const [red, green, blue, alpha] = growingPixel(image, targetX, targetY, width, height);
        pixels[target] = red;
        pixels[target + 1] = green;
        pixels[target + 2] = blue;
        pixels[target + 3] = alpha;
      } else {
        const [red, green, blue, alpha] = shrinkingPixel(
          image,
          columns[targetX] as Region,
          rows[targetY] as Region,
        );
        pixels[target] = red;
        pixels[target + 1] = green;
        pixels[target + 2] = blue;
        pixels[target + 3] = alpha;
      }
    }
  }
  return { width, height, pixels };
}

/**
 * The art with the washes filtered through it, which is what the game's filter does to the sprite's pixels.
 *
 * The filter replaces each pixel's colour with a mix of itself and the flat colour, keeping the pixel's own
 * alpha, so a transparent pixel stays transparent and the shape of the art is untouched. The washes are taken
 * in order, each one mixing into the result of the last, which is how the game stacks two of them.
 *
 * A wash is stated the way CSS states it — `rgba(94, 46, 20, 0.5)` — and the number that matters is the
 * fourth: how much of the flat colour replaces what is there.
 */
export function washArt(image: PngImage, washes: readonly string[]): PngImage {
  check(image);
  if (washes.length === 0) return image;
  const pixels = Uint8Array.from(image.pixels);
  for (const css of washes) {
    const channels = (css.match(/[0-9.]+/g) ?? []).map(Number);
    const red = channels[0] as number;
    const green = channels[1] as number;
    const blue = channels[2] as number;
    const alpha = channels[3] as number;
    for (let at = 0; at < pixels.length; at += 4) {
      if (pixels[at + 3] === 0) continue;
      pixels[at] = Math.round((pixels[at] as number) + (red - (pixels[at] as number)) * alpha);
      pixels[at + 1] = Math.round((pixels[at + 1] as number) + (green - (pixels[at + 1] as number)) * alpha);
      pixels[at + 2] = Math.round((pixels[at + 2] as number) + (blue - (pixels[at + 2] as number)) * alpha);
    }
  }
  return { width: image.width, height: image.height, pixels };
}

/** One target coordinate's source span: where the coverage starts and ends, and the pixels it touches. */
type Region = [start: number, first: number, last: number, end: number];

/**
 * Which part of one axis of the source each target coordinate covers.
 *
 * The coverage runs from `start` to `end` in source coordinates, and the pixels it can touch are the ones
 * whose whole-pixel spans `[x, x+1)` overlap it — so the first is `floor(start)` and the last is
 * `ceil(end) − 1`, clamped at the top to the last pixel of the source. Those two have to be whole numbers: a
 * source coordinate of 1.5 is halfway across the second pixel, but it is not an index, and a loop that uses
 * it as one reads the pixel at 1 twice and the pixel at 2 never.
 */
function shrinkRegions(sourceLength: number, targetLength: number): Region[] {
  const regions: Region[] = [];
  for (let target = 0; target < targetLength; target += 1) {
    const start = (target * sourceLength) / targetLength;
    const end = ((target + 1) * sourceLength) / targetLength;
    const first = Math.max(0, Math.floor(start));
    const last = Math.min(sourceLength - 1, Math.max(first, Math.ceil(end) - 1));
    regions.push([start, first, last, end]);
  }
  return regions;
}

/** One pixel as the four bytes it is stored as, in RGBA order. */
type Pixel = [red: number, green: number, blue: number, alpha: number];

/**
 * One averaged pixel: every source pixel the target covers, each weighted by how much of it it covers.
 *
 * The average is taken on colour weighted by alpha and then divided back out by alpha, which is what keeps a
 * pixel that is not there from dragging the result towards whatever colour it was stored with.
 */
function shrinkingPixel(image: PngImage, column: Region, row: Region): Pixel {
  const [startX, firstX, lastX, endX] = column;
  const [startY, firstY, lastY, endY] = row;
  let weightTotal = 0;
  let alphaTotal = 0;
  const colourTotal: [number, number, number] = [0, 0, 0];

  for (let sourceY = firstY; sourceY <= lastY; sourceY += 1) {
    const weightY = Math.min(endY, sourceY + 1) - Math.max(startY, sourceY);
    for (let sourceX = firstX; sourceX <= lastX; sourceX += 1) {
      const weight = weightY * (Math.min(endX, sourceX + 1) - Math.max(startX, sourceX));
      if (weight <= 0) continue;
      const at = (sourceY * image.width + sourceX) * 4;
      const alpha = image.pixels[at + 3] as number;
      weightTotal += weight;
      alphaTotal += weight * alpha;
      for (let channel = 0; channel < 3; channel += 1) {
        colourTotal[channel] =
          (colourTotal[channel] as number) + weight * (image.pixels[at + channel] as number) * alpha;
      }
    }
  }

  if (weightTotal === 0 || alphaTotal === 0) return [0, 0, 0, 0];
  return [
    Math.round(colourTotal[0] / alphaTotal),
    Math.round(colourTotal[1] / alphaTotal),
    Math.round(colourTotal[2] / alphaTotal),
    Math.round(alphaTotal / weightTotal),
  ];
}

/**
 * One interpolated pixel for a size larger than the source, on at least one axis.
 *
 * The sample point is the middle of the target pixel mapped back into the source — `(i + 0.5) / scale −
 * 0.5` — which is the one placement that leaves the outermost source pixels at the edges rather than half
 * a pixel inside, and the four samples are clamped, so a growing edge repeats the edge instead of fading
 * towards nothing.
 */
function growingPixel(
  image: PngImage,
  targetX: number,
  targetY: number,
  width: number,
  height: number,
): Pixel {
  const sourceX = ((targetX + 0.5) * image.width) / width - 0.5;
  const sourceY = ((targetY + 0.5) * image.height) / height - 0.5;
  const left = Math.min(image.width - 1, Math.max(0, Math.floor(sourceX)));
  const top = Math.min(image.height - 1, Math.max(0, Math.floor(sourceY)));
  const right = Math.min(image.width - 1, left + 1);
  const bottom = Math.min(image.height - 1, top + 1);

  const across = Math.min(1, Math.max(0, sourceX - left));
  const down = Math.min(1, Math.max(0, sourceY - top));
  const corners: [number, number, number, number] = [
    (top * image.width + left) * 4,
    (top * image.width + right) * 4,
    (bottom * image.width + left) * 4,
    (bottom * image.width + right) * 4,
  ];
  const weights: [number, number, number, number] = [
    (1 - across) * (1 - down),
    across * (1 - down),
    (1 - across) * down,
    across * down,
  ];

  let alphaTotal = 0;
  const colourTotal: [number, number, number] = [0, 0, 0];
  for (let corner = 0; corner < 4; corner += 1) {
    const at = corners[corner] as number;
    const weight = weights[corner] as number;
    const alpha = image.pixels[at + 3] as number;
    alphaTotal += weight * alpha;
    for (let channel = 0; channel < 3; channel += 1) {
      colourTotal[channel] =
        (colourTotal[channel] as number) + weight * (image.pixels[at + channel] as number) * alpha;
    }
  }

  if (alphaTotal === 0) return [0, 0, 0, 0];
  return [
    Math.round(colourTotal[0] / alphaTotal),
    Math.round(colourTotal[1] / alphaTotal),
    Math.round(colourTotal[2] / alphaTotal),
    Math.round(alphaTotal),
  ];
}

/**
 * The size an image states, checked against the pixels it carries, before anything reads either.
 *
 * A short `pixels` array is the failure that reads out of bounds rather than throwing on its own, and in a
 * compositor that means a picture assembled from whatever the next allocation happened to hold. Every entry
 * point starts here so that the failure is a message naming the size, not a wrong picture.
 */
function check(image: PngImage): PngImage {
  if (image === null || typeof image !== 'object') {
    throw new Error(
      `an image is an object of { width, height, pixels }; got ${image === null ? 'null' : typeof image}`,
    );
  }
  const { width, height, pixels } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`an image is ${width}x${height}; both sides are whole positive numbers of pixels`);
  }
  if (!(pixels instanceof Uint8Array)) {
    throw new Error('an image holds its pixels in a Uint8Array of RGBA bytes');
  }
  if (pixels.length !== width * height * 4) {
    throw new Error(
      `an image of ${width}x${height} needs ${width * height * 4} RGBA bytes, but holds ${pixels.length}`,
    );
  }
  return { width, height, pixels };
}
