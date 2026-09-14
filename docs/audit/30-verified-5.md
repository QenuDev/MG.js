# Audit 30: adversarial verification pass 5 (jotai bridge, client lifecycle, tsconfigs, live-socket script)

Every line below was opened in this session. Claims marked "probe" were reproduced with a throwaway
`packages/bootstrapped/src` harness (`npx tsx`), since `packages/bootstrapped/tests/` has no test for
`jotai/bridge.ts` or for the `install`/`uninstall` lifecycle at all (only `catalog-sources.test.ts:35-78`
and `room-upgrade.test.ts`, and each of those uses a fresh client). The harness files were deleted.

## 1. `release()` deletes the page's live `jotaiAtomCache` and never unwraps the synthetic `get`: **confirmed, high**

Opened: `jotai/bridge.ts:327-385` (`inspectAtom`), `:387-402` (synthetic holder), `:488-504` (`release`),
`:55-67` (the §12 premise), `client.ts:659-660` (the caller). jotai's own factory was fetched from
`unpkg.com/jotai@2.6.0/esm/vanilla.mjs:1-6`.

What is actually true. `release()` at `:500-502` deletes `page[ATOM_CACHE_KEY]` on identity alone, while the
comment two lines above it claims "still empty of the game's atoms ... the flag is checked, not assumed".
There is no size test and no flag on the synthetic (`:393-400`), and `releaseCacheGet` is only assigned in
the pre-existing-holder branch (`:431-437`). Probe D: bridge installed on a page with no cache → holder
synthesised → the "game" registered one atom through `holder.get(...)` (cache size 1) → `release()` printed
`DELETED`; the holder reference stayed callable and `inspectAtom` (no `active` guard) still wraps
`atom.write` at `:377`. This is the state the module itself says must not be deleted
(`:62-65`: the game reads the global and populates *ours*; §12: "used for hot-reload bookkeeping"), and
`BootstrappedClient.uninstall()` runs it.
Corrected fix: gate the delete on the condition the comment states (`synthetic.cache.size === 0`), or keep a
populated holder and neutralise it instead; brand the synthetic holder (realm-correct `Object`, as at `:419`)
so a foreign/copied holder is never deleted; and add `if (!active) return atom;` as the first line of
`inspectAtom` so a reference the game already took cannot re-patch atoms after release.

## 2. `atomLabel` prefers a jotai config key over `debugLabel`; `atomN` passes the sentinel: **confirmed, high**

Opened: `jotai/bridge.ts:260-279`, `:91-102` (the documented cache shapes), `:403-412` (bare-`Map` install),
`:632-645` (`JotaiBridge` registry). jotai 2.6.0 `vanilla.mjs:1-6`: every config is
`{ toString: () => \`atom${++keyCount}\` }`.

What is actually true. `:272-275` returns the key's `pageString` unless it is `''` or `'[object Object]'`.
On the first documented shape ("a bare `Map` keyed by the atom-config object", `:93-94`, iterated at `:406`)
the key *is* a config object, so its string form is `atom7`, which passes the sentinel and wins over the
reliable `debugLabel`. Probe C: a `Map` holding one atom with `debugLabel: 'store/activeModalStateAtom'`
produced `labels() === ["atom7"]` and `find('activeModalStateAtom')` → MISS. Every label on that shape is
positional and per-load, so `find`/`readByLabel`/`writeByLabel` (`:702-720`) can never match a real name and
the miss diagnostic prints wrong names.
Corrected fix: invert the preference in `atomLabel(key, atom, page)`, testing `debugLabel` first, then `label`,
then the key, and treat `''`, `'[object Object]'` and `/^atom\d+$/` as non-informative so they fall through. The key
remains a fallback for string-keyed caches, which is the case the `:266-269` comment was written for.

## 3. `install()` after `uninstall()` leaks a permanent page hook: **confirmed, high**

Opened: `client.ts:345-348`, `:354-366`, `:394-420`, `:625-695`; `realm.ts:342-368`, `:381-386`;
`catalog/bundle.ts:301-332`.

What is actually true. `install()` guards only `this.installed` (`:362`); `uninstall()` sets
`uninstalled = true`, `installed = false` and returns early for ever (`:636-638`); `isInstalled` is
`installed && !uninstalled` (`:347`). Probe B (fake page, `disableRender`, `disableJotai`) reproduced the
reported measurement exactly: after `install(); uninstall(); install()` gives `isInstalled=false, refCount=1,
keysBranded=true, keysReplaced=true`; after the second `uninstall()` it gives `ns=present, refCount=1,
keysBranded=true`. So the branded `Object.keys` wrapper (`bundle.ts:308-332`), the namespace claim and a
live `ready()` attachment survive with no handle that can ever release them; a later mod's claim/release
pair can never reach refCount 0 (`realm.ts:357-367`), and `isInstalled` reports `false` right after a
successful install.
Corrected fix: make the lifecycle explicit in `install()`, either by throwing
(`if (this.uninstalled) throw new Error('uninstall() is terminal; construct a new client')`) or by clearing
`uninstalled` and rebuilding state, and set `this.installed = true` only after every fallible step has
succeeded.

