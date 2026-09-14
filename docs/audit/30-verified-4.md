# Adversarial verification: findings batch 4

Every `path:line` below was opened in this session (`read`/`sed -n` on the working tree, plus repo-wide
grep for callers and for `removeEventListener`, `texture: true`, `.clear()`). Verdicts and severities are
mine; one claim is refuted and one has the wrong severity.

## 1. `current` assigned for every socket before the room-URL filter (CONFIRMED, high)

Opened: `packages/bootstrapped/src/attach/raw-socket.ts:221-232` (`current = socket` at 228, `urlFilter`
return at 232), `:234-271` (message listener 235, close listener 269-270), `:384-395` (`canSend`),
`:397-406` (`sendRaw`), `:443-464` (`release`).

True: `attach` writes `current = socket` at 228 for **every** constructed socket, then returns at 232
when the URL lacks `/api/rooms/`. The only close listener (`if (current === socket) current = null`) is
installed at 269-270 *after* that return, so the socket that clobbered `current` can never clear it, and
`canSend` (384) / `sendRaw` (397) read `current` unfiltered. The header names this exact failure
(:18-20, :229-231): "let a later one - anything at all - take the place of the game connection and
quietly carry our commands nowhere", and the code does it anyway. Once the unrelated socket closes,
`current` points at a CLOSED socket and `canSend()` stays false until some *later* socket is
constructed, so "for the rest of the session" is usual, not guaranteed.

Fix: move `current = socket` below the `urlFilter` test so only the adopted room socket is recorded; the
existing close listener then covers it.

## 2. Stand-in Welcome not latched (CONFIRMED, high), worse than reported

Opened: `attach/room-connection.ts:468-502` (gate 479, real welcome 504-513), `:635-653`,
`attach/transport.ts:152-168`, `packages/common/src/client.ts:542-567`,
`packages/common/src/protocol/sequencer.ts:295-306`.

True: `sawWelcome` is set in exactly one place, the real welcome subscription (:513); nothing sets it on
a stand-in dispatch, and no dedupe exists downstream, because `transport.ts:152-168` re-frames every
`WelcomeEvent` straight into `messageHandlers`, reaching `ClientCore.handleWelcome`. On the
missed-Welcome build the module's own docstring describes, the stand-in is permanent: every patch whose
`fullState` is present re-emits one, i.e. `store.replaceRoot` plus `welcome`/`state`/`ready` at patch
rate (client.ts:556, 564-566).

Understated: `handleWelcome` also calls `sequencer.seed` (client.ts:547), and `seed` (sequencer.ts:302-306)
reseeds `nextValue = executedCommandSequence + 1` **and clears the outstanding ledger**. The stand-in's
sequence is `lastFrontier`, the high-water of *observed* frontiers, which lags numbers already issued
but not yet executed, so a mid-session reseed can move the counter backwards onto a used number (the
"duplicate ... dropped without a word" hazard sequencer.ts:1-10 documents) and wipes the ledger the
`DroppedStale` inference is built from. That is a command-loss path, not only event churn.

Fix: add `let standInDelivered = false;` beside `sawWelcome`, set it when a stand-in is dispatched, so at
most one Welcome reaches the core; keep recording `lastFullState` (the patches already re-base the store).

## 3. `release()` never removes the socket listeners (CONFIRMED, high)

Opened: `raw-socket.ts:235`, `:269` (both `addEventListener` calls), `:443-464` (`release`), `:75`
(`removeEventListener` in the `SocketLike` type); grep over `packages/bootstrapped/{src,tests}` finds no
call site of `removeEventListener`.

True: `release()` restores the instance `send` hooks (447-455), the `WebSocket` constructor, and clears
`frameHandlers`/`welcomeHandlers` (460-461), but both listener closures stay attached to the *host*
socket forever, and both are anonymous arrows, so they are not removable as written. The host socket
keeps running `scrapeFrame(data)` (237) per frame, paying the cost that the gating at `:40-43` exists to
avoid, and keeps the binding graph alive. `release()` is a live path (`client.ts:663`). Impact is a
listener/memory leak plus per-frame CPU, not data loss.

