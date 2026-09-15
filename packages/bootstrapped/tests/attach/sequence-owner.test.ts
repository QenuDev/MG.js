/**
 * The sequence rule, that a command sequence is a non-negative integer, has exactly one home.
 *
 * ## The bug this exists for
 *
 * "Read the server's confirmed command frontier" was written out in **ten** places across three packages,
 * under **two different rules**: six copies tested `Number.isFinite` and reported `2.5` as a frontier, four
 * tested `Number.isInteger(value) && value >= 0`. `coexistence/renumber.ts` managed to contain both at
 * once: its private `asSequence` refused `2.5` while its own constructor seed, `observeFrontier`, the heal
 * target and the scraped-frame read all accepted it.
 *
 * The disagreement is not academic. `Renumberer.rewrite` stamps `frontier + 1`, so a `Welcome` carrying
 * `executedCommandSequence: 2.5` seeded the core sequencer to `3.5` while the renumberer, whose seed went
 * through the integer `asSequence`, stayed at `1`. Those are two counters that `bootstrapped/src/client.ts`
 * claims are "seed[ed] ... from the same fact, so they cannot disagree". Every command after that gap comes
 * back `invalid_sequence`, and the protocol fails *every later command too* until the session resyncs.
 *
 * ## Why the guard is behavioural *and* structural
 *
 * A behavioural test can only catch the copies reachable from a public entry point. Two of the ten were
 * inline inside `attach/raw-socket.ts` and `attach/room-connection.ts`, behind a socket the tests never
 * built, but that was a claim about the *socket*, not about the seam: `scrapeFrame` and
 * `RoomConnectionBinding.readFrontier` are exported and need no connection at all. Those two boundaries are
 * therefore observed directly below, and the text scan is no longer the only thing standing behind them.
 *
 * The scan that remains is anchored on the *operation* (`Number.isFinite` / `Number.isInteger`) and on where
 * its operand came from, which a rename cannot hide, rather than on the identifier list this phase happened
 * to delete (`value`, `rawSequence`, `frontier`, `seed`, `executedCommandSequence`). The old name-keyed rule
 * could not see `const value = record.executedCommandSequence; Number.isFinite(value)`, which is the exact
 * spelling Phase 3 deleted, so it passed while the weak rule was still expressible.
 *
 * What no text scan can do is follow a value through a function (`Number.isFinite(readIt(frame))`); the
 * behavioural assertions above are the guard for that. `tests/coexistence/envelope.test.ts` asserts function
 * identity for the same reason this file asserts identity of `readWelcomeFrontier`.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CommandSequencer, extractFrontier } from '@mg.js/common';
import { scrapeFrame } from '../../src/attach/raw-socket.ts';
import { bindRoomConnection } from '../../src/attach/room-connection.ts';
import { readWelcomeFrontier } from '../../src/client.ts';
import type { PageRealm } from '../../src/page/realm.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Every `.ts` under `dir`, recursively, built with `path.join(dir, entry.name)`.
 *
 * Hand-rolled rather than `readdirSync(dir, { recursive: true })` + `Dirent.parentPath`: `recursive` needs
 * Node 20.1 and `parentPath` needs Node 20.12, while the root `engines.node` promises `>=20`.
 */
function collectTsFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectTsFiles(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
}

/** Every `.ts` under the three packages' `src` trees, as absolute paths. A copy has to live in one. */
function everySourceFile(): string[] {
  const out: string[] = [];
  for (const pkg of ['common', 'headless', 'bootstrapped']) {
    collectTsFiles(join(repoRoot, 'packages', pkg, 'src'), out);
  }
  return out;
}

const SEQUENCE_MODULE = join(repoRoot, 'packages', 'common', 'src', 'protocol', 'codec.ts');

/**
 * A name that means "a sequence" in this codebase, whatever its prefix
 * (`frontierValue`, `seed`, and so on).
 */
const SEQUENCE_WORD = /[Ss]equence|[Ff]rontier|[Ss]eed/;

/** A value read from one of the wire's sequence fields, under any local name. */
const SEQUENCE_SOURCE = String.raw`(?:executedCommandSequence|commandSequence|\bfrontier\b|\bseed\b)`;

/** The two operations that can encode the rule. Any operand spelling is fine; the operation is the anchor. */
const RULE_OPERATION = /\bNumber\.(?:isFinite|isInteger)\(\s*([^)]*?)\s*\)/g;

