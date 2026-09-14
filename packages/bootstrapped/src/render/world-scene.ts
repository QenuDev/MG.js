/**
 * `WorldScene`: drawing into the game's own canvas.
 *
 * Split out of `world.ts` (Phase 5 Task 5.7c). This is the only module in the group that depends on all the
 * others: geometry to read the world, tiles to find it in the display list, cinematic claims to know when
 * another load owns the camera, and the warning helpers to report what it could not do.
 */

import type { CinematicClaimHooks } from './cinematic-claims.js';
import { cinematicClaims } from './cinematic-claims.js';
import type { PixiDisplayObject } from './ctors.js';
import { findAllNodes, getGraphicsCtor, isRiveLike } from './ctors.js';
import { PixiStage } from './pixi.js';
import { createSpriteSync } from './sprite.js';
import { detach } from './text.js';
import { collectTileViews, findRenderLayerCtor, textureFromImage } from './tile-view.js';
import type { WorldGeometry } from './world-geometry.js';
import { readGeometry } from './world-geometry.js';
import { defaultWorldErrorHandler, recordAndSet, recordAndWrapNoop } from './world-warnings.js';

/** §3.1 `WorldSceneConfig`: "WorldScene constructor options". */
export interface WorldSceneConfig {
  /** "Unique id": namespaces this scene's cinematic-mode claim and render-layer label. */
  owner: string;
  /** "Layer name → zIndex. The farm sits near 0." */
  layers: Record<string, number>;
  /** "Which of the above layers get lifted into a RenderLayer that sorts above the player avatar." */
  abovePlayer?: string[];
}

/** §3.1 `SpriteOptions`: "WorldScene#addSprite() options". */
export interface SpriteOptions {
  x: number;
  y: number;
  zIndex: number;
  /** "Must match a key in WorldSceneConfig.layers." */
  layer: string;
}

/** Options for {@link WorldScene}. */
export interface WorldSceneOptions {
  /** The root to look for the world container under. Defaults to the captured Pixi stage. */
  stage?: PixiDisplayObject | null;
  /** Cinematic-mode hooks. See {@link CinematicClaimHooks}. */
  cinematic?: CinematicClaimHooks;
  /**
   * The plain-string `.label` of the game's world container.
   *
   * Not documented (G40 gives `WorldGeometry.system` no description beyond "the game's world-container
   * node", and G39 notes the docs name no accessor for it). This code takes the label the recon
   * records the game tagging its containers with; a caller whose build differs supplies its own rather
   * than editing this.
   */
  worldLabel?: string;
  /** Diagnostic sink. Defaults to a warn-once `console.warn`. */
  onError?: (operation: string, error: unknown) => void;
}

/**
 * Labels the recon records the game using for its world/systems containers, most specific first.
 *
 * These are plain-string `.label`s rather than minified identifiers, which §14 calls "by far the most
 * stable hook point across builds". They are still a *guess at which one is the world*, so
 * {@link WorldScene.findWorldContainer} falls back to a structural search when none matches.
 */
const DEFAULT_WORLD_LABELS = ['GardenWorldSystem', 'GardenWorld', 'WorldSystem', 'World'];

/** One owned sprite, with the layer it went into so teardown can find it. */
interface OwnedSprite {
  node: PixiDisplayObject;
  layerName: string;
}

/** A layer's runtime state. */
interface LayerState {
  name: string;
  container: PixiDisplayObject;
  zIndex: number;
  /** True when this layer was lifted into a RenderLayer-like container. */
  abovePlayer: boolean;
}

/** A recorded value we changed and must put back. */
export interface Restore {
  target: Record<string, unknown>;
  key: string;
  value: unknown;
  /** True when the key did not exist as an own property, so restore must delete rather than assign. */
  wasAbsent: boolean;
  /**
   * What *we* installed on the slot.
   *
   * Compared by identity against the slot at `exit()` time. If they differ, something wrote the slot
   * after we did, another `WorldScene` over the same node, or a scene that entered earlier and exits
   * later, and that write is theirs to keep. DESIGN §6 I2: restore only your own change.
   */
  applied: unknown;
}

/** Monotonic instance counter, so two scenes never share a label even with the same owner. */
let sceneCounter = 0;

