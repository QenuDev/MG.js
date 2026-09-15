/**
 * No module-scope mutable state under `headless/src`.
 *
 * ## What this replaced, and why
 *
 * The Phase 5 plan's mitigation for splitting the 1404-line `client.ts` was:
 *
 * > *nothing moves that is mutable module state, and the extraction is grep-verified: every `let`/`const`
 * > at module scope in `client.ts` must appear in exactly one of the nine new files.
 * > `git grep -c "^let \|^const "` before and after the split must agree.*
 *
 * **That check cannot fail.** `client.ts` declares zero module-scope `const`/`let`, and that is
 * measured rather than assumed, so the count is `0` before and `0` after whatever the split does, and
 * `const` is not mutable state in any case. It is precisely the defect class this programme exists to
 * remove (DESIGN §6, I8): an assertion that cannot fail reads as a guarantee while guaranteeing
 * nothing, and here it was standing
 * in for the one real risk of a nine-way split: a `WeakSet`, a counter or a cache that used to be a
 * single instance becoming two, which no type error would catch.
 *
 * So this asserts the thing that *can* go wrong, in a way that can notice: a `let` or `var` at module
 * scope is the declaration shape that would duplicate silently. `headless/src` has none today, so
 * an extraction that adds one is a regression rather than a style opinion.
 *
 * The counter-example is there on purpose: `@mg.js/common` and `@mg.js/bootstrapped` *do* have
 * module-scope `let`/`var` (13 of them), so this guard is scoped to `headless` where the claim is true
 * rather than everywhere, where it would be a false statement about the repo.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '../src');

void test('no headless/src module declares mutable module-scope state', () => {
  const files = readdirSync(srcRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => resolve(entry.parentPath, entry.name));

  // A glob that silently matched nothing would make every assertion below vacuously true.
  assert.equal(files.length > 0, true, `no .ts files found under ${srcRoot}: this guard is scanning nothing`);

  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (/^(export\s+)?(let|var)\s/m.test(source)) {
      offenders.push(file.slice(srcRoot.length + 1));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'a module-scope `let`/`var` is shared, mutable state: if one moves into a split-out module, two copies ' +
      'can exist without any type error. Use a field, or a `const`.',
  );
});

void test('the guard would notice a module-scope `let` if one existed', () => {
  // The guard's own control. `assert.deepEqual([], [])` passes for a scanner that found no files, read no
  // bytes, or lost its regex. This runs the same predicate over text that does contain one.
  const predicate = (source: string): boolean => /^(export\s+)?(let|var)\s/m.test(source);
  assert.equal(predicate('let cache = new Map();\n'), true);
  assert.equal(predicate('export let counter = 0;\n'), true);
  assert.equal(predicate('  let indented = 1;\n'), false, 'an indented declaration is not module scope');
  assert.equal(predicate('const stable = 1;\nexport const also = 2;\n'), false);
});
