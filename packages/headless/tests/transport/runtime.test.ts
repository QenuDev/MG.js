/**
 * The bare-string keepalive, tested against a fake socket.
 *
 * Protocol recon §1.7 is the specification:
 *
 *   > "After the handshake, the server also sends application-level text pings as the bare string
 *   > `"ping"` (not a WebSocket protocol ping). Reply with the bare string `"pong"`, verbatim, no JSON
 *   > wrapper. Miss enough of these and the server drops you with close code `4400` after r[oughly 30s]"
 *
 * The common package's `isKeepalivePing` exists because, in the doc's own words, "the exact quoting has
 * been observed both ways", so both `ping` and `"ping"` are exercised here, and the reply is asserted to
 * be the **bare** `pong` in both cases.
 *
 * A fake socket makes this a unit test with no I/O at all: `WebSocketFactory` is structurally typed, so a
 * hand-written object satisfies it and lets every assertion be about bytes on the wire.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isKeepalivePing, KEEPALIVE_PING, KEEPALIVE_PONG, MAX_FRAME_BYTES } from '@mg.js/common';
import { decodeSocketPayload } from '../../src/transport/runtime.js';
import { StandaloneTransport } from '../../src/transport/standalone.js';
import { connectedTransport, FakeFactory, FakeSocket } from '../fixtures/fake-socket.js';

describe('isKeepalivePing (the common helper this transport relies on)', () => {
  it('accepts both observed quoting forms and nothing else', () => {
    assert.equal(isKeepalivePing('ping'), true);
    assert.equal(isKeepalivePing('"ping"'), true);
    assert.equal(isKeepalivePing('pong'), false);
    assert.equal(isKeepalivePing('{"type":"Ping"}'), false);
    assert.equal(isKeepalivePing('ping '), false);
  });
});

describe('StandaloneTransport keepalive', () => {
  it('answers a bare "ping" with a bare "pong"', async () => {
    const { socket } = await connectedTransport();
    socket.message(KEEPALIVE_PING);
    assert.deepEqual(socket.sent, [KEEPALIVE_PONG]);
    assert.equal(socket.sent[0], 'pong');
  });

  it('answers the JSON-quoted \'"ping"\' with the same bare "pong"', async () => {
    const { socket } = await connectedTransport();
    socket.message('"ping"');
    assert.deepEqual(socket.sent, ['pong']);
  });

  it('never wraps the reply in JSON', async () => {
    const { socket } = await connectedTransport();
    socket.message(KEEPALIVE_PING);
    assert.equal(socket.sent[0], KEEPALIVE_PONG);
    // The flat `Ping` action's reply is `{"type":"Pong"}`; §1.7 warns they are different mechanisms, and
    // sending the wrong one is the confusion this assertion pins down.
    assert.equal(socket.sent[0]?.includes('{'), false);
    assert.equal(socket.sent[0]?.includes('Pong'), false);
    assert.equal(socket.sent.length, 1);
  });

  it('does not surface the keepalive as a message', async () => {
    const { transport, socket } = await connectedTransport();
    const seen: string[] = [];
    transport.onMessage((raw) => seen.push(raw));

    socket.message(KEEPALIVE_PING);
    socket.message('"ping"');
    assert.deepEqual(seen, [], 'keepalives must be consumed by the transport, not forwarded');

    socket.message('{"type":"Welcome"}');
    assert.deepEqual(seen, ['{"type":"Welcome"}']);
  });

  it('survives repeated ping cycles', async () => {
    const { transport, socket } = await connectedTransport();
    const seen: string[] = [];
    transport.onMessage((raw) => seen.push(raw));

    for (let cycle = 0; cycle < 5; cycle += 1) {
      socket.message(cycle % 2 === 0 ? KEEPALIVE_PING : '"ping"');
    }
    assert.deepEqual(socket.sent, ['pong', 'pong', 'pong', 'pong', 'pong']);
    assert.deepEqual(seen, []);
    assert.equal(transport.state, 'open');
  });

  it('does not let a throwing reply escape the message handler', async () => {
    const { transport, socket } = await connectedTransport();
    socket.sendError = new Error('socket died mid-write');
    // No throw: the handler catches, records `lastError`, and the close event is the real signal.
    assert.doesNotThrow(() => socket.message(KEEPALIVE_PING));
    assert.equal((transport.lastError as Error).message, 'socket died mid-write');
  });

  it('keeps working after a message-handler subscriber throws', async () => {
    const { transport, socket } = await connectedTransport();
    transport.onMessage(() => {
      throw new Error('bad subscriber');
    });
    const seen: string[] = [];
    transport.onMessage((raw) => seen.push(raw));

    assert.doesNotThrow(() => socket.message('{"type":"Welcome"}'));
    assert.deepEqual(seen, ['{"type":"Welcome"}']);
  });
});

describe('StandaloneTransport close serialisation', () => {
  it('reports a server close as not-manual and not-clean', async () => {
    const { transport, socket } = await connectedTransport();
    const closes: Array<{ code: number; reason: string; wasClean: boolean; wasManual: boolean }> = [];
    transport.onClose((info) => closes.push(info));

    socket.closed({ code: 4400, reason: 'idle timeout', wasClean: true });
    assert.deepEqual(closes, [{ code: 4400, reason: 'idle timeout', wasClean: true, wasManual: false }]);
    assert.equal(transport.state, 'closed');
  });

  it('marks a local close as manual, the flag that suppresses reconnect', async () => {
    const { transport, socket } = await connectedTransport();
    const closes: Array<{ code: number; wasManual: boolean }> = [];
    transport.onClose((info) => closes.push({ code: info.code, wasManual: info.wasManual }));

    transport.close(1000, 'client disconnect');
    assert.equal(socket.closes[0]?.code, 1000);
    assert.equal(closes.length, 1);
    assert.equal(closes[0]?.code, 1000);
    assert.equal(closes[0]?.wasManual, true);
    assert.equal(transport.state, 'closed');
  });

  it('synthesises a close when close() itself throws, so the client is never left attached', async () => {
    const { transport, socket } = await connectedTransport();
    const closes: Array<{ wasManual: boolean }> = [];
    transport.onClose((info) => closes.push({ wasManual: info.wasManual }));

    socket.close = () => {
      throw new Error('close failed');
    };
    transport.close(1000, 'client disconnect');

    assert.equal(closes.length, 1);
    assert.equal(closes[0]?.wasManual, true);
    assert.equal(transport.state, 'closed');
  });

  it('dispatches at most one close per socket generation', async () => {
    const { transport, socket } = await connectedTransport();
    let count = 0;
    transport.onClose(() => {
      count += 1;
    });

    socket.closed({ code: 1006, reason: '', wasClean: false });
    // A second close event from the same socket (which some runtimes can emit after a manual close) must
    // not produce a second notification, or the client would schedule two reconnects.
    socket.closed({ code: 1006, reason: '', wasClean: false });
    assert.equal(count, 1);
  });

  it('defaults a payload-less close to 1006 rather than 0', async () => {
    const { transport, socket } = await connectedTransport();
    const closes: number[] = [];
    transport.onClose((info) => closes.push(info.code));
    socket.closed({});
    // `analyzeClose(0, ...)` would be an unrecognised standard code; 1006 is the spec's "abnormal closure"
    // and is what both implementations report for a dropped socket.
    assert.deepEqual(closes, [1006]);
  });
});

describe('StandaloneTransport headers', () => {
  it('passes headers through when the runtime supports them', async () => {
    await connectedTransport({ headers: { Origin: 'https://magicgarden.gg' } });
    assert.deepEqual(FakeSocket.constructed[0]?.options, {
      // The frame ceiling always reaches the constructor, headers or no headers.
      maxPayload: MAX_FRAME_BYTES,
      headers: { Origin: 'https://magicgarden.gg' },
    });
  });

  it('does not pretend headers were sent when the runtime cannot carry them', async () => {
    FakeSocket.constructed.length = 0;
    let reported: Record<string, string> | null = null;
    const transport = new StandaloneTransport({
      runtime: {
        kind: 'global',
        factory: FakeFactory,
        supportsHeaders: false,
        description: 'globalThis.WebSocket',
      },
      headers: { Origin: 'https://magicgarden.gg', 'User-Agent': 'ua' },
      onHeadersUnsupported: (dropped) => {
        reported = dropped as unknown as Record<string, string>;
      },
    });
    const connecting = transport.connect('wss://example.test/');
    FakeSocket.last?.open();
    await connecting;

    // No `headers` key at all: absence is the honest signal, since the real global would ignore it.
    assert.equal(FakeSocket.constructed[0]?.options?.headers, undefined);
    assert.ok(reported);
    assert.equal((reported as unknown as Record<string, string>).Origin, 'https://magicgarden.gg');
  });
});

describe('decodeSocketPayload', () => {
  it('decodes every payload shape a runtime can deliver', () => {
    assert.equal(decodeSocketPayload('ping'), 'ping');
    assert.equal(decodeSocketPayload(Buffer.from('ping')), 'ping');
    assert.equal(decodeSocketPayload(new TextEncoder().encode('ping').buffer), 'ping');
    assert.equal(decodeSocketPayload({ data: 'ping' }), 'ping');
    assert.equal(decodeSocketPayload({ data: Buffer.from('ping') }), 'ping');
  });

  it('returns null for anything that is not decodable text', () => {
    assert.equal(decodeSocketPayload(undefined), null);
    assert.equal(decodeSocketPayload(null), null);
    assert.equal(decodeSocketPayload(42), null);
    assert.equal(decodeSocketPayload({}), null);
  });
});
