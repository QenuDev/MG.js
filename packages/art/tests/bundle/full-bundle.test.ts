/**
 * The same predicates over the game's real 121 chunks, when this workspace still has them.
 *
 * The committed fixture is a *cut* of two chunks, and the whole claim of this package is that reading the cut
 * gives the same answer as reading the game. This test is the proof, and it is the one test here that needs the
 * 10.7 MB capture rather than the fixture.
 *
 * So it skips when the capture is not on this machine -- but it skips **by name**, on all three tests. It used
 * to return early with a `console.warn`, which was worse than it looked: the file then registered as a single
 * `ok` line named after its own path, the summary said `# skipped 0`, and nothing distinguished "the package
 * agrees with the game" from "nobody asked the game". Measured both ways before the change, `npm test -w
 * @mg.js/art` printed `# tests 208` with no capture and `# tests 210` with one, and only the second run's
 * output contained the three names below.
 *
 * `MG_ART_BUNDLE_DIR` is an override rather than a preference: when it is set it is the only candidate, because
 * a misspelled path must not quietly verify a different capture than the one that was named.
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
const repoRoot = resolve(here, '../../../..');

/**
 * Where this workspace keeps a captured bundle.
 *
 * The second candidate is the layout the default had all along, `../../mgafk-pi` from the monorepo root, and it
 * pointed one directory too far out: the capture sits at `MG/mgafk-pi`, beside the monorepo rather than beside
 * the workspace that holds it. Both are listed, so either layout finds it.
 */
const CANDIDATES =
  process.env['MG_ART_BUNDLE_DIR'] === undefined
    ? [
        resolve(repoRoot, '../mgafk-pi/json/bundle-1176-0'),
        resolve(repoRoot, '../../mgafk-pi/json/bundle-1176-0'),
      ]
    : [process.env['MG_ART_BUNDLE_DIR']];

const bundle = CANDIDATES.find((candidate) => existsSync(candidate));

/** Why the three tests below cannot run, or `false` when the capture is here. */
const missing =
  bundle === undefined
    ? `no captured v1176 bundle on this machine (looked in ${CANDIDATES.join(', ')}) - set MG_ART_BUNDLE_DIR`
    : false;

const where = bundle === undefined ? '' : ` (${bundle})`;
const fixture = loadFixture();

void test(`the predicates agree with the fixture over the game's own chunks${where}`, {
  skip: missing,
}, () => {
  if (bundle === undefined) return;
  const files = readdirSync(bundle).filter((name) => name.endsWith('.js'));
  assert.equal(files.length, 121, 'the captured bundle is not the 121 chunks this fixture was cut from');
  const chunks = files.map((name) => projectChunk(name, readFileSync(resolve(bundle, name), 'utf8')));
  const { tables, evidence } = extractArtTables(chunks);
  assert.deepEqual(tables, fixture.tables, 'the fixture and the bundle disagree about the tables');
  assert.deepEqual(evidence, fixture.evidence, 'the fixture and the bundle disagree about the evidence');
});

void test('the capture states the version the fixture was cut from', { skip: missing }, () => {
  if (bundle === undefined) return;
  const manifest = JSON.parse(readFileSync(resolve(bundle, 'capture-manifest.json'), 'utf8')) as {
    gameVersion: string;
    chunkCount: number;
  };
  assert.equal(manifest.gameVersion, fixture.manifest.sources.gameVersion);
  assert.equal(manifest.chunkCount, 121);
});

void test('the fixture directory and the bundle name the same chunks', { skip: missing }, () => {
  if (bundle === undefined) return;
  const chunks = readdirSync(bundle).filter((name) => name.endsWith('.js'));
  for (const file of fixture.manifest.files) {
    assert.ok(chunks.includes(file.chunk), `${file.chunk} is not in the capture`);
  }
  assert.ok(existsSync(FIXTURE_DIR));
});
