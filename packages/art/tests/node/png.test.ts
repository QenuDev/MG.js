/**
 * Test the PNG codec against bytes this file writes by hand.
 *
 * The two claims that matter most cannot be made with a fixture. A file whose scanlines use filter types
 * 1–4 is not something `encodePng` will ever produce, and an image host's own files arrive from a network
 * this test suite does not touch, so the only honest way to check that a filtered stream is read back
 * correctly is to build the stream here: take the pixels, filter them on purpose, and write the chunks with
 * the same CRC the format states. The writer at the top of this file is that, and it is deliberately *not* an
 * import of anything under test — a decoder checked against a writer that shares its arithmetic is checked
 * against its own mistakes.
 *
 * It moved here from `garden-viewer/png.test.mjs` with the codec it covers, assertions unchanged.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import {
  decodePng,
  drawOver,
  encodePng,
  type PngImage,
  pngSize,
  scaled,
  washArt,
} from '../../src/node/index.ts';

/** The eight bytes a PNG begins with. */
const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * CRC-32/ISO-HDLC, written out again here rather than imported.
 *
 * See the note at the top of the file: the point of this test's writer is to disagree with the module when
 * the module is wrong, and it cannot do that if it asks the module to compute its checksums.
 */
function crc32(bytes: Uint8Array): number {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ -1) >>> 0;
}

/** One chunk of `type`, holding `data`, with the CRC over both. */
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/**
 * A whole PNG, from an IHDR's worth of facts and an already-compressed pixel stream.
 *
 * `chunkSizes` is what gives the payload its boundaries: each size is one IDAT chunk, and they have to add
 * up to the payload exactly, since a leftover here would become a chunk of its own and quietly change how
 * many chunks the file holds. `interlace` is a parameter because one refusal test has to hand over a header
 * claiming Adam7, and a header whose bytes came from `encodePng` could not say that.
 */
