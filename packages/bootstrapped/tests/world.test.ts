/**
 * `WorldScene`: a layer you can see, and a restore that only takes back its own change.
 *
 * ## The two defects these tests exist for
 *
 * **A. No layer can ever display.** `buildLayers` creates one container per configured layer, assigns
 * it a label and a zIndex, and then sets `visible = false` (`world-scene.ts`). Nothing in the file ever
 * sets it back: the only other `visible` writes are `hideUnderlying` and `penPets`, both of which only
 * ever write `false`. Every sprite `addSprite` creates is added into one of those containers, so the
 * class's whole drawing surface is invisible by construction, and DESIGN §6 flags it as one of the four
 * critical findings ("no WorldScene layer can ever display a sprite"). The container is scene-owned and
 * `exit()` destroys it, so the correct value is simply `true`.
 *
 * **B. `exit()` can undo a write this scene did not make.** `recordAndSet`/`recordAndWrapNoop` store the
 * previous value and `exit()` restores it unconditionally, so if anything writes the slot after we did
 * (another scene over the same node, or an exiting scene that entered earlier) our restore clobbers
 * their value. DESIGN §6 I2 states the rule the fix has to satisfy: restore only your own change, and
 * specifically names this violation (`world-scene.ts`).
 *
 * The defect is *observable on a low-cardinality slot*: if the value we installed and the one used to
 * exist are the only two values a slot has, such as a boolean `visible`, a stale restore and a foreign
 * restore can land on the same value and the bug hides. So the test that pins it uses the tile's `draw`,
 * which has three distinct values (the original, the wrapper this scene installs, and a third body that
 * is neither). The `visible` slot still covers the ordinary path.
 *
 * ## What the fixture is, and why
 *
 * There is no Pixi and no real game stage in Node, so both are built structurally, the same approach as
 * `ctors.test.ts`, which is the reference for this file. `WorldScene` reaches Pixi through
 * `PixiStage.tryGetCtors()`, which derives the constructor set from the recorded stage root by
 * duck-typing live nodes and reading `.constructor`; a named constructor is therefore the only thing a
 * fake needs that a real node would not get from `Object`. Each fake node class is a real class named
 * the way a minified Pixi build still names one, and `addChild` maintains `children` and the parent
 * back-pointer, and `collectTileViews`, `isOwnLayer` and `detach` all read that back-pointer.
 *
 * The stage carries a Sprite node (a `.texture`/`.anchor` pair), a real Text node
 * (`renderPipeId: 'text'`) and a Graphics node (unminified `roundRect`/`clear`). Without all three,
 * `buildLayers` reports an error and returns without creating a single container, and the failure would be
 * the *fixture's*, not the class's. So every test in the "a layer you can see" block asserts up front
 * that the ctor set was recovered and that the world actually gained a layer container; a fixture that
 * recovers nothing cannot satisfy those assertions by accident.
 *
 * The world is found through the explicit `worldLabel` option rather than the recon's label list, so the
 * test does not depend on a guess about the game's labels. Layer containers are found by label *suffix*
 * (`<sceneId>/<layer>`), because `sceneId` embeds a module-level counter that makes the full label vary
 * from run to run.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PixiDisplayObject } from '../src/render/ctors.ts';
import { hasCoreCtorSet, resetCtorCache, setStageRoot, tryGetCtors } from '../src/render/ctors.ts';
import { asGraphics, WorldScene, type WorldSceneOptions } from '../src/render/world.ts';

// --------------------------------------------------------------------------------------
// Fake Pixi nodes
// --------------------------------------------------------------------------------------

/** A real class carrying a chosen constructor name, the field `deriveCtors` reads. */
class FakeNode implements PixiDisplayObject {
  [key: string]: unknown;
}

/** Write the constructor name a minified Pixi build still exposes. */
function nameClass(Ctor: unknown, name: string): void {
  Object.defineProperty(Ctor, 'name', { value: name });
}

