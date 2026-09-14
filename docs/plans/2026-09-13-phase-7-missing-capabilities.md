# Phase 7: Missing capabilities

Master plan, verbatim: *"Missing capabilities"*, with 7.1-7.5 as its table. Unlike Phase 6, which removed
surface, this phase **adds** capability, so the acceptance bar is the one the master plan has used all along:
each capability lands with a test that fails without it, and no capability is claimed that a test cannot
observe.

Written from measurement at the boundary (Phase 6 closed; `npm run verify` 888 tests / 0 fail / 0 skipped; bundle
321,790 B). A read-only scoping pass re-derived every line number, because the master plan's are from before
Phases 3-6 moved and renamed large parts of the tree.

## Three of the phase's premises are stale, and one of them is a live defect

| Task | What the master plan assumes | What is actually true |
|---|---|---|
| 7.1 | `startUserscript` has no teardown | **Two-thirds done.** `entry/userscript.ts:199-203` already registers an `onTeardown` that clears both intervals and destroys the badge (landed), and it is reachable: `client.stop` runs the teardown list. What is missing is the *handle*: `startUserscript` still returns `BootstrappedClient \| null` (`:76`). |
| 7.2 | `userscript.ts:205-210` clobbers the namespace | **Unfixed, and worse than a collision.** See below. |
| 7.4 | "`render/world.ts`" | **The target is a facade.** Phase 5 Task 5.7c turned `world.ts` into 17 lines of re-export; the class is `render/world-scene.ts` (651 lines). Half the fix landed too: `pixi.ts:212-214,218-221` already call `resetCtorCache()` when the renderer is recreated. |

### 7.2 is not a naming collision: it breaks the teardown path

`NAMESPACE_KEY` is `'__mgjs'`, and `isOurNamespace` (`page/namespace.ts:74-78`) requires
`marker === '__mgjs'` plus a string `version`. `entry/userscript.ts:112-116` writes the **`BootstrappedClient`
itself** to that key, and `globalThis.__mgjs` as well (`:117-121`). Then:

- `getNamespace` (`:89-97`) finds a value that is not a namespace and is `!== undefined`, so it **throws**:
  *"the page global `__mgjs` already exists and was not created by mg.js. Refusing to overwrite it."*
- `client.stop()` → `releaseInstall` → `getNamespace` therefore throws, so the `onTeardown` at `:199` never
  runs: the two intervals keep a closure over a torn-down client and the badge keeps painting a dead session.
  **That is 7.1's complaint**, arriving from 7.2.
- A second load's `claimInstall` throws for the same reason, **which is 7.2's complaint**.

The ordering is not in doubt: `start()` reaches `claimInstall(page)` with **no `await` before it** (verified: zero
awaits in the preceding 30 lines), so the namespace is created synchronously and destroyed a few lines later by
the entry's own write.

**And the mechanism for the fix already exists and is dead.** `page/namespace.ts:128-133` defines
`defineGlobal(name, value, page)`, documented at `:36-42` as *"the sanctioned replacement for the companion's
fleet of page globals: instead of `window.mgApiClient`, a mod reads
`getPage().__mgjs.globals.apiClient`"*, and **no file in `src` calls it**. The entry hand-writes the raw key
instead of using the registry built for that purpose. So 7.2's fix is to publish the client *through*
the namespace, which keeps the namespace intact and gives `defineGlobal` its first production caller.

**Consequence for ordering:** fixing 7.2 removes the raw `window.__mgjs = client` path, which is currently the
only page-reachable route to the client and so to `stop()`. **7.1's handle must land with or before 7.2**, or the
fix would trade a broken teardown for no teardown route at all.

## Task 7.1: a lifecycle handle for `startUserscript()`

**Steps.**

1. **Test first** (new `packages/bootstrapped/tests/entry/userscript.test.ts`, using the page stub the entry
   tests already use; confirm which fixture before writing): `startUserscript()` returns a handle whose `stop()`
   (a) clears both pollers, (b) destroys the badge host if one exists, (c) stops the client, and (d) is
   idempotent, meaning a second `stop()` is a no-op rather than a second teardown.
