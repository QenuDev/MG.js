/**
 * Sprites and the texture cache.
 *
 * ## The asymmetry the docs name, and why it drives this whole module
 *
 * §17, "Adding images / sprites": "decode it into a `Texture` once and reuse it for every sprite you
 * create from it". The quoted note continues that texture decode is comparatively expensive and that
 * sprite creation is cheap.
 *
 * That is not a small ratio. Decoding a PNG into a GPU texture means: read the bytes, run the image
 * decoder, upload to the GPU, and (on the way) allocate a canvas-backed source. Creating a `Sprite` is
 * a small object that holds a *reference* to an already-decoded texture. So a counter that shows a coin
 * icon should decode once and create N sprites, and the failure mode of getting this wrong is
 * dramatic: a per-update `Texture.from(dataUrl)` decodes the same bytes every frame, which at 60 Hz
 * means sixty full PNG decodes and sixty GPU uploads per second. That is enough to visibly drop the
 * game's frame rate on its own.
 *
 * {@link textureFrom} therefore memoises by an opaque cache key, and the cache is the *only* texture
 * creation path in this package.
 *
 * ## Why the cache key is a parameter rather than derived from the image
 *
 * Two different images can be the same object? No, but two different callers can hand us the same URL
 * and expect the same texture, and one caller can hand us a fresh `Image` element every time for the
 * same asset (the shape `new Image(); img.src = url` in a loop takes). The key is therefore
 * the caller's string, and the docs' own example uses the base64 payload itself as that key, which is
 * stable, unique per image, and already in memory.
 *
 * ## The `Texture.from` uncertainty, stated rather than papered over
 *
 * §17's example calls `ctors.Texture.from(img)`. That is Pixi v7's API. In Pixi v8 `Texture.from` was
 * removed from the class and lives on `Assets` instead, and the *constructor* accepts a source
 * directly. The recon notes the game's build has moved between Pixi majors without saying which one is
 * live. {@link textureFrom} therefore tries, in order: `Texture.from(source)`, then a direct
 * `new Texture(source)`, then `new Texture({ source })`, and reports failure rather than fabricating
 * success. Whichever succeeds is what the build supports, and we do not guess.
 */

import type { PixiDisplayObject, PixiTexture } from './ctors.js';
import { PixiStage } from './pixi.js';

/** Anything Pixi can build a texture from. */
export type TextureSource = HTMLImageElement | HTMLCanvasElement | ImageBitmap | string;

/** A texture plus the size we know about it, when we know it. */
export interface CachedTexture {
  readonly texture: PixiTexture;
  /** Intrinsic pixel width, or `null` when the source did not report one. */
  readonly width: number | null;
  /** Intrinsic pixel height, or `null`. */
  readonly height: number | null;
  /** How many times this cached texture has been handed out, for diagnostics. */
  readonly useCount: number;
}

/**
 * The texture cache.
 *
 * A `Map` rather than a `WeakMap` because the keys are strings. The store is **bounded**: past
 * `maxEntries` it evicts the oldest-inserted entry. Evicting, replacing and `release(key, true)` all
 * **destroy** the texture they drop, because dropping the reference is not releasing the GPU resource
 * behind it. Since the docs' own idiom keys the cache by the base64 payload, an unbounded store
 * also retains one image-sized string per entry. Two callers can still need a texture the cache is
 * dropping, and only the caller can rule either case out; {@link createTextureCache} names both hazards
 * and the property a caller must uphold.
 *
 * The bound is generous ({@link DEFAULT_TEXTURE_CACHE_ENTRIES}); eviction is
 * oldest-inserted-first, and an update to a live key does not refresh that order. A caller that wants to
 * add and remove textures dynamically should call {@link release}, so the cache is exposed as
 * an object rather than hidden behind a module-level `let`.
 */
export interface TextureCache {
  /** How many entries this cache holds before it evicts the oldest. */
  readonly maxEntries: number;
  /** The entry for a key, or `undefined`. */
  get(key: string): CachedTexture | undefined;
  /**
   * Store an entry, destroying the texture it replaces when that is a different one that no other entry
   * of this cache still holds.
   */
  set(key: string, entry: CachedTexture): void;
  /**
   * Drop an entry, destroying its texture when `destroy` is true and no other entry of this cache still
   * holds the same object.
   */
  release(key: string, destroy?: boolean): boolean;
  /** Every key currently held. */
  keys(): string[];
  /** How many entries are currently held. */
  size(): number;
}