/**
 * A world overlay scene.
 *
 * Lifecycle: construct → {@link enter} (or let {@link sync} do it) → draw → {@link exit}. Every method is
 * safe to call repeatedly and in any order, and `exit()` is safe when `enter()` never ran, since the docs say
 * so for both `enter` and `exit` ("Safe to call repeatedly", "Safe to call when never entered").
 */
export class WorldScene {
  /** The owner id, verbatim from the config. */
  readonly owner: string;
  /** A per-instance discriminant, so two scenes with one owner still get distinct labels. */
  readonly sceneId: string;
  /** The configured layer name → zIndex map. */
  readonly layers: Record<string, number>;

  private readonly abovePlayerNames: Set<string>;
  /**
   * The root the caller pinned this scene to, if any.
   *
   * Mutable, because {@link rebuild} may be handed a replacement. It is *not* re-resolved from
   * `PixiStage.stage` on its own: a caller that passed a stage owns that choice, and silently following the
   * captured root would abandon the tree they asked for.
   */
  private stageOverride: PixiDisplayObject | null;
  private readonly cinematic: CinematicClaimHooks;
  private readonly worldLabelOverride: string | undefined;
  private readonly onError: (operation: string, error: unknown) => void;
  /**
   * The root {@link findWorldContainer} last resolved against, so a replacement is detectable.
   *
   * Comparing the *root* rather than the container is what makes the check cheap and honest: the container is
   * a descendant, and a game that swaps renderers gives a new root with a new subtree under it.
   */
  private resolvedRoot: PixiDisplayObject | null = null;

  private readonly layerStates = new Map<string, LayerState>();
  private readonly owned: OwnedSprite[] = [];
  private readonly restores: Restore[] = [];

  private worldContainer: PixiDisplayObject | null = null;
  private entered = false;
  private claimedCinematic = false;
  private geometry: WorldGeometry | null = null;

  constructor(config: WorldSceneConfig, options: WorldSceneOptions = {}) {
    if (config.owner === '') {
      throw new Error(
        "mg.js: WorldScene requires a non-empty owner id. It namespaces this scene's cinematic-mode " +
          'claim and render-layer label, and an empty owner collides with every other scene.',
      );
    }
    this.owner = config.owner;
    sceneCounter += 1;
    this.sceneId = `${config.owner}#${sceneCounter}`;
    this.layers = { ...config.layers };
    this.abovePlayerNames = new Set(config.abovePlayer ?? []);
    this.stageOverride = options.stage ?? null;
    this.cinematic = options.cinematic ?? {};
    this.worldLabelOverride = options.worldLabel;
    this.onError = options.onError ?? defaultWorldErrorHandler;
  }

  /** True while this scene holds the farm. */
  get isEntered(): boolean {
    return this.entered;
  }

  /** The layer containers, keyed by layer name. Empty before `enter()`. */
  get layerNames(): string[] {
    return [...this.layerStates.keys()];
  }

  /**
   * Show or hide one of this scene's layers by name.
   *
   * A layer container is visible from the moment it is built, because otherwise nothing drawn into
   * it can ever appear, so hiding one is a deliberate act, and this is the affordance for it. Without this
   * the only way to hide a single layer would be to reach into the container through
   * {@link layerNames}' counterpart, which leaves the intent unstated.
   *
   * Not recorded as a {@link Restore}: the container is scene-owned and `exit()` destroys
   * it, so there is no previous value to give back to anyone else.
   *
   * @returns `false` when no layer of that name exists (or before {@link enter} created them), so a
   *   caller can tell a typo from a hidden layer.
   */
  setLayerVisible(name: string, visible: boolean): boolean {
    const layer = this.layerStates.get(name);
    if (layer === undefined) return false;
    layer.container.visible = visible;
    return true;
  }

  /**
   * Take over the farm.
   *
   * Idempotent per the docs ("Safe to call repeatedly"): a second call while entered does nothing and
   * returns `false`. Every step is individually guarded: a scene that cannot find the world container
   * still builds its layers so that a later `sync()` can attach them.
   *
   * @returns `true` when this call did the work, `false` when it was already entered or the world could
   *   not be located at all.
   */
  enter(): boolean {
    if (this.entered) return false;

    const world = this.findWorldContainer();
    if (world === null) {
      this.report('enter', new Error("the game's world container could not be located"));
      return false;
    }
    this.worldContainer = world;

    this.buildLayers(world);
    this.suppressTiles(world);
    this.hideUnderlying(world);
    this.claimCinematic();
    this.penPets(world);

    this.entered = true;
    return true;
  }

