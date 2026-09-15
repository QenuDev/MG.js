/**
 * `bindRawSocket`'s teardown: the listeners it adds are taken back.
 *
 * ## The bug these tests exist for
 *
 * Binding to the raw socket replaces `window.WebSocket` and attaches two listeners to every room socket it
 * sees: a `message` listener (the frame/identity scrape) and a `close` listener (which only maintains the
 * `current` pointer). `release()` restored the constructor and cleared the handler sets, but never called
 * `removeEventListener`. So after an uninstall the game's own socket still invoked our `message` listener on
 * every frame: per-frame work and a retained closure holding the whole binding, for the life of the page.
 *
 * DESIGN §6 I2 is that nothing may be taken without being restored, and a listener is taken. The handler
 * *sets* being cleared made this invisible, because no subscriber would fire. The assertion that matters is
 * therefore on the socket's listener registration itself, plus the explicit "a released binding attaches to
 * nothing" case, which is reachable whenever the page (or the game) kept a reference to the replacement
 * constructor.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_FRAME_BYTES } from '@mg.js/common';

import { bindRawSocket, installOutboundRewriter } from '../../src/attach/raw-socket.ts';
import type { PageRealm } from '../../src/page/realm.ts';

/** The room URL shape the filter looks for (`/api/rooms/`), so the binding takes an interest. */
const ROOM_URL = 'wss://magicgarden.gg/version/1166/api/rooms/abc/connect';

/**
 * A socket that counts its own listeners, so a leak is measurable rather than implied.
 *
 * `deliver` returns how many listeners it actually invoked: a released binding must leave that at 0, and
 * that number is the behavioural half of the claim. The count alone could be satisfied by a set that is
 * emptied but still enumerated.
 */
class CountingSocket {
  static readonly OPEN = 1;
  readyState = CountingSocket.OPEN;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(readonly url: string) {}

  /** Every frame the wrapped `send` actually forwarded, so "was the host's frame dropped?" is measurable. */
  readonly sent: unknown[] = [];

