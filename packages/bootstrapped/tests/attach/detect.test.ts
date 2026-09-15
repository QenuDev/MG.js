/**
 * `detect.ts`: choosing an attachment path, and reporting which one it chose.
 *
 * Every test here asserts on the *decision*: which `kind` won, why the room-connection path was rejected, what
 * a forced path overrides, and when `waitForAttachment` answers. The wiring those decisions feed (the
 * binding's sink, `AttachedTransport`, `ClientCore`) is asserted in `tests/attach/room-connection.test.ts`,
 * which also holds the tests for the room-connection surface itself. Both files take their fake page from
 * `tests/fixtures/attach-fixtures.ts`.
 *
 * A single `tests/attach.test.ts` used to hold both halves. Its header explained why it existed at all: every
 * other test in this package exercises one module, and "the riskiest surface, though, is the *wiring*". The
 * split keeps that statement true one file at a time: this one is about detection, the other about the
 * room-connection surface detection selects, and neither imports the other.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEmptySink, detectAttachment, waitForAttachment } from '../../src/attach/detect.ts';
import type { PageRealm } from '../../src/page/realm.js';
import { FakeRoomConnection, pageWith } from '../fixtures/attach-fixtures.ts';

// --------------------------------------------------------------------------------------
// detectAttachment
// --------------------------------------------------------------------------------------

void test('detectAttachment chooses the room connection when it is usable', () => {
  const connection = new FakeRoomConnection();
  const attachment = detectAttachment({ page: pageWith(connection) });
  try {
    assert.equal(attachment.kind, 'room-connection');
    assert.equal(attachment.report.kind, 'room-connection');
    assert.equal(attachment.report.roomConnectionRejected, null);
    assert.notEqual(attachment.room, null);
    assert.equal(attachment.socket, null);
  } finally {
    attachment.release();
  }
});

void test('detectAttachment falls back and says why when the object is absent', () => {
  const attachment = detectAttachment({ page: {} as PageRealm, force: undefined });
  try {
    // With no room connection, the raw-socket path is chosen (there is a `globalThis` to patch but no
    // `WebSocket` on this fake page, so the replacement is simply inert).
    assert.equal(attachment.kind, 'raw-socket');
    assert.match(
      String(attachment.report.roomConnectionRejected),
      /does not expose MagicCircle_RoomConnection/,
    );
  } finally {
    attachment.release();
  }
});

void test('detectAttachment reports none when there is no page at all', () => {
  const attachment = detectAttachment({ page: null });
  try {
    assert.equal(attachment.kind, 'none');
    assert.equal(attachment.sink.canSend(), false);
    assert.equal(attachment.sink.readFrontier(), null);
    assert.equal(attachment.sink.sendRaw('{"type":"QuinoaCommand"}'), false);
  } finally {
    attachment.release();
  }
});

void test('a forced attachment path overrides detection', () => {
  const attachment = detectAttachment({ page: pageWith(new FakeRoomConnection()), force: 'none' });
  try {
    assert.equal(attachment.kind, 'none');
  } finally {
    attachment.release();
  }
});

// --------------------------------------------------------------------------------------
// `waitForAttachment`: the deferred first attempt and the closed window's answer
// --------------------------------------------------------------------------------------

void test('waitForAttachment defers its first retry to the scheduled tick', async () => {
  // `waitForAttachment` probes once before it starts polling (`detect.ts` calls `detectAttachment` at the
  // top), so its first *poll* attempt must run after one interval, not in the same frame. The window is zero
  // length on purpose: an immediate first attempt would close it on that first synchronous tick and settle
  // before any scheduler ran, so `delays` staying at one entry is the observable difference.
  const ticks: Array<() => void> = [];
  const delays: number[] = [];
  const schedule = (callback: () => void, delayMs: number): number => {
    ticks.push(callback);
    delays.push(delayMs);
    return ticks.length;
  };

  let settledKind: string | null = null;
  const promise = waitForAttachment({ page: null, timeoutMs: 0, intervalMs: 250, schedule });
  void promise.then((attachment) => {
    settledKind = attachment.kind;
  });
  await Promise.resolve();

  assert.deepEqual(delays, [250], 'the first attempt waits one interval instead of repeating the probe');
  assert.equal(settledKind, null, 'an immediate first attempt would already have settled this');

  const firstTick = ticks[0];
  assert.ok(firstTick, 'the deferred tick must have been scheduled');
  firstTick();
  assert.equal((await promise).kind, 'none');
});

void test('waitForAttachment answers the deadline with a fresh empty attachment', async () => {
  // The end of the window is an answer, not a rejection: a mod loaded on a page that will never have the
  // object still starts, with an empty sink and `hasPage: false`. Each closed window gets a *fresh* binding
  // rather than the one the immediate probe already released. A page-less realm is the only shape that
  // reaches the poll at all, because `detectAttachment` always binds the raw socket when a page exists.
  const runNow = (callback: () => void, _delayMs: number): void => {
    callback();
  };
  const first = await waitForAttachment({ page: null, timeoutMs: 0, intervalMs: 10, schedule: runNow });
  const second = await waitForAttachment({ page: null, timeoutMs: 0, intervalMs: 10, schedule: runNow });

  assert.equal(first.kind, 'none');
  assert.equal(first.report.hasPage, false);
  assert.equal(first.sink.canSend(), false, 'an empty sink must not claim it can send');
  assert.equal(first.sink.sendRaw('{"type":"QuinoaCommand"}'), false);
  assert.notEqual(first, second, 'a closed window resolves a fresh binding, never a shared one');
});

// --------------------------------------------------------------------------------------
// createEmptySink
// --------------------------------------------------------------------------------------

void test('createEmptySink is a sink that reports itself unavailable', () => {
  // This is the acceptance Phase 6 owes for the decision to keep `createEmptySink` and delete the second
  // public name for it: before this, the only mentions of the empty sink in the whole suite were barrel
  // pins, so "the survivor changes behaviour" was untested on both sides of the deletion.
  const sink = createEmptySink();

  assert.equal(sink.kind, 'none');
  assert.equal(sink.canSend(), false);
  assert.equal(sink.sendRaw('{"type":"Ping"}'), false);
  assert.equal(sink.readFrontier(), null);

  // `AttachedTransport` calls both unsubscribe functions during teardown, so they must exist and be callable
  // even though no frame or welcome can arrive.
  const frameOff = sink.onFrame(() => undefined);
  const welcomeOff = sink.onWelcome(() => undefined);
  assert.equal(typeof frameOff, 'function');
  assert.equal(typeof welcomeOff, 'function');
  assert.doesNotThrow(() => {
    frameOff();
    welcomeOff();
    sink.detach();
  });
});

void test('createEmptySink returns an independent sink per call', () => {
  // This is not merely stylistic: `attached-transport.ts` refuses to re-attach the sink it already holds by
  // comparing identity, so a factory that returned one shared instance would make two different transports
  // consider each other's sink "the same".
  assert.notEqual(createEmptySink(), createEmptySink());
});
