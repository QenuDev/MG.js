/**
 * The diagnostic snapshot, as a pure function of its inputs.
 *
 * `BootstrapReport` is the page-shaped diagnostic a bug report wants, and `client.report.detail` is how a
 * caller reads it. Before Phase 5 Task 5.7e the only way to produce one was to build a whole
 * `BootstrappedClient` (a page realm, a storage backend, a protocol core, an attached socket), because the
 * builders were private methods that read eight of the client's fields. A diagnostic surface nobody can
 * exercise in a test is a diagnostic surface that drifts.
 *
 * So `buildDetail` and `buildReport` are functions of a named input struct. These tests assert the
 * documented shape directly, including the branch that is hardest to reach otherwise: an attachment that was
 * never attempted.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MG_VERSION, summarizeError, toMgError } from '@mg.js/common';
import type { AttachmentReport } from '../src/attach/detect.js';
import { BUNDLE_VERSION } from '../src/build-info.js';
import type { DiagnosticsInput } from '../src/diagnostics.js';
import { buildDetail, buildReport, errorSummaries } from '../src/diagnostics.js';

const attachment: AttachmentReport = {
  kind: 'room-connection',
  roomConnection: { present: true, sendMessage: true },
  roomConnectionRejected: null,
  socketsSeen: 3,
  urlFilter: 'magicgarden',
  hasPage: true,
  renumberingInstalled: true,
};

/** Everything the client resolves before calling `buildDetail`, with the happy path filled in. */
function input(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    attachment,
    ctorsRecovered: true,
    render: { enabled: true, initFired: true },
    jotai: { enabled: true, atomsSeen: 7, setCaptured: true },
    catalog: { enabled: true, tables: ['crops', 'items'] },
    renumbering: { enabled: true, owns: true, highestSeen: 42 },
    storage: { backend: 'localStorage', durable: true, roundTrips: true },
    hasPage: true,
    ...overrides,
  };
}

void test('buildDetail passes a resolved attachment through unchanged', () => {
  assert.deepEqual(buildDetail(input()).attachment, attachment);
});

void test('buildDetail reports an unattempted attachment as kind none, with a reason', () => {
  const detail = buildDetail(input({ attachment: null }));

  assert.equal(detail.attachment.kind, 'none');
  assert.equal(detail.attachment.roomConnection.present, false);
  // The reason is the string a caller reads to learn *why* there is no attachment; an empty one would make
  // `kind: 'none'` indistinguishable from a failed attempt.
  assert.equal(detail.attachment.roomConnectionRejected, 'attachment has not been attempted yet');
  assert.equal(detail.attachment.socketsSeen, 0);
  assert.equal(detail.attachment.urlFilter, '');
  assert.equal(detail.attachment.renumberingInstalled, false);
  // Unlike every other field here, this one comes from the caller: the page realm is knowable before an
  // attachment is attempted, so the default must not assert that there is none.
  assert.equal(detail.attachment.hasPage, true);
});

void test('buildDetail stamps the bundle version from its one home', () => {
  assert.equal(buildDetail(input()).version, BUNDLE_VERSION);
  assert.equal(buildDetail(input()).version, MG_VERSION);
});

void test('buildDetail copies each axis from its input, and never invents one', () => {
  const detail = buildDetail(
    input({
      attachment: null,
      ctorsRecovered: false,
      render: { enabled: false, initFired: false },
      jotai: { enabled: false, atomsSeen: 0, setCaptured: false },
      catalog: { enabled: false, tables: [] },
      renumbering: { enabled: false, owns: false, highestSeen: 0 },
      storage: { backend: 'memory', durable: false, roundTrips: false },
      hasPage: false,
    }),
  );

  assert.deepEqual(detail.render, { enabled: false, initFired: false, ctorsRecovered: false });
  assert.deepEqual(detail.jotai, { enabled: false, atomsSeen: 0, setCaptured: false });
  assert.deepEqual(detail.catalog, { enabled: false, tables: [] });
  assert.deepEqual(detail.renumbering, { enabled: false, owns: false, highestSeen: 0 });
  assert.deepEqual(detail.storage, { backend: 'memory', durable: false, roundTrips: false });
  assert.equal(detail.hasPage, false);
});

void test("buildDetail does not alias the caller's mutable inputs", () => {
  // `tables` arrives as a readonly view of a capture handle's key iterator. Building a report must not hand
  // the caller's array back, or a later `report` read would observe a mutation the caller made in between.
  const tables = ['crops'];
  const detail = buildDetail(input({ catalog: { enabled: true, tables } }));
  tables.push('items');
  assert.deepEqual(detail.catalog.tables, ['crops']);
});

void test('buildReport carries the contract axes alongside the detail', () => {
  const detail = buildDetail(input());
  const report = buildReport(
    {
      started: true,
      ready: true,
      selfPlayerId: 'p1',
      attachmentKind: 'room-connection',
      socketsSeen: 3,
      renumberingInstalled: true,
      version: '1169',
      errors: [],
    },
    detail,
  );

  assert.equal(report.kind, 'bootstrapped');
  assert.equal(report.started, true);
  assert.equal(report.ready, true);
  assert.equal(report.selfPlayerId, 'p1');
  assert.equal(report.attachment, 'room-connection');
  assert.equal(report.socketsSeen, 3);
  assert.equal(report.renumbering, true);
  assert.equal(report.version, '1169');
  assert.equal(report.detail, detail);
});

void test('buildReport reports a client that never attached without lying about it', () => {
  const report = buildReport(
    {
      started: false,
      ready: false,
      selfPlayerId: null,
      attachmentKind: null,
      socketsSeen: 0,
      renumberingInstalled: false,
      version: '1169',
      errors: [],
    },
    buildDetail(input({ attachment: null })),
  );

  assert.equal(report.kind, 'bootstrapped');
  assert.equal(report.started, false);
  assert.equal(report.attachment, null);
  assert.equal(report.detail.attachment.kind, 'none');
});

void test('the report is JSON-safe so it can be published', () => {
  // `report` is documented as "one JSON-safe snapshot". A `Map`, a `Set`, a function or a `undefined` field
  // survives the type checker and dies at `JSON.stringify`, so the round trip is the assertion that matters.
  const report = buildReport(
    {
      started: true,
      ready: false,
      selfPlayerId: null,
      attachmentKind: 'raw-socket',
      socketsSeen: 1,
      renumberingInstalled: false,
      version: '1169',
      errors: [summarizeError(toMgError(new Error('socket closed'), 'MG_SOCKET'))],
    },
    buildDetail(input()),
  );

  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

void test("errorSummaries puts the client's own wiring failure before the core's", () => {
  const own = toMgError(new Error('sink refused'), 'MG_SINK');
  const core = [{ name: 'Error', code: 'MG_CORE', message: 'core failure' }];

  const summaries = errorSummaries(own, core);

  assert.equal(summaries.length, 2);
  assert.equal(summaries[0]?.code, 'MG_SINK');
  assert.equal(summaries[1]?.code, 'MG_CORE');
  // `report.errors` and `lastError` read the same two slots (I6), so the list starts with the same failure
  // `lastError` returns, not a different one that happens to be about the same event.
  assert.equal(summaries[0]?.message, 'sink refused');
});

void test('errorSummaries with no failure of either kind is empty, not a placeholder', () => {
  assert.deepEqual(errorSummaries(null, []), []);
});

void test("errorSummaries does not alias the core's error list", () => {
  const core = [{ name: 'Error', code: 'MG_CORE', message: 'core failure' }];
  const summaries = errorSummaries(null, core);
  assert.notEqual(summaries, core);
  assert.deepEqual(summaries, core);
});
