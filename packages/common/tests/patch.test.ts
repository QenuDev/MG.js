/**
 * JSON Pointer and RFC 6902 patch application.
 *
 * The `/child` tolerance is the interesting part. The protocol doc's prose says game-state patches are
 * `/child`-prefixed while its own `applyPatch` sample never strips one, a direct self-contradiction.
 * The applier roots the tree at the whole `fullState` so `/child/...` resolves literally, and tolerates
 * the other reading rather than picking a winner. Both directions are tested here.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Patch } from '../src/protocol/wire.js';
import { applyPatch, deepClone, deepEqual, JsonPatch } from '../src/state/patch.js';
import {
  addLeadingChild,
  dropLeadingChild,
  escapeToken,
  formatPointer,
  getPointer,
  joinPointer,
  parsePointer,
  pointerContains,
  resolvePointer,
} from '../src/state/pointer.js';

/** The tree shape the server describes: room state at `.data`, game state at `.child.data`. */
function tree(): unknown {
  return {
    data: { players: [{ id: 'p_1', coins: 100 }], chat: [], hostPlayerId: 'p_1' },
    child: { data: { userSlots: [{ data: { activityLogs: [] } }] } },
  };
}

describe('JSON Pointer', () => {
  it('parses the empty pointer as the document root', () => {
    assert.deepEqual(parsePointer(''), []);
  });

  it('parses nested tokens', () => {
    assert.deepEqual(parsePointer('/data/players/0/coins'), ['data', 'players', '0', 'coins']);
  });

  it('unescapes ~1 before ~0, per RFC 6901', () => {
    // The order matters: "~01" must decode to "~1", not to "/".
    assert.deepEqual(parsePointer('/a~1b'), ['a/b']);
    assert.deepEqual(parsePointer('/a~0b'), ['a~b']);
    assert.deepEqual(parsePointer('/a~01b'), ['a~1b']);
  });

  it('escapes in the mirror order', () => {
    assert.equal(escapeToken('a/b'), 'a~1b');
    assert.equal(escapeToken('a~b'), 'a~0b');
    assert.equal(escapeToken('a~1b'), 'a~01b');
  });

  it('round-trips through format', () => {
    assert.equal(formatPointer(['a/b', 'c~d']), '/a~1b/c~0d');
    assert.deepEqual(parsePointer(formatPointer(['a/b', 'c~d'])), ['a/b', 'c~d']);
  });

  it('rejects a pointer that does not start with a slash', () => {
    assert.throws(() => parsePointer('data/players'), /Invalid JSON Pointer/);
  });

  it('resolves a nested value and reports its parent', () => {
    const result = resolvePointer(tree(), '/data/players/0/coins');
    assert.equal(result.found, true);
    if (result.found) {
      assert.equal(result.value, 100);
      assert.equal(result.key, 'coins');
    }
  });

  it('reports not-found rather than throwing', () => {
    assert.deepEqual(resolvePointer(tree(), '/data/nope'), { found: false });
    assert.deepEqual(resolvePointer(tree(), '/data/players/9'), { found: false });
    assert.equal(getPointer(tree(), '/data/nope'), undefined);
  });

  it('joins pointers', () => {
    assert.equal(joinPointer('/data', 'players', '0'), '/data/players/0');
    assert.equal(joinPointer('', 'data'), '/data');
  });

  it('detects containment in one direction only', () => {
    assert.equal(pointerContains('/data/inventory', '/data/inventory/3'), true);
    assert.equal(pointerContains('/data/inventory', '/data/inventory'), true);
    assert.equal(pointerContains('', '/anything'), true);
    assert.equal(pointerContains('/data/inventory', '/data'), false);
    assert.equal(pointerContains('/data/inventory', '/data/inventoryX'), false);
  });

  it('exposes the child-token helpers explicitly', () => {
    assert.equal(dropLeadingChild('/child/data/x'), '/data/x');
    assert.equal(dropLeadingChild('/child'), '');
    assert.equal(dropLeadingChild('/data/x'), null);
    assert.equal(addLeadingChild('/data/x'), '/child/data/x');
    assert.equal(addLeadingChild(''), '/child');
  });
});