2. **The residual leak, which the current teardown does not close.** `badge` is assigned asynchronously inside
   `whenBody` (`:128-130`). If `stop()` runs before `DOMContentLoaded`, the teardown sees `badge === null`, and
   then `whenBody`'s callback runs and creates a host **that is never destroyed**. The test above must include
   that ordering: `stop()` before the body exists, then fire the body callback, then assert no host is left in
   the DOM stub. The fix is a `stopped` flag the callback checks before creating, not a second teardown path.
3. Return `{ client, stop }` instead of the bare client, and have `stop()` do the interval/badge work directly
   **in addition to** the existing `onTeardown` registration. The registration stays: it is what makes a
   `client.stop()` from any other caller total (I7), and the handle's `stop()` is the direct route.
4. Keep the module's bottom-of-file self-invocation (`:215-219`) working. It must not hold a handle it never
   uses, and a failure there must still not break the page.

**No pin edit.** `startUserscript` is exported from no barrel (absent from `ROOT_SURFACE`, and `entry/` is not in
`FOLDER_BARRELS`), so a new handle type is not published surface. If that changes, the barrel guards will say so.

## Task 7.2: publish the client through the namespace

**Steps.**

1. **Test first**, in the same new file. The assertions, in the order they fail today:
   - After `startUserscript()`, `peekNamespace(page)` is a namespace object, **not** a client: this is the
     collision itself.
   - `getNamespace(page)` does **not** throw afterwards (today it throws), and neither does `client.stop()`.
   - The client is still reachable from the page: `readGlobal<BootstrappedClient>('client', page)` returns it.
   - **A second load works**: a second `startUserscript()` on the same page claims the same namespace
     (refcount 2), and its `stop()` releases to 1 rather than tearing the first down.
2. Replace the two raw writes with `defineGlobal('client', client, page)` for the page realm. For the sandbox
   `globalThis`, decide explicitly rather than by habit: the namespace lives on the *page*, so a second raw
   write to the sandbox global is harmless to the namespace but it is also the thing that made the README's
   "in either realm" promise unverifiable. Prefer publishing once, on the page, and correcting the promise.
3. **Correct the README line that promises the old behaviour**: `README.md:144`, *"From the devtools console,
   `window.__mgjs` is the live client in either realm."* It is already on Phase 8.1's known-broken list; leaving
   it until 8.1 would leave a live document telling users to expect the shape this task removes. The
   corrected sentence names the real path: `window.__mgjs.globals.client`.
4. Re-check the badge's own hint text (`entry/userscript.ts:169-170`), which says *"window.__mgjs is the live
   client."* That is the same lie, in the code, on the user's screen.

## Task 7.3: raw-socket welcome replay

**The gap, verified.** `raw-socket.ts:16` says it outright in its own header: *"We have **no Welcome
subscription**, so reconnects are invisible."* `onWelcome` (`:444-447`) only adds to a `Set` and returns an
unsubscribe; the frame handler publishes a `WelcomeEvent` to whoever is subscribed **at that moment** (`:256-262`)
and stores nothing. So a subscriber added after the frame (the common case for a mod that attaches late) never
learns the session, even though the room path already replays: `room-binding.ts:496` does that, and
`attached-transport.ts:142,160,351` stores a `lastWelcomeValue` and exposes `lastWelcome`.

**Steps.**

1. **Test first** (in `packages/bootstrapped/tests/attach/raw-socket.test.ts`, or a new mirrored
   `attach/raw-socket-welcome.test.ts` if that file is already at its natural size): deliver a `Welcome` through
   the fake socket, **then** subscribe, and assert the handler is called with the stored event. This fails today.
   Add the negative case too: with **no** welcome seen, a late subscriber must get nothing rather than a
   fabricated event.
