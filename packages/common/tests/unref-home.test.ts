/**
 * `unrefTimer` is the only place that touches `unref`.
 *
 * ## What this caught, and why it is a whole-repo scan
 *
 * Phase 3's job was "one home per helper" (DESIGN §5), and `unrefTimer` is one of them: `poll.ts`'s header
 * records that it replaced *"three different spellings of the same two checks, and two of them omitted the
 * `try`/`catch`, so a timer-like object whose `unref` throws took down the caller's teardown path."*
 *
 * A fifth spelling survived in `packages/headless/src/client.ts`, as `setTimeout(resolve, 300).unref?.()`.
 * Nothing in the suite could see it, and it was found by accident: TypeDoc's program resolved `setTimeout`
 * to the DOM overload, and `number` has no `unref`, so the line failed to compile with
 * `TS2339: Property 'unref' does not exist on type 'number'`, while `npm run typecheck` passed, because
 * there `@types/node` wins that overload for the same expression. The type error was the symptom; the
 * defect is the duplicate. The inline form is also strictly weaker than the helper: `?.()` guards a
 * nullish *receiver*, not a throwing `unref`, which is the exact case the helper's `try`/`catch` exists for.
 *
 * ## The red is evidenced, not asserted
 *
 * Unlike its sibling `structural-paths.test.ts`, which was written after the moves and so found nothing at
 * HEAD before exercising its failure mode with a synthetic control, this scan **had a real offender
 * when it was written**. It was run before the fix and named `packages/headless/src/client.ts:607`. So the
 * control case below still exists, but it is corroboration rather than the only evidence.
 *
 * ## What it does and does not claim
 *
 * It claims no *other* module spells the check itself. It does not claim every timer should be unref'd:
 * `reconnect.ts` and `common/src/client.ts` do not unref, and say why. Those decisions are
 * comments, and this scan strips comments, so prose about `unref` is not an offence.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** The repository root: three levels up from `packages/<pkg>/tests/`. */
const repoRoot = resolve(here, '../../..');
const packagesRoot = resolve(repoRoot, 'packages');

/** The helper's own home, which is allowed to name `unref` because it *is* the home. */
const HELPER = 'common/src/poll.ts';

/** A call to `unref`, with or without optional-call syntax, on any receiver. */
const INLINE_UNREF = /\.unref\s*\??\.\s*\(/;

/** One source file and its text, keyed repo-relative to `packages/`. */
export interface Source {
  readonly file: string;
  readonly source: string;
}

/**
 * Strip `//` and block comments so prose about `unref` is not read as a call.
 *
 * **Newlines inside a block comment are preserved.** Deleting the comment outright collapses its lines and
 * shifts every line number after it, so the scan reports an offender tens or hundreds of lines from the
 * real one, which it did on the first run of this guard, naming `client.ts:377` for a call at `:607`
 * (a 230-line block comment sits between them). A finding that misdirects its reader is a defect, not a
 * cosmetic wart, so the replacement keeps the comment's newlines and drops only its text.
 *
 * Crude and non-string-aware by design: a string literal containing `.unref(` would be a false positive,
 * and the scan surfacing it for a human is better than a regex that pretends to parse TypeScript. There is
 * no such literal today.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => '\n'.repeat((comment.match(/\n/g) ?? []).length))
    .replace(/\/\/[^\n]*/g, '');
}

/** Every inline `unref` call, as `file:line`, excluding the helper's own home. */
export function inlineUnrefs(sources: readonly Source[]): string[] {
  const offenders: string[] = [];
  for (const { file, source } of sources) {
    if (file === HELPER) continue;
    const stripped = stripComments(source);
    stripped.split('\n').forEach((line, index) => {
      if (INLINE_UNREF.test(line)) offenders.push(`${file}:${index + 1}`);
    });
  }
  return offenders;
}

/** Every `*.ts` under any package's `src/`, including nested folders. */
function sourceFiles(): Source[] {
  const sources: Source[] = [];
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const srcRoot = resolve(packagesRoot, entry.name, 'src');
    if (!existsSync(srcRoot)) continue;
    for (const found of readdirSync(srcRoot, { recursive: true, withFileTypes: true })) {
      if (!found.isFile() || !found.name.endsWith('.ts')) continue;
      const file = resolve(found.parentPath, found.name);
      sources.push({ file: file.slice(packagesRoot.length + 1), source: readFileSync(file, 'utf8') });
    }
  }
  return sources;
}

void test('the scan finds source files, and finds the helper it excludes', () => {
  const sources = sourceFiles();
  assert.equal(sources.length > 0, true, `no source files found under ${packagesRoot} - scan is empty`);
  assert.equal(
    sources.some((entry) => entry.file === HELPER),
    true,
    `${HELPER} was not found - the exclusion names a file that no longer exists`,
  );
});

void test('the pattern matches an inline unref call', () => {
  // The control: exercised in-process, so the guard's red is evidence in the suite rather than a transcript.
  const control: Source[] = [{ file: 'headless/src/fake.ts', source: 'setTimeout(f, 1).unref?.();' }];
  assert.deepEqual(inlineUnrefs(control), ['headless/src/fake.ts:1']);
  assert.deepEqual(inlineUnrefs([{ file: HELPER, source: 'timer.unref();' }]), [], 'the helper is exempt');
  assert.deepEqual(
    inlineUnrefs([{ file: 'headless/src/real.ts', source: '// an unref()ed timer\nconst t = f();' }]),
    [],
    'prose about unref is not a call',
  );
});

void test('no module spells the unref check itself - it belongs to unrefTimer', () => {
  assert.deepEqual(
    inlineUnrefs(sourceFiles()),
    [],
    'call unrefTimer() from @mg.js/common instead of calling .unref() inline',
  );
});
