# Audit 10: `@mg.js/bootstrapped`: jotai bridge + coexistence

Scope: `packages/bootstrapped/src/jotai/bridge.ts` (727 lines),
`packages/bootstrapped/src/coexistence/renumber.ts` (581), `.../brand.ts` (310).
Read in full; callers checked with grep across `packages/**` (excluding `dist`).

---

## 1. `installRenumberHook` returns a **detached** `Renumberer` when the slot is already ours: two counters, one socket

**Severity:** critical · **Category:** correctness · **Breaking:** no

`installRenumberHook` constructs its state machine *before* it knows whether it installed anything
(`renumber.ts:502`: `options.renumberer ?? new Renumberer(options.options)`), calls `installHook`
(`renumber.ts:504`) and then returns a handle whose `renumberer` is that fresh instance
(`renumber.ts:529-538`). `installHook` returns `{ outcome: 'reused', wrapper: existing, release: () => false }`
when the slot already carries our brand (`brand.ts:231-233`) and, in that case, never calls `wrap`. So the
wrapper on the wire is driven by the *first* renumberer, while the second handle hands the caller a machine
that no frame ever consults. The handle still reports `active: true`, because the getter at
`renumber.ts:532-534` compares the slot to `install.wrapper`, which on the reuse path *is* the existing
wrapper.

Consequences for a caller that follows the documented protocol (`client.ts:753-759` shows the intended
sequence: `remember(requestId)` before send, `claimNext()` for a self-built envelope):

* `handle.renumberer.claimNext()` takes a number from a counter that is not the one stamping frames, so the
  live rewriter sees the caller's own frame as foreign and `take()`s a second number for it, the gap the
  module header (`renumber.ts:9-10`) says becomes `invalid_sequence` and "then *every later command fails*".
* `handle.renumberer.remember(id)` registers the id on the machine nobody reads, so §19 part 3
  (`renumber.ts:202-212`, "don't re-intercept your own traffic") silently does nothing.

Trigger: any second install over a slot we own. That includes a second copy of the userscript in the page, an
`install()`/`uninstall()`/`install()` cycle in one realm, or a third party that set the forgeable marker
(finding 5). `tests/coexistence.test.ts:405-436` covers the fresh-install path only; no `src` caller
exercises `installRenumberHook` at all (grep: definition `renumber.ts:499`, re-export `index.ts:163`, tests
only), so this is reachable purely through the public API.

**Fix.** Make the live machine reachable from the wrapper and surface the outcome, e.g. in `renumber.ts`:

```ts
export const RENUMBERER_KEY = '__mgjsRenumberer';
// in wrap(): Object.defineProperty(wrapper, RENUMBERER_KEY, { value: renumberer, enumerable: false });
// in installRenumberHook(): if (install.outcome === 'reused') return { ...handle,
//   renumberer: (install.wrapper as Record<string, unknown>)[RENUMBERER_KEY] as Renumberer };
```

and add `readonly outcome: InstallOutcome` to `RenumberHookHandle` so a caller can tell "I own the
restore" from "I am a guest on someone else's wrapper".

---

## 2. `release()` deletes the page global `jotaiAtomCache` the game has been populating, and never unwraps the synthetic holder's `get`

**Severity:** high · **Category:** correctness · **Breaking:** no

The synthetic holder is created with only `cache` and `get` (`bridge.ts:392-402`) and no `__mgjsWrapped`
flag, and no `releaseCacheGet` closure is assigned on that branch (`releaseCacheGet` is only set in the
pre-existing-holder branch, `bridge.ts:431-437`). `release()` nevertheless deletes the page property on an
identity check alone:

```ts
// bridge.ts:498-502
// Remove a synthetic cache only if it is still exactly ours and still empty of the game's atoms.
// Removing a cache the game is actively using would break it, so the flag is checked, not assumed.
if (synthetic !== null && page !== null && page[ATOM_CACHE_KEY] === synthetic) {
  delete page[ATOM_CACHE_KEY];
}
```

