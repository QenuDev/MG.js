/**
 * The transport-level frame ceiling.
 *
 * The core refuses an oversized frame in `parseFrame`, but that is already too late for the bytes: the
 * runtime has buffered them and the decoder has copied them. Two defences sit below that, and this file
 * proves both:
 *
 *   - `maxPayload` is handed to the socket constructor, which the `ws` runtime enforces at the protocol
 *     layer, so the frame is never decoded.
 *   - `handleMessage` counts the bytes itself, because a browser or undici `WebSocket` ignores the
 *     unknown third constructor argument, so there the manual check *is* the defence.
 *
 * A fake socket enforces nothing, which makes the second half observable: a 64-byte frame under a
 * 32-byte cap must be dropped and answered with close code 1009 rather than forwarded.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { StandaloneTransport } from '../../src/transport/standalone.js';
import { FakeFactory, FakeSocket } from '../fixtures/fake-socket.js';

/** Build a connected transport with the given cap, over a fresh fake socket. */
async function cappedTransport(maxFrameBytes: number): Promise<{
  transport: StandaloneTransport;
  socket: FakeSocket;
}> {
  FakeSocket.constructed.length = 0;
  const transport = new StandaloneTransport({
    runtime: {
      kind: 'injected',
      factory: FakeFactory,
      supportsHeaders: true,
      description: 'fake socket',
    },
    maxFrameBytes,
  });
  const connecting = transport.connect('wss://example.test/version/1/api/rooms/r/connect');
  const socket = FakeSocket.last;
  assert.ok(socket, 'expected the factory to have been called');
  socket.open();
  await connecting;
  return { transport, socket };
}

describe('StandaloneTransport frame ceiling', () => {
  it('closes the socket instead of forwarding an oversized frame', async () => {
    const { transport, socket } = await cappedTransport(32);
    const received: string[] = [];
    transport.onMessage((raw) => {
      received.push(raw);
    });

    socket.message('x'.repeat(64));

    assert.deepEqual(received, [], 'an oversized frame must never reach the message handlers');
    assert.equal(socket.closes[0]?.code, 1009, '1009 is "message too big"');
    assert.equal(socket.closes[0]?.reason, 'message too big');
    const error = transport.lastError;
    assert.ok(error instanceof Error, 'the drop must be visible on lastError');
    assert.match(error.message, /32-byte cap/);
  });

  it('still forwards a frame under the cap', async () => {
    const { transport, socket } = await cappedTransport(32);
    const received: string[] = [];
    transport.onMessage((raw) => {
      received.push(raw);
    });

    socket.message('{"type":"Pong"}');

    assert.deepEqual(received, ['{"type":"Pong"}']);
    assert.deepEqual(socket.closes, []);
  });

  it('asks the socket runtime for the same ceiling via maxPayload', async () => {
    await cappedTransport(32);

    assert.equal(FakeSocket.constructed[0]?.options?.maxPayload, 32);
  });
});

describe('the default open timeout', () => {
  it('comes from common rather than from a second literal here', () => {
    // Asserted by scanning the source rather than by timing, and the reason is worth stating: the only
    // observable is the error raised once the timeout elapses, so a behavioural test would wait twenty
    // seconds. The scan protects something real: this module declared its own literal under a comment
    // claiming to mirror `DEFAULT_LIFECYCLE_TIMEOUTS.openMs`, while common's copy was read by nothing at
    // all. Two copies of one documented default existed, and the canonical one was the dead one.
    const source = readFileSync(new URL('../../src/transport/standalone.ts', import.meta.url), 'utf8');

    assert.match(source, /options\.openTimeoutMs \?\? DEFAULT_LIFECYCLE_TIMEOUTS\.openMs/);
    assert.match(
      source,
      /import \{[\s\S]*?DEFAULT_LIFECYCLE_TIMEOUTS[\s\S]*?\} from '@mg\.js\/common'/,
      'the shared default must be imported from common, not restated',
    );
    assert.doesNotMatch(source, /=\s*20_000/, 'a second literal for the open timeout is a second home');
  });
});