  send(data?: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** How many listeners are registered across every event type. */
  get listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  /** Deliver one inbound frame; returns how many listeners were invoked. */
  deliver(data: string): number {
    let invoked = 0;
    for (const listener of [...(this.listeners.get('message') ?? [])]) {
      invoked += 1;
      listener({ data });
    }
    return invoked;
  }
}

/** A page whose `WebSocket` is a constructible fake, ready to be replaced by the binding. */
function pageWithSocket(): Record<string, unknown> {
  return { WebSocket: CountingSocket as unknown as new (url: string) => CountingSocket };
}

describe('bindRawSocket: release takes back what it took', () => {
  it('attaches its listeners to a room socket and removes every one of them on release', () => {
    const page = pageWithSocket();
    const binding = bindRawSocket({ page: page as unknown as PageRealm });

    try {
      const Patched = page['WebSocket'] as new (url: string) => CountingSocket;
      const socket = new Patched(ROOM_URL);
      assert.equal(
        socket.listenerCount,
        2,
        'the binding watches `message` (the scrape) and `close` (the current pointer)',
      );

      binding.release();

      assert.equal(
        socket.listenerCount,
        0,
        'release() must remove both listeners, the two it took, and I2 says it gives them back',
      );
    } finally {
      binding.release();
    }
  });

  it('stops touching frames entirely once released', () => {
    const page = pageWithSocket();
    const binding = bindRawSocket({ page: page as unknown as PageRealm });

    try {
      const Patched = page['WebSocket'] as new (url: string) => CountingSocket;
      const socket = new Patched(ROOM_URL);

      const seen: unknown[] = [];
      binding.sink().onWelcome((event) => seen.push(event));

      // Before release the scrape runs and the welcome reaches the subscriber, so the test cannot pass by
      // the socket never having been observed in the first place.
      assert.equal(socket.deliver('{"selfPlayerId":"p_wire","executedCommandSequence":4}'), 1);
      assert.equal(seen.length, 1);

      binding.release();

      assert.equal(
        socket.deliver('{"selfPlayerId":"p_wire","executedCommandSequence":5}'),
        0,
        'a released binding must not be invoked per frame: that is the leak, and clearing the handler sets does not fix it',
      );
      assert.equal(seen.length, 1, 'no subscriber may be woken after release');
    } finally {
      binding.release();
    }
  });

  it('cannot attach to a socket built through a replacement the page still holds', () => {
    const page = pageWithSocket();
    const binding = bindRawSocket({ page: page as unknown as PageRealm });
    const Patched = page['WebSocket'] as new (url: string) => CountingSocket;

    binding.release();

    // A page (or the game) that captured the constructor before the release can still construct through it.
    const late = new Patched(ROOM_URL);
    assert.equal(
      late.listenerCount,
      0,
      'a released binding must refuse to attach, however the socket was constructed',
    );
  });
});

describe('bindRawSocket: an oversized frame is never parsed by the scrape', () => {
  it('does not JSON.parse an over-cap frame before the core can see it', () => {
    const page = pageWithSocket();
    const binding = bindRawSocket({ page: page as unknown as PageRealm });

    // `JSON.parse` is the observable: it is the exact operation the ceiling exists to keep off a hostile
    // input, and a spy counts it without asserting anything about how the scrape is written inside.
    const realParse = JSON.parse;
    let parses = 0;
    JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
      parses += 1;
      return reviver === undefined ? realParse(text) : realParse(text, reviver);
    }) as typeof JSON.parse;

    try {
      const Patched = page['WebSocket'] as new (url: string) => CountingSocket;
      const socket = new Patched(ROOM_URL);
      const welcomes: unknown[] = [];
      binding.sink().onWelcome((event) => welcomes.push(event));

      // Under the cap: a real `Welcome` shape so the scrape parses it and the subscriber is woken. This is
      // what makes the oversized case below a statement about size rather than about a broken frame.
      const small = '{"selfPlayerId":"p_under_cap","executedCommandSequence":3}';
      assert.equal(socket.deliver(small), 1);
      assert.equal(parses, 1, 'the scrape parsed the small welcome');
      assert.equal(welcomes.length, 1, 'the small welcome reached the subscriber');

      // The same frame padded past `MAX_FRAME_BYTES`, still carrying both markers and still valid JSON: a
      // scrape bounded only by `data.length >= 24` and the substring test would parse it in full.
      const oversized = `{"selfPlayerId":"p_over_cap","executedCommandSequence":4,"pad":"${'x'.repeat(
        MAX_FRAME_BYTES,
      )}"}`;
      assert.ok(
        new TextEncoder().encode(oversized).length > MAX_FRAME_BYTES,
        'the frame must actually exceed the cap, or this test proves nothing',
      );

      socket.deliver(oversized);

      assert.equal(parses, 1, 'an oversized frame must not be JSON.parsed on the raw-socket path');
      assert.equal(welcomes.length, 1, 'the oversized frame must not be scraped into a welcome');
      assert.equal(binding.readSelfPlayerId(), 'p_under_cap', 'the oversized frame must not be read at all');
    } finally {
      JSON.parse = realParse;
      binding.release();
    }
  });
});

describe('bindRawSocket: a fault in the rewriter must not eat the host frame', () => {
  it('forwards the original frame when the coexistence rewriter throws', () => {
    const page = pageWithSocket();
    const binding = bindRawSocket({ page: page as unknown as PageRealm });

    try {
      assert.equal(
        installOutboundRewriter(binding, () => {
          throw new Error('the rewriter exploded');
        }),
        true,
        'the rewriter seam must be reachable, or this test proves nothing at all',
      );

      const Patched = page['WebSocket'] as new (url: string) => CountingSocket;
      const socket = new Patched(ROOM_URL);
      const frame = '{"type":"QuinoaCommand","commandSequence":7}';

      // The room path calls the rewriter inside a try/catch and documents why: "A rewrite failure must
      // never drop the game's frame" (`renumber.ts`, the `renumberingSend` wrapper). This path called the
      // rewriter bare, so a throw escaped into the game's own `send` and the frame never left the browser.
      // That outcome is a *desync*, strictly worse than the duplicate sequence the rewriter exists to
      // prevent (I7).
      assert.doesNotThrow(() => socket.send(frame), "a rewriter fault must not surface in the game's send");
      assert.deepEqual(socket.sent, [frame], 'the host frame must still go out, unrenumbered');
    } finally {
      binding.release();
    }
  });
});

