/**
 * Rive artboards.
 *
 * ## What Rive is, and why it is not Pixi
 *
 * Pets and some decor in Magic Garden are Rive animations: a separate runtime with its own artboards
 * and state machines, "composited into the same canvas but not reachable through `PixiStage` at all"
 * (§2.8, and §15 of the protocol docs). A Rive host is not a display object, is not in the Pixi
 * display tree, and has no `children`. Duck-typing one as a Pixi node is the exact mistake the docs
 * warn about for text detection, "their constructor throws on Pixi-shaped arguments". That is why
 * `ctors.ts`'s `isRiveLike` rejects anything exposing `rive`/`artboard`/`stateMachine` before it
 * considers a node as `Text`.
 *
 * ## The text rule, stated plainly
 *
 * §2.8 `setTextRunValue`:
 *
 * > "Sets a named text run baked into the artboard. Throws if the artboard defines no run by that name,
 * > not every pet/decor asset has one, so treat a throw as 'unsupported', not a bug. There is no way
 * > to add a brand-new text run to an artboard that never defined one; for arbitrary new text over a
 * > Rive-animated object, attach a Pixi Text node to the container hosting its canvas/texture instead."
 *
 * So this module offers two different things and never blurs them:
 *
 *   - {@link RiveArtboard.setTextRunValue}: **set** the value of a run the *artist* defined. Wraps the
 *     documented throw into `false`, because "unsupported" is a normal outcome rather than an error.
 *   - {@link RiveArtboard.addOverlayText}: **inject** arbitrary new text by attaching a Pixi `Text`
 *     node over the container that hosts the artboard's canvas/texture. This is the documented
 *     approach and it is implemented here rather than recommended, because it is the only way to get a
 *     label onto a pet whose asset has no runs.
 *
 * The distinction matters because the two have completely different capabilities: a run can be
 * *animated* by the artboard (it can move with the pet, be clipped by the artboard's own masking, and
 * participate in its layout), while an overlay text node is a flat sibling that knows nothing about the
 * artboard's animation. A mod that wants "the pet's name, following the pet" needs a run; a mod that
 * wants "a floating number above the pet" should use the overlay and accept that it will not deform
 * with the pet.
 *
 * ## Gap G35: there is no documented way to *obtain* a live artboard
 *
 * The API reference calls `RiveArtboard` "TypeScript shape of a live Rive artboard instance" and gives
 * no factory, no lookup helper, and no field pointing at one. Nor does it document Rive's instantiation
 * entry point. §15's own advice is to "hook Rive's own instantiation entry point once, record every
 * instance that gets created, and look it up later by whichever asset name / tag you attached to it at
 * capture time", which presumes a hook point the docs never name.
 *
 * {@link RiveRegistry} is that recording facility, and it makes no claim about how
 * instances arrive: a caller who has found Rive's entry point registers what it produces, and a caller
 * who has not can still register an artboard it obtained some other way. Inventing an entry-point name
 * would be fabrication; providing the registry and saying so is not.
 *
 * ## Error contract
 *
 * Gap G36: "RiveArtboard methods can throw with no error contract... No error class, code, or type is
 * documented." Every method here therefore returns a boolean instead of throwing, and reports the
 * failure through an optional hook rather than an exception. Rive calls happen from inside the game's
 * animation tick, and §14's warning about exceptions escaping into the game's own rebuild applies
 * doubly here.
 */

import { isRiveLike, type PixiDisplayObject, type PixiText } from './ctors.js';
import { destroyText, detach } from './text.js';
import { createWarnOnce } from './warn-once.js';

/**
 * The Rive artboard surface.
 *
 * Structural and minimal: the four methods §2.8 documents, all optional because a build may expose a
 * different subset (the class is a *shape*, and §2.8 gives it no properties at all). Anything else the
 * artboard carries is reachable through the index signature without this interface having to claim it.
 */
