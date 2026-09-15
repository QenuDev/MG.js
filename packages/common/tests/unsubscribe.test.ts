/**
 * `Unsubscribe` has exactly one declaration.
 *
 * A type alias is erased at runtime, so there is no value to compare and no way to catch a second copy
 * with a behavioural assertion. The copy *is* the declaration, so the assertion is on the source text,
 * the same technique `build-output.test.ts` and `exports-map.test.ts` already use on artifacts.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DECLARATION = /^\s*export type Unsubscribe\b\s*=/m;

function everySourceFile(): string[] {
  const out: string[] = [];
  // Hand-rolled with `path.join(dir, entry.name)`: `recursive` needs Node 20.1 and `Dirent.parentPath`
  // needs 20.12, while the root `engines.node` promises `>=20`.
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
  };
  for (const pkg of ['common', 'headless', 'bootstrapped']) {
    walk(join(repoRoot, 'packages', pkg, 'src'));
  }
  return out;
}

void test('exactly one file in `packages/*/src` declares `Unsubscribe`', () => {
  const declaring = everySourceFile().filter((file) => DECLARATION.test(readFileSync(file, 'utf8')));
  assert.deepEqual(
    declaring.map((file) => file.slice(repoRoot.length + 1)),
    ['packages/common/src/unsubscribe.ts'],
    'a second declaration is a second identity for one concept',
  );
});

void test('the three consumers reach that one declaration', () => {
  const store = readFileSync(join(repoRoot, 'packages/common/src/state/store.ts'), 'utf8');
  const transport = readFileSync(join(repoRoot, 'packages/common/src/transport/seam.ts'), 'utf8');
  const socket = readFileSync(join(repoRoot, 'packages/headless/src/room-socket.ts'), 'utf8');
  for (const [name, source] of [
    ['state/store.ts', store],
    ['transport/seam.ts', transport],
    ['headless/room-socket.ts', socket],
  ] as const) {
    assert.match(
      source,
      /from '\.\.\/unsubscribe\.js'|Unsubscribe,/s,
      `${name} must import it, not declare it`,
    );
  }
});