  /**
   * Rebuild onto a replacement renderer.
   *
   * The game recreates its renderer on a WebGL context loss, and every node this scene recorded belongs to
   * the tree that went with it. `rebuild` unwinds what it can from the old tree (failures are reported, not
   * thrown, and the old nodes may already be destroyed), then enters the new one exactly as {@link enter}
   * would.
   *
   * @param stage the replacement root. Omitted, the scene re-resolves the root it already had: the captured
   *   one for a scene that never pinned a stage, or the pinned one, which is not abandoned silently.
   * @returns `true` when the scene entered the new tree.
   */
  rebuild(stage?: PixiDisplayObject | null): boolean {
    if (stage !== undefined) this.stageOverride = stage;

    this.exit();
    this.worldContainer = null;
    this.geometry = null;
    return this.enter();
  }

  /**
   * Hand the farm back.
   *
   * Restores every recorded value in reverse order (so nested changes unwind correctly), destroys every
   * node this scene created, and it releases, never forces off, its cinematic claim. Idempotent, and safe
   * when {@link enter} never ran.
   *
   * @returns `true` when this call did the work.
   */
  exit(): boolean {
    if (!this.entered) {
      // Still destroy anything a caller added before entering; leaking those would be worse than a
      // no-op exit.
      this.destroyOwned();
      return false;
    }

    this.releaseCinematic();

    // §18's fifth responsibility explicitly, before the shared restore unwind: pets go back in. The
    // restore records hold their previous `visible`, so this ordering is about intent, not mechanism.
    this.releasePets();

    // Reverse order: the last recorded change is the innermost one.
    for (let index = this.restores.length - 1; index >= 0; index -= 1) {
      const restore = this.restores[index];
      if (restore === undefined) continue;
      try {
        // I2: give back only what is still ours. If the slot no longer holds what we installed,
        // something else wrote it after us and that value is theirs, not a change of ours to reverse.
        if (restore.target[restore.key] !== restore.applied) continue;
        if (restore.wasAbsent) delete restore.target[restore.key];
        else restore.target[restore.key] = restore.value;
      } catch (error) {
        this.report('exit:restore', error);
      }
    }
    this.restores.length = 0;

    this.destroyOwned();

    for (const [name, state] of this.layerStates) {
      try {
        detach(state.container);
        state.container.destroy?.({ children: true });
      } catch (error) {
        this.report(`exit:destroyLayer(${name})`, error);
      }
    }
    this.layerStates.clear();

    this.worldContainer = null;
    this.geometry = null;
    this.entered = false;
    this.resolvedRoot = null;
    return true;
  }

  /**
   * Per-frame upkeep.
   *
   * "Builds the scene if needed and returns the geometry to draw against", so this is the method a
   * caller puts in its own tick and the only one it needs to call. Returns `null` "when the farm cannot
   * be read yet", which is also what it returns when the world container has not appeared.
   *
   * The geometry is recomputed on every call rather than cached: tile maps are re-laid-out when the
   * player switches farms or the room re-syncs, and a cached origin from a previous farm silently
   * misplaces every sprite. The recomputation is a handful of property reads, not a tree walk.
   */
  sync(): WorldGeometry | null {
    // A replaced renderer invalidates everything resolved from the old one, and nothing else in this class
    // can notice: the scene holds a container from a tree the game has thrown away. An entered scene whose
    // resolved root is no longer the live one rebuilds here, so recovery is automatic for a
    // scene that resolved the captured root. A scene with a pinned stage does not move: see `rebuild`.
    if (this.entered && this.resolvedRoot !== (this.stageOverride ?? PixiStage.stage)) {
      this.rebuild();
    }
    if (!this.entered && this.worldContainer === null) {
      const world = this.findWorldContainer();
      if (world === null) return null;
      this.worldContainer = world;
    }
    if (!this.entered) {
      if (!this.enter()) {
        // `enter()` failed; if it failed because the world vanished, report the absence.
        if (this.worldContainer === null) return null;
      }
    }

    const world = this.worldContainer;
    if (world === null) return null;

    const geometry = readGeometry(world);
    if (geometry === null) return null;
    this.geometry = geometry;
    return geometry;
  }

  /** The geometry from the last successful {@link sync}, or `null`. */
  get lastGeometry(): WorldGeometry | null {
    return this.geometry;
  }