function writePng({
  width,
  height,
  compressed,
  chunkSizes = [],
  colourType = 6,
  interlace = 0,
}: {
  width: number;
  height: number;
  compressed: Buffer;
  chunkSizes?: number[];
  colourType?: number;
  interlace?: number;
}): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colourType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = interlace;

  // The one payload can be handed over as several IDAT chunks, which is what an image host's own files do:
  // one of them splits it fifteen ways, and a reader that only took the first chunk would show a sliver.
  const pieces: Buffer[] = [];
  let at = 0;
  for (const size of chunkSizes) {
    pieces.push(compressed.subarray(at, at + size));
    at += size;
  }
  if (at < compressed.length) pieces.push(compressed.subarray(at));

  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk('IHDR', ihdr),
    ...pieces.map((piece) => chunk('IDAT', piece)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A copy of an image, so a test can compare against what it handed in after the original was mutated. */
function copyOf(image: PngImage): PngImage {
  return { width: image.width, height: image.height, pixels: image.pixels.slice() };
}

/** Whether two images hold the same size and the same pixels. */
function samePixels(actual: PngImage, expected: PngImage): boolean {
  return (
    actual.width === expected.width &&
    actual.height === expected.height &&
    Buffer.from(actual.pixels).equals(Buffer.from(expected.pixels))
  );
}

/**
 * Compare an image to RGBA pixels written out as literals, one row per line.
 *
 * A scaled picture is read a pixel at a time and the failure is always in one part of it, so the expected
 * value is written the way the picture is laid out rather than as a flat run of numbers.
 */
function expectPixels(actual: PngImage, rows: number[][]): void {
  const expected = rows.flat();
  assert.equal(actual.pixels.length, expected.length, 'the image is the size its rows say');
  assert.deepEqual(Array.from(actual.pixels), expected, 'every pixel is the one the arithmetic gives it');
}

/**
 * The four pixels of a tiny picture whose colours, alphas and filter arithmetic all differ.
 *
 * Varied on purpose: a round trip through the wrong filter, or through arithmetic that premultiplies by
 * accident, agrees with the input on a flat image and parts company here. Two of the four are the extremes
 * the compositor has to carry without special-casing them — alpha 0 and alpha 255.
 */
const VARIED: PngImage = {
  width: 2,
  height: 2,
  pixels: Uint8Array.from([
    255,
    0,
    0,
    255, // opaque red
    0,
    255,
    0,
    128, // half-transparent green
    0,
    0,
    255,
    0, // fully transparent, and its colour must survive as written
    255,
    255,
    255,
    255, // opaque white
  ]),
};

/** One scanline filter: the byte it predicts for `index`, from the row so far and the row above. */
type Filter = (row: Uint8Array, index: number, above: Uint8Array | null) => number;

/**
 * Every filter type forward, keyed by its number, so a filtered stream can be built by hand.
 *
 * `row` is the reconstructed bytes of the row being filtered, laid out without the type byte that leads it,
 * and `index` is a byte position in it. The byte above a pixel is `index - stride` in the *previous* row,
 * which is why the caller is handed both rows.
 *
 * What a filter predicts from is what the pixel actually was, not the filtered bytes in the file. The
 * distinction does not show up for `Sub`, whose one neighbour is already last in the same row, but
 * `Average` and `Paeth` mix a left neighbour with one from above: a table built on the filtered bytes would
 * predict correctly only where one of its terms is zero, which is where it would also look right.
 *
 * `bpp` is 4, since the only depth here is 8-bit RGBA, and the left and above of the first pixel and the
 * first row are the zero the format's own diagrams start from.
 */
const FILTERS: Record<number, Filter> = {
  0: () => 0,
  1: (row, index) => (index >= 4 ? (row[index - 4] as number) : 0),
  2: (_row, index, above) => (above === null ? 0 : (above[index] as number)),
  3: (row, index, above) => {
    const left = index >= 4 ? (row[index - 4] as number) : 0;
    return (left + (above === null ? 0 : (above[index] as number))) >> 1;
  },
  4: (row, index, above) => {
    const left = index >= 4 ? (row[index - 4] as number) : 0;
    const up = above === null ? 0 : (above[index] as number);
    const upperLeft = above !== null && index >= 4 ? (above[index - 4] as number) : 0;
    const estimate = left + up - upperLeft;
    const toLeft = Math.abs(estimate - left);
    const toAbove = Math.abs(estimate - up);
    const toUpperLeft = Math.abs(estimate - upperLeft);
    if (toLeft <= toAbove && toLeft <= toUpperLeft) return left;
    return toAbove <= toUpperLeft ? up : upperLeft;
  },
};

/** The five filters by their number, which is the byte a scanline carries to say which one it used. */
const FILTER_NAMES: Record<number, string> = { 0: 'none', 1: 'sub', 2: 'up', 3: 'average', 4: 'paeth' };

/**
 * The image's scanlines with `type` applied to every one of them, compressed into an IDAT payload.
 *
 * `row` holds the row's bytes as they are reconstructed, so the byte after any byte can predict against it;
 * the row above arrives as an argument rather than as the same array at a lower offset, which is where an
 * implementation of this tends to go wrong without noticing.
 */
function filterStream(image: PngImage, type: number): Buffer {
  const width = image.width * 4;
  const raw = Buffer.alloc((width + 1) * image.height);
  const filter = FILTERS[type] as Filter;
  let above: Uint8Array | null = null;
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (width + 1)] = type;
    const row = new Uint8Array(width);
    for (let index = 0; index < width; index += 1) {
      const value = image.pixels[y * width + index] as number;
      const predicted = filter(row, index, above);
      raw[y * (width + 1) + 1 + index] = (value - predicted + 256) & 0xff;
      row[index] = value;
    }
    above = row;
  }
  return deflateSync(raw);
}

/**
 * The image as a PNG whose IDAT payload is carried in exactly `count` chunks, none of them empty.
 *
 * The payload is handed over as a whole stream and cut by the sizes, and the sizes have to add up to it
 * exactly: a size list that stops short leaves the last piece to be taken as a remainder, which is one
 * chunk more than was asked for — a mistake that still produces a valid PNG, and so one a test has to make
 * impossible to hide.
 */
function pngSplitInto(image: PngImage, count: number): Buffer {
  const bytes = encodePng(image);
  // Only the payload's boundaries move, so the pieces are taken from the one chunk `encodePng` wrote rather
  // than the stream being recompressed.
  let at = 8;
  while (bytes.readUInt32BE(at + 4) !== 0x49444154) at += bytes.readUInt32BE(at) + 12;
  const payload = bytes.subarray(at + 8, at + 8 + bytes.readUInt32BE(at));

  const chunks = Math.max(1, Math.min(count, payload.length));
  // Each chunk takes the bytes up to the next boundary, at most one more than an even share and never more
  // than the payload has left for the chunks after it.
  const sizes = Array.from({ length: chunks }, (_, index) =>
    Math.min(Math.ceil(payload.length / chunks), payload.length - (chunks - index - 1)),
  );
  return writePng({ width: image.width, height: image.height, compressed: payload, chunkSizes: sizes });
}