export interface RiveArtboardLike {
  /** §2.8 `setTextRunValue`. Throws when the artboard defines no run by that name. */
  setTextRunValue?: (name: string, value: string) => void;
  /** §2.8 `setBooleanInput`. */
  setBooleanInput?: (name: string, value: boolean) => void;
  /** §2.8 `setNumberInput`. */
  setNumberInput?: (name: string, value: number) => void;
  /** §2.8 `fireTrigger`. */
  fireTrigger?: (name: string) => void;
  [key: string]: unknown;
}

/** A failure report, passed to a caller's `onError` when one is supplied. */
export interface RiveFailure {
  /** Which operation failed, e.g. `'setTextRunValue'`. */
  operation: string;
  /** The name argument, when the operation took one. */
  name?: string;
  /** The thrown value, verbatim. */
  error: unknown;
  /**
   * Whether this is the documented "unsupported" case rather than a genuine fault.
   *
   * §2.8 says a throw from `setTextRunValue` means the artboard has no run by that name, which is
   * normal. This flag is set when the throw looks like that case (the message mentions the run name or
   * the word "run"); otherwise it is a real fault worth surfacing.
   */
  unsupported: boolean;
}

/** Options every artboard wrapper takes. */
export interface RiveArtboardOptions {
  /**
   * The Pixi container that hosts this artboard's canvas/texture.
   *
   * Required for {@link RiveArtboard.addOverlayText} and unavailable otherwise; gap G35 means there is
   * no way to derive it from the artboard. Omit it and overlay text is simply refused.
   */
  hostContainer?: PixiDisplayObject | null;
  /** An asset name or tag, used to find this artboard later via {@link RiveRegistry.find}. */
  tag?: string;
  /** Notified on every failure. The default is a warn-once `console.warn`. */
  onError?: (failure: RiveFailure) => void;
}

/**
 * A live Rive artboard, wrapped.
 *
 * Not a subclass and not a proxy: it holds the artboard and forwards. A proxy would be tempting,
 * because it would let callers reach undocumented members transparently, but a proxy over a hot-path
 * object adds a trap on every property access in the game's animation tick, and the benefit (access to
 * members we cannot name) is the thing we should not be encouraging.
 */
export class RiveArtboard {
  /** The underlying instance. Exposed so a caller can reach members this wrapper does not model. */
  readonly artboard: RiveArtboardLike;
  /** The asset name or tag, when registered. */
  readonly tag: string | null;
  private readonly host: PixiDisplayObject | null;
  private readonly onError: (failure: RiveFailure) => void;
  private readonly overlays = new Set<PixiText>();

  constructor(artboard: RiveArtboardLike, options: RiveArtboardOptions = {}) {
    this.artboard = artboard;
    this.tag = options.tag ?? null;
    this.host = options.hostContainer ?? null;
    this.onError = options.onError ?? defaultRiveErrorHandler;
  }

  /** The container overlay text is attached to, or `null` when none was supplied. */
  get hostContainer(): PixiDisplayObject | null {
    return this.host;
  }

  /** True when this build's artboard exposes `setTextRunValue` at all. */
  get supportsTextRuns(): boolean {
    return typeof this.artboard.setTextRunValue === 'function';
  }

  /** True when this build's artboard exposes a state-machine input surface. */
  get supportsInputs(): boolean {
    return (
      typeof this.artboard.setBooleanInput === 'function' ||
      typeof this.artboard.setNumberInput === 'function' ||
      typeof this.artboard.fireTrigger === 'function'
    );
  }

