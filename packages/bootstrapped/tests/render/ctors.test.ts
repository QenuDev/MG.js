/**
 * `PixiCtors` accessor tests, against fake stages.
 *
 * ## Why fakes rather than a real stage
 *
 * Two reasons, and only the second is about convenience.
 *
 *   1. There is no real stage in Node. A test that needed one could not run in CI at all.
 *   2. The second reason is substantive. The property under test is a *discrimination*: a genuine Pixi `Text`
 *      must be chosen and a Rive-backed node that also exposes `.text`/`.style` must be rejected. The recon
 *      flags that as the misidentification where a node "would otherwise get misidentified, and Rive's
 *      constructor throws on Pixi-style args", so the test needs a decoy to test against, and the decoy has
 *      to be *constructed*, not found.
 *
 * The fake nodes carry a `constructor` whose `name` is set, because that is the only thing `deriveCtors` reads
 * off a node beyond the duck-typed members, and it is what a real minified Pixi build still provides.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PixiDisplayObject } from '../../src/render/ctors.ts';
import {
  DEFAULT_FIND_LIMIT,
  deriveCtors,
  findAllNodes,
  findByLabel,
  findNode,
  getCtors,
  hasCoreCtorSet,
  hasFullCtorSet,
  isGraphicsLike,
  isRiveLike,
  isSpriteLike,
  isTextLike,
  isUnrecoveredStub,
  resetCtorCache,
  setStageRoot,
  tryGetCtors,
} from '../../src/render/ctors.ts';

// --------------------------------------------------------------------------------------
// Fake Pixi classes
// --------------------------------------------------------------------------------------

/** A named constructor, since a minified Pixi build still exposes a name via `.name`. */
function namedClass<T extends object>(name: string, init: Partial<T>): new (...args: unknown[]) => T {
  const Ctor = function FakeNode(this: T): void {
    Object.assign(this, init);
  };
  Object.defineProperty(Ctor, 'name', { value: name });
  return Ctor as unknown as new (
    ...args: unknown[]
  ) => T;
}

/**
 * Real classes, not `{ constructor: ... }` literals.
 *
 * This matters: `deriveCtors` reads `.constructor` and requires it to be *callable*, because a constructor it
 * hands to a mod will be invoked with `new`. A fake whose `.constructor` is a plain object exercises a path no
 * real build takes, and would have hidden the fact that `Texture`/`Rectangle` recovery needs a genuine class on
 * the far side of the text.
 */
class FakeRectangle {
  x = 0;
  y = 0;
  width = 16;
  height = 16;
}

class FakeTexture {
  width = 16;
  height = 16;
  frame = new FakeRectangle();
}

const FakeContainer = namedClass<PixiDisplayObject>('Container', { children: [], addChild: () => undefined });
const FakeSprite = namedClass<PixiDisplayObject>('Sprite', {
  texture: new FakeTexture(),
  anchor: { x: 0.5, y: 0.5 },
});
const FakeText = namedClass<PixiDisplayObject>('Text', {
  text: 'hello',
  style: { fontFamily: 'Arial', fontSize: 14 },
  renderPipeId: 'text',
});
/**
 * The decoy: a Rive-backed node.
 *
 * It carries `.text` and `.style`, the two members a naive check would accept, and its minified constructor
 * name contains "Text", so even a name-based check would be fooled if the `renderPipeId` discriminant were
 * ignored. Its `.text` is an object rather than a string, and it exposes `artboard`, which is the structural
 * signal `isRiveLike` uses.
 */
const FakeRiveText = namedClass<PixiDisplayObject>('RiveTextNode', {
  text: { runs: [] },
  style: { artboardStyle: true },
  renderPipeId: 'rive',
  artboard: { id: 'pet-1' },
});
/**
 * A second decoy: the *hostile* one.
 *
 * A string `.text`, an object `.style`, a text-ish constructor name, and an `artboard`. It is designed to be
 * indistinguishable from a real Text unless `isRiveLike` is consulted *first*, which is the ordering the
 * recon's warning implies and the ordering `isTextLike` implements.
 */