/** The IDAT payload of the PNG `encodePng` writes for an image, which is what a split moves around. */
function payloadBytes(image: PngImage): Buffer {
  const bytes = encodePng(image);
  let at = 8;
  while (bytes.readUInt32BE(at + 4) !== 0x49444154) at += bytes.readUInt32BE(at) + 12;
  return bytes.subarray(at + 8, at + 8 + bytes.readUInt32BE(at));
}

/**
 * A picture with a different fact in every pixel, so one wrong byte lands somewhere visible.
 *
 * Laid out so that the top-left is red, the top-right is green, the bottom-left is blue and the bottom-right
 * is white: each composited pixel below can be named rather than compared to a table of numbers.
 */
const QUADRANTS: PngImage = {
  width: 2,
  height: 2,
  pixels: Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]),
};

/**
 * An eight-by-eight of pixels that have nothing to do with each other, so it compresses to a long payload.
 *
 * A flat picture deflates to a few bytes, and a payload with fewer bytes than there are chunks to cut it into
 * cannot be split the way an image host's files are. The pattern is a small linear congruential sequence
 * seeded with a constant rather than a random number, so a run of this file is the same run every time, and
 * the alpha varies with it so that a split stream that loses bytes loses visible ones.
 */
const NOISE: PngImage = (() => {
  const pixels = new Uint8Array(8 * 8 * 4);
  let state = 0x2f6e2b1;
  for (let at = 0; at < pixels.length; at += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    pixels[at] = (state >>> 16) & 0xff;
  }
  return { width: 8, height: 8, pixels };
})();

/**
 * A picture is written and read back exactly as it went in.
 *
 * This is the whole reason the writer filters every scanline with type 0: the round trip is only exact if
 * both ends agree about what the bytes mean, and a codec whose decoder reads the buffer its own encoder
 * wrote is the first thing that has to hold before anything is composited.
 */
void test('a picture survives being written as a PNG and read back', () => {
  const decoded = decodePng(encodePng(VARIED));
  assert.ok(samePixels(decoded, VARIED), 'the pixels come back exactly as they were written');
});

/**
 * A transparent pixel keeps the colour it was written with.
 *
 * There is no such thing as the colour of a pixel that is not there, so it is tempting to zero it on the
 * way through — but the file states one, the round trip's contract is to give back what went in, and
 * compositing is the operation that is supposed to decide what a transparent colour is worth.
 */
void test('a fully transparent pixel comes back with its own colour intact', () => {
  const decoded = decodePng(encodePng(VARIED));
  assert.deepEqual(
    Array.from(decoded.pixels.slice(8, 12)),
    [0, 0, 255, 0],
    'the transparent pixel is unchanged',
  );
});

/**
 * Every filter type the format defines is reversed.
 *
 * Five filters exist, and a decoder that handles only the one its own encoder writes works perfectly on
 * files it wrote itself and mangles every sprite an image host serves. Each stream here is built by
 * filtering the real pixels on purpose and writing the chunks by hand, so the type byte in the file is
 * genuinely 1, 2, 3 or 4 — the only way to get such a file without shipping one.
 */
for (const type of [0, 1, 2, 3, 4]) {
  void test(`a scanline filtered with type ${type} (${FILTER_NAMES[type]}) is undone`, () => {
    const bytes = writePng({
      width: VARIED.width,
      height: VARIED.height,
      compressed: filterStream(VARIED, type),
    });
    const decoded = decodePng(bytes);
    assert.ok(
      samePixels(decoded, VARIED),
      `the ${FILTER_NAMES[type]} filter is reversed to the pixels that produced it`,
    );
  });
}

/**
 * Every IDAT chunk is read, not just the first.
 *
 * A PNG may hold its compressed stream in as many chunks as it likes; an image host's own files use up to
 * fifteen. Joining them is what makes the difference between a whole sprite and the first fifteen bytes of
 * one, so the same payload is written split and whole and both have to decode to the same picture. The
 * picture is noisy rather than flat because a flat one compresses to a handful of bytes, and a payload
 * shorter than the chunk count cannot be split into that many chunks at all.
 */
