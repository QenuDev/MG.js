/**
 * `Emitter`: one listener-failure policy, one teardown name, and no second copy.
 *
 * ## What is asserted here, and why it had to be new
 *
 * `Emitter` already had `on`/`once`/`off`/`emit`/`listenerCount`/`removeAllListeners`, but the four
 * copies of the emitter in this repo did *not* agree on what `emit` does when a listener throws: `common`
 * swallowed silently, `headless` logged, and the standalone transport recorded `lastErrorValue`. The merge
 * gives the shared `Emitter` one overridable hook (`onListenerError`) so every host keeps its own policy
 * instead of reimplementing `emit`, and renames the teardown surface to `clear()` (keeping
 * `removeAllListeners` as a deprecated alias so no caller breaks). Both are additive, so the tests for
 * them are new, and they do not even compile, never mind run, against the pre-merge `Emitter`.
 *
 * ## The retained-`Set` leak
 *
 * `off()` here is `() => this.off(event, listener)`, which deletes the emptied `Set` from the map. The
 * headless copy instead closed over the `Set` and only called `set.delete(...)`, so every event name ever
 * subscribed kept an empty `Set` alive until `removeAllListeners()`. That leak is *not* visible through
 * `listenerCount` (which reads `set.size`, and an empty set has size 0); it is visible as a retained
 * *map key*, which is the thing {@link listenerKeys} reads. The last two tests are the phase gate: they scan
 * every source file under the three packages' `src` directories, so a fifth copy cannot be added without
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Emitter } from '../src/emitter.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The number of event names the emitter still holds a `Set` for. A private field, so read reflectively. */
function listenerKeys(target: object): number {
  const map: unknown = Reflect.get(target, 'listeners');
  if (!(map instanceof Map)) throw new Error('Emitter no longer stores its listeners in a Map');
  return map.size;
}

type ProbeEvents = { ping: [number]; other: [] };

/** An emitter with the hook implemented, the shape a host such as `HeadlessClient` uses. */
class Probe extends Emitter<ProbeEvents> {
  readonly seen: Array<[string, unknown]> = [];

  protected override onListenerError(event: keyof ProbeEvents, error: unknown): void {
    this.seen.push([String(event), error]);
  }
}

void test('a throwing listener is isolated and reported to onListenerError', () => {
  const probe = new Probe();
  const order: string[] = [];
  probe.on('ping', () => {
    order.push('first');
  });
  probe.on('ping', () => {
    throw new Error('bad handler');
  });
  probe.on('ping', (n) => {
    order.push(`third:${n}`);
  });

  probe.emit('ping', 7);

  assert.deepEqual(order, ['first', 'third:7'], 'one bad handler must not stop the others');
  assert.equal(probe.seen.length, 1, 'the failure is reported exactly once');
  assert.equal(probe.seen[0]?.[0], 'ping', 'the overriding host is told which event failed');
  assert.match(String(probe.seen[0]?.[1]), /bad handler/);
});

void test('the default policy swallows, so a host that needs nothing keeps the old behaviour', () => {
  const emitter = new Emitter<{ ping: [] }>();
  let reached = false;
  emitter.on('ping', () => {
    throw new Error('bad handler');
  });
  emitter.on('ping', () => {
    reached = true;
  });

  assert.doesNotThrow(() => emitter.emit('ping'));
  assert.equal(reached, true, 'isolation is the default, not something a host opts into');
});

void test('off deletes an emptied event, and clear drops every listener', () => {
  const emitter = new Emitter<{ a: []; b: [] }>();
  const off = emitter.on('a', () => {});
  assert.equal(emitter.listenerCount('a'), 1);
  off();
  assert.equal(emitter.listenerCount('a'), 0);
  assert.equal(listenerKeys(emitter), 0, 'the emptied Set must not be retained');

  emitter.on('a', () => {});
  emitter.on('b', () => {});
  emitter.clear();
  assert.equal(emitter.listenerCount('a') + emitter.listenerCount('b'), 0);
  assert.equal(listenerKeys(emitter), 0);
});

void test('removeAllListeners still clears, because it is a published name', () => {
  const emitter = new Emitter<{ a: [] }>();
  emitter.on('a', () => {});
  emitter.removeAllListeners();
  assert.equal(emitter.listenerCount('a'), 0);
  assert.equal(listenerKeys(emitter), 0);
});

void test('once delivers one time and then prunes itself', () => {
  const emitter = new Emitter<{ a: [number] }>();
  const seen: number[] = [];
  emitter.once('a', (n) => {
    seen.push(n);
  });
  emitter.emit('a', 1);
  emitter.emit('a', 2);
  assert.deepEqual(seen, [1]);
  assert.equal(emitter.listenerCount('a'), 0);
  assert.equal(listenerKeys(emitter), 0);
});

void test('a detacher taken before clear() cannot resurrect a listener', () => {
  const emitter = new Emitter<{ a: [] }>();
  const off = emitter.on('a', () => {});
  emitter.clear();
  off();
  assert.equal(emitter.listenerCount('a'), 0);
  assert.equal(listenerKeys(emitter), 0);
});

/** Every TypeScript source file in the three packages. */
function sourceFiles(): string[] {
  const out: string[] = [];
  // Hand-rolled with `path.join(dir, entry.name)`: `recursive` needs Node 20.1 and `Dirent.parentPath`
  // needs 20.12, while the root `engines.node` promises `>=20`.
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
  };
  for (const pkg of ['common', 'headless', 'bootstrapped']) {
    walk(join(repoRoot, 'packages', pkg, 'src'));
  }
  return out;
}

void test('no file outside `common/src/emitter.ts` keeps a listener map of its own', () => {
  const declaring = sourceFiles().filter((file) => readFileSync(file, 'utf8').includes('new Map<keyof'));
  assert.deepEqual(
    declaring.map((file) => file.slice(repoRoot.length + 1)),
    ['packages/common/src/emitter.ts'],
    'a second listener map is a second identity for one concept',
  );
});

void test('no package hand-rolls a dispatch loop over its own handler set', () => {
  const offenders = sourceFiles().filter((file) =>
    readFileSync(file, 'utf8').includes('for (const handler of [...this.'),
  );
  assert.deepEqual(
    offenders.map((file) => file.slice(repoRoot.length + 1)),
    [],
  );
});