  /**
   * Set a baked text run's value.
   *
   * §2.8: "Throws if the artboard defines no run by that name, not every pet/decor asset has one, so treat
   * a throw as 'unsupported', not a bug."
   *
   * @returns `true` when the value was written; `false` when the run is absent, the method is absent, or
   *   the call threw. A caller rendering a label should fall back to {@link addOverlayText} on `false`.
   */
  setTextRunValue(name: string, value: string): boolean {
    const fn = this.artboard.setTextRunValue;
    if (typeof fn !== 'function') {
      this.report({ operation: 'setTextRunValue', name, error: null, unsupported: true });
      return false;
    }
    try {
      fn.call(this.artboard, name, value);
      return true;
    } catch (error) {
      this.report({
        operation: 'setTextRunValue',
        name,
        error,
        unsupported: looksLikeMissingRun(error, name),
      });
      return false;
    }
  }

  /** Set a named boolean input on the state machine. `false` when the input or method is absent. */
  setBooleanInput(name: string, value: boolean): boolean {
    return this.callInput('setBooleanInput', name, value);
  }

  /** Set a named number input on the state machine. `false` when the input or method is absent. */
  setNumberInput(name: string, value: number): boolean {
    return this.callInput('setNumberInput', name, value);
  }

  /**
   * Fire a named trigger.
   *
   * A trigger is one-shot: the state machine consumes it and it does not need resetting. Firing one the
   * artboard does not define is the same "unsupported" case as a missing run.
   */
  fireTrigger(name: string): boolean {
    const fn = this.artboard.fireTrigger;
    if (typeof fn !== 'function') {
      this.report({ operation: 'fireTrigger', name, error: null, unsupported: true });
      return false;
    }
    try {
      fn.call(this.artboard, name);
      return true;
    } catch (error) {
      this.report({
        operation: 'fireTrigger',
        name,
        error,
        unsupported: looksLikeMissingRun(error, name),
      });
      return false;
    }
  }

  /**
   * Attach a Pixi `Text` node over this artboard's host container.
   *
   * The documented approach for arbitrary new text (§2.8, §15): "find the Pixi container that hosts the
   * Rive canvas/texture and attach a `Text` node to that, positioned over it". Note the node is added to
   * the *host container*, not to the artboard: Rive has "no equivalent of `addChild`".
   *
   * The node is tracked so {@link destroy} can release it. Overlay text is owned by this wrapper
   * because nobody else has a reference to it.
   *
   * @param create a factory returning the already-configured Text node. A factory rather than a style
   *   bag so the caller keeps control of the style and the node type, and so this module does not need
   *   the constructor set.
   * @returns the attached node, or `null` when there is no host container or `addChild` refused it.
   */
  addOverlayText(
    create: (host: PixiDisplayObject) => PixiText | null,
    options: { x?: number; y?: number; zIndex?: number } = {},
  ): PixiText | null {
    const host = this.host;
    if (host === null) {
      this.report({
        operation: 'addOverlayText',
        error: new Error('no hostContainer was supplied for this artboard'),
        unsupported: true,
      });
      return null;
    }
    if (typeof host.addChild !== 'function') {
      this.report({
        operation: 'addOverlayText',
        error: new Error('host container has no addChild'),
        unsupported: true,
      });
      return null;
    }

    let node: PixiText | null = null;
    try {
      node = create(host);
    } catch (error) {
      this.report({ operation: 'addOverlayText', error, unsupported: false });
      return null;
    }
    if (node === null) return null;

    if (options.x !== undefined) node.x = options.x;
    if (options.y !== undefined) node.y = options.y;
    // A high zIndex only sorts when the parent has `sortableChildren`; §18 says a raw positive zIndex
    // "does not reliably beat the avatar's own sorting". It is a hint, not a guarantee, and the caller
    // that needs a guarantee should use a `RenderLayer` (see `world-scene.ts`).
    node.zIndex = options.zIndex ?? 1_000_000;

    try {
      host.addChild(node);
    } catch (error) {
      this.report({ operation: 'addOverlayText', error, unsupported: false });
      return null;
    }
    this.overlays.add(node);
    return node;
  }

