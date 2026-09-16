/**
 * The same predicates over the game's real 121 chunks, when this workspace still has them.
 *
 * The committed fixture is a *cut* of two chunks, and the whole claim of this package is that reading the cut
 * gives the same answer as reading the game. This test is the proof, and it is the one test here that needs the
 * 10.7 MB capture rather than the fixture -- so it warns and skips when the capture is not on this machine
 * instead of failing, the way `tests/purity.test.ts` skips before `tsc -b` has built anything. CI has the
 * fixture; a developer with the cache gets the stronger assertion.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { extractArtTables } from '../../src/bundle/extract.ts';
import { projectChunk } from '../../src/bundle/tools/typescript-reader.ts';
import { FIXTURE_DIR, loadFixture } from './load-fixture.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

/** Where this workspace keeps a captured bundle, and where the environment may point instead. */
const CANDIDATES = [
  process.env['MG_ART_BUNDLE_DIR'],
  resolve(repoRoot, '../../../../../../mgafk-pi/json/bundle-1176-0'),
  resolve(repoRoot, '../../mgafk-pi/json/bundle-1176-0'),
  resolve(repoRoot, '../mgafk-pi/json/bundle-1176-0'),
].filter((candidate): candidate is string => candidate !== undefined);

const bundle = CANDIDATES.find((candidate) => existsSync(candidate));

if (bundle === undefined) {
  console.warn(
    `\n[mg.js] WARNING: no captured v1176 bundle found (looked in ${CANDIDATES.join(', ')}), so the ` +
      'full-bundle agreement test is SKIPPED. Set MG_ART_BUNDLE_DIR to run it.\n',
  );
} else {
  const fixture = loadFixture();

  void test(`the predicates agree with the fixture over the game's own chunks (${bundle})`, () => {
    const files = readdirSync(bundle).filter((name) => name.endsWith('.js'));
    assert.equal(files.length, 121, 'the captured bundle is not the 121 chunks this fixture was cut from');
    const chunks = files.map((name) => projectChunk(name, readFileSync(resolve(bundle, name), 'utf8')));
    const { tables, evidence } = extractArtTables(chunks);
    assert.deepEqual(tables, fixture.tables, 'the fixture and the bundle disagree about the tables');
    assert.deepEqual(evidence, fixture.evidence, 'the fixture and the bundle disagree about the evidence');
  });

  void test('the capture states the version the fixture was cut from', () => {
    const manifest = JSON.parse(readFileSync(resolve(bundle, 'capture-manifest.json'), 'utf8')) as {
      gameVersion: string;
      chunkCount: number;
    };
    assert.equal(manifest.gameVersion, fixture.manifest.sources.gameVersion);
    assert.equal(manifest.chunkCount, 121);
  });

  void test('the fixture directory and the bundle name the same chunks', () => {
    const chunks = readdirSync(bundle).filter((name) => name.endsWith('.js'));
    for (const file of fixture.manifest.files) {
      assert.ok(chunks.includes(file.chunk), `${file.chunk} is not in the capture`);
    }
    assert.ok(existsSync(FIXTURE_DIR));
  });
}
