/**
 * The client core, exercised over a fake transport.
 *
 * This is where the honest-ack design gets pinned down. The protocol has one feedback channel and, in
 * the documented payload, no `requestId` to correlate it with, so the core must (a) match exactly when
 * an id is echoed, (b) match probably-but-flag-it when it is not, and (c) never claim confirmation it
 * does not have. Those three behaviours are the difference between a wrapper that is merely convenient
 * and one that is trustworthy.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AckMode } from '../src/client.js';
import { ClientCore } from '../src/client.js';
import type { ClientCloseEvent } from '../src/client-contract.js';
import { MgCommandRejectedError, MgConfigError, MgNotReadyError } from '../src/errors.js';
import { extractFrontier, extractPatches, parseFrame, serializeFrame } from '../src/protocol/codec.js';
import type { Transport, TransportCloseInfo, TransportKind, TransportState } from '../src/transport/seam.js';
import type { Unsubscribe } from '../src/unsubscribe.js';
import { MG_VERSION } from '../src/version.js';

/** A transport that records outbound frames and lets a test inject inbound ones. */
class FakeTransport implements Transport {
  readonly kind: TransportKind = 'standalone';
  state: TransportState = 'idle';
  readonly sent: string[] = [];
  /** When set, {@link send} throws it, which is the "the write failed" case a transport can always have. */
  failSend: Error | null = null;
  private readonly messageHandlers = new Set<(raw: string) => void>();
  private readonly openHandlers = new Set<() => void>();
  private readonly closeHandlers = new Set<(info: TransportCloseInfo) => void>();

  open(): void {
    this.state = 'open';
    for (const handler of this.openHandlers) handler();
  }

  send(raw: string): void {
    if (this.failSend !== null) throw this.failSend;
    this.sent.push(raw);
  }

  close(code = 1000, reason = ''): void {
    this.state = 'closed';
    for (const handler of this.closeHandlers) {
      handler({ code, reason, wasClean: true, wasManual: true });
    }
  }