The comment describes a guard that is not in the code: there is no emptiness test on `synthetic.cache` and no
flag test (the flag does not exist on this object). That contradicts the module's own premise
(`bridge.ts:62-66`: the whole reason to synthesize is that "the game reads `window.jotaiAtomCache` ... the
game populates *ours*"), so the object being deleted is, by design, the one the game registered its atoms
into. This runs from `BootstrappedClient.uninstall()` (`client.ts:659-660`).

Second half of the same teardown gap: because `inspectAtom` (`bridge.ts:327-385`) never checks the `active`
flag, any reference the game (or another mod) already took to the holder keeps calling our wrapped `get`
after release, and that call re-runs `atom.write = capture` (`bridge.ts:377`), re-patching the game's atoms
after uninstall, with `capturedSet` re-populated and no handle left to release it.

**Fix.** In `bridge.ts`, gate the delete on the condition the comment states and make the holder
self-identifying, e.g. `if (synthetic !== null && page?.[ATOM_CACHE_KEY] === synthetic && synthetic.cache.size === 0) delete page[ATOM_CACHE_KEY];`, set `holder.__mgjsWrapped = true` on the synthetic holder so a foreign or copied holder is never deleted, and add `if (!active) return;` as the first line of `inspectAtom`.

---

## 3. `atomLabel` prefers the cache key over `debugLabel`, and its "useless key" sentinel misses jotai atoms

**Severity:** high · **Category:** correctness · **Breaking:** no

```ts
// bridge.ts:271-278
if (key !== null && key !== undefined) {
  const keyText = pageString(page, key);
  if (keyText !== '' && keyText !== '[object Object]') return keyText;
}
if (typeof atom.debugLabel === 'string' && atom.debugLabel !== '') return atom.debugLabel;
```

`AtomCacheLike`'s first documented shape is "A bare `Map` keyed by the atom-config object"
(`bridge.ts:93-94`), and `install` iterates that (`bridge.ts:406`, `bridge.ts:463`), passing the
config object as `key`. A jotai atom config is **not** `[object Object]`, because jotai's factory gives
every config a custom string form:

```js
// jotai 2.6.0 esm/vanilla.mjs:2-6
function atom(read, write) {
  const key = `atom${++keyCount}`;
  const config = { toString: () => key };
```

So `pageString(page, config)` returns `"atom7"`, which passes the sentinel, and the reliable
`debugLabel` (`store/activeModalStateAtom`, the §12 mechanism this module's header is built on,
`bridge.ts:20-28`) is discarded. On that shape every label is a positional `atomN`, `JotaiBridge.find()`
(`bridge.ts:529-537`) can never match a real name, and `writeByLabel`/`readByLabel` (`bridge.ts:702-720`)
always miss. `labels()` even advertises the wrong names in the thrown diagnostic. Worse, `atomN` numbering
is per-page-load, so a label that did match would match a different atom on the next build.

**Fix.** In `bridge.ts`, invert the preference in `atomLabel(key, atom, page)`. Check `debugLabel` first,
then `label`, then the key. Reject non-informative keys explicitly (`if (keyText === '' || keyText ===
'[object Object]' || /^atom\d+$/.test(keyText))` fall through). Keep the key as a fallback only, since the
docs' example key is a string path.

---

## 4. The captured store `set`/`get` are module globals that survive `uninstall()`, and nothing can re-capture them

**Severity:** medium · **Category:** correctness · **Breaking:** no

`capturedSet`/`capturedGet` are module-scoped (`bridge.ts:139-145`) and are only cleared by
`resetJotaiCapture()` (`bridge.ts:189-194`), which has no caller in `src` (grep: definition plus the
`index.ts:311` re-export only). `BootstrappedClient.uninstall()` calls `this.jotai?.release()`
(`client.ts:659-660`), and `release()` restores writers but leaves both globals set. Two failures follow in
the same realm:

* a later `new JotaiBridge()` adopts the dead store: `get set()` returns it, `ready` is `true`
  (`bridge.ts:648-656`), and `writeAtom` reports `{ ok: true }` (`bridge.ts:612-614`) while writing into the
  store the previous client detached, so the game's UI never changes and the caller has no signal.
* re-capture is impossible: `inspectAtom` only wraps a writer while `capturedSet === null`
  (`bridge.ts:346`), and the retry loop stops as soon as `capturedSet !== null` (`bridge.ts:472`), so the new
  store's `set` is never seen again.

This is precisely the scenario `resetJotaiCapture`'s own docblock names ("a store can be replaced (a React
remount after an error boundary, say). Holding a stale `set` would write into a dead store and silently do
nothing", `bridge.ts:182-188`), but the recovery path exists and is not wired to the lifecycle.

**Fix.** Call `resetJotaiCapture()` from `BootstrappedClient.uninstall()` next to `this.jotai?.release()`, and
track `capturedStore: { set, get } | null` instead of two bare globals, replacing `capturedSet === null` at
`bridge.ts:346` and `bridge.ts:472` with a check that the captured store is still live.