  /**
   * Update every overlay node's text.
   *
   * The cheap path, called at whatever rate the caller wants: assigning `.text` is a string compare and
   * a re-rasterise only on an actual change, whereas recreating the node would reallocate a texture.
   */
  updateOverlayText(value: string): number {
    let updated = 0;
    for (const node of this.overlays) {
      try {
        if (node.text !== value) {
          node.text = value;
          updated += 1;
        }
      } catch {
        // A node mid-destroy. Skipping it is the right answer.
      }
    }
    return updated;
  }

  /** Remove and destroy every overlay node this wrapper created. */
  destroyOverlays(): number {
    let destroyed = 0;
    for (const node of this.overlays) {
      if (destroyText(node)) destroyed += 1;
    }
    this.overlays.clear();
    return destroyed;
  }

  /**
   * Detach the first overlay node, for a caller that wants to remove one specifically.
   *
   * Kept separate from {@link destroyOverlays} so the common case, one badge that comes and goes while
   * others stay, does not have to destroy and rebuild everything.
   */
  removeOverlayText(node: PixiText): boolean {
    if (!this.overlays.has(node)) return false;
    this.overlays.delete(node);
    try {
      detach(node);
      return true;
    } catch {
      return false;
    }
  }

  /** Release every overlay this wrapper owns. The artboard itself is the game's and is never touched. */
  destroy(): void {
    this.destroyOverlays();
  }

  private callInput(operation: 'setBooleanInput' | 'setNumberInput', name: string, value: unknown): boolean {
    const fn = this.artboard[operation];
    if (typeof fn !== 'function') {
      this.report({ operation, name, error: null, unsupported: true });
      return false;
    }
    try {
      (fn as (n: string, v: unknown) => void).call(this.artboard, name, value);
      return true;
    } catch (error) {
      this.report({
        operation,
        name,
        error,
        unsupported: looksLikeMissingRun(error, name),
      });
      return false;
    }
  }

  private report(failure: RiveFailure): void {
    try {
      this.onError(failure);
    } catch {
      // An error reporter that throws is worse than no reporter.
    }
  }
}

/**
 * Wrap an artboard.
 *
 * @throws {TypeError} when `artboard` is not an object. This is the one case worth throwing: passing a
 *   Pixi node here is a *caller* bug (the exact misidentification `ctors.ts` guards against), and a
 *   silent no-op wrapper would hide it until the mod's feature mysteriously did nothing.
 */
export function wrapArtboard(artboard: unknown, options: RiveArtboardOptions = {}): RiveArtboard {
  if (artboard === null || (typeof artboard !== 'object' && typeof artboard !== 'function')) {
    throw new TypeError(
      'mg.js: wrapArtboard expected a Rive artboard object. A Pixi node is not a Rive artboard, ' +
        'because Rive instances are not in the Pixi display tree (see recon-quinoa-api-reference.md §2.8).',
    );
  }
  return new RiveArtboard(artboard as RiveArtboardLike, options);
}

/** True when a value looks like a Rive artboard rather than a Pixi node. */
export function isArtboardLike(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record['setTextRunValue'] === 'function' ||
    typeof record['setBooleanInput'] === 'function' ||
    typeof record['fireTrigger'] === 'function'
  ) {
    return true;
  }
  // Structural signal as a fallback: `ctors.ts`'s one Rive-host predicate, so this cannot disagree
  // with `world.ts`'s pet search about which node is a Rive host. This used to restate two of its
  // three keys and omit `artboard`, which rejected a genuine artboard-only node.
  return isRiveLike(record);
}

/**
 * Does this thrown value mean "the artboard has no such run/input"?
 *
 * §2.8 says a throw from `setTextRunValue` is the "unsupported" signal, but gives no error class or code
 * (gap G36). So the check is on the message, and the check is *narrow*: it looks for the name we
 * passed, or the words "run"/"input"/"state machine". Anything else is treated as a genuine fault,
 * because misclassifying a real bug as "unsupported" is how a mod ends up silently doing nothing.
 */
