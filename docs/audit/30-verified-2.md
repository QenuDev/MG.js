# Adversarial verification: findings batch 2

Every cited line was opened by me in this session; behavioural claims were reproduced by running the built
`packages/common/dist` with `node --input-type=module` (probe output quoted verbatim).

## 1. No hostile-input test; `/__proto__` patch paths pollute Object.prototype: CONFIRMED (critical)

Opened: `packages/common/src/state/pointer.ts:17-28`, `packages/common/src/state/patch.ts:175-183`,
`patch.ts:219`, `patch.ts:260`. Grep: zero `__proto__` hits in `packages/*/tests` and `packages/*/src`.

What is true: the headline claim reproduces. `applyPatch({}, [{op:'add', path:'/__proto__/pwned/inner',
value:1}])` → `applied 0`, `outcomes[0].error = 'Parent path "/__proto__/pwned" does not exist.'`, yet
`Object.prototype.hasOwnProperty('pwned') === true` and `for (const k in {})` yields `['pwned']`:
realm-wide, enumerable pollution from an operation the library reports as failed. Same through
`JsonPatch.apply` and through `/data/__proto__/pwned2/inner`; and `packages/common/tests/patch.test.ts` has
no hostile-input case (grep).

Where the finding's evidence is wrong: the polluting line is not `patch.ts:260`
(`parent.value[key] = patch.value`, the leaf write; with key `__proto__` it only swaps one node's
prototype) but `patch.ts:177-180` in `ensureContainer`: `record[token]` reads the inherited prototype and
`record[token] = slot` (180) writes onto it. The path needs ≥3 tokens so the walk reaches
`Object.prototype` and *creates* a slot there. `pointer.ts:24-27` accepting the token is a true enabler.

Corrected fix: reject `__proto__`, `constructor` and `prototype` tokens inside `parsePointer`
(`pointer.ts:24-27`, one guard that covers `resolvePointer` and `applyOperation`) and add the hostile-input
test to `packages/common/tests/patch.test.ts`. Exporting `isUnsafeToken` is optional.

## 2. WorldScene.enter() hides the host world while its own layers are created permanently invisible: CONFIRMED (critical)

Opened: `packages/bootstrapped/src/render/world.ts:246-264`, `:369-406`, `:453-499`, `:513-537`.
Grep `visible` over all of `packages/bootstrapped/src`: the only writers in this file are `:480` (false),
`:535` (false), `:607` (false); the only other package writer is `graphics.ts:168-172` (`setVisible` on an
unrelated overlay object). No `visible = true`, no `setLayerVisible`, no unhide path; `layerStates` is
private and exposes no container accessor.

What is true: every layer container is created `visible = false` (480) and `addSprite` parents each sprite
into exactly that container (`:399`), so an owned sprite can never be drawn. `hideUnderlying`
(`:527-536`) hides *every* non-own immediate child while its own comment (`:528-529`) says it must be
limited to "tile-ish children" because "hiding the avatar or the UI systems would be a much larger claim", yet
the tile predicate exists (`collectTileViews`, used at `:514`) and is not applied. Net effect: the located
`GardenWorld(System)` group goes blank while entered. `ls packages/bootstrapped/tests` shows no
`world.test.ts`.

Corrected fix: set `container.visible = true` at `:480` and cover it in a new `tests/world.test.ts`; in
`hideUnderlying`, skip children with no tile views (`collectTileViews(child, 32).length === 0`) before the
recorded `visible = false` at `:535`.

## 3. room/version unencoded in the connect-URL path: PARTIAL (real bug, medium not high)

Opened: `packages/common/src/protocol/connect-url.ts:50-78` (interpolation at `:57`), `id.ts:50-66`,
`packages/common/tests/connect-url.test.ts:26-31`, `packages/headless/src/version.ts:120-127`.

What is true: `:57` interpolates `options.version` and `room` into the path with no validation and no
encoding. Reproduced exactly: room `abc&x=1#frag` →
`wss://magicgarden.gg/version/1157/api/rooms/abc&x=1?...&clientVisibilityState=%22visible%22#frag/connect`
(`new URL(url).pathname === '/version/1157/api/rooms/abc&x=1'`, hash `#frag/connect`), so `/connect` is
swallowed and every reconnect rebuilds the same broken URL. Version `11/57?x` likewise re-parses the path,
and version is network-sourced with only a non-empty-string check (`version.ts:120-127`), so it is not
charset-constrained either.

