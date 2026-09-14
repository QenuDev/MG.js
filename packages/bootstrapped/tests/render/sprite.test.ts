/**
 * The texture cache's bound: it must **destroy** what it drops.
 *
 * ## The defect these tests exist for
 *
 * `createTextureCache` returned an unbounded `Map` whose `set` overwrote whatever was there
 * (`sprite.ts:79-81`). Nothing was ever evicted and nothing was ever destroyed, so two leaks shared one
 * root cause:
 *
 *   - **distinct keys are unbounded**, and the documented idiom passes the base64 payload itself as the
 *     key (`sprite.ts:24-26`), so every entry also retains an image-sized string;
 *   - the `refresh: true` path re-`set`s a brand-new texture over the old one (`sprite.ts:170`), leaking
 *     one GPU texture per call: the replaced entry is dropped with no `destroy()`.
 *
 * DESIGN §6 I5 names this verbatim. The acceptance is therefore not "the map got smaller" but "the
 * evicted texture was destroyed": a test that only checked `size()` or map membership would pass against
 * an implementation that dropped the reference and leaked the GPU resource, which is the bug.
 *
 * ## The judgement call these tests also pin
 *
 * Destroy-on-evict can destroy a texture a live sprite still references, and this cache cannot know
 * (Pixi sprites hold the texture directly; `useCount` counts cache hits, not live references). The plan
 * accepts that risk behind a generous default bound. The other half of the same coin is that a `set`
 * which re-hands out the *same* texture object, that is, `textureFrom`'s reuse path, which bumps `useCount`,
 * must **not** destroy it. That guard is asserted directly, and via `textureFrom`, because the over-eager
 * version of a destroy-on-replace fix kills a texture still on screen.
 *
 * ## The fixture
 *
 * There is no Pixi in Node, so the constructor set is derived from a structural fake stage exactly as
 * `world.test.ts` and `ctors.test.ts` do: `textureFrom` reaches Pixi through `PixiStage.tryGetCtors()`,
 * which duck-types the recorded root. The fake `Texture` tracks every instance and records the argument
 * of every `destroy` call, so "destroyed" is distinguishable from "dropped".
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PixiDisplayObject, PixiTexture } from '../../src/render/ctors.ts';
import { resetCtorCache, setStageRoot, tryGetCtors } from '../../src/render/ctors.ts';
import {
  type CachedTexture,
  createTextureCache,
  DEFAULT_TEXTURE_CACHE_ENTRIES,
  textureFrom,
} from '../../src/render/sprite.ts';

// --------------------------------------------------------------------------------------
// Fake Pixi nodes
// --------------------------------------------------------------------------------------

/** A real class carrying a chosen constructor name, the property `deriveCtors` reads. */
class FakeNode {
  [key: string]: unknown;
}

/** Write the constructor name a minified Pixi build still exposes. */
function nameClass(Ctor: unknown, name: string): void {
  Object.defineProperty(Ctor, 'name', { value: name });
}

/**
 * A texture with real object identity and a readable `destroy` spy.
 *
 * `destroyCalls` is the fixture's reason for existing: an implementation that merely forgets the entry
 * records `[]` here, and one that destroys it records `[true]`.
 */
class FakeTexture implements PixiTexture {
  [key: string]: unknown;

  /** Every instance, in construction order, so a test can name the texture built for a key. */
  static readonly instances: FakeTexture[] = [];

  /** The argument of every `destroy` call. Empty means it was never destroyed. */
  readonly destroyCalls: (boolean | undefined)[] = [];

  width = 16;
  height = 16;

  constructor(readonly source: unknown) {
    FakeTexture.instances.push(this);
  }

  destroy(destroySource?: boolean): void {
    this.destroyCalls.push(destroySource);
  }

  static from(source: unknown): FakeTexture {
    return new FakeTexture(source);
  }

  /** Drop the construction log, so a test only sees textures it caused. */
  static forget(): void {
    FakeTexture.instances.length = 0;
  }
}

class FakeContainer extends FakeNode {
  children: PixiDisplayObject[] = [];

  addChild(...children: PixiDisplayObject[]): void {
    for (const child of children) {
      this.children.push(child);
      child.parent = this as unknown as PixiDisplayObject;
    }
  }
}
nameClass(FakeContainer, 'Container');

/** A Sprite: the `.texture`/`.anchor` pair is `isSpriteLike`'s discriminant. */
class FakeSprite extends FakeNode {
  texture = new FakeTexture(undefined);
  anchor = { x: 0.5, y: 0.5 };
}
nameClass(FakeSprite, 'Sprite');

/** A genuine Text: `renderPipeId: 'text'` is the documented discriminant. */
class FakeText extends FakeNode {
  text = 'hello';
  style: Record<string, unknown> = { fontFamily: 'Arial', fontSize: 14 };
  renderPipeId = 'text';
}
nameClass(FakeText, 'Text');