void test('a picture whose IDAT is split across several chunks decodes whole', () => {
  const decoded = decodePng(pngSplitInto(NOISE, 15));
  assert.ok(
    samePixels(decoded, NOISE),
    'the chunks are joined before inflating, so nothing is lost between them',
  );
});

/**
 * The split is real: the file really does carry fifteen IDAT chunks of one byte or more.
 *
 * The test above would pass on a file with one chunk, which would make it a test of nothing. This reads the
 * chunk list back out of the bytes it wrote, so the claim that a split file decodes is a claim about a file
 * that is actually split — and a chunk of nothing would not count, because fifteen chunks is what an image
 * host's own files hold rather than fourteen and an empty one.
 */
void test('the split picture really is split fifteen ways', () => {
  const bytes = pngSplitInto(NOISE, 15);
  const sizes: number[] = [];
  for (let at = 8; at + 8 <= bytes.length; at += bytes.readUInt32BE(at) + 12) {
    if (bytes.toString('latin1', at + 4, at + 8) === 'IDAT') sizes.push(bytes.readUInt32BE(at));
  }
  assert.equal(sizes.length, 15, 'the payload is carried in fifteen chunks');
  assert.ok(
    sizes.every((size) => size > 0),
    'and no chunk of it is empty',
  );
  // A file whose first chunk held everything and whose last fourteen held nothing would pass the two checks
  // above, so the payload has to be spread across them rather than parked in one.
  const even = Math.ceil(payloadBytes(NOISE).length / 15);
  assert.ok(
    sizes.every((size) => size <= even),
    'and the bytes are spread across the fifteen, not parked in one',
  );
});

/**
 * A file that is not RGBA is refused by name, not decoded into nonsense.
 *
 * Colour type 3 is an indexed PNG, whose pixel bytes are palette entries: read as RGBA they are a plausible
 * looking picture built out of nothing but the wrong numbers, which is exactly the failure that has to be a
 * message instead.
 */
void test('an indexed PNG is refused with the colour type it actually is', () => {
  const bytes = writePng({
    width: 1,
    height: 1,
    compressed: deflateSync(Buffer.from([0, 0])),
    colourType: 3,
  });
  assert.throws(
    () => decodePng(bytes),
    /indexed.*colour type 6/s,
    'the refusal names what it found and what it reads',
  );
});

/**
 * An interlaced PNG is refused rather than decoded as though it were not.
 *
 * Adam7 stores each scanline in up to seven passes, so an interlaced stream read as a flat one is not a
 * smaller picture or a garbled one — it is a different picture, laid out row by row from the first pass
 * onwards. Nothing here can carry that out, so the file says so instead of drawing something.
 */
void test('an interlaced PNG is refused', () => {
  const bytes = writePng({
    width: VARIED.width,
    height: VARIED.height,
    compressed: filterStream(VARIED, 0),
    interlace: 1,
  });
  assert.throws(() => decodePng(bytes), /interlac/i, 'the refusal is about interlacing');
});

/**
 * A file with no IHDR is refused, because nothing about it can be trusted.
 *
 * The header is where the size and the format come from; without it the remaining bytes cannot even be said
 * to be pixels, and a decoder that pressed on would be inventing the shape of the picture.
 */
void test('a PNG with no IHDR is refused', () => {
  const bytes = Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  assert.throws(() => decodePng(bytes), /no IHDR/, 'the refusal is about the missing header');
});

/**
 * A layer laid down at a positive offset covers the base where it lands and leaves the rest alone.
 *
 * The covered pixel is checked as the layer's colour arriving where a *different* colour already was, which
 * is the state a composite is visible in at all: an opaque cyan over a green base is cyan, and a compositor
 * that forgot to read the base, or wrote a whole row instead of the covered part of one, parts company here.
 * The pixels the layer does not reach are compared to what they were, because quietly erasing the tile
 * beneath is the other way this goes wrong.
 */
