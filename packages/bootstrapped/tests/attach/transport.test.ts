/**
 * The bootstrapped transport joins the one `Emitter`.
 *
 * `AttachedTransport` kept three parallel `Set`s (`messageHandlers`/`openHandlers`/`closeHandlers`) and
 * dispatched them from five hand-written loops: two in the constructor and in `attachSink`, one in
 * `close()`, two in `syncReadiness()`. Every one of them swallowed, with a comment explaining that a
 * consumer's failure "must never reach the game's dispatch". That *is* `Emitter`'s default
 * `onListenerError`, so this transport overrides nothing: the policy is preserved by inheriting it rather
 * than by restating it five times.
 *
 * The source scan is the regression test: a sixth loop, or a fourth `Set`, is a sixth place for the four
 * copies to disagree again.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it, test } from 'node:test';
import { Emitter } from '@mg.js/common';
import { AttachedTransport } from '../../src/attach/attached-transport.ts';
import { createEmptySink } from '../../src/attach/detect.ts';
import type { AttachedSink } from '../../src/attach/room-connection.ts';

/** The smallest honest sink: it captures the frame handler so a test can deliver a frame. */
function inertSink(): { sink: AttachedSink; deliver: (raw: string) => void } {
  let frameHandler: ((raw: string) => void) | null = null;
  // Derived from the one empty sink rather than restated: this used to be a third hand-written copy of the
  // same nine members, differing only in that it captures the frame handler so a test can deliver a frame.
  const sink: AttachedSink = {
    ...createEmptySink(),
    onFrame: (handler) => {
      frameHandler = handler;
      return () => {
        frameHandler = null;
      };
    },
  };
  return {
    sink,
    deliver: (raw: string) => {
      frameHandler?.(raw);
    },
  };
}

void test('AttachedTransport is an Emitter', () => {
  const { sink } = inertSink();
  assert.ok(new AttachedTransport({ sink, readinessPollMs: 0 }) instanceof Emitter);
});

void test('a throwing message subscriber is swallowed before it can reach the game dispatch', () => {
  const { sink, deliver } = inertSink();
  const transport = new AttachedTransport({ sink, readinessPollMs: 0 });
  const seen: string[] = [];
  transport.onMessage(() => {
    throw new Error('bad subscriber');
  });
  transport.onMessage((raw) => {
    seen.push(raw);
  });

  assert.doesNotThrow(() => deliver('{"type":"Welcome"}'));

  assert.deepEqual(seen, ['{"type":"Welcome"}'], 'one bad subscriber must not stop the others');
});

void test('the transport keeps no handler sets and no dispatch loops of its own', () => {
  const source = readFileSync(new URL('../../src/attach/attached-transport.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Handlers = new Set/, 'the three parallel Sets have one home: Emitter');
  assert.doesNotMatch(source, /for \(const handler of \[\.\.\.this\./);
  assert.match(
    source,
    /class AttachedTransport extends Emitter<AttachedTransportEvents> implements Transport/,
  );
});

void test('a transport holding the empty sink reports connecting, not open', () => {
  // The reason the empty sink exists at all, and the behavioural claim its docstring made without a test
  // behind it: `state` derives from `sink.canSend()`, so a sink that reports itself
  // unavailable yields `'connecting'`, which is honest before the game has created a connection, where
  // a permissive stub would yield the optimistic `'open'` and a caller would send into nothing.
  const transport = new AttachedTransport({ sink: createEmptySink(), endpoint: 'attached:pending' });
  try {
    assert.equal(transport.state, 'connecting');
    assert.equal(transport.isIdle, true);
  } finally {
    transport.close();
  }
});

describe('AttachedTransport observes what goes out', () => {
  /**
   * The gap this closes.
   *
   * The transport is the only seam every outbound frame passes through whichever attachment path won, and it
   * offered no way to observe one: `lastSendResult` is a single-slot post-hoc diagnostic, so a mod that wanted
   * to see outgoing commands had to patch the host socket itself and re-implement the envelope test
   * `coexistence/envelope.ts` already owns, and `client.ts` records both reference mods doing the same
   * thing. This channel is observe-only and sits *after* the rewriter, so it consumes no sequence number and
   * cannot displace `Renumberer` (the ordering constraint `room-binding.ts` documents as the reason its
   * interceptor slot is singular).
   */

  /** A sink that accepts, so a send can succeed and be observed. */
  function acceptingSink(): { sink: AttachedSink; sent: string[] } {
    const sent: string[] = [];
    return {
      sent,
      sink: {
        ...createEmptySink(),
        canSend: () => true,
        sendRaw: (raw: string) => {
          sent.push(raw);
          return true;
        },
      },
    };
  }

  it('notifies an observer of a frame the sink accepted', () => {
    const { sink, sent } = acceptingSink();
    const transport = new AttachedTransport({ sink, readinessPollMs: 0 });
    const observed: string[] = [];

    try {
      const off = transport.onSend((raw) => observed.push(raw));
      transport.send('{"type":"Harvest"}');

      assert.deepEqual(sent, ['{"type":"Harvest"}'], 'the frame must actually reach the sink');
      assert.deepEqual(observed, sent, 'and the observer must see what the sink was given');
      off();
    } finally {
      transport.close();
    }
  });

  it('says nothing about a frame the sink refused', () => {
    // The channel reports what went out, not what was attempted: a refused send is already reported by
    // `lastSendResult.accepted === false`, and counting it as outbound would be the observer lying.
    const { sink } = inertSink();
    const transport = new AttachedTransport({ sink, readinessPollMs: 0 });
    const observed: string[] = [];

    try {
      const off = transport.onSend((raw) => observed.push(raw));
      transport.send('{"type":"Harvest"}');

      assert.equal(transport.lastSendResult?.accepted, false, 'this sink refuses, so the send failed');
      assert.deepEqual(observed, [], 'a frame that did not go out must not be reported as outbound');
      off();
    } finally {
      transport.close();
    }
  });

  it('stops notifying once the subscription is released', () => {
    const { sink } = acceptingSink();
    const transport = new AttachedTransport({ sink, readinessPollMs: 0 });
    const observed: string[] = [];

    try {
      const off = transport.onSend((raw) => observed.push(raw));
      off();
      transport.send('{"type":"Harvest"}');

      assert.deepEqual(observed, [], 'an unsubscribed observer must not be called');
    } finally {
      transport.close();
    }
  });

  it('lets a throwing observer fail without eating the frame', () => {
    // The rule every other subscription on this transport follows, and the one `Emitter` implements: a
    // consumer's failure must never reach the game's dispatch. An observer that throws is a consumer.
    const { sink, sent } = acceptingSink();
    const transport = new AttachedTransport({ sink, readinessPollMs: 0 });
    const after: string[] = [];

    try {
      const offBad = transport.onSend(() => {
        throw new Error('observer blew up');
      });
      const offGood = transport.onSend((raw) => after.push(raw));

      assert.doesNotThrow(() => transport.send('{"type":"Harvest"}'));
      assert.deepEqual(sent, ['{"type":"Harvest"}'], 'the frame still reached the sink');
      assert.deepEqual(after, ['{"type":"Harvest"}'], 'and the next observer still ran');
      offBad();
      offGood();
    } finally {
      transport.close();
    }
  });
});