class FakeContainer extends FakeNode {
  /** Declared rather than assigned in, so `addChild` always has a list to push into. */
  children: PixiDisplayObject[] = [];

  addChild(...children: PixiDisplayObject[]): void {
    for (const child of children) {
      this.children.push(child);
      child.parent = this as unknown as PixiDisplayObject;
    }
  }

  removeChildren(...children: PixiDisplayObject[]): void {
    for (const child of children) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
    }
  }
}
nameClass(FakeContainer, 'Container');

/**
 * A Graphics: the unminified `roundRect`/`clear` pair is `isGraphicsLike`'s discriminant.
 *
 * It extends the container, as Pixi's own `Graphics` does: `addSprite` adds into a layer with
 * `container.addChild?.(sprite)`, and a Graphics that could not hold children would make the
 * non-`abovePlayer` layer path untestable.
 */
class FakeGraphics extends FakeContainer {
  clear(): void {
    // Nothing to clear in a fake.
  }

  roundRect(): void {
    // Nothing to draw in a fake.
  }
}
nameClass(FakeGraphics, 'Graphics');

/** A texture factory that accepts an image, so `textureFromImage`'s `new TextureCtor(image)` route works. */
class FakeTexture {
  constructor(readonly source: unknown) {}
}

/** A Sprite: `.texture` plus an object `.anchor` is `isSpriteLike`'s discriminant. */
class FakeSprite extends FakeNode {
  texture = new FakeTexture(undefined);
  anchor = { x: 0.5, y: 0.5 };
}
nameClass(FakeSprite, 'Sprite');

/** A genuine Text: `renderPipeId: 'text'` is the documented discriminant, and `.text` is a string. */
class FakeText extends FakeNode {
  text = 'hello';
  style: Record<string, unknown> = { fontFamily: 'Arial', fontSize: 14 };
  renderPipeId = 'text';
}
nameClass(FakeText, 'Text');

/** A tile view: `draw` and no `children` is the shape `collectTileViews` looks for. */
class FakeTile {
  visible = true;
  draw(): void {
    // The game's own redraw, which suppression is supposed to wrap.
  }
}

/**
 * The stage root.
 *
 * `deriveCtors` reads the *stage's own* constructor as `Container`, so the root must be a genuine
 * container-shaped instance and not a bare object.
 */
class FakeStageRoot extends FakeContainer {}

/** An image element. `textureFromImage` only needs an object identity, which its `WeakMap` also requires. */
function fakeImage(): HTMLImageElement {
  return { width: 16, height: 16, src: 'about:blank#fixture' } as unknown as HTMLImageElement;
}

// --------------------------------------------------------------------------------------
// The fixture
// --------------------------------------------------------------------------------------

/** The label this fixture gives its world container, passed explicitly as `worldLabel`. */
const WORLD_LABEL = 'FixtureWorldSystem';

/** Matches the scene's own layer labels, which are `<owner>#<counter>/<layer>`. */
const OWN_LAYER_LABEL = /#\d+\//;

interface Fixture {
  readonly stage: PixiDisplayObject;
  readonly world: PixiDisplayObject;
  readonly tile: PixiDisplayObject;
  readonly ui: PixiDisplayObject;
  /** Every error the scene reported, so a silently degraded path is visible in a test failure. */
  readonly errors: string[];
}

/** Build a stage with a labellable world, one tile child and one non-tile child. */
function makeFixture(): Fixture {
  const world = new FakeContainer();
  Object.assign(world, { label: WORLD_LABEL, visible: true });

  const tile = new FakeTile() as unknown as PixiDisplayObject;
  Object.assign(tile, { visible: true });

  const ui = new FakeContainer();
  Object.assign(ui, { label: 'FixtureFarmUi', visible: true });

  const stage = new FakeStageRoot();
  stage.addChild(world, new FakeSprite(), new FakeText(), new FakeGraphics());
  // Both the tile and the ui node are the world's own immediate children: that is the set
  // `hideUnderlying` hides, and it is the subtree `collectTileViews` walks for `draw` wrappers.
  world.addChild(tile, ui);

  return { stage, world, tile, ui, errors: [] };
}

