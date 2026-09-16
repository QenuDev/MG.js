/**
 * Rebuild `packages/art/fixtures/` from the live game.
 *
 * This is not a test and it is not shipped (`package.json`'s `files` excludes the `*.mjs` here). It is the
 * recorded recipe for the captured fixtures the offline tests read, so that a reader can check what each
 * one is and regenerate it after a game version moves. It is the only thing in this package that touches
 * the network, and it is never run by `npm test`.
 *
 * What it writes, and why each piece is small:
 *
 *   - `sprites-2x-0.pack.json`  one atlas pack's metadata, exactly as the game serves it (33 KB).
 *   - `<slug>.crop.ktx2`        a KTX2 built by cropping the game's own UASTC blocks for the frames under
 *                               test. The game's atlas is 4,856,876 bytes of 4044x4088; a frame's blocks are
 *                               a few thousand. The bytes are the game's, unmodified: UASTC is a 4x4-block
 *                               format, so a block-aligned crop of level 0 is a valid texture on its own.
 *                               Zstandard supercompression is kept, because that is the path the game's own
 *                               file exercises and the one the vendored transcoder has to support.
 *   - `<slug>.oracle.rgba.gz`   the community API's PNG of the same sprite, decoded to raw RGBA and
 *                               gzipped. It is the oracle the tolerance test compares against; it lives
 *                               here and on no runtime path.
 *   - `provenance.json`         every URL, byte count, digest and crop rect behind the above.
 *
 * Usage:
 *   node fixtures/build-fixtures.mjs [--atlas <path-to-ktx2>]
 *
 * The atlas is read from `--atlas`, else from `.logs/art-atlas-fixtures/atlas-2x-0.ktx2` in this workspace,
 * else downloaded. Its digest is checked against `provenance.json` when a record already exists, so a
 * regeneration cannot silently capture a different game build.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, inflateSync, zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
/** Where the workspace keeps a downloaded copy of the atlas. `.logs/` is outside the repo; see `.gitignore`. */
const ATLAS_CACHE = [
  process.env.MG_ART_ATLAS,
  resolve(REPO, '.logs/art-atlas-fixtures/atlas-2x-0.ktx2'),
  resolve(REPO, '../.logs/art-atlas-fixtures/atlas-2x-0.ktx2'),
  resolve(REPO, '../../.logs/art-atlas-fixtures/atlas-2x-0.ktx2'),
].filter(Boolean);
const ORIGIN = 'https://magicgarden.gg';
const COMMUNITY = 'https://mg-api.ariedam.fr';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0';

/** The frames this fixture set captures. The keys are the game's own, checked against the pack below. */
const CAPTURED = [
  { key: 'sprite/animation/NotifyFlag-0', slug: 'notifyflag-0' },
  { key: 'sprite/ui/Thumbtack', slug: 'thumbtack' },
];

const BLOCK = 4;
const BLOCK_BYTES = 16;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fetchBytes(url) {
  const response = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * The community API's oracle PNGs, to raw RGBA.
 *
 * Written here rather than imported: the package's own PNG codec is another commit's job, and reaching
 * into the viewer's checkout for a fixture builder would make this file unrunnable from a fresh clone.
 * It refuses anything but 8-bit RGBA, non-interlaced -- which is what both oracle URLs serve (measured:
 * IHDR bit depth 8, colour type 6, interlace 0) -- because a silent conversion here would corrupt the
 * tolerance test's only independent reference.
 */
function decodePngRgba(png) {
  const signature = '89504e470d0a1a0a';
  if (png.subarray(0, 8).toString('hex') !== signature) throw new Error('not a PNG');
  let at = 8;
  let header = null;
  const data = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString('latin1');
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
    } else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  if (!header) throw new Error('no IHDR');
  if (header.bitDepth !== 8 || header.colorType !== 6 || header.interlace !== 0) {
    throw new Error(
      `unsupported PNG: depth ${header.bitDepth}, colour type ${header.colorType}, interlace ${header.interlace}`,
    );
  }

  const { width, height } = header;
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const raw = inflateSync(Buffer.concat(data));
  const pixels = new Uint8Array(width * height * bytesPerPixel);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prior = y === 0 ? new Uint8Array(stride) : pixels.subarray((y - 1) * stride, y * stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bytesPerPixel ? out[i - bytesPerPixel] : 0;
      const b = prior[i];
      const c = i >= bytesPerPixel ? prior[i - bytesPerPixel] : 0;
      let value = line[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      out[i] = value & 0xff;
    }
  }
  return { width, height, pixels };
}

