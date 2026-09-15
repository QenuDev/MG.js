/**
 * The `exports` map, asserted rather than assumed.
 *
 * ## The bug this exists for
 *
 * `@mg.js/headless/auth` used to point at `dist/auth/types.js`, a file whose name says "types"
 * and whose only export is `StaticAuthProvider`. Both real providers (`CookieAuthProvider`,
 * `GuestAuthProvider`) live in sibling files, so the documented import
 * `import { GuestAuthProvider } from '@mg.js/headless/auth'` was `undefined` at runtime and a type error
 * at typecheck, while `tsc -b` stayed perfectly green. Nothing caught it because `exports` is not part of
 * the type graph and no test read the map.
 *
 * So this test reads the map, resolves every entry the way Node would, imports the built file, and asserts
 * the subpath actually reaches the names a caller is told to use. Every target is taken *from* the map, so
 * a future rename is checked rather than restated.
 *
 * ## Why it skips rather than fails
 *
 * The test reads build artifacts, and `node --test` may be run before `tsc -b`, a normal state for a
 * fresh checkout and not a defect. Failing would make the suite order-dependent. It prints a loud warning
 * naming the build command instead. `npm run verify` builds before it tests, so the assertions always run
 * there.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '../..');
const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
  exports: Record<string, { types?: string; default?: string }>;
};

/**
 * What each subpath must reach, at runtime.
 *
 * Kept small and behavioural on purpose: if one of these names disappears, a caller following the
 * documented import path is broken, and that is the only thing this test is defending.
 */
const REQUIRED_RUNTIME_EXPORTS: Record<string, readonly string[]> = {
  '.': [
    'HeadlessClient',
    'RoomSocket',
    'StandaloneTransport',
    'StaticAuthProvider',
    'CookieAuthProvider',
    'GuestAuthProvider',
    'VersionResolver',
    'ReconnectPolicy',
    // Re-exported from `@mg.js/common` since the two error hierarchies became one; the public import
    // path must not move even though the class now lives in the shared package.
    'MgConfigError',
  ],
  './auth': [
    'StaticAuthProvider',
    'CookieAuthProvider',
    'GuestAuthProvider',
    'MC_JWT_COOKIE',
    'toCookieHeader',
    'ANONYMOUS_USER_STYLE_PARAM',
    'buildAnonymousUserStyle',
  ],
  './transport': [
    'StandaloneTransport',
    'DEFAULT_ORIGIN',
    'DESKTOP_CHROME_UA',
    'buildConnectHeaders',
    'originQueryHint',
    'NoWebSocketError',
    'acquireWebSocketRuntime',
    'decodeSocketPayload',
  ],
};

const subpaths = Object.keys(REQUIRED_RUNTIME_EXPORTS);
const targets = subpaths.map((subpath) => {
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
  // A member file is a hand-picked slice of a folder, and that is exactly how "./auth" came to resolve to
  // a module with no providers in it. The convention (DESIGN §4.1) is one barrel per folder.
  for (const { subpath, js } of targets) {
    if (!existsSync(js)) continue;
    assert.ok(js.endsWith('index.js'), `exports["${subpath}"] should target an index.js barrel, not ${js}`);
  }
});

void test('the client facade still re-exports every name the package barrel asks of it', async () => {
  // `client.ts` being split into nine modules is only safe while `client.js` remains a *facade*: nine
  // headless test files plus `index.ts` import from it by path, so a name that moves out without being
  // re-exported breaks callers.
  //
  // What this adds over `tsc`, stated narrowly, because the two overlap: `tsc` catches a dropped *type*
  // re-export (mutation-verified; removing `HeadlessCloseEvent` fails `index.ts` with TS2724) and it
  // catches a dropped *value* re-export too, whereas this asserts the runtime shape of the module. The
  // gap it closes is that `tsx` strips types without checking them, so under a bare `npm test` a value
  // export that has become type-only is `undefined` at runtime with nothing to notice. Mutation-verified:
  // turning `HANDSHAKE_GAME_NAME` into a `type` alias fails this test and nothing else in `npm test`.
  const facade = (await import('../../src/client.js')) as Record<string, unknown>;
  for (const name of ['HeadlessClient', 'appendAuthQuery', 'HANDSHAKE_ACTIONS', 'HANDSHAKE_GAME_NAME']) {
    assert.equal(
      Object.hasOwn(facade, name),
      true,
      `client.ts must keep re-exporting ${name}, which index.ts imports from it by path`,
    );
  }
});