2. Store the last `WelcomeEvent` in the binding, and have `onWelcome` replay it to a handler registered after it
   arrived. One subtlety to get right and to test: the replay must be **synchronous on subscribe or
   asynchronous by design**, not both. Pick one and assert it, because a caller that writes
   `if (ready) ...` immediately after subscribing will depend on the choice.
3. Do not replay to a *reconnect*'s subscribers as if it were the current session: the binding's `release()`
   clears handlers (`:499`), so the stored value must be cleared on release too, and a stale welcome must not
   outlive the socket it came from.

## Task 7.4: renderer-recreation recovery

**Steps.**

1. **Test first**, against a swapped fake renderer: enter a scene, replace the renderer behind it, and assert the
   scene rebuilds rather than painting into a dead surface. The class is `render/world-scene.ts`; `world.ts` is
   only the re-export facade.
2. The two gaps, both verified: `sync()` (`:281-291`) re-resolves the renderer only when `!entered`, and `enter()`
   (`:193`) returns early when already entered, so after a recreation the scene keeps its stale references. Add
   `rebuild(stage?)` and have `sync()` self-heal through it.
3. `pixi.ts:212-214,218-221` already calls `resetCtorCache()` on recreation; `client.ts:649` calls a
   caller-supplied `onRendererRecreated` and nothing else. Decide in the test what the client's default should be:
   today the recovery is opt-in and silently absent when no callback is passed, which is the same "capability
   that only exists if you opt in" shape Phase 6 deleted elsewhere. If it stays opt-in, the plan must say so
   explicitly rather than leaving it implicit.

## Task 7.5: the four candidates, not planned yet

The master plan says **"scope them before starting"**, and that scoping is still in flight. This phase does not
execute 7.5 until it lands and its table is appended here with, for each candidate: what exists, what the smallest
honest implementation is, what it touches, whether the repository has evidence the capability is wanted, a risk
rating, and, where the honest answer is that the capability should **not** be built, the argument for rejecting
it. A capability added on speculation is the mirror image of the dead surface Phase 6 removed.

## Guards and pins each task must consider

| Guard | Touch? |
|---|---|
| `packages/bootstrapped/tests/barrels.test.ts` (`ROOT_SURFACE`, `CLIENT_SURFACE`, `FOLDER_BARRELS`) | Only if a name is added to or removed from a barrel. 7.1-7.4 add none: `startUserscript` is in no barrel. |
| `packages/headless/tests/integration/removed-surface.test.ts` | Not unless this phase deletes a name. |
| `packages/common/tests/symbol-parity.test.ts` | Not unless `common`'s root surface changes; 7.1-7.4 are all `bootstrapped`. |
| `packages/headless/tests/integration/structural-paths.test.ts` | New test files must name any `packages/...` path that exists. |
| `packages/*/tests/module-state.test.ts` | **Yes for 7.1/7.3**: a per-call `stopped` flag and a stored last-welcome are module or binding state. `bootstrapped`'s guard allow-lists the files that declare module-scope `let`/`var`, so new mutable state must be an instance field, or the allow-list entry is a deliberate edit with a reason. |

## Acceptance mapping

| Master-plan acceptance | How it is met |
|---|---|
| 7.1 handle with `stop()` | The new test asserts intervals cleared, badge host gone (including the `stop()`-before-body ordering), client stopped, `stop()` idempotent. |
| 7.2 reuse the namespace, second load works | The test asserts the namespace survives, `getNamespace`/`stop()` do not throw, the client is reachable via `globals.client`, and a second load refcounts to 2 and releases to 1. |
| 7.3 late subscriber gets the welcome | Fails today; the negative case (no welcome seen → nothing) is asserted beside it. |
| 7.4 swapped renderer recovers | Fails today with a fake renderer swap. |
| Phase gate | `npm run verify` exit 0 per commit; the boundary also runs `verify:catalog` and `verify:socket`, because 7.2 changes what the page publishes and 7.3 touches the raw-socket inbound path. |

