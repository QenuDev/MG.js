/**
 * The provenance record, and the document generated from it.
 *
 * Two things have to be true at once. Every table the model consumes has to be accounted for -- which predicate
 * found it, what shape it looked for, what confirms it, and who reads it -- and the committed document has to be
 * the record's own output rather than something a person wrote once. So this test checks the join in both
 * directions, checks that the *extraction* credits each table to the predicate the record names, and asserts the
 * committed `docs/art-provenance.md` byte for byte against the renderer.
 *
 * The stamp it renders with is the newest shipped fixture's: `art:sync` writes `docs/art-provenance.md` for the
 * version it just read, and `--check` regenerates it for the newest committed data file, so that is the
 * extraction the committed document has to be. The data file `art:sync` writes carries the same extraction,
 * which the sync's `--check` compares byte for byte.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PREDICATES } from '../../src/bundle/predicates.ts';
import {
  PROVENANCE,
  provenanceFor,
  renderProvenanceDoc,
  type TableProvenance,
} from '../../src/bundle/provenance.ts';
import { MODEL_TABLES, type TableId } from '../../src/bundle/tables.ts';
import { loadFixture, newestShippedVersion, shippedFixtureDirectory } from './load-fixture.ts';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '../..');
const docPath = resolve(packageRoot, '../../docs/art-provenance.md');

const fixture = loadFixture(shippedFixtureDirectory(newestShippedVersion()));

void test('every table the model consumes has a provenance entry, and every entry names a real predicate', () => {
  const entries = provenanceFor();
  assert.deepEqual(
    entries.map((entry) => entry.id),
    [...MODEL_TABLES],
    "the record covers the model tables, in the model's own order",
  );
  // The *names* the predicates call themselves, not their ids: the record credits a predicate by the name it
  // is documented under, and the join in `provenanceFor` checks the two against each other.
  const predicateNames = new Set(PREDICATES.map((predicate) => predicate.predicate));
  for (const table of MODEL_TABLES) {
    const entry = PROVENANCE[table];
    assert.ok(entry !== undefined, `${table} has no provenance entry`);
    assert.ok(predicateNames.has(entry.predicate), `${table} credits a predicate that does not exist`);
    assert.ok(entry.consumers.length > 0, `${table} has no consumer, so nothing should publish it`);
    assert.ok(
      entry.validator !== null || entry.confirmedBy.length > 0,
      `${table} is confirmed by nothing: give it a validation check or name the test that confirms it`,
    );
  }
});

void test('the record cannot be short: a missing table is refused rather than rendered as a gap', () => {
  // Destructured rather than deleted: the record is typed as complete on purpose, so the only way to make a
  // short one is to say which entry is being left out.
  const { placement: _placement, ...partial } = PROVENANCE;
  assert.throws(
    () => provenanceFor(partial as Record<TableId, TableProvenance>, PREDICATES),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /the model consumes placement with no provenance entry/);
      return true;
    },
  );
});

void test('the record cannot credit the wrong predicate, and the predicates keep the prose', () => {
  const mistyped = { ...PROVENANCE, scale: { ...PROVENANCE.scale, predicate: 'anchor-table' } };
  assert.throws(() => provenanceFor(mistyped, PREDICATES), /scale is credited to anchor-table/);

  for (const entry of provenanceFor()) {
    const predicate = PREDICATES.find((candidate) => candidate.id === entry.id);
    assert.ok(predicate !== undefined);
    // The words come from the predicate, so the document cannot describe a shape the code does not look for.
    assert.equal(entry.looksFor, predicate.looksFor);
    assert.equal(entry.invariant, predicate.invariant);
    assert.ok(entry.looksFor.length > 20 && entry.invariant.length > 20);
  }
});

void test('the extraction credits each table to the predicate its provenance names', () => {
  for (const table of MODEL_TABLES) {
    const evidence = fixture.evidence[table];
    assert.ok(evidence !== undefined, `${table} has no evidence in the fixture`);
    assert.equal(
      evidence.predicate,
      PROVENANCE[table].predicate,
      `${table} was found by a different predicate`,
    );
    assert.ok(evidence.invariant.length > 0);
    assert.ok(evidence.chunk.endsWith('.js'));
  }
});

void test("the committed document is the record's own output, stamped with the version it was read from", () => {
  const committed = readFileSync(docPath, 'utf8');
  const rendered = renderProvenanceDoc(provenanceFor(), {
    gameVersion: fixture.manifest.sources.gameVersion,
    artVersion: fixture.manifest.sources.artVersion,
    evidence: fixture.evidence,
  });
  assert.equal(committed, rendered, 'docs/art-provenance.md has drifted from PROVENANCE: regenerate it');
  assert.match(
    committed,
    new RegExp(`game version \\*\\*${fixture.manifest.sources.gameVersion}\\*\\*`),
    'the document is stamped with the version whose extraction it describes',
  );
  for (const table of MODEL_TABLES) {
    assert.ok(committed.includes(`## \`${table}\``), `the document has no section for ${table}`);
  }
});

void test("the document names the game's own symbol for each table, which is what a reviewer needs", () => {
  const committed = readFileSync(docPath, 'utf8');
  for (const table of MODEL_TABLES) {
    const evidence = fixture.evidence[table];
    if (evidence.declaration !== null) {
      assert.ok(
        committed.includes(`declaration \`${evidence.declaration}\``),
        `${table} is not stamped with the declaration it was read from`,
      );
    }
  }
});