  /**
   * Add an image to the world under this scene's ownership.
   *
   * "Destroyed automatically on `exit()`", recorded in {@link owned} for exactly that reason, which is
   * also why a caller must not destroy an owned sprite itself without using {@link removeSprite}: the
   * bookkeeping would still hold it and `exit()` would destroy it a second time.
   *
   * @returns the sprite, or `null` when the layer is unknown, the constructor set is not ready, or the
   *   texture was rejected. A `null` return rather than a throw, because this is called from a drawing
   *   path where a throw would land inside the game's frame.
   */
  addSprite(image: HTMLImageElement, options: SpriteOptions): PixiDisplayObject | null {
    const layer = this.layerStates.get(options.layer);
    if (layer === undefined) {
      this.report(
        'addSprite',
        new Error(
          `layer "${options.layer}" is not one of this scene's configured layers ` +
            `(${Object.keys(this.layers).join(', ') || 'none'})`,
        ),
      );
      return null;
    }

    const ctors = PixiStage.tryGetCtors();
    if (ctors === null) {
      this.report('addSprite', new Error('the Pixi constructor set is not recovered yet'));
      return null;
    }

    try {
      const texture = textureFromImage(ctors.Texture, image);
      if (texture === null) {
        this.report('addSprite', new Error('the image could not be turned into a texture'));
        return null;
      }
      const sprite = createSpriteSync(ctors.Sprite, texture, {
        x: options.x,
        y: options.y,
        zIndex: options.zIndex,
      });
      layer.container.addChild?.(sprite);
      this.owned.push({ node: sprite, layerName: options.layer });
      return sprite;
    } catch (error) {
      this.report('addSprite', error);
      return null;
    }
  }

  /**
   * Destroy one sprite early.
   *
   * "For a scene whose pieces come and go during play." Removes the sprite from the ownership ledger
   * first, so a later `exit()` cannot double-destroy it.
   */
  removeSprite(sprite: unknown): void {
    if (sprite === null || sprite === undefined || typeof sprite !== 'object') return;
    const index = this.owned.findIndex((entry) => entry.node === sprite);
    if (index >= 0) this.owned.splice(index, 1);
    const node = sprite as PixiDisplayObject;
    try {
      detach(node);
      node.destroy?.({ children: true });
    } catch (error) {
      this.report('removeSprite', error);
    }
  }

  /** How many sprites this scene currently owns. Diagnostics and tests. */
  get spriteCount(): number {
    return this.owned.length;
  }

  // ------------------------------------------------------------------------------------
  // The five documented responsibilities
  // ------------------------------------------------------------------------------------

  /**
   * (1) and (2): one container per named layer, and a RenderLayer for the `abovePlayer` ones.
   *
   * The container type is `Graphics` when a Graphics constructor is available and `Container` otherwise.
   * `Graphics` is preferred purely because §18 names it first and it is a superset for our purposes (it
   * is a Container that can also be drawn into), while `Container` is the guaranteed fallback since the
   * documented `PixiCtors` set always carries one.
   *
   * **The `abovePlayer` degradation is explicit.** §18: a RenderLayer is "the only reliable way to draw
   * in front of the player character. A raw large positive `zIndex` on the world container does not
   * reliably beat the avatar's own sorting." `RenderLayer` is *not* part of the documented constructor
   * set and there is no documented way to recover one, so this method looks for a `RenderLayer`
   * constructor on the recovered `Container`'s module (which is how a bundled Pixi exposes it when it
   * exposes it at all) and, failing that, still creates the layer and still assigns the zIndex, which
   * the docs say is unreliable, not useless. The degradation is reported so a caller can see it rather
   * than silently get a layer that draws behind the player.
   */
  private buildLayers(world: PixiDisplayObject): void {
    if (this.layerStates.size > 0) return;

    const ctors = PixiStage.tryGetCtors();
    const graphicsCtor = getGraphicsCtor();
    const RenderLayerCtor = findRenderLayerCtor(ctors?.Container ?? null);

    for (const [name, zIndex] of Object.entries(this.layers)) {
      try {
        const wantsRenderLayer = this.abovePlayerNames.has(name);
        let container: PixiDisplayObject;

        if (wantsRenderLayer && RenderLayerCtor !== null) {
          container = new RenderLayerCtor();
        } else if (graphicsCtor !== null) {
          container = new graphicsCtor() as unknown as PixiDisplayObject;
        } else if (ctors !== null) {
          container = new ctors.Container();
        } else {
          this.report('buildLayers', new Error('no Container or Graphics constructor is available'));
          return;
        }

        // The owner-namespaced label. G41 says the docs specify nothing for two scenes with one owner;
        // the sceneId makes them distinct regardless.
        container.label = `${this.sceneId}/${name}`;
        container.zIndex = zIndex;
        // Scene-owned and destroyed by `exit()`, so this layer is *ours to show*: a fresh Pixi Container
        // is visible, and this code must not hide it, because there is no restore record and no code path
        // that would ever put it back, and hiding it made every sprite `addSprite` created permanently
        // undrawable. A caller who wants a layer hidden says so through `setLayerVisible`.
        container.visible = true;

        if (wantsRenderLayer && RenderLayerCtor === null) {
          this.report(
            'buildLayers',
            new Error(
              `layer "${name}" is listed in abovePlayer but no RenderLayer constructor is recoverable ` +
                'on this build, so it will rely on zIndex sorting, which the docs say does not reliably ' +
                'beat the player avatar.',
            ),
          );
        }

        world.addChild?.(container);
        this.layerStates.set(name, { name, container, zIndex, abovePlayer: wantsRenderLayer });
      } catch (error) {
        this.report(`buildLayers(${name})`, error);
      }
    }
  }

