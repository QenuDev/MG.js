/**
 * `common`'s `exports` map, asserted rather than assumed, plus the one rename that must not be silent.
 *
 * ## Why `common` needs its own twin of the `headless` test
 *
 * `headless/tests/exports-map.test.ts` exists because `@mg.js/headless/auth` pointed at
 * `dist/auth/types.js`, a file with no auth providers in it: the documented import path yielded
 * `undefined`, while `tsc -b` stayed green, because `exports` is not part of the type graph. The audit's
 * rule is the general form of that bug, stated as *"the one thing that must never be split across commits: an
 * `exports` map edit and the file move it points at."* `common` had no such test, so a `common` move could
 * reproduce the same class of break with nothing watching.
 *
 * Task 5.3 moves two member files *underneath* barrels whose `exports` targets do not change. The map half
 * of that promise is what this file checks; the two `existsSync` assertions at the end are the
 * half that fails on the pre-move tree.
 *
 * ## Why it skips rather than fails
 *
 * The map assertions read build artifacts, and `node --test` can legitimately run before `tsc -b`. Failing
 * would make the suite order-dependent, so it prints a loud warning instead. `npm run verify` builds
 * before it tests, so the assertions always run there. The rename assertions read `src/`, so they always
 * run.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
  exports: Record<string, { types?: string; default?: string }>;
};

/**
 * What each subpath must reach, at runtime.
 *
 * Small and behavioural, like the `headless` twin: these are names a caller following the
 * documented import path is told they can use, one or two per layer, not an inventory. The full inventory
 * is `symbol-parity.test.ts`'s job.
 */
const REQUIRED_RUNTIME_EXPORTS: Record<string, readonly string[]> = {
  '.': [
    'ClientCore',
    'CatalogClient',
    'Emitter',
    'MgError',
    'CommandSequencer',
    'ACTION_SPECS',
    'parseFrame',
    'DEFAULT_LIFECYCLE_TIMEOUTS',
  ],
  './protocol': [
    'parseFrame',
    'analyzeClose',
    'buildConnectUrl',
    'isKeepalivePing',
    'MAX_FRAME_BYTES',
    'SCOPE_ROOM',
  ],
  './actions': [
    'GameActions',
    'GAME_ACTION_METHOD_COUNT',
    'CommandHandle',
    'CommandSequencer',
    'FormRegistry',
    'ACTION_SPECS',
    'getActionSpec',
    'interpretRejection',
    'ResultCode',
  ],
  './state': ['ObservableStore', 'JsonPatch', 'applyPatch', 'pointerContains', 'emptyStateTree'],
  './catalog': [
    'CatalogClient',
    'CATALOG_KINDS',
    'CommunityApiContractError',
    'CommunityApiSource',
    'DEFAULT_COMMUNITY_API_URL',
    'emptyCatalog',
    'GAME_GRID_MS',
    'restockCountdown',
    'RemoteJsonSource',
    'StaticCatalogSource',
    'SUPPORTED_API_CONTRACT',
    'verifyContract',
  ],
  './transport': ['DEFAULT_LIFECYCLE_TIMEOUTS'],
};

const targets = Object.keys(REQUIRED_RUNTIME_EXPORTS).map((subpath) => {
  const entry = manifest.exports[subpath];
  assert.ok(entry, `package.json has no exports entry for "${subpath}"`);
  assert.ok(entry.default, `exports["${subpath}"] has no "default" target`);
  assert.ok(entry.types, `exports["${subpath}"] has no "types" target`);
  return {
    subpath,
    js: resolve(packageRoot, entry.default),
    dts: resolve(packageRoot, entry.types),
  };
});

const missing = targets.filter((t) => !existsSync(t.js) || !existsSync(t.dts));
if (missing.length > 0) {
  console.warn(
    `\n[mg.js] WARNING: ${missing.length} of ${targets.length} exports targets are not built, so the ` +
      `exports-map assertions are SKIPPED.\n  Run:  npm run build\n`,
  );
}

for (const { subpath, js, dts } of targets) {
  void test(`exports["${subpath}"] resolves to a built module carrying the documented names`, async () => {
    if (!existsSync(js) || !existsSync(dts)) {
      // Covered by the loud warning above; see the header for why this is a skip and not a failure.
      return;
    }

    const mod = (await import(pathToFileURL(js).href)) as Record<string, unknown>;
    for (const name of REQUIRED_RUNTIME_EXPORTS[subpath] ?? []) {
      assert.ok(
        Object.hasOwn(mod, name),
        `"${subpath}" must export ${name}, but the built module exports: ${Object.keys(mod).sort().join(', ')}`,
      );
    }
  });
}

void test('every exports subpath points at a barrel, not at a member file', () => {
  // A member file is a hand-picked slice of a folder; that is how "./auth" came to resolve to a module
  // with no providers in it. The convention (DESIGN §4.1) is one barrel per folder.
  for (const { subpath, js } of targets) {
    if (!existsSync(js)) continue;
    assert.ok(js.endsWith('index.js'), `exports["${subpath}"] should target an index.js barrel, not ${js}`);
  }
});

void test('the exports map has the six documented keys', () => {
  assert.deepEqual(Object.keys(manifest.exports).sort(), [
    '.',
    './actions',
    './catalog',
    './protocol',
    './state',
    './transport',
  ]);
});

// The half that fails on the pre-move tree, so this task cannot land as a no-op.
void test('the two misnamed types.ts files were renamed to their concepts', () => {
  const src = resolve(packageRoot, 'src');
  assert.equal(existsSync(resolve(src, 'transport/seam.ts')), true, 'transport/types.ts should be seam.ts');
  assert.equal(existsSync(resolve(src, 'transport/types.ts')), false, 'the misnamed transport file remains');
  assert.equal(existsSync(resolve(src, 'catalog/defs.ts')), true, 'catalog/types.ts should be defs.ts');
  assert.equal(
    existsSync(resolve(src, 'catalog/types.ts')),
    false,
    'catalog/types.ts exports four runtime values, so it is not a types.ts',
  );
});
