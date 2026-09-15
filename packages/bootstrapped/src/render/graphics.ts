/**
 * Rounded badges and custom shapes.
 *
 * ## The one rule, and the measurement behind it
 *
 * The protocol docs are unusually direct about this (§16, "Drawing shapes & badges"):
 *
 * > "`clear()` then redraw is the correct update pattern. `Graphics` instances are meant to be reused
 * > across frames, not recreated. Recreating one every update leaks nodes and is measurably slower for
 * > anything updating more than a couple of times a second."
 *
 * The cost is two-sided. **Cpu**: a new Graphics allocates a geometry batch; the renderer's batcher
 * re-uploads that batch's attribute buffer on first use, so a badge redrawn at 3 Hz for a minute
 * produces 180 separate GPU buffer uploads instead of one. **Memory**: the old node is only collected
 * if the game's own container releases it, and the game's containers are long-lived UI systems that
 * release children on their own schedule, not ours, so each discarded badge survives at least until
 * the card it was attached to is destroyed, and a container that never destroys children accumulates
 * them for the lifetime of the page. The recon puts the visible threshold at "above a couple of Hz",
 * which is the rate a coin counter or a timer wants to run at.
 *
 * So {@link Badge} creates the Graphics **once** and keeps it, and `update()` is `clear()` + redraw on
 * the same instance forever.
 *
 * ## The second rule: never throw into the game's render loop
 *
 * The recon records the real symptom (§14, text drawing): if a handler attached to the game's own
 * subtree throws, "the exception bubbles up into the game's own rebuild and aborts it partway through".
 * The symptom is that the whole card visibly shifts or renders half-built, not a clean crash. A badge that
 * throws on an unexpected `text.width` therefore does not produce an error message; it produces a
 * visually corrupt inventory card attributed to the game. Every method on {@link Badge} is wrapped, and
 * a failure returns `false` rather than propagating. There is no path from this module into the game's
 * frame that can throw.
 *
 * ## Why a class rather than loose functions
 *
 * A badge is a pair (Graphics + Text) plus a lifetime. Holding the pair together is what makes
 * {@link Badge.destroy} able to release both, and what makes it impossible to redraw one without the
 * other. The class also caches the last-rendered dimensions so a redraw that changes nothing is skipped
 * entirely: the cheapest GPU work is the work not submitted.
 */

import type { PixiDisplayObject, PixiGraphics } from './ctors.js';
import { PixiStage } from './pixi.js';
import { detach } from './text.js';
import { createWarnOnce } from './warn-once.js';

/** A colour as Pixi accepts it: a hex number, or a CSS string. */
export type BadgeColour = number | string;

/** Style for a {@link Badge}. */
export interface BadgeStyle {
  /** Fill colour. Default `0x000000`. */
  fill?: BadgeColour;
  /** Fill alpha 0-1. Default `0.55`: readable text over it, card still visible behind. */
  fillAlpha?: number;
  /** Border colour. Omit for no border. */
  stroke?: BadgeColour;
  /** Border width in pixels when {@link BadgeStyle.stroke} is set. */
  strokeWidth?: number;
  /** Corner radius. Default 6, matching the game's own rounded chips. */
  radius?: number;
  /** Horizontal padding added around the measured content. Default 8. */
  paddingX?: number;
  /** Vertical padding added around the measured content. Default 4. */
  paddingY?: number;
}

/** Resolved style with every field present. */
interface ResolvedBadgeStyle extends Required<Omit<BadgeStyle, 'stroke'>> {
  stroke: BadgeColour | null;
}

const DEFAULT_BADGE_STYLE: ResolvedBadgeStyle = {
  fill: 0x000000,
  fillAlpha: 0.55,
  stroke: null,
  strokeWidth: 1,
  radius: 6,
  paddingX: 8,
  paddingY: 4,
};