  /**
   * (3a): suppress the game's own tile redraw.
   *
   * The game redraws each tile through a per-tile view object's `draw`. Wrapping `draw` with a no-op
   * *recorded* wrapper is the reversible way to stop that: it leaves the object in place, so restoring is
   * an assignment rather than a reconstruction. The companion mod's own discipline (`wrappedTileViews`
   * plus a `typeof draw !== 'function'` guard) is the pattern followed here.
   *
   * The wrapped instances are recorded in {@link restores}, so `exit()` puts the original `draw` back.
   * Anything without a `draw` function is left alone rather than given one, because adding a `draw` to
   * an object that never had it would change the game's own dispatch.
   */
  private suppressTiles(world: PixiDisplayObject): void {
    const tiles = collectTileViews(world);
    for (const tile of tiles) {
      recordAndWrapNoop(this.restores, tile as Record<string, unknown>, 'draw');
    }
  }

  /**
   * (3b): hide, do not destroy, the tiles and effects underneath.
   *
   * §18 is emphatic: "hide (don't destroy) the tiles/effects underneath so they can be restored
   * byte-for-byte on exit." Hiding is recorded as a {@link Restore} of the previous `visible` value, so a
   * tile that was *already* hidden before we entered is restored to hidden, not to visible.
   */
  private hideUnderlying(world: PixiDisplayObject): void {
    // Only the world container's own immediate tile-ish children, not the whole subtree: hiding the
    // avatar or the UI systems would be a much larger claim than "the farm tiles".
    const children = world.children;
    if (!Array.isArray(children)) return;
    for (const child of children) {
      if (child === null) continue;
      if (this.isOwnLayer(child)) continue;
      recordAndSet(this.restores, child as Record<string, unknown>, 'visible', false);
    }
  }

  /** True when a node is one of this scene's own layer containers. */
  private isOwnLayer(node: PixiDisplayObject): boolean {
    for (const state of this.layerStates.values()) {
      if (state.container === node) return true;
    }
    return false;
  }

  /**
   * (4): claim cinematic mode.
   *
   * Refcounted per owner, and released rather than forced off. Two behaviours are possible and the
   * difference is stated rather than hidden:
   *
   *   - With {@link CinematicClaimHooks} supplied, the host's claim/release reach the game's own atom.
   *   - Without them, the claim is tracked only in this module's ledger. The scene still works; the game
   *     simply does not know, so it will keep drawing its own farm UI. That is the honest degradation for
   *     a mod that has not found `isCinematicModeAtom`, and it is better than an assignment that would
   *     clobber whatever the game or another mod had set.
   */
  private claimCinematic(): void {
    const count = (cinematicClaims.get(this.owner) ?? 0) + 1;
    cinematicClaims.set(this.owner, count);
    if (count === 1 && typeof this.cinematic.claim === 'function') {
      try {
        this.cinematic.claim(this.owner);
      } catch (error) {
        this.report('claimCinematic', error);
      }
    }
    this.claimedCinematic = true;
  }