  onMessage(handler: (raw: string) => void): Unsubscribe {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onOpen(handler: () => void): Unsubscribe {
    this.openHandlers.add(handler);
    return () => this.openHandlers.delete(handler);
  }

  onClose(handler: (info: TransportCloseInfo) => void): Unsubscribe {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /** Inject an inbound frame. */
  deliver(raw: string): void {
    for (const handler of [...this.messageHandlers]) handler(raw);
  }

  /** Deliver a structured message as a JSON frame. */
  deliverJson(message: Record<string, unknown>): void {
    this.deliver(serializeFrame(message));
  }

  /** The parsed outbound frames. */
  frames(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

function welcome(executedCommandSequence = 10, selfPlayerId = 'p_1'): Record<string, unknown> {
  return {
    type: 'Welcome',
    selfPlayerId,
    executedCommandSequence,
    fullState: {
      data: { players: [{ id: 'p_1', coins: 100 }], chat: [], hostPlayerId: 'p_1' },
      child: { data: { userSlots: [{ data: { activityLogs: [] } }] } },
    },
  };
}

function makeClient(ackMode: AckMode = 'fifo'): { client: ClientCore; transport: FakeTransport } {
  const transport = new FakeTransport();
  const client = new ClientCore({ transport, ackMode, timeouts: { commandAckMs: 50 } });
  return { client, transport };
}

/** A wall-clock delay, used only to put a bound on "did this settle promptly". */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// --------------------------------------------------------------------------------------
// Codec
// --------------------------------------------------------------------------------------

describe('codec', () => {
  it('recognises the bare-string keepalive in both observed spellings', () => {
    assert.deepEqual(parseFrame('ping'), { kind: 'keepalive' });
    // The doc's own handler accepts the JSON-quoted form too, "evidence the exact quoting has been
    // observed both ways".
    assert.deepEqual(parseFrame('"ping"'), { kind: 'keepalive' });
  });

  it('parses a known message type', () => {
    const result = parseFrame('{"type":"Welcome","selfPlayerId":"p_1"}');
    assert.equal(result.kind, 'message');
    assert.equal(result.kind === 'message' && result.isKnown, true);
  });

  it('keeps an unknown message type intact instead of discarding it', () => {
    const result = parseFrame('{"type":"SomethingNew","field":1}');
    assert.equal(result.kind, 'message');
    if (result.kind === 'message' && !result.isKnown) {
      assert.equal(result.message.type, 'SomethingNew');
      assert.equal(result.message.raw.field, 1);
    } else {
      assert.fail('expected an unknown message');
    }
  });

  it('reports non-JSON text as unparsed rather than throwing', () => {
    assert.deepEqual(parseFrame('not json at all'), {
      kind: 'unparsed',
      text: 'not json at all',
    });
  });

  it('reports an empty frame', () => {
    assert.deepEqual(parseFrame(''), { kind: 'empty' });
  });

  it('handles a JSON array without crashing', () => {
    assert.equal(parseFrame('[1,2,3]').kind, 'unparsed');
  });

  it('extracts patches from PartialState and from both RoomFrame shapes', () => {
    const patches = [{ op: 'replace', path: '/data/players/0/coins', value: 1 }];
    assert.deepEqual(extractPatches({ type: 'PartialState', patches }), patches);
    assert.deepEqual(extractPatches({ type: 'RoomFrame', state: { patches } }), patches);
    assert.deepEqual(extractPatches({ type: 'RoomFrame', patches }), patches);
    assert.deepEqual(extractPatches({ type: 'RoomFrame' }), []);
    assert.deepEqual(extractPatches(null), []);
  });

  it('extracts the frontier where present and ignores anything else', () => {
    assert.equal(extractFrontier({ executedCommandSequence: 42 }), 42);
    assert.equal(extractFrontier({ executedCommandSequence: 'nope' }), null);
    assert.equal(extractFrontier({}), null);
  });

  it('refuses to serialise a frame that would not survive a round trip', () => {
    // JSON.stringify(undefined) is undefined; sending that would put the literal text "undefined" on
    // the wire, so it throws instead.
    assert.throws(() => serializeFrame(undefined as unknown as Record<string, unknown>));
  });
});

// --------------------------------------------------------------------------------------
// Lifecycle
// --------------------------------------------------------------------------------------

describe('ClientCore: readiness', () => {
  it('refuses to send before Welcome, rather than failing silently on the wire', () => {
    const { client } = makeClient();
    assert.equal(client.isReady, false);
    assert.throws(() => client.actions.waterPlant({ slot: 1 }), MgNotReadyError);
  });

  it('becomes ready on Welcome and seeds the sequencer from it', () => {
    const { client, transport } = makeClient();
    transport.deliverJson(welcome(10));
    assert.equal(client.isReady, true);
    assert.equal(client.selfPlayerId, 'p_1');
    assert.equal(client.sequencer.peek(), 11);
  });

  it('does not seed from a fractional frontier', () => {
    // I4: `Welcome.executedCommandSequence` is untrusted input. Before the canonical gate, `2.5` seeded
    // the counter to `3.5`, opened the readiness gate, and would have put a non-integer sequence on the
    // wire, which the server answers with `invalid_sequence`, poisoning every later command.
    const { client, transport } = makeClient();
    transport.deliverJson(welcome(2.5));
    assert.equal(client.isReady, false, 'a non-canonical frontier must not open the gate');
    assert.equal(client.sequencer.peek(), 1, 'the counter must stay at its pre-Welcome value');
    assert.throws(() => client.send('ping', {}), MgNotReadyError);
  });

  it('ignores every non-canonical frontier shape', () => {
    // `NaN` cannot survive JSON, since `JSON.stringify` writes it as `null`, so it reaches the client as the
    // `null` case; the rest are the shapes the field can actually carry.
    const shapes: unknown[] = [2.5, -1, Number.NaN, '7', null, undefined];
    for (const frontier of shapes) {
      const { client, transport } = makeClient();
      transport.deliverJson({ ...welcome(), executedCommandSequence: frontier });
      const label = frontier === undefined ? 'undefined' : String(frontier);
      assert.equal(client.isReady, false, `a frontier of ${label} must not open the gate`);
      assert.equal(client.sequencer.peek(), 1, `a frontier of ${label} must not move the counter`);
    }
  });

  it('opens the gate when a state frame supplies the frontier', () => {
    // The fallback the tightened gate needs: a `Welcome` with no canonical frontier is not ready, but the
    // first `RoomFrame` that carries one seeds the counter and readies the client.
    const { client, transport } = makeClient();
    transport.deliverJson(welcome(2.5));
    assert.equal(client.isReady, false);
    assert.equal(client.sequencer.peek(), 1);
    transport.deliverJson({
      type: 'RoomFrame',
      executedCommandSequence: 7,
      state: { patches: [] },
    });
    assert.equal(client.isReady, true);
    assert.equal(client.sequencer.peek(), 8);
  });

  it('does not open the gate on a fractional state-frame frontier', () => {
    // The frame path reads the frontier too, so it must apply the same canonical rule as `Welcome`. A
    // `Number.isFinite` check here would seed `3.5` and ready the client on an illegal value.
    const { client, transport } = makeClient();
    transport.deliverJson({
      type: 'Welcome',
      selfPlayerId: 'p_1',
      fullState: { data: {}, child: { data: {} } },
    });
    assert.equal(client.isReady, false);
    transport.deliverJson({ type: 'RoomFrame', executedCommandSequence: 2.5, state: { patches: [] } });
    assert.equal(client.isReady, false);
    assert.equal(client.sequencer.frontier, null);
    assert.equal(client.sequencer.peek(), 1);
  });

  it('readies a waiting caller when only a state frame supplies the frontier', async () => {
    // What a caller that relied on the old gate sees: `waitUntilReady` no longer resolves on a frontier-less
    // Welcome, but it still resolves on the frame that does carry one instead of timing out.
    const { client, transport } = makeClient();
    const pending = client.waitUntilReady(1000);
    transport.deliverJson({
      type: 'Welcome',
      selfPlayerId: 'p_1',
      fullState: { data: {}, child: { data: {} } },
    });
    assert.equal(client.isReady, false);
    transport.deliverJson({ type: 'RoomFrame', executedCommandSequence: 4, state: { patches: [] } });
    await pending;
    assert.equal(client.sequencer.peek(), 5);
  });

  it('still seeds and readies from a canonical Welcome', () => {
    const { client, transport } = makeClient();
    transport.deliverJson(welcome(1157));
    assert.equal(client.isReady, true);
    assert.equal(client.sequencer.peek(), 1158);
  });

  it('seeds a frontier-less Welcome from a canonical frontier reader', () => {
    // Audit 03 F5: the bootstrapped core carries a live frontier reader. A Welcome that lost its frontier
    // (the stand-in for a missed one) must still be able to ready the session, but only from canonical
    // evidence, so a reader cannot smuggle in a fractional counter either.
    const transport = new FakeTransport();
    const client = new ClientCore({ transport, getFrontier: () => 41 });
    transport.deliverJson({
      type: 'Welcome',
      selfPlayerId: 'p_1',
      fullState: { data: {}, child: { data: {} } },
    });
    assert.equal(client.isReady, true);
    assert.equal(client.sequencer.peek(), 42);
  });

  it('refuses a frontier-less Welcome whose frontier reader is non-canonical', () => {
    const transport = new FakeTransport();
    const client = new ClientCore({ transport, getFrontier: () => 2.5 });
    transport.deliverJson({
      type: 'Welcome',
      selfPlayerId: 'p_1',
      fullState: { data: {}, child: { data: {} } },
    });
    assert.equal(client.isReady, false);
    assert.equal(client.sequencer.peek(), 1);
  });

  it('populates room and game state at their documented depths', () => {
    const { client, transport } = makeClient();
    transport.deliverJson(welcome());
    assert.deepEqual(client.room, {
      players: [{ id: 'p_1', coins: 100 }],
      chat: [],
      hostPlayerId: 'p_1',
    });
    assert.deepEqual(client.game, { userSlots: [{ data: { activityLogs: [] } }] });
    assert.equal(client.store.get('/data/players/0/coins'), 100);
    assert.deepEqual(client.store.get('/child/data/userSlots'), [{ data: { activityLogs: [] } }]);
  });

  it('tolerates a Welcome with a partial fullState', () => {
    const { client, transport } = makeClient();
    transport.deliverJson({ type: 'Welcome', selfPlayerId: 'p_1', executedCommandSequence: 0 });
    assert.equal(client.isReady, true);
    assert.deepEqual(client.store.get('/child/data'), {});
  });

  it('resolves waitUntilReady', async () => {
    const { client, transport } = makeClient();
    const pending = client.waitUntilReady(1000);
    transport.deliverJson(welcome());
    await pending;
  });

  it('rejects waitUntilReady on timeout', async () => {
    const { client } = makeClient();
    await assert.rejects(client.waitUntilReady(10), /not ready within/);
  });

  it('drops readiness when the transport closes', () => {
    const { client, transport } = makeClient();
    transport.deliverJson(welcome());
    transport.state = 'closed';
    transport.close(4400, 'idle');
    assert.equal(client.isReady, false);
    assert.equal(client.selfPlayerId, null);
  });

  it('does not let a frame that arrives after a close reopen the session', () => {
    // The transport seam is constructor-only, so a core whose socket closed has no session left to
    // ready: a close is permanent for that core. A stray `Welcome` used to re-set `welcome` and
    // `selfPlayerId` and re-open `ready`, which made the `welcome` accessor's claim ("a Welcome outlives
    // neither a close nor a `stop()`") false. The state-frame route to readiness is the same hazard, so
    // a `PartialState` after the close must not ready the core either.
    const { client, transport } = makeClient();
    transport.deliverJson(welcome(10, 'p_1'));
    transport.state = 'closed';
    transport.close(4400, 'idle');

    transport.deliverJson(welcome(20, 'p_2'));
    assert.equal(client.isReady, false, 'a closed session must not become ready on a late Welcome');
    assert.equal(client.selfPlayerId, null);
    assert.equal(client.welcome, null);

    // A frontier-bearing state frame is the second path to `ready` (`handleStateFrame`'s fallback).
    transport.deliverJson({ type: 'PartialState', executedCommandSequence: 30, patches: [] });
    assert.equal(client.isReady, false, 'a closed session must not become ready on a late state frame');
  });
});

// --------------------------------------------------------------------------------------
// Sending and form selection
// --------------------------------------------------------------------------------------

describe('ClientCore: sending', () => {
  it('sends a room-scoped action flat with the Room scope', () => {
    const { client, transport } = makeClient();
    transport.deliverJson(welcome());
    void client.actions.chat({ message: 'hi' });
    assert.deepEqual(transport.frames()[0], { scopePath: ['Room'], type: 'Chat', message: 'hi' });
  });

  it('sends a flat Quinoa action without an envelope and without consuming a sequence number', () => {
    const { client, transport } = makeClient();
    transport.deliverJson(welcome(10));
    void client.actions.teleport({ x: 1, y: 2 });
    assert.deepEqual(transport.frames()[0], {
      scopePath: ['Room', 'Quinoa'],
      type: 'Teleport',
      position: { x: 1, y: 2 },
    });
    assert.equal(client.sequencer.lastIssued, 10, 'a flat action must not take a sequence number');
  });

  it('wraps a wrapped action and stamps the next sequence number', () => {
    const { client, transport } = makeClient();
    transport.deliverJson(welcome(10));
    void client.actions.waterPlant({ slot: 3 });
    const frame = transport.frames()[0];
    assert.equal(frame?.type, 'QuinoaCommand');
    assert.deepEqual(frame?.scopePath, ['Room', 'Quinoa']);
    assert.equal(frame?.commandSequence, 11);
    assert.deepEqual(frame?.command, { type: 'WaterPlant', slot: 3 });
    assert.equal(typeof frame?.requestId, 'string');
  });

  it('increments contiguously across successive wrapped actions', () => {
    const { client, transport } = makeClient();
    transport.deliverJson(welcome(10));
    void client.actions.waterPlant({ slot: 1 });
    void client.actions.waterPlant({ slot: 2 });
    void client.actions.sellAllCrops();
    assert.deepEqual(
      transport.frames().map((frame) => frame.commandSequence),
      [11, 12, 13],
    );
  });

  it('stamps monotonically even when a flat action interleaves', () => {
    const { client, transport } = makeClient();
    transport.deliverJson(welcome(10));
    void client.actions.waterPlant({ slot: 1 });
    void client.actions.teleport({ x: 0, y: 0 });
    void client.actions.waterPlant({ slot: 2 });
    const sequences = transport
      .frames()
      .filter((frame) => frame.type === 'QuinoaCommand')
      .map((frame) => frame.commandSequence);
    assert.deepEqual(sequences, [11, 12]);
  });

  it('honours a form override at runtime', () => {
    const { client, transport } = makeClient();
    transport.deliverJson(welcome());
    client.forms.setActionForm('Wish', 'flat');
    void client.actions.wish({ itemId: 'coin' });
    assert.deepEqual(transport.frames()[0], {
      scopePath: ['Room', 'Quinoa'],
      type: 'Wish',
      itemId: 'coin',
    });
  });

  it('sends a pre-built frame verbatim via sendRaw', () => {
    const { client, transport } = makeClient();
    transport.deliverJson(welcome());
    client.sendRaw({ scopePath: ['Room'], type: 'UsurpHost' });
    assert.equal(transport.sent[0], '{"scopePath":["Room"],"type":"UsurpHost"}');
  });
});

// --------------------------------------------------------------------------------------
// Sequence integrity: a gap poisons every later command
// --------------------------------------------------------------------------------------

describe('ClientCore: sequence integrity', () => {
  it('does not consume a sequence number when the action is unknown', () => {
    // REGRESSION: `take()` used to run before `buildFrame()`. An unknown action threw AFTER a number
    // was consumed, leaving a gap, which the server answers with `invalid_sequence` and then rejects
    // every later command too. The number must be given back.
    const { client, transport } = makeClient();
    transport.deliverJson(welcome(10));
    assert.equal(client.sequencer.peek(), 11);

    assert.throws(() => client.send('NotARealAction'), /Unknown action/);
    assert.equal(client.sequencer.peek(), 11, 'the number must not have been consumed');

    // And the next real command must still be contiguous.
    void client.actions.waterPlant({ slot: 1 });
    assert.equal(transport.frames()[0]?.commandSequence, 11);
  });

  it('rolls the sequence number back when the transport throws', () => {
    // REGRESSION: a frame that never reaches the wire is a gap, not a command.
    const transport = new FakeTransport();
    const client = new ClientCore({ transport, timeouts: { commandAckMs: 50 } });
    transport.deliverJson(welcome(10));

    const originalSend = transport.send.bind(transport);
    let failNext = true;
    transport.send = (raw: string): void => {
      if (failNext) {
        failNext = false;
        throw new Error('socket is gone');
      }
      originalSend(raw);
    };

    // `send()` rethrows the transport error synchronously, so a caller must learn immediately that the
    // frame never left.
    assert.throws(() => client.actions.waterPlant({ slot: 1 }), /socket is gone/);
    assert.equal(client.sequencer.peek(), 11, 'the number must be rolled back');

    void client.actions.waterPlant({ slot: 2 });
    const frames = transport.frames();
    assert.equal(frames.length, 1, 'only the second frame reached the wire');
    assert.equal(frames[0]?.commandSequence, 11, 'and it must reuse the freed number');
  });

  it('keeps the envelope requestId and the ledger requestId identical', () => {
    // They used to be generated independently and reconciled by a scan; they must simply agree.
    const { client, transport } = makeClient();
    transport.deliverJson(welcome());
    const handle = client.actions.waterPlant({ slot: 1 });
    assert.equal(transport.frames()[0]?.requestId, handle.requestId);
    assert.equal(client.sequencer.pending[0]?.requestId, handle.requestId);
  });

  it('gives every command a distinct internal requestId', () => {
    const { client, transport } = makeClient();
    transport.deliverJson(welcome());
    const a = client.actions.chat({ message: 'one' });
    const b = client.actions.chat({ message: 'two' });
    assert.notEqual(a.requestId, b.requestId);
    // A room-scoped frame carries no requestId on the wire; the envelope is the only place it exists.
    // The handle still has one, because it is the correlation key for the ledger.
    assert.equal(
      transport.frames().every((frame) => !('requestId' in frame)),
      true,
    );
  });

  it('puts the requestId on the wire only for wrapped actions', () => {
    const { client, transport } = makeClient();
    transport.deliverJson(welcome());
    const wrapped = client.actions.waterPlant({ slot: 1 });
    const flat = client.actions.teleport({ x: 0, y: 0 });
    const frames = transport.frames();
    assert.equal(frames[0]?.requestId, wrapped.requestId);
    assert.equal('requestId' in (frames[1] ?? {}), false);
    // The flat handle is still addressable in the ledger under its own key.
    assert.ok(flat.requestId.length > 0);
  });

  it('marks an unsequenced action with a sequence of -1 rather than a bogus number', () => {
    const { client, transport } = makeClient();
    transport.deliverJson(welcome(10));
    const handle = client.actions.chat({ message: 'hi' });
    assert.equal(handle.sequence, -1);
    assert.equal(client.sequencer.lastIssued, 10, 'and it must not advance the counter');
  });

  it('does not roll back over a number that a later frame already used', () => {
    // The guard that makes `rollback` safe: it only applies to the newest number.
    const { client, transport } = makeClient();
    transport.deliverJson(welcome(10));
    void client.actions.waterPlant({ slot: 1 });
    void client.actions.waterPlant({ slot: 2 });
    assert.equal(client.sequencer.rollback(11), false, 'must not rewind over an in-flight number');
    assert.equal(client.sequencer.peek(), 13);
  });
});

// --------------------------------------------------------------------------------------
// Ack correlation: the honest part
// --------------------------------------------------------------------------------------

describe('ClientCore: ack correlation', () => {
  it('matches exactly and reports confirmed when the server echoes requestId', async () => {
    const { client, transport } = makeClient('strict');
    transport.deliverJson(welcome());
    const handle = client.actions.waterPlant({ slot: 1 });
    const frame = transport.frames()[0];

    transport.deliverJson({
      type: 'QuinoaCommandResult',
      requestId: frame?.requestId,
      commandType: 'WaterPlant',
      ok: true,
    });

    const result = await handle;
    assert.equal(result.ok, true);
    assert.equal(result.confirmed, true);
    assert.equal(result.matchMethod, 'requestId');
  });

  it('reports fifo matches as NOT confirmed, because ordering is probable not proof', async () => {
    // This is the documented default case: the payload carries no requestId at all.
    const { client, transport } = makeClient('fifo');
    transport.deliverJson(welcome());
    const handle = client.actions.waterPlant({ slot: 1 });

    transport.deliverJson({ type: 'QuinoaCommandResult', commandType: 'WaterPlant', ok: true });

    const result = await handle;
    assert.equal(result.ok, true);
    assert.equal(result.confirmed, false, 'a fifo match must never claim confirmation');
    assert.equal(result.matchMethod, 'fifo');
  });

  it('does not match in strict mode when no requestId comes back', async () => {
    const { client, transport } = makeClient('strict');
    transport.deliverJson(welcome());
    const handle = client.actions.waterPlant({ slot: 1 });
    transport.deliverJson({ type: 'QuinoaCommandResult', commandType: 'WaterPlant', ok: true });
    // Nothing was matched, so the handle ages out as unconfirmed rather than being resolved.
    await assert.rejects(handle.result, /was not confirmed/);
  });

  it('rejects with a structured rejection on a failed command', async () => {
    const { client, transport } = makeClient('fifo');
    transport.deliverJson(welcome());
    const handle = client.actions.waterPlant({ slot: 1 });
    const frame = transport.frames()[0];

    transport.deliverJson({
      type: 'QuinoaCommandResult',
      requestId: frame?.requestId,
      commandType: 'WaterPlant',
      ok: false,
      code: 'no_slot',
    });

    await assert.rejects(handle.result, (error: unknown) => {
      assert.ok(error instanceof MgCommandRejectedError);
      assert.equal(error.rejection.code, 'no_slot');
      assert.equal(error.rejection.suggestsWrongForm, false);
      return true;
    });
  });

  it('flags the wrong-form signature when the server cannot name the command', async () => {
    const { client, transport } = makeClient('fifo');
    transport.deliverJson(welcome());
    const handle = client.actions.waterPlant({ slot: 1 });
    transport.deliverJson({
      type: 'QuinoaCommandResult',
      commandType: 'unknown',
      ok: false,
      code: 'invalid_message',
    });
    await assert.rejects(handle.result, (error: unknown) => {
      assert.ok(error instanceof MgCommandRejectedError);
      assert.equal(error.rejection.suggestsWrongForm, true);
      return true;
    });
  });

  it('attributes an unnamed rejection to the oldest pending command', async () => {
    const { client, transport } = makeClient('fifo');
    transport.deliverJson(welcome());
    const first = client.actions.waterPlant({ slot: 1 });
    const second = client.actions.waterPlant({ slot: 2 });

    transport.deliverJson({ type: 'QuinoaCommandResult', commandType: 'unknown', ok: false });

    await assert.rejects(first.result);
    // The second is still pending, so it must not have been settled.
    assert.equal(client.report.pending, 1);
    second.result.catch(() => {});
  });

  it('ages out an unmatched command as unconfirmed rather than failing it', async () => {
    const { client, transport } = makeClient('fifo');
    transport.deliverJson(welcome());
    const handle = client.actions.waterPlant({ slot: 1 });
    await assert.rejects(handle.result, /may or may not have executed/);
  });

  it('ignores every result in ackMode none, and still settles the handle on timeout', async () => {
    // `none` disables correlation, not settlement. A promise that never settles would hang `await`
    // forever and leak the ledger entry.
    const { client, transport } = makeClient('none');
    transport.deliverJson(welcome());
    const handle = client.actions.waterPlant({ slot: 1 });
    transport.deliverJson({
      type: 'QuinoaCommandResult',
      requestId: transport.frames()[0]?.requestId,
      commandType: 'WaterPlant',
      ok: true,
    });
    assert.equal(client.report.pending, 1, 'an echoed requestId must still be ignored');
    await assert.rejects(handle.result, /was not confirmed/);
    assert.equal(client.report.pending, 0, 'the ledger entry must not leak');
  });

  it('exposes a settled promise that never rejects', async () => {
    const { client, transport } = makeClient('fifo');
    transport.deliverJson(welcome());
    const handle = client.actions.waterPlant({ slot: 1 });
    transport.deliverJson({
      type: 'QuinoaCommandResult',
      commandType: 'WaterPlant',
      ok: false,
      code: 'no_slot',
    });
    const settled = await handle.settled;
    assert.equal(settled?.ok, false);
  });

  it('keeps the same store across a reconnect when one is supplied', () => {
    // REGRESSION: a reconnect requires a new ClientCore (the transport seam is constructor-only), which
    // used to mean a NEW store. A caller who cached `client.store` then held a dead store that silently
    // stopped receiving patches.
    const first = makeClient();
    first.transport.deliverJson(welcome(1));
    first.client.store.subscribe('/data/players/0/coins', () => {});

    const shared = first.client.store;
    const secondTransport = new FakeTransport();
    const second = new ClientCore({ transport: secondTransport, store: shared });

    assert.equal(second.store, shared, 'the store identity must survive the reconnect');
    assert.equal(shared.stats.subscribers, 1, 'and so must its subscriptions');

    const before = shared.version;
    secondTransport.deliverJson(welcome(50));
    // The subscription is still live on the reused store, and the new Welcome replaced the tree on it.
    assert.equal(shared.get('/data/players/0/coins'), 100);
    // INVARIANT I8: this line used to read `second.store.version > first.client.store.version`, and
    // `second.store === first.client.store === shared`, so it compared a number with itself and could
    // never fail. `before` is captured from the same store immediately before the second `Welcome`, which
    // is the only reference point that makes the assertion mean "replaceRoot bumped it".
    assert.ok(shared.version > before, 'replaceRoot bumped the same store');
  });

  it('creates a fresh store when none is supplied', () => {
    const a = makeClient();
    const b = makeClient();
    assert.notEqual(a.client.store, b.client.store);
  });

  it('ignores a result for an action with nothing pending', () => {
    const { transport } = makeClient('fifo');
    transport.deliverJson(welcome());
    assert.doesNotThrow(() =>
      transport.deliverJson({ type: 'QuinoaCommandResult', commandType: 'HarvestCrop', ok: true }),
    );
  });
});

// --------------------------------------------------------------------------------------
// State frames and the DroppedStale inference
// --------------------------------------------------------------------------------------

describe('ClientCore: state frames', () => {
  it('applies a PartialState patch', () => {
    const { client, transport } = makeClient();
    transport.deliverJson(welcome());
    transport.deliverJson({
      type: 'PartialState',
      patches: [{ op: 'replace', path: '/data/players/0/coins', value: 1250 }],
    });
    assert.equal(client.store.get('/data/players/0/coins'), 1250);
  });

  it('applies a RoomFrame patch and reads the frontier from it', () => {
    const { client, transport } = makeClient();
    transport.deliverJson(welcome(10));
    transport.deliverJson({
      type: 'RoomFrame',
      executedCommandSequence: 25,
      state: { patches: [{ op: 'replace', path: '/data/players/0/coins', value: 77 }] },
    });
    assert.equal(client.store.get('/data/players/0/coins'), 77);
    assert.equal(client.sequencer.frontier, 25);
    assert.equal(client.sequencer.peek(), 26, 'the frontier must advance the sequencer');
  });

  it('emits state and partialState events', () => {
    const { client, transport } = makeClient();
    let stateEvents = 0;
    let partialEvents = 0;
    client.on('state', () => {
      stateEvents += 1;
    });
    client.on('partialState', (event) => {
      partialEvents += 1;
      assert.equal(event.patches.length, 1);
    });
    transport.deliverJson(welcome());
    transport.deliverJson({
      type: 'PartialState',
      patches: [{ op: 'replace', path: '/data/players/0/coins', value: 1 }],
    });
    assert.equal(partialEvents, 1);
    assert.equal(stateEvents, 2, 'one for the snapshot, one for the patch');
  });

  it('synthesizes DroppedStale when the frontier passes an unanswered command', () => {
    // The server never sends this code; the API reference calls it "a client-side inference".
    const { client, transport } = makeClient();
    transport.deliverJson(welcome(0));
    const handle = client.actions.waterPlant({ slot: 1 });
    handle.result.catch(() => {});

    // The event is captured into a list rather than a `let`: the assignment happens inside a callback,
    // which control-flow analysis cannot follow, and `dropped?.action` on a `null`-initialised `let`
    // narrows to `never`.
    const dropped: { action: string }[] = [];
    client.on('droppedStale', (event) => {
      dropped.push(event);
    });

    transport.deliverJson({
      type: 'RoomFrame',
      executedCommandSequence: 5,
      state: { patches: [{ op: 'replace', path: '/data/players/0/coins', value: 2 }] },
    });

    assert.equal(dropped[0]?.action, 'WaterPlant');
  });

  it('rejects a dropped-stale handle with the synthesized code', async () => {
    const { client, transport } = makeClient();
    transport.deliverJson(welcome(0));
    const handle = client.actions.waterPlant({ slot: 1 });
    transport.deliverJson({
      type: 'RoomFrame',
      executedCommandSequence: 5,
      state: { patches: [{ op: 'replace', path: '/data/players/0/coins', value: 2 }] },
    });
    await assert.rejects(handle.result, (error: unknown) => {
      assert.ok(error instanceof MgCommandRejectedError);
      assert.equal(error.rejection.code, 'dropped_stale');
      return true;
    });
  });

  it('reports an unparseable frame instead of throwing', () => {
    const { client, transport } = makeClient();
    let raw: string | null = null;
    client.on('unparsed', (event) => {
      raw = event.raw;
    });
    transport.deliverJson(welcome());
    assert.doesNotThrow(() => transport.deliver('<html>nope</html>'));
    assert.equal(raw, '<html>nope</html>');
  });

  it('drops an oversized frame and records the outcome', () => {
    const { client, transport } = makeClient();
    const oversized: Array<{ bytes: number; limit: number }> = [];
    let unparsed = 0;
    client.on('oversizedFrame', (event) => {
      oversized.push(event);
    });
    client.on('unparsed', () => {
      unparsed += 1;
    });
    transport.deliverJson(welcome());

    // Mirrors `MAX_FRAME_BYTES` in `../src/protocol/codec.js`. Spelled out rather than imported so this
    // test can be run against the pre-fix source and fail on behaviour, not on a missing export.
    const cap = 8 * 1024 * 1024;
    transport.deliver('x'.repeat(cap + 1));

    assert.deepEqual(oversized, [{ bytes: cap + 1, limit: cap }]);
    assert.equal(unparsed, 0, 'an oversized frame must not also be reported as unparseable');
    const event = oversized[0];
    assert.ok(event);
    assert.equal(Object.hasOwn(event, 'raw'), false, 'the frame itself must not be retained');
  });

  it('reports an unknown message type instead of throwing', () => {
    const { client, transport } = makeClient();
    let type: string | null = null;
    client.on('unknownMessage', (event) => {
      type = event.type;
    });
    transport.deliverJson({ type: 'FutureThing', x: 1 });
    assert.equal(type, 'FutureThing');
  });

  it('does not surface the bare-string keepalive as a message', () => {
    const { client, transport } = makeClient();
    let messages = 0;
    client.on('unknownMessage', () => {
      messages += 1;
    });
    client.on('unparsed', () => {
      messages += 1;
    });
    transport.deliver('ping');
    assert.equal(messages, 0);
  });

  it('answers the keepalive only when the transport does not', () => {
    // The headless transport owns the keepalive; the bootstrapped one must leave the host's alone.
    const own = makeClient();
    own.transport.deliverJson(welcome());
    own.client.transport.send('pong');
    assert.equal(own.transport.sent.at(-1), 'pong');

    const transport = new FakeTransport();
    // Constructing the core is the act under test: it is what subscribes to the transport's traffic.
    void new ClientCore({ transport, autoHandledKeepalive: true });
    transport.deliver('ping');
    assert.deepEqual(transport.sent, ['pong'], 'the core answers when the transport does not');
  });

  it('tolerates a /child-less patch path by falling back', () => {
    const { client, transport } = makeClient();
    transport.deliverJson(welcome());
    // The tree is fullState-rooted, so a game-state patch without the prefix needs the fallback.
    transport.deliverJson({
      type: 'PartialState',
      patches: [{ op: 'replace', path: '/child/data/userSlots/0/data/activityLogs', value: ['x'] }],
    });
    assert.deepEqual(client.store.get('/child/data/userSlots/0/data/activityLogs'), ['x']);
  });

  it('survives a patch that cannot be applied anywhere', () => {
    const { client, transport } = makeClient();
    transport.deliverJson(welcome());
    assert.doesNotThrow(() =>
      transport.deliverJson({
        type: 'PartialState',
        // `chat` is an array, so `oops` is not a valid index and cannot be created into existence.
        patches: [{ op: 'add', path: '/data/chat/oops', value: 1 }],
      }),
    );
    assert.equal(client.report.state.patchFailures, 1);
  });
});

// --------------------------------------------------------------------------------------
// Ledger reconciliation
// --------------------------------------------------------------------------------------

describe('ClientCore: ledger reconciliation', () => {
  /** The ack deadline is armed at 50 ms by `makeClient`, so the timeout needs a real await. */
  async function expireOne(client: ClientCore, transport: FakeTransport): Promise<void> {
    transport.deliverJson(welcome(0));
    const handle = client.actions.waterPlant({ slot: 1 });
    await assert.rejects(handle.result, /may or may not have executed/);
  }

  it('does not fail a live command on a fractional RoomFrame frontier', async () => {
    // The reviewer's scenario: `Welcome` at 10, send (sequence 11), then a `RoomFrame` carrying an
    // untrusted `executedCommandSequence: 11.5`. `extractFrontier` accepts it (`Number.isFinite`), so the
    // raw value reached the ledger loop; the counter refused it, the ledger did not, and the live command
    // was reported `dropped_stale` while the caller still held its handle.
    const { client, transport } = makeClient('fifo');
    const dropped: { requestId: string }[] = [];
    client.on('droppedStale', (event) => {
      dropped.push(event);
    });

    transport.deliverJson(welcome(10));
    const handle = client.actions.waterPlant({ slot: 1 });
    const sent = transport.frames()[0];
    assert.equal(sent?.commandSequence, 11, 'the first command takes the sequence after the frontier');

    transport.deliverJson({
      type: 'RoomFrame',
      executedCommandSequence: 11.5,
      state: { patches: [{ op: 'replace', path: '/data/players/0/coins', value: 2 }] },
    });

    assert.deepEqual(dropped, [], 'a fraction is not a frontier and must not fail a live command');
    assert.equal(client.sequencer.pending.length, 1, 'the live command is still outstanding');
    assert.equal(client.report.pending, 1, 'and the caller still has a pending handle');
    assert.equal(client.sequencer.frontier, 10, 'the counter gate stays shut');

    // The command is still usable: acknowledging it settles the handle rather than a stale inference.
    transport.deliverJson({
      type: 'QuinoaCommandResult',
      requestId: sent?.requestId,
      commandType: 'WaterPlant',
      ok: true,
    });
    const result = await handle.result;
    assert.equal(result.ok, true, 'the acknowledgement settles the handle normally');
  });

  it('does not report a timed-out command twice', async () => {
    const { client, transport } = makeClient('fifo');
    const dropped: { requestId: string }[] = [];
    client.on('droppedStale', (event) => {
      dropped.push(event);
    });

    await expireOne(client, transport);

    // The timeout settles the caller's handle. The sequencer's ledger is a *second* bookkeeping of the
    // same command, and before the fix it was left behind: the entry survived, the frontier below
    // passed it, and the core reported the same command as `dropped_stale`, while `stats.pending`
    // (the handle map) already read 0.
    assert.equal(client.report.pending, 0, 'the handle map is empty after the timeout');
    assert.equal(client.sequencer.pending.length, 0, 'the timeout must reclaim the sequencer entry too');

    transport.deliverJson({
      type: 'RoomFrame',
      executedCommandSequence: 5,
      state: { patches: [{ op: 'replace', path: '/data/players/0/coins', value: 2 }] },
    });

    assert.equal(
      dropped.length,
      0,
      'a command that already timed out must not also be reported dropped-stale',
    );
    assert.equal(client.report.pending, 0);
    assert.equal(client.sequencer.pending.length, 0);
  });

  it('keeps the two pending counters equal across settle paths', async () => {
    // Every path that settles a handle must settle the sequencer entry by the same route, or the two
    // counters disagree for the rest of the connection's life. The two assertions below are read as a
    // pair on purpose: `report.pending` (the caller handles) and `sequencer.pending` (the wire ledger) are
    // independent bookkeepings, so the equality is an invariant in its own right: a path that empties one
    // and leaks the other fails on the equality, not merely on one of the two zeros.
    const bothEmpty = (client: ClientCore, path: string): void => {
      const handedToCaller = client.report.pending;
      const onTheWire = client.sequencer.pending.length;
      assert.equal(onTheWire, 0, `${path} must reclaim the sequencer entry`);
      assert.equal(handedToCaller, 0, `${path} must settle the caller's handle too`);
      assert.equal(handedToCaller, onTheWire, `${path}: the two counters must agree, not just both be zero`);
    };

    const acked = makeClient();
    acked.transport.deliverJson(welcome(0));
    acked.client.actions.waterPlant({ slot: 1 }).result.catch(() => {});
    acked.transport.deliverJson({
      type: 'QuinoaCommandResult',
      requestId: acked.transport.frames()[0]?.requestId,
      commandType: 'WaterPlant',
      ok: true,
    });
    bothEmpty(acked.client, 'ack');

    const closed = makeClient();
    closed.transport.deliverJson(welcome(0));
    closed.client.actions.waterPlant({ slot: 1 }).result.catch(() => {});
    closed.transport.close();
    bothEmpty(closed.client, 'close');

    const disposed = makeClient();
    disposed.transport.deliverJson(welcome(0));
    disposed.client.actions.waterPlant({ slot: 1 }).result.catch(() => {});
    await disposed.client.stop();
    bothEmpty(disposed.client, 'stop');
  });
});

// --------------------------------------------------------------------------------------
// Disposal
// --------------------------------------------------------------------------------------

describe('ClientCore: stop', () => {
  it('fails pending commands and detaches', async () => {
    const { client, transport } = makeClient();
    transport.deliverJson(welcome());
    const handle = client.actions.waterPlant({ slot: 1 });
    await client.stop();
    await assert.rejects(handle.result, /abandoned/);
    assert.equal(client.isReady, false);
  });

  it('stops receiving after stop', async () => {
    const { client, transport } = makeClient();
    transport.deliverJson(welcome());
    await client.stop();
    let messages = 0;
    client.on('state', () => {
      messages += 1;
    });
    transport.deliverJson({
      type: 'PartialState',
      patches: [{ op: 'replace', path: '/data/players/0/coins', value: 9 }],
    });
    assert.equal(messages, 0);
  });

  it('settles a pending readiness wait on stop', async () => {
    const { client } = makeClient();
    // A wait that would otherwise stay armed for the full timeout. Before the fix, `stop()` (then
    // `dispose()`) left it unsettled and the live timer kept the event loop alive, so this test did not
    // fail. It *hung* until the 60 s timer fired.
    const pending = client.waitUntilReady(60_000);
    await client.stop();
    await assert.rejects(pending, MgNotReadyError);
  });

  it('settles every pending readiness wait on stop, not only the most recent', async () => {
    const { client } = makeClient();
    // Two outstanding waits on a client that will never see `Welcome`. The recorded defect is that the
    // core held one slot (`readyWait`), so `stop()` (then `dispose()`) rejected only the second wait and
    // the first served out its full timeout, measured at 3000 ms, with its live timer holding the process
    // open that long.
    const first = client.waitUntilReady(2000);
    const second = client.waitUntilReady(2000);

    await client.stop();

    const outcome = await Promise.race([
      Promise.allSettled([first, second]).then(() => 'settled' as const),
      delay(250).then(() => 'still pending' as const),
    ]);
    assert.equal(
      outcome,
      'settled',
      'stop() left an earlier readiness wait pending; every outstanding wait must be rejected, not only the latest',
    );
    // The message distinguishes "stop settled it" from "the timeout fired", so a wait that is only
    // released late cannot pass by rejecting with the wrong reason.
    await assert.rejects(first, /stopped before it became ready/, 'the first wait must settle on stop');
    await assert.rejects(second, /stopped before it became ready/, 'the second wait settles too');
  });
});

// --------------------------------------------------------------------------------------
// --------------------------------------------------------------------------------------
// A store survives stop(), owned or supplied (audit 03 F1)
// --------------------------------------------------------------------------------------

describe('ClientCore: a store survives stop(), owned or supplied', () => {
  it("stop() leaves a caller-supplied store's subscribers alone", async () => {
    // The exact failure `ClientCoreOptions.store` exists to prevent. A reconnect builds a new core and
    // hands it the previous store so the caller's cached `client.store` keeps receiving patches. Before
    // the fix `stop()` called `store.clearSubscribers()` unconditionally, so the caller's subscription,
    // made on the *previous* core, was dropped by the teardown of a core it was handed to.
    const first = makeClient();
    first.transport.deliverJson(welcome(1));
    const shared = first.client.store;
    shared.subscribe('/data/players/0/coins', () => {});
    assert.equal(shared.stats.subscribers, 1);

    const secondTransport = new FakeTransport();
    const second = new ClientCore({ transport: secondTransport, store: shared });
    assert.equal(second.store, shared, 'the supplied store is reused, not replaced');

    await second.stop();

    assert.equal(
      shared.stats.subscribers,
      1,
      "the caller's subscription must outlive the core it was made on",
    );
    assert.equal(second.report.state.subscribers, 1, 'the report reads the store it was given');
    // And the store is still usable, not merely still counted: a fix that emptied the subscription map
    // would leave this new subscription on a store nobody can wake.
    let deliveriesAfterStop = 0;
    shared.subscribe('/data/players/0/coins', () => {
      deliveriesAfterStop += 1;
    });
    shared.applyPatches([{ op: 'replace', path: '/data/players/0/coins', value: 7 }]);
    assert.equal(
      deliveriesAfterStop,
      1,
      'the supplied store still delivers after the core that was handed it stops',
    );
  });

  it('stop() leaves the subscribers of a store it created alone too', async () => {
    // DELIBERATE DEVIATION from the task plan, which expected a "this core owns the store, so it may
    // clear it" branch to be the safe direction. It is not: `stop()` is also the teardown *between*
    // connect attempts, and `HeadlessClient` hands the previous attempt's store to the next core. That
    // store was created by the *old* core, so an ownership test still says "clear it" and the reconnect
    // loses every subscription, measured, before this test existed, as a cached subscription that fired
    // never again after a reconnect. The store's subscribers are never the core's to drop.
    const { client } = makeClient();
    let deliveries = 0;
    client.store.subscribe('/data/players/0/coins', () => {
      deliveries += 1;
    });
    assert.equal(client.store.stats.subscribers, 1);

    await client.stop();

    assert.equal(client.store.stats.subscribers, 1, 'a stopped core keeps the state tree it populated');
    client.store.applyPatches([{ op: 'replace', path: '/data/players/0/coins', value: 5 }]);
    assert.equal(deliveries, 1, 'and the subscription it held still works');
  });
});

// --------------------------------------------------------------------------------------
// The contract (MgClient)
// --------------------------------------------------------------------------------------

describe('ClientCore: adopts the one client contract', () => {
  it('stop() is idempotent and never throws', async () => {
    const { client } = makeClient();

    await client.stop();
    await client.stop();

    // `stop()` tears the core down but does not un-start the session: `started` reports "a start was
    // performed", so `start()` after `stop()` is refusable rather than silently wrong.
    assert.equal(client.report.started, true, 'stopping is not un-starting');
    assert.equal(client.report.ready, false);
  });

  it('start() after stop() is an MgConfigError', async () => {
    const { client } = makeClient();
    await client.stop();
    await assert.rejects(client.start(), MgConfigError);
  });

  it('report carries the version, the kind and an empty error list', () => {
    const { client } = makeClient();
    const report = client.report;
    assert.equal(report.version, MG_VERSION);
    assert.equal(report.kind, 'common');
    assert.deepEqual(report.errors, []);
    assert.equal(report.started, false);
    assert.equal(report.attachment, null);
    assert.equal(report.socketsSeen, 0);
    assert.equal(report.renumbering, false);
  });

  it('close carries the TransportCloseInfo wrapped as { info }', () => {
    const { client, transport } = makeClient();
    const seen: ClientCloseEvent[] = [];
    client.on('close', (event) => {
      seen.push(event);
    });

    transport.close(1001, 'going away');

    assert.equal(seen.length, 1, 'the close handler must fire once');
    assert.equal(seen[0]?.info.code, 1001);
    assert.equal(seen[0]?.info.reason, 'going away');
  });
});

// --------------------------------------------------------------------------------------
// Ping / Pong, and the raw send gate (audit 03 F2 + F8)
// --------------------------------------------------------------------------------------

describe('ClientCore: Pong answers a ping', () => {
  it('ping() resolves on the Pong reply instead of ageing out', async () => {
    // `Ping` is `flat` and is answered by a direct `Pong`, not by a `QuinoaCommandResult`. The core used to
    // `return` on `case 'Pong'`, so nothing settled the handle and `expirePending` rejected it with
    // `MgCommandUnconfirmedError` after the 50 ms ack deadline, so a ping that had succeeded on the wire
    // reported as unconfirmed. `ackMode: 'strict'` on purpose: a `fifo` accident must not be able to pass
    // this.
    const { client, transport } = makeClient('strict');
    transport.deliverJson(welcome());

    const handle = client.actions.ping({ id: 7 });
    // The ping really did go out carrying that id, because the Pong has to answer it.
    assert.equal(transport.frames()[0]?.id, 7, 'the flat Ping carries its id on the wire');

    transport.deliverJson({ type: 'Pong', id: 7 });

    const result = await handle;
    assert.equal(result.ok, true);
    assert.equal(result.matchMethod, 'requestId', 'the echoed id is proof, not a guess');
    assert.equal(result.confirmed, true);
    assert.equal(result.action, 'Ping');
  });

  it('ping() still ages out when the Pong answers a different id', async () => {
    // The negative control that keeps the first test honest: a `Pong` is only evidence for the ping whose
    // id it echoes, so an unmatched one must leave the handle to the ack deadline.
    const { client, transport } = makeClient('strict');
    transport.deliverJson(welcome());

    const handle = client.actions.ping({ id: 7 });
    transport.deliverJson({ type: 'Pong', id: 8 });

    await assert.rejects(handle.result, /was not confirmed/);
  });

  it("ackMode 'none' never correlates a Pong, so the ping ages out", async () => {
    // `'none'` is documented as *never* correlate: every handle settles from the frontier ledger or the
    // timeout. A `Pong` is a correlation like any other, so in `'none'` it must be ignored exactly as a
    // `QuinoaCommandResult` is, or otherwise the mode's own doc ("never correlate") is false for `Ping`.
    const { client, transport } = makeClient('none');
    transport.deliverJson(welcome());

    const handle = client.actions.ping({ id: 7 });
    transport.deliverJson({ type: 'Pong', id: 7 });

    assert.equal(client.report.pending, 1, 'an uncorrelated Pong must leave the Ping outstanding');
    await assert.rejects(handle.result, /was not confirmed/);
  });

  it('sendRaw refuses before Welcome', () => {
    const { client, transport } = makeClient();
    // A raw frame can carry a sequence-bearing envelope, so sending one before `Welcome` reaches the
    // server as `invalid_sequence` and can poison every later command. `send()` has always refused; the
    // raw seam did not, and an attachment's send hook is the caller that used it early.
    assert.throws(() => client.sendRaw({ type: 'X' }), MgNotReadyError);
    assert.deepEqual(transport.sent, [], 'nothing may reach the transport');
    // `lastError` answers "why did the transport last fail", so a readiness refusal is not recorded in
    // it, because the refusal is the throw, and it is the same rule `send()` follows. The `sendRaw` doc
    // says so.
    assert.equal(client.lastError, null, 'a pre-Welcome refusal is not a transport failure');
  });

  it('sendRaw records a transport failure in lastError', () => {
    const { client, transport } = makeClient();
    transport.deliverJson(welcome());
    transport.failSend = new Error('socket is gone');

    // Re-thrown on purpose: `sendRaw` is the seam a host's send hook calls, and swallowing a failed
    // write is the silent-failure class I8 exists to prevent.
    assert.throws(() => client.sendRaw({ type: 'X' }), /socket is gone/);
    assert.equal(client.lastError?.code, 'send_failed');
    // The recorded error is the typed `MgError` the hierarchy wraps it in, not the raw `Error`.
    assert.deepEqual(client.report.errors, [
      { name: 'MgError', code: 'send_failed', message: 'socket is gone' },
    ]);
  });
});

// --------------------------------------------------------------------------------------
// Identity is one fact, not two (audit 03 F7, invariant I6)
// --------------------------------------------------------------------------------------

describe('ClientCore: welcome and selfPlayerId agree across a close', () => {
  it('a close clears the welcome and the identity together', () => {
    // `welcomeValue` was assigned only in `handleWelcome` and cleared nowhere, while the close handler
    // cleared `selfPlayerId`. So after a close `client.selfPlayerId` was `null` while
    // `client.welcome?.selfPlayerId` still named the player who was no longer connected: two accessors for
    // one fact, disagreeing. I6 forbids exactly that.
    const { client, transport } = makeClient();
    transport.deliverJson(welcome(10, 'p_42'));
    assert.notEqual(client.welcome, null, 'the welcome must have landed');
    assert.equal(client.selfPlayerId, 'p_42');
    assert.equal(client.welcome?.selfPlayerId, client.selfPlayerId, 'the two accessors agree while live');
    assert.equal(client.report.selfPlayerId, 'p_42', 'and the report carries the same identity');

    transport.close();

    assert.equal(client.welcome, null, 'a Welcome describes a session that has ended');
    assert.equal(client.selfPlayerId, null);
    assert.equal(client.isReady, false);
    assert.equal(client.report.selfPlayerId, null, 'the report agrees with both accessors');
  });

  it('stop() clears the welcome too', async () => {
    const { client, transport } = makeClient();
    transport.deliverJson(welcome(10, 'p_42'));
    assert.notEqual(client.welcome, null);

    await client.stop();

    assert.equal(client.welcome, null, 'a stopped core has no session at all');
    assert.equal(client.selfPlayerId, null);
    assert.equal(client.report.selfPlayerId, null);
  });

  it('a close that is not a Welcome still reports no identity', () => {
    // The negative control for the report axis: `selfPlayerId` must be the honest `null` before any
    // `Welcome`, not a placeholder. That is the same rule that made `RoomSocket.playerId` return `''` a
    // defect.
    const { client, transport } = makeClient();
    transport.close();
    assert.equal(client.report.selfPlayerId, null);
    assert.equal(client.welcome, null);
  });
});
