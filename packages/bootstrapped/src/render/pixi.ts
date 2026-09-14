/**
 * Renderer discovery: the init-hook wrapper.
 *
 * ## The two hooks, and why they are the only way in
 *
 * The game's bundled Pixi build never publishes `window.PIXI` or `window.__PIXI_APP__`. What it *does*
 * expose are two public callback slots, written verbatim in the recon (recon
 * `recon-quinoa-api-reference.md` §2.7, `PixiStage.capture`):
 *
 *   - `window.__PIXI_APP_INIT__(app)`: fired when an `Application` is constructed;
 *   - `window.__PIXI_RENDERER_INIT__(renderer)`: fired when a `Renderer` is created, *including* a
 *     fresh one after WebGL context loss.
 *
 * Their exact semantics are not documented beyond that, and §2.7 warns that "an Application may not
 * always be constructed"; some builds only ever fire the renderer hook. So {@link capture} records
 * *whichever* fires, tolerates both, and never assumes a call order.
 *
 * ## Why we must call through
 *
 * Some builds (and devtools extensions, and other mods) already hold these hooks. Overwriting them
 * would silently break whatever was there. The recon records "calling through to any previous hook
 * (e.g. devtools)" as part of the documented behaviour, and the companion-patterns recon shows the
 * existing mod doing the same. Every wrapper here invokes the previous function first and only then
 * records the value, so a hook that throws cannot stop us from capturing.
 *
 * ## Why this re-fires
 *
 * §2.7: "Re-fires on renderer recreation, which happens after a WebGL context loss from being
 * backgrounded." This is the single most underestimated fact about living in this renderer: when the
 * browser reclaims the GPU context of a backgrounded tab, Pixi does not resume: it builds a *new*
 * renderer and a *new* stage, and every display object the old stage held is gone. A mod that cached a
 * container, a texture, or the constructor set across that boundary is now holding a dead object whose
 * methods may throw or silently no-op. {@link capture}'s callback is therefore the signal to rebuild,
 * and {@link resetCtorCache} is what the callback should call first (`ctors.ts` documents the cache).
 *
 * ## Realm discipline
 *
 * Nothing here touches `window` directly. The hooks live on `realm.getPage()`, because under
 * Tampermonkey with `@grant unsafeWindow` the sandbox's `window` is not the game's. Installing the
 * hook there would install it where the game never looks.
 *
 * Module load is side-effect free: `capture()` must be called explicitly.
 */

import type { PageRealm } from '../page/realm.js';
import { getPage, requirePage } from '../page/realm.js';
import type {
  GetCtorsOptions,
  PixiApplicationLike,
  PixiCtors,
  PixiDisplayObject,
  PixiGraphics,
  PixiRendererLike,
  RecoveredCtors,
} from './ctors.js';
import {
  DEFAULT_FIND_LIMIT,
  deriveCtors,
  findByLabel as findByLabelImpl,
  findNode as findNodeImpl,
  getApplication,
  getCtors as getCtorsImpl,
  getGraphicsCtor as getGraphicsCtorImpl,
  getRenderer,
  getStageRoot,
  resetCtorCache,
  setApplication,
  setRenderer,
  setStageRoot,
  tryGetCtors,
} from './ctors.js';

// The documented hook names. Named exactly, because they are part of the game's public-ish surface
// (devtools integrations rely on them too) rather than something we invented.
const APP_INIT_HOOK = '__PIXI_APP_INIT__';
const RENDERER_INIT_HOOK = '__PIXI_RENDERER_INIT__';

/** What fired, and with what. */
export interface PixiCaptureEvent {
  /** Which hook fired. */
  hook: 'app' | 'renderer';
  /** The captured value. Typed loosely because a build may pass something other than a class instance. */
  value: unknown;
  /** How many times this hook has fired for this page. Above 1 means a renderer recreation. */
  fireCount: number;
  /** True when this fire replaced a previously captured value, i.e. a recreation, not a first init. */
  wasRecreation: boolean;
}

/** Called after every hook fire, once the capture state has been updated. */
export type PixiCaptureListener = (event: PixiCaptureEvent) => void;

/** Options for {@link PixiStage.capture}. */
export interface PixiCaptureOptions {
  /**
   * Notified on every fire.
   *
   * The intended use is rebuilding anything derived from the stage (overlay containers, cached
   * textures, `WorldScene` layers), because after a context loss those are all dead. `wasRecreation`
   * distinguishes "first init" from "everything you built is gone".
   */
  onEvent?: PixiCaptureListener;
  /** Page realm to install on. Defaults to `realm.getPage()`. Exported for tests. */
  page?: PageRealm | null;
}