const FakeRiveHostile = namedClass<PixiDisplayObject>('TextLikeRiveArtboard', {
  text: 'also looks like text',
  style: { fontFamily: 'Arial', fontSize: 12 },
  artboard: { id: 'pet-2' },
});

const FakeGraphics = namedClass<PixiDisplayObject>('Graphics', {
  clear: () => undefined,
  roundRect: () => undefined,
  rect: () => undefined,
  circle: () => undefined,
  fill: () => undefined,
  stroke: () => undefined,
});

/** Build a stage: a fake Container holding the given children. */
function makeStage(children: PixiDisplayObject[]): PixiDisplayObject {
  const stage = new FakeContainer() as PixiDisplayObject & Record<string, unknown>;
  stage.children = children;
  return stage;
}

void test('the fake ctors are distinct constructors, so a mix-up would be detectable', () => {
  assert.notEqual(new FakeText().constructor, new FakeSprite().constructor);
  assert.notEqual(new FakeText().constructor, new FakeRiveText().constructor);
});

// --------------------------------------------------------------------------------------
// Duck-typing
// --------------------------------------------------------------------------------------

void test('isTextLike accepts a genuine Text via the documented renderPipeId discriminant', () => {
  assert.equal(isTextLike(new FakeText()), true);
});

void test('isTextLike rejects a Rive node that also exposes .text and .style', () => {
  assert.equal(isTextLike(new FakeRiveText()), false);
  assert.equal(isRiveLike(new FakeRiveText()), true);
});

void test('isTextLike rejects the hostile decoy that would fool a naive check', () => {
  // This node has a string `.text`, an object `.style`, a text-ish name, and NO renderPipeId, so it reaches
  // the documented looser fallback, where the Rive check must be consulted first.
  assert.equal(isTextLike(new FakeRiveHostile()), false);
});

void test('isTextLike falls back loosely when renderPipeId is absent', () => {
  const genuine = new FakeText() as PixiDisplayObject & Record<string, unknown>;
  delete genuine['renderPipeId'];
  assert.equal(isTextLike(genuine), true);
});

void test('isTextLike rejects a node claiming a non-text render pipe', () => {
  const node = { text: 'x', style: {}, renderPipeId: 'batchable' };
  assert.equal(isTextLike(node), false);
});

void test('isSpriteLike requires a texture and an anchor, and rejects text and Rive nodes', () => {
  assert.equal(isSpriteLike(new FakeSprite()), true);
  assert.equal(isSpriteLike(new FakeText()), false);
  assert.equal(isSpriteLike(new FakeRiveText()), false);
  assert.equal(isSpriteLike({ texture: {} }), false, 'a texture without an anchor is not a Sprite');
});

void test('isGraphicsLike keys on the public roundRect/clear pair', () => {
  assert.equal(isGraphicsLike(new FakeGraphics()), true);
  // `clear` alone is not enough: several Pixi node types have it.
  assert.equal(isGraphicsLike({ clear: () => undefined }), false);
  assert.equal(isGraphicsLike({ roundRect: () => undefined }), false);
});

void test('isRiveLike accepts any one of the three Rive hosts, including an artboard-only node', () => {
  // This is the key set the other two copies in the tree were measured against: `rive.ts`'s structural
  // fallback tested only `stateMachine`/`rive`, so an artboard-only node was Rive-like here and not
  // there. The assertion passes on the code as it was at this home; the failing-first evidence for the
  // drift is `tests/render/rive.test.ts`, which is where the narrow copy lived.
  assert.equal(isRiveLike({ artboard: {} }), true);
  assert.equal(isRiveLike({ stateMachine: {} }), true);
  assert.equal(isRiveLike({ rive: {} }), true);
  assert.equal(isRiveLike({ artboard: {}, stateMachine: {}, rive: {} }), true);
  assert.equal(isRiveLike({ text: 'hi' }), false);
});

// --------------------------------------------------------------------------------------
// findNode / findByLabel
// --------------------------------------------------------------------------------------

