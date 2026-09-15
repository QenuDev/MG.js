# Phase 6: Inert surface. Implement or delete

Master plan, verbatim: *"Every item is either wired to observable behaviour with a test, or removed (breaking
changes allowed)."* Acceptance: *"a test asserts each surviving option/endpoint changes behaviour; the deleted
names are listed per commit."*

This plan is written from measurement at the boundary (Phase 5 closed: `npm run verify` 876 tests / 0 fail /
0 skipped; both live checks pass; bundle 322,654 B). The master plan's list is from the audit and **two of its
eight named items are already resolved**. The audit's list is the outer bound, not the work.

## What "inert" means here, precisely

Four shapes, and the disposition differs for each:

1. **Write-only**: a value is assigned and never read on any path. `FormRegistry.fallback` is this shape.
2. **Constant-gated**: a branch exists but its guard is a constant, so the branch is unreachable.
   `isFallbackEnabled` returns `false` unconditionally, so (1) is inert as well.
3. **Unreferenced declaration**: an exported name with no caller anywhere in the repository. `setETag`,
   `hasCapturedGet`, `emptyCatalogSource`.
4. **Dead registration / dead option**: a call that is legal, runs, and has no observable effect. The
   comment-only `onTeardown` callback; `GetCtorsOptions.page`.

The acceptance line is the hard one for shapes 1 and 2: proving a *surviving* option changes behaviour needs a
test that fails when the option is removed. That is what makes "wire it" the expensive disposition and why the
default here is **delete**, which is the master plan's own order of preference.

## Disposition table: the eight named items

| # | Item | Location | Status | Disposition |
|---|---|---|---|---|
| 1 | `FormFallback`, `FormRegistryOptions.formFallback`, `setFormFallback`, `isFallbackEnabled` | `common/src/actions/registry.ts:463,467,514,527` | **INERT, two ways at once**: `isFallbackEnabled(_name)` is `private` and `return false`, so the only branch that reads `fallback` (`:495`) is unreachable, and `fallback` is otherwise never read, so it is write-only. `'strict'` has no consumer at all. | **Delete** the type, the option, the setter, the private method and the `:495` branch. Breaking removal from `common`'s public surface; see "The `formFallback` argument" below. |
| 2 | `RemoteJsonSource.setETag` | `common/src/catalog/remote-json-source.ts:152` | **INERT**: zero references repo-wide (source, tests, scripts, docs; searched by name and by `'setETag'` string). | **Delete.** |
| 3 | `GetCtorsOptions.page` | `common`, `bootstrapped/src/render/ctors.ts:249` | **INERT**: `getCtors` (`:832`) reads `timeoutMs`, `schedule` and `stage` and never `options.page`. The docstring promises "explicit root override for the Graphics lookup", and `stage` already is that. | **Delete** the field, and the `PageRealm` import if it becomes unused. |
| 4 | `hasCapturedGet` | `bootstrapped/src/jotai/bridge.ts:188` | **INERT**: zero references, and **not in any barrel** (`jotai/index.ts` and `src/index.ts` do not export it), so it is reachable only by deep import. | **Delete.** Not a published-surface change. |
| 5 | `emptyCatalogSource` | `bootstrapped/src/client.ts:1173` | **INERT**: zero references; declared on `client.ts`'s module surface but **not** re-exported from `src/index.ts`. | **Delete**, and drop the name from `CLIENT_SURFACE` in `barrels.test.ts:449`. The guard I added in 5.7e is the thing that would otherwise fail, which is the guard working. |
| 6 | `EMPTY_STARTUP_SINK` | `bootstrapped/src/client.ts:1117` | **LIVE but duplicated**: used at `:310`, exported from `src/index.ts:60`, pinned in `ROOT_SURFACE`, and field-for-field identical to `attach/detect.ts`'s `createEmptySink()`. | **Dedupe, not delete**: the name survives (`EMPTY_STARTUP_SINK = createEmptySink()`), the implementation gets one home. |
| 7 | Comment-only `onTeardown` registration | `bootstrapped/src/client.ts:660` | **INERT**: `onTeardown` (`page/namespace.ts:240`) pushes its callback onto `namespace.teardowns`, and this callback's body is a comment. The push is an observable side effect only in that the array grows by a no-op. | **Delete the registration.** Must first confirm it is not the thing that *creates* the namespace for a later claim, because `onTeardown` calls `getNamespace(page)`, which **does** create it. See the failure mode note below. |
| 8 | `KEEPALIVE_PING` / `KEEPALIVE_PONG` | `common/src/protocol/wire.ts:205-206` | **LIVE, resolved, no action**. Both are used: `PING` by `isKeepalivePing` and `headless/src/transport/standalone.ts:55`; `PONG` sent at `standalone.ts:494` and re-exported as `KEEPALIVE` at `:579`; both pinned by `common/tests/symbol-parity.test.ts:73` and exercised in `headless/tests/transport/runtime.test.ts:40,53`. | **Leave, with this reason recorded.** The master plan's "if unused" is settled: they are not. |

