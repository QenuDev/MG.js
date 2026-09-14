/**
 * Text labels.
 *
 * ## Why there is a helper at all
 *
 * Creating a Pixi `Text` node by hand is three easy-to-get-wrong steps: recover the constructor (it is
 * not on `window`; see `ctors.ts`), pass a style object whose field names differ between Pixi major
 * versions (`fill` is `fill` in v7+ but was `fill` *and* `fillStyle` in older builds; `fontFamily` vs
 * `font`), and attach the node to a container that is actually in the live stage rather than to a
 * detached one nobody renders.
 *
 * The game's own UI is entirely text-driven, so a mod that wants to show anything usually wants text,
 * and a mod that creates text per frame is the single most common way to leak display objects. Hence:
 * create once, {@link updateText} in place, {@link destroyText} explicitly.
 *
 * ## Where text *cannot* go
 *
 * Rive-driven objects (pets, some decor) are a separate animation runtime composited into the same
 * canvas. §2.8 says they are "not reachable through PixiStage at all", and text on them cannot be
 * injected as a run unless the artboard author defined one. §2.8's guidance is to "attach a Pixi Text
 * node to the container hosting its canvas/texture instead". {@link createTextOver} exists for that
 * shape: given any display object, find its parent container and put a text node above it.
 *
 * ## The style defaults are measured, not decorative
 *
 * The game renders at device pixel ratio and its own UI text is small and tightly kerned. The defaults
 * here match the game's body text so a mod's label does not look obviously foreign, but they are
 * explicitly overridable, because the honest position is that these are our choices, not the game's
 * documented values.
 */

import type { PixiDisplayObject, PixiText, PixiTextStyle } from './ctors.js';
import { PixiStage } from './pixi.js';

/**
 * Style fields we set by default.
 *
 * `resolution` is not part of the style object in every Pixi version, so it is applied separately in
 * {@link createText}. `fill` is `0xffffff` (a number) rather than a CSS string: Pixi
 * accepts both, but a number avoids a string parse per text node and is what the game's own styles use.
 */
export const DEFAULT_TEXT_STYLE: PixiTextStyle = {
  fontFamily: 'Arial, Helvetica, sans-serif',
  fontSize: 14,
  fontWeight: '600',
  fill: 0xffffff,
  align: 'center',
  stroke: 0x000000,
  strokeThickness: 3,
};

/** Options for {@link createText}. */
export interface CreateTextOptions {
  /** The text to display. */
  text: string;
  /** Style overrides, merged over {@link DEFAULT_TEXT_STYLE}. */
  style?: PixiTextStyle;
  /** Position within the parent. Default 0,0. */
  x?: number;
  y?: number;
  /** Draw order within the parent. Default 0. */
  zIndex?: number;
  /** Anchor as a fraction, e.g. `{ x: 0.5, y: 0.5 }` to centre. Applied only if the node has an anchor. */
  anchor?: { x: number; y: number };
  /**
   * Device-pixel-ratio multiplier for glyph rasterisation.
   *
   * Left unset by default: Pixi resolves the renderer's resolution itself, and forcing it is only worth
   * doing for text that will be scaled up. Setting it wrong makes text *blurrier*, not sharper.
   */
  resolution?: number;
  /** The label to give the node, so {@link PixiStage.findByLabel} can find it again. */
  label?: string;
}

/**
 * True when a value looks like a live Pixi Text node.
 *
 * Re-exported from nowhere. This is a local, cheap check for {@link updateText}'s defensive path. The
 * authoritative duck-typing lives in `ctors.ts` (`isTextLike`); this one only asks "does it have the
 * two members I am about to write".
 */
function isTextShaped(node: unknown): node is PixiText {
  if (node === null || typeof node !== 'object') return false;
  const record = node as Record<string, unknown>;
  return 'text' in record && 'style' in record;
}

/**
 * Create a text node.
 *
 * @throws {PixiCtorsTimeoutError} when the constructor set cannot be recovered.
 * @throws {Error} when the recovered `Text` constructor was a stub (see `ctors.ts`'s `nullConstructor`).
 */
export async function createText(options: CreateTextOptions): Promise<PixiText> {
  const ctors = await PixiStage.getCtors();
  return createTextSync(ctors.Text, options);
}

/**
 * The synchronous half of {@link createText}, for a caller that has already awaited `getCtors()`.
 *
 * Separated because the useful pattern is to await once at startup and then create labels synchronously
 * in response to game events, which keeps `await` out of hot paths and
 * out of code that must run inside a single frame.
 */