## 5. The brand marker is a bare `true`: unversioned, forgeable, and re-used as an enumerable flag on the atom cache

**Severity:** medium · **Category:** security (session DoS, not a credential issue) · **Breaking:** yes

`isBranded` accepts any function whose `MARKER_KEY` is exactly `true` (`brand.ts:126-129`), and
`classifySlot` maps that to `'mine'` (`brand.ts:154-160`), which both hook installers treat as "leave it
alone": `raw-socket.ts:292` returns before installing the socket rewriter, and `installHook` reuses without
calling `wrap` (`brand.ts:231-233`). The marker carries no owner, build id or version, so a single line by
any other page script silently disables coexistence. A page script can set
`WebSocket.prototype.send.__mgjsWrapped = true` directly, or load a copy of an older mg.js build. The
result is the failure this whole subsystem exists to prevent: our
commands are stamped from a counter the game does not share, the gap is `invalid_sequence`, and the
connection freezes (`renumber.ts:9-10`). The marker is also non-secret and global, so it cannot be used as a
trust signal at all.

Separately, `bridge.ts` reuses the same name for an unrelated concept with a plain (enumerable) assignment:
`holder.__mgjsWrapped = true` at `bridge.ts:430`, read back at `bridge.ts:419`. `brand.ts:84-88` states the
opposite convention for markers, which are non-enumerable so that a `{...spread}`/`Object.assign` copy
cannot carry a stale brand. A copied holder object would therefore read as already wrapped, and `install`
would skip wrapping its `get`, leaving the bridge permanently blind.

**Fix.** In `brand.ts` make the marker carry identity: change `MARKER_KEY`'s value to a token (e.g.
`{ owner: string; version: number } | true`), add `const MARKER_OWNER_KEY = '__mgjsOwner'`, and have
`isBranded(value)` / `classifySlot(obj, key)` distinguish `'mine'` (this instance/build) from
`'compatible'` (another mg.js build, which chains to it and adopts its renumberer per finding 1). Set the
bridge's holder flag with `Object.defineProperty(holder, MARKER_KEY, { value: true, enumerable: false })` so
the two uses cannot be confused.

## Lower-severity observations (not in the top 5)

* `bridge.ts` has **zero tests**: `grep -rl "JotaiBridge|writeAtom|jotaiAtomCache" packages/*/tests` returns
  nothing, while the pure `coexistence` module has `tests/coexistence.test.ts`. A 727-line module that patches
  the host page's atom cache and every atom writer is the least-covered file in the package.
* The `get` wrapper on an existing holder is never removed once `set` is captured: `releaseCacheGet` is only
  invoked from `release()` (`bridge.ts:496`), so for the life of the session every `holder.get(key, initial)`
  costs one wrapper call plus two `atomLabel` computations (once in `inspectAtom` `bridge.ts:333`, once in the
  `JotaiBridge` visitor `bridge.ts:640`) even though `capturedSet !== null` short-circuits the only thing the
  inspection could still do (`bridge.ts:346`). `inspectedCount` (`bridge.ts:148`) counts re-inspections, so
  `atomCount`/`report().jotai.atomsSeen` (`client.ts:820`) overstate.
* `applyRenumbering` (`renumber.ts:546-573`) is reached only by the unused `installRenumberHook` and tests;
  the live path uses `applyRenumberingToString` (`client.ts:973-988`), which returns before `rewrite` for our
  own frames and so never increments `oursSeenCount`/`passthroughCount`.

## What works well here

* `restoreSlot`'s identity guard, including the `undefined`-means-delete distinction (`brand.ts:269-284`).
  Restoring a `WebSocket.prototype.send` slot by assignment would shadow the prototype member forever.
* `installHook`'s three-way classification with chaining onto a foreign wrapper (`brand.ts:227-252`),
  and `'reused'` refusing to own a restore it did not perform.
* `Renumberer`'s pure, page-free state machine: passive phase, monotonic `observeFrontier`, explicit
  `healAfterInvalidSequence`, `reseed` on reconnect (`renumber.ts:140-414`); it is testable without a
  browser.
* `applyRenumbering`'s gate ordering (non-string, then length, then substring, then `JSON.parse`,
  `renumber.ts:546-561`) matches the documented reason (per-frame jank) exactly.
* `attemptTeardown` (`brand.ts:298-310`): a failing teardown step must not leave later hooks installed.
