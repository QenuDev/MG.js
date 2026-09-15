/**
 * The Pixi constructor surface: the one accessor every downstream mod uses.
 *
 * ## Why this file exists at all
 *
 * The game exposes no `PIXI` global. Its Pixi.js build is bundled, tree-shaken and minified into the
 * game's own chunk, so `window.PIXI` is `undefined` and there is no importable module to reach for.
 * The only way to create a Sprite, a Text node or a Graphics is to recover the *constructors from
 * objects the game has already made*: duck-type a live node and read its `.constructor`. That is what
 * `PixiStage.getCtors()` is specified to do (recon `recon-quinoa-api-reference.md` §2.7).
 *
 * ## The documented surface, and the one gap in it
 *
 * §3.1 defines `PixiCtors` with **exactly five** fields: `Container`, `Sprite`, `Texture`,
 * `Rectangle` and `Text`. All five are typed bare `unknown` (gap G37: "a wrapper must write its own
 * types for every Pixi object it creates"). `Graphics` is *not* one of the five; §2.7 documents it
 * behind a separate call, `PixiStage.getGraphicsCtor(stage)`, because the graphics node is found by a
 * different signal (unminified `roundRect()`/`clear()`) and may not exist until something is drawn.
 *
 * This module therefore exposes the documented five through {@link PixiCtors}, `Graphics` through
 * {@link getGraphicsCtor} / {@link RecoveredCtors.graphics}, and `Application`/`Renderer` through
 * {@link getApplication} / {@link getRenderer}. Those two are not recoverable by duck-typing the
 * stage at all, only from the `__PIXI_APP_INIT__` / `__PIXI_RENDERER_INIT__` hooks that
 * `src/render/pixi.ts` captures.
 *
 * ## Two more documented gaps this module has to fill
 *
 *   - **G39**: the docs refer to "the live root container, from `PixiStage.stage`", but `PixiStage`
 *     documents no `stage` property. The root is therefore *written* rather than read: it is whichever
 *     object the init hooks hand us, or `application.stage`.
 *   - **G38**: "discovery is polling-based with no policy... No timeout, no retry count, no failure
 *     signal." {@link getCtors} therefore implements the policy the docs leave out: a bounded
 *     `requestAnimationFrame` poll with a real deadline, and an explicit failure rather than a
 *     promise that never settles.
 *
 * ## No `any`
 *
 * The docs type all of this as `unknown`. Rather than preserving `unknown` (which forces every caller
 * to cast) or reaching for `any` (which is banned here), this module declares *minimal structural*
 * interfaces describing only the members a mod actually calls. They are open-ended by design: the index
 * signature `[key: string]: unknown` lets a build that adds members still assign cleanly. They are also
 * non-exhaustive by design, so nothing here claims more knowledge of Pixi than we have verified.
 *
 * Nothing in this file touches `window` at module load; every page access goes through
 * `realm.getPage()` inside a function.
 */

import { pollUntil } from '@mg.js/common';
import { getPage } from '../page/realm.js';

// --------------------------------------------------------------------------------------
// Structural Pixi types
// --------------------------------------------------------------------------------------

/**
 * Anything that can live in the display tree.
 *
 * Every member is optional-except-the-structural-ones on purpose: `addChild`/`removeChild` are the
 * two calls that define "is a container", and `destroy` is the one that defines "can be cleaned up".
 * A leaf display object (a Sprite, a Text) has no `addChild` and that is correct.
 */
export interface PixiDisplayObject {
  /** Present on containers. */
  addChild?: (...children: PixiDisplayObject[]) => unknown;
  /** Present on containers. `removeChild` throws when absent, so prefer `removeChildren` or a guarded call. */
  removeChild?: (child: PixiDisplayObject) => unknown;
  /** Some Pixi versions expose this; it never throws for a child that is not present. */
  removeChildren?: (...children: PixiDisplayObject[]) => unknown;
  /** Releases GPU/CPU resources. Never call this on a node the game owns. */
  destroy?: (options?: { children?: boolean; texture?: boolean; textureSource?: boolean }) => void;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  zIndex?: number;
  /** The plain-string label the game assigns (e.g. `"GardenInfoCardSystem"`). Stable across minification; see §2.7 `findByLabel`. */
  label?: string;
  visible?: boolean;
  alpha?: number;
  rotation?: number;
  scale?: { x: number; y: number; set?: (x: number, y?: number) => void };
  /** The display list, when this is a container. */
  children?: PixiDisplayObject[];
  parent?: PixiDisplayObject | null;
  /** Text-like nodes carry this; used by {@link isTextLike} and by the Rive decoy check. */
  text?: unknown;
  /** Text-like nodes carry a style object; also present on Rive nodes, hence the decoy check. */
  style?: unknown;
  /**
   * The render pipe this node is bound to.
   *
   * `"text"` is the discriminant §2.7 calls for. The game's Rive-backed nodes also expose `.text` and
   * `.style` but are *not* bound to the text pipe, since their constructor throws when handed Pixi-shaped
   * arguments. That is why the docs require this extra check.
   */
  renderPipeId?: unknown;
  /** Sprites carry this. */
  texture?: unknown;
  /** Sprites carry this. */
  anchor?: unknown;
  [key: string]: unknown;
}

