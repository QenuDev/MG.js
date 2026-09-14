# Audit 09 of `bootstrapped/render/{rive,sprite,graphics,text}.ts` + `storage.ts`

Scope: `packages/bootstrapped/src/render/rive.ts`, `sprite.ts`, `graphics.ts`, `text.ts`,
`packages/bootstrapped/src/storage.ts`. Callers were checked with `grep` across `packages/**` (excluding `dist/`).
One suspected bug (the `updateText` style merge) was **executed against the real Pixi bundles** and disproved.
See "Checked and cleared" below. `packages/bootstrapped/tests/` contains only `attach`, `build-output`,
`catalog-sources`, `coexistence`, `ctors` and `room-upgrade` tests: **none of the five files in this scope has
a test file**, so every finding below is currently unguarded.

---

## F1: `TypedStorage.clear()` is a silent no-op on the `gm` backend (high, correctness)

`createGmBackend`'s `keys()` returns `[]` unconditionally (`storage.ts:193-198`, with the comment that GM
enumeration "is impossible"), and `TypedStorage.clear()` is implemented as
`const keys = backend.keys(); for (const key of keys) backend.removeRaw(key); return keys.length;`
(`storage.ts:392-396`). On the GM backend that loop iterates zero times and returns `0`.

The shipped userscript always lands on that backend: the metadata banner grants `GM_getValue`/`GM_setValue`
(`scripts/build.ts:86-87`, asserted by `tests/build-output.test.ts:106-107`) and `selectBackend` prefers GM over
`localStorage` whenever the API resolves (`storage.ts:424-425`). `removeRaw` cannot fully compensate either: the
banner does **not** grant `GM_deleteValue`, so the delete branch (`storage.ts:182-185`) is dead in production and
every removal falls through to the tombstone write `api.setValue(prefix + key, null)` (`storage.ts:188`), which
`getRaw` maps back to absent (`storage.ts:166`) but which is never enumerable and never reclaimed. The comment
claiming "Tampermonkey has no `GM_deleteValue`" (`storage.ts:126`, `:186`) is also factually wrong. The API is
documented and declared in the repo's own `@types/tampermonkey` (`node_modules/@types/tampermonkey/index.d.ts:862`).

Why it matters: any caller that resets mod settings, or switches account/profile, is told `0` keys were removed
while every value survives in GM storage and is no longer enumerable by the library. The one destructive API in
the module therefore reports success on the one backend it cannot act on. `clear()` and `keys()` have no in-repo
caller (`client.ts:227,370-377,809-811` uses only `backend`, `durable` and `probeStorage`), so nothing in the
repo exercises it today.

Fix: keep a key index. In `storage.ts`, make the GM backend track its own keys, e.g. an index stored under
`prefix + '__index__'` written by `setRaw(key: string, value: string): void` and pruned by
`removeRaw(key: string): void`, and have `keys(): string[]` return it. Add `// @grant GM_deleteValue` to the
banner in `scripts/build.ts` so `removeRaw` really deletes instead of tombstoning. Breaking: **no** (no exported
name, signature or type changes).

## F2: `RiveRegistry.clear()` forgets tags but leaves the host map populated (medium, correctness)

`clear()` is documented as "Forget everything" (`rive.ts:508`) but only clears `byTag`
(`rive.ts:509-511`), while its sibling `unregister` deletes from both maps
(`rive.ts:494-506`: `byTag` at `:497` and `byHost` at `:502`). Since `byHost` is a `WeakMap` keyed by the Pixi
container (`rive.ts:467`), a `clear()` leaves every wrapper reachable through
`findByHost(host: PixiDisplayObject): RiveArtboard | null` (`rive.ts:484-486`) for as long as the game's
container lives, which for UI containers is the page's lifetime.

Two consequences, both checkable in the same class: the registry's public surface contradicts itself
(`unregister` removes both keys, `clear` removes one), and `RiveArtboard.destroy(): void` (`rive.ts:336-338`)
only calls `destroyOverlays()`. It never unregisters, so the strong `byTag` `Map` (`rive.ts:466`) is an
unbounded registry that holds artboard wrappers and their overlay `Set` (`rive.ts:131`) until a caller
remembers to call `unregister` manually.

Why it matters: a caller that resets the registry after the game rebuilds a room gets stale wrappers back from
the host lookup and will keep driving (and keeping alive) artboards that belong to a discarded scene; overlay
Text nodes stay referenced with them.