## Risk / revert

**7.2 is the risky one, and its risk is behavioural rather than structural:** removing the raw `window.__mgjs`
write changes what every existing page-side consumer sees. Two things bound it: the namespace design already
specifies the sanctioned path (`globals`, `namespace.ts:36-42`), and the README's current promise is what Phase
8.1 has already flagged as wrong, so the correction is owed regardless. The one real hazard is an out-of-repo
mod reading `window.__mgjs` directly; there is no way to detect that from inside, so it is recorded as a
breaking change in the commit body.

**7.1's residual badge leak** is the subtle one: the failing ordering (stop before body) is invisible unless the
test drives it, so it is step 2 rather than a follow-up.

**7.3's replay timing** is the one where a wrong choice is not caught by the test that motivated it: whether the
replay is synchronous or asynchronous must be decided, documented and asserted, because callers will write
`if (ready)` immediately after subscribing.

**7.4 could quietly do nothing.** If the recovery stays opt-in via a callback the environment does not pass, the
capability exists only in tests. That is the failure mode to design against, and the reason step 3 asks the plan
to state the default explicitly.

---

## Scoping report folded in (read-only pass; three of this plan's own tables were wrong)

### C1: the `module-state` row overstated the guard

The guard matches `/^(?:export\s+)?(?:let|var)\s/` **per line**, so it only bites on a **column-zero**
`let`/`var`; a `stopped` flag or a stored last-welcome inside a closure is invisible to it, and neither
`entry/userscript.ts` nor `attach/raw-socket.ts` is in its allow-list. So 7.1/7.3 need no allow-list edit
unless the implementation *chooses* module scope, in which case the entry is a deliberate edit with a reason.
The corrected claim is narrower than "yes for 7.1/7.3".

### C2: 7.4 step 1 could not work as written

There is **no fake renderer anywhere** in the tree (`FakeRenderer`/`fakeStage`/`rendererId` have zero matches
under `packages/**/*.ts`), and a scene built with the `stage` option (which `world.test.ts`'s `makeScene`
always passes) **cannot observe a replacement at all**, because `WorldSceneOptions.stage` is captured once
into `private readonly stageOverride` and `findWorldContainer()` resolves `stageOverride ?? PixiStage.stage`.
`rebuild()` would re-resolve the same dead override. So the test swaps the **stage root** via `setStageRoot`
(the real, re-exported seam) or passes the new stage to `rebuild(stage?)`, and "swapped fake renderer" was
wrong wording. Also, none of the three live checks exercises WebGL context loss, so
7.4's acceptance rests entirely on the fake: `verify:socket` does not cover it.

### C3: 7.5's stated source does not exist

The master plan cites README *"missing features"*. There is no such section (`README.md`'s headings are at 1,
15, 26, 51, 62, 86, 88, 122, 152, 169, 194, 226, 240, 244, 256, 262, 268, 282, 323, 339, 399, 430; `## Known
limitations` at 323 is the nearest), no audit finding mentions any of the four candidates, and the only
occurrence of the four names in the whole `docs/` tree is the plan row itself. **The four candidates have no
source at all beyond that row.** They are not equal, and the scoping pass dispositioned them:

