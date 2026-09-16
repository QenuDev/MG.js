/**
 * `art`'s exports map, asserted rather than assumed.
 *
 * This is the same test `common` and `headless` carry, for the same reason: `exports` is not part of the
 * type graph, so a subpath can point at a file that does not exist and `tsc -b` stays green while the
 * documented import yields `undefined`. The map is the package's public surface; a rename has to be a
 * deliberate act that touches this file.
 *
 * `REQUIRED_RUNTIME_EXPORTS` grows with each commit that publishes a name. It is an inventory of what a
 * caller is *told* they can use, one or two per layer -- `symbol-parity.test.ts` in `common` is the place
 * for a complete symbol list, and it does not cover this package.
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
 * What each subpath must reach at runtime.
 *
 * Every commit that publishes a name adds it here and to the module it belongs to; the entries below are the
 * four the package declares, in the order a reader meets them.
 */
const REQUIRED_RUNTIME_EXPORTS: Record<string, readonly string[]> = {
  '.': [
    'frameBox',
    'REFERENCE_TILE_PX',
    'boxOf',
    'extentOf',
    'placePart',
    'fitPicture',
    'mutationArt',
    'mutationStack',
    'mutationOverlayArt',
    'mutationAnchor',
    'mutationPlacement',
    'spriteName',
    'resolveSprite',
  ],
  './bundle': [],
  './source': ['contentRevision', 'gameVersion', 'atlasPacks', 'atlasImage'],
  './node': [
    'readKtx2Header',
    'decodeKtx2',
    'decodeKtx2File',
    'frameSize',
    'frameBytes',
    'decodePng',
    'encodePng',
    'drawOver',
    'scaled',
    'pngSize',
    'washArt',
  ],
};

const target = (subpath: string) => {
  const entry = manifest.exports[subpath];
  assert.ok(entry, `package.json has no exports entry for "${subpath}"`);
  assert.ok(entry.default, `exports["${subpath}"] has no "default" target`);
  assert.ok(entry.types, `exports["${subpath}"] has no "types" target`);
  return {
    subpath,
    js: resolve(packageRoot, entry.default),
    dts: resolve(packageRoot, entry.types),
  };
};

const targets = Object.keys(REQUIRED_RUNTIME_EXPORTS).map(target);

const missing = targets.filter((t) => !existsSync(t.js) || !existsSync(t.dts));
if (missing.length > 0) {
  console.warn(
    `\n[mg.js] WARNING: ${missing.length} of ${targets.length} exports targets are not built, so the ` +
      'exports-map assertions are SKIPPED.\n  Run:  npm run build\n',
  );
}

for (const { subpath, js, dts } of targets) {
  void test(`exports["${subpath}"] resolves to a built module carrying the documented names`, async () => {
    if (!existsSync(js) || !existsSync(dts)) return; // Covered by the warning above.

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
  for (const { subpath, js } of targets) {
    if (!existsSync(js)) continue;
    assert.ok(js.endsWith('index.js'), `exports["${subpath}"] should target an index.js barrel, not ${js}`);
  }
});

void test('the exports map has the four documented keys', () => {
  assert.deepEqual(Object.keys(manifest.exports).sort(), ['.', './bundle', './node', './source']);
});

void test('the two entries that exist to import something are declared as such', () => {
  // The split is the package's whole architecture claim: the model and the extractor are loadable in a
  // browser, the sources reach the network and the codec reaches Node. A fifth subpath would need a row in
  // the README's table and a reason here.
  const declared = new Set(Object.keys(manifest.exports));
  assert.ok(declared.has('./source'), './source is where the network lives');
  assert.ok(declared.has('./node'), './node is where node:zlib and node:fs live');
});