/**
 * True when a finite/integer test in `source` is applied to something a sequence read could have produced.
 *
 * The operand is matched by *provenance* as well as by name: a local assigned from a sequence field is
 * collected first (`const value = record.executedCommandSequence`), so renaming the local does not hide it.
 * That is a syntactic approximation by nature: see the file header for what it cannot follow.
 */
function testsASequence(source: string): boolean {
  const aliases = new Set<string>();
  const aliasPattern = new RegExp(
    String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^;\n]*${SEQUENCE_SOURCE}`,
    'g',
  );
  for (const match of source.matchAll(aliasPattern)) {
    const name = match[1];
    if (name !== undefined) aliases.add(name);
  }
  for (const match of source.matchAll(RULE_OPERATION)) {
    const operand = (match[1] ?? '').trim();
    if (SEQUENCE_WORD.test(operand)) return true;
    if (aliases.has(operand)) return true;
  }
  return false;
}

void test('the published Welcome reader is the canonical frontier reader, not a copy of it', () => {
  // `bootstrapped/src/index.ts` publishes `readWelcomeFrontier`, so the name has to keep existing, but only
  // as a re-export of the one reader, never as a second implementation that can drift from it. Identity, not
  // behaviour: a re-introduced copy that happens to agree today is still a copy.
  assert.equal(
    readWelcomeFrontier,
    extractFrontier,
    'readWelcomeFrontier and extractFrontier must be the same function object',
  );
});

void test('exactly one file in `packages/*/src` writes the sequence rule, under any identifier', () => {
  const offenders = everySourceFile()
    .filter((file) => file !== SEQUENCE_MODULE)
    .filter((file) => testsASequence(readFileSync(file, 'utf8')))
    .map((file) => file.slice(repoRoot.length + 1));
  assert.deepEqual(offenders, [], 'a sequence validated anywhere but its home can disagree about the rule');
});

void test('the scan sees the deleted spelling and a renamed local, but not a non-sequence operand', () => {
  // This is the assertion the old name-keyed guard could not make. `const value =` followed by the
  // sequence field is the exact text Phase 3 deleted and the reviewer re-introduced to defeat it; `q` and
  // `n` are the same rule under names the old regex never listed. The final case is the control:
  // `Number.isFinite` on a byte count is legal, so a guard that rejected the operation outright would be
  // wrong rather than strict.
  assert.equal(
    testsASequence('const value = record.executedCommandSequence;\nNumber.isFinite(value);'),
    true,
  );
  assert.equal(testsASequence('const q = frame.commandSequence;\nNumber.isFinite(q);'), true);
  assert.equal(testsASequence('const n = frame.executedCommandSequence;\nNumber.isInteger(n);'), true);
  assert.equal(testsASequence('Number.isFinite(record.executedCommandSequence);'), true);
  assert.equal(testsASequence('const size = header.contentLength;\nNumber.isFinite(size);'), false);
});

void test('the raw-socket scrape refuses a fractional frontier', () => {
  // One of the two seams the old scan existed for, now observed rather than inferred from source text.
  const fractional = JSON.stringify({ type: 'RoomFrame', executedCommandSequence: 2.5, patches: [] });
  assert.equal(scrapeFrame(fractional).executedCommandSequence, null, '2.5 is not a frontier');

  const canonical = JSON.stringify({ type: 'RoomFrame', executedCommandSequence: 7, patches: [] });
  assert.equal(scrapeFrame(canonical).executedCommandSequence, 7, 'the control: 7 is read normally');
});

void test('the room-connection frontier read refuses a fractional publication', () => {
  // The other seam: `lastDistributedRoomPublication.executedCommandSequence` is read before every stamp.
  const connection = {
    lastDistributedRoomPublication: { executedCommandSequence: 2.5 },
    sendMessage: () => undefined,
    subscribeToPatches: () => () => undefined,
  };
  const binding = bindRoomConnection({ page: { MagicCircle_RoomConnection: connection } as PageRealm });
  try {
    assert.equal(binding.readFrontier(), null, '2.5 is malformed input, not a frontier');
    connection.lastDistributedRoomPublication = { executedCommandSequence: 4 };
    assert.equal(binding.readFrontier(), 4, 'the control: a canonical publication is read normally');
  } finally {
    binding.release();
  }
});

void test('the core counter ignores a fractional frontier observation', () => {
  // The reachable half of the same rule, so the two seams above are not the only behavioural evidence.
  const sequencer = new CommandSequencer();
  sequencer.observeFrontier(2.5);
  assert.equal(sequencer.peek(), 1, 'an observation of 2.5 must not move the next stamp to 3.5');
});