void test('findNode walks nested children depth-first', () => {
  const deep = makeStage([makeStage([new FakeSprite()])]);
  const found = findNode(deep, (node) => isSpriteLike(node));
  assert.notEqual(found, null);
  assert.equal(found?.constructor, FakeSprite);
});

void test('findNode respects its limit and returns null rather than throwing', () => {
  const stage = makeStage([new FakeSprite()]);
  // A limit of 0 means no node is ever visited.
  assert.equal(
    findNode(stage, () => true, 0),
    null,
  );
  // A limit smaller than the depth to the sprite also fails cleanly.
  assert.equal(
    findNode(stage, (n) => isSpriteLike(n), 1),
    null,
  );
});

void test('findNode survives a cyclic child array', () => {
  // The game mutates its display list mid-frame, so a transient cycle is possible. An infinite loop inside a
  // requestAnimationFrame callback would freeze the tab.
  const a = new FakeContainer() as PixiDisplayObject & Record<string, unknown>;
  const b = new FakeContainer() as PixiDisplayObject & Record<string, unknown>;
  a['children'] = [b];
  b['children'] = [a, new FakeSprite()];
  assert.notEqual(
    findNode(a, (n) => isSpriteLike(n)),
    null,
  );
});

void test('findNode survives a predicate that throws on one node', () => {
  const stage = makeStage([{ label: 'bad' } as unknown as PixiDisplayObject, new FakeSprite()]);
  const found = findNode(stage, (node) => {
    if ((node as { label?: string }).label === 'bad') throw new Error('exotic node');
    return isSpriteLike(node);
  });
  assert.notEqual(found, null);
});

void test('findByLabel matches the authored plain-string label', () => {
  // The recon records labels like "GardenInfoCardSystem" as "by far the most stable hook point across builds".
  const card = new FakeContainer() as PixiDisplayObject & Record<string, unknown>;
  card['label'] = 'GardenInfoCardSystem';
  card['children'] = [new FakeSprite()];
  const stage = makeStage([makeStage([]), card]);

  assert.equal(findByLabel(stage, 'GardenInfoCardSystem'), card);
  assert.equal(findByLabel(stage, 'Nope'), null);
});

void test('findAllNodes collects every match', () => {
  const stage = makeStage([new FakeSprite(), makeStage([new FakeSprite()])]);
  assert.equal(findAllNodes(stage, (n) => isSpriteLike(n)).length, 2);
});

void test('the documented default find limit is 25000', () => {
  assert.equal(DEFAULT_FIND_LIMIT, 25_000);
});

// --------------------------------------------------------------------------------------
// deriveCtors
// --------------------------------------------------------------------------------------

void test('tryGetCtors returns null on an empty stage', () => {
  resetCtorCache();
  const empty = makeStage([]);
  setStageRoot(empty);
  assert.equal(tryGetCtors(), null);
});

void test('tryGetCtors returns null when the stage has a sprite but no text yet', () => {
  // The documented cold-load hazard: "Sprites render before any UI text does on a cold load, so a naive
  // 'found a sprite → done' check locks in Text: null permanently if it runs too early."
  resetCtorCache();
  setStageRoot(makeStage([new FakeSprite()]));
  assert.equal(tryGetCtors(), null);
});

void test('tryGetCtors returns a full ctor set on a populated stage', () => {
  resetCtorCache();
  const stage = makeStage([new FakeSprite(), new FakeText(), new FakeGraphics()]);
  setStageRoot(stage);

  const ctors = tryGetCtors();
  assert.notEqual(ctors, null);
  assert.equal(ctors?.Container, FakeContainer);
  assert.equal(ctors?.Sprite, FakeSprite);
  assert.equal(ctors?.Text, FakeText, 'the genuine Text must win');
  assert.equal(ctors?.Texture, FakeTexture);
  assert.equal(ctors?.Rectangle, FakeRectangle);
  // Graphics is recovered through the separate accessor, exactly as §2.7 documents, and is not one of the five.
  assert.equal(ctors?.graphics, FakeGraphics);
  assert.equal(hasFullCtorSet(ctors as NonNullable<typeof ctors>), true);
  assert.equal(hasCoreCtorSet(ctors as NonNullable<typeof ctors>), true);
});