/** Options for {@link createBadge}. */
export interface CreateBadgeOptions {
  /** The container the badge is added to. Must be in the live stage or nothing renders. */
  parent: PixiDisplayObject;
  /** The Text node whose measured bounds the badge wraps. */
  text: PixiDisplayObject;
  style?: BadgeStyle;
  /** Draw order within the parent. The badge should sit *behind* its text. */
  zIndex?: number;
}

/**
 * A reusable rounded badge.
 *
 * Lifecycle: {@link createBadge} once, {@link Badge.update} on every change, {@link Badge.destroy} when
 * the thing it annotates goes away. The class is not disposable-by-GC by design: a Pixi node is not
 * freed by dropping the reference, so `destroy()` is the only correct release.
 */
export class Badge {
  /** The Graphics node. Public so a caller can add extra shapes to the same node if it wants. */
  readonly graphics: PixiGraphics;
  /** The text node this badge wraps, kept so `update()` can re-measure without a lookup. */
  readonly text: PixiDisplayObject;
  private readonly style: ResolvedBadgeStyle;
  private lastWidth = -1;
  private lastHeight = -1;
  private destroyed = false;

  /** @internal Use {@link createBadge}. */
  constructor(graphics: PixiGraphics, text: PixiDisplayObject, style: ResolvedBadgeStyle) {
    this.graphics = graphics;
    this.text = text;
    this.style = style;
  }

  /** True once {@link destroy} has run. All later calls are no-ops. */
  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /**
   * Redraw the badge around whatever the text node currently measures.
   *
   * Re-reads `text.width` / `text.height` every call rather than caching them: a text node's measured
   * size changes the moment its string or style changes, and Pixi's `Text` recomputes those lazily on
   * access, so reading them *after* the text assignment is both correct and free.
   *
   * Skips the redraw when the measured size is unchanged AND `force` is false. That is safe because the
   * shape is a pure function of the size: nothing else about the badge can change without also going
   * through this method.
   *
   * @returns `true` when the badge was (re)drawn, `false` when it was skipped or the redraw failed.
   */
  update(force = false): boolean {
    if (this.destroyed) return false;
    try {
      const width = readNumber(this.text, 'width');
      const height = readNumber(this.text, 'height');
      if (width === null || height === null) return false;
      if (!force && width === this.lastWidth && height === this.lastHeight) return false;

      const { paddingX, paddingY, radius } = this.style;
      const boxWidth = width + paddingX * 2;
      const boxHeight = height + paddingY * 2;

      // The documented update pattern: clear, then redraw on the SAME instance. `clear()` resets the
      // geometry context and, critically, does not reset the transform or detach the node, so the
      // badge keeps its parent, its zIndex and its event wiring across every redraw.
      this.graphics.clear();
      this.graphics.roundRect(-paddingX, -paddingY, boxWidth, boxHeight, radius);
      this.graphics.fill({ color: this.style.fill, alpha: this.style.fillAlpha });
      if (this.style.stroke !== null) {
        this.graphics.stroke({ color: this.style.stroke, width: this.style.strokeWidth });
      }

      this.lastWidth = width;
      this.lastHeight = height;
      return true;
    } catch (error) {
      // The guard the recon demands: this method is called from inside the game's own render/update
      // path, and a throw here corrupts the game's UI rebuild rather than reporting a mod error.
      warnOnce('badge redraw failed', error);
      return false;
    }
  }

  /** Show or hide the badge and its text together: a badge behind hidden text is a floating black box. */
  setVisible(visible: boolean): void {
    if (this.destroyed) return;
    try {
      this.graphics.visible = visible;
      this.text.visible = visible;
    } catch {
      // Visibility is cosmetic; failing to set it must not throw into a caller's frame.
    }
  }

  /**
   * Release the Graphics node.
   *
   * Only the Graphics. The wrapped Text node is *not* destroyed here even though the badge "owns" the
   * pair conceptually, because a caller almost always wants the label to outlive the badge (or to be owned by
   * a card), and a helper that destroys something it did not create is how double-destroy bugs start.
   * Destroy the text separately with `destroyText`.
   *
   * @param options.children forwarded to Pixi's `destroy`, so a Graphics carrying extra shapes can be
   *   released in one call.
   */
  destroy(options: { children?: boolean } = {}): boolean {
    if (this.destroyed) return false;
    this.destroyed = true;
    try {
      detach(this.graphics);
      this.graphics.destroy?.(options);
      return true;
    } catch (error) {
      warnOnce('badge destroy failed', error);
      return false;
    }
  }
}

