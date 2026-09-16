/**
 * `art:sync`: the command, offline.
 *
 * Everything here runs with no socket. The extraction path is exercised through `--bundle`, which reads a
 * capture this machine already has (the committed fixture, or the fixture copied into a temporary directory as a
 * fake new version), and the `--from` path is exercised against a stubbed `fetch` -- never the network, and never
 * a live community host, because the endpoints it would talk to are somebody else's and a test that needs them is
 * a test that fails on a train.
 *
 * Two properties matter more than the rest and are asserted directly: two runs are byte-identical, and a version
 * change is a new file rather than an overwrite. The third is the failure mode the whole design accepts -- a
 * predicate that no longer finds its table -- and it is checked through the real process, because "exits
 * non-zero naming the predicate" is a claim about a command line, not about a function's return value.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ArtDataError } from '../../src/bundle/data.ts';
import {
  applySync,
  checkPlan,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  main,
  parseArgs,
  planSync,
  type SyncHttp,
} from '../../src/bundle/tools/sync.ts';
import { FIXTURE_DIR } from './load-fixture.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const committedData = readFileSync(resolve(repoRoot, 'packages/art/data/1176.json'), 'utf8');
const temporary: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mgjs-art-sync-'));
  temporary.push(directory);
  return directory;
}

after(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

/** A `fetch` that answers from a table of URLs and refuses anything else. */
function stubFetch(routes: Readonly<Record<string, string>>): SyncHttp {
  return async (url: string) => {
    const body = routes[url];
    if (body === undefined) throw new Error(`the test served no route for ${url}`);
    return {
      ok: true,
      status: 200,
      text: async () => body,
      json: async () => JSON.parse(body) as unknown,
    };
  };
}

/** A temporary repository with a committed data file and an empty `docs/`. */
function temporaryRepo(data: string): string {
  const root = scratch();
  mkdirSync(join(root, 'packages/art/data'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'packages/art/data/1176.json'), data);
  return root;
}

/**
 * A temporary capture that claims to be another game version: the fixture's chunks, its atlas, and a
 * `capture-manifest.json` stating the version. This is how a version change is simulated without a socket.
 */