const u32 = (buf, offset) => buf.readUInt32LE(offset);
const u64 = (buf, offset) => Number(buf.readBigUInt64LE(offset));

function readKtx2Header(buf) {
  if (buf.subarray(0, 12).toString('latin1') !== '\u00abKTX 20\u00bb\r\n\u001a\n') {
    throw new Error('not a KTX2 file');
  }
  const levelCount = u32(buf, 40);
  const levels = [];
  for (let level = 0; level < levelCount; level += 1) {
    const at = 80 + level * 24;
    levels.push({ byteOffset: u64(buf, at), byteLength: u64(buf, at + 8), uncompressed: u64(buf, at + 16) });
  }
  return {
    vkFormat: u32(buf, 12),
    typeSize: u32(buf, 16),
    width: u32(buf, 20),
    height: u32(buf, 24),
    layerCount: u32(buf, 32),
    faceCount: u32(buf, 36),
    levelCount,
    supercompressionScheme: u32(buf, 44),
    dfdByteOffset: u32(buf, 48),
    dfdByteLength: u32(buf, 52),
    levels,
  };
}

/** The blocks for level 0, inflated, plus the geometry a crop needs. */
function readLevel0Blocks(atlas, header) {
  const level = header.levels[0];
  const frame = atlas.subarray(level.byteOffset, level.byteOffset + level.byteLength);
  const raw = header.supercompressionScheme === 2 ? zstdDecompressSync(frame) : frame;
  if (raw.length !== level.uncompressed) {
    throw new Error(`level 0 inflated to ${raw.length} bytes, header says ${level.uncompressed}`);
  }
  return raw;
}

/** A block-aligned rect covering `rect`, and the UASTC blocks inside it, as a standalone KTX2. */
function cropToKtx2(atlas, header, blocks, rect, note) {
  const blocksPerRow = Math.ceil(header.width / BLOCK);
  const blockX0 = Math.floor(rect.x / BLOCK);
  const blockY0 = Math.floor(rect.y / BLOCK);
  const blockX1 = Math.ceil((rect.x + rect.w) / BLOCK);
  const blockY1 = Math.ceil((rect.y + rect.h) / BLOCK);

  const columns = blockX1 - blockX0;
  const rows = blockY1 - blockY0;
  const raw = Buffer.alloc(columns * rows * BLOCK_BYTES);
  for (let row = 0; row < rows; row += 1) {
    const from = ((blockY0 + row) * blocksPerRow + blockX0) * BLOCK_BYTES;
    blocks.copy(raw, row * columns * BLOCK_BYTES, from, from + columns * BLOCK_BYTES);
  }

  const payload = zstdCompressSync(raw);
  const dfd = atlas.subarray(header.dfdByteOffset, header.dfdByteOffset + header.dfdByteLength);
  const kvdText = `KTXwriter\0mg.js art fixtures: block-aligned UASTC crop, ${note}\0`;
  const kvd = Buffer.alloc(4 + Buffer.byteLength(kvdText, 'latin1'));
  kvd.writeUInt32LE(Buffer.byteLength(kvdText, 'latin1'), 0);
  kvd.write(kvdText, 4, 'latin1');

  const dfdOffset = 80 + 24;
  const kvdOffset = dfdOffset + dfd.length;
  const dataOffset = Math.ceil((kvdOffset + kvd.length) / 8) * 8;
  const out = Buffer.alloc(dataOffset + payload.length);
  atlas.copy(out, 0, 0, 12);
  out.writeUInt32LE(header.vkFormat, 12);
  out.writeUInt32LE(header.typeSize, 16);
  out.writeUInt32LE(columns * BLOCK, 20);
  out.writeUInt32LE(rows * BLOCK, 24);
  out.writeUInt32LE(0, 28);
  out.writeUInt32LE(0, 32);
  out.writeUInt32LE(1, 36);
  out.writeUInt32LE(1, 40);
  out.writeUInt32LE(2, 44);
  out.writeUInt32LE(dfdOffset, 48);
  out.writeUInt32LE(dfd.length, 52);
  out.writeUInt32LE(kvdOffset, 56);
  out.writeUInt32LE(kvd.length, 60);
  out.writeBigUInt64LE(0n, 64);
  out.writeBigUInt64LE(0n, 72);
  out.writeBigUInt64LE(BigInt(dataOffset), 80);
  out.writeBigUInt64LE(BigInt(payload.length), 88);
  out.writeBigUInt64LE(BigInt(raw.length), 96);
  dfd.copy(out, dfdOffset);
  kvd.copy(out, kvdOffset);
  payload.copy(out, dataOffset);

  return {
    bytes: out,
    crop: { x: blockX0 * BLOCK, y: blockY0 * BLOCK, w: columns * BLOCK, h: rows * BLOCK },
    blocks: { columns, rows },
    rawBytes: raw.length,
    zstdBytes: payload.length,
  };
}