function looksLikeMissingRun(error: unknown, name: string): boolean {
  if (error === null || error === undefined) return true;
  const message = typeof error === 'string' ? error : (error as { message?: unknown }).message;
  if (typeof message !== 'string') return false;
  const lower = message.toLowerCase();
  if (message.includes(name)) return true;
  return (
    lower.includes('no text run') ||
    (lower.includes('not found') && (lower.includes('run') || lower.includes('input'))) ||
    lower.includes('no input') ||
    lower.includes('state machine')
  );
}

/**
 * The default failure handler: warn once per (operation, name) pair.
 *
 * Warn-once because a pet's artboard re-ticks every frame; a warn per frame would flood the console and
 * bury the first occurrence, which is the only informative one. The implementation is `warn-once.ts`'s;
 * the memo is this module's.
 *
 * The `unsupported` early return stays here rather than moving into the shared helper: it is a "do not
 * log this class of outcome at all" rule, not a warn-once rule.
 */
const warn = createWarnOnce();
function defaultRiveErrorHandler(failure: RiveFailure): void {
  // "Unsupported" is a documented, expected outcome: every pet asset without a text run produces one.
  // Logging those would train a user to ignore the console.
  if (failure.unsupported) return;
  warn(`${failure.operation}:${failure.name ?? ''}`, `Rive ${failure.operation} failed`, failure.error);
}

/** Clear the warn-once memo. Exported for tests. */
export function resetRiveWarnings(): void {
  warn.reset();
}

/**
 * A registry of live artboards.
 *
 * The facility §15 presumes exists and the API reference does not provide (gap G35). The registry is
 * passive by design: it records artboards that somebody else found, and it does not attempt to hook Rive's
 * instantiation entry point, because the docs never name one and a guessed global would be fabrication.
 *
 * Two lookup keys are supported and they are different things:
 *   - `tag`: whatever the *registrar* chose to call it, which is the only stable handle available
 *     (there is no asset-name property on the documented shape).
 *   - `host`: the Pixi container the artboard draws into, which is the key a caller with a display
 *     object in hand actually has.
 */
export class RiveRegistry {
  private readonly byTag = new Map<string, RiveArtboard>();
  private readonly byHost = new WeakMap<object, RiveArtboard>();

  /** Register an artboard. Re-registering the same tag replaces the previous entry. */
  register(wrapper: RiveArtboard, host?: PixiDisplayObject | null): void {
    if (wrapper.tag !== null) this.byTag.set(wrapper.tag, wrapper);
    const effectiveHost = host ?? wrapper.hostContainer;
    if (effectiveHost !== null && typeof effectiveHost === 'object') {
      this.byHost.set(effectiveHost, wrapper);
    }
  }

  /** Look up by tag. */
  find(tag: string): RiveArtboard | null {
    return this.byTag.get(tag) ?? null;
  }

  /** Look up by the Pixi container the artboard draws into. */
  findByHost(host: PixiDisplayObject): RiveArtboard | null {
    return this.byHost.get(host) ?? null;
  }

  /** Every tag currently registered. */
  tags(): string[] {
    return [...this.byTag.keys()];
  }

  /** Forget a wrapper. Does not destroy it; ownership of the artboard is the game's. */
  unregister(wrapper: RiveArtboard): boolean {
    let removed = false;
    if (wrapper.tag !== null && this.byTag.get(wrapper.tag) === wrapper) {
      this.byTag.delete(wrapper.tag);
      removed = true;
    }
    const host = wrapper.hostContainer;
    if (host !== null && this.byHost.get(host) === wrapper) {
      this.byHost.delete(host);
      removed = true;
    }
    return removed;
  }

  /** Forget everything. Overlay nodes are NOT destroyed; call `destroy()` on each wrapper first. */
  clear(): void {
    this.byTag.clear();
  }
}

/** The package-wide artboard registry. */
export const sharedArtboards = new RiveRegistry();