/** Point the recovery module at this fixture's stage and drop any root/ctor state a prior test left. */
function installFixture(fixture: Fixture): void {
  resetCtorCache();
  setStageRoot(fixture.stage);

  // The guard that keeps every assertion below meaningful: without a recovered ctor set, `buildLayers`
  // reports and returns, and a test for "the layer is visible" would fail for the wrong reason, or, in
  // a weaker shape, pass for it.
  const ctors = tryGetCtors();
  assert.ok(ctors !== null, 'the fixture stage must yield a recovered constructor set');
  assert.ok(
    hasCoreCtorSet(ctors),
    'the fixture stage must expose a Sprite and a genuine Text, or buildLayers degrades',
  );
}

/** A scene over the fixture's world, with its errors captured. */
function makeScene(
  fixture: Fixture,
  layers: Record<string, number>,
  options: { abovePlayer?: string[] } = {},
): WorldScene {
  const sceneOptions: WorldSceneOptions = {
    stage: fixture.stage,
    worldLabel: WORLD_LABEL,
    onError: (operation) => fixture.errors.push(operation),
  };
  return new WorldScene(
    { owner: 'world-test', layers, ...(options.abovePlayer ? { abovePlayer: options.abovePlayer } : {}) },
    sceneOptions,
  );
}

/** Find a layer container by its label suffix, because `sceneId` carries a run-varying counter. */
function findLayer(fixture: Fixture, name: string): PixiDisplayObject {
  const children = fixture.world.children ?? [];
  const found = children.find((child) => (child.label ?? '').endsWith(`/${name}`));
  assert.ok(found !== undefined, `layer "${name}" was created and added to the world container`);
  return found;
}

/** How many layer containers this scene has added to the world. */
function ownLayerCount(fixture: Fixture): number {
  const children = fixture.world.children ?? [];
  return children.filter((child) => OWN_LAYER_LABEL.test(child.label ?? '')).length;
}

// --------------------------------------------------------------------------------------
// Defect A: a layer you can see
// --------------------------------------------------------------------------------------