Fix: in `rive.ts` drop the `readonly` on the private `byHost` field and reset it, e.g.
`clear(): void { this.byTag.clear(); this.byHost = new WeakMap<object, RiveArtboard>(); }`, and document that
`byTag` growth is the caller's responsibility (or have `destroy(): void` take an optional registry). Breaking:
**no** (the reset itself touches no exported declaration).

## F3: A `Text` node created for an overlay/label leaks when `addChild` throws (medium, correctness)

`RiveArtboard.addOverlayText(create, options)` calls the caller's factory (`rive.ts:263`), then
`host.addChild(node)` inside a `try` whose `catch` reports the failure and returns `null`
(`rive.ts:277-282`), so `node` is never destroyed. `createTextOver(TextCtor, target, options)` has the same
shape: `const node = createTextSync(...)` (`text.ts:237`) then `parent.addChild(node)` whose `catch`
returns `null` (`text.ts:241-245`). Both helpers exist precisely for hosts that "frequently [are] not a
container and adding a child to it is either a silent no-op or a throw" (`text.ts:223-225`), i.e. the throwing
path is the anticipated one.

The leak repeats, because the documented caller loop is `create` → attach → retry next frame for a label whose
host rejected it: each attempt allocates a Pixi `Text` with its own canvas-backed texture. Related, same class:
`removeOverlayText(node: PixiText): boolean` detaches the node (`rive.ts:327-329`) and drops it from the
`overlays` set, so a later `destroyOverlays()` (`rive.ts:309-316`) can no longer free it, and nothing in the
wrapper destroys it.

Why it matters: a canvas-backed `Text` texture is not freed by dropping the reference. This is the
"create once, destroy explicitly" rule the module header states (`text.ts:13-14`), so a rejected host turns
into unbounded GPU/canvas allocation at frame rate.

Fix: destroy the node in both catch blocks, e.g. in `rive.ts`'s
`addOverlayText(create: (host: PixiDisplayObject) => PixiText | null, options: { x?: number; y?: number; zIndex?: number } = {}): PixiText | null`
call `destroyText(node)` before `this.report(...)`, and do the same in `text.ts`'s
`createTextOver(TextCtor: new (...args: unknown[]) => PixiText, target: PixiDisplayObject, options: CreateTextOptions): PixiText | null`;
have `removeOverlayText` route through `destroyText(node)` too. Breaking: **no**.

## F4: Texture cache is unbounded and a re-decode orphans the replaced texture (medium, correctness)

`createTextureCache()` is a plain `Map` with no maximum, no eviction and no size accessor
(`sprite.ts:75-97`), justified in the header as "unbounded rather than LRU because the realistic key count is
'the handful of icons this mod draws'" (`sprite.ts:58-61`). Nothing enforces that: `textureFrom`'s default key
is the caller's source string (`sprite.ts:141`), and the documented key for the interesting case is the base64
payload itself (`sprite.ts:25-27`), so a mod that decodes per-asset data URLs grows one
`{ texture, width, height, useCount }` per asset for the page's lifetime.

Worse, the `refresh` path replaces the entry without any release: with `refresh: true` the cache read is
skipped (`sprite.ts:143`) and the new entry is written over the old key at `sprite.ts:170`, so the previous
`PixiTexture` becomes unreachable with no handle left to destroy it. `TextureCache.release(key, destroy = false)`
(`sprite.ts:82-94`) defaults to *not* destroying, so the obvious cleanup call also leaks the GPU texture.

Two documentation/consistency defects sit on top of this: the header tells the reader to "call
`releaseTexture`" (`sprite.ts:60`) and that this cache "is the *only* texture creation path in this package"
(`sprite.ts:17-18`). `releaseTexture` does not exist anywhere in the repo (grep over `packages/**` and
`docs/`), and `world.ts:900-909`'s `textureFromImage` is a second, `sharedTextures`-bypassing construction path
with the same three-route logic as `constructTexture` (`sprite.ts:180-202`).

Why it matters: the module exists to prevent repeated GPU uploads; an unbounded map plus an orphaned texture per
refresh reintroduces the memory growth it documents as unacceptable, and the named cleanup function a
consumer would reach for is missing.

Fix: in `sprite.ts` accept a bound, `createTextureCache(options: { maxEntries?: number } = {}): TextureCache`,
that evicts (and destroys) the oldest entries and destroys the replaced texture when `cache.set` overwrites an
existing key, make `release(key: string, destroy = true)` the default, and add the referenced
`releaseTexture(cache: TextureCache, key: string, destroy?: boolean): boolean`. Breaking: **no** (all additive).