/**
 * Create a badge behind a text node.
 *
 * The Graphics is created **once** here and reused for the badge's whole lifetime. It is added to the
 * parent *before* being positioned: Pixi's `addChild` is what installs the node into the render tree,
 * and a Graphics that is never added draws nothing regardless of its geometry.
 *
 * @throws {PixiCtorsTimeoutError} when the Graphics constructor cannot be recovered. See
 *   `ctors.ts`'s `getGraphicsCtor`, which needs a node already exposing the public `roundRect`/`clear`
 *   API. That is usually the game's own UI, so this resolves a moment after the first card is drawn.
 */
export async function createBadge(options: CreateBadgeOptions): Promise<Badge> {
  const ctor = PixiStage.getGraphicsCtor(PixiStage.stage);
  if (ctor === null) {
    throw new Error(
      'mg.js: no Graphics constructor is reachable yet. The game has not drawn a node exposing the ' +
        'public roundRect()/clear() API. Wait for a UI frame (or an init-hook fire) and retry.',
    );
  }
  return createBadgeSync(ctor, options);
}

/** The synchronous half of {@link createBadge}, for a caller that already recovered the constructor. */
export function createBadgeSync(
  GraphicsCtor: new (...args: unknown[]) => PixiGraphics,
  options: CreateBadgeOptions,
): Badge {
  const style: ResolvedBadgeStyle = {
    fill: options.style?.fill ?? DEFAULT_BADGE_STYLE.fill,
    fillAlpha: options.style?.fillAlpha ?? DEFAULT_BADGE_STYLE.fillAlpha,
    stroke: options.style?.stroke ?? DEFAULT_BADGE_STYLE.stroke,
    strokeWidth: options.style?.strokeWidth ?? DEFAULT_BADGE_STYLE.strokeWidth,
    radius: options.style?.radius ?? DEFAULT_BADGE_STYLE.radius,
    paddingX: options.style?.paddingX ?? DEFAULT_BADGE_STYLE.paddingX,
    paddingY: options.style?.paddingY ?? DEFAULT_BADGE_STYLE.paddingY,
  };

  const graphics = new GraphicsCtor();
  if (options.zIndex !== undefined) graphics.zIndex = options.zIndex;

  // Add before drawing: some Pixi versions defer geometry upload until the node is in a rendered tree,
  // and adding afterwards works but forces an extra bounds invalidation.
  const parent = options.parent;
  if (typeof parent.addChild === 'function') {
    try {
      parent.addChild(graphics);
    } catch {
      // A parent that rejects the child (wrong node type) still lets us return a usable badge; the
      // caller can attach it itself.
    }
  }

  const badge = new Badge(graphics, options.text, style);
  badge.update(true);
  return badge;
}

/** Read a numeric member, or `null` when it is absent or not finite. */
function readNumber(node: PixiDisplayObject, key: 'width' | 'height'): number | null {
  const value = node[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

/**
 * Warn at most once per message.
 *
 * The failure paths here run at frame rate. A `console.warn` per frame is its own performance problem,
 * and it also floods the console past the point where the user can see the *first* occurrence, which is
 * the only one that matters. So: first occurrence logs, the rest are silent.
 *
 * The implementation is `warn-once.ts`'s; the memo is this module's, so `resetWarnOnce()` cannot silence
 * a warning reported by another module.
 */
const warn = createWarnOnce();
function warnOnce(message: string, error: unknown): void {
  warn(message, message, error);
}

/** Clear the warn-once memo. Exported for tests, which must not be silenced by a previous case. */
export function resetWarnOnce(): void {
  warn.reset();
}