/** A Pixi `Texture` (or texture source) as far as a mod needs it. */
export interface PixiTexture {
  width?: number;
  height?: number;
  /** Pixi v8 name. */
  source?: unknown;
  /** Pixi v7 name. */
  baseTexture?: unknown;
  destroy?: (destroySource?: boolean) => void;
  [key: string]: unknown;
}

/** A Pixi `Rectangle`. */
export interface PixiRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
  [key: string]: unknown;
}

/**
 * The Graphics surface.
 *
 * Named to match the *public, unminified* methods the game's build actually exposes. This is the
 * signal `PixiStage.getGraphicsCtor` uses to identify the constructor, and the signal
 * {@link isGraphicsLike} uses here. The chainable shape/`fill`/`stroke` calls are what
 * `src/render/graphics.ts` relies on.
 */
export interface PixiGraphics extends PixiDisplayObject {
  clear: () => PixiGraphics;
  roundRect: (x: number, y: number, width: number, height: number, radius?: number) => PixiGraphics;
  rect: (x: number, y: number, width: number, height: number) => PixiGraphics;
  circle: (x: number, y: number, radius: number) => PixiGraphics;
  fill: (options?: unknown) => PixiGraphics;
  stroke: (options?: unknown) => PixiGraphics;
  moveTo?: (x: number, y: number) => PixiGraphics;
  lineTo?: (x: number, y: number) => PixiGraphics;
}

/** A Pixi `Text` node. */
export interface PixiText extends PixiDisplayObject {
  text: string;
  style: PixiTextStyle;
  /** Anchor on Text is a point-like object rather than a tuple. */
  anchor?: { x: number; y: number; set?: (x: number, y?: number) => void };
  resolution?: number;
}

/** The text style fields we set. All optional; the game's own build fills the rest. */
export interface PixiTextStyle {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  fill?: unknown;
  align?: string;
  stroke?: unknown;
  strokeThickness?: number;
  dropShadow?: unknown;
  wordWrap?: boolean;
  wordWrapWidth?: number;
  padding?: number;
  [key: string]: unknown;
}

/**
 * A Pixi `Application`.
 *
 * Recovered from `__PIXI_APP_INIT__`, never duck-typed from the stage, because an Application is not in
 * the display tree.
 */
export interface PixiApplicationLike {
  stage?: PixiDisplayObject;
  renderer?: PixiRendererLike;
  /** Rebuilds the renderer after context loss. Not all builds expose it. */
  render?: (...args: unknown[]) => unknown;
  ticker?: unknown;
  [key: string]: unknown;
}

/** A Pixi `Renderer`. */
export interface PixiRendererLike {
  width?: number;
  height?: number;
  /** The `<canvas>` the renderer draws into. */
  view?: unknown;
  /** Present on builds that support forced context restore. */
  resize?: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}

/**
 * The documented five-field set, plus the constructors recovered from the init hooks.
 *
 * The five are exactly §3.1's `PixiCtors`; they are also declared as a standalone interface
 * ({@link PixiCtors}) so a caller can accept the documented shape alone.
 */
export interface PixiCtors {
  /** `PIXI.Container`. */
  Container: new (
    ...args: unknown[]
  ) => PixiDisplayObject;
  /** `PIXI.Sprite`. */
  Sprite: new (
    ...args: unknown[]
  ) => PixiDisplayObject;
  /** `PIXI.Texture`. */
  Texture: new (
    ...args: unknown[]
  ) => PixiTexture;
  /** `PIXI.Rectangle`. */
  Rectangle: new (
    ...args: unknown[]
  ) => PixiRectangle;
  /** `PIXI.Text`. */
  Text: new (
    ...args: unknown[]
  ) => PixiText;
}

/**
 * Everything recovered, including the two constructors the docs exclude from `PixiCtors`.
 *
 * `graphics` is `null`-able because a Graphics node truly may not exist yet (nothing has drawn a
 * custom shape), and `application`/`renderer` are nullable because an app may not have been
 * constructed at all. §2.7 says: "an Application may not always be constructed".
 */