/** A capture session's teardown. */
export interface PixiCaptureHandle {
  /** Restores the previous hook functions, but only if ours are still the installed ones. */
  release(): void;
  /** Whether the hooks are still installed by us. */
  readonly active: boolean;
  /** Fire counts, for diagnostics. */
  readonly stats: { app: number; renderer: number; recreations: number };
}

/** Fire counters, module-scoped: they describe the page, not a particular capture session. */
let appFireCount = 0;
let rendererFireCount = 0;
let recreationCount = 0;

/** The currently active capture session, so a second `capture()` is a no-op rather than a double wrap. */
let activeCapture: PixiCaptureHandle | null = null;

/**
 * The previous hook function we displaced.
 *
 * Kept so {@link release} can restore what was there rather than `undefined`, which would erase a
 * devtools hook we merely wrapped.
 */
interface HookSlot {
  readonly name: string;
  /** The function that was on the page when we installed, if any. */
  readonly previous: unknown;
  /** Our wrapper, so release can verify identity before restoring. */
  readonly installed: unknown;
}

function readHook(page: PageRealm, name: string): unknown {
  return page[name];
}

/**
 * Call a displaced hook, defensively.
 *
 * The previous hook may be anything at all: `undefined`, a non-function a previous script left behind,
 * or a function that throws because its own dependencies are gone. None of those may stop the capture,
 * so this never propagates.
 */
function callThrough(previous: unknown, value: unknown): void {
  if (typeof previous !== 'function') return;
  try {
    (previous as (argument: unknown) => unknown)(value);
  } catch {
    // A predecessor's failure is not our failure. Swallowing it is what the wrapper is for.
  }
}

/**
 * Install the init-hook wrappers.
 *
 * Idempotent: a second call while a capture is active returns the existing handle. That matters
 * because two loads of this bundle (userscript plus an importing mod) both call it, and a double wrap
 * would double-count fires and double-fire `onEvent` for one renderer.
 */
export function capture(options: PixiCaptureOptions = {}): PixiCaptureHandle {
  if (activeCapture?.active) return activeCapture;

  const page = options.page ?? getPage();
  if (page === null) {
    // No page: return an inert handle rather than throwing. `capture()` is called from `install()`,
    // and a mod that imports this library in Node should get a no-op, not a crash at import time.
    return inertHandle();
  }

  const slots: HookSlot[] = [];

  const makeWrapper = (
    hookName: string,
    kind: 'app' | 'renderer',
    record: (value: unknown) => void,
  ): ((value: unknown) => void) => {
    const previous = readHook(page, hookName);
    const wrapper = (value: unknown): void => {
      callThrough(previous, value);
      if (kind === 'app') appFireCount += 1;
      else rendererFireCount += 1;

      const fireCount = kind === 'app' ? appFireCount : rendererFireCount;
      const hadCapture = kind === 'app' ? appFireCount > 1 : rendererFireCount > 1;
      if (hadCapture) recreationCount += 1;

      try {
        record(value);
      } catch {
        // Recording must never break the game's own init.
      }

      if (options.onEvent !== undefined) {
        try {
          options.onEvent({ hook: kind, value, fireCount, wasRecreation: hadCapture });
        } catch {
          // A listener's failure is its own.
        }
      }
    };
    slots.push({ name: hookName, previous, installed: wrapper });
    return wrapper;
  };

  const appWrapper = makeWrapper(APP_INIT_HOOK, 'app', (value) => {
    // A recreation invalidates every cached ctor AND the captured root; the new Application owns a new
    // stage. `setApplication` re-points the root from the new app, so clear first.
    if (appFireCount > 1) resetCtorCache();
    setApplication(value);
  });

  const rendererWrapper = makeWrapper(RENDERER_INIT_HOOK, 'renderer', (value) => {
    // Only clear on a genuine recreation. On first fire there is nothing to clear, and clearing would
    // throw away a root the app hook legitimately captured a moment earlier in the same init.
    if (rendererFireCount > 1) resetCtorCache();
    setRenderer(value);
    // The renderer fires first in some builds and the app never fires at all in others, so a renderer
    // is also a usable root source: `renderer.stage` exists on some builds.
    const stage = (value as { stage?: unknown } | null)?.stage;
    if (stage !== undefined && stage !== null && getStageRoot() === null) setStageRoot(stage);
  });

  page[APP_INIT_HOOK] = appWrapper;
  page[RENDERER_INIT_HOOK] = rendererWrapper;

  const handle: PixiCaptureHandle = {
    get active(): boolean {
      return page[APP_INIT_HOOK] === appWrapper || page[RENDERER_INIT_HOOK] === rendererWrapper;
    },
    get stats() {
      return { app: appFireCount, renderer: rendererFireCount, recreations: recreationCount };
    },
    release(): void {
      // Identity-guarded restore: only put the previous hook back if ours is still what is installed.
      // If another mod wrapped us in the meantime, restoring would erase *their* hook. That is the
      // same "identity-guarded restore" rule §19 states for socket hooks, applied to the init hooks.
      for (const slot of slots) {
        if (page[slot.name] !== slot.installed) continue;
        if (slot.previous === undefined) {
          delete page[slot.name];
        } else {
          page[slot.name] = slot.previous;
        }
      }
      if (activeCapture === handle) activeCapture = null;
    },
  };

  activeCapture = handle;
  return handle;
}

