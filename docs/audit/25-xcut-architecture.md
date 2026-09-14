# Cross-cutting architecture audit: mg.js

Repo. Scope: whole repo (`packages/*/src`, `package.json`s, tsconfigs). Method: read the three
clients end to end; AST import-graph extraction (91 files / 413 edges) + Tarjan SCC; two targeted `tsc`
compiles; `tsc -b --force --listFilesOnly`; `npm ls --workspaces`. Every citation was opened and quoted.

---

## 1. The four clients are not one library; they are four dialects (high, api-design, breaking: yes)

There are **four** client-shaped classes. They share no interface and diverge on every axis a caller touches.

| | `ClientCore` | `HeadlessClient` | `RoomSocket` | `BootstrappedClient` |
|---|---|---|---|---|
| start | (ctor, `common/src/client.ts:154`) | `connect(): Promise<void>` `headless/src/client.ts:528` | `connect(opts): Promise<string>` `room-socket.ts:112` | `install(): this` `bootstrapped/src/client.ts:361` |
| ready | `waitUntilReady(ms?)` `:274` | `waitUntilReady()` `:545` | `waitUntilReady()` `:173` | `ready(): Promise<Attachment>` `:440` |
| stop | `dispose()` `:205` | `disconnect()` `:556` + `destroy()` `:587` | `disconnect()` `:153` + `destroy()` `:178` | `uninstall()` `:635` |
| events | `on/once/off/emit` (`Emitter`) | own `on` `:473` + `onCore` `:506` | `on(ClientEvents)` `:312` + 9 `onX` `:256-300` | **none**; must use `client.core.on` |
| identity | `selfPlayerId: string\|null` | `selfPlayerId: string\|null` `:370` | `playerId: string` → `''` `:198` | `selfPlayerId: string\|null` `:292` |
| diagnostics | `stats` (typed) `:254` | `stats: Record<string,unknown>` `:452` | `stats: Record<string,unknown>` `:247` | `report(): BootstrapReport` `:794` |

**1a. `HeadlessClient` re-implements `Emitter`.** `common/src/emitter.ts:14` exports `Emitter`; `HeadlessClient` hand-rolls the same `Map<key, Set<listener>>` at `headless/src/client.ts:271` with its own `on`/`once`/`emit` (`:473`, `:489`, `:982`), differing only in that `emit` logs instead of swallowing (`:992`). `Emitter`'s only consumer in the repo is `ClientCore` (`common/src/client.ts:133`). Fix: `extends Emitter<HeadlessClientEvents>`.

**1b. Two live subscription surfaces collide.** `HeadlessClientEvents` (`:138-159`) declares `open: []`, `ready: []`, `close: [HeadlessCloseEvent]`; `ClientEvents` (`common/src/client.ts:58-74`) declares the same three names with `close: [TransportCloseInfo]`. `:743` forwards core `ready` through `this.emit('ready')`, so `on('ready')` and `onCore('ready')` are two names for one fact while `on('close')` and `onCore('close')` carry different payload types. Fix: `HeadlessClientEvents extends ClientEvents`; delete `onCore`.

**1c. Client errors bypass the taxonomy.** `common/src/errors.ts:4-6` claims *"Every failure this package can produce is a named class."* `HeadlessClient.requireCore` (`:975-977`) throws bare `new Error(...)` for the condition `MgNotReadyError` (`errors.ts:124`) exists for; `room-socket.ts:114-117` and `:168` do the same.

**Target shape.** Breaking pre-1.0 is allowed, so add to `common/src/client.ts`:
`export interface MgClient<TEvents extends ClientEvents> { start(): Promise<void>; stop(): Promise<void>;
ready(signal?: AbortSignal): Promise<void>; on<K extends keyof TEvents>(e: K, l: Listener<TEvents[K]>): Unsubscribe;
readonly isReady: boolean; readonly selfPlayerId: string | null; readonly stats: MgClientStats }`, implemented by
all four. Renames: `install`→`start`, `uninstall`→`stop`, `RoomSocket.playerId`→`selfPlayerId`; `BootstrappedClient`
keeps its `Attachment` on a new `install(): Promise<Attachment>`.

---

## 2. `WorldScene.enter()` hides the host world and its own layers never become visible (critical, correctness)

