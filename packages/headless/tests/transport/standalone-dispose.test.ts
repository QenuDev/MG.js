/**
 * `dispose()` has to actually dispose.
 *
 * The defect these tests pin down: `dispose()` cleared the handler sets and dropped the socket
 * reference without ever calling `socket.close()`. Nothing threw, no existing test failed, and the
 * transport reported `closed`, but the TCP connection stayed open and the game server went on holding a
 * session whose events nobody was reading. A leak whose only symptom is a server-side session count is
 * what a unit test has to assert directly.
 *
 * Two consequences are covered, because they are the two halves of "totality": nothing may be left
 * *outside* the transport (a live socket, a listener still attached) and nothing may be left *inside* it
 * (a `connect()` whose promise can never settle now that its events have nowhere to land).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StandaloneTransport } from '../../src/transport/standalone.js';
import { connectedTransport, FakeFactory, FakeSocket } from '../fixtures/fake-socket.js';

/** A transport whose `connect()` has been called but whose socket has not opened yet. */
function connectingTransport(): {
  transport: StandaloneTransport;
  socket: FakeSocket;
  connecting: Promise<void>;
} {
  FakeSocket.constructed.length = 0;
  const transport = new StandaloneTransport({
    runtime: {
      kind: 'injected',
      factory: FakeFactory,
      supportsHeaders: true,
      description: 'fake socket',
    },
  });
  const connecting = transport.connect('wss://example.test/version/1/api/rooms/r/connect');
  const socket = FakeSocket.last;
  assert.ok(socket, 'expected the factory to have been called');
  return { transport, socket, connecting };
}

/** How a promise settled, without ever awaiting it. An unsettled promise must fail, not hang. */
async function settleOutcome(promise: Promise<void>): Promise<string> {
  let outcome = 'pending';
  void promise.then(
    () => {
      outcome = 'resolved';
    },
    (error: unknown) => {
      outcome = error instanceof Error ? error.message : 'rejected';
    },
  );
  // One macrotask turn is enough for any promise callback queued as a microtask.
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  return outcome;
}

describe('StandaloneTransport.dispose', () => {
  it('closes the socket it owns, so the server is not left holding the session', async () => {
    const { transport, socket } = await connectedTransport();
    assert.equal(socket.readyState, FakeSocket.OPEN);

    transport.dispose();

    assert.deepEqual(socket.closes, [{ code: 1000, reason: 'transport disposed' }]);
    assert.equal(socket.readyState, FakeSocket.CLOSED);
    assert.equal(transport.state, 'closed');
  });

  it('closes a socket that never finished connecting, and does not strand the caller of connect()', async () => {
    const { transport, socket, connecting } = connectingTransport();

    transport.dispose();

    assert.deepEqual(socket.closes, [{ code: 1000, reason: 'transport disposed' }]);
    assert.equal(transport.state, 'closed');
    // The old behaviour detached the listeners the pending connect was resolved through, so this
    // promise could never settle: the caller awaited a socket that no longer existed.
    assert.match(await settleOutcome(connecting), /disposed before the socket opened/);
  });

  it('leaves no listener attached to the socket it disposed', async () => {
    const { transport, socket } = await connectedTransport();
    assert.deepEqual(socket.listenerTypes(), ['close', 'error', 'message', 'open']);

    transport.dispose();

    assert.deepEqual(socket.listenerTypes(), []);
  });

  it('does not report the teardown as a close event to its own subscribers', async () => {
    const { transport } = await connectedTransport();
    const closes: string[] = [];
    transport.onClose((info) => {
      closes.push(`${info.code}/${info.wasManual}`);
    });

    transport.dispose();

    // Dispose is what an owner calls when the owner itself is going away; re-entering that owner with a
    // close event is how you get a reconnect scheduled for a client that no longer exists.
    assert.deepEqual(closes, []);
  });

  it('ignores a close that arrives from the socket after the teardown', async () => {
    const { transport, socket } = await connectedTransport();
    const closes: unknown[] = [];
    transport.onClose((info) => {
      closes.push(info);
    });

    transport.dispose();
    socket.closed({ code: 1006, reason: 'gone', wasClean: false });

    assert.deepEqual(closes, []);
    assert.equal(transport.state, 'closed');
  });

  it('survives a socket that refuses to close, and is idempotent', async () => {
    const { transport, socket } = await connectedTransport();
    socket.closeError = new Error('already gone');

    assert.doesNotThrow(() => {
      transport.dispose();
    });
    assert.equal(transport.state, 'closed');
    assert.equal(socket.closes.length, 1, 'the close was still attempted once');

    assert.doesNotThrow(() => {
      transport.dispose();
    });
    assert.equal(socket.closes.length, 1, 'a second dispose must not close anything again');
  });

  it('is safe on a transport that never connected', () => {
    const transport = new StandaloneTransport({
      runtime: {
        kind: 'injected',
        factory: FakeFactory,
        supportsHeaders: true,
        description: 'fake socket',
      },
    });

    assert.doesNotThrow(() => {
      transport.dispose();
    });
    assert.equal(transport.state, 'closed');
  });
});