## The `formFallback` argument, and the test that kept it alive

`packages/common/tests/forms.test.ts:122-127` is the reason item 1 needs a paragraph rather than a line. It
reads:

```ts
it('does not silently rewrite known-good flat actions by default', () => {
  const registry = new FormRegistry({ formFallback: 'wrap' });
  assert.equal(registry.formOf('Ping'), 'flat');
  assert.equal(registry.formOf('DropObject'), 'flat');
});
```

**This test cannot fail for the reason its name gives.** It passes the strongest available setting (`'wrap'`,
which is also the default) and asserts that `formOf` returns the declared form. It would pass with
`formFallback: 'strict'`, and it would pass with no argument at all. What it really tests is that `formOf`
prefers the declared form for `Ping` and `DropObject`, which is real and worth keeping. But the presence of an
option in its fixture is what kept a dead knob in the public API, and a reader sees a fallback that has been
exercised. Per DESIGN §6/I8 that is the defect: the test reads as a guarantee of the option and guarantees
nothing about it.

So the deletion rewrites that test to say what it checks: the two `formOf` assertions, with no option in the
fixture. The guard that the *mechanism* is gone is a source scan asserting `isFallbackEnabled` no longer
exists, because "delete a private method that returns a constant" otherwise has no red.

## The failure mode in item 7, and how to test it before deleting

`onTeardown(teardown, page)` is not a pure push: it calls `getNamespace(page)` (`page/namespace.ts:241`), which
**creates and installs** the `__mgjs` namespace if it is not there. The comment-only callback at
`client.ts:660` therefore has one plausible non-obvious effect, making the namespace exist at that point in
`start()`, for whatever runs after it. Deleting it is only safe if nothing between `:660` and the first
`claimInstall` depends on the namespace existing, and "nothing depends on that" is the kind of claim
that has been wrong four times already in this programme.

So item 7's test comes first and is a **behavioural** one: assert that `start()` followed by `stop()` on a page
whose namespace did not exist leaves the page in the same state whether or not the registration is there,
that is, write the assertion against `peekNamespace(page)` and the refcount, watch it pass before the deletion and
after it, and if it fails, the registration is required and the disposition flips to *wire it with a
comment that says why*.

## Method, and why each item is its own commit

1. **Test first, per item.** For a deletion, the red is either a source scan that the name is gone (for
   shape 3, where no test can exist by definition) or a rewritten test for a fixture that used to name it. For
   a wire-or-dedupe, the red is a behavioural assertion that fails against the current code.
2. **One commit per item**, so a revert is per-item and the commit body lists exactly which public names were
   deleted, which is the master plan's acceptance line. Group only when the items are mechanically inseparable.
3. **`npm run verify` green at every commit.** This is the phase's own gate: 876 tests before the phase, with
   the count *rising* by the guards this phase adds and *falling* by nothing (deleting a dead name deletes no
   test).
