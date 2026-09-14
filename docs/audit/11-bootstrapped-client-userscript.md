# bootstrapped/client + userscript: audit

Scope: `packages/bootstrapped/src/client.ts`, `userscript.ts`, `catalog/bundle.ts`, `index.ts`. Read
alongside for callers: `realm.ts`, `attach/transport.ts`, `coexistence/brand.ts`, `scripts/build.ts`,
`dist/magicgarden.user.js`. Two findings below were confirmed by probes; the rest is read from source.

---

## 1. `install()` has no `uninstalled` guard, so a second install leaks page hooks permanently (high)

**Category:** correctness · **Breaking:** no

**Evidence.** `client.ts:361-363` guards only on `installed`:

```ts
install(): this {
  if (this.installed) return this;
  this.installed = true;
```

`uninstall()` is one-way. See `client.ts:636-638`:

```ts
uninstall(): void {
  if (this.uninstalled) return;
  this.uninstalled = true;
```

So `install(); uninstall(); install()` re-runs every hook install (`captureCatalogBundle` at
`client.ts:395`, `PixiStage.capture` at `client.ts:405`) and re-claims the namespace at
`client.ts:366`, but the *second* `uninstall()` returns immediately and releases none of it.
Measured:

```
1 install : isInstalled=true  refCount=1 keysBranded=true
1 uninst  : isInstalled=false ns=removed  keysBranded=false
2 install : isInstalled=false refCount=1 keysBranded=true   <-- install() reports itself not installed
2 uninst  : isInstalled=false ns=present refCount=1 keysBranded=true   <-- hook still on the page
```

(`keysBranded` is `isBranded(FakeCtor.keys)` after `captureCatalogBundle` wrapped it.)

**Why it matters.** The host page keeps a branded `Object.keys` wrapper forever (it scans every object
the game enumerates), and the namespace `refCount` stays at 1. `releaseInstall` only returns the
teardown list at refCount 0 (`realm.ts:357-367`), so a *later, unrelated* mod's `uninstall()` decrements
to 1 and never tears anything down. Two of this package's advertised guarantees are false in this sequence:
idempotent install and clean uninstall. `isInstalled` is also simply wrong (`false` immediately
after a successful `install()`), and a mod's own teardown/UI code branches on that value.

**Fix.** Make the lifecycle a single state machine rather than two booleans. Either make `install()`
throw loudly after teardown, using `if (this.uninstalled) throw new Error('BootstrappedClient: uninstall() is terminal; construct a new client')`, or make `install()` clear `uninstalled` and rebuild `detachers`/state. Set `this.installed = true` only after the fallible steps below succeed, and null `this.attachment` in `uninstall()`.

---

## 2. A failed `install()` leaves the client claiming to be installed, and `uninstall()` itself throws (high)

**Category:** correctness · **Breaking:** no

**Evidence.** `client.ts:363-366` mutates the lifecycle flags *before* the first fallible call:

```ts
this.installed = true;

this.ownsClaim = true;
const outcome = claimInstall(this.page ?? requirePage());
```