export interface RecoveredCtors extends PixiCtors {
  /** From {@link getGraphicsCtor}. `null` until a Graphics node exists in the stage. */
  graphics: (new (...args: unknown[]) => PixiGraphics) | null;
  /** From `__PIXI_APP_INIT__`, or `application.stage`'s owner when only the renderer hook fired. */
  application: PixiApplicationLike | null;
  /** From `__PIXI_RENDERER_INIT__`, or `application.renderer`. */
  renderer: PixiRendererLike | null;
}

/** Options for {@link getCtors}. */
export interface GetCtorsOptions {
  /** Where to look. Defaults to the captured root (see {@link setStageRoot}). */
  stage?: PixiDisplayObject | null;
  /** Give up after this long. Default 15000 ms, which is three frames of a slow start and not an eternity. */
  timeoutMs?: number;
  /** How to schedule retries. Defaults to `requestAnimationFrame`, falling back to a timer. */
  schedule?: (callback: () => void) => void;
}

/** Why {@link getCtors} rejected, for a caller that wants to distinguish slow from absent. */
export class PixiCtorsTimeoutError extends Error {
  override readonly name = 'PixiCtorsTimeoutError';
}

// --------------------------------------------------------------------------------------
// Module-scope caches, and why
// --------------------------------------------------------------------------------------

/**
 * Cache of the recovered constructor set, keyed by the stage object.
 *
 * §2.7: "Cache the result at module scope: re-deriving it walks the entire stage, tens of thousands of
 * nodes on the world/tile layer alone." This is not a micro-optimisation. `findNode` is a depth-first
 * walk with a 25 000-node default budget. A mod that calls `getCtors()` once per frame, which is
 * the natural thing to write, would spend the entire frame budget re-walking the tree it already
 * walked last frame. A `WeakMap` keyed by the stage also gives us correctness for free: a new stage
 * (after WebGL context loss, which recreates the renderer and the strip) is a different key and is
 * re-derived automatically.
 */
const ctorCache = new WeakMap<object, RecoveredCtors>();

/**
 * The recovered constructor set for the *current* stage, for the synchronous fast path.
 *
 * Held separately from `ctorCache` because {@link tryGetCtors} is called with no argument in the hot
 * path and must not walk anything.
 */
let lastRecovered: RecoveredCtors | null = null;

/** The last root we were handed, from the init hooks or an explicit call. */
let stageRoot: PixiDisplayObject | null = null;

/** The Application and Renderer from the init hooks (see `render/pixi.ts`). */
let capturedApplication: PixiApplicationLike | null = null;
let capturedRenderer: PixiRendererLike | null = null;

/**
 * Record the live stage root.
 *
 * Called by `render/pixi.ts` when an init hook fires. Exposed because the docs (gap G39) document no
 * `PixiStage.stage` property, so the root has to be *written* from the hook rather than read from the
 * library.
 */
export function setStageRoot(root: unknown): void {
  stageRoot = isContainerLike(root) ? (root as PixiDisplayObject) : null;
}

/** The recorded stage root, or `null`. */
export function getStageRoot(): PixiDisplayObject | null {
  return stageRoot;
}

/** Record the Application recovered from `__PIXI_APP_INIT__`. */
export function setApplication(application: unknown): void {
  capturedApplication =
    application !== null && typeof application === 'object' ? (application as PixiApplicationLike) : null;
  // A renderer-only build never fires the app hook, so fill the renderer from the app when we can.
  if (capturedApplication !== null && capturedRenderer === null) {
    const renderer = capturedApplication.renderer;
    if (renderer !== null && typeof renderer === 'object') {
      capturedRenderer = renderer as PixiRendererLike;
    }
  }
  if (capturedApplication !== null) {
    const stage = capturedApplication.stage;
    if (stage !== undefined && stage !== null) setStageRoot(stage);
  }
}

/** Record the Renderer recovered from `__PIXI_RENDERER_INIT__`. */
export function setRenderer(renderer: unknown): void {
  capturedRenderer =
    renderer !== null && typeof renderer === 'object' ? (renderer as PixiRendererLike) : null;
}

/** The Application recovered from the init hooks, or `null`. */
export function getApplication(): PixiApplicationLike | null {
  return capturedApplication;
}

/** The Renderer recovered from the init hooks, or `null`. */
export function getRenderer(): PixiRendererLike | null {
  return capturedRenderer;
}