  /**
   * (4, teardown): release the claim.
   *
   * Only when the owner's refcount reaches zero, so two scenes sharing an owner work:
   * the first to exit does not steal the claim from the second.
   */
  private releaseCinematic(): void {
    if (!this.claimedCinematic) return;
    this.claimedCinematic = false;
    const count = (cinematicClaims.get(this.owner) ?? 0) - 1;
    if (count > 0) {
      cinematicClaims.set(this.owner, count);
      return;
    }
    cinematicClaims.delete(this.owner);
    if (typeof this.cinematic.release === 'function') {
      try {
        this.cinematic.release(this.owner);
      } catch (error) {
        this.report('releaseCinematic', error);
      }
    }
  }

  /**
   * (5): pen active pets out of the way.
   *
   * Pets are found structurally, not by label: a pet node in this game carries a Rive host, and
   * `ctors.ts` already knows how to recognise that shape. Moving them is a recorded `visible = false`
   * rather than a translation, because we do not know the tile size (G40) and a guessed offset would
   * park them somewhere visible.
   */
  private penPets(world: PixiDisplayObject): void {
    // Every pet, not the first one. `findNode` stops at the first match, so a farm with more than one Rive
    // host left the rest on their claimed tiles (audit 08 §2). The predicate was never the problem, the walk
    // was. `findAllNodes` is the same traversal with an array result, and the budget is the same.
    const pets = findAllNodes(world, (node) => isRiveLike(node), 4_000);
    for (const pet of pets) {
      recordAndSet(this.restores, pet as Record<string, unknown>, 'visible', false);
    }
  }

  /**
   * (5, teardown): let pets back in.
   *
   * Nothing to do beyond the shared {@link restores} unwinding in {@link exit}: the restore record
   * already holds each pet's previous `visible`. This method exists to make the mapping to §18's fifth
   * responsibility explicit and to give a future implementation somewhere to put a real "un-pen".
   */
  private releasePets(): void {
    // Empty: restoration is handled by the reverse-order unwind in exit(), which is the
    // only place that can be sure it runs exactly once.
  }

  // ------------------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------------------

  /** Destroy every owned node and clear the ledger. */
  private destroyOwned(): void {
    for (const entry of this.owned) {
      try {
        detach(entry.node);
        entry.node.destroy?.({ children: true });
      } catch (error) {
        this.report('destroyOwned', error);
      }
    }
    this.owned.length = 0;
  }

  /**
   * Find the world container.
   *
   * Two strategies, in order, because neither is reliable alone:
   *   1. **By label.** §14: the game tags containers with plain strings like `"GardenInfoCardSystem"`,
   *      which are "by far the most stable hook point across builds". The candidate list plus the
   *      caller's `worldLabel` override.
   *   2. **Structurally.** A container that has children which themselves look like tiles. This is the
   *      fallback for a build that renamed the label, which the docs' own drift warnings make likely
   *      enough to plan for.
   *
   * A caller-supplied `stage` always wins over the captured root, so a mod that has its own reference is
   * never overridden by our guess.
   */
  findWorldContainer(): PixiDisplayObject | null {
    const root = this.stageOverride ?? PixiStage.stage;
    if (root === null) return null;
    this.resolvedRoot = root;

    const labels =
      this.worldLabelOverride === undefined
        ? DEFAULT_WORLD_LABELS
        : [this.worldLabelOverride, ...DEFAULT_WORLD_LABELS];

    for (const label of labels) {
      const found = PixiStage.findByLabel(root, label);
      if (found !== null) return found;
    }

    // Structural fallback: the shallowest container holding a node that looks like a tile view (it has
    // its own `draw`), the shape the farm has.
    return PixiStage.findNode(
      root,
      (node) => {
        if (node === null || typeof node !== 'object') return false;
        const record = node as Record<string, unknown>;
        const children = record['children'];
        if (!Array.isArray(children) || children.length < 4) return false;
        return children.some(
          (child) =>
            child !== null &&
            typeof child === 'object' &&
            typeof (child as { draw?: unknown }).draw === 'function',
        );
      },
      4_000,
    );
  }

  private report(operation: string, error: unknown): void {
    try {
      this.onError(operation, error);
    } catch {
      // Never let a reporter throw into a caller.
    }
  }
}

// --------------------------------------------------------------------------------------
// Pure helpers (exported for tests)
// --------------------------------------------------------------------------------------