/** A handle for the no-page case: does nothing, reports itself inactive. */
function inertHandle(): PixiCaptureHandle {
  return {
    active: false,
    stats: { app: 0, renderer: 0, recreations: 0 },
    release(): void {
      // Nothing was installed.
    },
  };
}

/**
 * The documented `PixiStage` surface, as one object.
 *
 * The API reference models this as a class with static methods (§2.7: `capture`, `getCtors`,
 * `getGraphicsCtor`, `findByLabel`, `findNode`). It is presented here as a frozen namespace object
 * rather than a class with statics because that is what it actually is: there is no instance state,
 * no construction, and no `this`. Callers get the documented call shapes either way.
 *
 * Note the two additions the docs' own gaps force:
 *   - `stage`, `application`, `renderer` accessors, because G39 observes that `getCtors(stage)` refers
 *     to "`PixiStage.stage`" while `PixiStage` documents no such property. We supply it, and it is
 *     written by {@link capture}, which is the only thing that can know it.
 *   - `tryGetCtors`, because `getCtors` is documented as returning `null` and requiring the caller to
 *     poll (G38), and a per-frame caller needs a synchronous path that does not.
 */
export const PixiStage = {
  /** Install the init hooks. See {@link capture}. */
  capture,

  /** The recorded root container, or `null` before an init hook fires. */
  get stage(): PixiDisplayObject | null {
    return getStageRoot();
  },

  /** The Application, if the app hook fired. */
  get application(): PixiApplicationLike | null {
    return getApplication();
  },

  /** The Renderer, if either hook produced one. */
  get renderer(): PixiRendererLike | null {
    return getRenderer();
  },

  /**
   * Recover the full constructor set, polling until the stage has rendered a sprite and a real text
   * node. Rejects with `PixiCtorsTimeoutError` after `timeoutMs`.
   */
  getCtors(options?: GetCtorsOptions): Promise<PixiCtors> {
    return getCtorsImpl(options);
  },

  /** The synchronous fast path: cached result, one derivation attempt, or `null`. Never polls. */
  tryGetCtors(): RecoveredCtors | null {
    return tryGetCtors();
  },

  /** Derive the set from an explicit root, bypassing the cache. */
  deriveCtors,

  /** Find the Graphics constructor by the public `roundRect`/`clear` API. */
  getGraphicsCtor(stage?: unknown): (new (...args: unknown[]) => PixiGraphics) | null {
    return getGraphicsCtorImpl(stage ?? getStageRoot());
  },

  /** Find a node by its authored `.label`. */
  findByLabel(root: unknown, label: string): PixiDisplayObject | null {
    return findByLabelImpl(root, label);
  },

  /** The general depth-first search underlying the two above. */
  findNode(
    root: unknown,
    predicate: (node: unknown) => boolean,
    limit = DEFAULT_FIND_LIMIT,
  ): PixiDisplayObject | null {
    return findNodeImpl(root, predicate, limit);
  },

  /** Drop the ctor/root caches. Call this from `capture`'s `onEvent` when `wasRecreation` is true. */
  resetCtorCache,
} as const;

/** Re-exported so a caller can drive teardown without importing two modules. */
export { resetCtorCache };

/**
 * The page realm the hooks are on, or a throw.
 *
 * Exposed because several render helpers (`Graphics` creation, sprite creation) need a page to read
 * `document` from, and they must all resolve it the same way.
 */
export function requireRenderPage(): PageRealm {
  return requirePage();
}