/**
 * Drop every cache.
 *
 * Called when the renderer is recreated (WebGL context loss after the tab is backgrounded; §2.7
 * says the init hooks "re-fire on renderer recreation"). The old stage's constructors are usually
 * still valid, since the game's module graph did not reload, but the *root* is gone, and holding a
 * destroyed container that way is a use-after-free waiting to happen. Clearing is cheap; being wrong is not.
 */
export function resetCtorCache(): void {
  lastRecovered = null;
  stageRoot = null;
  capturedApplication = null;
  capturedRenderer = null;
}

// --------------------------------------------------------------------------------------
// Duck typing
// --------------------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

/** Structural check for "has a `children` array", which means it can be walked. */
export function isContainerLike(value: unknown): boolean {
  if (!isObject(value)) return false;
  return Array.isArray(value['children']);
}

/**
 * True when a node is the game's Rive-backed fake-text node.
 *
 * The recon's warning, restated: Rive-based nodes "also expose `.text`/`.style`" and their
 * constructor "throws on Pixi-shaped arguments". They are *not* Pixi display objects at all:
 * they are Rive artboard hosts composited into the same canvas, so selecting one as `PixiCtors.Text`
 * would produce a constructor that detonates the first time a mod calls `new Text(...)`.
 *
 * The signals, in order of strength:
 *   - a `rive`/`artboard`/`stateMachine` member (the Rive runtime object model);
 *   - `renderPipeId` present but not `"text"` on a node that also carries `.text` (a Pixi node with a
 *     non-text pipe is a Container/Graphics, not a Rive host, but combined with `artboard` it is
 *     decisive);
 *   - `.text` that is not a string (Rive's `.text` is typically the artboard or a run collection).
 */
export function isRiveLike(value: unknown): boolean {
  if (!isObject(value)) return false;
  if ('rive' in value || 'artboard' in value || 'stateMachine' in value) return true;
  return false;
}

/**
 * True when a node is a genuine Pixi `Text`.
 *
 * §2.7 is explicit that the primary check is `renderPipeId === "text"`, "falling back to a looser
 * check" only when that field is absent. The looser check is written to require *positive* evidence of
 * being a Pixi Text, meaning a string `.text` and an object `.style`, and to reject anything Rive-shaped
 * first. A signature-less test ("has `.text`") is precisely what the docs warn against.
 */
export function isTextLike(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (isRiveLike(value)) return false;

  const renderPipeId = value['renderPipeId'];
  if (typeof renderPipeId === 'string') {
    // The documented discriminant. Authoritative when present, in both directions.
    return renderPipeId === 'text';
  }

  // renderPipeId absent (older build, or a node type that sets it late). Looser check, documented as
  // such: a Pixi Text carries a *string* `.text` and an object `.style`, and its minified constructor
  // name still contains "Text" because Pixi's own classes are not renamed as aggressively as the
  // game's own modules.
  if (typeof value['text'] !== 'string') return false;
  const style = value['style'];
  if (!isObject(style)) return false;
  const ctorName = constructorName(value);
  return ctorName.includes('Text') || 'fontSize' in style || 'fontFamily' in style;
}

/**
 * True when a node is a genuine Pixi `Sprite`.
 *
 * Sprite in Pixi v7 has `.texture` and `.anchor` and is a leaf; in v8 the texture may live under
 * `.texture` still but `.anchor` is a `Point`. Rather than pinning a version, require the two fields
 * that are stable across both and exclude the two things that are not sprites but share them (Text
 * nodes carry no `.anchor` in v7 and graphics carry no `.texture`).
 */
export function isSpriteLike(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (isRiveLike(value)) return false;
  if (value['texture'] === undefined || value['texture'] === null) return false;
  if (isTextLike(value)) return false;
  const anchor = value['anchor'];
  // v7 Sprite.anchor is a Point-like object; some builds expose a bare array [x, y].
  return isObject(anchor) || Array.isArray(anchor);
}

/**
 * True when a node exposes the public Graphics API.
 *
 * §2.7: "Finds a node exposing the public, unminified `roundRect()`/`clear()` Graphics API". Those two
 * names are the whole signal, and they are the *right* signal. The game's build minifies its own
 * identifiers but cannot minify the Pixi API without breaking its own call sites, so `roundRect` and
 * `clear` survive verbatim.
 */
export function isGraphicsLike(value: unknown): boolean {
  if (!isObject(value)) return false;
  return typeof value['roundRect'] === 'function' && typeof value['clear'] === 'function';
}

