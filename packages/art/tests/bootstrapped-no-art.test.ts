/**
 * The userscript must not reach the art package, and a size budget is the only thing that notices when it does.
 *
 * `@mg.js/bootstrapped` is a library, and a re-export is the way art tables would arrive in whatever page
 * consumes it: somebody adds `export * from '@mg.js/art'` to a barrel to save an import, nothing typechecks
 * differently, and the page pays for a drawing model it does not use.
 *
 * **This test is the guard, and it is the only one here.** An earlier version of this comment named a bundle
 * size budget in `bootstrapped/scripts/assert-bundle-size.ts` as the thing that would notice; that file does
 * not exist, and never did in this repository's current shape — the bundle, its Tampermonkey banner and its
 * size budget moved to the example userscript's own repository, which owns the artifact
 * (`packages/bootstrapped/src/index.ts:22-24`, `.github/workflows/ci.yml:46-49`). Naming a guard that lives
 * somewhere else is worse than naming none, because it reads as covered.
 *
 * So the check is on the sources, not on a built bundle: it names the file that did it, before anything has
 * to measure a size.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const bootstrappedSrc = resolve(repoRoot, 'packages/bootstrapped/src');

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}

void test('bootstrapped never imports the art package', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(bootstrappedSrc)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1] ?? '';
      if (/^@mg\.js\/art(\/|$)/.test(specifier) || /packages\/art\//.test(specifier)) {
        offenders.push(`${relative(repoRoot, file)} imports "${specifier}"`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'the userscript has a bundle-size budget, and the art model is not part of what it draws with',
  );
});
