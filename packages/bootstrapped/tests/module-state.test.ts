/**
 * Module-scope mutable state under `bootstrapped/src` is an allow-listed set.
 *
 * ## What this replaced, and why
 *
 * The Phase 5 plan's mitigation for splitting a large file was:
 *
 * > *nothing moves that is mutable module state, and the extraction is grep-verified: `git grep -c
 * > "^let \|^const "` before and after the split must agree.*
 *
 * **That check cannot fail.** `client.ts`, the file 5.7e splits, declares zero module-scope `let`/`var`:
 * the count is `0` before and `0` after whatever the split does, so "the counts agree" is satisfied by a
 * split that duplicates state, by one that does not, and by one that never ran. (`const` is not mutable
 * state in any case, and the single module-scope `const` in the file is an object literal that nothing
 * reassigns.) That is the defect class this programme exists to remove, stated in DESIGN §6/I8: an
 * assertion that cannot fail reads as a guarantee while guaranteeing nothing.
 *
 * So this asserts the thing that *can* go wrong, in a way that can notice it. A `let` or `var` at module
 * scope is the one declaration shape that duplicates silently across a split: a `WeakSet`, a counter or a
 * cache that used to be a single instance becomes two, and no type error is raised, because both copies
 * typecheck against the same declarations.
 *
 * ## Why an allow-list rather than "there are none"
 *
 * `headless/src` really has none, so 5.5b could assert exactly that. `bootstrapped/src` has thirteen, and
 * this guard would be a false statement about the repo if it denied them. Each is an in-page singleton by
 * design: the page realm override, the Pixi capture counters, the scene counter, the recovered constructors
 * and the captured jotai functions. So the honest claim is the narrow one: *these* exist, and
 * anything else is a new decision someone has to make on purpose.
 *
 * The entries are per-file **counts**, not line numbers, so ordinary edits do not churn the list; what
 * fails is a new file gaining module-scope mutable state, or an existing file gaining more. That is
 * precisely the shape that a split duplicating state produces.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '../src');

/**
 * Every file under `bootstrapped/src` that declares module-scope `let`/`var`, and how many.
 *
 * Measured, not assumed. A new entry here is a design decision about shared mutable state in a page that
 * can hold two copies of this bundle, so it is a decision to record on purpose rather than a side effect of
 * a refactor.
 */
const MODULE_SCOPE_MUTABLE_STATE: Readonly<Record<string, number>> = {
  'jotai/bridge.ts': 3,
  'page/override.ts': 1,
  'render/ctors.ts': 4,
  'render/pixi.ts': 4,
  'render/world-scene.ts': 1,
};

/** Module scope is column zero: an indented `let` is inside a function, a block or a class body. */
const moduleScopeDeclaration = /^(?:export\s+)?(?:let|var)\s/;

/** A zero-argument call site cannot be a false positive, and `let` is not matched mid-identifier. */
export function countModuleScopeMutableState(source: string): number {
  return source.split('\n').filter((line) => moduleScopeDeclaration.test(line)).length;
}

void test('bootstrapped/src declares module-scope mutable state only in the allow-listed files', () => {
  const files = readdirSync(srcRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => resolve(entry.parentPath, entry.name));

  // A glob that silently matched nothing would make every assertion below vacuously true.
  assert.equal(files.length > 0, true, `no .ts files found under ${srcRoot}: this guard is scanning nothing`);

  const found: Record<string, number> = {};
  for (const file of files) {
    const count = countModuleScopeMutableState(readFileSync(file, 'utf8'));
    if (count > 0) found[file.slice(srcRoot.length + 1)] = count;
  }

  assert.deepEqual(
    found,
    MODULE_SCOPE_MUTABLE_STATE,
    'module-scope `let`/`var` is shared, mutable state. If a split moved one into a new module, two copies ' +
      'now exist and no type error will say so. If this is deliberate, add it to the allow-list with a ' +
      'reason; if it is not, make it a field or a `const`.',
  );
});

void test('the guard would notice module-scope mutable state if a split introduced it', () => {
  // The guard's own control. `assert.deepEqual({}, {})` passes for a scanner that found no files or read no
  // bytes, or lost its regex, so the predicate is exercised here on text that does contain a `let`.
  assert.equal(countModuleScopeMutableState('let cache = new Map();\n'), 1);
  assert.equal(countModuleScopeMutableState('export let counter = 0;\n'), 1);
  assert.equal(countModuleScopeMutableState('var legacy = 1;\n'), 1);
  assert.equal(
    countModuleScopeMutableState('  let indented = 1;\n'),
    0,
    'an indented `let` is not module scope',
  );
  assert.equal(countModuleScopeMutableState('const stable = 1;\nexport const also = 2;\n'), 0);
  assert.equal(countModuleScopeMutableState('const outlet = 1;\n'), 0, '`let` must not match inside a name');
  assert.equal(countModuleScopeMutableState('function f() {\n  let inner = 1;\n}\n'), 0);
});
