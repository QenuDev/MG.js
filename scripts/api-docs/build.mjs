/**
 * Generate the API reference (HTML, gitignored) and rewrite the committed surface manifest.
 *
 * `check.mjs` is the gate; this is the command that satisfies it. The HTML exists so a human can read the
 * reference locally: open `.docs-api/index.html`, or serve the directory if the search index misbehaves
 * under `file://`. It is not committed: DESIGN §10 declines committing generated artifacts, and the
 * manifest is what the gate actually compares.
 */

import { writeFileSync } from 'node:fs';
import { convert, MANIFEST_PATH, serialise, surfaceOf } from './surface.mjs';

const { app, project } = await convert();

// `generateDocs` reports failure by logging, not by throwing: it can print "html output could not be
// generated" and still resolve. Checking `project` is therefore not enough.
await app.generateDocs(project, app.options.getValue('out'));
const errors = app.logger.errorCount ?? app.logger._errorCount ?? 0;
if (errors > 0) {
  console.error(`docs:build: typedoc reported ${errors} error(s); the reference is incomplete`);
  process.exit(1);
}

const modules = surfaceOf(project);
const symbols = Object.values(modules).reduce(
  (total, byKind) => total + Object.values(byKind).reduce((n, names) => n + names.length, 0),
  0,
);

writeFileSync(MANIFEST_PATH, serialise(modules));

console.log('docs:build');
console.log(`  modules    ${Object.keys(modules).length}`);
console.log(`  symbols    ${symbols}`);
console.log(`  manifest   ${MANIFEST_PATH}`);
console.log(`  html       ${app.options.getValue('out')} (gitignored)`);
