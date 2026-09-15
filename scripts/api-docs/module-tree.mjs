/**
 * Give each module the name a reader should see.
 *
 * ## The three problems, and why none is a config option
 *
 * 1. **`src` is not a category.** TypeDoc names a module after its entry point's path relative to the common
 *    base of all entry points. Ours is `packages/`, so `packages/headless/src/auth` is *named*
 *    `headless/src/auth`, a filesystem path rendered as a heading, with a `src` node that has one child and
 *    no meaning to a consumer. `basePath` cannot fix it (its own help: "Specifies a path which links may be
 *    resolved relative to"), and there is no renaming option.
 *
 * 2. **`entry/badge` is not a category either.** `src/entry/` has no barrel: it is where the bundle entry
 *    lives, not a feature area, so a module named after it reads as a place in the source tree. A directory
 *    with no barrel is transparent: its files are named directly, giving `badge`.
 *
 * 3. **A flat `pkg/module` name still shows the package twice** once the module list is rendered. Reparenting
 *    the modules under a real package module produces the correct tree but TypeDoc's router rejects it
 *    ("Tried to get a URL of a router target common.common which did not receive a URL") and generation
 *    fails, so the default theme keeps flat names. Nesting needs a custom theme or a docs framework.
 *
 * Names are derived from the entry list rather than guessed, and a name that does not match either rule is
 * reported instead of silently left as a path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Converter } from 'typedoc';
import { entryPoints, REPO } from './entry-points.mjs';

const BASE = path.join(REPO, 'packages');

/** `a/src/b` -> `a/b`; `pkg/src` -> `pkg`; `src` -> ``. */
export function stripSrc(name) {
  return name
    .replace(/(^|\/)src(?=\/|$)/g, '$1')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

/** The name TypeDoc will derive for each entry, mapped to the name to use instead. */
function desiredNames() {
  const map = new Map();
  for (const entry of entryPoints) {
    const raw = path
      .relative(BASE, entry)
      .replace(/\.ts$/, '')
      .replace(/\/index$/, '');
    const pkg = raw.split('/')[0];
    let segments = raw.split('/').filter((s) => s !== 'src');
    // Drop interior segments that name a directory with no barrel: they are not categories.
    segments = segments.filter((segment, index) => {
      if (index === 0 || index === segments.length - 1) return true;
      return fs.existsSync(path.join(BASE, pkg, 'src', segment, 'index.ts'));
    });
    map.set(raw, segments.join('/'));
  }
  return map;
}

export function load(app) {
  const names = desiredNames();
  const unmatched = [];
  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, (context) => {
    for (const child of context.project.children ?? []) {
      const wanted = names.get(child.name);
      if (wanted) {
        child.name = wanted;
        continue;
      }
      const fallback = stripSrc(child.name);
      unmatched.push(child.name);
      if (fallback) child.name = fallback;
    }
    if (unmatched.length > 0) {
      app.logger.warn(
        `[module-tree] no entry-point mapping for: ${unmatched.join(', ')}. Fell back to stripping "src"`,
      );
    }
  });
}