void test('deriveCtors picks the genuine Text when a Rive decoy is present', () => {
  resetCtorCache();
  // The decoys come FIRST in the display list, so a search that accepted the first `.text`-bearing node would
  // pick one of them. That ordering is the reason the test exists.
  const stage = makeStage([new FakeRiveText(), new FakeRiveHostile(), new FakeSprite(), new FakeText()]);

  const ctors = deriveCtors(stage);
  assert.notEqual(ctors, null);
  assert.equal(ctors?.Text, FakeText);
  assert.notEqual(ctors?.Text, FakeRiveText);
  assert.notEqual(ctors?.Text, FakeRiveHostile);
});

void test('deriveCtors returns null when only Rive decoys and a sprite are present', () => {
  // No genuine text node: null, so the caller polls. Caching a Rive constructor as `Text` would produce a
  // constructor that "throws on Pixi-shaped arguments" the first time a mod called `new Text(...)`.
  const stage = makeStage([new FakeSprite(), new FakeRiveText(), new FakeRiveHostile()]);
  assert.equal(deriveCtors(stage), null);
});

void test('deriveCtors returns null on a non-container', () => {
  assert.equal(deriveCtors(null), null);
  assert.equal(deriveCtors({}), null);
  assert.equal(deriveCtors(new FakeSprite()), null);
});

void test('deriveCtors refuses a set where Sprite and Text collapsed to one constructor', () => {
  // A node that satisfies both duck types means the discrimination failed. Handing back a set whose `Sprite`
  // and `Text` are the same constructor would silently create the wrong object type.
  const ambiguous = namedClass<PixiDisplayObject>('Ambiguous', {
    texture: {
      width: 8,
      height: 8,
      frame: { constructor: { name: 'Rect' } },
      constructor: { name: 'Texture' },
    },
    anchor: { x: 0, y: 0 },
    text: 'x',
    style: {},
    renderPipeId: 'text',
  });
  const stage = makeStage([new ambiguous()]);
  assert.equal(deriveCtors(stage), null);
});

// --------------------------------------------------------------------------------------
// Caching
// --------------------------------------------------------------------------------------

void test('the ctor set is cached per stage, so a re-derivation does not re-walk', () => {
  resetCtorCache();
  const stage = makeStage([new FakeSprite(), new FakeText()]);
  setStageRoot(stage);
  const first = tryGetCtors();
  const second = tryGetCtors();
  assert.notEqual(first, null);
  // Referentially identical: the second call returned the cached object rather than walking the tree again.
  assert.equal(first, second);
});

void test('a new stage root is re-derived rather than served from the old cache', () => {
  // This is what makes a WebGL context loss safe: the renderer rebuild produces a new stage, which is a
  // different cache key, so nothing stale is served.
  resetCtorCache();
  setStageRoot(makeStage([new FakeSprite(), new FakeText()]));
  assert.notEqual(tryGetCtors(), null);

  const replacement = makeStage([new FakeSprite(), new FakeText(), new FakeGraphics()]);
  setStageRoot(replacement);
  const derived = tryGetCtors();
  assert.notEqual(derived, null);
  assert.equal(derived?.graphics, FakeGraphics);
});