/**
 * How many textures one cache holds before the oldest is evicted.
 *
 * 256 matches the renumberer's `MAX_REMEMBERED_IDS`, and is two orders of magnitude above the "handful
 * of icons" the cache was designed for, so a legitimate mod never reaches it.
 */
export const DEFAULT_TEXTURE_CACHE_ENTRIES = 256;

/**
 * Destroy one cached texture, tolerating a missing `destroy` and one that throws.
 *
 * The single place a texture is actually destroyed, reached from {@link destroyIfUnshared} and through it
 * from {@link TextureCache.release}, {@link TextureCache.set}'s replace path and its eviction loop, so all
 * three drop a resource the same way.
 */
function destroyTexture(entry: CachedTexture): void {
  if (typeof entry.texture.destroy === 'function') {
    try {
      entry.texture.destroy(true);
    } catch {
      // A texture that refuses to destroy is the game's business, not ours.
    }
  }
}

/**
 * Destroy a texture this cache is dropping, unless another of its entries still hands out the same object.
 *
 * Pixi dedupes `Texture.from(source)`, so two keys of one cache can map to the same texture object: the
 * same source handed in under two keys is one texture. Destroying it while the other entry is live would
 * hand a caller a destroyed object, and that is the one half of the shared-texture hazard this cache *can*
 * detect, so it does. A texture still held elsewhere (another cache, a live sprite) is not detectable
 * here and remains the caller's obligation. See {@link createTextureCache}.
 *
 * The scan is over the cache's own entries, which `maxEntries` bounds, and it runs only when the cache is
 * already dropping something (eviction, replacement or an explicit release).
 */
function destroyIfUnshared(
  store: Map<string, CachedTexture>,
  droppedKey: string,
  entry: CachedTexture,
): void {
  for (const [key, held] of store) {
    if (key !== droppedKey && held.texture === entry.texture) return;
  }
  destroyTexture(entry);
}

/**
 * Create an empty cache.
 *
 * ## The two destroy hazards, and the property that makes them safe
 *
 * Eviction, replacement and `release(key, true)` destroy the texture they drop, and this cache cannot tell
 * whether anything still needs that texture: Pixi sprites hold the texture directly, and `useCount` counts
 * cache hits rather than live references. There are two ways a caller can still need it:
 *
 *   1. **A live sprite.** A sprite built from a cached texture keeps that exact object, so dropping the
 *      entry under its key destroys the texture out from under a sprite that is still on screen.
 *   2. **A second cache entry holding the same object.** `Texture.from(source)` dedupes, so the same
 *      source handed in under two keys is *one* texture held by two entries; dropping one entry must not
 *      destroy an object the other entry still hands out. Unlike hazard 1 this is detectable inside a
 *      single cache, so it is guarded: {@link destroyIfUnshared} destroys a texture only when no entry of
 *      this cache still holds it.
 *
 * The property a caller must uphold is therefore **one key per texture object, per cache, for as long as
 * any sprite uses it**. The default key of {@link textureFrom}, the source itself, upholds the key half,
 * because Pixi's own dedupe makes one source one texture; a caller that invents aliases for a source does
 * not, and neither does a caller that lets a sprite outlive the entry it came from. The default bound is
 * generous enough that a legitimate mod never reaches it; a caller with a larger working set passes
 * `maxEntries`, understanding that hazard 1 stays theirs to manage.
 *
 * `maxEntries` must be a positive finite integer. Anything else throws a `RangeError`: `NaN` or
 * `Infinity` (which compare false
 * against every size, so nothing is ever evicted), `0` or a negative (which evicts the entry just stored),
 * or a fraction (which would make the enforced bound differ from the reported one). A bound that cannot
 * bound is worse than no option at all.
 */