/**
 * Point the recovery module at a fake stage and prove it yielded a usable constructor set.
 *
 * The `ctors.Texture === FakeTexture` assertion is what keeps every `textureFrom` test below honest: a
 * recovery that fell back to the throwing stub would otherwise surface as an unrelated throw.
 */
function installStage(): void {
  const stage = new FakeContainer();
  stage.addChild(new FakeSprite(), new FakeText());

  resetCtorCache();
  setStageRoot(stage);

  const ctors = tryGetCtors();
  assert.ok(ctors !== null, 'the fixture stage must yield a recovered constructor set');
  assert.equal(ctors.Texture, FakeTexture, 'the fixture must recover the fake texture constructor');
  assert.equal(ctors.Sprite, FakeSprite, 'the fixture must recover the fake sprite constructor');

  FakeTexture.forget();
}

// --------------------------------------------------------------------------------------
// Cache entries
// --------------------------------------------------------------------------------------

/** A cache entry plus the fake texture behind it, so a test can read the destroy spy. */
interface FakeEntry {
  readonly entry: CachedTexture;
  readonly texture: FakeTexture;
}

function cacheEntry(): FakeEntry {
  const texture = new FakeTexture(undefined);
  return { entry: { texture, width: 16, height: 16, useCount: 1 }, texture };
}

// --------------------------------------------------------------------------------------
// The bound
// --------------------------------------------------------------------------------------

describe('createTextureCache: a declared bound', () => {
  it('declares the documented default bound', () => {
    assert.equal(
      createTextureCache().maxEntries,
      DEFAULT_TEXTURE_CACHE_ENTRIES,
      'the exported constant is the default, so the option is not inert',
    );
    assert.equal(DEFAULT_TEXTURE_CACHE_ENTRIES, 256, 'the documented default is 256 entries');
  });

  it('destroys the texture it evicts once the default bound is exceeded', () => {
    const cache = createTextureCache();
    const entries = Array.from({ length: DEFAULT_TEXTURE_CACHE_ENTRIES }, () => cacheEntry());
    for (const [index, item] of entries.entries()) cache.set(`key-${index}`, item.entry);

    const first = entries[0];
    const newest = entries[DEFAULT_TEXTURE_CACHE_ENTRIES - 1];
    assert.ok(first !== undefined, 'the loop above built a first entry');
    assert.ok(newest !== undefined, 'the loop above built a last entry');
    assert.equal(
      cache.keys().length,
      DEFAULT_TEXTURE_CACHE_ENTRIES,
      'the cache holds exactly its declared bound',
    );
    assert.deepEqual(
      first.texture.destroyCalls,
      [],
      'nothing is destroyed while the cache is within its bound',
    );

    cache.set('key-overflow', cacheEntry().entry);

    // The honest red: pre-fix this is `[]`, because nothing was evicted and nothing was destroyed.
    assert.deepEqual(
      first.texture.destroyCalls,
      [true],
      'the evicted texture must be destroyed, not merely dropped, because dropping the reference leaks it',
    );
    assert.deepEqual(newest.texture.destroyCalls, [], 'a texture still in the cache is not destroyed');
    assert.equal(
      cache.keys().length,
      DEFAULT_TEXTURE_CACHE_ENTRIES,
      'the bound still holds after the overflow insert',
    );
    assert.equal(cache.get('key-0'), undefined, 'the oldest key was evicted');
    assert.notEqual(cache.get('key-overflow'), undefined, 'the entry just stored is the one retained');
  });

  it('destroys the texture it evicts when a smaller bound is declared', () => {
    const cache = createTextureCache({ maxEntries: 2 });
    assert.equal(cache.maxEntries, 2, 'the declared bound is exposed on the cache');

    const a = cacheEntry();
    const b = cacheEntry();
    const c = cacheEntry();
    cache.set('a', a.entry);
    cache.set('b', b.entry);
    cache.set('c', c.entry);

    assert.equal(cache.size(), 2, 'size() reports the bound, not the number of keys ever inserted');
    assert.equal(cache.get('a'), undefined, 'the oldest entry is gone');
    assert.deepEqual(a.texture.destroyCalls, [true], 'and its texture was destroyed');
    assert.deepEqual(b.texture.destroyCalls, [], 'b is still live');
    assert.deepEqual(c.texture.destroyCalls, [], 'the entry just stored is live');
  });

  it('evicts the oldest insertion, and re-setting a live key does not refresh that order', () => {
    // The phase plan's case 4 expects `b` to be evicted after `a` is re-read. That cannot hold against
    // the plan's own `set`: `Map.set` on a live key keeps the original insertion position, so `a` is
    // still the oldest entry. This pins the contract the implementation actually declares: eviction is
    // oldest-inserted-first, not least-recently-written and not least-used.
    const cache = createTextureCache({ maxEntries: 2 });
    const a = cacheEntry();
    const b = cacheEntry();
    const c = cacheEntry();
    cache.set('a', a.entry);
    cache.set('b', b.entry);
    cache.set('a', { ...a.entry, useCount: a.entry.useCount + 1 });

    assert.equal(cache.get('a')?.useCount, 2, 'the re-set entry is the live one');

    cache.set('c', c.entry);

    assert.equal(cache.get('a'), undefined, 'a was inserted first, so a is the entry evicted');
    assert.equal(cache.get('b')?.useCount, 1, 'b survives: order is insertion, not use count');
    assert.deepEqual(a.texture.destroyCalls, [true], 'the evicted texture is destroyed');
    assert.deepEqual(b.texture.destroyCalls, [], 'the surviving texture is untouched');
  });

  it('destroys a replaced entry only when it holds a different texture', () => {
    const cache = createTextureCache({ maxEntries: 4 });
    const original = cacheEntry();
    cache.set('a', original.entry);

    cache.set('a', { ...original.entry, useCount: 2 });
    assert.deepEqual(
      original.texture.destroyCalls,
      [],
      're-setting the same texture object is an update, not a replacement',
    );
    assert.equal(cache.size(), 1, 'and it did not create a second entry');

    const replacement = cacheEntry();
    cache.set('a', replacement.entry);
    assert.deepEqual(original.texture.destroyCalls, [true], 'a different texture orphans the old one');
    assert.deepEqual(replacement.texture.destroyCalls, [], 'the texture now stored is live');
  });

  it('still destroys on an explicit release, which is the path that was refactored', () => {
    const cache = createTextureCache({ maxEntries: 4 });
    const released = cacheEntry();
    const kept = cacheEntry();
    cache.set('gone', released.entry);
    cache.set('kept', kept.entry);

    assert.equal(cache.release('gone', true), true, 'the entry was there to release');
    assert.equal(cache.release('gone', true), false, 'a second release reports there was nothing to do');
    assert.deepEqual(released.texture.destroyCalls, [true], 'release(true) destroys the texture it drops');
    assert.deepEqual(kept.texture.destroyCalls, [], 'and destroys nothing else');
    assert.equal(cache.size(), 1, 'the released key is gone');
  });
});