function parseArgs(argv) {
  const args = { atlas: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--atlas') args.atlas = argv[(i += 1)];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const provenancePath = resolve(HERE, 'provenance.json');
const previous = existsSync(provenancePath) ? JSON.parse(readFileSync(provenancePath, 'utf8')) : null;

const version = JSON.parse((await fetchBytes(`${ORIGIN}/platform/v1/version`)).toString('utf8')).version;
const manifestUrl = `${ORIGIN}/version/${version}/assets/manifest.json`;
const manifest = JSON.parse((await fetchBytes(manifestUrl)).toString('utf8'));

let packPath = null;
for (const bundle of manifest.bundles ?? []) {
  for (const asset of bundle.assets ?? []) {
    const aliases = Array.isArray(asset.alias) ? asset.alias : [asset.alias];
    if (!aliases.includes('atlases/sprites-0.json')) continue;
    const sources = Array.isArray(asset.src) ? asset.src : [asset.src];
    packPath = (sources.find((s) => s?.resolution === 2) ?? sources[0]).src;
  }
}
if (packPath === null) throw new Error(`${manifestUrl} names no atlases/sprites-0.json`);

const packUrl = new URL(packPath, manifestUrl).toString();
const packBytes = await fetchBytes(packUrl);
const pack = JSON.parse(packBytes.toString('utf8'));
const imageUrl = new URL(pack.meta.image, packUrl).toString();

const atlasPath = args.atlas ?? ATLAS_CACHE.find((candidate) => existsSync(candidate)) ?? imageUrl;
const atlas = args.atlas || atlasPath !== imageUrl ? readFileSync(atlasPath) : await fetchBytes(imageUrl);
const atlasDigest = sha256(atlas);
if (previous?.atlas?.sha256 && previous.atlas.sha256 !== atlasDigest) {
  throw new Error(
    `atlas digest ${atlasDigest} does not match the recorded ${previous.atlas.sha256}; ` +
      'the game published a different file than the fixtures were built from',
  );
}
console.log(`atlas ${imageUrl}\n  ${atlas.length} bytes sha256 ${atlasDigest}`);

const header = readKtx2Header(atlas);
const blocks = readLevel0Blocks(atlas, header);
console.log(`  ${header.width}x${header.height} vkFormat ${header.vkFormat}, ${header.levelCount} levels, ` +
  `supercompression ${header.supercompressionScheme}, level 0 ${blocks.length} bytes`);

mkdirSync(HERE, { recursive: true });
writeFileSync(resolve(HERE, 'sprites-2x-0.pack.json'), packBytes);

const frames = {};
for (const { key, slug } of CAPTURED) {
  const frame = pack.frames[key];
  if (!frame) throw new Error(`${packUrl} has no frame ${key}`);
  if (frame.rotated) throw new Error(`${key} is rotated; the crop below assumes blocks are not transposed`);

  const cropped = cropToKtx2(atlas, header, blocks, frame.frame, key);
  writeFileSync(resolve(HERE, `${slug}.crop.ktx2`), cropped.bytes);

  const index = JSON.parse((await fetchBytes(`${COMMUNITY}/assets/sprites`)).toString('utf8'));
  const name = key.split('/').pop();
  let entry = null;
  for (const items of Object.values(index.sprites ?? {})) {
    for (const item of items ?? []) if (item.name === name) entry = item;
  }
  if (!entry) throw new Error(`the community index does not carry ${name}, so there is no oracle for it`);
  const oraclePng = await fetchBytes(entry.url);
  const oracle = decodePngRgba(oraclePng);
  const stated = frame.sourceSize ?? { w: frame.frame.w, h: frame.frame.h };
  if (oracle.width !== stated.w || oracle.height !== stated.h) {
    throw new Error(`${name}: oracle is ${oracle.width}x${oracle.height}, the atlas frame says ${stated.w}x${stated.h}`);
  }
  const oracleRgbaGz = gzipSync(oracle.pixels, { level: 9 });
  writeFileSync(resolve(HERE, `${slug}.oracle.rgba.gz`), oracleRgbaGz);

  frames[key] = {
    slug,
    crop: cropped.crop,
    blockColumns: cropped.blocks.columns,
    blockRows: cropped.blocks.rows,
    cropKtx2Bytes: cropped.bytes.length,
    cropKtx2Sha256: sha256(cropped.bytes),
    rawUastcBytes: cropped.rawBytes,
    zstdBytes: cropped.zstdBytes,
    oracle: {
      url: entry.url,
      pngBytes: oraclePng.length,
      pngSha256: sha256(oraclePng),
      rgbaBytes: oracle.pixels.length,
      file: `${slug}.oracle.rgba.gz`,
      gzipBytes: oracleRgbaGz.length,
      sha256: sha256(oracleRgbaGz),
    },
  };
  console.log(
    `${key}\n  crop ${cropped.crop.w}x${cropped.crop.h} at ${cropped.crop.x},${cropped.crop.y} ` +
      `-> ${cropped.bytes.length} bytes (${cropped.rawBytes} UASTC -> ${cropped.zstdBytes} zstd)\n` +
      `  oracle ${entry.url} ${oraclePng.length} png bytes -> ${oracle.width}x${oracle.height} rgba`,
  );
}

const provenance = {
  note:
    'Written by fixtures/build-fixtures.mjs from the live game and the live community API. Nothing in the ' +
    'tests touches the network; these files are what they read.',
  capturedFrom: { origin: ORIGIN, community: COMMUNITY, gameVersion: version, manifest: manifestUrl },
  pack: {
    alias: 'atlases/sprites-0.json',
    resolution: 2,
    url: packUrl,
    file: 'sprites-2x-0.pack.json',
    bytes: packBytes.length,
    sha256: sha256(packBytes),
    frames: Object.keys(pack.frames).length,
  },
  atlas: {
    url: imageUrl,
    bytes: atlas.length,
    sha256: atlasDigest,
    vkFormat: header.vkFormat,
    typeSize: header.typeSize,
    width: header.width,
    height: header.height,
    layerCount: header.layerCount,
    faceCount: header.faceCount,
    levelCount: header.levelCount,
    supercompressionScheme: header.supercompressionScheme,
    level0: {
      byteOffset: header.levels[0].byteOffset,
      byteLength: header.levels[0].byteLength,
      uncompressed: header.levels[0].uncompressed,
    },
    uastcBlockBytes: BLOCK_BYTES,
    uastcBlockEdge: BLOCK,
  },
  transcoder: {
    files: [
      { file: 'basis_transcoder.js', bytes: readFileSync(resolve(REPO, 'packages/art/assets/basis_transcoder.js')).length, sha256: sha256(readFileSync(resolve(REPO, 'packages/art/assets/basis_transcoder.js'))) },
      { file: 'basis_transcoder.wasm', bytes: readFileSync(resolve(REPO, 'packages/art/assets/basis_transcoder.wasm')).length, sha256: sha256(readFileSync(resolve(REPO, 'packages/art/assets/basis_transcoder.wasm'))) },
    ],
    source: 'Magic-garden-API/src/assets/wasm/ at commit e69bddb, "Added ktx2 format for sprite"',
    licence: 'assets/basis_transcoder.LICENSE (Apache-2.0, plus the Zstandard decoder\'s BSD-3-Clause)',
  },
  frames,
};

writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
console.log(`wrote ${Object.keys(frames).length} crops and ${provenancePath}`);