Fix: have `bindRawSocket` collect `() => socket.removeEventListener?.('message', onMessage)` and the
`close` equivalent into an array, run it reversed in `release()` beside the existing restores.

## 4. `penPets` hides exactly one pet (CONFIRMED, high), impact is visual

Opened: `render/world.ts:597-617` (`findNode` 605, `recordAndSet` 607, empty `releasePets` 617),
`world.ts:28` (§18 "Herd active pets ... out"), `world.ts:870-874` (`isRiveHostLike`),
`render/ctors.ts:467-497`, `:532-560`.

True: `findNode` returns on the first accepted node (ctors.ts:481-497, documented 467-468), so `penPets`
records exactly one `visible = false`; there is no pet loop and no render test file pinning this. With
several pets all but one stay drawn over the scene. Caveat: `findNode` is pre-order from the world
container, so the single match may be an ancestor of several pets (over-hiding) rather than one pet:
either outcome is wrong and is not what §18 asks for. Harm is visual, not data loss.

Fix: implement `penPets` over `findAllNodes(world, isRiveHostLike, 64)` (ctors.ts:532), skipping any
match that is an ancestor of another match, and `recordAndSet` per pet so `exit()`'s unwind restores each.

## 5. `imageTextures` returns a destroyed texture (REFUTED, low)

Opened: `world.ts:394-399` (`addSprite` → `textureFromImage`), `:408-425` (`removeSprite`, destroy at
421), `:626-635` (`destroyOwned`, destroy at 631), `:899-938` (`imageTextures` 905, `.set` 936),
`ctors.ts:70`, `render/sprite.ts:76-95`.

True: the premise is false. Nothing in the module destroys a texture, because both destroy sites pass only
`{ children: true }` (421, 631), and `ctors.ts:70` types `texture?: boolean` as a *separate* option no
call site supplies. Under both Pixi majors `Container/Sprite.destroy({children:true})` destroys children,
not their textures, so the cache only ever returns a live texture and add → remove → add redraws
correctly. Nor is eviction a practical problem: the WeakMap is keyed by the `<img>` the game already
holds, entries die with the image, and `Texture.from` may cache the texture in Pixi anyway. The "leaks
after a WebGL context loss" clause is unsupported by anything in the tree. The recommendation is
actively dangerous: `texture: true` at 631 would destroy a texture that Pixi's `Texture.from` cache, and
possibly the game, still references. The only real, minor gap: `sharedTextures` exposes
`release(key, destroy)` (sprite.ts:81-93) while this cache exposes nothing.

## 6. `TypedStorage.clear()` silent no-op on gm (PARTIAL, medium, not high)

Opened: `storage.ts:392-396` (`clear`), `:193-198` (`keys` returning `[]`), `:156-190`
(`createGmBackend`), `:311` (interface doc), `:182-184`, `:308-318`;
`packages/bootstrapped/scripts/build.ts:85-87`; grep for `.clear()` on the store.

True: the mechanism is exactly as reported. `clear()` iterates `backend.keys()` and returns
`keys.length`, the gm backend's `keys()` is hard-coded `[]`, so on the Tampermonkey build `clear()`
removes nothing and reports `0`. Supporting facts check out: no storage test file, and the metadata
block grants only `unsafeWindow`/`GM_getValue`/`GM_setValue`, so `api.deleteValue` is always `undefined`
and `removeRaw` falls back to the null sentinel (183-189). The comment at 182-184 ("Tampermonkey has no
`GM_deleteValue`") is wrong, because it has it; this script does not grant it.

Correction: severity high is overstated. The gm limitation of `keys()` *is* documented in the exported
interface ("Empty for the gm backend, see the note there", :311), `clear()` has no caller under
`packages/*/src` (no reset or account-switch path exists), and no data is lost: values survive, the safe
direction. It is a latent public-API contract defect that will bite the first external caller.

Fix (still worth doing): back the gm backend with a `prefix + '__index__'` key maintained by
`setRaw`/`removeRaw` so `keys()`/`clear()` are honest, add `@grant GM_deleteValue` at build.ts:85-87,
and delete the false claim at storage.ts:182-184.
