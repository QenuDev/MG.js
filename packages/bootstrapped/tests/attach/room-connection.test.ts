/**
 * The room-connection surface: `room-connection.ts` plus the four modules it re-exports.
 *
 * `room-connection.ts` is a facade. Its contents were split into `room-types.ts`, `room-binding.ts`,
 * `room-frames.ts` and `room-sink.ts`, and every name it exported before the split is still exported here, so
 * these tests reach the binding, the frame codec and the sink *through the facade* rather than importing the
 * split modules directly: the facade is the contract, and it is what makes the split revertable in one commit.
 *
 * The chain tests at the bottom run fake page → detect → binding → `AttachedTransport` → `ClientCore`, because
 * that is where some of the binding's wiring is only observable: a sink whose `onFrame` is never read, a
 * `Welcome` that never reaches the transport, or a renumbering hook installed on a slot the transport does not
 * use would all compile cleanly and silently do nothing. `detect.ts`'s own decisions (which `kind` wins, and
 * why) are asserted in `tests/attach/detect.test.ts`. Both files take their fake page from
 * `tests/fixtures/attach-fixtures.ts`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClientCore, isKeepalivePing, serializeFrame } from '@mg.js/common';
import { AttachedTransport } from '../../src/attach/attached-transport.ts';
import { detectAttachment } from '../../src/attach/detect.ts';
import {
  describeRoomConnection,
  isRoomConnectionUsable,
  normaliseRoomFrame,
  serialiseFrame,
} from '../../src/attach/room-connection.ts';
import { Renumberer } from '../../src/coexistence/renumber.ts';
import { installRealmOverride } from '../../src/page/override.ts';
import {
  FakeRoomConnection,
  makeLegacyRoomConnection,
  pageWith,
  welcomeMessage,
} from '../fixtures/attach-fixtures.ts';

// --------------------------------------------------------------------------------------
// describeRoomConnection / isRoomConnectionUsable
// --------------------------------------------------------------------------------------

void test('describeRoomConnection reports each documented field independently', () => {
  const restore = installRealmOverride({ page: pageWith(new FakeRoomConnection()) });
  try {
    const report = describeRoomConnection(pageWith(new FakeRoomConnection()));
    assert.equal(report['present'], true);
    assert.equal(report['sendMessage'], true);
    assert.equal(report['trySendMessageNow'], true);
    assert.equal(report['subscribeToRoomFrames'], true);
    assert.equal(report['lastDistributedRoomPublication'], true);
  } finally {
    restore();
  }
});

void test('describeRoomConnection reports absence rather than throwing', () => {
  const report = describeRoomConnection(pageWith(undefined));
  assert.deepEqual(report, { present: false });
});

void test('a room connection without a send path is not usable', () => {
  // An object that exists but cannot carry a command must not send `detect.ts` down this path: it would
  // "attach" successfully and then fail every send.
  const restore = installRealmOverride({
    page: pageWith({ subscribeToRoomFrames: () => () => undefined }),
  });
  try {
    assert.equal(isRoomConnectionUsable(pageWith({ subscribeToRoomFrames: () => () => undefined })), false);
  } finally {
    restore();
  }
});

void test('a room connection with both a send and an observation path is usable', () => {
  assert.equal(isRoomConnectionUsable(pageWith(new FakeRoomConnection())), true);
});

// --------------------------------------------------------------------------------------
// Frame normalisation and re-serialisation
// --------------------------------------------------------------------------------------

void test('normaliseRoomFrame finds patches under either documented location', () => {
  // `state.patches` (the classic RoomFrame shape) and top-level `patches` (observed on some builds) must both
  // be understood, because `@mg.js/common`'s `extractPatches` accepts both and the two must agree.
  const nested = normaliseRoomFrame({ executedCommandSequence: 4, state: { patches: [{ op: 'add' }] } });
  assert.equal(nested.executedCommandSequence, 4);
  assert.deepEqual(nested.patches, [{ op: 'add' }]);

  const flat = normaliseRoomFrame({ patches: [{ op: 'remove' }] });
  assert.deepEqual(flat.patches, [{ op: 'remove' }]);
  assert.equal(flat.executedCommandSequence, null);
});

void test("serialiseFrame produces a frame common's parser understands", () => {
  const raw = serialiseFrame({
    executedCommandSequence: 9,
    state: { patches: [{ op: 'replace', path: '/a' }] },
  });
  assert.notEqual(raw, null);
  const parsed = JSON.parse(String(raw)) as Record<string, unknown>;
  assert.equal(parsed['type'], 'RoomFrame');
  assert.equal(parsed['executedCommandSequence'], 9);
  // Round-trip through common: it must recognise the frame as a known message type.
  assert.deepEqual(parsed['patches'], [{ op: 'replace', path: '/a' }]);
});

void test('serialiseFrame refuses a frame with nothing to carry', () => {
  assert.equal(serialiseFrame({}), null);
  assert.equal(serialiseFrame(null), null);
  assert.equal(serialiseFrame('{"type":"Welcome"}'), '{"type":"Welcome"}');
});

// --------------------------------------------------------------------------------------
// The full chain: fake page → detect → transport → ClientCore
// --------------------------------------------------------------------------------------
//
// These assert through the binding's sink and the transport, not on `detect.ts`'s choice, so they live here
// rather than beside the detection tests.

void test('a Welcome frame travels detect, transport, ClientCore and seeds the sequencer', async () => {
  const connection = new FakeRoomConnection();
  const attachment = detectAttachment({ page: pageWith(connection) });
  const transport = new AttachedTransport({ sink: attachment.sink, readinessPollMs: 0 });

  // `autoHandledKeepalive: false` is the documented bootstrapped setting, and `getFrontier` is what makes
  // ClientCore build a FrontierAnchoredStrategy rather than a MonotonicStrategy.
  const core = new ClientCore({
    transport,
    autoHandledKeepalive: false,
    getFrontier: () => attachment.sink.readFrontier(),
  });

  try {
    assert.equal(core.isReady, false);

    // The room connection hands us a parsed frame, which the sink re-serialises for the string-based seam.
    const raw = serialiseFrame({ ...welcomeMessage('p_42', 7) });
    assert.notEqual(raw, null);
    connection.emitFrame(JSON.parse(String(raw)) as unknown);

    assert.equal(core.isReady, true);
    assert.equal(core.selfPlayerId, 'p_42');
    assert.equal(core.sequencer.frontier, 7);
    // (2) verified: the strategy really is frontier-anchored, so its next number is frontier + 1.
    assert.equal(core.sequencer.peek(), 8);
  } finally {
    void core.stop('test teardown');
    transport.close();
    attachment.release();
  }
});

void test('the frontier reader reads lastDistributedRoomPublication directly', () => {
  const connection = new FakeRoomConnection();
  const attachment = detectAttachment({ page: pageWith(connection) });
  try {
    // §4: the frontier is "kept current on every frame", so this is a synchronous read with no subscription.
    assert.equal(attachment.sink.readFrontier(), 3);
    connection.lastDistributedRoomPublication = { executedCommandSequence: 12 };
    assert.equal(attachment.sink.readFrontier(), 12);
    // A stale publication object must not drag the frontier backwards.
    connection.lastDistributedRoomPublication = { executedCommandSequence: 5 };
    assert.equal(attachment.sink.readFrontier(), 12);
  } finally {
    attachment.release();
  }
});

void test('a Welcome event also feeds the frontier when the publication object is missing', async () => {
  const connection = new FakeRoomConnection();
  connection.lastDistributedRoomPublication = null;
  const attachment = detectAttachment({ page: pageWith(connection) });
  const transport = new AttachedTransport({ sink: attachment.sink, readinessPollMs: 0 });
  const core = new ClientCore({ transport, autoHandledKeepalive: false });

  try {
    // Subscribe first: `subscribeToWelcome` fires again on reconnect, and the adapter must report the frontier
    // that arrives with it.
    connection.emitWelcome({ selfPlayerId: 'p_9' }, Date.now(), 21);
    assert.equal(transport.lastWelcome?.executedCommandSequence, 21);
    assert.equal(transport.lastWelcome?.selfPlayerId, 'p_9');
    assert.equal(attachment.sink.readFrontier(), 21);
    void core.stop('test teardown');
  } finally {
    transport.close();
    attachment.release();
  }
});

void test("send(\u200b) goes through the host's own send path, and the renumbering hook sees it", () => {
  const connection = new FakeRoomConnection();
  connection.isCommandSessionReady = true;

  const attachment = detectAttachment({ page: pageWith(connection) });
  const renumberer = new Renumberer();
  const installed = attachment.setOutboundRewriter((payload: unknown) => renumberer.rewrite(payload).frame);
  const transport = new AttachedTransport({ sink: attachment.sink, readinessPollMs: 0 });

  try {
    assert.equal(installed, true);

    // The game's own frame goes out untouched while we are passive.
    const gameFrame = {
      scopePath: ['Room', 'Quinoa'],
      type: 'QuinoaCommand',
      requestId: 'game-1',
      commandSequence: 5,
      command: { type: 'HarvestCrop' },
    };
    connection.sendMessage(gameFrame);
    assert.deepEqual(connection.sent[0], { via: 'sendMessage', payload: gameFrame });
    assert.equal(renumberer.owns, false);

    // Our frame claims the counter, and the *next* game frame is renumbered to follow it.
    const mine = renumberer.claimNext();
    renumberer.remember('mine-1');
    const mineFrame = { ...gameFrame, requestId: 'mine-1', commandSequence: mine };
    connection.sendMessage(mineFrame);

    const nextGame = { ...gameFrame, requestId: 'game-2', commandSequence: 99 };
    connection.sendMessage(nextGame);

    const lastSent = connection.sent[connection.sent.length - 1] as { payload: { commandSequence: number } };
    assert.equal(lastSent.payload.commandSequence, mine + 1);
    // And the transport reports that the frame was accepted, on the synchronous path rather than the queueing
    // one, because queueing a stamped command "hands a now-invalid sequence number to a session that hasn't
    // opened yet" (Appendix A).
    transport.send(serializeFrame(mineFrame));
    const viaSink = connection.sent[connection.sent.length - 1] as { via: string };
    assert.equal(viaSink.via, 'trySendMessageNow');
    assert.equal(transport.lastSendResult?.accepted, true);
  } finally {
    transport.close();
    attachment.release();
  }
});

void test("close() detaches without closing the host's connection", () => {
  const connection = new FakeRoomConnection();
  const attachment = detectAttachment({ page: pageWith(connection) });
  const transport = new AttachedTransport({ sink: attachment.sink, readinessPollMs: 0 });

  const infos: Array<{ wasManual: boolean; wasClean: boolean }> = [];
  transport.onClose((info) => infos.push({ wasManual: info.wasManual, wasClean: info.wasClean }));

  transport.close();

  assert.equal(transport.state, 'closed');
  // `wasManual: true` is required: ClientCore uses it to distinguish our own detach from a lost connection,
  // and getting it wrong would make `dispose()` report the player's session as lost.
  assert.deepEqual(infos, [{ wasManual: true, wasClean: true }]);
  // The connection object is untouched, because no `close` was called on it. A `send` after the transport
  // closed must not reach the host.
  const before = connection.sent.length;
  transport.send('{"type":"QuinoaCommand","requestId":"x","commandSequence":1}');
  assert.equal(connection.sent.length, before);
  assert.equal(transport.lastSendResult?.accepted, false);
  attachment.release();
});

void test('release() restores the wrapped send methods identity-guarded', () => {
  const connection = new FakeRoomConnection();
  const originalSendMessage = connection.sendMessage;
  const originalTrySend = connection.trySendMessageNow;

  const attachment = detectAttachment({ page: pageWith(connection) });
  assert.notEqual(connection.sendMessage, originalSendMessage, 'sendMessage must be wrapped while attached');
  assert.notEqual(connection.trySendMessageNow, originalTrySend);

  attachment.release();
  assert.equal(connection.sendMessage, originalSendMessage);
  assert.equal(connection.trySendMessageNow, originalTrySend);
});

void test('a keepalive frame is not consumed by the transport', () => {
  // rule 3: the host game answers the bare-string keepalive. If the transport filtered it, and the core were
  // also configured to answer it, the server would see two pongs. `autoHandledKeepalive: false` is what
  // makes the core's own handling apply.
  assert.equal(isKeepalivePing('ping'), true);
  assert.equal(isKeepalivePing('"ping"'), true, 'the doc records the JSON-quoted form as observed too');
  assert.equal(isKeepalivePing('{"type":"Welcome"}'), false);

  const connection = new FakeRoomConnection();
  const attachment = detectAttachment({ page: pageWith(connection) });
  const transport = new AttachedTransport({ sink: attachment.sink, readinessPollMs: 0 });
  const received: string[] = [];
  transport.onMessage((raw) => received.push(raw));
  try {
    // The transport has no keepalive filter of its own, so this arrives, which is the contract.
    connection.emitFrame('ping');
    // This line used to read `assert.deepEqual(received, [JSON.stringify({ type: 'RoomFrame' })].length === 0
    // ? [] : received)`, which compares `received` with itself: the array literal's length is 1, so the
    // ternary always takes its right-hand branch and the assertion held whatever arrived. It survived Task
    // 0.4's sweep for assertions that cannot fail because the tautology is *computed*, not literal. The claim
    // the comment was reaching for is that the frame arrives unchanged, with no envelope synthesised on the
    // host's behalf.
    assert.deepEqual(received, ['ping'], 'the frame arrives byte-for-byte');
    assert.equal(received.length, 1, "the transport must not consume frames on the host's behalf");
  } finally {
    transport.close();
    attachment.release();
  }
});

void test('the legacy bare-function subscription shape is accepted', () => {
  // §4: "subscribeToPatches's return value alone has been observed as both a bare function and a
  // `{ currentState, unsubscribe }` record across bundles."
  const legacy = makeLegacyRoomConnection();
  const attachment = detectAttachment({ page: pageWith(legacy), force: 'room-connection' });
  try {
    assert.equal(attachment.kind, 'room-connection');
    // Reaching this point without a throw is the assertion: a bare-function return is normalised rather than
    // mistaken for a record and dereferenced.
    assert.equal(attachment.sink.canSend(), true);
  } finally {
    attachment.release();
  }
});

void test('inbound room frames reach ClientCore and land in the state store', () => {
  const connection = new FakeRoomConnection();
  const attachment = detectAttachment({ page: pageWith(connection) });
  const transport = new AttachedTransport({ sink: attachment.sink, readinessPollMs: 0 });
  const core = new ClientCore({ transport, autoHandledKeepalive: false });

  try {
    // A Welcome gives the core an identity and seeds the sequencer, then patches are applied to the store.
    connection.emitFrame(welcomeMessage('p_1', 4));
    assert.equal(core.selfPlayerId, 'p_1');

    connection.emitFrame({
      type: 'RoomFrame',
      executedCommandSequence: 5,
      state: { patches: [{ op: 'replace', path: '/data/hostPlayerId', value: 'p_1' }] },
    });

    // `core.room` IS the `/data` pointer (see `ObservableStore.room`), so a patch at `/data/hostPlayerId`
    // lands directly on it. The assertion goes through the public accessor rather than the raw tree, because
    // this is the path a mod actually reads.
    const room = core.room as { hostPlayerId?: unknown };
    assert.equal(room.hostPlayerId, 'p_1');
    assert.equal(core.store.stats.patchFailures, 0);
  } finally {
    void core.stop('test teardown');
    transport.close();
    attachment.release();
  }
});

void test('an unmodelled inbound frame is surfaced, not fatal', () => {
  const connection = new FakeRoomConnection();
  const attachment = detectAttachment({ page: pageWith(connection) });
  const transport = new AttachedTransport({ sink: attachment.sink, readinessPollMs: 0 });
  const core = new ClientCore({ transport, autoHandledKeepalive: false });

  const unknownTypes: string[] = [];
  core.on('unknownMessage', (message) => unknownTypes.push(message.type));

  try {
    connection.emitFrame({ type: 'SomethingFromAFutureBuild', payload: 1 });
    // The codec is forgiving inbound on purpose: "a wrapper that dies on one odd message is worse than one
    // that logs it."
    assert.deepEqual(unknownTypes, ['SomethingFromAFutureBuild']);
    assert.equal(core.isReady, false);
  } finally {
    void core.stop('test teardown');
    transport.close();
    attachment.release();
  }
});