describe('WorldScene layers: a created layer is visible', () => {
  it('leaves the container it created for a layer visible, so sprites in it can be displayed', () => {
    const fixture = makeFixture();
    installFixture(fixture);
    const scene = makeScene(fixture, { farm: 0 });

    assert.equal(scene.enter(), true, 'the scene entered the world it was pointed at');

    // Fixture sanity, not the assertion under test: a layer really was created.
    assert.equal(ownLayerCount(fixture), 1, 'exactly one layer container was created and added');

    const layer = findLayer(fixture, 'farm');
    assert.equal(
      layer.visible,
      true,
      'buildLayers creates the layer container, so it must be visible: nothing else in the class sets it back',
    );
    assert.equal(layer.zIndex, 0, 'the configured zIndex is still applied');
    assert.deepEqual(fixture.errors, [], 'the ordinary path must not degrade into a reported error');
  });

  it('adds a sprite into a container that is visible, which is the only path a sprite can be seen through', () => {
    const fixture = makeFixture();
    installFixture(fixture);
    const scene = makeScene(fixture, { farm: 0 });
    scene.enter();

    const sprite = scene.addSprite(fakeImage(), { x: 4, y: 8, zIndex: 1, layer: 'farm' });
    assert.ok(sprite !== null, 'addSprite succeeds when the layer exists and the ctor set is recovered');
    assert.equal(scene.spriteCount, 1, 'the sprite is owned by the scene');

    const layer = findLayer(fixture, 'farm');
    assert.equal(layer.children?.includes(sprite), true, 'the sprite landed in the layer container it named');
    assert.equal(
      layer.visible,
      true,
      'a sprite can only be displayed if the container holding it is visible',
    );
    assert.equal(layer.parent, fixture.world, 'the layer is parented to the world it was built into');

    scene.exit();
  });

  it('makes an abovePlayer layer visible when a RenderLayer is recoverable', () => {
    const fixture = makeFixture();

    // `findRenderLayerCtor` reads `RenderLayer` off the Container constructor itself or off a
    // CJS/IIFE namespace hanging there, and a bundle shim often hangs the namespace off `module`. That is
    // the shape built here, and it is the one recovery route the class documents.
    class FakeRenderLayer extends FakeContainer {
      renderLayer = true;
    }
    nameClass(FakeRenderLayer, 'RenderLayer');
    Object.assign(FakeContainer, { module: { RenderLayer: FakeRenderLayer } });

    try {
      installFixture(fixture);
      const scene = makeScene(fixture, { overlay: 10 }, { abovePlayer: ['overlay'] });

      assert.equal(scene.enter(), true, 'the scene entered the world it was pointed at');

      const layer = findLayer(fixture, 'overlay');
      assert.equal(layer.renderLayer, true, 'the abovePlayer layer really is a RenderLayer instance');
      assert.equal(layer.visible, true, 'the lifted container is visible too');

      scene.exit();
    } finally {
      Reflect.deleteProperty(FakeContainer, 'module');
    }
  });

  it('lets a caller hide and show a layer by name, and reports the layer it could not find', () => {
    const fixture = makeFixture();
    installFixture(fixture);
    const scene = makeScene(fixture, { farm: 0 });
    scene.enter();

    assert.equal(scene.setLayerVisible('farm', false), true, 'a known layer is found and hidden');
    assert.equal(findLayer(fixture, 'farm').visible, false, 'the named layer is hidden');

    assert.equal(scene.setLayerVisible('farm', true), true, 'the same layer can be shown again');
    assert.equal(findLayer(fixture, 'farm').visible, true, 'a caller can make a layer visible again');

    assert.equal(scene.setLayerVisible('scenery', false), false, 'an unknown layer is reported as not found');

    scene.exit();
  });
});

// --------------------------------------------------------------------------------------
// Defect B: restore only your own change
// --------------------------------------------------------------------------------------

describe('WorldScene.exit: restores only the change it made', () => {
  it('leaves a value written by someone else after we entered exactly as they wrote it', () => {
    const fixture = makeFixture();
    installFixture(fixture);
    const scene = makeScene(fixture, { farm: 0 });

    // The tile's `draw` is the slot with three distinct values (the original, the wrapper this scene
    // installs, and a third body that is neither), and that is what makes a stale restore observable. A
    // boolean `visible` has only two values, so "we restored our stale previous" and "their write
    // survived" can coincide and the defect hides.
    const original = fixture.tile.draw;
    assert.equal(typeof original, 'function', 'the tile starts with a draw function of its own');

    assert.equal(scene.enter(), true, 'the scene entered the world it was pointed at');
    const wrapper = fixture.tile.draw;
    assert.notEqual(wrapper, original, 'entering suppressed the game’s tile draw with a wrapper of its own');

    // Another body writes the same slot after us, whether a second scene over this node or an exiting
    // scene that entered before us.
    const foreign = (): void => {
      // A draw installed by something that is not this scene.
    };
    fixture.tile.draw = foreign;

    scene.exit();

    assert.equal(
      fixture.tile.draw,
      foreign,
      'exit() must not clobber a write this scene did not make (DESIGN §6 I2)',
    );
  });

  it('restores a slot it wrote and nobody else touched', () => {
    const fixture = makeFixture();
    installFixture(fixture);
    const scene = makeScene(fixture, { farm: 0 });

    assert.equal(fixture.tile.visible, true, 'the tile starts visible');
    scene.enter();
    assert.equal(fixture.tile.visible, false, 'entering hid the tile');

    scene.exit();

    assert.equal(fixture.tile.visible, true, 'the ordinary path restores the exact previous value');
    assert.equal(fixture.ui.visible, true, 'every recorded slot is restored, not just the first');
    assert.equal(ownLayerCount(fixture), 0, 'the layer containers are detached on exit');
    assert.equal(scene.isEntered, false, 'the scene is no longer entered');
  });

  it('restores the `draw` wrapper it installed on the ordinary path', () => {
    const fixture = makeFixture();
    installFixture(fixture);
    const scene = makeScene(fixture, { farm: 0 });

    const original = fixture.tile.draw;
    scene.enter();
    assert.notEqual(fixture.tile.draw, original, 'entering suppresses the game tile draw with a wrapper');

    scene.exit();
    assert.equal(fixture.tile.draw, original, 'the wrapper it installed is replaced by the original');
  });
});