void test('a layer at a positive offset composites over the base and stops at its own edge', () => {
  const base = copyOf(QUADRANTS);
  const layer: PngImage = { width: 1, height: 1, pixels: Uint8Array.from([0, 255, 255, 255]) };
  drawOver(base, layer, 1, 0);

  assert.deepEqual(
    Array.from(base.pixels.slice(4, 8)),
    [0, 255, 255, 255],
    'the covered pixel is the layer, arriving over the green that was there',
  );
  assert.deepEqual(
    Array.from(base.pixels.slice(0, 4)),
    [255, 0, 0, 255],
    'the pixel to the left of the layer is untouched',
  );
  assert.deepEqual(
    Array.from(base.pixels.slice(8, 12)),
    [0, 0, 255, 255],
    'the pixel below is untouched, so the layer covered one pixel and not one row',
  );
});

/**
 * A half-transparent layer over a base shows both, and the result is the source-over arithmetic.
 *
 * The one case the opaque layer above cannot check: a pixel that is half one colour and half another. Half a
 * green over an opaque red keeps all of the green and the half of the red the layer did not cover, at an
 * alpha that fills the pixel — and it is checked here rather than against a remembered value because the two
 * halves do not come out even: the green lands on 128 and the red on 127, which is the rounding the
 * arithmetic is stated in rather than a colour that replaced a colour.
 */
void test('a half-transparent layer over a base keeps half of each', () => {
  const base = copyOf(QUADRANTS);
  drawOver(base, { width: 1, height: 1, pixels: Uint8Array.from([0, 255, 0, 128]) }, 0, 0);
  assert.deepEqual(
    Array.from(base.pixels.slice(0, 4)),
    [127, 128, 0, 255],
    'both colours are in the covered pixel, and its alpha is full',
  );
});

/**
 * Both pixels on the two layers are half-transparent, and the result is still the formula as stated.
 *
 * Every other composite test here keeps one side opaque or empty, which is exactly the arrangement that hides
 * a wrong constant in the arithmetic: with an opaque base the base's term is the only one left and it cancels
 * the error, and with an opaque layer there is no base term to get wrong at all. The values below were taken
 * from the formula written out in fractions, so this pins the byte form to it rather than to itself.
 */
void test('a half-transparent layer over a half-transparent base uses both alphas', () => {
  const base: PngImage = { width: 1, height: 1, pixels: Uint8Array.from([240, 50, 90, 180]) };
  drawOver(base, { width: 1, height: 1, pixels: Uint8Array.from([10, 200, 30, 100]) }, 0, 0);
  assert.deepEqual(
    Array.from(base.pixels),
    [130, 122, 61, 209],
    'the layer is weighted by 100, the base by 180 and by what the layer left of it, over the alpha they land at',
  );
});

/**
 * A layer hanging off the top-left is clipped, and what falls outside the base is not written.
 *
 * Mutation art is anchored at a point inside the crop's art and can overhang the top and the left, so a
 * negative offset is a case that happens rather than a malformed call. Two things have to hold at once: the
 * covered pixel is the correct composite of the correct layer pixel, and the base is still the length it
 * was — a layer drawn at (-1, -1) that indexed itself from zero would write its bottom-right pixel into the
 * base's first and quietly move the picture by one.
 */
void test('a layer hanging off the top-left is clipped to the base', () => {
  const base = copyOf(QUADRANTS);
  const before = base.pixels.length;
  // Only the layer's own bottom-right pixel is opaque, so anything drawn at all beyond it is visible.
  const layer: PngImage = {
    width: 2,
    height: 2,
    pixels: Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 20, 30, 255]),
  };
  drawOver(base, layer, -1, -1);

  assert.deepEqual(
    Array.from(base.pixels.slice(0, 4)),
    [10, 20, 30, 255],
    "the base's first pixel takes the layer's last",
  );
  assert.deepEqual(
    Array.from(base.pixels.slice(4, 16)),
    [0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255],
    'the rest of the base is what it was, including where the layer fell outside it',
  );
  assert.equal(base.pixels.length, before, 'clipping changes which pixels are written, never how many exist');
});

/**
 * A transparent layer pixel leaves the base exactly as it was, alpha and all.
 *
 * This is the case that separates compositing from averaging. Source-over of nothing is the base, so a
 * half-transparent base pixel under a transparent layer pixel stays half-transparent — a result which
 * arithmetic that blended the two alphas would get wrong.
 */
void test('a transparent part of a layer leaves the base alone', () => {
  const base = copyOf(QUADRANTS);
  const layer: PngImage = { width: 1, height: 1, pixels: Uint8Array.from([255, 0, 255, 0]) };
  drawOver(base, layer, 0, 0);
  assert.deepEqual(
    Array.from(base.pixels.slice(0, 4)),
    [255, 0, 0, 255],
    'an opaque base is not dimmed by a layer that is not there',
  );
});