## 4. Failed `install()` leaves `isInstalled` true and `uninstall()` throwing: **partial, medium**

Opened: `client.ts:361-432`, `:635-695`; `realm.ts:187-202`, `:220-228`; `bundle.ts:301-310`;
`coexistence/brand.ts:227-252`; `userscript.ts:186-193`.

What is actually true. The flags are set before the first fallible call (`:363-366`) and `uninstall()`
repeats the unguarded `requirePage()` (`:681`). Probe A (Node, no page) reproduced the report verbatim:
`install` threw from `requirePage()`, `isInstalled` then `true`, `uninstall` threw the same error. So
teardown is not the safe no-op the rest of `:635-694` promises (`attemptTeardown` everywhere else), and
`isInstalled` lies. What the finding overstates is the leak: in the reproduced path the throw happens
evaluating the `:366` argument, *before* `claimInstall`, so no refCount is taken and no hook exists. The
claim/hook leak needs a throw after a successful claim. That path is reachable but not normal, e.g. the unguarded slot
write at `brand.ts:240` reached from `bundle.ts:308` on a frozen page `Object` (then the refCount stays 1
and `userscript.ts:190-193` drops the client), or a foreign `__mgjs` global throwing inside `claimInstall`
(`realm.ts:223-228`, which leaks no refCount but leaves `ownsClaim`). Real defect, medium rather than high:
nothing on the ordinary path loses data.
Corrected fix: resolve the page once in `install()` and reuse it in `uninstall()`; wrap the post-claim body
in `try/catch`, and on throw release `catalogHandle`/`captureHandle`, call `releaseInstall`, reset
`installed`/`ownsClaim` and rethrow.

## 5. `packages/headless/tsconfig.test.json` is referenced by nothing; no test file is type-checked: **partial, medium**

Opened: root `tsconfig.json:1-7`, `tsconfig.base.json`, `packages/{common,headless,bootstrapped}/tsconfig.json`,
`packages/headless/tsconfig.test.json`, `package.json` (`typecheck`, `verify`), `headless/tests/integration.test.ts:466-503`.

What is actually true. All three package configs include only `src/**/*.ts` (`headless/tsconfig.json:8`), the
root references only those three (`tsconfig.json:3-5`), and `npm run typecheck` is `tsc -b --force`, so no
`tests/**` file is in any program. The evidence line "grep ... = no matches" is wrong: `tsconfig.test` appears
in `docs/audit/*`, but never in a config or script, so the substance holds. Independently confirmed with
`npx tsc -p packages/headless/tsconfig.test.json --noEmit` (exit 2) and
`npx tsc -p packages/common/tsconfig.json --listFilesOnly` (0 files under `tests/`): the orphan config reports
two genuine errors, `headless/tests/integration.test.ts(502,28)` and `(503,28)`, both TS2339 on `plans[0]`
narrowed to `never` by the `assert.deepEqual(plans, [])` at `:483`. Severity medium, not high: this is an
unchecked verification net (assertions the compiler would have rejected), not a break in shipped code.
Corrected fix: add `packages/common/tsconfig.test.json` and `packages/bootstrapped/tsconfig.test.json`
mirroring the headless one and reference all three from root `tsconfig.json` so `tsc -b --force` covers
tests (and a scripts config for `scripts/**`); then fix the errors it surfaces.

## 6. `verify-live-socket.ts` reports PASS and exit 0 for any connection failure: **confirmed, high**

Opened: `scripts/verify-live-socket.ts:93-158`, `:158-196`. The cited line number is wrong: the guard is at
`:158` (`if (sawSessionExpired || !client.isReady)`), not `:126`; the three unconditional `report(..., true,
...)` calls are at `:161`, `:164` and `:169` (not `129-138`).

What is actually true. A DNS failure, a TLS abort, or the `:104` deadline race all leave `client.isReady`
false, so they enter the "documented 4840 SessionExpired" branch, print "transport reached the server:
WebSocket upgrade accepted" and "server closed with 4840" as facts, set `failures = 0` at `:178` (also
discarding any earlier failed `report` from `:83-149`), and exit 0 at `:195`. The `else` at `:179-185` is
reachable only when a Welcome arrived and a later step threw. So the one script that can detect a transport
regression cannot fail on a transport regression.
Corrected fix: change `:158` to `if (sawSessionExpired)`; make `:161`'s transport report conditional on
evidence (`client.stats.stopped !== undefined || sawSessionExpired`); keep the three hard-coded `true`s only
inside the verified-4840 case; let every other connection failure fall through to `failures += 1`.

Verdict tally: 4 confirmed (1, 2, 3, 6, all high), 2 partial with severity corrected to medium (4, 5),
0 refuted. No finding requires a breaking change to an exported name, signature or type.
