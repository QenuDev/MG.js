/**
 * The render facade: everything a mod needs to draw, assembled once.
 *
 * ## Why this is a module and not a private method of `BootstrappedClient`
 *
 * It used to be built as `createRenderFacade(client)` and read the client's private capture handle with
 * bracket-string access: `client['captureHandle']` (Phase 5 Task 5.7e). That compiles: element access on a
 * private field is not a visibility error in TypeScript, so the `private` modifier stopped meaning anything
 * for the one field a second module reached for, and the `as PixiCaptureHandle | null` beside it made the
 * reach-in look like a typing necessity rather than what it was. The audit named the defect (*"that is a
 * missing seam, not a shortcut"*), and the seam is {@link RenderFacadeDeps}.
 *
 * ## Why the seam is two thunks and not two values
 *
 * The facade is created once, in the constructor, because `client.render.stage` and the helper namespaces
 * must be usable before the game has created anything. But the capture handle is not installed until
 * {@link start} runs the Pixi init hook, and the jotai bridge is released on `stop()` and rebuilt on the
 * next `start()`. So both are *read live*: an eager read would freeze `client.render.capture` at `null`
 * forever and would wire cinematic claims to a bridge that had already been released. Both failures are
 * silent: no type error, and no test asserted `client.render.capture` before this split. That is why the
 * thunks are a required part of this interface rather than an implementation detail.
 */

import type { JotaiBridge } from '../jotai/bridge.js';
import * as graphics from './graphics.js';
import type { PixiCaptureHandle } from './pixi.js';
import { PixiStage } from './pixi.js';
import { RiveRegistry } from './rive.js';
import * as sprite from './sprite.js';
import * as text from './text.js';
import type { WorldSceneConfig, WorldSceneOptions } from './world.js';
import { WorldScene } from './world.js';

/** The render facade: everything a mod needs to draw. */
export interface RenderFacade {
  /** The documented `PixiStage` surface (`capture`, `getCtors`, `getGraphicsCtor`, `findByLabel`, `findNode`). */
  readonly stage: typeof PixiStage;
  /** The init-hook capture handle, or `null` when rendering is disabled. */
  readonly capture: PixiCaptureHandle | null;
  /** Text helpers. */
  readonly text: typeof text;
  /** Badge/shape helpers. */
  readonly graphics: typeof graphics;
  /** Texture cache and sprite helpers. */
  readonly sprite: typeof sprite;
  /** Live Rive artboards. */
  readonly rive: RiveRegistry;
  /**
   * Create a world scene.
   *
   * The cinematic hooks are wired to the jotai `isCinematicModeAtom` when the bridge has found it, so the
   * scene's claim reaches the game's own state. When the atom has not been found, `WorldScene` tracks the claim
   * locally and reports that it did. See its `claimCinematic`.
   */
  worldScene(config: WorldSceneConfig, options?: Omit<WorldSceneOptions, 'cinematic'>): WorldScene;
}

/**
 * What facade construction needs from its owner.
 *
 * Named as a dependency object rather than by passing the client, so that this module cannot reach for
 * anything else: the closure is the whole coupling, and `grep captureHandle` finds it.
 */
export interface RenderFacadeDeps {
  /** Read live: the handle is installed by `start()`, long after the facade is built. */
  readonly captureHandle: () => PixiCaptureHandle | null;
  /** Read live: the bridge is released on `stop()` and rebuilt on the next `start()`. */
  readonly jotai: () => JotaiBridge | null;
}

/** Create the render facade. Kept out of the constructor body so that class stays readable. */
export function createRenderFacade(deps: RenderFacadeDeps): RenderFacade {
  const rive = new RiveRegistry();
  return {
    stage: PixiStage,
    get capture(): PixiCaptureHandle | null {
      return deps.captureHandle();
    },
    text,
    graphics,
    sprite,
    rive,
    worldScene(config: WorldSceneConfig, options: Omit<WorldSceneOptions, 'cinematic'> = {}): WorldScene {
      // Wire the cinematic claim to the game's own atom when the bridge has found it, so `enter()` actually
      // puts the game into cinematic mode rather than only tracking it locally. When the atom is missing, the
      // hooks are omitted entirely and `WorldScene` reports the degradation, which is the honest answer.
      const cinematic = cinematicHooks(deps);
      return new WorldScene(config, { ...options, ...(cinematic !== undefined ? { cinematic } : {}) });
    },
  };
}

/**
 * Build cinematic-mode hooks from the jotai bridge.
 *
 * The atom is named in the recon §6.3 as "cinematic mode", with no label given. The candidate labels are the
 * ones the companion mod's own source uses (`isCinematicModeAtom`), tried by segment match, and `null` when none
 * is found. The claim is *refcounted by owner* so that two scenes can hold it at once and releasing one does
 * not clear the other's. That is what §18 requires: "release your claim", not "force it off".
 */
function cinematicHooks(deps: RenderFacadeDeps): WorldSceneOptions['cinematic'] | undefined {
  const bridge = deps.jotai();
  if (bridge === null) return undefined;

  const owners = new Set<string>();

  return {
    claim(owner: string): void {
      owners.add(owner);
      const atom = bridge.find('isCinematicModeAtom') ?? bridge.find('cinematicModeAtom');
      if (atom === null) return;
      bridge.write(atom, true);
    },
    release(owner: string): void {
      owners.delete(owner);
      if (owners.size > 0) return;
      const atom = bridge.find('isCinematicModeAtom') ?? bridge.find('cinematicModeAtom');
      if (atom === null) return;
      bridge.write(atom, false);
    },
  };
}
