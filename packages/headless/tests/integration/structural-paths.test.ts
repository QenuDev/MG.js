/**
 * Every `packages/<pkg>/src|tests/...` path a test names must exist.
 *
 * ## Why this is a whole-repo scan and not one file's business
 *
 * Thirty-odd tests assert on source *text*: they read a module, grep it for a pattern, or locate a
 * declaration by line. They do it by naming the path as a literal, which makes the path a claim about the
 * repository that nothing checks. Move or rename the module and the test keeps passing, because a scan that
 * found no files returns an empty list, and an empty list is what "no offenders" looks like. That
 * is the vacuous-pass shape this programme keeps finding (DESIGN §6/I8), and it is what the audit recorded
 * as F7 against Task 5.8: *"`render-owner.test.ts` and its siblings can silently pass on a moved tree."*
 *
 * Task 5.8 moves 28 test files, so this is the task where the literals would rot.
 *
 * ## The guard's own red is tested, not asserted in a comment
 *
 * Written before the moves, this scan found **nothing** at HEAD, because every literal already resolved
 * when Phases 2 through 5 renamed their files and fixed the literals as they went. So "run it and watch it
 * fail" was not available as evidence, and a comment claiming otherwise would be the kind of lie this
 * programme treats as a defect. Instead the failure mode is exercised in-process: {@link
 * missingPathLiterals} is a pure function over `{ file, source }` pairs, and the control case below feeds it
 * a source naming a path that cannot exist and requires it to be reported. That keeps the evidence in the
 * suite rather than in a transcript.
 *
 * The control builds its example paths by joining fragments, so this file's own text contains no match for
 * its own pattern and the scan needs no self-exclusion.
 *
 * ## What it does and does not claim
 *
 * It claims a path resolves, not that the module still has the shape the test expects. That is deliberate:
 * "the file exists" is checkable from a scan, while "the file still contains the thing this test greps for"
 * needs the test itself, which fails when the grep stops matching. This guard exists to make a *missing*
 * file loud, which is the case the test cannot see.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** The repository root: four levels up from `packages/<pkg>/tests/integration/`. */
const repoRoot = resolve(here, '../../../..');
/** The `packages/` directory the walk starts from. */
const packagesRoot = resolve(repoRoot, 'packages');

/** A repo-relative path literal, with an optional `:line` suffix that is stripped before resolving. */
const PATH_LITERAL = /\bpackages\/[a-z@][a-z0-9@.-]*\/(?:src|tests)\/[A-Za-z0-9_./-]+/g;

/** One test file and its text. */
export interface TestSource {
  readonly file: string;
  readonly source: string;
}

/** The literals a test source names, as `{ literal, line }`, deduped, in source order. */
export function pathLiterals(source: string): { literal: string; line: number }[] {
  const found: { literal: string; line: number }[] = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(PATH_LITERAL)) {
    const literal = (match[0] ?? '').replace(/:\d+$/, '');
    if (seen.has(literal)) continue;
    seen.add(literal);
    // The line number of the match, so a failure names where to look rather than only what to fix.
    found.push({ literal, line: source.slice(0, match.index).split('\n').length });
  }
  return found;
}

/** Every named literal that does not resolve, as `file:line -> literal`. */
export function missingPathLiterals(sources: readonly TestSource[]): string[] {
  const missing: string[] = [];
  for (const { file, source } of sources) {
    for (const { literal, line } of pathLiterals(source)) {
      if (existsSync(resolve(repoRoot, literal))) continue;
      missing.push(`${file}:${line} -> ${literal}`);
    }
  }
  return missing;
}

/** Every `*.ts` under any package's `tests/`, including nested folders. */
function testSources(): TestSource[] {
  const sources: TestSource[] = [];
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const testsRoot = resolve(packagesRoot, entry.name, 'tests');
    if (!existsSync(testsRoot)) continue;
    for (const found of readdirSync(testsRoot, { recursive: true, withFileTypes: true })) {
      if (!found.isFile() || !/\.m?ts$/.test(found.name)) continue;
      const file = resolve(found.parentPath, found.name);
      sources.push({ file: file.slice(packagesRoot.length + 1), source: readFileSync(file, 'utf8') });
    }
  }
  return sources;
}

void test('the scan finds test files, and finds path literals inside them', () => {
  const sources = testSources();
  assert.equal(
    sources.length > 0,
    true,
    `no test files found under ${packagesRoot} - this guard scans nothing`,
  );
  const withLiterals = sources.filter((entry) => pathLiterals(entry.source).length > 0);
  assert.equal(
    withLiterals.length > 0,
    true,
    'no test file names a packages/.../src path - the pattern or the walk has stopped matching',
  );
});

void test('every packages/<pkg>/src or /tests path named by a test exists', () => {
  assert.deepEqual(
    missingPathLiterals(testSources()),
    [],
    'a test names a path that does not exist: the literal is a claim about the repository, and a scan that ' +
      'finds no file returns the same empty list as one that found no offenders. Point the literal at the ' +
      "module's current home (and if the module moved, check what the test greps for).",
  );
});

void test('the scan reports a path that cannot exist', () => {
  // The guard's own red, in-process. Built by joining so this file contains no literal its own scan would
  // find, which is also why no self-exclusion is needed above.
  const bogus = ['packages', 'common', 'src', 'no-such-module-57e.ts'].join('/');
  assert.deepEqual(
    missingPathLiterals([{ file: 'pkg/tests/fake.test.ts', source: `const p = '${bogus}';` }]),
    [`pkg/tests/fake.test.ts:1 -> ${bogus}`],
  );
  // And a real one is not reported, so the control cannot pass by reporting everything.
  const real = ['packages', 'common', 'src', 'poll.ts'].join('/');
  assert.deepEqual(
    missingPathLiterals([{ file: 'pkg/tests/fake.test.ts', source: `const p = '${real}';` }]),
    [],
  );
});

void test('the pattern notices a path literal, and strips a line suffix', () => {
  const example = ['packages', 'common', 'src', 'poll.ts'].join('/');
  assert.deepEqual(pathLiterals(`const p = '${example}';`), [{ literal: example, line: 1 }]);
  assert.deepEqual(pathLiterals(`// ${example}:42 in prose\n`), [{ literal: example, line: 1 }]);
  assert.deepEqual(pathLiterals("const p = './src/poll.ts';"), [], 'a relative path is not a repo literal');
  assert.deepEqual(pathLiterals("const p = 'src/poll.ts';"), [], 'an unanchored path is not a repo literal');
});