`packages/bootstrapped/src/render/world.ts:480` sets `container.visible = false;` on every layer container it
creates and `:493` attaches it. `grep -n visible` over the file shows the **only** writes are `:480`, `:535`,
`:607`, all `false`; there is no `visible = true` anywhere in `packages/bootstrapped/src` outside
`graphics.ts:171-172`. `addSprite` (`:399`) adds into that invisible container, so the whole documented
`RenderFacade`/`addSprite` surface renders nothing.

The same method also contradicts its own comment. `:528-530` asserts *"Only the world container's own immediate
tile-ish children ... hiding the avatar or the UI systems would be a much larger claim"*, but `:531-536` is
`for (const child of children) { if (child === null) continue; if (this.isOwnLayer(child)) continue;
recordAndSet(this.restores, child as Record<string, unknown>, 'visible', false); }`, with no tile predicate.
`enter()` (`:246-264`) runs this against the live game world, so entering a scene hides every non-own immediate
child with nothing drawn in its place. Fix: apply `collectTileViews`' predicate (`:820`) to immediate children
and set `container.visible = true` when the first sprite lands, restoring the prior value on `exit()`.

Independently checkable, same file: `removeSprite` (`:414-425`) calls `node.destroy?.({children: true})` even when `index < 0`, destroying nodes the scene does not own; `penPets` (`:604-607`) uses `findNode` (DFS pre-order, limit 4 000) so it pens exactly **one** node although the header says "Herd active pets", and the player avatar is itself a Rive host. No test imports `render/world`: 968 lines, the largest file in the repo, zero coverage.

---

## 3. `common`'s HARD RULE is unenforced and already violated (high, architecture, breaking: yes)

`packages/common/src/index.ts:6` claims common *"never opens a socket and never touches a DOM."*
`packages/common/src/catalog/http.ts:66` calls the global `fetch`; `:55` constructs an `AbortController`;
`:56`/`:107` use `setTimeout`/`clearTimeout`. `FetchJsonOptions` (`:16-23`) has **no transport member**, so it
is not injectable; it is public API via `catalog/index.ts:35` → `index.ts:18`, and ships into the userscript
because `PlatformApiSource` is instantiated at `headless/src/version.ts:154`. `platform-source.ts:31-35` also
hardcodes `PLATFORM_PATHS` and `:73` the origin `https://magicgarden.gg`.

Nobody noticed because of the build config: `tsconfig.base.json:5` is
`"lib": ["ES2022", "DOM", "DOM.Iterable"]`, inherited by **all three** packages, and
`packages/common/tsconfig.json` sets no `lib` and no `types`, so `@types/node` is auto-included too. Compiling
`packages/common/src` with `lib:["ES2022"], types:[]` yields 23 errors at 21 sites (`http.ts:20,55,56,66,107,112`;
`client.ts:123,277,282,380,422`; `state/store.ts:236,243,247,259`; `log.ts:45,48`; `connect-url.ts:57`;
`id.ts:18,52`), against zero under the current config. The typechecker cannot catch a platform breach in common.
Fix: `packages/common/tsconfig.json` gains `"lib": ["ES2022"], "types": []` plus a CI job running
`tsc -b packages/common`; then move `catalog/http.ts` + `catalog/platform-source.ts` out of common behind an
injected `type FetchJson = (url: string, options?: FetchJsonOptions) => Promise<unknown>` on `CatalogSource`.

*The other half of the rule holds:* common declares **no** `dependencies`; `common/src` has **0** `node:*` and
**0** `ws` imports; headless↔bootstrapped have **0** edges.

---

## 4. `npm run typecheck` checks none of the 21 test files (high, tests)

`tsconfig.json:4-8` references the three packages, and each package `tsconfig.json` sets
`"include": ["src/**/*.ts"]`. `npx tsc -b --force --listFilesOnly | grep -c "tests/"` returns **0**, so the
verification gate never sees a test; tests run through `tsx`, which strips types without checking them.

The intent existed: `packages/headless/tsconfig.test.json` is **tracked by git** and sets
`"include": ["src/**/*.ts", "tests/**/*.ts"]`, `"types": ["node"]`, `"noEmit": true`, referenced by no
tsconfig, no `references` entry and no npm script. Running it now fails:

```
npx tsc -p packages/headless/tsconfig.test.json
packages/headless/tests/integration.test.ts(502,28): error TS2339: Property 'superseded' does not exist on type 'never'.
packages/headless/tests/integration.test.ts(503,28): error TS2339: Property 'delayMs' does not exist on type 'never'.
```