describe('applyPatch: RFC 6902 operations', () => {
  it('adds a value at a nested path', () => {
    const doc = tree();
    const patches: Patch[] = [{ op: 'add', path: '/data/players/0/level', value: 5 }];
    const result = applyPatch(doc, patches);
    assert.equal(result.ok, true);
    assert.equal(getPointer(doc, '/data/players/0/level'), 5);
  });

  it('inserts into an array at an index', () => {
    const doc = tree();
    applyPatch(doc, [{ op: 'add', path: '/data/chat/0', value: 'hi' }]);
    assert.deepEqual(getPointer(doc, '/data/chat'), ['hi']);
  });

  it('appends to an array with the "-" token', () => {
    const doc = tree();
    applyPatch(doc, [{ op: 'add', path: '/data/chat/-', value: 'a' }]);
    applyPatch(doc, [{ op: 'add', path: '/data/chat/-', value: 'b' }]);
    assert.deepEqual(getPointer(doc, '/data/chat'), ['a', 'b']);
  });

  it('replaces an existing value', () => {
    const doc = tree();
    const result = applyPatch(doc, [{ op: 'replace', path: '/data/players/0/coins', value: 1250 }]);
    assert.equal(result.ok, true);
    assert.equal(getPointer(doc, '/data/players/0/coins'), 1250);
  });

  it('creates a replace target that does not exist, matching the documented server applier', () => {
    // The documented applier treats anything that is not `remove` as an assign, so `replace` on a path
    // the client has not seen yet lands rather than being dropped. Strict RFC 6902 semantics remain
    // available via `createMissing: false`.
    const created = tree();
    const lenient = applyPatch(created, [{ op: 'replace', path: '/data/players/0/gems', value: 1 }]);
    assert.equal(lenient.ok, true);
    assert.equal(getPointer(created, '/data/players/0/gems'), 1);

    const strictDoc = tree();
    const strict = applyPatch(strictDoc, [{ op: 'replace', path: '/data/players/0/gems', value: 1 }], {
      createMissing: false,
      tolerant: false,
    });
    assert.equal(strict.ok, false);
    assert.equal(strict.failed, 1);
    assert.match(strict.outcomes[0]?.error ?? '', /does not exist/);
  });

  it('removes a value and splices arrays rather than leaving a hole', () => {
    const doc = { data: { chat: ['a', 'b', 'c'] } };
    applyPatch(doc, [{ op: 'remove', path: '/data/chat/1' }]);
    assert.deepEqual(getPointer(doc, '/data/chat'), ['a', 'c']);
  });

  it('moves a value', () => {
    const doc = { data: { from: 1 } };
    applyPatch(doc, [{ op: 'move', from: '/data/from', path: '/data/to' }]);
    assert.equal(getPointer(doc, '/data/to'), 1);
    assert.equal(getPointer(doc, '/data/from'), undefined);
  });

  it('refuses to move a value into its own child', () => {
    const doc = { data: { a: { b: 1 } } };
    const result = applyPatch(doc, [{ op: 'move', from: '/data/a', path: '/data/a/b/c' }]);
    assert.equal(result.ok, false);
    assert.match(result.outcomes[0]?.error ?? '', /own children/);
  });

  it('copies by value, not by reference', () => {
    const doc = { data: { a: { n: 1 } } };
    applyPatch(doc, [{ op: 'copy', from: '/data/a', path: '/data/b' }]);
    (getPointer(doc, '/data/b') as { n: number }).n = 99;
    assert.equal(getPointer(doc, '/data/a/n'), 1);
  });

  it('passes and fails a test operation', () => {
    const doc = tree();
    assert.equal(applyPatch(doc, [{ op: 'test', path: '/data/players/0/coins', value: 100 }]).ok, true);
    assert.equal(applyPatch(doc, [{ op: 'test', path: '/data/players/0/coins', value: 999 }]).ok, false);
  });

  it('reports an unknown op as a failure without throwing', () => {
    const doc = tree();
    const result = applyPatch(doc, [{ op: 'frobnicate', path: '/data' } as unknown as Patch]);
    assert.equal(result.ok, false);
    assert.match(result.outcomes[0]?.error ?? '', /Unsupported patch op/);
  });
});