`requirePage()` throws when the client is constructed outside a page (`realm.ts:193-202`), a context the
package explicitly supports (`catalog/bundle.ts:301-306`: "An importable library loaded outside a page
must still construct"). There is no `try/catch` anywhere in `install()`, and `uninstall()` repeats the
same unguarded `requirePage()` at `client.ts:681` (`releaseInstall(this.page ?? requirePage())`).
Measured in Node:

```
hasPage false
install threw: mg.js: no page realm is available (no unsafeWindow, no windo
isInstalled true          <-- after the throw
uninstall threw: mg.js: no page realm is available (no unsafeWindow, no windo
```

The same hole exists for every step between the claim and `return this`: `captureCatalogBundle`
(`:395`), `new CatalogClient` (`:400`), `PixiStage.capture` (`:405`). `userscript.ts:188-193` catches
an `install()` throw and drops the client, so any hook installed before the throw (and the claim taken
at `:366`) is left behind with no handle that can release it.

**Why it matters.** A failed install is the *anticipated* path (`userscript.ts:191` has a dedicated
message for it), yet it leaves the shared refcount permanently elevated and page hooks installed with
nobody holding a release handle. That breaks the invariant the whole "coexistence" design rests on.

**Fix.** Wrap the body of `install()` after the claim in `try { ... } catch (error) { rollbackInstall(); throw error; }`, where `rollbackInstall()` releases `catalogHandle`/`captureHandle`, calls `releaseInstall`, and resets `installed`/`ownsClaim`. Cheaper alternative that fixes the confirmed case: set `installed`/`ownsClaim` only after `claimInstall` and the hook installs return, and never call `requirePage()` twice. Resolve the page once into a local and reuse it in `uninstall()`.

---

## 3. The userscript never tears down its badge or its two 500 ms pollers, and keeps reporting a released attachment (medium)

**Category:** correctness (leaked timer/watcher) · **Breaking:** yes

**Evidence.** `userscript.ts:232` and `:268` create two `setInterval(..., REFRESH_MS)` pollers and
`userscript.ts:288` returns only the client; the interval ids and the badge handle stay in the closure,
so nothing can stop them. `BadgeHandle.destroy()` (`userscript.ts:134-137`) is defined and never called,
and `startUserscript` never uses the namespace teardown hook (`onTeardown`, `realm.ts:371-373`) that the
client itself uses at `client.ts:427`. Meanwhile the pollers read `client.attachmentKind` /
`client.attachmentReport`, which survive teardown, because `uninstall()` never nulls `this.attachment`
(`client.ts:662-664` releases it but leaves the field set). Measured:

```
attached kind = none
after uninstall: attachmentKind = none
after uninstall: attachmentReport = {"kind":"none","sockets":0}
ready() after uninstall resolved again
```

So after `window.__mgjs.uninstall()` the badge keeps ticking every 500 ms, keeps logging, and keeps
displaying "attached ... waiting for Welcome" from a binding that has been released.

**Why it matters.** A mod that uninstalls the client (or a second userscript load) leaves a visible
status badge lying about state, plus two permanent timers, on the game page. That is the class of leak
the userscript file's own doctrine ("failure is reported, never swallowed"; clean restore) forbids.

**Fix.** In `startUserscript`, register the teardown once the page is known:
`onTeardown(() => { clearInterval(timer); clearInterval(reportTimer); badge?.destroy(); }, page);`
and have `startUserscript(): { client: BootstrappedClient; stop(): void }` (or `BootstrappedClient.uninstall()` null out `this.attachment` and `this.attachmentPromise`) so the reported state stops after teardown.

---

## 4. `report()` returns the stale `renumberingInstalled`, contradicting the fix documented 500 lines above (medium)

**Category:** consistency · **Breaking:** no

**Evidence.** `attachmentReport` (`client.ts:332-343`) exists solely because two fields lie after an
upgrade (its docstring says the badge showed `renumbering: false` "on a session that was numbering
frames"), and it re-resolves `renumberingInstalled` against `this.sendSeam` and `socketsSeen` against
`attachment.socket?.socketCount`. `report()`, the diagnostic meant for bug reports, does neither:
`client.ts:799` uses `this.attachment?.report` (the raw snapshot) and `client.ts:828` uses
`this.attachment?.report.renumberingInstalled === true`.

**Why it matters.** After a raw-socket → room-connection upgrade (`upgradeAttachment`, `client.ts:581-623`)
`report().renumbering.enabled` is `false` while renumbering is provably active on the retained send seam.
That is the precise failure the getter's docstring calls "worse than no diagnostic, because it sends the
reader looking in the wrong place". The fix was applied to one accessor and not the other.

**Fix.** In `report()`, build the attachment block from the resolved getter:
`const attachment = this.attachmentReport; ... renumbering: { enabled: attachment?.renumberingInstalled ?? false, ... }` and use `attachment?.socketsSeen`. That is a one-line change that removes the second source of truth.

---

## 5. The barrel exports two functions named `asEnvelope` under inverted names (medium)

**Category:** api-design · **Breaking:** yes

**Evidence.** `index.ts:48` exports `client.ts`'s helper under its bare name:

```ts
export { BootstrappedClient, EMPTY_STARTUP_SINK, applyRenumberingToString, asEnvelope, parseEnvelope, readWelcomeFrontier } from './client.js';
```

while `index.ts:162` exports the *authority* renamed: `asEnvelope as asCommandEnvelope` from
`./coexistence/renumber.ts`. `client.ts:937-940` states which is which in its own words: "`renumber.ts`'s
`asEnvelope` is the authority for the state machine, and this is the client's own light re-check".

**Why it matters.** The barrel's dominant convention for a colliding name is to alias the duplicate
(`asEnvelope as asCommandEnvelope` at `:162`, `getGraphicsCtor as getSpriteGraphicsCtor` at `:252`,
`install as installJotaiBridge` at `:309`); the one place it is broken is the place where the aliased
name is the authoritative implementation. A mod author who imports `asEnvelope` from the package gets
the re-check, and has to know to reach for `asCommandEnvelope` to get the real one. That is a surprise from a
package that otherwise goes out of its way to make the authority discoverable.

**Fix.** In `index.ts`, drop `asEnvelope` from the `./client.js` re-export and export the authority under
the plain name: `export { Renumberer, applyRenumbering, asEnvelope, ... } from './coexistence/renumber.js';`, keeping `asCommandEnvelope` as a deprecated-free alias only if a consumer already needs it (pre-1.0: just rename). Keep `client.ts`'s local helper internal, or export it as `parseEnvelopeEnvelope`-style distinct name.

---

## Lower-severity observations (not counted as findings)

- `userscript.ts:219-226` wraps `whenBody(...)` in `try/catch`, but at `document-start` `doc.body` is null,
  so `createBadge` actually runs later from the `DOMContentLoaded` listener (`userscript.ts:152-158`),
  *outside* that `try/catch`. A throw from `host.attachShadow` (`:73`) becomes an uncaught page error.
- `client.ts:427-429` registers an empty teardown callback on the namespace; dead code whose comment
  claims otherwise (`releaseInstall` already splices the list). Delete it.
- `catalog/bundle.ts:212-213` returns the game's own array and `:293` stores it, while `detach()`
  (`:347-354`) never clears `capture.tables`/`best`: the game's tables stay pinned until `uninstall()` and
  later game-side mutation silently changes the "authoritative" catalogue. `load()` copies (`:391`).
- Two unrelated `createBadge`s in one package: `userscript.ts:61` (DOM status badge) and the exported one
  at `index.ts:242` (Pixi graphics badge). Also `bundle.ts:301-306`'s inert handle is reported as
  `catalog.enabled: true` because `client.ts:824` only tests `!== null`.

## What works well here

- Every teardown step goes through `attemptTeardown` (`client.ts:640-693`), so one already-dead hook
  cannot strand the rest: the failure mode most uninstall paths get wrong.
- The socket binding is retained by design after a raw-socket → room-connection upgrade because it is
  the only unbypassable send seam, and is released separately at teardown (`client.ts:581-605`,
  `client.ts:665-670`, `attach/transport.ts:313-314`); this is subtle and correct.
- `installHook` returns `release: () => false` for a `'reused'` install (`brand.ts:231-233`), so a second
  load of the bundle cannot tear out the first load's hook, and `bundle.ts:353` relies on that.
- `catalog/bundle.ts` recognises tables structurally (never by minified name), latches re-entrancy, and
  self-detaches after 30 s with an identity-guarded restore (`bundle.ts:255-281`, `:308-344`, `:347-354`).
- The userscript artifact satisfies its hard packaging constraints: verified `dist/magicgarden.user.js`
  begins with the `==UserScript==` block, is one IIFE containing zero `import`/`require`, and contains no
  `eval(` (metadata banner authored in `scripts/build.ts:76-92`, emitted via esbuild `banner`).