4. **Update the pinned name sets in the same commit as the deletion that invalidates them. That means**
   `common/tests/symbol-parity.test.ts` (133 frozen root exports) and `common/tests/exports-map.test.ts`'s
   `REQUIRED_RUNTIME_EXPORTS` for runtime names, `bootstrapped/tests/barrels.test.ts`'s `CLIENT_SURFACE` for
   item 5. A deletion that leaves a guard red is not landed.

## Order

Ascending risk, which is also ascending "how much can I be wrong about":

1. **Item 2 (`setETag`), item 4 (`hasCapturedGet`), item 3 (`GetCtorsOptions.page`)**: three unreferenced
   declarations with no consumer and no barrel presence (except `page`, which is a field of an exported type).
   One commit each, or one commit with three named deletions listed in the body.
2. **Item 5 (`emptyCatalogSource`)**: same shape, but the deletion must update the guard I added in 5.7e.
3. **Item 6 (`EMPTY_STARTUP_SINK` dedupe)**: behaviour-preserving, so it gets a behavioural equivalence test
   plus a one-home source scan, and the byte delta must be reported (the dedupe *shrinks* the bundle).
4. **Item 7 (comment-only `onTeardown`)**: needs the namespace-existence test first; riskiest of the
   deletions because it can interact with install/refcount.
5. **Item 1 (`formFallback`)**: the only item that removes a documented *capability* and rewrites a test that
   currently passes, so it lands last and with the largest commit body.

## Still to fold in: the audit's remaining unused-code findings

The master plan says *"plus the audit's remaining unverified `unused-code` findings in
`docs/audit/21-xcut-unused-api.md`"*. A read-only inventory of that document is in flight; its table (with a
disposition per finding, the same evidence shape as above) is appended to this plan **before** the items below
it are executed, and any finding that overlaps the eight above is reconciled rather than listed twice.

Two candidates are already known from the ledger's backlog and belong to this phase rather than to a later one,
so the inventory is expected to confirm them rather than discover them:

- `asOutboundString` (`bootstrapped/src/attach/raw-socket.ts`), recorded as dead code by the Phase 3 planner,
  to be deleted rather than fixed (its `JSON.stringify(undefined)` return type is a lie).
- `VersionResolver.invalidate()` (`headless/src/version.ts:221`) and callerless `sweepStale`, recorded as
  having no callers.

## Acceptance mapping

| Master-plan acceptance | How it is met |
|---|---|
| "a test asserts each surviving option/endpoint changes behaviour" | Items 6 (equivalence + one-home scan) and 7 (namespace-existence) survive with behavioural tests. Items 1 to 5 are deleted, so the clause does not apply to them; item 8 is recorded as already live with its two usage sites named. |
| "the deleted names are listed per commit" | Every commit body names each removed public name and says whether it was on a package's root surface, a module surface, or neither. |
| Phase gate | `npm run verify` exit 0 at every commit; final boundary re-runs `verify:catalog` and `verify:socket`, since item 1 touches `common`'s action registry and item 6 touches the transport's initial sink. |

## Risk / revert

The dangerous item is **1**: `formOf` decides the wire form an action is sent in, so a mistake there
changes protocol behaviour, and the phase's own evidence (a unit test on a registry) would not catch a wrong
*wire* answer. Two things bound it: the deletion removes a branch that is **unreachable today**
(`isFallbackEnabled` is a constant `false`), so the effective behaviour of `formOf` cannot change. The
live `verify:socket` check at the boundary exercises real sends through `GameActions`.

**Item 6** is the one that could surprise: `attached-transport.ts:323` compares sink *identity*
(`if (sink === this.sink) return false;`), so the dedupe must keep `EMPTY_STARTUP_SINK` a single shared
instance rather than a factory call at each use. `export const EMPTY_STARTUP_SINK = createEmptySink();` is one
instance created once at module evaluation, the same as the current object literal; the equivalence test
asserts the two sinks agree on every method, and the transport's refusal to re-attach the same sink is
otherwise unchanged.

