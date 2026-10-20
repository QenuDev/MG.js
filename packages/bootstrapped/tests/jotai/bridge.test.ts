/**
 * The jotai bridge's teardown, against the shape the game's own bundle uses.
 *
 * ## Why the game-populated holder must be preserved
 *
 * `install()` synthesises `page.jotaiAtomCache` when the game has not created one yet, on the premise
 * that the game then adopts it. The shipped bundle does exactly that, once per atom module:
 *
 *     globalThis.jotaiAtomCache = globalThis.jotaiAtomCache || {
 *       cache: new Map,
 *       get(e, t) { return this.cache.has(e) ? this.cache.get(e) : (this.cache.set(e, t), t) },
 *     };
 *     globalThis.jotaiAtomCache.get('/home/runner/work/.../client/src/store/jwtAtom.ts/jwtAtom', u(void 0));
 *
 * So the map inside our holder *is* the game's atom registry, the thing that keeps one live atom
 * instance per module path. `release()` therefore has two duties: leave that registry where the game
 * put it, and take our own inspecting `get` out of it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ATOM_CACHE_KEY,
  install,
  type JotaiAtom,
  readAtom,
  resetJotaiCapture,
} from '../../src/jotai/bridge.ts';
import { installRealmOverride } from '../../src/page/override.ts';
import type { PageRealm } from '../../src/page/realm.ts';

/** The holder shape {@link install} synthesises, as the page sees it. */
interface CacheHolder {
  cache: Map<unknown, JotaiAtom>;
  get(key: unknown, initial: JotaiAtom): JotaiAtom;
}

function isCacheHolder(value: unknown): value is CacheHolder {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { cache?: unknown; get?: unknown };
  return candidate.cache instanceof Map && typeof candidate.get === 'function';
}

/** A page with no cache yet, exactly as at document-start. */
function emptyPage(): { page: PageRealm; restore: () => void } {
  const page: PageRealm = {};
  return { page, restore: installRealmOverride({ page }) };
}

/** A game atom as the bundle registers one: an object with a debug label and nothing else we touch. */
function gameAtom(label: string): JotaiAtom {
  return { debugLabel: label };
}

void test('release() leaves a cache the game adopted, and takes our get out of it', () => {
  const { page, restore } = emptyPage();
  // `retryForMs: 0` keeps the 500 ms retry tick out of the assertions; nothing here needs the clock.
  const handle = install({ page, retryForMs: 0 });

  try {
    const holder = page[ATOM_CACHE_KEY];
    assert.ok(isCacheHolder(holder), 'install() must synthesise the cache the game reads');

    // The game's own line, then the game's own lookup: it finds our object, keeps it, and registers a
    // hot-reload-safe atom in it.
    const jwtKey = 'client/src/store/jwtAtom.ts/jwtAtom';
    const jwtAtom = gameAtom(jwtKey);
    assert.equal(holder.get(jwtKey, jwtAtom), jwtAtom);
    assert.equal(holder.cache.get(jwtKey), jwtAtom);

    const inspectedWhileActive = handle.atomCount;

    handle.release();

    // The registry the game populated is not ours to delete: its later modules look their atoms up by
    // key in this very object, and a fresh holder would hand them a second instance of the same atom.
    assert.equal(
      page[ATOM_CACHE_KEY],
      holder,
      'release() deleted a jotaiAtomCache the game had registered its atoms in',
    );
    assert.equal(holder.cache.get(jwtKey), jwtAtom, 'the game atom must survive teardown');

    // No mg.js code may stay in the game's atom path. A `.get` after release is the game's call, not
    // ours to inspect, and the object still has to answer it, or the game's cache is broken.
    const lateKey = 'client/src/store/late.ts/lateAtom';
    const lateAtom = gameAtom(lateKey);
    assert.equal(holder.get(lateKey, lateAtom), lateAtom);
    assert.equal(
      handle.atomCount,
      inspectedWhileActive,
      'the synthetic get is still inspecting atoms after release',
    );
    assert.equal(holder.cache.get(lateKey), lateAtom, 'the holder must stay a working cache');
  } finally {
    restore();
  }
});