| Candidate | Disposition | Why |
|---|---|---|
| **Outgoing-command observer** | **Accept**: see 7.6 below | The only candidate where the gap forces consumers to duplicate library code. `client.ts` states that every outbound frame ends in `currentWebSocket.send()` and that both reference mods patch the socket for this reason, so a consumer wanting to observe outgoing commands must re-implement the envelope test `coexistence/envelope.ts` already owns. Three partial pieces exist and none is an observer: `SendAttempt`/`lastSendResult` is a single-slot post-hoc diagnostic, `room-binding.ts`'s `outbound` set is a **single**-slot interceptor (a second rewriter would double-renumber), and `installOutboundRewriter` is the rewriter itself. |
| **Tile-object access** | **Scope down** | The write side exists and the read side does not: `tileObjectIdx` is a required parameter of `MutationPotion` and `CropCleanser`, so the library can address a tile it cannot describe; a stale index silently mutates the wrong crop. Only the narrow shape is honest: resolve an index against the **already-observable state tree** via `client.store`. Reverse-engineering the game's live tile→object map from the render tree is high-risk and speculative. If built, it is a `common`-side state helper, which means `symbol-parity.test.ts`'s frozen 125-name snapshot is the pin to edit. |
| **Pointer/input observation** | **Reject**, recorded in DESIGN §10 | No source, no documented game input API, no screen→tile transform, per-frame cost the raw-socket header already treats as a hazard, and `entry/userscript.ts` states the boundary outright: "This is a wrapper, not a mod. It has no feature UI." |
| **DOM panel** | **Reject**, recorded in DESIGN §10 | A shadow-isolated collapsible panel already exists: `badge.ts` (`HOST_ID`, shadow root, detail pane, click-to-open, `destroy()`) filled by the entry with nine lines of live report. Generalising it is speculative surface, the mirror of what Phase 6 removed. |

### 7.6: the accepted candidate, as its own task