**Item 7** is the one that could be wrong about the repository rather than about the code: if the namespace
creation at `client.ts:660` turns out to be required, the disposition flips and nothing is deleted.

---

## Corrections from the read-only inventory (folded in before executing beyond the first commit)

The inventory was run against with ripgrep and `git log -S`. It **disproves one of this plan's own
items** and finds eleven inert items the master plan's sentence does not name, so the table above is not the
work list. Corrections, in order of how wrong this plan was:

### C1: Item 7 does not exist. The plan's phrase is unsourced.

*"`EMPTY_STARTUP_SINK`'s duplicate teardown registration"* appears only in the master plan
(`2026-09-13-code-consistency.md:797`) and has no corroborating evidence in the code or in any audit: no name
is registered twice, `onTeardown` (`page/namespace.ts:240`) is a plain push, and `releaseInstall` splices each
entry once. What **is** dead is different, and the inventory found it:

| Real finding | Where | Why it is dead |
|---|---|---|
| Empty `onTeardown` registration | `client.ts:660-662` | the callback body is only a comment; this is audit 40's `:427-429`, anchor drifted. Its one non-obvious effect is that `onTeardown` calls `getNamespace(page)` and so *creates* the namespace; the failure mode below still applies. |
| `BootstrappedClient.teardowns` | declared `client.ts:227`, spliced `:975-977` | **never pushed to**, since the initial commit: the drain loop always iterates an empty array. |

So item 7 becomes two items, and the namespace-creation test in the failure mode note is owed for the first of them.

### C2: Item 6's disposition changes: delete the *name*, not the concept.

The inventory confirms `EMPTY_STARTUP_SINK` (`client.ts:1117`) is field-for-field identical to
`attach/detect.ts`'s `createEmptySink()` (`:113`), and adds the part this plan missed: its **behaviour is
required** because `client.ts:310` hands it to `AttachedTransport` as the initial sink, so the
pre-attachment state is honestly `'connecting'` rather than optimistically `'open'`
(`attached-transport.ts:229,370-376`). What is inert is the *name*: it is a second public door to a thing the
root surface already publishes as `createEmptySink` (`attach/index.ts:18` → `index.ts:75`).

Disposition, revised: **delete `EMPTY_STARTUP_SINK` and use `createEmptySink()` at `client.ts:310`**, updating
`index.ts:60`, `ROOT_SURFACE` and `CLIENT_SURFACE` in the same commit. One public way to make an empty sink,
not two.

**And the acceptance line is already unmet here**: the inventory reports that *no test anywhere asserts the
empty sink's behaviour or the pre-attachment `'connecting'` state*: `createEmptySink` appears in tests only as
a barrel pin. That test is therefore part of this item, not a nicety: without it the survivor is exactly as
inert as the thing being deleted.

### C3: Eleven more inert items, five of them outside the master plan's sentence *and* outside audit 21.

Audit 21 is **not** the outer bound in practice: its §3 (`asEnvelope` duplicated) and §5 (`Unsubscribe`
declared twice) were closed by Phases 3.3/3.7c and 3.1, so two of its five sections are stale-closed. And these
are inert without appearing in it:

