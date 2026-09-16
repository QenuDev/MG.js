/**
 * The test that keeps the extractor honest about *how* it found the tables.
 *
 * The predicates are shape-driven, and the temptation a year from now is to "fix" a broken build by writing
 * `if (chunk.file === 'LayoutMotionController-....js')` or by matching a symbol that happens to be stable. This
 * test makes that impossible: it takes the declaration names the extractor actually had to read out of every
 * capture the package ships -- from each fixture manifest, and from the roles of each extracted placement
 * function -- and greps the package's own `src/` for every one of them as a whole word. A shipped predicate may
 * not name a minified symbol, and the names change with every build, so naming one is not a shortcut but a lie.
 * The list is every shipped version's rather than the first one's, because a guard that covers only the build it
 * was written against stops covering the newest the moment a second version is published.
 *
 * The fixtures and the manifest *do* record the names -- that is the provenance a reviewer needs -- and the
 * model cites them too: `mutation.ts` says the over-set is the game's `Ko` and that `Wet`'s wash is
 * `rgb(50, 180, 200)` in `jo`, because where a number came from is the thing a reader has to be able to check.
 * A citation in a doc comment is not a dependency, which is why the two halves of this file are checked
 * differently: the extractor's own source is grepped line by line, comments and all, and the rest of `src/` is
 * grepped for *code* -- a line that is not a comment body. Without that distinction the test failed on the
 * provenance it exists to make unnecessary.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { FixtureManifest } from '../../src/bundle/tools/fixtures.ts';
import { loadFixture, shippedDataText, shippedFixtureDirectory, shippedVersions } from './load-fixture.ts';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '../..');
const sourceRoot = resolve(packageRoot, 'src');
const extractorRoot = resolve(sourceRoot, 'bundle');

function sourceFiles(directory: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}

/**
 * Whether a line is a comment body rather than code.
 *
 * Line-level, and that is enough because this repository's comments are JSDoc blocks: every line of prose
 * inside one starts with `*`, and a one-line comment starts with `//` or `/*`. A trailing comment after code
 * on the same line is not detected, which is the honest limit of reading lines instead of tokens -- and the
 * thing it would let past is a citation, which is what the whole distinction is for.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
}

const fixture = loadFixture();

/** Every minified declaration name the extractions had to read, wherever they recorded it. */
function minifiedNames(): readonly string[] {
  const names = new Set<string>();
  // The declaration names, and the names of the bindings the extractor had to resolve out of another chunk.
  // Imported locals as a whole are deliberately not included: a minified import list is a wall of one-letter
  // names that are ordinary English words, so grepping for all of them would test the prose, not the code.
  for (const version of shippedVersions()) {
    const manifest = JSON.parse(
      readFileSync(join(shippedFixtureDirectory(version), 'fixture.json'), 'utf8'),
    ) as FixtureManifest;
    for (const file of manifest.files) {
      for (const cut of file.cuts) names.add(cut.declaration);
    }
    const data = JSON.parse(shippedDataText(version)) as {
      readonly tables: {
        readonly placement: { readonly externals: readonly { name: string; role: string }[] };
      };
    };
    for (const external of data.tables.placement.externals) {
      if (external.role !== 'host') names.add(external.name);
    }
  }
  return [...names].sort();
}

void test('the extraction needed at least the names this test greps for', () => {
  const names = minifiedNames();
  assert.ok(
    names.length >= 10,
    `the fixture records only ${names.length} names, so the grep would be vacuous`,
  );
  // The tables were really found by shape: their predicates are named, and they are not symbol names.
  assert.ok(fixture.evidence.spriteNames.predicate.includes('-'));
  assert.ok(fixture.evidence.placement.predicate.includes('-'));
});

void test("the extractor's own source never names a minified symbol", () => {
  const files = sourceFiles(extractorRoot);
  assert.ok(
    files.length >= 6,
    `only ${files.length} source files found, which cannot be the whole extractor`,
  );
  const offenders: string[] = [];
  for (const file of files) {
    // Comments included, deliberately: a name here is one build away from being a dependency, and the
    // predicates have shape names to talk about themselves with.
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const name of minifiedNames()) {
      const pattern = new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`);
      for (const [at, line] of lines.entries()) {
        if (pattern.test(line))
          offenders.push(`${relative(packageRoot, file)}:${at + 1} names "${name}": ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `a predicate named a minified symbol:\n${offenders.join('\n')}`);
});

void test('and the rest of the package names one in code nowhere', () => {
  const files = sourceFiles(sourceRoot).filter((file) => !file.startsWith(`${extractorRoot}/`));
  assert.ok(files.length >= 2, `only ${files.length} files outside the extractor, which cannot be right`);
  const offenders: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !isCommentLine(line));
    for (const name of minifiedNames()) {
      const pattern = new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`);
      for (const [at, line] of lines.entries()) {
        if (pattern.test(line))
          offenders.push(`${relative(packageRoot, file)}:${at + 1} names "${name}": ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `the model named a minified symbol in code, where it can become a dependency:\n${offenders.join('\n')}`,
  );
});

void test('the source names the shapes in prose instead, so the next reader knows what each one looks for', () => {
  const predicates = readFileSync(resolve(sourceRoot, 'bundle/predicates.ts'), 'utf8');
  for (const shape of [
    'sprite-name-table',
    'mutation-art-table',
    'display-flag-table',
    'anchor-table',
    'plant-table',
    'scale-cap',
    'mutation-over-set',
    'placement-function',
    'icon-fill-table',
    'item-type-enum',
  ]) {
    assert.ok(predicates.includes(shape), `predicates.ts does not name the ${shape} predicate`);
  }
  assert.ok(predicates.includes('invariant:'), 'the predicates carry no invariants');
});