// --------------------------------------------------------------------------------------
// The bound's own validation
// --------------------------------------------------------------------------------------

describe('createTextureCache: the bound is validated', () => {
  /**
   * Every value that cannot bound a `Map<string, CachedTexture>`, with the pre-fix behaviour measured:
   *
   *   - `NaN`: `size > NaN` is false, so nothing is ever evicted; measured 1000 entries retained against
   *     a declared bound of `NaN`, so it is the unbounded cache the bound exists to prevent;
   *   - `Infinity`: the same defect with an honest-looking number; measured 1000 entries retained;
   *   - `0` / negative: `size > 0` is true for the entry just stored, so every `set` destroys the texture
   *     it was just handed, and `size` stays at 0: a cache that cannot cache;
   *   - a fraction: silently truncated by the comparison, so `2.5` acts as `2` while `maxEntries` reports
   *     `2.5`.
   */
  const unusable: { readonly label: string; readonly value: number }[] = [
    { label: 'a NaN bound, which compares false against every size', value: Number.NaN },
    { label: 'an infinite bound', value: Number.POSITIVE_INFINITY },
    { label: 'a negatively infinite bound', value: Number.NEGATIVE_INFINITY },
    { label: 'a zero bound, which would evict the entry it just stored', value: 0 },
    { label: 'a negative bound, which would evict the entry it just stored', value: -1 },
    { label: 'a fractional bound, rather than truncating it', value: 2.5 },
  ];

  for (const { label, value } of unusable) {
    it(`refuses ${label}`, () => {
      assert.throws(
        () => createTextureCache({ maxEntries: value }),
        (error: unknown): boolean => {
          assert.ok(error instanceof RangeError, `expected a RangeError, got ${String(error)}`);
          assert.match(error.message, /maxEntries/, 'the error must name the option');
          assert.ok(
            error.message.includes(String(value)),
            `the error must name the rejected value; message was "${error.message}"`,
          );
          return true;
        },
      );
    });
  }

  it('accepts the smallest usable bound', () => {
    const cache = createTextureCache({ maxEntries: 1 });
    const only = cacheEntry();
    cache.set('a', only.entry);

    assert.equal(cache.maxEntries, 1, 'the declared bound is exposed');
    assert.equal(cache.size(), 1, 'a bound of 1 is usable: `size > 1` is still false for one entry');
    assert.deepEqual(only.texture.destroyCalls, [], 'the entry just stored is not destroyed');
  });
});