export function createTextureCache(options: { maxEntries?: number } = {}): TextureCache {
  const maxEntries = options.maxEntries ?? DEFAULT_TEXTURE_CACHE_ENTRIES;
  // A bound that cannot bound is worse than no option at all, because it reads like a bound. `size > NaN`
  // and `size > Infinity` are both false, so those values make the cache unbounded, which defeats the
  // purpose of the bound, and `0`/a negative makes every `set` destroy the texture it was just handed to.
  // A fraction is rejected rather than truncated: `maxEntries` reports the value back, so truncating would
  // make the exposed bound differ from the enforced one.
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError(
      `createTextureCache: maxEntries must be a positive finite integer, received ${String(maxEntries)}.`,
    );
  }
  const store = new Map<string, CachedTexture>();
  return {
    maxEntries,
    size: () => store.size,
    get: (key) => store.get(key),
    set: (key, entry) => {
      const previous = store.get(key);
      // Replacing a *different* texture orphans it. `textureFrom`'s reuse path re-sets the same texture
      // object with a bumped `useCount`, and destroying there would kill a texture still on screen. A
      // different texture another key still holds is not destroyed either: that key is still handing it out.
      if (previous !== undefined && previous.texture !== entry.texture) {
        destroyIfUnshared(store, key, previous);
      }
      store.set(key, entry);
      while (store.size > maxEntries) {
        const oldest = store.keys().next().value; // Map iteration is insertion order.
        // Unreachable: `maxEntries` is validated to be >= 1 and `store.set` above just added a key, so
        // `size > maxEntries` means the map holds at least two entries and its iterator cannot be empty.
        // The guard exists only to narrow `IteratorResult.value`, not to handle a real case.
        if (oldest === undefined) break;
        const evicted = store.get(oldest);
        store.delete(oldest);
        if (evicted !== undefined) destroyIfUnshared(store, oldest, evicted);
      }
    },
    release: (key, destroy = false) => {
      const entry = store.get(key);
      if (entry === undefined) return false;
      store.delete(key);
      if (destroy) destroyIfUnshared(store, key, entry);
      return true;
    },
    keys: () => [...store.keys()],
  };
}

/** The package-wide texture cache. Mods that want their own should call {@link createTextureCache}. */
export const sharedTextures: TextureCache = createTextureCache();

/** Options for {@link textureFrom}. */
export interface TextureFromOptions {
  /** The cache to use. Defaults to {@link sharedTextures}. */
  cache?: TextureCache;
  /**
   * Cache key. Defaults to using the source itself when it is a string; a non-string source with no
   * explicit key is *not* cached, because there is no stable identity to cache it under.
   */
  key?: string;
  /** Force a fresh decode even when the key is already cached. */
  refresh?: boolean;
}