| Item | Where | Note |
|---|---|---|
| `asOutboundString` | `raw-socket.ts:179`, re-exported `:552`, `attach/index.ts:32`, pinned `barrels.test.ts:46`/`ROOT_SURFACE:301` | Phase 3's plan item 28 said delete it; that never landed. Delete it rather than fix it, because its `JSON.stringify(undefined)` return type is a lie. |
| `getSpriteGraphicsCtor` | `render/index.ts:30` | a pure alias of `getGraphicsCtor` with zero callers; pinned `barrels.test.ts:196`/`ROOT_SURFACE:344`. |
| Aggregate `KEEPALIVE` | `headless/src/transport/standalone.ts:579` | zero callers; pinned `headless/tests/integration/exports-map.test.ts:67`. **`KEEPALIVE_PING`/`PONG` are live and stay** (C4). |
| `BootstrappedClient.teardowns` | `client.ts:227`, loop `:975-977` | see C1. |
| `LifecycleTimeouts.openMs` | `common/src/transport/seam.ts:92,100`; spread into `ClientCoreOptions` at `client.ts:250` | never read: `client.ts:451` reads `welcomeMs`, `:594` `commandAcMs` and `commandAckMs`, and `headless` hardcodes its own 20 s at `standalone.ts:127`. Phase 3 item 14 said "do not fix them in this phase; do not drop them either"; this phase is where that debt is paid. |

### C4: Item 8 resolves to "leave", with the aggregate as the only actionable part.

`KEEPALIVE_PING`/`KEEPALIVE_PONG` are live on the wire path (`standalone.ts:494` sends `PONG`) and asserted in
`headless/tests/transport/runtime.test.ts`. The master plan's hedge is settled: leave both. Only the
**aggregate** `KEEPALIVE` object is dead (C3).

### C5: Audit §2 is the largest item in the phase, and it is a per-name decision.

