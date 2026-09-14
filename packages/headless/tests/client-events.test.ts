/**
 * The headless hosts of `Emitter`: one base class, two policies, and no third listener map.
 *
 * ## The defect this file pins
 *
 * `HeadlessClient` kept its own `Map<keyof HeadlessClientEvents, Set<...>>` and its own `on`/`once`/`emit`.
 * Its detacher was `() => { set?.delete(listener) }`, which closes over the `Set` instead of addressing the
 * registry, so unsubscribing pruned nothing: every event name ever subscribed kept an empty `Set` alive
 * until `destroy()`. That is a slow leak (I2) with no failing test, because `listenerCount`, the obvious
 * diagnostic, reads `set.size`, and an empty set has size 0. The leak is the retained *map key*, which
 * {@link listenerKeys} reads reflectively.
 *
 * Two things follow, and both are asserted below: `HeadlessClient` must be an `Emitter` (so the one
 * pruning `off` is what it uses), and its own map, `on`, `once` and `emit` must be gone from the source.
 *
 * ## What must *not* change
 *
 * The client's failure policy is *log it*, and the standalone transport's is *record it in `lastError`*.
 * Both are preserved by overriding the shared hook rather than by reimplementing `emit`, so both are
 * asserted here as regression guards on the merge.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Emitter, MemoryLogSink } from '@mg.js/common';
import { HeadlessClient } from '../src/client.js';
import { connectedTransport } from './fixtures/fake-socket.js';

/** The number of event names the emitter still holds a `Set` for: a private field, so read reflectively. */
function listenerKeys(target: object): number {
  const map: unknown = Reflect.get(target, 'listeners');
  if (!(map instanceof Map)) throw new Error('the emitter no longer stores its listeners in a Map');
  return map.size;
}

void test('HeadlessClient is an Emitter, and keeps its own failure policy', () => {
  assert.ok(new HeadlessClient({ version: '9999' }) instanceof Emitter, 'extends, does not re-implement');
});

void test('headless src declares no listener map of its own', () => {
  const source = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /new Map<keyof HeadlessClientEvents/, 'the map has one home: Emitter');
  assert.match(source, /class HeadlessClient extends Emitter<HeadlessClientEvents>/);
});

void test('detaching prunes the emptied event, so destroy() cannot retain a Set', () => {
  const client = new HeadlessClient({ version: '9999' });
  const off = client.on('open', () => {});
  assert.equal(listenerKeys(client), 1, 'one event name, one Set');

  off();

  assert.equal(
    listenerKeys(client),
    0,
    'a detacher that only deleted from a captured Set leaves the empty Set behind',
  );
  assert.equal(client.listenerCount('open'), 0);
});

void test('a reused detacher cannot resurrect a listener after destroy', async () => {
  const client = new HeadlessClient({ version: '9999' });
  const listener = (): void => {};
  const stale = client.on('open', listener);
  await client.stop();

  client.on('open', listener);
  stale();

  assert.equal(listenerKeys(client), 0, 'the stale detacher must address the live registry, not an orphan');
});

void test('a throwing listener is logged, not rethrown, and does not stop the others', () => {
  const sink = new MemoryLogSink();
  const client = new HeadlessClient({ version: '9999', logLevel: 'debug', logSink: sink });
  const order: string[] = [];
  client.on('open', () => {
    order.push('first');
  });
  client.on('open', () => {
    throw new Error('bad handler');
  });
  client.on('open', () => {
    order.push('third');
  });

  assert.doesNotThrow(() => client.emit('open'));

  assert.deepEqual(order, ['first', 'third'], 'one bad handler must not stop the others');
  assert.ok(
    sink.snapshot().some((record) => record.message.includes('listener for "open" threw')),
    'the headless policy is to log the failure',
  );
});

void test('the standalone transport keeps no handler sets of its own', () => {
  const source = readFileSync(new URL('../src/transport/standalone.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Handlers = new Set/, 'the three parallel Sets have one home: Emitter');
  assert.doesNotMatch(source, /for \(const handler of \[\.\.\.this\./);
  assert.match(
    source,
    /class StandaloneTransport extends Emitter<TransportEvents> implements ObservableTransport/,
  );
});

void test('the transport records a throwing subscriber in lastError and still reaches the rest', async () => {
  const { transport, socket } = await connectedTransport();
  const seen: string[] = [];
  transport.onMessage(() => {
    throw new Error('bad subscriber');
  });
  transport.onMessage((raw) => {
    seen.push(raw);
  });

  socket.message('{"type":"Welcome"}');

  assert.deepEqual(seen, ['{"type":"Welcome"}'], 'isolation, exactly as the hand-rolled loop had it');
  const error: unknown = transport.lastError;
  assert.ok(
    error instanceof Error && error.message === 'bad subscriber',
    'the transport policy is to record the failure, not to log it',
  );
});