## F5: `TypedStorage.set()` cannot report a write that was swallowed (medium, api-design)

`set<T>(key: string, value: T): T` returns the value it was given (`storage.ts:372-385`), while the write itself
is best-effort: `createGmBackend.setRaw` swallows refusals (`storage.ts:171-179`) and
`createWebStorageBackend.setRaw` swallows `QuotaExceededError` (`storage.ts:215-221`). The docstring says it
"does not claim success it cannot verify" (`storage.ts:299-305`), but returning `T` is precisely
that claim for any caller that chains or logs the result, and the only detection facility in the package is
`probeStorage` (`storage.ts:443-453`), which runs once at install (`client.ts:375`) and writes a probe key whose
`remove` leaves a GM tombstone (`storage.ts:188`).

Why it matters: a settings panel that reflects `set()`'s return value shows "saved" while nothing persisted on
the backend the userscript actually uses. That is the silent-configuration-loss path.

Fix: change the exported signature in `storage.ts` to
`set<T>(key: string, value: T): boolean` (write, read back, compare `JSON.stringify`, `console.warn` on
mismatch) and add `setOrThrow<T>(key: string, value: T): T` for callers that want the value; keep `get`/`getOrNull`
as they are. Breaking: **yes** (published return type changes).

---

## Checked and cleared (not findings)

- **`updateText`'s style merge** (`text.ts:165`, `node.style = { ...node.style, ...style }`) was the prime
  suspect: spreading a live `TextStyle` instance looks like it copies build-private fields (`_fontSize`,
  `_fontFamily`, ...) instead of style keys. Executed against the real bundles: Pixi 7.4.2's
  `TextStyle(style)` runs `deepCopyProperties(this, style, style)` (`dist/pixi.mjs:21028-21031`), i.e. it
  ranges over the *source's* own keys, so the `_`-prefixed backing fields are copied back by name and existing
  style survives: `new TextStyle({...base, fontSize: 20})` kept `fontFamily='Arial'`, `strokeThickness=3`,
  `align='center'`. Not a bug on v7 (the version the module header names) and the v8 bundle behaves the same way
  for the copied keys.
- `DEFAULT_TEXT_STYLE` (`text.ts:42-50`) is exported mutable, but no in-repo caller mutates it and
  `createTextSync` copies it (`text.ts:111`); `graphics.ts` likewise copies every field into a per-badge
  `ResolvedBadgeStyle` (`graphics.ts:230-238`) instead of sharing `DEFAULT_BADGE_STYLE` (`graphics.ts:71-79`).
- `applyAnchor` (`text.ts:132-141`) correctly prefers `ObservablePoint.set` over direct field writes, and
  `detach` (`text.ts:199-217`) tries the safe `removeChildren` form before the throwing `removeChild`.

## What works well here

- Nothing in these modules can throw into the game's render loop: `Badge.update`/`setVisible`/`destroy`
  (`graphics.ts:134-200`), `RiveArtboard.report` (`rive.ts:360-366`) and `updateText`/`destroyText`
  (`text.ts:160-171`, `:181-190`) all wrap and return a value, which matches the recon's "an exception here
  corrupts the game's UI rebuild" rule.
- The "unsupported" vs "fault" split for Rive is modelled honestly: `RiveFailure.unsupported`
  (`rive.ts:84-99`) plus the narrow `looksLikeMissingRun` message check (`rive.ts:412-424`) instead of
  fabricating an error class the docs never define, with a warn-once default handler (`rive.ts:432-445`).
- Warn-once memos are exported for tests as explicit resets (`resetWarnOnce` `graphics.ts:286`,
  `resetRiveWarnings` `rive.ts:448`, `resetWorldWarnings` `world.ts:954`), so the pattern is consistent.
- `storage.ts` keeps the hard rule clean (no `node:*`, no DOM globals, no new dependency), scopes `clear()` to
  the prefix instead of `localStorage.clear()` (`storage.ts:311-317`), exposes `durable: false` for the memory
  backend (`storage.ts:250-252`) and self-tests round-tripping through `probeStorage` (`storage.ts:443-453`).
- `constructTexture` (`sprite.ts:180-202`) tries `Texture.from` → `new Texture(source)` → `new Texture({source})`
  and lets the last failure surface, rather than guessing the Pixi major; `loadImageSource` (`sprite.ts:216-242`)
  prefers `decode()` and resolves the page's `Image` through the realm.