Overstated: "re-target the URL". Both values sit after the authority, so neither can change host, port or
scheme, and no credential is exposed (`appendAuthQuery` still lands in the query). The normal path is safe:
`randomRoomSlug()` (`id.ts:50-66`) emits `[a-z0-9]`, the documented slug shape.

Corrected fix: as proposed, `safePathSegment(name, value)` in `connect-url.ts` rejecting `/ ? # %` and
whitespace (else `encodeURIComponent`), applied to `version` and `room` at `:57`, with tests. Severity
medium (input validation/robustness), not high.

## 4. applyPatch throws on a malformed patch path instead of reporting a failed op: CONFIRMED (high)

Opened: `packages/common/src/state/patch.ts:218-219`, `:443-490`, `packages/common/src/state/pointer.ts:20-22`,
`packages/common/src/client.ts:492-540` (`:498`, `:600`), `packages/common/src/state/store.ts:155-180`,
`packages/common/src/protocol/codec.ts:104-118`.

What is true: `applyOperation` calls `parsePointer(patch.path)` unguarded (`patch.ts:219`), which throws
(`pointer.ts:20-22`). Reproduced: `applyPatch({data:{}}, [{op:'add', path:'data/x', value:1}])` throws
`Error: Invalid JSON Pointer "data/x": must be empty or start with "/"`. Reachability is real:
`extractPatches` (`codec.ts:104-118`) casts the wire array straight to `Patch[]` with no `path` validation
(a non-string `path` throws even earlier, in `startsWith`). `store.applyPatches` (`store.ts:159`) runs from
`handleStateFrame` (`client.ts:600`), whose doc at `:495` promises "Never throws"; the throw skips the
`currentVersion` bump (`store.ts:163`) and `notifyAffected` (`store.ts:178`) while earlier ops in the batch
have already mutated `this.tree` in place. The transport guards
(`headless/src/transport/client.ts:265-272`, `bootstrapped/src/attach/transport.ts:140-147`) confine it and
keep it from crashing the page, but they merely swallow it, so the silent divergence is never reported.

Corrected fix: as proposed, catch around the `parsePointer` call and the switch body in `applyOperation`
(or inside `applyOne`'s `attempt`) and return the message as a failed `PatchOutcome`
(`resolution: 'failed'`); make `parsePointer` throw `MgProtocolError` from `./errors.js`; add a
`patch.test.ts` case asserting `ok:false` instead of a throw.

## 5. dispose() clears the subscribers of a caller-supplied store, defeating ClientCoreOptions.store: CONFIRMED (high)

Opened: `packages/common/src/client.ts:86-101`, `:154-177`, `:204-217` (`:214`),
`packages/common/src/state/store.ts:271-274`, `packages/common/tests/client.test.ts:541-556`,
`packages/headless/src/client.ts:349-355` and `:698-706`, `packages/bootstrapped/src/client.ts:236-244`.

What is true: `dispose()` unconditionally runs `this.store.clearSubscribers()` (`:214` →
`store.ts:272-273` clears the whole map). The option doc (`:86-101`) says the reconnect recipe requires a new
core *and* that "only `dispose()` releases the old listeners", while passing the previous store "keeps every
subscription attached". Both cannot hold. Neither production client passes `store`
(`headless/src/client.ts:698-706`, `bootstrapped/src/client.ts:236-244`), and headless states the opposite
of the truth: "`@mg.js/common` does not let a caller supply the store"
(`headless/src/client.ts:352-353`). The only caller passing it (`client.test.ts:550`,
`new ClientCore({ transport: secondTransport, store: shared })`) never disposes the first core, so the real
sequence is untested. Correction: the finding's "no in-repo caller passes store" is wrong by one test.

Corrected fix: as recommended, `private readonly ownsStore = options.store === undefined` in the
constructor; `if (this.ownsStore) this.store.clearSubscribers();` in `dispose()`; then pass
`this.core?.store` at the headless reconnect site (`headless/src/client.ts:698`) and fix the stale getter
comment. Add a regression test that disposes the first core before reusing its store.

### Summary

| # | Title (short) | Verdict | Severity | Breaking |
|---|---|---|---|---|
| 1 | `__proto__` patch paths pollute Object.prototype | confirmed (evidence corrected to patch.ts:177-180) | critical | no |
| 2 | WorldScene layers invisible / host world hidden | confirmed | critical | no |
| 3 | room/version unencoded in connect-URL path | partial | medium | no |
| 4 | applyPatch throws on malformed path | confirmed | high | no |
| 5 | dispose() wipes a caller-supplied store's subscribers | confirmed | high | no |