void test('release() removes a synthetic cache the game never adopted', () => {
  const { page, restore } = emptyPage();
  const handle = install({ page, retryForMs: 0 });

  try {
    assert.ok(isCacheHolder(page[ATOM_CACHE_KEY]), 'install() must synthesise the cache');
  } finally {
    handle.release();
    restore();
  }

  assert.equal(
    Object.hasOwn(page, ATOM_CACHE_KEY),
    false,
    'a cache nobody registered an atom in must not outlive the bridge',
  );
});

/**
 * The supplied store, and why the bridge must prefer it.
 *
 * Release 1604 puts the game's jotai store at `globalThis.__jotaiStore` before the first render. Patching
 * an atom's `write` still works, but it only finds the store after something in the game writes an atom,
 * and the game's own developers have asked mods not to hook atom reads at all. The supplied store is the
 * supported-in-practice hook, so it has to be adopted even when no write has happened yet.
 */
void test('install() adopts the page __jotaiStore without waiting for an atom write', () => {
  resetJotaiCapture();
  const { page, restore } = emptyPage();
  const values = new Map<unknown, unknown>();
  const store = {
    get: (atom: unknown) => values.get(atom) ?? null,
    set: (atom: unknown, value: unknown) => {
      values.set(atom, value);
    },
  };
  page['__jotaiStore'] = store;
  const playerId = gameAtom('playerIdAtom');
  values.set(playerId, 'p_supplied');

  const handle = install({ page, retryForMs: 0 });
  try {
    assert.notEqual(handle.set, null, 'the supplied store must answer immediately');
    assert.equal(readAtom(playerId), 'p_supplied');
  } finally {
    handle.release();
    restore();
    resetJotaiCapture();
  }
});

void test('the retry adopts a __jotaiStore that appears after install', () => {
  resetJotaiCapture();
  const { page, restore } = emptyPage();
  const values = new Map<unknown, unknown>();
  const playerId = gameAtom('playerIdAtom');
  values.set(playerId, 'p_late');
  let tick: (() => void) | null = null;
  const schedule = (callback: () => void): (() => void) => {
    tick = callback;
    return () => {
      tick = null;
    };
  };

  const handle = install({ page, retryForMs: 10_000, retryIntervalMs: 50, schedule });
  try {
    assert.equal(handle.set, null, 'nothing has been supplied yet');
    page['__jotaiStore'] = {
      get: (atom: unknown) => values.get(atom) ?? null,
      set: (atom: unknown, value: unknown) => {
        values.set(atom, value);
      },
    };
    // The assignment happens inside the injected scheduler, which control-flow analysis cannot see.
    const fire = tick as unknown as (() => void) | null;
    assert.notEqual(fire, null, 'install() must schedule its first retry');
    fire?.();
    assert.notEqual(handle.set, null, 'the retry must adopt the late store');
    assert.equal(readAtom(playerId), 'p_late');
  } finally {
    handle.release();
    restore();
    resetJotaiCapture();
  }
});

void test('release() never deletes a cache the page put there itself', () => {
  const { page, restore } = emptyPage();
  const handle = install({ page, retryForMs: 0 });

  try {
    // Models another mod, or a later game bootstrap, taking the slot while we hold the bridge. The
    // identity check is what keeps our teardown off someone else's object.
    const theirs: CacheHolder = {
      cache: new Map<unknown, JotaiAtom>(),
      get: (_key: unknown, initial: JotaiAtom): JotaiAtom => initial,
    };
    page[ATOM_CACHE_KEY] = theirs;

    handle.release();

    assert.equal(page[ATOM_CACHE_KEY], theirs, 'release() must only ever remove its own holder');
  } finally {
    restore();
  }
});