export function createTextSync(
  TextCtor: new (...args: unknown[]) => PixiText,
  options: CreateTextOptions,
): PixiText {
  const style: PixiTextStyle = { ...DEFAULT_TEXT_STYLE, ...(options.style ?? {}) };
  const node = new TextCtor(options.text, style);

  if (options.x !== undefined) node.x = options.x;
  if (options.y !== undefined) node.y = options.y;
  if (options.zIndex !== undefined) node.zIndex = options.zIndex;
  if (options.label !== undefined) node.label = options.label;
  if (options.resolution !== undefined) node.resolution = options.resolution;

  if (options.anchor !== undefined) applyAnchor(node, options.anchor);
  return node;
}

/**
 * Set an anchor, tolerating both Pixi shapes.
 *
 * v7's `Text.anchor` is an `ObservablePoint` with a `set(x, y)` method; some builds expose a bare
 * `{ x, y }`. Writing through `set` when it exists is what keeps Pixi's internal bounds cache in sync.
 * Assigning `.x` directly on an `ObservablePoint` also works, but only because it is a proxy, and that
 * is a version detail we should not depend on.
 */
function applyAnchor(node: PixiText, anchor: { x: number; y: number }): void {
  const current = node.anchor;
  if (current === undefined || current === null) return;
  if (typeof current.set === 'function') {
    current.set(anchor.x, anchor.y);
    return;
  }
  current.x = anchor.x;
  current.y = anchor.y;
}

/**
 * Change a text node's content in place.
 *
 * This is the cheap path and the one to prefer. Assigning `.text` is a string compare plus a
 * re-rasterise, and the re-rasterise happens *only when the string actually changed*, because Pixi
 * short-circuits an identical assignment.
 * Destroying and recreating the node, by contrast, reallocates a canvas-backed texture every time and leaks
 * the old one if the destroy is missed.
 *
 * @returns `true` when something was written. Never throws on a malformed node; a helper that throws
 *   inside the game's render loop would take the frame down with it.
 */
export function updateText(node: PixiText | null | undefined, text: string, style?: PixiTextStyle): boolean {
  if (!isTextShaped(node)) return false;
  try {
    if (node.text !== text) node.text = text;
    if (style !== undefined) {
      // Assigning a whole new style object is the documented Pixi way to restyle; mutating the existing
      // object in place does NOT invalidate Pixi's measured bounds on every build.
      node.style = { ...node.style, ...style };
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Destroy a text node and detach it from its parent.
 *
 * Order matters: remove from the parent *first*. Destroying a node that is still in a display list
 * leaves the parent holding a destroyed child, and the game's next render of that container will touch
 * freed internals. `destroy` options are left at defaults (`children: false`, `texture: true`) so the
 * node's own texture is released. A Text node owns its texture, unlike a Sprite which may share one.
 */
export function destroyText(node: PixiText | null | undefined): boolean {
  if (node === null || node === undefined || typeof node !== 'object') return false;
  try {
    detach(node);
    if (typeof node.destroy === 'function') node.destroy();
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a node from its parent using whichever removal method the build has.
 *
 * `removeChild` *throws* in Pixi when the child is not present, the situation a
 * double-teardown produces, so it is attempted last and its failure ignored. `removeChildren` with an
 * explicit list is the safe form where available.
 */
export function detach(node: PixiDisplayObject): void {
  const parent = node.parent;
  if (parent === null || parent === undefined) return;
  if (typeof parent.removeChildren === 'function') {
    try {
      parent.removeChildren(node);
      return;
    } catch {
      // Fall through to removeChild.
    }
  }
  if (typeof parent.removeChild === 'function') {
    try {
      parent.removeChild(node);
    } catch {
      // Already detached, or the parent is mid-destroy. Nothing useful to do.
    }
  }
}

/**
 * Create a text node positioned over an existing display object.
 *
 * The documented way to put arbitrary text on a Rive-driven object (§2.8): "attach a Pixi Text node to
 * the container hosting its canvas/texture instead". The node is added to the target's *parent* rather
 * than to the target itself, because a Rive host is frequently not a container and adding a child to it
 * is either a silent no-op or a throw.
 *
 * @returns the text node, or `null` when the target has no parent to attach to.
 */
export function createTextOver(
  TextCtor: new (...args: unknown[]) => PixiText,
  target: PixiDisplayObject,
  options: CreateTextOptions,
): PixiText | null {
  const parent = target.parent;
  if (parent === null || parent === undefined || typeof parent.addChild !== 'function') return null;

  const node = createTextSync(TextCtor, options);
  // Sit above the target within the same parent. `zIndex` only sorts when the parent has
  // `sortableChildren` enabled, so this is a best-effort ordering hint, not a guarantee.
  node.zIndex = options.zIndex ?? (target.zIndex ?? 0) + 1;
  try {
    parent.addChild(node);
  } catch {
    return null;
  }
  return node;
}
