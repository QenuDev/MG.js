/**
 * Which modules TypeDoc documents, per package.
 *
 * `entryPointStrategy: 'packages'` documents a package's root entry *and* every subpath in its `exports`
 * map. Because our root barrels re-export the subpaths' symbols by design, so callers can
 * `import { GuestAuthProvider } from '@mg.js/headless'`, the same symbol is reachable from two modules.
 * TypeDoc documents it once and does not choose predictably: `CookieAuthProvider` and
 * `CookieHeaderValidationError` are declared in the same file (`auth/cookie.ts`) and re-exported by the same
 * two barrels, yet the first landed in the package-level `classes/` and the second in `auth/interfaces/`.
 * No module page is then complete, which reads as a categorisation bug because it is one.
 *
 * So ownership is explicit: a package publishing subpaths is documented by its owning modules, and its root
 * re-export barrel is not an entry point. A package whose only export is `"."` is documented by its root
 * barrel, or it would document nothing.
 *
 * A package-level module is an entry only if it contributes a public symbol, since otherwise `connect-url.ts`
 * would publish its internal helpers (`buildAttemptUrl`, `joinHost`) in a reference no user can import from.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '../..');
export const PACKAGES = ['common', 'art', 'headless', 'bootstrapped'];

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function moduleNames(source) {
  const src = stripComments(source);
  const names = new Set();
  const stars = [];
  for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/gs)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (t)
        names.add(
          t
            .split(/\s+as\s+/)
            .pop()
            .trim(),
        );
    }
  }
  for (const m of src.matchAll(
    /export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|interface|function|const|let|var|enum|type)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/export\s+\*\s+from\s+['"]([^'"]+)['"]/g)) stars.push(m[1]);
  return { names, stars };
}

function surface(entry, seen = new Set()) {
  const file = path.normalize(entry);
  if (seen.has(file) || !fs.existsSync(file)) return new Set();
  seen.add(file);
  const { names, stars } = moduleNames(fs.readFileSync(file, 'utf8'));
  for (const target of stars) {
    const next = target.startsWith('.') ? path.join(path.dirname(file), target) : target;
    for (const name of surface(next.replace(/\.js$/, '.ts'), seen)) names.add(name);
  }
  return names;
}

function sourceFor(pkgDir, spec) {
  const target = spec.types ?? spec.default ?? '';
  return path.join(
    pkgDir,
    String(target)
      .replace(/^\.\/dist\//, 'src/')
      .replace(/\.d\.ts$/, '.ts'),
  );
}

export function entryPointsFor(pkg) {
  const pkgDir = path.join(REPO, 'packages', pkg);
  const srcDir = path.join(pkgDir, 'src');
  const { exports: exportMap = {} } = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const subpaths = Object.keys(exportMap).filter((k) => k !== '.');

  const candidates = [];
  if (subpaths.length > 0) {
    // The subpath barrels *are* the public surface, so their exports are public by construction.
    for (const key of subpaths) {
      const file = sourceFor(pkgDir, exportMap[key]);
      if (fs.existsSync(file)) candidates.push(file);
    }
  } else {
    // No public subpaths, since `bootstrapped`'s only export is `"."`, so the feature barrels own
    // the surface.
    // Documenting the root re-export barrel instead would put every symbol in one module grouped by kind,
    // with no categories at all, and leave `References` sections where the `export *` re-exports land.
    for (const dir of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const barrel = path.join(srcDir, dir.name, 'index.ts');
      if (fs.existsSync(barrel)) {
        candidates.push(barrel);
      } else {
        for (const file of fs.readdirSync(path.join(srcDir, dir.name))) {
          if (file.endsWith('.ts')) candidates.push(path.join(srcDir, dir.name, file));
        }
      }
    }
  }

  // Package-level modules, never the root re-export barrel, which is the one that creates the duplicate
  // homes. A file earns an entry only by contributing a public symbol, which is how `connect-url.ts` stops
  // publishing its internal helpers.
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts') && entry.name !== 'index.ts') {
      candidates.push(path.join(srcDir, entry.name));
    }
  }

  const publicNames = new Set();
  for (const key of Object.keys(exportMap)) {
    for (const name of surface(sourceFor(pkgDir, exportMap[key]))) publicNames.add(name);
  }

  return [...new Set(candidates)]
    .filter((file) => [...surface(file)].some((name) => publicNames.has(name)))
    .sort();
}

export const entryPoints = PACKAGES.flatMap(entryPointsFor);