describe('applyPatch: the /child contradiction', () => {
  it('applies a /child-prefixed path literally against a fullState-rooted tree', () => {
    const doc = tree();
    const result = applyPatch(doc, [
      { op: 'add', path: '/child/data/userSlots/0/data/activityLogs/-', value: { action: 'Bloom' } },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.outcomes[0]?.resolution, 'literal');
    assert.deepEqual(getPointer(doc, '/child/data/userSlots/0/data/activityLogs'), [{ action: 'Bloom' }]);
  });

  it('drops a /child prefix when the tree is rooted at the game state alone', () => {
    // The other reading of the contradictory prose: the client rooted its tree one level lower.
    const doc = { data: { userSlots: [] } };
    const result = applyPatch(doc, [{ op: 'add', path: '/child/data/userSlots', value: [1] }]);
    assert.equal(result.ok, true);
    assert.equal(result.outcomes[0]?.resolution, 'dropped-child');
    assert.deepEqual(getPointer(doc, '/data/userSlots'), [1]);
  });

  it('adds a /child prefix when the tree expects nesting the server omitted', () => {
    const doc = { child: { data: { userSlots: [] } } };
    const result = applyPatch(doc, [{ op: 'add', path: '/data/userSlots', value: [7] }]);
    assert.equal(result.ok, true);
    assert.equal(result.outcomes[0]?.resolution, 'added-child');
    assert.deepEqual(getPointer(doc, '/child/data/userSlots'), [7]);
  });

  it('records tolerated operations so drift is visible instead of silent', () => {
    const doc = { child: { data: {} } };
    const result = applyPatch(doc, [{ op: 'add', path: '/data/x', value: 1 }]);
    assert.equal(result.tolerated.length, 1);
    assert.equal(result.tolerated[0]?.path, '/data/x');
    assert.equal(result.tolerated[0]?.appliedPath, '/child/data/x');
  });

  it('prefers the literal interpretation when both would resolve', () => {
    const doc = { data: { x: 1 }, child: { data: { y: 2 } } };
    const result = applyPatch(doc, [{ op: 'replace', path: '/data/x', value: 5 }]);
    assert.equal(result.outcomes[0]?.resolution, 'literal');
    assert.equal(getPointer(doc, '/data/x'), 5);
  });

  it('needs both switches off for strict RFC 6902 semantics', () => {
    const doc = { child: { data: {} } };
    const tolerant = applyPatch(doc, [{ op: 'add', path: '/data/x', value: 1 }], { tolerant: false });
    assert.equal(tolerant.ok, true, 'creation is still allowed');
    assert.equal(tolerant.outcomes[0]?.resolution, 'created-parent');

    const strictDoc = { child: { data: {} } };
    const strict = applyPatch(strictDoc, [{ op: 'add', path: '/data/x', value: 1 }], {
      tolerant: false,
      createMissing: false,
    });
    assert.equal(strict.ok, false);
    assert.equal(strict.outcomes[0]?.resolution, 'failed');
  });

  it('reports the failure rather than throwing when creation is not allowed', () => {
    const doc = { data: {} };
    const result = applyPatch(doc, [{ op: 'replace', path: '/nope/at/all', value: 1 }], {
      createMissing: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.outcomes[0]?.resolution, 'failed');
    assert.ok(result.outcomes[0]?.error);
  });

  it('creates the path rather than failing when creation IS allowed', () => {
    // The documented server applier creates containers, so a path it does not recognise yet is grown
    // rather than dropped. The `created-parent` resolution is the signal that this happened.
    const doc: Record<string, unknown> = { data: {} };
    const result = applyPatch(doc, [{ op: 'replace', path: '/nope/at/all', value: 1 }]);
    assert.equal(result.ok, true);
    assert.equal(result.outcomes[0]?.resolution, 'created-parent');
    assert.equal(getPointer(doc, '/nope/at/all'), 1);
  });

  it('never fabricates a /child branch to satisfy a path that has a real home', () => {
    // The ordering guarantee: `/child` normalisation is tried BEFORE creation, so a real target is
    // always preferred over an invented one.
    const doc: Record<string, unknown> = { data: { x: 1 } };
    const result = applyPatch(doc, [{ op: 'replace', path: '/child/data/x', value: 2 }]);
    assert.equal(result.ok, true);
    assert.equal(result.outcomes[0]?.resolution, 'dropped-child');
    assert.equal(getPointer(doc, '/data/x'), 2);
    assert.equal(getPointer(doc, '/child'), undefined, 'no phantom /child branch may appear');
  });

  it('does not mutate the caller when the patch list is empty', () => {
    const doc = tree();
    const result = applyPatch(doc, []);
    assert.equal(result.ok, true);
    assert.equal(result.applied, 0);
  });
});

describe('applyPatch: documented create-missing behaviour', () => {
  it('creates a missing object container along the path', () => {
    // The documented `JsonPatch.apply` walks the path "creating an array when the next segment is
    // numeric, an object otherwise". Without this, a patch naming a branch the client has not seen yet
    // is dropped and local state drifts from the server's.
    const doc: Record<string, unknown> = {};
    const result = applyPatch(doc, [{ op: 'add', path: '/data/players/0/coins', value: 5 }]);
    assert.equal(result.ok, true);
    assert.equal(result.outcomes[0]?.resolution, 'created-parent');
    assert.deepEqual(getPointer(doc, '/data/players/0/coins'), 5);
    // `data` and `players` are objects; `0` is an array index, so `players` became an array.
    assert.equal(Array.isArray(getPointer(doc, '/data/players')), true);
  });

  it('extends an array with nulls when the index is past the end', () => {
    const doc: Record<string, unknown> = { data: { chat: ['a'] } };
    const result = applyPatch(doc, [{ op: 'add', path: '/data/chat/3', value: 'd' }]);
    assert.equal(result.ok, true);
    assert.deepEqual(getPointer(doc, '/data/chat'), ['a', null, null, 'd']);
  });

  it('lets a replace land on a path that does not exist yet, as the server applier does', () => {
    // RFC 6902 would fail this; the documented server applier treats anything that is not `remove` as
    // an assign, so `add` and `replace` converge.
    const doc: Record<string, unknown> = {};
    const result = applyPatch(doc, [{ op: 'replace', path: '/data/coins', value: 9 }]);
    assert.equal(result.ok, true);
    assert.equal(getPointer(doc, '/data/coins'), 9);
  });

  it('does not clobber an existing container while creating deeper ones', () => {
    const doc = { data: { players: [{ id: 'p_1', coins: 100 }] } };
    applyPatch(doc, [{ op: 'add', path: '/data/players/0/level', value: 3 }]);
    assert.deepEqual(getPointer(doc, '/data/players/0'), { id: 'p_1', coins: 100, level: 3 });
  });

  it('still fails on a non-numeric segment where an array is expected', () => {
    // Creation cannot rescue this: the parent exists and IS an array, so the segment is simply invalid.
    const doc: Record<string, unknown> = { data: { list: [] } };
    const result = applyPatch(doc, [{ op: 'add', path: '/data/list/abc', value: 1 }]);
    assert.equal(result.ok, false);
    assert.equal(result.outcomes[0]?.resolution, 'failed');
  });

  it('can be disabled for strict RFC 6902 semantics', () => {
    const doc: Record<string, unknown> = {};
    const result = applyPatch(doc, [{ op: 'add', path: '/data/players/0/coins', value: 5 }], {
      createMissing: false,
      tolerant: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.outcomes[0]?.resolution, 'failed');
  });

  it('still prefers the literal path over creating one, when both would work', () => {
    const doc: Record<string, unknown> = { data: { x: 1 } };
    const result = applyPatch(doc, [{ op: 'replace', path: '/data/x', value: 9 }]);
    assert.equal(result.outcomes[0]?.resolution, 'literal');
    assert.equal(getPointer(doc, '/data/x'), 9);
  });

  it('does not remove a container it created when a later op in the same batch fails', () => {
    const doc: Record<string, unknown> = {};
    const result = applyPatch(doc, [
      { op: 'add', path: '/data/a/b', value: 1 },
      { op: 'test', path: '/nonexistent/thing', value: 1 },
    ]);
    assert.equal(result.applied, 1);
    assert.equal(result.failed, 1);
    assert.equal(getPointer(doc, '/data/a/b'), 1);
  });
});

describe('JsonPatch (the documented static helper)', () => {
  it('is not instantiable, matching the reference', () => {
    // The reference calls it "Not instantiable". Every member is static.
    assert.throws(() => new (JsonPatch as unknown as new () => unknown)());
  });

  it('applies a single operation and returns the root', () => {
    const doc: Record<string, unknown> = { data: { players: [{ coins: 100 }] } };
    const returned = JsonPatch.apply(doc, {
      op: 'replace',
      path: '/data/players/0/coins',
      value: 1250,
    });
    assert.equal(returned, doc, 'the same root object is returned, mutated in place');
    assert.equal(getPointer(doc, '/data/players/0/coins'), 1250);
  });

  it('creates containers and extends arrays, per the documented algorithm', () => {
    const doc: Record<string, unknown> = {};
    JsonPatch.apply(doc, { op: 'add', path: '/data/chat/2', value: 'c' });
    assert.deepEqual(getPointer(doc, '/data/chat'), [null, null, 'c']);
  });

  it('removes at the leaf', () => {
    const doc: Record<string, unknown> = { data: { a: 1, b: 2 } };
    JsonPatch.apply(doc, { op: 'remove', path: '/data/a' });
    assert.equal(getPointer(doc, '/data/a'), undefined);
    assert.equal(getPointer(doc, '/data/b'), 2);
  });

  it('normalizes a /child-prefixed path', () => {
    const doc = { child: { data: { userSlots: [] } } };
    JsonPatch.apply(doc, { op: 'add', path: '/child/data/userSlots', value: [1] });
    assert.deepEqual(getPointer(doc, '/child/data/userSlots'), [1]);
  });

  it('applyAll reports which operations landed', () => {
    const doc: Record<string, unknown> = {};
    const { root, result } = JsonPatch.applyAll(doc, [
      { op: 'add', path: '/data/x', value: 1 },
      { op: 'test', path: '/nope', value: 1 },
    ]);
    assert.equal(root, doc);
    assert.equal(result.applied, 1);
    assert.equal(result.failed, 1);
  });
});

describe('deepClone / deepEqual', () => {
  it('clones nested structures without sharing references', () => {
    const original = { a: [{ b: 1 }] };
    const copy = deepClone(original);
    assert.deepEqual(copy, original);
    (copy.a[0] as { b: number }).b = 2;
    assert.equal(original.a[0]?.b, 1);
  });

  it('compares structurally', () => {
    assert.equal(deepEqual({ a: [1, 2] }, { a: [1, 2] }), true);
    assert.equal(deepEqual({ a: [1, 2] }, { a: [2, 1] }), false);
    assert.equal(deepEqual({ a: 1 }, { a: 1, b: undefined as unknown }), false);
    assert.equal(deepEqual(null, null), true);
    assert.equal(deepEqual(null, {}), false);
  });
});

/**
 * A patch path is attacker-controlled: it arrives over the socket, and the game's frame is not the only
 * thing that can write one. Every case here was reachable before the guards, and each one is a silent
 * failure, since the outcome reported a problem while the damage was already done, or the allocation
 * happened before any check could run.
 */
describe('applyPatch: hostile paths', () => {
  it('refuses a path that would pollute Object.prototype through the container walk', () => {
    // `ensureContainer` read the *inherited* `__proto__` slot, found an object, descended into it and then
    // assigned onto it, so the container walk itself was the write primitive, and it ran before the
    // failure was recorded. Reproduced as: applied 0, failed 1, and `Object.prototype.pwned` set.
    const doc: Record<string, unknown> = {};
    const result = applyPatch(doc, [{ op: 'add', path: '/__proto__/pwned/inner', value: 1 }]);

    assert.equal(result.ok, false);
    assert.equal(({} as Record<string, unknown>)['pwned'], undefined, 'Object.prototype must be clean');
    assert.equal(Object.hasOwn(Object.prototype, 'pwned'), false);
  });

  it('refuses a path that would set the document prototype through a leaf write', () => {
    const doc: Record<string, unknown> = {};
    const result = applyPatch(doc, [{ op: 'add', path: '/__proto__', value: { polluted: true } }]);

    assert.equal(result.ok, false);
    assert.equal(Object.getPrototypeOf(doc), Object.prototype, 'the document prototype must be intact');
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  });

  it('refuses constructor and prototype as write keys', () => {
    // One hop out from `__proto__`: `/constructor/prototype/x` reaches the same place.
    const doc: Record<string, unknown> = {};
    const result = applyPatch(doc, [{ op: 'add', path: '/data/constructor/prototype/pwned', value: 1 }]);

    assert.equal(result.ok, false);
    assert.equal(({} as Record<string, unknown>)['pwned'], undefined);
  });

  it('refuses to pad an array by millions of entries', () => {
    // The tolerance is deliberate (see the create-missing block above) but it was unbounded: this used to
    // allocate twenty million slots in a couple of hundred milliseconds, from one frame.
    const doc: Record<string, unknown> = { data: { chat: [] } };
    const result = applyPatch(doc, [{ op: 'add', path: '/data/chat/20000000/x', value: 1 }]);

    assert.equal(result.ok, false);
    assert.equal((doc['data'] as { chat: unknown[] }).chat.length, 0, 'no padding may have happened');
  });

  it('still pads a gap the game could plausibly produce', () => {
    // The bound must not break the documented tolerance it is bounding.
    const doc: Record<string, unknown> = { data: { chat: ['a'] } };
    const result = applyPatch(doc, [{ op: 'add', path: '/data/chat/5', value: 'f' }]);

    assert.equal(result.ok, true);
    assert.deepEqual(getPointer(doc, '/data/chat'), ['a', null, null, null, null, 'f']);
  });
});

describe('deepClone: keys that are not safe to assign', () => {
  it('keeps an own __proto__ key instead of losing it to the prototype setter', () => {
    // `JSON.parse('{"__proto__":1}')` produces a real own property, so this is a shape the wire can carry.
    // Assigning it onto a fresh object ran the inherited setter: the key vanished and the clone's
    // prototype was replaced.
    const source = JSON.parse('{"__proto__":{"marker":1},"a":2}') as Record<string, unknown>;
    const copy = deepClone(source);

    assert.equal(Object.hasOwn(copy, '__proto__'), true, 'the key must survive');
    assert.equal(Object.getPrototypeOf(copy), Object.prototype, 'the prototype must be untouched');
    assert.deepEqual(copy['a'], 2);
  });
});