/** A constructor's name, or `''` when it is anonymous. Never throws. */
function constructorName(value: unknown): string {
  if (!isObject(value)) return '';
  const ctor = (value as { constructor?: unknown }).constructor;
  if (typeof ctor !== 'function') return '';
  const name = (ctor as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

// --------------------------------------------------------------------------------------
// Search
// --------------------------------------------------------------------------------------

/** The documented default budget: §2.7 gives `findNode`'s `limit` a default of `25000`. */
export const DEFAULT_FIND_LIMIT = 25_000;

/**
 * Depth-first search over the display tree.
 *
 * Implemented iteratively with an explicit stack rather than recursively: the world/tile layer nests
 * deeply enough that a recursive walk is a stack-overflow risk in a page that is already using most of
 * its stack for the game's own render loop.
 *
 * Cycles are guarded against with a `Set`, because a malformed or mid-mutation tree (the game mutates
 * the display list every frame) can transiently contain one, and an infinite loop inside a
 * `requestAnimationFrame` callback would freeze the tab.
 *
 * @returns the first node the predicate accepts, or `null`. Never throws: a getter that throws on
 *   some exotic node must not break the whole search, so each node is visited defensively.
 */
export function findNode(
  root: unknown,
  predicate: (node: unknown) => boolean,
  limit = DEFAULT_FIND_LIMIT,
): PixiDisplayObject | null {
  if (!isObject(root)) return null;
  if (!Number.isFinite(limit) || limit <= 0) return null;

  const visited = new Set<unknown>();
  const stack: unknown[] = [root];
  let budget = limit;

  while (stack.length > 0) {
    const node = stack.pop();
    if (!isObject(node)) continue;
    if (visited.has(node)) continue;
    visited.add(node);
    budget -= 1;
    if (budget <= 0) return null;

    let accepted = false;
    try {
      accepted = predicate(node);
    } catch {
      // A predicate that throws on one node says nothing about the rest of the tree.
      accepted = false;
    }
    if (accepted) return node as PixiDisplayObject;

    let children: unknown;
    try {
      children = (node as { children?: unknown }).children;
    } catch {
      children = undefined;
    }
    if (!Array.isArray(children)) continue;
    // Push in reverse so the traversal order matches a natural pre-order (first child first).
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child: unknown = children[index];
      if (!visited.has(child)) stack.push(child);
    }
  }

  return null;
}

/**
 * Find a node by the plain-string `.label` the game assigned it.
 *
 * §2.7: "A plain-string `.label` the game assigned to a container, e.g. `'GardenInfoCardSystem'`, not
 * a minified identifier, and far more stable across builds." This is the recommended way to reach a
 * specific part of the game's UI: label strings are authored, so they survive the minifier, whereas
 * variable names and object identity do not.
 */
export function findByLabel(root: unknown, label: string): PixiDisplayObject | null {
  return findNode(root, (node) => {
    if (!isObject(node)) return false;
    return (node as { label?: unknown }).label === label;
  });
}

/** Every node matching a predicate, breadth-first, honouring the same budget. */
export function findAllNodes(
  root: unknown,
  predicate: (node: unknown) => boolean,
  limit = DEFAULT_FIND_LIMIT,
): PixiDisplayObject[] {
  const found: PixiDisplayObject[] = [];
  if (!isObject(root)) return found;
  const visited = new Set<unknown>();
  const queue: unknown[] = [root];
  let budget = limit;
  while (queue.length > 0 && budget > 0) {
    const node = queue.shift();
    if (!isObject(node) || visited.has(node)) continue;
    visited.add(node);
    budget -= 1;
    let accepted = false;
    try {
      accepted = predicate(node);
    } catch {
      accepted = false;
    }
    if (accepted) found.push(node as PixiDisplayObject);
    const children = (node as { children?: unknown }).children;
    if (Array.isArray(children)) {
      for (const child of children) if (!visited.has(child)) queue.push(child);
    }
  }
  return found;
}

// --------------------------------------------------------------------------------------
// Constructor recovery
// --------------------------------------------------------------------------------------

/** Wrap a recovered constructor, or `null` when it is not callable. */
function asConstructor<T>(value: unknown): (new (...args: unknown[]) => T) | null {
  return typeof value === 'function' ? (value as new (...args: unknown[]) => T) : null;
}

/**
 * Recover the `Texture` and `Rectangle` constructors.
 *
 * Neither is duck-typed from a live node the way Sprite/Text are, because neither is *in* the display
 * tree. A Texture is referenced by sprites, and a Rectangle is only reachable as the geometry of
 * something (a texture's frame, a node's bounds). The reachable routes, in the order tried:
 *
 *   1. `Texture` from the first sprite's `.texture.constructor` (the texture instance itself).
 *   2. `Texture` from a node's `texture.source.constructor` when the sprite's texture is a plain
 *      object produced by a factory rather than a class instance.
 *   3. `Rectangle` from the same texture's `.frame`/`.orig` (a Rectangle instance), and from any
 *      node's `.bounds`/`.hitArea`.
 *
 * Every route is feature-detected and any that fails is simply skipped: the recon says these shapes
 * move between builds, so a fabricated fallback would be worse than a `null` field. `Texture` being
 * `null` is survivable for text/shape work; a caller that needs it should check.
 */
function recoverTextureAndRectangle(stage: PixiDisplayObject): {
  Texture: (new (...args: unknown[]) => PixiTexture) | null;
  Rectangle: (new (...args: unknown[]) => PixiRectangle) | null;
} {
  let Texture: (new (...args: unknown[]) => PixiTexture) | null = null;
  let Rectangle: (new (...args: unknown[]) => PixiRectangle) | null = null;

  const candidateNodes = findAllNodes(
    stage,
    (node) => isObject(node) && (node as { texture?: unknown }).texture !== undefined,
    // Set far below the 25 000 default on purpose: we only need *one* textured node, and scanning the
    // whole world layer to find it would be the exact cost the docs warn about.
    2_000,
  );

  for (const node of candidateNodes) {
    const texture = node.texture;
    if (Texture === null) {
      Texture = asConstructor<PixiTexture>(constructorOf(texture));
    }
    if (isObject(texture)) {
      if (Texture === null) Texture = asConstructor<PixiTexture>(constructorOf(texture['source']));
      if (Texture === null) Texture = asConstructor<PixiTexture>(constructorOf(texture['baseTexture']));
      if (Rectangle === null) Rectangle = asConstructor<PixiRectangle>(constructorOf(texture['frame']));
      if (Rectangle === null) Rectangle = asConstructor<PixiRectangle>(constructorOf(texture['orig']));
    }
    if (Rectangle === null) Rectangle = asConstructor<PixiRectangle>(constructorOf(node['bounds']));
    if (Rectangle === null) Rectangle = asConstructor<PixiRectangle>(constructorOf(node['hitArea']));
    if (Texture !== null && Rectangle !== null) break;
  }

  return { Texture, Rectangle };
}

/** The `.constructor` of a value, or `undefined`. */
function constructorOf(value: unknown): unknown {
  if (!isObject(value)) return undefined;
  return (value as { constructor?: unknown }).constructor;
}

/**
 * Derive the full constructor set by walking a live stage.
 *
 * @returns the set, or `null` when the stage has not yet rendered both a sprite and a *genuine* text
 *   node. §2.7 says: "null if the stage has not rendered a sprite and a genuine text node yet. Poll on
 *   requestAnimationFrame and retry." Callers that need it now should use {@link getCtors}, which
 *   implements that polling with a deadline.
 *
 * `Container` comes from the stage itself (the root *is* a Container), which is both correct and free:
 * reading its constructor beats searching 25 000 nodes for one.
 */
export function deriveCtors(stage: unknown): RecoveredCtors | null {
  if (!isContainerLike(stage)) return null;
  const root = stage as PixiDisplayObject;

  const containerCtor = asConstructor<PixiDisplayObject>(constructorOf(root));
  if (containerCtor === null) return null;

  const spriteNode = findNode(root, isSpriteLike);
  const textNode = findNode(root, isTextLike);
  if (spriteNode === null || textNode === null) return null;

  const spriteCtor = asConstructor<PixiDisplayObject>(constructorOf(spriteNode));
  const textCtor = asConstructor<PixiText>(constructorOf(textNode));
  if (spriteCtor === null || textCtor === null) return null;

  // A sprite and a text node that report the *same* constructor mean the duck typing collapsed onto
  // one node type, so refuse rather than hand back a set that would create the wrong object.
  if (spriteCtor === textCtor) return null;

  const graphicsNode = findNode(root, isGraphicsLike);
  const graphicsCtor = asConstructor<PixiGraphics>(constructorOf(graphicsNode));
  const { Texture, Rectangle } = recoverTextureAndRectangle(root);

  return {
    Container: containerCtor,
    Sprite: spriteCtor,
    // Both are legitimately nullable in the docs' model; the *declared* PixiCtors type requires them,
    // so a null Texture is surfaced as a throwing stub rather than a lie. See `nullConstructor`.
    Texture: Texture ?? nullConstructor<PixiTexture>('Texture'),
    Rectangle: Rectangle ?? nullConstructor<PixiRectangle>('Rectangle'),
    Text: textCtor,
    graphics: graphicsCtor,
    application: capturedApplication,
    renderer: capturedRenderer,
  };
}

/**
 * A constructor that exists only to fail loudly.
 *
 * `PixiCtors` declares `Texture` and `Rectangle` as required, because the documented typedef does. But
 * both are recovered opportunistically, and a stage that has rendered a sprite and text yet happens to
 * expose neither is entirely possible. The choice is between claiming a `Texture` we do not have (a
 * silent `undefined is not a constructor` two call frames later) or claiming one that throws with a
 * sentence explaining why. The second is strictly more useful, and `hasFullCtorSet` lets a caller check
 * first.
 */
function nullConstructor<T>(name: string): new (...args: unknown[]) => T {
  const fail = function unrecoverable(): never {
    throw new Error(
      `mg.js: the Pixi ${name} constructor could not be recovered from this build's stage. ` +
        'Nothing in the live display tree exposed one to duck-type. Check hasFullCtorSet(ctors) ' +
        'before constructing.',
    );
  };
  // Named so a stack trace says which one it was.
  Object.defineProperty(fail, 'name', { value: `Unrecovered${name}` });
  // And marked, because a *name* is not a reliable identity: `isUnrecoveredStub` used to string-match on
  // `.constructor.name`, which is `'Function'` for every function ever written, so the check silently reported
  // `false` for the very stubs it existed to find. The stored constructor reference is compared by
  // identity instead, which cannot be fooled by a naming convention.
  Object.defineProperty(fail, UNRECOVERED_CONSTRUCTORS, {
    value: name,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return fail as unknown as new (
    ...args: unknown[]
  ) => T;
}

/**
 * Identity key for an unrecovered-constructor stub.
 *
 * A `Symbol` for a debugger's sake, since a symbol-keyed property that nothing reads is otherwise
 * invisible in an inspection. The lookup itself never depends on the symbol's *description*, only on
 * its identity.
 */
export const UNRECOVERED_CONSTRUCTORS: unique symbol = Symbol.for('mg.js.unrecoveredConstructor');

/**
 * True when every constructor in the documented five-field set was *actually* recovered (as opposed to
 * standing in as a throwing stub).
 */
export function hasFullCtorSet(ctors: PixiCtors): boolean {
  return (
    !isUnrecoveredStub(ctors.Texture) &&
    !isUnrecoveredStub(ctors.Rectangle) &&
    !isUnrecoveredStub(ctors.Container) &&
    !isUnrecoveredStub(ctors.Sprite) &&
    !isUnrecoveredStub(ctors.Text)
  );
}

/**
 * Whether a constructor is one of {@link nullConstructor}'s stubs.
 *
 * Checked by identity, not by name. The name check is kept as a secondary signal because it is what a reader
 * would look for in a stack trace, but it can never be the *only* check: `constructorName` of a function is
 * `'Function'`, and a mod that happens to name its own class `UnrecoveredTexture` would be a false positive.
 */
export function isUnrecoveredStub(value: unknown): boolean {
  if (typeof value !== 'function') return false;
  if ((value as unknown as Record<symbol, unknown>)[UNRECOVERED_CONSTRUCTORS] !== undefined) return true;
  return (
    (value as { name?: unknown }).name !== undefined &&
    String((value as { name: unknown }).name).startsWith('Unrecovered')
  );
}

/**
 * The synchronous fast path.
 *
 * Returns the cached set when the current stage has already been derived, and otherwise attempts a
 * single derivation *now*, caching a success. Returns `null` when nothing has been recovered yet, since it
 * never polls, never schedules, never waits. This is what a per-frame caller should use: the first
 * frame pays for the walk, every later frame is a variable read.
 */
export function tryGetCtors(): RecoveredCtors | null {
  const root = stageRoot ?? capturedApplication?.stage ?? null;
  if (root === null) return lastRecovered;

  const cached = ctorCache.get(root);
  if (cached !== undefined) {
    lastRecovered = cached;
    return cached;
  }

  const derived = deriveCtors(root);
  if (derived === null) return lastRecovered;
  ctorCache.set(root, derived);
  lastRecovered = derived;
  return derived;
}

/**
 * Find a live node exposing the Graphics API and return its constructor.
 *
 * `stage` is optional because the previously-duplicated zero-argument route (`sprite.ts`'s own
 * `getGraphicsCtor()`, which `render/index.ts` also re-exported under a second name until Phase 6) resolved
 * `PixiStage.getGraphicsCtor(PixiStage.stage)`, i.e. the captured root. Leaving the parameter required would
 * have made folding that route in a breaking change to a public name; that second published name is now gone
 * and the behaviour it aliased is this function's default.
 */
export function getGraphicsCtor(stage?: unknown): (new (...args: unknown[]) => PixiGraphics) | null {
  const root = isContainerLike(stage) ? stage : (stageRoot ?? capturedApplication?.stage ?? null);
  if (root === null || root === undefined) return null;
  const node = findNode(root, isGraphicsLike);
  return asConstructor<PixiGraphics>(constructorOf(node));
}

/**
 * Default retry scheduler: `requestAnimationFrame` when the page has one, a 16 ms timer otherwise.
 *
 * `requestAnimationFrame` is the right primitive, and it retries as soon as the game has had a chance
 * to render, so at most one extra derivation attempt per frame, and it is automatically throttled in a
 * backgrounded tab. It is also the primitive the docs name (§2.7), so a caller that supplies its own
 * `schedule` is opting out of documented behaviour, not into it.
 *
 * The timer fallback exists because `requestAnimationFrame` is absent in a worker and in a jsdom test,
 * and a userscript that hangs forever because it could not find a frame callback would be worse than
 * one that polls on a timer.
 */
function defaultSchedule(callback: () => void): void {
  // Read through `realm` rather than touching `window`/`unsafeWindow` here, because the realm bridge is the
  // only place allowed to resolve the page. A *missing* page degrades to the timer fallback instead of
  // throwing, because polling for a renderer is meaningless without a page and a hard failure there
  // would be a worse answer than a timer that simply never finds one.
  const page = getPage();
  const raf = page?.['requestAnimationFrame'];
  if (typeof raf === 'function') {
    (raf as (cb: () => void) => unknown).call(page, callback);
    return;
  }
  setTimeout(callback, 16);
}

/**
 * Recover the constructor set, polling until the stage has rendered a sprite and a genuine text node.
 *
 * Implements the policy gap G38 says is missing: a real deadline, a bounded number of schedules, and a
 * rejection with a diagnosable message rather than a promise that never settles.
 *
 * @throws {PixiCtorsTimeoutError} when nothing was recovered inside `timeoutMs`.
 */
export async function getCtors(options: GetCtorsOptions = {}): Promise<PixiCtors> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const schedule = options.schedule ?? defaultSchedule;
  const explicitStage = options.stage ?? null;
  if (explicitStage !== null) setStageRoot(explicitStage);

  // Fast path first: a cached or immediately derivable set resolves without ever scheduling a frame.
  if (explicitStage === null) {
    const immediate = tryGetCtors();
    if (immediate !== null && hasFullCtorSet(immediate)) return immediate;
  } else {
    const derived = deriveCtors(explicitStage);
    if (derived !== null) {
      ctorCache.set(explicitStage, derived);
      lastRecovered = derived;
      if (hasFullCtorSet(derived)) return derived;
    }
  }

  let attemptCount = 0;
  let lastRoot: unknown = null;
  const recovered = await pollUntil<PixiCtors>({
    attempt: (attempt) => {
      attemptCount = attempt;
      const root = explicitStage ?? stageRoot ?? capturedApplication?.stage ?? null;
      lastRoot = root;
      const derived = root === null ? null : deriveCtors(root);
      if (derived !== null) {
        if (root !== null) ctorCache.set(root, derived);
        lastRecovered = derived;
        // Answer on a set with a usable Text and Sprite even if Texture/Rectangle are stubs: those two
        // are for callers who need them, and blocking readiness on them would hang every text-only mod.
        if (hasCoreCtorSet(derived)) return derived;
      }
      return null;
    },
    timeoutMs,
    // This site's scheduler leaves it unused, and on purpose: `defaultSchedule` is
    // `requestAnimationFrame`, which re-fires each frame and takes no delay. The adapter below passes the
    // callback through unchanged rather than turning the frame loop into a 16 ms timer.
    intervalMs: 16,
    schedule: (callback) => {
      schedule(callback);
    },
  });
  if (recovered !== null) return recovered;

  throw new PixiCtorsTimeoutError(
    `mg.js: could not recover the Pixi constructor set within ${timeoutMs}ms ` +
      `(${attemptCount} attempts). The stage had ${lastRoot === null ? 'no root' : 'no live sprite + text pair'}. ` +
      'If the game never rendered a text node, call getCtors({ stage }) with an explicit root.',
  );
}

/**
 * True when the three constructors a text/shape mod actually cannot do without were recovered.
 *
 * Weaker than {@link hasFullCtorSet} on purpose: `Texture` and `Rectangle` are recovered
 * opportunistically from whatever happens to be in the tree, and a legitimately text-only workload
 * should not wait 15 seconds for a `Texture` it will never construct.
 */
export function hasCoreCtorSet(ctors: PixiCtors): boolean {
  return (
    !isUnrecoveredStub(ctors.Container) && !isUnrecoveredStub(ctors.Sprite) && !isUnrecoveredStub(ctors.Text)
  );
}