Fix: add a `tsconfig.test.json` per package modelled on the orphan, reference all three from the root
`tsconfig.json`, point `typecheck` at them, and repair the two `never` narrowings at `integration.test.ts:502-503`.

---

## 5. The workspace graph is broken, and the scripts bypass the exports map to cope (high, architecture)

`package-lock.json` records one workspace: `:468` is the sole `node_modules/@mg.js/*` entry, `:1102` the sole
`packages/*` entry. `npm ls --workspaces --depth=0` prints only `@mg.js/common`; `node_modules/@mg.js/`
contains only a `common` symlink; `require.resolve('@mg.js/headless')` throws `MODULE_NOT_FOUND`. The README's
documented imports (`README.md:94`, `:105`, `:135`) do not resolve in this checkout.

Because the bare specifiers are unavailable, the root dev scripts reach into `src`:
`scripts/verify-live-socket.ts:47` `'../packages/headless/src/client.js'`, `:48` `'.../auth/guest.js'`, `:49`
`'../packages/common/src/log.js'`, and `scripts/verify-live.ts:13-16` four `'../packages/common/src/catalog/*.js'`.
These are the only 7 `../..` escapes in the repo (`packages/*/src` and `packages/*/tests` are clean) and they are
not merely untidy: `headless/src/client.ts:83` resolves `@mg.js/common` to `packages/common/dist` while the
script resolves `./packages/common/src/log.js` to the **source**, so one process holds two independent copies of
common: `createLogger`/`MemoryLogSink` fail identity comparison across the seam, module singletons such as
`DEFAULT_REGISTRY` (`protocol/forms.ts:538`) diverge, and `isMgError`/`instanceof` checks silently return false.
Fix: regenerate the lockfile so all three workspaces link, switch the scripts to `'@mg.js/headless'` /
`'@mg.js/common'`, and add the missing `./reconnect`, `./version`, `./auth` subpaths; all 6 declared `common`
subpaths and both `headless` subpaths are currently unused, since all 22 cross-package edges use the bare specifier.

---

## 6. Duplicated platform plumbing (medium, duplication)

- `coexistence/renumber.ts:546` `applyRenumbering(data, renumberer)` and `client.ts:973` `applyRenumberingToString(data, renumberer)` do the same job from two files. The client copy drops `renumber.ts`'s cheap guards (`:552` `data.length < 16`, `:553` `includes('QuinoaCommand')`) so it `JSON.parse`s every outbound string; its extra `isOurs` check (`:977`) is redundant because `rewrite` returns `action:'ours'` untouched (`:334-337`). `client.ts:968` admits the duplication. Fix: delete `applyRenumberingToString`, export and call `applyRenumbering`.
- `world.ts:877-895 detachNode` ≡ `render/text.ts:199 detach` (already imported by `graphics.ts:42`); `world.ts:870-874 isRiveHostLike` ≡ `ctors.ts:374 isRiveLike`; `world.ts:964-968 asGraphics` ≡ `ctors.ts:435 isGraphicsLike`; the warn-once helper (`world.ts:940-955`) is a third copy of `graphics.ts:274-287` and `rive.ts:432-450`.

---

## 7. Documented behaviour the code does not have (medium, docs)

- `README.md:145` `await client.render.getCtors()`: `RenderFacade` (`bootstrapped/src/client.ts:140-162`) has
  no `getCtors`; it is `client.render.stage.getCtors()` (`pixi.ts:306`), as `index.ts:33` correctly shows.
- `headless/src/client.ts:201` says reconnect "falls back to `DEFAULT_RECONNECT`". That constant
  (`common/src/protocol/types.ts:287`) has **zero consumers**: only its definition and the barrel re-export
  `protocol/index.ts:27`. The real fallback is `reconnect.ts:247` `DEFAULT_RECONNECT_POLICY`, a second literal
  whose doc (`reconnect.ts:44`) claims the two "cannot drift" with nothing enforcing it.
- `raw-socket.ts:173/504` `asOutboundString` is documented "Exported for the rewriter and for tests" with no
  call site and no test; `bootstrapped/src/client.ts:988 emptyCatalogSource` has no caller and is absent from
  the barrel (`index.ts:48`); `socket.removeEventListener` (`raw-socket.ts:75`) is never called, so the two
  anonymous listeners installed at `:235`/`:269` survive `release()` (`:443-464`).

---

## 8. The four big files: responsibilities and the seam