// --------------------------------------------------------------------------------------
// One texture object under two keys
// --------------------------------------------------------------------------------------

/**
 * The second destroy hazard, and the guard that closes the detectable half of it.
 *
 * `Texture.from(source)` dedupes, so two keys of one cache can hold the *same* texture object. Dropping
 * one entry then destroys an object that the other, still-live entry keeps handing out, so a caller that
 * reads through the surviving key gets a destroyed texture. The guard is "destroy only when no entry of this
 * cache still holds the object", which is checkable inside one cache; a live *sprite* (hazard 1) is not,
 * and stays documented rather than guarded.
 */
describe('createTextureCache: one texture object under two keys', () => {
  it('does not destroy on eviction a texture another live entry still hands out', () => {
    const cache = createTextureCache({ maxEntries: 2 });
    const shared = cacheEntry();
    cache.set('a', shared.entry);
    cache.set('b', shared.entry);

    // Exceed the bound: `a` is the oldest entry and is evicted.
    cache.set('c', cacheEntry().entry);

    assert.equal(cache.get('a'), undefined, 'the oldest key was evicted');
    assert.ok(cache.get('b') !== undefined, 'the other key still hands the texture out');
    assert.deepEqual(
      shared.texture.destroyCalls,
      [],
      'evicting one key must not destroy a texture a surviving entry still hands out',
    );

    // Not retained forever: the last holder still destroys it, exactly once.
    assert.equal(cache.release('b', true), true, 'b was there to release');
    assert.deepEqual(shared.texture.destroyCalls, [true], 'the last holder destroys the shared texture');
  });

  it('does not destroy a shared texture on the replace path either', () => {
    const cache = createTextureCache({ maxEntries: 4 });
    const shared = cacheEntry();
    cache.set('a', shared.entry);
    cache.set('b', shared.entry);

    const replacement = cacheEntry();
    cache.set('a', replacement.entry);

    assert.equal(cache.get('a')?.texture, replacement.texture, 'a now holds the replacement');
    assert.deepEqual(
      shared.texture.destroyCalls,
      [],
      'replacing one key must not destroy an object the other key still holds',
    );
    assert.equal(cache.get('b')?.texture, shared.texture, 'b still hands out the shared texture');
  });

  it('drops a released entry without destroying a texture another key still holds', () => {
    const cache = createTextureCache({ maxEntries: 4 });
    const shared = cacheEntry();
    cache.set('a', shared.entry);
    cache.set('b', shared.entry);

    assert.equal(cache.release('a', true), true, 'the entry was there, so it is dropped');
    assert.equal(cache.get('a'), undefined, 'the released key is gone');
    assert.equal(cache.get('b')?.texture, shared.texture, 'the other key still hands the texture out');
    assert.deepEqual(
      shared.texture.destroyCalls,
      [],
      'an explicit release must not leave the surviving entry handing out a destroyed texture',
    );
  });
});

// --------------------------------------------------------------------------------------
// The cache `textureFrom` writes through
// --------------------------------------------------------------------------------------

describe('textureFrom: the cache it writes through', () => {
  it('does not destroy a texture it merely re-hands out', () => {
    installStage();
    const cache = createTextureCache();

    textureFrom('reuse-source', { cache, key: 'a' });
    const reused = textureFrom('reuse-source', { cache, key: 'a' });

    assert.equal(reused.useCount, 2, 'the second call is a cache hit, so the count is bumped');
    assert.equal(FakeTexture.instances.length, 1, 'the second call decoded nothing');

    const only = FakeTexture.instances[0];
    assert.ok(only !== undefined, 'the first call built a texture');
    assert.deepEqual(only.destroyCalls, [], 're-setting the same texture object must not destroy it');
  });

  it('destroys the texture it replaces on a refresh', () => {
    installStage();
    const cache = createTextureCache();

    textureFrom('refresh-source', { cache, key: 'a', refresh: true });
    const second = textureFrom('refresh-source', { cache, key: 'a', refresh: true });

    assert.equal(FakeTexture.instances.length, 2, 'a refresh decodes a fresh texture');
    const [firstTexture, secondTexture] = FakeTexture.instances;
    assert.ok(firstTexture !== undefined, 'the first decode is tracked');
    assert.ok(secondTexture !== undefined, 'the second decode is tracked');
    assert.equal(second.texture, secondTexture, 'the returned entry holds the new texture');
    assert.deepEqual(firstTexture.destroyCalls, [true], 'the replaced texture is destroyed exactly once');
    assert.deepEqual(secondTexture.destroyCalls, [], 'the live texture is not destroyed');
  });
});
