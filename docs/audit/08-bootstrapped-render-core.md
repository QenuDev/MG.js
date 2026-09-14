# Audit 08: `packages/bootstrapped/src/render/` (`world.ts`, `ctors.ts`, `pixi.ts`) + `realm.ts`

Read in full: `world.ts` (968), `ctors.ts` (881), `pixi.ts` (352), `realm.ts` (386). Neighbours
(`sprite.ts`, `graphics.ts`, `text.ts`) were read only where these four call into them. Every "no other
caller" claim below was checked with grep across `packages/bootstrapped/**`.

Pixi-version note up front: I found **no** v7-only API use. `roundRect`/`fill`/`stroke` are used
exclusively (`graphics.ts:150-153`, `ctors.ts:133-142`); `beginFill`/`endFill`/`lineStyle` appear nowhere in
the package. The version risks here are the opposite kind: v8's API applied to v8 *semantics* it did not
account for (findings 1 and 3).

## 1. Every `WorldScene` layer container is created permanently invisible, so no scene can ever show a sprite (critical)

`world.ts:480` (`buildLayers`) and `world.ts:399` (`addSprite`):

```ts
478        container.label = `${this.sceneId}/${name}`;
479        container.zIndex = zIndex;
480        container.visible = false;
...
399      layer.container.addChild?.(sprite);
```

`visible = false` here is **not** recorded in `this.restores`: it is a bare assignment, unlike every other
mutation of a game-owned object in this file, which goes through `recordAndSet` (`world.ts:856-867`).
Nothing else in the package ever sets a layer container visible again: `grep -rn "visible" packages/bootstrapped/src`
returns only `world.ts:480`, `world.ts:535`, `world.ts:607` and `graphics.ts:171-172`, and there is no
`setLayerVisible`/`showLayer`/`visible = true` anywhere. `isOwnLayer` (`world.ts:540-545`) also
makes `hideUnderlying` *skip* those containers (`world.ts:534`), so they are never re-evaluated either.

Effect: `addSprite` adds the sprite to a container with `visible === false`, so it and all its children are
culled by Pixi forever. `hideUnderlying` correctly hides the tiles, so `enter()` produces a blank farm with
nothing drawn on it. The module's entire purpose (§18's "temporarily takes over the player's own farm
tiles to draw something else on them") is unreachable. There is no test covering this: `grep -rn "WorldScene\|addSprite" packages/bootstrapped/tests/*.ts`
matches only a comment in `build-output.test.ts:128`, so 490 green tests say nothing about it.

Fix: the layer's *initial* visibility is ours to choose, so make it visible and let only the game's nodes be
restored: replace `world.ts:480` with `container.visible = true;` (nothing to record, since the container
is created and destroyed by this scene at `world.ts:493` / `world.ts:304-312`). If a caller needs a layer
hidden later, add `WorldScene.setLayerVisible(name: string, visible: boolean): boolean` which records the
previous value through the existing `recordAndSet(this.restores, ...)` so `exit()` still restores it.

## 2. `penPets` hides exactly one node, so the farm's pets stay on the claimed tiles (high)

`world.ts:604-608`:

```ts
605    const pets = PixiStage.findNode?.(world, (node) => isRiveHostLike(node), 4_000) ?? null;
606    if (pets === null) return;
607    recordAndSet(this.restores, pets as Record<string, unknown>, 'visible', false);
```

`findNode` is documented and implemented as "the first node the predicate accepts, or `null`"
(`ctors.ts:467-468`, early `return node` at `ctors.ts:497`), a finder rather than a collector, while the
collector `findAllNodes` already exists in this package (`ctors.ts:532-560`). §18's fifth responsibility,
quoted in this file's own header at `world.ts:28`, is to "herd active pet**s** out of the affected tiles
for the duration". A farm with three pets leaves two rendering on top of the overlay; because
`destroyOwned`/`exit` only unwind what `restores` holds, the un-hidden pets are then never "let back in" in
any sense: they were never moved, so the pair of methods silently under-delivers in both directions.

Fix: in `world.ts:604`, replace the `findNode` call with `collectTileViews`'s sibling shape, reusing
`PixiStage.findNode` only after narrowing the root, or (cleaner) add
`WorldScene.penPets(): number` implemented over `findAllNodes(world, isRiveHostLike, 64)` from
`ctors.ts:532`, filtering out any node that is an ancestor of another match, and calling
`recordAndSet(this.restores, node, 'visible', false)` for each. Return the count so tests can assert >1.

## 3. The per-image texture cache hands back a texture the scene already destroyed (high)

`world.ts:905-938` and `world.ts:414-425`:

```ts
905  const imageTextures = new WeakMap<object, PixiTexture>();
...
911    const cached = imageTextures.get(image);
912    if (cached !== undefined) return cached;   // returned even if it is dead
...
421      node.destroy?.({ children: true });      // destroys the Sprite, not the texture
```

`imageTextures` has no invalidation path: not a `delete` in this file, not a clear-on-recreation hook,
not an eviction in `removeSprite` (`world.ts:414-425`) or `destroyOwned` (`world.ts:627-637`). So the
documented "pieces come and go during play" flow at `world.ts:408-413` is broken: `addSprite(image)`,
`removeSprite(sprite)`, `addSprite(image)` returns the *first* texture object, which Pixi has already
released along with the sprite subtree, and the second sprite renders nothing (or throws inside Pixi's
render pipe, in the game's frame). The same cache is also stale-by-construction after a WebGL context loss,
where §2.7 (`pixi.ts:26-34`) says the renderer and every texture it uploaded are rebuilt.

Count that against the fact that a texture made here is never released at all: `addSprite`'s sprites are
destroyed with `destroy?.({ children: true })` (`world.ts:631`), never `{ texture: true }`, so each image
the caller passes leaks its GPU upload for the life of the page. The `WeakMap` that keeps it alive is keyed
by the image, i.e. exactly as long as the caller's own image reference lives.

Fix: stop treating the cache as append-only. Add a module function
`export function invalidateImageTexture(image: object): void` next to `world.ts:905` that deletes the entry,
call it from `removeSprite` and `destroyOwned` after `node.destroy`, and expose
`export function resetImageTextures(): void` (called from the `wasRecreation` path; see finding 4) that
re-creates the WeakMap. Then a sprite this module created can be destroyed with
`node.destroy?.({ children: true, texture: true })` at `world.ts:631` because the cache no longer points at
the corpse.

## 4. `WorldScene` never reacts to renderer recreation: `worldContainer` and every layer outlive the stage (medium)

`client.ts:405-419` is the only `onEvent` handler in the package:

```ts
407        onEvent: (event) => {
408          if (!event.wasRecreation) return;
...
412          this.logger.warn('the renderer was recreated (WebGL context loss); mod-owned nodes are stale');
413          try {
414            this.options.onRendererRecreated?.();
```

`pixi.ts:337` documents the contract as "**Drop the ctor/root caches. Call this from `capture`'s `onEvent`
when `wasRecreation` is true**". The handler calls `resetCtorCache` only via the internal wrappers
(`pixi.ts:212`, `pixi.ts:219`), whose effect is invisible to consumers; the application-level listener
never resets and nothing tells a live `WorldScene`. After the recreation that
`pixi.ts:26-34` calls "the single most underestimated fact about living in this renderer", a scene that was
entered keeps `entered = true` (`world.ts:262`), a `worldContainer` pointing into the destroyed stage
(`world.ts:254`), and layer containers that no longer exist in any render tree. `sync()` (`world.ts:331-351`)
only re-resolves the world when `!this.entered && this.worldContainer === null`, so it happily returns
geometry derived from the dead container forever, and `addSprite` keeps pushing into a detached container.
For a Tampermonkey script whose whole install story is "run at document-start and survive backgrounding
(`pixi.ts:26-34`)", that is a permanent silent breakage after the first context loss: the mod's overlay
never comes back and the tiles it suppressed are never restored.

Fix: give the scene a rebuild entry point and call it from the handler:
`WorldScene.rebuild(stage?: PixiDisplayObject | null): boolean` that runs `exit()` (restores the game's
properties on the dead objects, harmless) and then re-resolves `this.worldContainer` via
`findWorldContainer()` and re-`enter()`s; `sync()` should pre-check `this.entered && this.worldContainer !== null && this.worldContainer.parent === undefined && this.worldContainer !== PixiStage.stage`
to self-heal. In `client.ts:407`, call `resetCtorCache()` alongside the warning, before user callbacks.

## 5. `GetCtorsOptions.page` is declared, documented and never read; the polling chain cannot be cancelled (medium)

`ctors.ts:238-239` vs the whole of `getCtors` (`ctors.ts:814-866`):

```ts
238  /** Explicit root override for the Graphics lookup, if the caller has one. */
239  page?: PageRealm | null;
```

`page` appears nowhere else in the file (`grep -n "page" packages/bootstrapped/src/render/ctors.ts` → only
the import at `:48-49`, this declaration, and the `getPage()` call at `:797`), so `defaultSchedule` ignores
it and always resolves the *ambient* page (`ctors.ts:797`). A test or non-browser host that supplies
`{ page }` gets `unsafeWindow`/`globalThis` scheduling anyway, and the field's JSDoc ("root override for the
Graphics lookup") describes something no code does. The same option bag already has `stage` for that.

The same loop is unbounded on the way out: `attempt` (`ctors.ts:837-862`) schedules itself with
`schedule(attempt)` (`ctors.ts:861`) and returns early on resolve/reject (`:848`, `:859`) *without* any
cancellation, and `defaultSchedule` (`ctors.ts:792-804`) neither retains the `requestAnimationFrame` id nor
the `setTimeout` handle. An abandoned `getCtors()` promise (the normal case when the caller has already
given up, or when `getCtors` was called defensively and the page never rendered text) keeps running one
full `deriveCtors` stage walk per frame for the remainder of the 15 s deadline (`ctors.ts:815`); each walk
is up to `DEFAULT_FIND_LIMIT` 25 000 nodes (`ctors.ts:454`, `:646-647`). Call it a few times and the page
pays several redundant tree walks per frame.

Fix: make the option real or delete it, and add cancellation:
`function defaultSchedule(callback: () => void): () => void` in `ctors.ts:792` returning a cancel function
(`cancelAnimationFrame` off the same page object, `clearTimeout` otherwise), with `GetCtorsOptions` gaining
`schedule: (callback: () => void) => () => void` and `getCtors` holding `let cancel: (() => void) | null`
that `set` before `schedule(attempt)` and calls in both terminal branches. Thread `options.page` into
`defaultSchedule(page)` at `ctors.ts:816` so an injected page is actually used.

## Smaller, still checkable

- `world.ts:790`: `if (holder === null || typeof holder !== 'object') continue;` runs before
  `holder['RenderLayer']`, but `findRenderLayerCtor`'s own `holders` list is seeded with
  `containerCtor` (`world.ts:783`), a **function** (`typeof === 'function'`), so the fast path always
  `continue`s and only the `module`/`exports`/`default`/`PIXI` string keys added at `world.ts:785-788` are
  ever inspected. The comment at `world.ts:773-775` says a recovered `Container` "may carry sibling
  references" directly. Fix: `if (holder === null || (typeof holder !== 'object' && typeof holder !== 'function')) continue;`.
  This never produces a *wrong* layer (the result is still type-checked at `world.ts:792`), so it is a
  silent degradation to the zIndex fallback that `world.ts:482-491` then reports: a misleading diagnostic
  rather than a crash.
- `realm.ts:63-96`: the interface's own comment says "Every field is optional on read because a *different*
  build of this package may have created the namespace first", but `hooks` and `teardowns` are declared
  non-optional and `getNamespace` only structural-checks `marker`/`version` (`realm.ts:205-209`). A
  namespace written by another build that matches those two fields but has no `hooks` makes
  `onNamespaceEvent` throw at `realm.ts:302` (`handlers.add` on `undefined`) and `onTeardown` throw at
  `realm.ts:372`, from inside `install()`. Fix: `readonly hooks?: Map<...>` / `readonly teardowns?: Array<...>`
  plus `const hooks = namespace.hooks ?? (namespace.hooks = new Map())` in `getNamespace`.
- `getCtors` mutates global state from an explicit-stage call: `ctors.ts:818` does `setStageRoot(explicitStage)`
  before the fast path, so a one-shot `getCtors({ stage: someOtherTree })` silently re-points
  `PixiStage.stage`, and so `WorldScene.findWorldContainer` (`world.ts:654`), for the rest of the page.

## What works well here

- The init-hook wrappers (`pixi.ts:176-225`) call the displaced hook *first* inside a `try`, then record, so
  a devtools hook that throws cannot stop the capture; release is identity-guarded per slot
  (`pixi.ts:241-248`) and restores the previous value rather than `undefined`.
- `recordAndWrapNoop` (`world.ts:840-853`) gets the `wasAbsent` / own-property-vs-prototype distinction
  right: the difference between restoring the tile `draw` and leaving an own-property no-op shadowing the
  prototype after every teardown.
- `findNode` / `findAllNodes` are iterative with an explicit stack, a visited `Set` for mid-mutation cycles
  and a hard node budget (`ctors.ts:470-514`), with every predicate call individually `try`/`catch`ed.
- `realm.ts` resolves the page through one function, never at module load (`realm.ts:39-42`, `:172-180`),
  reads `unsafeWindow` as a property rather than naming it (`realm.ts:145-152`), and returns `null` where a
  throw would make the library unimportable in Node.
- `readGeometry` (`world.ts:708-744`) refuses to fabricate a tile size and returns `null` instead; the
  failure it avoids (sprites silently landing in the wrong place) is far worse than the one it takes.