// --------------------------------------------------------------------------------------
// The pet predicate is the shared one
// --------------------------------------------------------------------------------------

describe('WorldScene.penPets: the shared Rive-host predicate', () => {
  it('pens a pet that is a callable Rive host, which the deleted private copy rejected', () => {
    // The drift this pins is behavioural. `ctors.ts`'s `isRiveLike` accepts objects *and* callables
    // (`isObject` is `typeof 'object' || typeof 'function'`); `world.ts`'s private `isRiveHostLike`
    // rejected anything whose `typeof` was not `'object'`. A callable pet carrying `artboard` was
    // therefore skipped, and a skipped real host means the feature silently does nothing.
    //
    // The pet hangs off `ui` rather than off the world itself on purpose: `hideUnderlying` hides the
    // world's own immediate children, so a direct child would be `visible = false` either way and the
    // assertion would pass for the wrong reason. Only a pet deeper in the subtree can be reached by
    // `penPets`'s `findNode` walk, and that is what makes this discriminate.
    const fixture = makeFixture();
    const pet = Object.assign(
      (): void => {
        // A callable node, which is the shape a minified Rive host can take.
      },
      { artboard: {}, visible: true },
    );
    fixture.ui.addChild?.(pet as unknown as PixiDisplayObject);
    installFixture(fixture);
    const scene = makeScene(fixture, { farm: 0 });

    assert.equal(scene.enter(), true, 'the scene entered the world it was pointed at');
    assert.equal(
      pet.visible,
      false,
      'a callable Rive host is a pet, so penPets must hide it (the old predicate returned false here)',
    );

    scene.exit();
  });
});

// --------------------------------------------------------------------------------------
// asGraphics: the narrowing form of the one predicate
// --------------------------------------------------------------------------------------

describe('asGraphics: never throws on a value that is not a Graphics', () => {
  it('answers null for anything that is not a Graphics, including null itself', () => {
    // Before the delegation this threw: `world.ts` dereferenced `.clear` with no receiver guard, while
    // `isGraphicsLike` (the predicate it was duplicating) guarded first. The declared return type and
    // the "convenience" doc already promised `null`, so the throw was the bug.
    assert.equal(asGraphics(null as unknown as PixiDisplayObject), null);
    assert.equal(asGraphics(undefined as unknown as PixiDisplayObject), null);
    assert.equal(asGraphics({} as unknown as PixiDisplayObject), null);
    assert.equal(
      asGraphics({ clear: () => undefined } as unknown as PixiDisplayObject),
      null,
      '`clear` alone is not the public Graphics API',
    );
    assert.equal(
      asGraphics({ clear: () => undefined, roundRect: () => undefined } as unknown as PixiDisplayObject) !==
        null,
      true,
    );
  });
});

// --------------------------------------------------------------------------------------
// Renderer recreation (Phase 7 Task 7.4, plus audit 08 §2)
// --------------------------------------------------------------------------------------

