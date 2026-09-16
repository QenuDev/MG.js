/**
 * The userscript must not reach the art package, and a size budget is the only thing that notices when it does.
 *
 * `@mg.js/bootstrapped` ships into a page whose bundle size is asserted
 * (`bootstrapped/scripts/assert-bundle-size.ts`). A re-export is the way art tables would arrive there:
 * somebody adds `export * from '@mg.js/art'` to a barrel to save an import, nothing typechecks differently,
 * the budget moves by however large the tables are, and the page pays for a drawing model it does not use.
 *
 * So the check is on the sources, not on the built bundle: it names the file that did it, before the budget
 * has to.
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
