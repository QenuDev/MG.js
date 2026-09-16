/**
 * The vendored artefact is the one that was measured.
 *
 * `assets/basis_transcoder.{js,wasm}` is 585 KB of third-party binary that decides what every decoded pixel
 * is. `assets/basis_transcoder.sha256` records the two digests beside it, and this file recomputes them: a
 * swapped or truncated transcoder fails here, next to the recorded provenance, rather than in a comparison
 * against an oracle whose tolerance would have hidden it.
 *
 * No network. The licence file is checked for the licence it claims to carry, because a vendored artefact
 * without its licence is the one thing an offline test can still catch.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { provenance } from './fixture-files.js';

const ASSETS = fileURLToPath(new URL('../../assets/', import.meta.url));

void test('the vendored transcoder matches the digests recorded beside it', () => {
  const recorded = new Map<string, string>();
  for (const line of readFileSync(`${ASSETS}basis_transcoder.sha256`, 'utf8').split('\n')) {
    const match = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim());
    if (match?.[1] && match[2]) recorded.set(match[2], match[1]);
  }
  assert.deepEqual(
    [...recorded.keys()].sort(),
    ['basis_transcoder.js', 'basis_transcoder.wasm'],
    'the checksum file names exactly the two vendored files',
  );

  for (const [file, digest] of recorded) {
    const bytes = readFileSync(`${ASSETS}${file}`);
    assert.ok(bytes.byteLength > 0, `${file} is not empty`);
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      digest,
      `${file} is not the artefact basis_transcoder.sha256 records`,
    );
  }
});

void test('the provenance records the same digests and byte counts as the files on disk', () => {
  for (const file of provenance.transcoder.files) {
    const bytes = readFileSync(`${ASSETS}${file.file}`);
    assert.equal(bytes.byteLength, file.bytes, `${file.file}: byte count`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, `${file.file}: digest`);
  }
});

void test('the transcoder ships with the licence it is redistributed under', () => {
  const licence = readFileSync(`${ASSETS}basis_transcoder.LICENSE`, 'utf8');
  assert.match(licence, /Apache License/, 'the Apache-2.0 text');
  assert.match(licence, /Version 2\.0, January 2004/, 'the Apache-2.0 text is the real one');
  assert.match(licence, /Basis Universal/, 'the upstream NOTICE Apache-2.0 4(d) requires');
  assert.match(licence, /BSD 3-Clause|BSD License/, "the Zstandard decoder's licence");
  assert.match(licence, /supercompressionScheme = 2/, 'what this build is here for is stated in it');
});

void test('the assets directory holds nothing but the artefact, its checksums and its licence', () => {
  assert.deepEqual(readdirSync(ASSETS).sort(), [
    'basis_transcoder.LICENSE',
    'basis_transcoder.js',
    'basis_transcoder.sha256',
    'basis_transcoder.wasm',
  ]);
});
