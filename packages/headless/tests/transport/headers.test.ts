/**
 * Header capability is a property of the resolved runtime, and an injected factory is not automatically
 * header-capable.
 *
 * The runtime seam is where this can be answered honestly, so the tests live here rather than in the
 * client: `acquireWebSocketRuntime` decides `supportsHeaders`, and the client's `requireHeadersForAuth`
 * guard is only as good as that answer. An injected constructor is the host's promise, so a factory may
 * declare its own posture; when it does not, the one case that can still be detected is the global
 * WHATWG constructor, which is known to discard an `options.headers` bag.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SocketLike, WebSocketFactory } from '../../src/transport/runtime.js';
import { acquireWebSocketRuntime } from '../../src/transport/runtime.js';

/**
 * A constructable factory carrying the optional capability hint, shaped like the real thing.
 *
 * `StandaloneTransport` calls `new runtime.factory(...)` and uses the instance as the socket, so the
 * constructor itself has to look like a WebSocket. A class that did its work behind a separate
 * `build()` method would hand the transport a useless object, and the test would silently be measuring
 * the global constructor instead of the injected one.
 *
 * Written as a function that returns a class rather than `class ... implements WebSocketFactory`,
 * because TypeScript cannot see that a class constructor satisfies an interface's *construct signature*:
 * `implements WebSocketFactory` reports "provides no match for the signature". An object whose call
 * signature and `prototype` line up is checked structurally, which is how the runtime sees it too.
 */
function testFactory(hint: boolean | undefined): WebSocketFactory {
  class TestFactory implements SocketLike {
    static supportsConnectHeaders: boolean | undefined;

    readonly readyState = 0;

    close(): void {}
    send(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
  }
  TestFactory.supportsConnectHeaders = hint;
  return TestFactory as unknown as WebSocketFactory;
}

describe('acquireWebSocketRuntime: header capability of an injected factory', () => {
  it('honours a factory that declares it cannot send headers', async () => {
    const runtime = await acquireWebSocketRuntime({ factory: testFactory(false) });
    assert.equal(runtime.kind, 'injected');
    assert.equal(runtime.supportsHeaders, false);
    assert.match(runtime.description, /declar/i);
  });

  it('honours a factory that declares it can send headers', async () => {
    const runtime = await acquireWebSocketRuntime({ factory: testFactory(true) });
    assert.equal(runtime.kind, 'injected');
    assert.equal(runtime.supportsHeaders, true);
    assert.match(runtime.description, /declar/i);
  });

  it('detects the global WHATWG constructor, which silently discards headers', async () => {
    const runtime = await acquireWebSocketRuntime({ factory: globalThis.WebSocket });
    assert.equal(runtime.kind, 'injected');
    assert.equal(runtime.supportsHeaders, false);
    assert.match(runtime.description, /globalThis\.WebSocket/);
  });

  it('assumes an undeclared third-party factory is header-capable, and says so', async () => {
    const runtime = await acquireWebSocketRuntime({ factory: testFactory(undefined) });
    assert.equal(runtime.supportsHeaders, true);
    assert.match(runtime.description, /cannot be detected/i);
  });
});