**`headless/src/client.ts` (1025).** Option normalisation `:162-338`; core facade `:340-466`; hand-rolled
events `:468-514`; lifecycle `:516-592`; connection establishment (version → runtime → headers → URL → core →
handshake) `:594-778`; close classification, supersession and backoff `:787-955`; URL helpers `:998-1025`.
**Split:** `connection.ts` = a `ConnectAttempt` owning `:604-778`; `supersession.ts` = the
`pendingSupersession`/`reclaimSupersededNext`/`confirmSupersededReconnect`/`awaitReconnect` machine `:814-905`
(~140 pure lines); `client.ts` keeps facade + lifecycle, extends `Emitter`.

**`bootstrapped/src/client.ts` (994).** Facade/accessors `:267-348`; install/ready/uninstall `:350-695`;
coexistence wiring `:697-792`; report/namespace `:794-909`; envelope helpers `:910-994`. **Split:**
`attach/lifecycle.ts`, `coexistence/wiring.ts` (absorbing the §6 fix), `envelope.ts`; `client.ts` keeps the facade.

**`bootstrapped/src/render/world.ts` (968).** Lifecycle `:208-355`; layers `:432-499`; tile suppression
`:501-518`; hide/restore `:520-545`; cinematic policy `:162-176`, `:547-594`; pets `:596-620`; sprite ledger
`:369-430`, `:627-637`; container discovery `:639-684`; geometry `:695-766`; ctor recovery `:768-797`; display
utils `:799-895`; texture cache `:897-938`. **Split:** `world/scene.ts`, `world/geometry.ts`,
`world/cinematic.ts`, `world/restore.ts`; delete-and-re-import per §6; add `tests/world.test.ts`.

**`bootstrapped/src/attach/room-connection.ts` (920).** Seam types `:47-193`; probing `:203-210`, `:882-920`;
frame normalisation `:757-830`; binding `:294-755`; sink wiring `:832-880`. Teardown is the best in the repo:
`release()` `:723-751` restores wrapped methods via identity-guarded `hookReleases` (`:425` →
`brand.ts:249,255-258`), drains `subscriptions` `:726-732` (pushed `:464`/`:500`/`:537`), and installs no timers
or globals (`:205` is a read). Two gaps: no tombstone (`grep -n released` → `:327,724,725`), so `send` `:601`,
`sendNow` `:625`, `subscribeToRoomFrames` `:662` and `sink()` `:676` stay live with `outbound` cleared `:746`
and `activeRewriter` nulled `:750`, so a post-release frame leaves **unnumbered**, the exact "frozen game"
failure the module exists to prevent; and `:749` clears `lastFrontier` while `lastSelfPlayerId` `:339`,
`lastFullState` `:341` and `sawWelcome` `:351` survive into a later stand-in welcome. `:770-780` also
re-implements common's `extractPatches` tolerance (`protocol/codec.ts:108-115`), which its own comment `:760-762`
says must agree. **Split:** `attach/room-connection/{object,frames,binding,sink}.ts` plus a shared
`attach/sink.ts` holding `AttachedSink`/`AttachKind`, since `raw-socket.ts:381` implements the same interface.

---

## What works well here

- **The dependency graph is clean**: 0 cycles across 91 files / 413 edges, 22 cross-package edges all
  `@mg.js/common`, 0 headless↔bootstrapped edges, 0 `node:*` and 0 `ws` imports inside any `packages/*/src`,
  and `common` declares no `dependencies` at all, so the protocol → state → actions → client layering holds.
- **Ack correlation is honest rather than guessed**: three explicit modes with `confirmed`/`matchMethod`
  (`common/src/client.ts:49-74`), and `ClientCoreOptions.store` (`:86-101`) documents the reconnect
  store-identity trap it exists to prevent.
- **`room-connection.ts` teardown is the strongest in the repo**: identity-guarded method restoration via
  `brand.ts:249 restoreSlot`, reverse-order subscription draining, no timers or globals to leak.
- **The userscript packaging constraint is enforced, not aspirational**: esbuild `format:'iife'`,
  `platform:'browser'`, banner-as-metadata (`scripts/build.ts:114-134`), and `build-output.test.ts:143`
  asserts the artifact carries no Node built-in specifier.
- **`ReconnectPolicy` keeps `random` injectable** (`reconnect.ts:79`, `:244`) where `common` hardcodes
  `Math.random`/`Date.now`; the right pattern already exists here and should be propagated.
