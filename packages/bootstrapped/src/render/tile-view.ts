/**
 * Finding tiles and render layers, and the Graphics predicate that guards them.
 *
 * Split out of `world.ts` (Phase 5 Task 5.7c). The bounded scans live here, and so does
 * {@link asGraphics} - the narrowing form of `ctors.ts`'s `isGraphicsLike`.
 */

import type { PixiDisplayObject, PixiGraphics, PixiTexture } from './ctors.js';
import { isGraphicsLike } from './ctors.js';

/**
 * Find a `RenderLayer` constructor, if this build exposes one.
 *
 * `RenderLayer` is a Pixi v8 class and is *not* in the documented `PixiCtors` set, and the API reference
 * documents no way to obtain it. The only route that does not involve inventing a global is the
 * constructor's own module: a bundled Pixi attaches its exports to the function object's properties
 * (esbuild's IIFE CJS shim keeps a `module.exports`-shaped property on some bundles) or, more reliably,
 * the recovered `Container` may carry sibling references. Both are tried; neither is assumed.
 *
 * Returns `null` otherwise, and the caller degrades with a report. See {@link WorldScene.buildLayers}.
 */
export function findRenderLayerCtor(
  containerCtor: (new (...args: unknown[]) => PixiDisplayObject) | null,
): (new (...args: unknown[]) => PixiDisplayObject) | null {
  if (containerCtor === null) return null;
  const holders: unknown[] = [containerCtor];
  // A CJS/IIFE bundle shim often hangs the namespace off the exported function.
  for (const key of ['module', 'exports', '__esModule', 'default', 'PIXI']) {
    const value = (containerCtor as unknown as Record<string, unknown>)[key];
    if (value !== undefined && value !== null) holders.push(value);
  }
  for (const holder of holders) {
    if (holder === null || typeof holder !== 'object') continue;
    const candidate = (holder as Record<string, unknown>)['RenderLayer'];
    if (typeof candidate === 'function') {
      return candidate as new (
        ...args: unknown[]
      ) => PixiDisplayObject;
    }
  }
  return null;
}

/**
 * Walk a world container looking for per-tile view objects.
 *
 * A tile view is identified by having its own `draw` method and being a leaf-ish node (no `children`
 * array), which is how the game's tile renderers are shaped. Bounded and iterative, and it never
 * throws: this runs while the game might be mutating the same tree.
 */
export function collectTileViews(root: unknown, limit = 2_000): PixiDisplayObject[] {
  const found: PixiDisplayObject[] = [];
  if (root === null || typeof root !== 'object') return found;
  const seen = new Set<unknown>();
  const stack: unknown[] = [root];
  let budget = limit;

  while (stack.length > 0 && budget > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    budget -= 1;

    const record = node as Record<string, unknown>;
    if (typeof record['draw'] === 'function' && !Array.isArray(record['children'])) {
      found.push(node as PixiDisplayObject);
      continue;
    }
    const children = record['children'];
    if (Array.isArray(children)) {
      for (const child of children) if (!seen.has(child)) stack.push(child);
    }
  }
  return found;
}

/**
 * Turn an `HTMLImageElement` into a texture, trying both Pixi majors' routes.
 *
 * Local rather than delegating to `sprite.ts`'s `textureFrom`, because `WorldScene.addSprite` receives an
 * already-decoded image element (the documented signature) and the shared cache is keyed by strings. A
 * `<img>` is a stable object identity, so the WeakMap cache is the correct shape and avoids treating
 * two distinct images as one.
 */
const imageTextures = new WeakMap<object, PixiTexture>();

export function textureFromImage(
  TextureCtor: new (...args: unknown[]) => PixiTexture,
  image: HTMLImageElement,
): PixiTexture | null {
  if (image === null || typeof image !== 'object') return null;
  const cached = imageTextures.get(image);
  if (cached !== undefined) return cached;

  const withFrom = TextureCtor as unknown as { from?: (value: unknown) => unknown };
  let texture: PixiTexture | null = null;

  if (typeof withFrom.from === 'function') {
    try {
      const created = withFrom.from(image);
      if (created !== null && typeof created === 'object') texture = created as PixiTexture;
    } catch {
      // v8 removed the static.
    }
  }
  if (texture === null) {
    try {
      texture = new TextureCtor(image);
    } catch {
      try {
        texture = new TextureCtor({ source: image });
      } catch {
        return null;
      }
    }
  }
  imageTextures.set(image, texture);
  return texture;
}

/**
 * A Graphics handle for a scene layer, if the caller wants to draw into one.
 *
 * Convenience, not part of the documented surface: `WorldScene` is specified to own *containers*, and
 * drawing into them is the caller's business. This exists so a caller does not have to know that a
 * layer's container happens to be a Graphics instance.
 *
 * The narrowing flavour of `ctors.ts`'s `isGraphicsLike`, and it delegates to it rather than restating
 * the `clear`/`roundRect` pair: the hand-written pair dereferenced its argument with no receiver guard,
 * so a `null` threw a `TypeError` where the predicate answered `false` and this function's own return
 * type promised `null`.
 */
export function asGraphics(container: PixiDisplayObject): PixiGraphics | null {
  return isGraphicsLike(container) ? (container as PixiGraphics) : null;
}