/**
 * Shrinking by a whole factor averages the whole area each pixel covers.
 *
 * A four-by-four of black and white columns taken to one pixel is the case that tells an average apart from
 * a sample: point sampling returns whichever column it happened to land on — black or white — and only an
 * area average returns the mid-grey that is actually there. The columns are whole, so the arithmetic is
 * exact and the expected value is exactly (2040/16, rounded) = 128.
 */
void test('shrinking a black and white checkerboard to one pixel gives mid-grey', () => {
  const pixels = new Uint8Array(4 * 4 * 4);
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      const at = (y * 4 + x) * 4;
      const level = x < 2 ? 0 : 255;
      pixels[at] = level;
      pixels[at + 1] = level;
      pixels[at + 2] = level;
      pixels[at + 3] = 255;
    }
  }
  const small = scaled({ width: 4, height: 4, pixels }, 1, 1);
  assert.deepEqual(
    Array.from(small.pixels),
    [128, 128, 128, 255],
    'eight white and eight black pixels average to mid-grey',
  );
});

/**
 * Shrinking by a factor that is not whole weights pixels by how much of them is covered.
 *
 * Three pixels across into two cannot divide evenly, so the left target pixel covers all of the first source
 * pixel and half of the second, and the right one covers the other half and all of the third. An area
 * average has to weight by that half; a scheme that rounds the coverage to a whole pixel gets one of the two
 * targets wrong, and both are checked.
 */
void test('shrinking three pixels into two weights the half-covered pixel by its half', () => {
  const image: PngImage = {
    width: 3,
    height: 1,
    pixels: Uint8Array.from([0, 0, 0, 255, 255, 255, 255, 255, 100, 100, 100, 255]),
  };
  const small = scaled(image, 2, 1);
  assert.deepEqual(
    Array.from(small.pixels),
    [85, 85, 85, 255, 152, 152, 152, 255],
    'each target is the average of the source it covers, the middle pixel split between them',
  );
});

/**
 * Shrinking by a factor that is the same on both axes covers every source pixel by area, exactly.
 *
 * The arithmetic here is exact and the expected bytes were worked out from the source by hand, not by the
 * module: a 12×9 of integer colours into a 5×4, where each target pixel covers a 12/5 by 9/4 block of the
 * source. That is the case a sprite hits whenever it is scaled to a tile — `290/66` is not a whole number
 * either — and the place a shrink that samples points instead of averaging areas goes wrong, by dropping
 * whole rows and columns and leaving whatever the sample landed on.
 */
void test('shrinking by a non-whole factor on both axes averages every source area exactly', () => {
  const source: PngImage = { width: 12, height: 9, pixels: new Uint8Array(12 * 9 * 4) };
  for (let y = 0; y < 9; y += 1) {
    for (let x = 0; x < 12; x += 1) {
      const at = (y * 12 + x) * 4;
      source.pixels[at] = x * 20; // red rises to the right
      source.pixels[at + 1] = y * 25; // green rises downwards
      source.pixels[at + 2] = 40; // and blue is the same everywhere
      source.pixels[at + 3] = 255;
    }
  }
  const small = scaled(source, 5, 4);
  expectPixels(small, [
    [15, 17, 40, 255],
    [62, 17, 40, 255],
    [110, 17, 40, 255],
    [158, 17, 40, 255],
    [205, 17, 40, 255],
    [15, 72, 40, 255],
    [62, 72, 40, 255],
    [110, 72, 40, 255],
    [158, 72, 40, 255],
    [205, 72, 40, 255],
    [15, 128, 40, 255],
    [62, 128, 40, 255],
    [110, 128, 40, 255],
    [158, 128, 40, 255],
    [205, 128, 40, 255],
    [15, 183, 40, 255],
    [62, 183, 40, 255],
    [110, 183, 40, 255],
    [158, 183, 40, 255],
    [205, 183, 40, 255],
  ]);
});

/**
 * Growing interpolates rather than repeating the nearest source pixel.
 *
 * Doubling a two-by-two leaves the four source pixels in the corners and asks what lies between them. An
 * interpolation answers with values between the two colours; nearest-neighbour answers with one colour or
 * the other and nothing in between, so the value at a half-way point is the whole claim.
 */