function temporaryCapture(version: string, broken = false): string {
  const directory = scratch();
  const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, 'fixture.json'), 'utf8')) as {
    files: { fixture: string; chunk: string }[];
  };
  for (const file of manifest.files) {
    const text = readFileSync(join(FIXTURE_DIR, file.fixture), 'utf8');
    const withoutTable = broken
      ? text
          .split('\n')
          .filter((line) => (line.match(/`sprite\//g) ?? []).length <= 100)
          .join('\n')
      : text;
    writeFileSync(join(directory, file.chunk), withoutTable);
  }
  cpSync(join(FIXTURE_DIR, 'atlas-frames.json'), join(directory, 'atlas-frames.json'));
  writeFileSync(
    join(directory, 'capture-manifest.json'),
    `${JSON.stringify({ pageUrl: 'https://magicgarden.gg/r/test', gameVersion: version, chunkCount: 2 }, null, 2)}\n`,
  );
  return directory;
}

void test('the flags are parsed strictly: an unknown flag is a usage error, not something ignored', () => {
  assert.deepEqual(parseArgs(['--check']).check, true);
  assert.equal(parseArgs(['--from', 'https://host/data/art']).from, 'https://host/data/art');
  assert.equal(parseArgs(['--bundle', FIXTURE_DIR]).bundle, FIXTURE_DIR);
  assert.throws(() => parseArgs(['--from']), /--from needs a value/);
  assert.throws(() => parseArgs(['--nope']), /unknown flag --nope/);
  assert.throws(() => parseArgs(['--check', '--from', 'https://host/data/art']), /different sources/);
});

void test('two runs are byte-identical, and writing twice leaves the same bytes', async () => {
  const args = { bundle: FIXTURE_DIR, origin: 'https://magicgarden.gg' };
  const first = await planSync({ repoRoot, args, log: () => {} });
  const second = await planSync({ repoRoot, args, log: () => {} });
  assert.equal(first.serialized, second.serialized);
  assert.equal(first.provenance, second.provenance);
  assert.equal(first.serialized, committedData, 'the fixture no longer reproduces the committed data file');

  const root = temporaryRepo('{}\n');
  applySync(first, root);
  const once = readFileSync(join(root, 'packages/art/data/1176.json'), 'utf8');
  applySync(second, root);
  const twice = readFileSync(join(root, 'packages/art/data/1176.json'), 'utf8');
  assert.equal(once, twice);
  assert.equal(once, first.serialized);
});

void test('the seven steps are reported, and the decode step says whose work it is', async () => {
  const plan = await planSync({
    repoRoot,
    args: { bundle: FIXTURE_DIR, origin: 'https://magicgarden.gg' },
    log: () => {},
  });
  const steps = plan.steps.map((step) => step.step);
  assert.deepEqual(steps, ['1. version', '2. bundle', '3. atlas', '4. decode', '5. extract', '6. validate']);
  const decode = plan.steps.find((step) => step.step === '4. decode');
  assert.ok(decode !== undefined);
  assert.match(decode.detail, /@mg\.js\/art\/node/);
  const extract = plan.steps.find((step) => step.step === '5. extract');
  assert.ok(extract !== undefined);
  for (const predicate of [
    'sprite-name-table',
    'mutation-art-table',
    'display-flag-table',
    'anchor-table',
    'scale-cap',
    'mutation-over-set',
    'placement-function',
  ]) {
    assert.ok(extract.detail.includes(predicate), `step 5 does not report ${predicate}`);
  }
});

void test('a new game version is a new file, not an overwrite', async () => {
  const root = temporaryRepo(committedData);
  const capture = temporaryCapture('1177');
  const code = await main(['--bundle', capture], { repoRoot: root, log: () => {} });
  assert.equal(code, EXIT_OK);
  const written = join(root, 'packages/art/data/1177.json');
  assert.ok(existsSync(written), 'the sync did not write the new version');
  assert.match(readFileSync(written, 'utf8'), /"gameVersion": "1177"/);
  assert.equal(
    readFileSync(join(root, 'packages/art/data/1176.json'), 'utf8'),
    committedData,
    'the sync overwrote the version it was not asked about',
  );
});

void test('--check fails on a difference, and says which file drifted', async () => {
  const root = temporaryRepo('{}\n');
  const plan = await planSync({
    repoRoot: root,
    args: { bundle: FIXTURE_DIR, origin: 'https://magicgarden.gg' },
    log: () => {},
  });
  const report = checkPlan(plan, root);
  assert.ok(report.differences.length >= 1);
  assert.ok(report.differences.some((line) => line.includes('1176.json differs')));
  assert.ok(report.differences.some((line) => line.includes('art-provenance.md does not exist')));

  const clean = temporaryRepo(committedData);
  writeFileSync(join(clean, 'docs/art-provenance.md'), plan.provenance);
  const cleanPlan = await planSync({
    repoRoot: clean,
    args: { bundle: FIXTURE_DIR, origin: 'https://magicgarden.gg' },
    log: () => {},
  });
  assert.deepEqual(checkPlan(cleanPlan, clean).differences, []);
  assert.equal(await main(['--check', '--bundle', FIXTURE_DIR], { repoRoot: clean, log: () => {} }), EXIT_OK);
});

void test('--check with a stale file exits non-zero rather than reporting success', async () => {
  const stale = JSON.parse(committedData) as { tables: { scale: { cap: number } } };
  stale.tables.scale.cap = 0.5;
  const root = temporaryRepo(`${JSON.stringify(stale, null, 2)}\n`);
  writeFileSync(join(root, 'docs/art-provenance.md'), 'stale\n');
  const code = await main(['--check', '--bundle', FIXTURE_DIR], { repoRoot: root, log: () => {} });
  assert.equal(code, EXIT_FAILED);
});

void test('a predicate that no longer finds its table exits non-zero, and the process says which one', () => {
  const capture = temporaryCapture('1176', true);
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      resolve(repoRoot, 'packages/art/src/bundle/tools/sync.ts'),
      '--check',
      '--bundle',
      capture,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(result.status, EXIT_FAILED, `expected exit 1, saw ${String(result.status)}: ${result.stderr}`);
  assert.match(result.stderr, /sprite-name-table/);
  assert.match(result.stderr, /the game changed shape/);
});

void test('--help is a documented success rather than an error', async () => {
  const lines: string[] = [];
  assert.equal(await main(['--help'], { repoRoot, log: (line) => lines.push(line) }), EXIT_OK);
  assert.ok(lines.some((line) => line.includes('--check')));
  assert.equal(await main(['--nope'], { repoRoot, log: () => {} }), EXIT_USAGE);
});

void test('--from takes one contract-checked GET, and produces the same data as the extraction', async () => {
  const document = JSON.parse(committedData) as { artVersion: string; gameVersion: string };
  const frames = JSON.parse(readFileSync(join(FIXTURE_DIR, 'atlas-frames.json'), 'utf8')) as {
    frameKeys: readonly string[];
  };
  const http = stubFetch({
    'https://host/data/art': committedData,
    [`https://magicgarden.gg/version/${document.artVersion}/assets/manifest.json`]: JSON.stringify({
      bundles: [
        {
          name: 'default',
          assets: [
            {
              alias: ['atlases/sprites-0.json'],
              src: [{ src: 'atlases/sprites-2x-0.json', resolution: 2 }],
            },
          ],
        },
      ],
    }),
    [`https://magicgarden.gg/version/${document.artVersion}/assets/atlases/sprites-2x-0.json`]:
      JSON.stringify({
        frames: Object.fromEntries(frames.frameKeys.map((key) => [key, { sourceSize: { w: 1, h: 1 } }])),
      }),
  });
  const root = scratch();
  const plan = await planSync({
    repoRoot: root,
    fetch: http,
    log: () => {},
    args: { from: 'https://host/data/art', origin: 'https://magicgarden.gg' },
  });
  assert.equal(plan.source, 'url');
  assert.equal(plan.gameVersion, document.gameVersion);
  assert.equal(plan.serialized, committedData, 'the contract path and the extraction path disagree');
  assert.equal(plan.chunks.length, 0, '--from must not read the game at all');
  for (const step of plan.steps) assert.ok(step.detail.length > 0);
});

