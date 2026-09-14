/**
 * The `headless`/`bootstrapped` boundary, and the retry policy that stays below it.
 *
 * ## Why these are characterisation tests, not failing-first tests
 *
 * Task 3.6 asked whether `headless/src/reconnect.ts`'s `computeBackoff` and
 * `bootstrapped/src/attach/detect.ts`'s `waitForAttachment` are "the same helper in two homes". They are
 * not: one is a pure delay calculator driven by a `BackoffContext`, the other a fixed-interval deadline
 * poll with no attempt number, no close and no randomness. So nothing moved, and the honest pair of
 * assertions here is a guard around a boundary that is *already* respected; the "before" run of this
 * file passes. The failing-first evidence for 3.6 is the identity assertion in `backoff.test.ts`.
 *
 * That matters because the alternative, inventing a behaviour change so a red test exists, would be a
 * worse plan than the one this file documents. A boundary with no test is a boundary the next "unify the
 * retry logic" attempt can cross by accident; this is what makes crossing it a test failure.
 *
 * DESIGN §3.1:109-110 forbids the two platform packages importing each other, and §3.1 rule 1 keeps a
 * retry *policy* in the client that owns it rather than in a lower layer.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Every `.ts` under one package's `src` tree, as absolute paths. An offending import has to live there.
 *
 * Hand-rolled with `path.join(dir, entry.name)` rather than `readdirSync(..., { recursive: true })` +
 * `Dirent.parentPath`: `recursive` needs Node 20.1 and `parentPath` needs Node 20.12, while the root
 * `engines.node` promises `>=20`.
 */
function everySourceFileIn(pkg: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
  };
  walk(join(repoRoot, 'packages', pkg, 'src'));
  return out;
}

/** An import specifier for `banned`, as opposed to prose that happens to name it. */
function importsPackage(banned: string): RegExp {
  return new RegExp(`(?:from|import\\()\\s*'@mg\\.js/${banned}'`);
}

void test('`bootstrapped` and `headless` never import each other', () => {
  // The scan matches an import specifier rather than a bare mention: `headless/src/room-socket.ts:10`
  // names `@mg.js/bootstrapped` in a comment that is precisely about *not* depending on it, and a
  // substring test would report that comment as a violation.
  for (const [pkg, banned] of [
    ['bootstrapped', 'headless'],
    ['headless', 'bootstrapped'],
  ] as const) {
    const offender = importsPackage(banned);
    const offenders = everySourceFileIn(pkg)
      .filter((file) => offender.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(repoRoot.length + 1));
    assert.deepEqual(offenders, [], `${pkg} must not import ${banned}`);
  }
});

void test('`bootstrapped` computes no retry delay: the backoff has one home', () => {
  // The attach side polls a deadline; it does not calculate a delay. If a future change gives it one,
  // the cadence can disagree with `headless`'s, and nothing else would notice.
  const offenders = everySourceFileIn('bootstrapped')
    .filter((file) => /computeBackoff|BackoffPlan|maxDelayMs/.test(readFileSync(file, 'utf8')))
    .map((file) => file.slice(repoRoot.length + 1));
  assert.deepEqual(offenders, [], 'a delay calculated in two packages can disagree about the cadence');
});