**An observe-only outgoing-command channel.** `attach/room-types.ts`'s `AttachedSink` gains `onSend(handler)
=> unsubscribe`, fed from the same point `room-binding.ts` applies its interceptor, so it consumes no sequence
number and cannot displace the rewriter (the ordering constraint `room-binding.ts:159-166` documents).
Observe-only is the whole design: a second *rewriter* is the double-renumbering failure the coexistence layer
exists to prevent. Touches `room-types.ts`, both sink implementations (`raw-socket.ts`, `room-binding.ts`) and
`attached-transport.ts`; a new exported type may need the `attach` barrel's `types` array. Test: send through
each attachment path and assert the observer sees every frame the rewriter saw, in order, and that an observer
throwing does not stop the send, the same "one bad subscriber" rule `transport.test.ts` already pins. Risk is
low because it is additive and the seam already carries every frame.

### C4: two open audit findings belong to no phase, and both are render/client-adjacent

- **Audit 08 §2** (`docs/audit/08-bootstrapped-render-core.md:43`): *"`penPets` hides exactly one node, so the
  farm's pets stay on the claimed tiles, high."* Verified still true: `render/world-scene.ts:557-561` uses
  `PixiStage.findNode?.(...)`, and the fix names `findAllNodes` (`ctors.ts:538`, beside `findNode` at `:476`).
  This belongs in 7.4's neighbourhood: it is a render-capability bug, not a missing feature, and is folded
  into 7.4 rather than left homeless.
- **Audit 11 §2** (`docs/audit/11-bootstrapped-client-userscript.md:55`): *"A failed `install()` leaves the
  client claiming to be installed, and `uninstall()` itself throws, high."* No `rollbackInstall` exists;
  `start()` sets `ownsClaim = true` **before** `claimInstall` and wraps none of its fallible steps. Two halves
  did land (`installed = true` only at the end, and `stop()` uses `getPage()`), so the confirmed case is partly
  mitigated, but this is correctness rather than capability, so Phase 7's premise does not reach it. It gets a
  **Phase 8** line rather than being silently dropped. Note 7.2 has just made the *observed* failure mode
  smaller: `stop()` no longer throws on a userscript-started client.

### C5: the master plan's 7.x anchors are all stale

It cites `userscript.ts:205-210` and `realm.ts:239` (today `entry/userscript.ts:112-116` and
`page/namespace.ts:89-110`), `render/world.ts` (a 17-line facade), and a README section that does not exist.
Only its 7.1 and 7.3 rows point at real code. The master plan's Task 7.5 row should be restated as *no source
exists*, with the dispositions above as the decision.

---

## Phase 7 closure: measured

Six commits, each `npm run verify` green:

- the plan, written from measurement
- the entry split into `main.ts` (auto-run) + `userscript.ts` (importable), which 7.1 needed to be testable at all
- 7.1 + 7.2: the handle, and the namespace publication that fixes a live throw
- 7.3: the raw-socket welcome replay
- 7.4: `rebuild(stage?)` + `sync()` self-heal, plus audit 08 §2
- 7.6: the observe-only outbound channel
- the scoping folded, with two rejections recorded in DESIGN §10
**Boundary evidence.** `npm run verify` exit 0: lint, typecheck (src + tests), build, **904 tests /
0 fail / 0 skipped** (common 438, headless 199, bootstrapped 267), up 11 from the 893 the phase opened at, and
every one of them a test for a capability that did not exist or a guard relaxed to its claim. `verify:catalog` exit 0: `ALL LIVE CHECKS PASSED`
(`.logs/phase7-close-catalog.log`). `verify:socket` exit 0: `LIVE SOCKET CHECK PASSED (documented behaviour
observed)` (`.logs/phase7-close-socket.log`); that one matters here because 7.2 changed what the page publishes
and 7.3 changed the inbound welcome path. Bundle 322,434 → **325,179 B**.

**What this phase found that the plan did not know.**

- **7.2 was not a naming collision.** The entry wrote the client over the namespace's own key, and because
  `start()` reaches `claimInstall` with no `await` before it, the namespace was created and then destroyed a few
  lines later. `startUserscript` threw out of its own `onTeardown` registration, so the pollers were created
  and their teardown was never registered: they leaked **unconditionally**, not merely on `stop()`. The fix uses
  `defineGlobal`, the namespace's own sanctioned path, which had no caller in `src`.
- **7.1 was two-thirds done**, so it became a return-type task plus a leak the audit had not named: a badge
  created after `stop()` had nobody to destroy it.
- **7.4's premise was wrong twice over.** `render/world.ts` is a 17-line facade (the class is
  `world-scene.ts`), half the fix had landed as `resetCtorCache()`, and, in the part that mattered, a scene built
  with the `stage` option *cannot* observe a replacement, because the option is captured into a readonly field
  that wins at the lookup. The plan's "swap a fake renderer" step was untestable as written.
- **7.5's stated source does not exist.** No README "missing features" section, no audit finding, no
  half-built code: the four candidates' only home was the master-plan row itself. Two are rejected and recorded
  in DESIGN §10. The accepted one became 7.6.
- **7.6 deviates from the plan's sketch.** The channel is on `AttachedTransport`, not on
  `AttachedSink`: the sink is private to the transport, so a sink-level channel would have been a capability
  nobody could call. That was the inert surface Phase 6 spent six commits deleting.

**Acceptance, per task.** 7.1: intervals cleared, badge host removed (including the `stop()`-before-body
ordering), `stop()` idempotent, client stopped. 7.2: the namespace survives a start, `getNamespace`/`stop()` do
not throw, the client is reachable at `window.__mgjs.globals.client`, and a second load refcounts 2 → 1. 7.3: a
late subscriber is replayed the scraped welcome synchronously, and nothing is replayed when there was none, to
a subscriber already present, or after `release()`. 7.4: every pet in the subtree is penned; `sync()` rebuilds
onto a replaced root and unwinds the old one; a pinned stage is kept until `rebuild(stage)` moves it. 7.6: an
accepted frame is observed as the sink received it, a refused frame is not, unsubscribe works, and a throwing
observer eats nothing.

**Carried forward, not dropped.** Audit 11 §2 (a failed `install()` leaves the client claiming to be installed,
and `uninstall()` throws) goes to Phase 8: it is correctness rather than capability, so this phase's premise
does not reach it, and 7.2 has already removed one of its two failure modes by making `stop()` work on a
userscript-started client. Automatic scene recovery on renderer recreation stays the caller's job, and the
client's comment now says why rather than implying a mod will know what to call: `render.worldScene` is a
factory that does not retain the scenes it hands out.