void test('growing interpolates the values between the source pixels', () => {
  const image: PngImage = {
    width: 2,
    height: 1,
    pixels: Uint8Array.from([0, 0, 0, 255, 100, 100, 100, 255]),
  };
  const large = scaled(image, 4, 1);
  assert.deepEqual(
    Array.from(large.pixels.slice(4, 8)),
    [25, 25, 25, 255],
    'a quarter of the way across is a quarter of the way between the two colours',
  );
  assert.deepEqual(
    Array.from(large.pixels.slice(8, 12)),
    [75, 75, 75, 255],
    'and three quarters across is three quarters between them, so the ramp is a ramp',
  );
});

/**
 * A fully transparent source pixel contributes no alpha, and no colour either.
 *
 * Straight-alpha arithmetic that blended the colour bytes directly would take the colour of a pixel that is
 * not there and pull its neighbours towards it, which is the halo every sprite edge grows. The transparent
 * pixel here is black, so that halo would be a darkening of the white beside it — and the alpha it lands at
 * is checked too, because a growing edge that faded towards nothing would be the same mistake made in the
 * other channel.
 */
void test('a transparent source pixel does not darken the neighbours it interpolates with', () => {
  const image: PngImage = {
    width: 2,
    height: 1,
    pixels: Uint8Array.from([255, 255, 255, 255, 0, 0, 0, 0]),
  };
  const large = scaled(image, 4, 1);
  assert.deepEqual(
    Array.from(large.pixels.slice(4, 8)),
    [255, 255, 255, 191],
    'the white stays white, at the alpha it covers',
  );
  assert.deepEqual(
    Array.from(large.pixels.slice(8, 12)),
    [255, 255, 255, 64],
    'and the next pixel is still white, with less of it',
  );
});

/**
 * Asking for the size an image already is hands back the same pixels, and a copy of them.
 *
 * The size is the common case — a sprite used at its own scale — and it must not go through the averaging
 * arithmetic, which would leave every value where it was found but cost a pass over the pixels to do it.
 * They are a copy, so a caller that writes into the result of a no-op resize cannot find itself mutating
 * the picture it passed in.
 */
void test('scaling to the size an image already is returns its pixels unchanged', () => {
  const image = copyOf(QUADRANTS);
  const same = scaled(image, image.width, image.height);
  assert.ok(samePixels(same, image), 'the pixels are the ones that went in');
  same.pixels[0] = 0;
  assert.equal(image.pixels[0], 255, 'and they are a copy, so writing to them does not reach the input');
});

/**
 * An image that is not a whole number of pixels is refused before anything reads it.
 *
 * A short pixel array is the failure that reads out of bounds rather than throwing on its own: the reading
 * code gets undefined, `undefined + 1` is NaN, and the composited picture has a hole in it that no assertion
 * downstream would name. The check counts the bytes instead, so the message can say which is wrong.
 */
void test('an image whose pixels do not match its size is refused', () => {
  assert.throws(
    () => encodePng({ width: 4, height: 4, pixels: new Uint8Array(16) }),
    /needs 64 RGBA bytes, but holds 16/,
    'the refusal states the size and the bytes it found',
  );
});

/**
 * The size a file states in its header is read without inflating or unfiltering anything.
 *
 * This is the whole point of the function: an atlas index states a URL and nothing about the file's size, and
 * measuring it costs a ranged read of the first bytes rather than a decode. The PNG below carries an IDAT
 * that is not a pixel stream at all, so a call that touched it would fail rather than answer.
 */
void test('a PNG states its size in its header, and that is all pngSize reads', () => {
  const bytes = writePng({ width: 3, height: 2, compressed: Buffer.from([0xde, 0xad, 0xbe, 0xef]) });
  assert.deepEqual(
    pngSize(bytes),
    { width: 3, height: 2 },
    'the IHDR says 3x2, and nothing else has to be read',
  );
});

/**
 * A file too short to hold a header is refused, rather than answering with a size of nothing.
 *
 * The loader that wants `{ width: 0, height: 0 }` for a file it could not measure is the one that decides
 * that; a codec returning a sentinel would be stating a size no file declared.
 */
