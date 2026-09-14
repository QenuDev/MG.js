/**
 * The observable store.
 *
 * The subscription semantics are the part worth pinning down: a subscriber on `/data/inventory` must
 * wake for a change at `/data/inventory/3` (descendant) and for a wholesale replacement at `/data`
 * (ancestor), and must NOT wake for an unrelated sibling. Getting this wrong produces either a wrapper
 * that misses updates or one that re-renders constantly.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MgConfigError, MgTransportError } from '../src/errors.js';
import { activityLogs, findPlayerIndex, playerCount } from '../src/state/paths.js';
import { getPointer } from '../src/state/pointer.js';
import type { StateChange } from '../src/state/store.js';
import { emptyStateTree, ObservableStore } from '../src/state/store.js';

function seededStore(): ObservableStore {
  const store = new ObservableStore();
  store.replaceRoot({
    data: {
      players: [
        { id: 'p_1', coins: 100 },
        { id: 'p_2', coins: 50 },
      ],
      chat: [],
      hostPlayerId: 'p_1',
    },
    child: { data: { userSlots: [{ data: { activityLogs: [] } }, { data: { activityLogs: [] } }] } },
  });
  return store;
}

describe('ObservableStore: reads', () => {
  it('starts with the documented empty tree shape', () => {
    const store = new ObservableStore();
    assert.deepEqual(store.snapshot(), emptyStateTree());
  });

  it('exposes room and game state at their documented depths', () => {
    const store = seededStore();
    assert.deepEqual(store.get('/data/hostPlayerId'), 'p_1');
    // Game state is one level deeper than room state: the extra nesting the doc warns about.
    assert.deepEqual(store.get('/child/data/userSlots/0/data/activityLogs'), []);
    assert.deepEqual(store.room, store.get('/data'));
    assert.deepEqual(store.game, store.get('/child/data'));
  });

  it('reports has() correctly', () => {
    const store = seededStore();
    assert.equal(store.has('/data/hostPlayerId'), true);
    assert.equal(store.has('/data/nope'), false);
  });

  it('hands out snapshots that cannot mutate the live tree', () => {
    const store = seededStore();
    const snapshot = store.snapshot() as { data: { players: { coins: number }[] } };
    const firstPlayer = snapshot.data.players[0];
    assert.ok(firstPlayer !== undefined, 'the snapshot must carry the seeded player');
    firstPlayer.coins = 999999;
    assert.equal(store.get('/data/players/0/coins'), 100);
  });
});

describe('ObservableStore: patching', () => {
  it('applies patches and bumps the version', () => {
    const store = seededStore();
    const before = store.version;
    const { result } = store.applyPatches([{ op: 'replace', path: '/data/players/0/coins', value: 1250 }]);
    assert.equal(result.ok, true);
    assert.equal(store.get('/data/players/0/coins'), 1250);
    assert.equal(store.version, before + 1);
  });

  it('counts failures in its diagnostics without throwing', () => {
    const store = seededStore();
    // A non-numeric segment where an array is required cannot be created into existence, so this is a
    // genuine failure even with the documented create-missing behaviour switched on.
    store.applyPatches([{ op: 'add', path: '/data/chat/oops', value: 1 }]);
    assert.equal(store.stats.patchFailures, 1);
    assert.equal(store.stats.patchCount, 1);
  });

  it('replaces the whole tree on a snapshot and wakes everyone', () => {
    const store = seededStore();
    let calls = 0;
    store.subscribe('/data/players', () => {
      calls += 1;
    });
    store.replaceRoot({ data: { players: [] }, child: { data: {} } });
    assert.equal(calls, 1);
    assert.equal(store.get('/data/players')?.valueOf !== undefined, true);
  });
});

describe('ObservableStore: subscriptions', () => {
  it('wakes a subscriber for a descendant change', () => {
    const store = seededStore();
    const seen: StateChange[] = [];
    store.subscribe('/data/players', (change) => seen.push(change));
    store.applyPatches([{ op: 'replace', path: '/data/players/0/coins', value: 1 }]);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]?.changedPaths, ['/data/players/0/coins']);
  });

  it('wakes a subscriber for an ancestor change', () => {
    const store = seededStore();
    let calls = 0;
    store.subscribe('/data/players/0/coins', () => {
      calls += 1;
    });
    store.applyPatches([{ op: 'replace', path: '/data/players', value: [] }]);
    assert.equal(calls, 1, 'a wholesale replacement of an ancestor must wake the subscriber');
  });

  it('does not wake a subscriber for an unrelated change', () => {
    const store = seededStore();
    let calls = 0;
    store.subscribe('/data/chat', () => {
      calls += 1;
    });
    store.applyPatches([{ op: 'replace', path: '/data/players/0/coins', value: 1 }]);
    assert.equal(calls, 0);
  });

  it('does not treat a prefix-sharing sibling as a match', () => {
    const store = new ObservableStore({ initial: { data: { inventory: [], inventoryX: [] } } });
    let calls = 0;
    store.subscribe('/data/inventory', () => {
      calls += 1;
    });
    store.applyPatches([{ op: 'add', path: '/data/inventoryX/-', value: 1 }]);
    assert.equal(calls, 0);
  });

  it('delivers the current value at the watched path', () => {
    const store = seededStore();
    let value: unknown;
    store.subscribe('/data/players/0/coins', (change) => {
      value = change.value;
    });
    store.applyPatches([{ op: 'replace', path: '/data/players/0/coins', value: 777 }]);
    assert.equal(value, 777);
  });

  it('fires immediately on subscribe when asked', () => {
    const store = seededStore();
    let value: unknown;
    store.subscribe(
      '/data/hostPlayerId',
      (change) => {
        value = change.value;
      },
      { fireImmediately: true },
    );
    assert.equal(value, 'p_1');
  });

  it('does not fire immediately for a path that does not resolve yet', () => {
    const store = new ObservableStore();
    let calls = 0;
    store.subscribe(
      '/data/players',
      () => {
        calls += 1;
      },
      { fireImmediately: true },
    );
    assert.equal(calls, 0);
  });

  it('stops delivering after unsubscribe', () => {
    const store = seededStore();
    let calls = 0;
    const off = store.subscribe('/data/players', () => {
      calls += 1;
    });
    store.applyPatches([{ op: 'add', path: '/data/players/-', value: { id: 'p_3' } }]);
    off();
    store.applyPatches([{ op: 'add', path: '/data/players/-', value: { id: 'p_4' } }]);
    assert.equal(calls, 1);
  });

  it('keeps working when a subscriber throws', () => {
    const store = seededStore();
    let secondCalled = false;
    store.subscribe('/data/players', () => {
      throw new Error('boom');
    });
    store.subscribe('/data/players', () => {
      secondCalled = true;
    });
    assert.doesNotThrow(() =>
      store.applyPatches([{ op: 'add', path: '/data/players/-', value: { id: 'p_3' } }]),
    );
    assert.equal(secondCalled, true, 'one throwing subscriber must not block the others');
  });

  it('wakes a root subscriber for any change', () => {
    const store = seededStore();
    let calls = 0;
    store.subscribeAll(() => {
      calls += 1;
    });
    store.applyPatches([{ op: 'replace', path: '/data/players/0/coins', value: 1 }]);
    assert.equal(calls, 1);
  });

  it('does not notify when a patch batch is empty', () => {
    const store = seededStore();
    let calls = 0;
    store.subscribeAll(() => {
      calls += 1;
    });
    store.applyPatches([]);
    assert.equal(calls, 0);
  });

  it('does not notify for a patch that failed to apply', () => {
    const store = seededStore();
    let calls = 0;
    store.subscribeAll(() => {
      calls += 1;
    });
    store.applyPatches([{ op: 'add', path: '/data/chat/oops', value: 1 }]);
    assert.equal(calls, 0);
  });
});

describe('ObservableStore: waitFor', () => {
  it('resolves immediately when the predicate already holds', async () => {
    const store = seededStore();
    const value = await store.waitFor<number>('/data/players/0/coins', (v) => v === 100);
    assert.equal(value, 100);
  });

  it('resolves when a later patch satisfies it', async () => {
    const store = seededStore();
    const pending = store.waitFor<number>('/data/players/0/coins', (v) => v === 500);
    store.applyPatches([{ op: 'replace', path: '/data/players/0/coins', value: 500 }]);
    assert.equal(await pending, 500);
  });

  it('rejects on timeout with a retryable transport error, not a bare Error', async () => {
    const store = seededStore();
    await assert.rejects(
      store.waitFor('/data/players/0/coins', (v) => v === 999, { timeoutMs: 10 }),
      (error: unknown) => {
        if (!(error instanceof MgTransportError)) {
          assert.fail(`expected MgTransportError, got ${String(error)}`);
        }
        assert.equal(error.kind, 'state');
        assert.equal(error.code, 'wait_timeout');
        assert.equal(error.disposition, 'retry');
        assert.match(error.message, /Timed out waiting/);
        return true;
      },
    );
  });

  it('rejects an aborted wait with a config error, so it is not read as a transport fault', async () => {
    const store = seededStore();
    const controller = new AbortController();
    const pending = store.waitFor('/data/players/0/coins', (v) => v === 999, {
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(pending, (error: unknown) => {
      if (!(error instanceof MgConfigError)) {
        assert.fail(`expected MgConfigError, got ${String(error)}`);
      }
      assert.equal(error.code, 'wait_aborted');
      assert.equal(error.disposition, 'fatal');
      assert.equal(store.stats.subscribers, 0, 'an aborted wait must release its subscription');
      return true;
    });
  });

  it('removes its subscription after resolving, so it does not leak', async () => {
    const store = seededStore();
    const pending = store.waitFor<number>('/data/players/0/coins', (v) => v === 500);
    store.applyPatches([{ op: 'replace', path: '/data/players/0/coins', value: 500 }]);
    await pending;
    assert.equal(store.stats.subscribers, 0);
  });

  it('releases its subscription when the predicate throws', async () => {
    const store = seededStore();
    let counted = 0;
    const off = store.subscribe('/data/players/0/coins', () => {
      counted += 1;
    });
    // The first read must not throw, or there is no returned promise to inspect: the predicate throws
    // only on the delivery the patch triggers.
    let calls = 0;
    const pending = store.waitFor('/data/players/0/coins', () => {
      calls += 1;
      if (calls > 1) throw new Error('bad predicate');
      return false;
    });
    store.applyPatches([{ op: 'replace', path: '/data/players/0/coins', value: 500 }]);
    assert.equal(
      store.stats.subscribers,
      1,
      'a throwing predicate must release the wait subscription, leaving only the counter',
    );
    assert.equal(counted, 1, 'the counter subscriber must still be told about the patch');
    await assert.rejects(pending, /bad predicate/);
    off();
  });

  it('releases its deadline timer when the predicate throws', async () => {
    const store = seededStore();
    const deadlineMs = 1_000;
    let armedCount = 0;
    const armed = new Set<unknown>();
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = new Proxy(realSetTimeout, {
      apply(target, thisArg, args: [() => void, number?]) {
        const handle: unknown = Reflect.apply(target, thisArg, args);
        if (args[1] === deadlineMs) {
          armedCount += 1;
          armed.add(handle);
        }
        return handle;
      },
    });
    globalThis.clearTimeout = new Proxy(realClearTimeout, {
      apply(target, thisArg, args: [unknown]) {
        armed.delete(args[0]);
        return Reflect.apply(target, thisArg, args);
      },
    });
    try {
      let calls = 0;
      const pending = store.waitFor(
        '/data/players/0/coins',
        () => {
          calls += 1;
          if (calls > 1) throw new Error('bad predicate');
          return false;
        },
        { timeoutMs: deadlineMs },
      );
      store.applyPatches([{ op: 'replace', path: '/data/players/0/coins', value: 500 }]);
      assert.equal(armedCount, 1, 'the wait must have armed exactly one deadline timer');
      assert.equal(armed.size, 0, 'the deadline timer must be cleared when the predicate throws');
      await assert.rejects(pending, /bad predicate/);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  it('rejects rather than throwing when the predicate throws on the first read', async () => {
    const store = seededStore();
    await assert.rejects(
      store.waitFor('/nope', () => {
        throw new Error('bad predicate');
      }),
      /bad predicate/,
    );
  });
});

describe('typed path helpers', () => {
  it('build the documented pointers', () => {
    assert.equal(activityLogs(2), '/child/data/userSlots/2/data/activityLogs');
  });

  it('count players defensively on an empty tree', () => {
    assert.equal(playerCount({}), 0);
    assert.equal(playerCount(null), 0);
    assert.equal(playerCount(seededStore().snapshot()), 2);
  });

  it('finds a player index by id', () => {
    const snapshot = seededStore().snapshot();
    assert.equal(findPlayerIndex(snapshot, 'p_2'), 1);
    assert.equal(findPlayerIndex(snapshot, 'p_9'), -1);
    assert.equal(findPlayerIndex(null, 'p_1'), -1);
  });

  it('resolves activity log entries through the store', () => {
    const store = seededStore();
    store.applyPatches([
      { op: 'add', path: `${activityLogs(0)}/-`, value: { action: 'Bloom', parameters: { pet: 'p_1' } } },
    ]);
    assert.deepEqual(getPointer(store.root, activityLogs(0)), [
      { action: 'Bloom', parameters: { pet: 'p_1' } },
    ]);
  });
});
