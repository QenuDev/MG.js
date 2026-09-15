/**
 * Names Phase 6 removed must not come back without a test for what they do.
 *
 * ## Why a guard is the honest artifact for a dead-code deletion
 *
 * Phase 6's acceptance is *"a test asserts each surviving option changes behaviour; the deleted names are
 * listed per commit"*. For a **surviving** option that is the usual test-first loop. For a deleted one it
 * cannot be: dead code is, by definition, code whose removal no behavioural test can notice, so "the test
 * went red before the deletion" is unavailable, and that absence is what let the dead surface
 * accumulate behind the appearance of coverage.
 *
 * The nearest thing to a red that a deletion can have is a scan that fails **before** the deletion and passes
 * after. That is what this file is: it is written with the names still in the tree, watched failing, and then
 * made green by the deletion in the same commit. Afterwards it pins the decision, so restoring one of these
 * names is a deliberate act that has to bring a test with it rather than a quiet re-addition.
 *
 * ## Why it strips comments
 *
 * The removals' explanations live in the source as prose, and those explanations necessarily *name* the thing
 * that was removed: `remote-json-source.ts` is where a reader learns why this source cannot send a
 * conditional request. Matching prose would make the guard forbid documenting its own decision. So the scan
 * looks at declarations, not at writing.
 *
 * The names are grouped by the commit that removed them, which is also the record the master plan asks for.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const packagesRoot = resolve(repoRoot, 'packages');

/**
 * Removed name → the commit's justification, one line, so the guard explains itself.
 *
 * Add to this only when the name is actually gone. A name listed while it still exists makes the guard red
 * for the wrong reason, and the phase's rule is `verify` green at every commit.
 */
const REMOVED: Readonly<Record<string, string>> = {
  setETag:
    'an ETag could never be learned: `fetchJson` exposes no response headers, so nothing ' +
    'populated the map this setter wrote to and the conditional-request path was unreachable',
  hasCapturedGet: 'no caller, and not exported from any barrel; reachable only by deep import',
  FormFallback:
    'the fallback it named was unreachable: its only guard returned a constant false, so neither value of ' +
    'the type could change an answer. A caller opts one action in with setActionForm instead',
  setFormFallback: 'zero callers, and it wrote the field nothing read',
  isFallbackEnabled: 'returned a constant false, and that made the whole fallback unreachable',
  asOutboundString: 'no caller inside or outside raw-socket.ts, and it was re-exported to the root surface',
  getSpriteGraphicsCtor:
    'a second published name for `getGraphicsCtor` with zero callers; Phase 3.7c had already made it a pure ' +
    'alias, which left nothing for the alias to do',
  KEEPALIVE:
    'the aggregate { ping, pong } object, documented as "exposed for tests and diagnostics" while no test or ' +
    'diagnostic used it; the constants themselves are live and exported from common',
  signatureOf:
    'a dead implementation of the technique `state/store.ts` explicitly rejects. This library receives a ' +
    'patch stream and never polls or diffs string signatures',
  slotGarden: 'no reader',
  slotInventory: 'no reader',
  playerCoins: 'no reader; the field guide example it quoted is a literal a caller can write directly',
  ACTIVITY_ACTION_FIELD: 'no reader',
  ACTIVITY_PET_PATH: 'no reader',
  PLAYER_DISCORD_ID_FIELD: 'no reader, and no caller looks up either spelling',
  PLAYER_DISCORD_ID_FIELD_LEGACY: 'no reader, and no caller looks up either spelling',
  DEFAULT_OPEN_TIMEOUT_MS:
    'a local literal claiming in a comment to mirror `DEFAULT_LIFECYCLE_TIMEOUTS.openMs`, while that copy ' +
    'was read by nothing: the transport now imports the shared default',
  emptyCatalogSource: 'no caller, and not on the package root surface',
  EMPTY_STARTUP_SINK:
    'a second public door to what the root surface already publishes as `createEmptySink`; the empty-sink ' +
    "behaviour is required as the transport's initial sink, the name was not",
};

/** Prose is not a declaration. Block comments first, then line comments. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Every `.ts` under any package's `src`, as `{ file, source }` with comments stripped. */
function strippedSources(): { file: string; source: string }[] {
  const sources: { file: string; source: string }[] = [];
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const srcRoot = resolve(packagesRoot, entry.name, 'src');
    if (!existsSync(srcRoot)) continue;
    for (const file of readdirSync(srcRoot, { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.ts')) continue;
      const path = resolve(file.parentPath, file.name);
      sources.push({
        file: path.slice(packagesRoot.length + 1),
        source: stripComments(readFileSync(path, 'utf8')),
      });
    }
  }
  return sources;
}

void test('the scan reads sources and strips their comments', () => {
  const sources = strippedSources();
  assert.equal(sources.length > 0, true, `no sources found under ${packagesRoot} - this guard scans nothing`);
  // The control: a declaration survives, a mention in prose does not.
  const control = 'const kept = 1; // setETag is gone\n/* setETag was here */\n';
  const stripped = stripComments(control);
  assert.match(stripped, /const kept = 1;/);
  assert.doesNotMatch(stripped, /setETag/);
});

void test('no name Phase 6 removed is declared in any package source', () => {
  const offenders: string[] = [];
  for (const { file, source } of strippedSources()) {
    for (const name of Object.keys(REMOVED)) {
      if (new RegExp(`\\b${name}\\b`).test(source)) offenders.push(`${file} -> ${name}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `a name Phase 6 removed is back in the source. Each was deleted for a recorded reason:\n${Object.entries(
      REMOVED,
    )
      .map(([name, why]) => `  - ${name}: ${why}`)
      .join('\n')}\nIf it is needed again, it needs a test that fails without it, which is the ` +
      'acceptance Phase 6 could not get from a deletion.',
  );
});