void test('a file too short to state a size is refused', () => {
  assert.throws(
    () => pngSize(Buffer.alloc(8)),
    /states its size in its first 24 bytes, and this is 8 bytes/,
    'the refusal names what it was handed',
  );
});

/**
 * A file whose size is not in an IHDR is refused, and the message names what is there instead.
 *
 * The bytes at 12–16 are a chunk's *type*, so a file that is not what it claims shows up there as whatever
 * chunk it really leads with.
 */
void test('a PNG that does not lead with an IHDR is refused', () => {
  const bytes = Buffer.concat([Buffer.from(SIGNATURE), chunk('IDAT', Buffer.alloc(0)), Buffer.alloc(20)]);
  assert.throws(
    () => pngSize(bytes),
    /IHDR chunk, and byte 12 of this file is IDAT/,
    'the refusal names the chunk it found',
  );
});

/** A file that does not begin with the signature is not a PNG, and no part of its header is believed. */
void test('a file with no PNG signature is refused by pngSize', () => {
  assert.throws(
    () => pngSize(Buffer.alloc(24)),
    /does not begin with the PNG signature/,
    'the refusal is about the signature',
  );
});

/**
 * A wash mixes the flat colour into every pixel that is there, and leaves the alpha alone.
 *
 * The mix is stated as a fraction of the flat colour: half a blue into an opaque red is `255/2` in the red
 * and `255/2` in the blue, each rounded once, which is 128 and not 127 or 255.
 */
void test('a wash mixes its flat colour into the pixels', () => {
  const red: PngImage = { width: 1, height: 1, pixels: Uint8Array.from([255, 0, 0, 255]) };
  const washed = washArt(red, ['rgba(0, 0, 255, 0.5)']);
  assert.deepEqual(
    Array.from(washed.pixels),
    [128, 0, 128, 255],
    'half of the blue is in it, and its alpha is untouched',
  );
  assert.deepEqual(
    Array.from(red.pixels),
    [255, 0, 0, 255],
    'and the image it was handed is not what it wrote into',
  );
});

/**
 * A pixel that is not there is not washed, and keeps the colour it was stored with.
 *
 * Alpha is what the filter leaves alone, so a transparent pixel stays exactly as it was — colour included,
 * because the round trip above is the operation that decided what that colour means.
 */
void test('a transparent pixel is left out of the wash', () => {
  const image: PngImage = {
    width: 2,
    height: 1,
    pixels: Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 0]),
  };
  const washed = washArt(image, ['rgba(0, 255, 0, 1)']);
  assert.deepEqual(
    Array.from(washed.pixels),
    [0, 255, 0, 255, 0, 0, 255, 0],
    'the opaque pixel takes all of the green, and the transparent one is untouched',
  );
});

/**
 * Two washes are taken in order, each mixing into the result of the last.
 *
 * The order matters and the expected value says so: half a white into black is 128, and half a black into
 * that is 64; the other order gives 128, because the black it starts with has nothing to move. A stack of
 * washes that was applied in any order, or from the original pixels each time, would land on one of the two
 * numbers and not the other.
 */
void test('two washes stack in the order they are given', () => {
  const black: PngImage = { width: 1, height: 1, pixels: Uint8Array.from([0, 0, 0, 255]) };
  assert.deepEqual(
    Array.from(washArt(black, ['rgba(255, 255, 255, 0.5)', 'rgba(0, 0, 0, 0.5)']).pixels),
    [64, 64, 64, 255],
    'the second wash mixes into what the first left',
  );
  assert.deepEqual(
    Array.from(washArt(black, ['rgba(0, 0, 0, 0.5)', 'rgba(255, 255, 255, 0.5)']).pixels),
    [128, 128, 128, 255],
    'and the reverse order gives the other number, so the order is really the order',
  );
});

/** No washes is nothing to do, so the image comes back as it was rather than as a copy. */
void test('no washes hands the image straight back', () => {
  const image = copyOf(QUADRANTS);
  assert.equal(washArt(image, []), image, 'the same image, not a copy of it');
});

/** A wash is a pixel operation like any other, so it refuses an image whose pixels do not match its size. */
void test('a wash refuses an image that is not the size it states', () => {
  assert.throws(
    () => washArt({ width: 4, height: 4, pixels: new Uint8Array(16) }, ['rgba(0, 0, 0, 0.5)']),
    /needs 64 RGBA bytes, but holds 16/,
    'the refusal states the size and the bytes it found',
  );
});