describe('bindRawSocket: a late subscriber still learns the session', () => {
  /**
   * The asymmetry these tests close.
   *
   * The room path and the socket path publish the same event to the same audience, and only one of them
   * remembers it: `room-binding.ts`'s `subscribeToWelcome` replays a stand-in built from the current state,
   * with the reason spelled out in its own comment. `raw-socket.ts`'s `onWelcome` added the handler to a
   * `Set` and stored nothing, so a mod that attached after the `Welcome` had already been scraped waited for
   * a session that had already started. That is the common case, since the game's socket is created when the
   * page loads and a mod may attach later. The binding's own header says as much: *"We have no Welcome
   * subscription, so reconnects are invisible."*
   */

  it('replays the scraped welcome to a handler that subscribes after it arrived', () => {
    const page = pageWithSocket();
    const binding = bindRawSocket({ page: page as unknown as PageRealm });

    try {
      const Patched = page['WebSocket'] as new (url: string) => CountingSocket;
      const socket = new Patched(ROOM_URL);

      // The session starts before anyone is listening, which is the ordering that used to lose the event.
      assert.equal(socket.deliver('{"selfPlayerId":"p_late","executedCommandSequence":9}'), 1);
      assert.equal(binding.sink().readFrontier(), 9, 'the scrape really did see that frame');

      const seen: Array<{ selfPlayerId: string | null; executedCommandSequence: number | null }> = [];
      binding.sink().onWelcome((event) => seen.push(event));

      // Synchronous, matching the room path's replay: a caller that writes `if (ready) ...` immediately after
      // subscribing must not have to await a tick. The synchronous choice is part of the
      // contract, not an implementation detail.
      assert.equal(seen.length, 1, 'a late subscriber must be replayed the welcome, synchronously');
      assert.equal(seen[0]?.selfPlayerId, 'p_late');
      assert.equal(seen[0]?.executedCommandSequence, 9);
    } finally {
      binding.release();
    }
  });

  it('replays nothing when no welcome has been scraped', () => {
    // The negative case, so the replay cannot be "call the handler with something": a binding that never saw
    // a welcome has no session to describe, and inventing one would be the fabricated-event failure the room
    // path's stand-in was careful to avoid.
    const page = pageWithSocket();
    const binding = bindRawSocket({ page: page as unknown as PageRealm });

    try {
      const seen: unknown[] = [];
      binding.sink().onWelcome((event) => seen.push(event));
      assert.deepEqual(seen, []);
    } finally {
      binding.release();
    }
  });

  it('does not double-deliver to a handler that was already subscribed', () => {
    // The regression the fix could introduce: a handler present when the frame arrives gets it from the
    // dispatch loop, and the replay path must not hand it the same event a second time.
    const page = pageWithSocket();
    const binding = bindRawSocket({ page: page as unknown as PageRealm });

    try {
      const Patched = page['WebSocket'] as new (url: string) => CountingSocket;
      const socket = new Patched(ROOM_URL);

      const seen: unknown[] = [];
      binding.sink().onWelcome((event) => seen.push(event));
      assert.equal(socket.deliver('{"selfPlayerId":"p_once","executedCommandSequence":2}'), 1);

      assert.equal(seen.length, 1, 'one welcome, one delivery');
    } finally {
      binding.release();
    }
  });

  it('does not replay a session that the release has already torn down', () => {
    // A released binding has no socket and no session; replaying into it would hand a caller an event for a
    // binding that is gone, which is worse than silence.
    const page = pageWithSocket();
    const binding = bindRawSocket({ page: page as unknown as PageRealm });

    const Patched = page['WebSocket'] as new (url: string) => CountingSocket;
    const socket = new Patched(ROOM_URL);
    assert.equal(socket.deliver('{"selfPlayerId":"p_gone","executedCommandSequence":1}'), 1);

    binding.release();

    const seen: unknown[] = [];
    binding.sink().onWelcome((event) => seen.push(event));
    assert.deepEqual(seen, [], 'a released binding must not replay the session it just threw away');
  });
});