void test('--from refuses a document that is not the contract, naming what is missing', async () => {
  const document = JSON.parse(committedData) as { tables: Record<string, unknown> };
  delete document.tables['placement'];
  const http = stubFetch({ 'https://host/data/art': JSON.stringify(document) });
  await assert.rejects(
    () =>
      planSync({ repoRoot: scratch(), fetch: http, log: () => {}, args: { from: 'https://host/data/art' } }),
    (error: unknown) => {
      assert.ok(error instanceof ArtDataError, `expected an ArtDataError, saw ${String(error)}`);
      assert.match(error.message, /placement/);
      return true;
    },
  );
});

void test('--check finds the committed fixture when this machine has no bundle cache', async () => {
  // The CI case: no capture, no network, only what is committed. The fixture is copied into a temporary
  // repository so the default cache root cannot accidentally find this workspace's bundle and prove nothing.
  const root = temporaryRepo(committedData);
  cpSync(FIXTURE_DIR, join(root, 'packages/art/fixtures/bundle-1176'), { recursive: true });
  const live = await planSync({
    repoRoot: root,
    args: { bundle: join(root, 'packages/art/fixtures/bundle-1176'), origin: 'https://magicgarden.gg' },
    log: () => {},
  });
  writeFileSync(join(root, 'docs/art-provenance.md'), live.provenance);
  const plan = await planSync({ repoRoot: root, args: { check: true }, log: () => {} });
  assert.equal(plan.source, 'fixture');
  assert.equal(plan.serialized, committedData);
  assert.deepEqual(checkPlan(plan, root).differences, []);
  assert.equal(await main(['--check'], { repoRoot: root, log: () => {} }), EXIT_OK);
});