All **18** symbols in `common/src/state/paths.ts` are dead in `src/`: the module's only importer is a barrel
re-export, and the four the audit calls "called" (`player`, `activityLogs`, `playerCount`, `findPlayerIndex`)
are used **only by `common/tests/store.test.ts`**, so the audit's "4 live" reading is test-only usage. All 18
are pinned by name in `common/tests/symbol-parity.test.ts`, so one snapshot edit covers whichever subset goes.
The audit proposes deleting 8 and adopting 6 (`ROOM_ROOT`, `GAME_ROOT`, `PLAYERS`, `HOST_PLAYER_ID`, `CHAT`,
`USER_SLOTS`), where "adopt" means the module earns its keep by being *used* (a new `paths.test.ts`, and the
README's hand-written literals at `:119`/`:140` replaced by the helpers). That split is a design decision, not
mechanical work, so it is its own task in this phase with its own commit.

### C6: One deleted item closes a door. The deletion is still right.

`GetCtorsOptions.page` is deleted above. Audit 08 §5 wanted that option threaded into a
`schedule(callback, page?)` so polling could be cancelled. Deleting it is still right, because the field as written
is read by nothing, and an option whose documented use is impossible is the defect that Phase 2.3 removed a
redirect option for. But the door is now closed, so **if that cancellation capability is built (Phase 7), the
option is re-introduced together with the test that makes it change behaviour**, not restored as surface.

### C7: The acceptance line is unmet for every survivor, and meeting it is the phase's work.

The inventory's blunt finding: *no test asserts empty-sink behaviour, no test passes `GetCtorsOptions.page`, no
test calls `setETag`, no test exercises `formFallback` changing a result, and no `paths.test.ts` exists.* The
deletions are the easy half. For each survivor the acceptance line demands a test that **fails when the option
is removed**, and for C5 that test is what defines "adopt".

---

## Phase 6 closure: measured

Six commits, each independently revertable, each `npm run verify` green:

| batch | commit | what landed |
|---|---|---|
| plan | | the plan above, written from measurement; corrected by the inventory in C1 to C7 |
| 1 | | deleted `setETag` (+ its map and `If-None-Match`), `hasCapturedGet`, `GetCtorsOptions.page`, `emptyCatalogSource`; new `removed-surface.test.ts` guard |
| 2 | | the two *real* teardown items (C1): the comment-only `onTeardown` and the never-pushed `teardowns` field + drain loop |
| 3 | | deleted `EMPTY_STARTUP_SINK`; one public way to make an empty sink; the missing empty-sink and pre-attachment `'connecting'` tests |
| 4 | | deleted the `formFallback` mechanism (`FormFallback`, the option, the setter, `isFallbackEnabled`) and rewrote the test that codified the no-op |
| 5 | | deleted `asOutboundString`, `getSpriteGraphicsCtor`, the aggregate `KEEPALIVE`; gave the 20 s open default one home |
| 6 | | `state/paths.ts` decided name by name: 8 deleted, 10 kept and pinned by a new test |

**Deleted public names, per the acceptance line.** From a package root surface: `EMPTY_STARTUP_SINK`,
`asOutboundString`, `getSpriteGraphicsCtor`, `FormFallback`, `KEEPALIVE`, and, from `common`'s frozen
snapshot, the eight `state/paths.ts` helpers. From a module surface only: `emptyCatalogSource`,
`hasCapturedGet`. From a type: `FormRegistryOptions.formFallback`, `GetCtorsOptions.page`,
`LifecycleTimeouts.openMs`'s duplicate (`DEFAULT_OPEN_TIMEOUT_MS`). From a class: `setFormFallback`,
`RemoteJsonSource.setETag`. Not public at all: `isFallbackEnabled`, `BootstrappedClient.teardowns`,
`signatureOf`'s callers (there were none).

**Acceptance, per survivor.** The line is *"a test asserts each surviving option changes behaviour"*, and the
inventory's finding was that this was unmet for **every** item in the master plan's list: no test covered the
empty sink, `GetCtorsOptions.page`, `setETag`, a result-changing `formFallback`, or `state/paths.ts`. It is now
met where the phase kept something: the empty sink's full contract and the pre-attachment `'connecting'` state
(batch 3), the live `setActionForm` opt-in that the deleted fallback was pretending to be (batch 4), the one
home for the open timeout asserted by source scan with the reason a timing test would take 20 s (batch 5), and
`state/paths.ts` pinned literal by literal (batch 6). Where an item was deleted, the phase's artifact is the
`removed-surface` guard, which was red before each deletion and pins the decision afterwards.

**The two plan claims this phase disproved.** The master plan's *"`EMPTY_STARTUP_SINK`'s duplicate teardown
registration"* does not exist, because no name is registered twice, and the real dead teardown code was elsewhere
(C1). Its *"`KEEPALIVE_*` if unused"* resolves the other way: both constants are live on the wire path, and only
the aggregate object was dead (C4). A third, from the audit: `state/paths.ts`'s "4 of 18 are called" is
test-only usage, so all 18 were dead in `src`.

**Artifact.** 322,654 B at the Phase 5 boundary → **321,783 B**, with the three deletions that were inside the
bundle's entry graph accounting for the -871 (teardown loop -184, duplicate empty sink -231, the dead fallback
-456). The rest were byte-identical because esbuild had already tree-shaken them, which is itself the evidence
that they were unreachable.

**Not closed by this phase, and homed rather than dropped.** `C6`: deleting `GetCtorsOptions.page` closes the
door audit 08 §5 wanted for cancellable polling. If that capability is built in Phase 7, the option returns
with the test that makes it change behaviour. `C7`: the audit's `unused-code` label covered *declarations*; it
did not touch the `exports-map`/`symbol-parity` snapshot discipline, which now has eight fewer names to keep
honest.

**Boundary evidence.** `npm run verify` exit 0: lint, typecheck (src + tests), build, **888 tests
/ 0 fail / 0 skipped** (common 438, headless 199, bootstrapped 251), up 8 from the 880 the phase opened at,
because every deletion batch added the guard or the survivor test that pins it, and no deletion removed a test.
`npm run verify:catalog` exit 0: `ALL LIVE CHECKS PASSED` (`.logs/phase6-close-catalog.log`).
`npm run verify:socket` exit 0: `LIVE SOCKET CHECK PASSED (documented behaviour observed)`
(`.logs/phase6-close-socket.log`); that one matters more than usual here, because batch 4 changed the code that
decides the wire form an action is sent in.
