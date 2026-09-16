/**
 * The two pure entries import nothing, and that is a claim about the build rather than about the sources.
 *
 * `@mg.js/art` says it can be handed to a browser as one file with no bundler. That is only true while every
 * specifier reachable from its entry is relative: one `import { fetchJson } from '@mg.js/common/catalog'`,
 * or one `node:zlib`, and the claim is false -- in a way no typecheck notices, because a `node:` import
 * typechecks fine and a workspace import resolves fine. So this walks the built files, follows the relative
 * specifiers, and fails on the first one that is neither.
 *
 * It walks `dist/`, not `src/`, because the build is what a consumer loads: a type-only import erased by
 * `tsc` is not a runtime import, and reporting it would make this test argue with the compiler.
 *
 * ## Why it warns instead of failing when `dist/` is absent
 *
 * `node --test` can legitimately run before `tsc -b`, and a suite that fails on build order is a suite
 * people learn to ignore. `npm run verify` builds first, so the assertions always run there.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
  exports: Record<string, { types?: string; default?: string }>;
};

/** The entries that promise to import nothing. `./source` and `./node` are the ones that exist to import. */
const PURE_ENTRIES = ['.', './bundle'] as const;

const entries = PURE_ENTRIES.map((subpath) => {
  const target = manifest.exports[subpath]?.default;
  assert.ok(target, `package.json has no "default" target for exports["${subpath}"]`);
  return { subpath, file: resolve(packageRoot, target) };
});

const built = entries.filter((e) => existsSync(e.file));
if (built.length < entries.length) {
  const missing = entries.filter((e) => !existsSync(e.file)).map((e) => e.subpath);
  console.warn(
    `\n[mg.js] WARNING: ${missing.join(', ')} not built, so the purity assertions are SKIPPED.\n` +
      '  Run:  npm run build\n',
  );
}

/**
 * Which characters of a built file are code, and which sit inside a string, template or comment.
 *
 * Not a parser, but not a regex either, and it has to be one of the two. Two earlier versions of this file
 * were wrong, and both are worth knowing about:
 *
 *   * A bare regex over the whole file reported that `dist/bundle/data.js` imported
 *     `", JSON.stringify(gameVersion));\n }` — because an error message in that file ends with the words
 *     "read from" and a quote follows.
 *   * Blanking the literals before matching was worse. `import 'node:fs'` *is* a literal, so blanking it
 *     removed the specifier the gate exists to find: appending that line to `dist/index.js` left the suite
 *     green, which is a gate that has stopped gating.
 *
 * So the mask guards the *keyword*, not the specifier. A match counts when the `import` or `from` that
 * introduces it begins in code; the specifier itself is a literal and always will be.
 *
 * A template's `${...}` is code and is marked as such, because a specifier inside an interpolation is a real
 * specifier and a gate that ignored it would be the same failure a third time.
 */
function codeMask(source: string): boolean[] {
  const mask = new Array<boolean>(source.length).fill(true);
  type Frame = { kind: 'code'; braces: number } | { kind: 'quote'; quote: string } | { kind: 'template' };
  const frames: Frame[] = [{ kind: 'code', braces: -1 }];

  const literal = (from: number, to: number): void => {
    for (let index = from; index < to && index < mask.length; index += 1) mask[index] = false;
  };

  let index = 0;
  while (index < source.length) {
    const frame = frames[frames.length - 1];
    if (frame === undefined) break;
    const char = source[index] ?? '';

    if (frame.kind === 'quote') {
      if (char === '\\') {
        literal(index, index + 2);
        index += 2;
        continue;
      }
      if (char === frame.quote) {
        frames.pop();
        literal(index, index + 1);
        index += 1;
        continue;
      }
      literal(index, index + 1);
      index += 1;
      continue;
    }

    if (frame.kind === 'template') {
      if (char === '\\') {
        literal(index, index + 2);
        index += 2;
        continue;
      }
      if (char === '`') {
        frames.pop();
        literal(index, index + 1);
        index += 1;
        continue;
      }
      if (char === '$' && source[index + 1] === '{') {
        literal(index, index + 2);
        frames.push({ kind: 'code', braces: 0 });
        index += 2;
        continue;
      }
      literal(index, index + 1);
      index += 1;
      continue;
    }

    // Code: the three ways a literal starts, the brace that ends an interpolation, and nothing else.
    if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? source.length : end;
      literal(index, stop);
      index = stop;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      literal(index, stop);
      index = stop;
      continue;
    }
    if (char === '"' || char === "'") {
      frames.push({ kind: 'quote', quote: char });
      literal(index, index + 1);
      index += 1;
      continue;
    }
    if (char === '`') {
      frames.push({ kind: 'template' });
      literal(index, index + 1);
      index += 1;
      continue;
    }
    if (frame.braces >= 0) {
      if (char === '{') frame.braces += 1;
      else if (char === '}') {
        if (frame.braces === 0) {
          frames.pop();
          literal(index, index + 1);
          index += 1;
          continue;
        }
        frame.braces -= 1;
      }
    }
    index += 1;
  }
  return mask;
}

/**
 * Every specifier a built ES module can load, whichever of the three forms it uses.
 *
 * Deliberately not a parser. The build emits plain `import ... from '...'`, `export ... from '...'` and
 * `await import('...')`, with no comments to speak of and no computed specifiers, because that is what
 * TypeScript emits for the source this package is allowed to contain. The mask is what keeps a phrase in an
 * error message from being read as one.
 */
function specifiersOf(source: string): string[] {
  const code = codeMask(source);
  const found: string[] = [];
  for (const pattern of [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) {
      if (match.index === undefined || code[match.index] !== true) continue;
      found.push(match[1] ?? '');
    }
  }
  return found;
}

/** Follow relative specifiers from an entry and return every file reached, plus every specifier seen. */
function reachable(entry: string) {
  const visited = new Set<string>();
  const offsets: { from: string; specifier: string }[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    for (const specifier of specifiersOf(source)) {
      offsets.push({ from: file, specifier });
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        queue.push(resolve(dirname(file), specifier));
      }
    }
  }
  return { visited, offsets };
}

for (const { subpath, file } of entries) {
  void test(`exports["${subpath}"] reaches nothing but relative files`, () => {
    if (!existsSync(file)) return; // Covered by the warning above.

    const { visited, offsets } = reachable(file);
    assert.ok(visited.size > 0, `${subpath} reached no files at all, which cannot be right`);

    const foreign = offsets.filter((o) => !o.specifier.startsWith('./') && !o.specifier.startsWith('../'));
    assert.deepEqual(
      foreign.map((o) => `${relative(packageRoot, o.from)} imports "${o.specifier}"`),
      [],
      `exports["${subpath}"] must be loadable with no bundler and no Node built-ins. ` +
        'Move the code that needs them to the /source or /node entry.',
    );
  });
}

void test('the pure entries are the ones the package says they are', () => {
  const sources: Record<string, string> = {
    '.': 'src/index.ts',
    './bundle': 'src/bundle/index.ts',
  };
  for (const subpath of PURE_ENTRIES) {
    const file = resolve(packageRoot, sources[subpath] ?? '');
    assert.ok(existsSync(file), `exports["${subpath}"] has no source entry at ${sources[subpath]}`);
    assert.ok(readFileSync(file, 'utf8').length > 0, `${subpath} has an empty source entry`);
  }
});