/** Read a numeric `width`/`height` off a texture or its source, tolerating both Pixi majors. */
function readSize(texture: unknown, axis: 'width' | 'height'): number | null {
  if (texture === null || typeof texture !== 'object') return null;
  const record = texture as Record<string, unknown>;
  const direct = record[axis];
  if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) return direct;
  // v7: size lives on the source image. v8: on `.source`.
  for (const holder of [record['source'], record['baseTexture'], record['resource']]) {
    if (holder === null || typeof holder !== 'object') continue;
    const value = (holder as Record<string, unknown>)[axis];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/**
 * Create (or reuse) a texture.
 *
 * Reuses by cache key. Decode cost is why this exists; see the module header.
 *
 * @throws {Error} when the `Texture` constructor was not recovered, or when no supported construction
 *   route exists on this build. Failing loudly is correct here: a caller that asked for a texture and
 *   silently received `null` would attach an invisible sprite and have nothing to debug.
 */
export function textureFrom(source: TextureSource, options: TextureFromOptions = {}): CachedTexture {
  const cache = options.cache ?? sharedTextures;
  const key = options.key ?? (typeof source === 'string' ? source : null);

  if (key !== null && options.refresh !== true) {
    const hit = cache.get(key);
    if (hit !== undefined) {
      // Hand out the same entry with an incremented use count. The count is diagnostic only: it is
      // what tells a caller whether their cache key is actually deduplicating or whether they are
      // decoding the same asset under many keys.
      const reused: CachedTexture = { ...hit, useCount: hit.useCount + 1 };
      cache.set(key, reused);
      return reused;
    }
  }

  const ctors = PixiStage.tryGetCtors();
  if (ctors === null) {
    throw new Error(
      'mg.js: the Pixi constructor set is not recovered yet, so no texture can be created. ' +
        'Await PixiStage.getCtors() before calling textureFrom().',
    );
  }

  const texture = constructTexture(ctors.Texture, source);
  const entry: CachedTexture = {
    texture,
    width: readSize(texture, 'width'),
    height: readSize(texture, 'height'),
    useCount: 1,
  };
  if (key !== null) cache.set(key, entry);
  return entry;
}

/**
 * The three construction routes, tried in order.
 *
 * Each is wrapped because a route that exists but rejects our argument throws, and a build that has
 * `Texture.from` present but non-functional is the case this ordering is protecting against.
 */
function constructTexture(
  TextureCtor: new (...args: unknown[]) => PixiTexture,
  source: TextureSource,
): PixiTexture {
  const withFrom = TextureCtor as unknown as { from?: (value: unknown) => unknown };

  if (typeof withFrom.from === 'function') {
    try {
      const created = withFrom.from(source);
      if (created !== null && typeof created === 'object') return created as PixiTexture;
    } catch {
      // v8 removed the static; a build that keeps it as a throwing shim lands here.
    }
  }

  try {
    return new TextureCtor(source);
  } catch {
    // Some builds require an options bag instead of a bare source.
  }

  return new TextureCtor({ source });
}

/**
 * Wait for an `Image` to decode.
 *
 * `HTMLImageElement.decode()` is the modern, promise-returning route and it fails loudly, which is the
 * behaviour a caller wants: an image that 404s should reject rather than sit forever in `onload` limbo. It is
 * feature-detected because older WebKit lacks it, and falling back to `onload`/`onerror` is a real
 * difference in behaviour, not a stylistic one.
 *
 * The page's `Image` constructor is resolved through the realm, not from this module's scope: under
 * Tampermonkey's sandbox the sandbox's `Image` is a different constructor whose instances may not be
 * acceptable to the page's Pixi build.
 */
export async function loadImageSource(
  url: string,
  imageCtor?: new () => HTMLImageElement,
): Promise<HTMLImageElement> {
  const Ctor = imageCtor ?? resolveImageCtor();
  if (Ctor === null) {
    throw new Error('mg.js: no Image constructor is available in this realm; cannot decode a texture.');
  }
  const image = new Ctor();
  image.src = url;

  const decodable = image as unknown as { decode?: () => Promise<void> };
  if (typeof decodable.decode === 'function') {
    await decodable.decode();
    return image;
  }

  await new Promise<void>((resolve, reject) => {
    image.addEventListener('load', () => resolve(), { once: true });
    image.addEventListener(
      'error',
      () => reject(new Error(`mg.js: image failed to load: ${url.slice(0, 96)}`)),
      { once: true },
    );
  });
  return image;
}

/**
 * Find the page's `Image` constructor.
 *
 * Read through the global object rather than importing `realm`, because a *missing* page should give
 * `null` (and a clear throw from the caller) rather than a `requirePage` exception from deep inside a
 * helper that a caller may have wrapped in its own try/catch.
 */
function resolveImageCtor(): (new () => HTMLImageElement) | null {
  const globalObject = globalThis as Record<string, unknown>;
  const unsafe = globalObject['unsafeWindow'];
  const holder =
    unsafe !== null && typeof unsafe === 'object' ? (unsafe as Record<string, unknown>) : globalObject;
  const ctor = holder['Image'];
  return typeof ctor === 'function' ? (ctor as new () => HTMLImageElement) : null;
}

/**
 * Create a sprite from a texture.
 *
 * The docs stress that creating a sprite from a texture is cheap, so this is synchronous and does no
 * caching of its own. A
 * sprite is a *view* of a texture: many sprites per texture is the intended shape, and each sprite owns
 * no pixel data.
 *
 * Sizing: `width`/`height` are set together when both are given, because setting only one distorts the
 * sprite, and Pixi's `width` setter recomputes `scale`, so setting `width` and then `height` from a
 * square's target size leaves the scale correct only by accident. When neither is given, the sprite
 * keeps the texture's intrinsic size, which is almost always the right default.
 */
export function createSprite(
  texture: PixiTexture,
  options: { x?: number; y?: number; width?: number; height?: number; zIndex?: number; label?: string } = {},
): PixiDisplayObject {
  const ctors = PixiStage.tryGetCtors();
  if (ctors === null) {
    throw new Error(
      'mg.js: the Pixi constructor set is not recovered yet, so no sprite can be created. ' +
        'Await PixiStage.getCtors() before calling createSprite().',
    );
  }
  return createSpriteSync(ctors.Sprite, texture, options);
}

/** The synchronous half of {@link createSprite}, for a caller that already has the constructor. */
export function createSpriteSync(
  SpriteCtor: new (...args: unknown[]) => PixiDisplayObject,
  texture: PixiTexture,
  options: { x?: number; y?: number; width?: number; height?: number; zIndex?: number; label?: string } = {},
): PixiDisplayObject {
  const sprite = new SpriteCtor(texture);
  if (options.x !== undefined) sprite.x = options.x;
  if (options.y !== undefined) sprite.y = options.y;
  if (options.width !== undefined && options.height !== undefined) {
    sprite.width = options.width;
    sprite.height = options.height;
  }
  if (options.zIndex !== undefined) sprite.zIndex = options.zIndex;
  if (options.label !== undefined) sprite.label = options.label;
  return sprite;
}