/** A rive-like node deep enough in the subtree that `hideUnderlying` cannot be why it is hidden. */
function petNode(): { artboard: object; visible: boolean } {
  return { artboard: {}, visible: true };
}

describe('WorldScene: the game replaces its renderer', () => {
  it('pens every pet in the subtree, not only the first', () => {
    // Audit 08 §2: `penPets` used `findNode`, which stops at the first match, so a farm with more than one
    // Rive host left the rest on their claimed tiles. The predicate was never the problem. The *walk* was.
    // Two pets, both deeper than the world's own children so `hideUnderlying` cannot explain either.
    const fixture = makeFixture();
    const first = petNode();
    const second = petNode();
    fixture.ui.addChild?.(first as unknown as PixiDisplayObject);
    fixture.ui.addChild?.(second as unknown as PixiDisplayObject);
    installFixture(fixture);
    const scene = makeScene(fixture, { farm: 0 });

    assert.equal(scene.enter(), true);
    assert.equal(first.visible, false, 'the first pet must be penned');
    assert.equal(second.visible, false, 'a second pet must be penned too, not left on its tiles');

    scene.exit();
  });

  it('rebuilds onto a replaced stage root', () => {
    // The capability the audit asked for: a WebGL context loss gives the game a new renderer, and a scene
    // holding the old tree paints into nothing. This scene is built without a `stage` option, so it resolves
    // the captured root, which is the only shape that *can* observe a replacement, because a
    // caller-supplied stage is deliberate and kept.
    const first = makeFixture();
    installFixture(first);
    const scene = new WorldScene(
      { owner: 'world-test', layers: { farm: 0 } },
      { worldLabel: WORLD_LABEL, onError: (operation) => first.errors.push(operation) },
    );

    assert.equal(scene.enter(), true);
    assert.equal(ownLayerCount(first), 1, 'the scene laid its layer into the original world');

    // The replacement: a fresh tree becomes the captured root.
    const second = makeFixture();
    resetCtorCache();
    setStageRoot(second.stage);

    scene.sync();

    assert.equal(
      ownLayerCount(second),
      1,
      'sync() must rebuild onto the new root rather than keep painting into the old one',
    );
    assert.equal(ownLayerCount(first), 0, 'the old tree must be unwound, not left with our layers in it');
    // This does not assert `sync()`'s geometry: this fixture's world exposes no grid fields, so
    // `readGeometry` returns `null` for it by design, and a non-null assertion here would be a statement
    // about the fake rather than about the rebuild. The layer counts above are what distinguish a rebuild
    // from a scene that kept painting into the discarded tree.
    assert.deepEqual(first.errors, [], 'the rebuild must not report a failure it recovered from');

    scene.exit();
  });

  it('adopts a caller-supplied stage when told to', () => {
    // A scene built *with* a stage cannot detect a replacement: the override is deliberate, and it wins
    // over the captured root. So recovery there is explicit: `rebuild(stage)` is how a caller hands over
    // the new tree. Without an argument the override stands.
    const first = makeFixture();
    installFixture(first);
    const scene = makeScene(first, { farm: 0 });

    assert.equal(scene.enter(), true);
    assert.equal(ownLayerCount(first), 1);

    const second = makeFixture();
    resetCtorCache();
    setStageRoot(second.stage);

    // The captured root moved, but this scene was pointed at `first` on purpose, so nothing happens.
    scene.sync();
    assert.equal(ownLayerCount(first), 1, 'an explicit stage must not be abandoned implicitly');
    assert.equal(ownLayerCount(second), 0, 'and the scene must not silently follow the captured root');

    // Handed the new stage, it moves.
    assert.equal(scene.rebuild(second.stage), true, 'rebuild(stage) must report that it did the work');
    assert.equal(ownLayerCount(second), 1, 'rebuild(stage) must lay the scene into the stage it was given');
    assert.equal(ownLayerCount(first), 0, 'and unwind the stage it left');

    scene.exit();
  });
});
