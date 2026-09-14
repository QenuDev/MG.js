/**
 * The small helpers in `render/` have one home each.
 *
 * ## Why these assertions are on source text
 *
 * Each of the five helpers was duplicated by copy, and three of the copies were byte-identical while two
 * had drifted. A behavioural test can only observe the copy that is reachable from a public entry point,
 * and the helpers here are module-private or narrowing wrappers: `world.ts`'s `detachNode` is not
 * exported, and `asGraphics`/`isGraphicsLike` are two names for one predicate. So where the duplication
 * itself is the risk, the assertion reads the `src` tree and names the offending file: a re-introduced
 * copy is a different function object and a different declaration, and this is the only kind of test that
 * notices one that happens to agree today.
 *
 * The comments below record, per helper, which copy survived and which drifted. The drift is the reason
 * two of these are behaviour changes rather than refactors.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const RENDER_ROOT = join(repoRoot, 'packages', 'bootstrapped', 'src', 'render');

/**
 * Every `.ts` under `bootstrapped/src/render`, as absolute paths.
 *
 * Scoped to `render/` rather than the whole package on purpose: `live-catalog/object-keys-source.ts:344` has an unrelated
 * local `function detach(): boolean` for a capture handle, and a package-wide name scan would report it
 * as a second node-teardown policy.
 */
function renderSources(): string[] {
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
  walk(RENDER_ROOT);
  return out;
}

/** The repo-relative names of every `render/` source file whose text matches `pattern`. */
function sourcesMatching(pattern: RegExp): string[] {
  return renderSources()
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => file.slice(file.indexOf('packages/')))
    .sort();
}

void test('`detach` has one implementation: `render/text.ts`', () => {
  // `world.ts`'s `detachNode` was module-private, unnamed in the docs and byte-identical to `text.ts`'s
  // exported `detach` apart from the name. A second declaration is a second behaviour to keep in step.
  assert.deepEqual(
    sourcesMatching(/function detach(Node)?\s*\(/),
    ['packages/bootstrapped/src/render/text.ts'],
    'a second detach is a second teardown policy',
  );
});

void test('`getGraphicsCtor` has one implementation: `render/ctors.ts`', () => {
  // `sprite.ts`'s zero-argument copy was `PixiStage.getGraphicsCtor(PixiStage.stage)`, a one-line
  // delegation to the same `ctors.ts` function the stage itself adapts. The surviving copy takes an
  // optional stage, which is a widening of the route, not of the result.
  assert.deepEqual(
    sourcesMatching(/function getGraphicsCtor\s*\(/),
    ['packages/bootstrapped/src/render/ctors.ts'],
    'a second getGraphicsCtor is a second search route for the same node',
  );
});

void test('`isRiveLike` has one implementation: `render/ctors.ts`', () => {
  // Two copies answered "is this a pet-ish node": `world.ts`'s private `isRiveHostLike` (same three
  // keys, but `typeof 'object'` only) and `ctors.ts`'s exported `isRiveLike` (objects *and* callables).
  // `rive.ts`'s `isArtboardLike` fallback was a third, narrower answer that omitted `artboard`; it now
  // delegates to the surviving predicate instead of restating two of its three keys.
  assert.deepEqual(
    sourcesMatching(/function isRive(Host)?Like\s*\(/),
    ['packages/bootstrapped/src/render/ctors.ts'],
    'a second Rive-host predicate is a second answer to "is this a pet"',
  );
});

void test('the Graphics predicate has one test, and `asGraphics` delegates to it', () => {
  // Two declarations are correct here and only two: `ctors.ts`'s `isGraphicsLike` is the test, and
  // `tile-view.ts`'s `asGraphics` is its narrowing form (same test, different return type), kept because
  // deleting it would be a public removal for no gain. This assertion passes before and after the
  // delegation, and its job is that a *third* declaration cannot appear. The behavioural red for the
  // delegation is in `tests/world.test.ts`: the hand-written pair threw on `null`.
  assert.deepEqual(
    sourcesMatching(/function (asGraphics|isGraphicsLike)\s*\(/),
    ['packages/bootstrapped/src/render/ctors.ts', 'packages/bootstrapped/src/render/tile-view.ts'],
    'a third Graphics predicate is a third answer to "does this node expose the Graphics API"',
  );
});

void test('warn-once has one implementation and three callers', () => {
  // Three modules each declared their own `Set` and their own reset. The surviving implementation is the
  // factory in `warn-once.ts`; each caller keeps a private memo.
  //
  // This used to match `/new Set<string>()/` as a proxy for "the memo", taught by the plan's scan of the old
  // per-caller names (`warned`, `warnedKeys`, `warnedOperations`). That proxy is a *shape*, not the property
  // the test claims, and it fired for the wrong reason the moment an unrelated module declared a
  // `Set<string>`: the cinematic-claim refcount in `render/facade.ts` (`const owners = new Set<string>()`)
  // is not a warn-once memo, and calling it one would have meant contorting working code to satisfy a
  // regex. The signal that is actually the implementation's identity is its declaration, the same form the
  // two predicates above use, and an inline re-implementation is caught by the next test, since any
  // warn-once must call `console.warn`.
  assert.deepEqual(
    sourcesMatching(/function createWarnOnce\s*\(/),
    ['packages/bootstrapped/src/render/warn-once.ts'],
    'a second factory is a second warn-once implementation',
  );

  // The other half of the test's name, which nothing asserted: the memo is *per caller*, so a
  // fourth caller is a fourth warning cadence, the thing the factory exists to make visible rather than
  // hide behind one shared `Set`.
  assert.deepEqual(
    sourcesMatching(/=\s*createWarnOnce\(\)/),
    [
      'packages/bootstrapped/src/render/graphics.ts',
      'packages/bootstrapped/src/render/rive.ts',
      'packages/bootstrapped/src/render/world-warnings.ts',
    ],
    'a fourth memo is a fourth warning cadence',
  );
});

void test('exactly one file under `render/` logs a warning', () => {
  // `console.warn(` in the three callers is what the factory replaced. Prose mentions of `console.warn`
  // (in the "why once" comments) are not matched; this is the call, not the word.
  assert.deepEqual(
    sourcesMatching(/console\.warn\(/),
    ['packages/bootstrapped/src/render/warn-once.ts'],
    'a warning logged outside the one warn-once is a warning with its own cadence',
  );
});