void test('a build with no reachable Texture/Rectangle gets a throwing stub, not undefined', () => {
  // `Texture` and `Rectangle` are the two of the documented five that are recovered *opportunistically*, from
  // a live sprite's texture, its `.frame`, or a node's `bounds`, rather than by duck-typing a node that is
  // definitely of that type. A build whose textures come out of a factory closure can therefore expose neither.
  //
  // The node keeps a real constructor by design (it is a plain object, so the recovered `Texture` cannot be
  // inherited from it), while its `.texture` has its `constructor` explicitly `undefined`. That closes the walk
  // at the texture itself: `constructorOf(texture.source)` and `constructorOf(texture.baseTexture)` are both
  // `undefined` too, so there is no `Texture` to recover and no `frame` to recover a `Rectangle` from.
  //
  // It must keep a real constructor because `deriveCtors` legitimately refuses a set whose `Sprite` could not be
  // recovered at all. A sprite node with no constructor is a detection failure, not a missing Texture.
  resetCtorCache();
  // A class, so the node's *inherited* constructor is a real function (the walk needs a genuine `Sprite`
  // constructor to accept the set at all), while its own `.texture` is an object carrying
  // `constructor: undefined`, the shape a factory-produced texture has, and what stops both
  // recovery routes.
  class BareSprite {
    anchor = { x: 0, y: 0 };
    texture: Record<string, unknown> = {
      constructor: undefined,
      source: undefined,
      baseTexture: undefined,
      frame: undefined,
    };
  }
  const ctors = deriveCtors(makeStage([new BareSprite() as unknown as PixiDisplayObject, new FakeText()]));
  assert.notEqual(ctors, null);
  assert.equal(
    isUnrecoveredStub((ctors as NonNullable<typeof ctors>).Texture),
    true,
    'with no reachable Texture instance, the field must be a throwing stub',
  );
  assert.equal(hasFullCtorSet(ctors as NonNullable<typeof ctors>), false);
  // The core set is still usable: a text-only mod must not be blocked on a Texture it will never construct.
  assert.equal(hasCoreCtorSet(ctors as NonNullable<typeof ctors>), true);

  // And the stub fails with a sentence naming the constructor, not with a bare "undefined is not a
  // constructor" two call frames later.
  assert.throws(() => new (ctors as NonNullable<typeof ctors>).Texture(), /could not be recovered/);
  assert.throws(() => new (ctors as NonNullable<typeof ctors>).Rectangle(), /could not be recovered/);
});

void test('a real Texture instance anywhere in the tree is enough to recover the constructor', () => {
  // The counterpart to the test above, and the reason the stub is rare in practice: one ordinary textured sprite
  // anywhere in the stage supplies both the Texture and the Rectangle.
  resetCtorCache();
  const ctors = deriveCtors(makeStage([new FakeSprite(), new FakeText()]));
  assert.equal(ctors?.Texture, FakeTexture);
  assert.equal(ctors?.Rectangle, FakeRectangle);
  assert.equal(isUnrecoveredStub(ctors?.Texture), false);
});

// --------------------------------------------------------------------------------------
// The async poll
// --------------------------------------------------------------------------------------

void test('getCtors resolves from an explicit stage without scheduling a frame', async () => {
  resetCtorCache();
  const stage = makeStage([new FakeSprite(), new FakeText(), new FakeGraphics()]);
  let scheduled = 0;
  const ctors = await getCtors({
    stage,
    schedule: () => {
      scheduled += 1;
    },
  });
  assert.equal(ctors.Text, FakeText);
  assert.equal(scheduled, 0, 'a resolvable stage must not schedule a retry');
});

void test('getCtors polls until the stage has both a sprite and a genuine text node', async () => {
  resetCtorCache();
  // Start with only a sprite, then add the text node on the second "frame".
  const stage = makeStage([new FakeSprite()]);
  let attempts = 0;
  let pending: (() => void) | null = null;

  const promise = getCtors({
    stage,
    timeoutMs: 5_000,
    schedule: (callback) => {
      pending = callback;
      // Run the queued retry on a microtask so the test does not need a clock.
      queueMicrotask(() => {
        attempts += 1;
        if (attempts === 1) {
          stage.children = [new FakeSprite(), new FakeText()];
        }
        callback();
      });
    },
  });

  const ctors = await promise;
  assert.equal(ctors.Text, FakeText);
  assert.equal(attempts >= 1, true);
  void pending;
});

void test('getCtors rejects with a diagnosable error when nothing is ever rendered', async () => {
  resetCtorCache();
  const stage = makeStage([]);
  await assert.rejects(
    () =>
      getCtors({
        stage,
        timeoutMs: 0,
        schedule: () => {
          // Never retry: the timeout is 0, so the first attempt is also the last.
        },
      }),
    /could not recover the Pixi constructor set within 0ms/,
  );
});
