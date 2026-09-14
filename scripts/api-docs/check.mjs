/**
 * Fail when the committed API surface no longer matches the declarations.
 *
 * This is the gate half of the pair. It converts the packages and compares the result with
 * `docs/api-surface.json`, naming what appeared, disappeared or moved. It does **not** render HTML:
 * the comparison needs the project, not the site, so it is cheap enough to run inside `verify`.
 *
 * A failure here is not a formatting complaint. It means a public symbol was added, removed or changed
 * kind, and the reference a consumer reads has not been looked at since. The fix is to run
 * `npm run docs:build` and read the diff it produces.
 */

import { readFileSync } from 'node:fs';
import { convert, diffSurface, MANIFEST_PATH, surfaceOf } from './surface.mjs';

let expected;
try {
  expected = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')).modules;
} catch (error) {
  console.error(`docs:check: cannot read ${MANIFEST_PATH}: run \`npm run docs:build\` once to create it.`);
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const { project } = await convert();
const actual = surfaceOf(project);
const changes = diffSurface(expected, actual);

if (changes.length === 0) {
  const symbols = Object.values(actual).reduce(
    (total, byKind) => total + Object.values(byKind).reduce((n, names) => n + names.length, 0),
    0,
  );
  console.log(
    `docs:check: the reference matches the declarations (${symbols} symbols, ${Object.keys(actual).length} modules)`,
  );
  process.exit(0);
}

console.error(`docs:check: the API surface has changed and the reference has not been regenerated.`);
console.error(`  ${changes.length} change(s) against ${MANIFEST_PATH}:\n`);
for (const line of changes.slice(0, 40)) console.error(`    ${line}`);
if (changes.length > 40) console.error(`    … and ${changes.length - 40} more`);
console.error(
  `\n  Run \`npm run docs:build\`, read the reference, then commit the manifest with the change.`,
);
process.exit(1);
