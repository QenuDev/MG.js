# Code consistency and hardening: improvement plan

> **For agentic workers:** this is a **program** of eight phases, not one task list. Phase 0 and Phase 1
> are specified step-by-step and can be executed as written. Phases 2 through 8 are scoped work packages: each
> produces working, testable software on its own, and the executing agent writes its own detailed
> step-by-step plan (in this directory) before starting it. Use
> `superpowers:subagent-driven-development` or `superpowers:executing-plans` per phase. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** make `mg.js` consistent with `docs/DESIGN.md`: one client contract, one home per helper, a
stated file structure, enforced invariants. It must also fix the four critical defects the audit found.

**Architecture:** keep the three-package split and the `protocol → state → actions → client → platform`
layering; converge the four client classes onto one `MgClient` contract; move each duplicated helper to a
single owner in `common`; apply the folder rule (≥2 modules or a published subpath) and mirror tests to
source paths; enforce the nine invariants in `docs/DESIGN.md` §6 with tests rather than comments.

**Tech stack:** TypeScript 5.9 (NodeNext ESM, `strict` + `noUncheckedIndexedAccess` + `noUnusedLocals` +
`noUnusedParameters`), npm workspaces, `node --test` via `tsx`, esbuild for the userscript, `ws` as an
optional peer for header-capable sockets, Biome for lint+format, GitHub Actions for the gate.

**Spec:** `docs/DESIGN.md`. This plan argues from it; executors read both. Evidence for every defect
named below is in `docs/audit/00-index.md` and the per-area reports it links.

**Baseline at the time of writing:** `tsc -b --force` exit 0, 490 tests reported (16 of them silently
skipping; see Phase 0 Task 3), `npm run build` exit 0, userscript 276.2 KiB (282,800 B), `verify:live`
all-passed. **Nothing below has been implemented yet.**

> **Baseline correction (added after Phase 3).** The number above was what `npm test` *reported*, not the
> true size of the suite. The programme's real starting count was **566 tests**; the "490" here and the
> "500" recorded at the end of Phase 0 (and the "500" in
> `docs/plans/2026-09-13-phase-2-wire-hardening.md`'s baseline and verification-plan lines) are reported figures, and the 16 skips were
> the artifact assertions Phase 0 Task 3 made run. At the end of Phase 3 the suite reports **736 tests**
> (bootstrapped 181, common 386, headless 169), 0 fail, 0 skipped. The Phase 2 plan's own copy of the stale 500
> is corrected by its own concurrent Phase 2 close-out pass.

## Global constraints

These apply to every task and are not repeated per task.

- **Relative imports always end in `.js`** (NodeNext ESM). No CJS, no `require`. Exactly one exception
  exists today (21 test files import `.ts`) and Phase 0 removes it.
- **`common` stays platform-free**: `"lib": ["ES2022"]`, `"types": []`, zero runtime dependencies, no
  `node:*`, no DOM globals, no `ws`. Browser-safe HTTP is injected as a function.
- **`headless` and `bootstrapped` never import each other**, directly or through `packages/*/src` paths.
- **The userscript must remain one self-contained file**: no external imports, no `eval`, no second
  output chunk. `npm run build` proves it.
- **`strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters` stay on** for source
  *and* tests. `tsc -b --force` and `tsc -p tsconfig.tests.json` both exit 0.
- **No public option may be inert** and no test may be unable to fail (invariants I8, §5 of the spec).
- **Every commit leaves `npm run verify` green**, and after Phase 0, `verify` means
  lint → typecheck(src+tests) → build → test → size.
- **Behaviour changes need a test that fails before and passes after.** Refactors need the existing
  suite to stay green and the public surface to stay identical unless the task says otherwise.
- **Breaking changes are allowed** (pre-1.0), but each one is listed in the task that makes it.

---

## Phase 0: Make the gates real (must be first)

Nothing else in this plan can be trusted until this phase lands: today `npm install` cannot run, tests
are typechecked by nothing, and the artifact assertions that would catch Phase 1's bugs never execute.

**Status: COMPLETE.** Landed (0.1) · (0.3) · (0.4, size + assertion)
(0.6, license) · (0.2) · (0.4, live scripts) · (0.5, Biome),
with task 5.3 pulled forward and Phase 1.1.

Deviations from the text below, all deliberate: 5.3 ran first (it fixed a real breakage rather than a
style question, and its acceptance check is what proves the workspace install); 0.2 was fixed by a
delegated agent and independently reviewed; the `verify` string was grown incrementally (`size` in 0.4,
`lint` in 0.5) so every intermediate commit stayed green, so the final string differs from
0.3's; and the two live scripts were rewritten by a delegated agent, which found a fifth bug on the way
(`verify-live-socket.ts` could exit 0 **without printing any verdict**, because the teardown awaited a
reconnect backoff whose internal waits are `unref`'d).

Measured at the end of the phase: `npm run verify` exit 0, biome 108 files 0 diagnostics, `tsc -b` and
`tsc -p tsconfig.tests.json` both exit 0, **500 tests / 0 fail / 0 skipped** (the figure the runner
reported; the programme's true starting count was **566**; see the baseline correction at `:25`), bundle 277.8 KiB
(284,467 B, +1,667 B from the formatting pass), size budget enforced. `npm ci` from a clean checkout
recreates all three workspace links.

### Task 0.1: Pin the npm cache and regenerate the lockfile

**Files:** create `.npmrc`; regenerate `package-lock.json`; keep `.npm-cache/` gitignored.

- [ ] **Step 1: Reproduce the failure**

Run: `npm ls --depth=0`
Expected: `npm error code ELSPROBLEMS`, `UNMET DEPENDENCY @mg.js/bootstrapped`, `UNMET DEPENDENCY
@mg.js/headless`, and a log line about `$HOME/.npm/_logs` being unwritable. `npm pack --dry-run`
fails outright with `EROFS`.

- [ ] **Step 2: Write the config**

```
# .npmrc
cache=.npm-cache
```

- [ ] **Step 3: Regenerate and assert**

Run: `npm install && npm ls --depth=0`
Expected: clean tree, no `UNMET DEPENDENCY`, and `ls node_modules/@mg.js` shows **three** symlinks
(`common`, `headless`, `bootstrapped`) instead of today's one.

- [ ] **Step 4: Prove the lockfile is complete**

Run:
`node -e "console.log(Object.keys(require('./package-lock.json').packages).filter(k=>/^packages\/[a-z]+$/.test(k)))"`
Expected: `[ 'packages/bootstrapped', 'packages/common', 'packages/headless' ]`. The lockfile's
`packages` map today contains **only** `packages/common` and `node_modules/@mg.js/common`.

Then prove reproducibility: `rm -rf node_modules && npm ci && npm ls --depth=0`
Expected: exit 0 and the same three symlinks.

- [ ] **Step 5: Re-run the full suite and note any version drift**

Run: `npm run verify`
Expected: exit 0. Everything is caret-ranged, so the fresh lock may pick newer patch/minor versions; if
something breaks, pin the offender in this commit rather than chasing it later.

- [ ] **Step 6: Commit**

```bash
git add .npmrc package-lock.json package.json
git commit -m "chore: pin the npm cache so installs are reproducible"
```

### Task 0.2: Typecheck the tests and the scripts

**Files:** create `tsconfig.tests.json`; delete `packages/headless/tsconfig.test.json`; modify root
`package.json`; fix 18 errors across `packages/*/tests/**`.

**Interfaces:** the new project must set `noEmit: true`, `composite: false`, `declaration: false`,
`allowImportingTsExtensions: true`, `types: ["node", "tampermonkey"]`, and include
`packages/*/src/**`, `packages/*/tests/**`, `scripts/**`, `packages/bootstrapped/scripts/**`. It is
invoked with `tsc -p` (not `tsc -b`) because it is not composite.

- [ ] **Step 1: Write the config and see every error**

```jsonc
// tsconfig.tests.json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true, "composite": false, "declaration": false, "declarationMap": false,
    "allowImportingTsExtensions": true, "types": ["node", "tampermonkey"]
  },
  "include": ["packages/*/src/**/*.ts", "packages/*/tests/**/*.ts", "scripts/**/*.ts",
              "packages/bootstrapped/scripts/**/*.ts"]
}
```

Run: `npx tsc -p tsconfig.tests.json`
Expected: **18 errors**. Known examples to confirm the config works:
`packages/common/tests/client.test.ts(501,26) TS2345`, `packages/common/tests/forms.test.ts(223,29)
TS18046`, `packages/common/tests/client.test.ts(704,11) TS6133 'delegated' is declared but never read`,
`packages/bootstrapped/tests/attach.test.ts(27,15) TS6196 'InboundMessage' is declared but never used`,
`packages/headless/tests/integration.test.ts(502,28) TS2339 Property 'superseded' does not exist on
type 'never'`.

- [ ] **Step 2: Fix the 18 errors with real fixes, not `any`**

Rules: an unused import is deleted; a wrong type is corrected at the source if the source is wrong;
`unknown` is narrowed with a type guard rather than asserted; a genuine test bug (asserting on the wrong
shape) is fixed in the test. **Do not** add `@ts-expect-error`, `as any`, or widen a source type to
silence a test error.

- [ ] **Step 3: Delete the dead config and wire the gate**

Run: `git rm packages/headless/tsconfig.test.json` (grep proves nothing references it).
Then in root `package.json`:

```json
"typecheck": "tsc -b --force && tsc -p tsconfig.tests.json",
"typecheck:src": "tsc -b --force"
```

- [ ] **Step 4: Verify both directions**

Run: `npx tsc -p tsconfig.tests.json` → exit 0.
Run: `npm run typecheck` → exit 0.
Then prove the gate can fail: add `const unusedForTheProbe = 1;` to a test file, run
`npm run typecheck`, expect `TS6133`, and remove it.

- [ ] **Step 5: Commit**

```bash
git add tsconfig.tests.json package.json packages/*/tests packages/common/src packages/headless/src packages/bootstrapped/src
git commit -m "test: typecheck the tests and scripts, and fix the 18 errors it finds"
```

### Task 0.3: Make `verify` build before it tests

**Files:** modify root `package.json`; modify `packages/bootstrapped/tests/build-output.test.ts`.

**Why:** `verify` is `typecheck && test && build`, so `built = existsSync(dist/magicgarden.user.js)` is
false on a clean checkout and all **16** artifact assertions skip, so the standalone-userscript property
has never been asserted on any run.

- [ ] **Step 1: Prove the assertions skip today**

Add a temporary `console.log('artifact present:', built)` to `build-output.test.ts` and run:
`rm -rf packages/bootstrapped/dist && npm test`
Expected: `built: false` and 16 `# SKIP` lines for the artifact tests.

- [ ] **Step 2: Reorder the gate**

```json
"test": "npm run test --workspaces --if-present",
"build": "tsc -b && npm run bundle -w @mg.js/bootstrapped",
"verify": "npm run typecheck && npm run build && npm test"
```

Add `"bundle": "npm run bundle -w @mg.js/bootstrapped"` to root, rename
`packages/bootstrapped`'s `build:userscript` → `bundle`, and update the string in
`build-output.test.ts:58-59` in the same commit. Give `packages/headless/package.json` the `test`
script it is missing, so `--workspaces` discovers all three packages. Replace the two hand-written
`test:unit`/`test:integration` globs with the three per-package names (`test:common`, `test:headless`,
`test:bootstrapped`). A fourth package must not be able to silently stop being tested.

**Land this incrementally, one gate at a time, so every commit is green:** this task's `verify` is
`typecheck && build && test`; Task 0.4 appends `&& npm run size`, and Task 0.5 prepends
`npm run lint &&`. The final string is the one shown in DESIGN §7.

*Measured after this change:* a bare `npm test` on a tree with no artifact reports 113 bootstrapped
tests with **16 skipped** and prints the warning; `npm run verify` from the same clean state reports
113/113 with **0 skipped**, and the previously-never-executed assertions ("bundle contains no ESM import
or export statements", "no CommonJS require calls", "no Node built-in imports") pass. Per-package totals
after `--workspaces` discovery: common 278, bootstrapped 113, headless 103.

- [ ] **Step 3: Prove the assertions now run**

The skip logic itself is deliberate and justified: `build-output.test.ts:18-28` explains that a fresh
checkout has no artifact, that failing would make the suite order-dependent, and that it prints a loud
warning naming the build command. That reasoning is sound; the defect is purely that `verify` tests
*before* it builds, so the artifact never exists at test time and the warning is the only thing that
ever runs. **Keep the skip** (it is the right behaviour for a bare `npm test`) and fix the order.

Run: `rm -rf packages/bootstrapped/dist && npm run verify`
Expected: exit 0, and the artifact assertions **execute** inside `verify`. Record both counts: on a tree
with no artifact, a bare `npm test` reports the bootstrapped package as 113 tests with **16 skipped**;
inside `verify` it must be 113 with **0 skipped**.

- [ ] **Step 4: Commit**

```bash
git add package.json packages/*/package.json packages/bootstrapped/tests/build-output.test.ts
git commit -m "test: build before testing, so the userscript artifact is actually asserted"
```

### Task 0.4: Delete the assertions that cannot fail, and add a size gate

**Files:** `packages/headless/tests/room-socket.test.ts`, `scripts/verify-live-socket.ts`,
`scripts/probe-guest-encoding.ts`, create `scripts/assert-bundle-size.ts`, root `package.json`.

- [ ] **Step 1: `assert(x > 0 || true)`**

`room-socket.test.ts:214-217` asserts `server.commands.length > 0 || true`, which is `assert.ok(true)`.
Work out what it meant (the commands the mock server should have received), assert the real value, and
confirm the test still passes. If it cannot pass, that is a bug to fix, not a test to weaken.

- [ ] **Step 2: The live socket script must fail**

`verify-live-socket.ts` reports `PASS` and exits 0 for *any* connection failure (`:158`, `:161-171`,
`:178`, `:195`). Make failure classes explicit: the documented guest `4840` is an expected outcome with
its own exit code and message; every other close, timeout, or handshake failure exits non-zero with the
code and reason. `probe-guest-encoding.ts` currently always exits 0. It must exit non-zero when an
encoding that should be rejected is accepted.

- [ ] **Step 3: The size gate**

Create `scripts/assert-bundle-size.ts`: fail above **320 KiB (327,680 B)**, warn above **300 KiB**,
print the delta against the recorded baseline. Wire it as `"size": "tsx scripts/assert-bundle-size.ts"`
and add it to `verify`. Replace the vacuous `assert(stats.size > 20_000)` in `build-output.test.ts:68`
with a call to the same budget constant.

- [ ] **Step 4: Verify each gate can fail**

Run: `npm run size` → exit 0 at 282,800 B.
Temporarily set the fail threshold to 200,000 and re-run → exit 1 with the size printed. Revert.

- [ ] **Step 5: Commit**

```bash
git add scripts packages/headless/tests/room-socket.test.ts packages/bootstrapped/tests/build-output.test.ts package.json
git commit -m "test: remove gates that cannot fail and add a real bundle-size budget"
```

### Task 0.5: Biome, then one formatting pass

**Files:** create `biome.json`; root `package.json`; the whole repo (formatting only).

- [ ] **Step 1: Config**

`biome.json`: space indent, width 2, `lineWidth` **110** (decided; see DESIGN §11.5; 100 would rewrap
~299 code lines, 110 only ~57, and comments are never rewrapped either way), single quotes, semicolons always, trailing
commas all, LF; `organizeImports` on; recommended lint rules on, with these off or downgraded where the
codebase differs by design: `noExplicitAny` (downgrade to warn), `noNonNullAssertion` (off, because the
codebase does not use `!`), `useLiteralKeys` (off, because wire records rely on index signatures).

- [ ] **Step 2: Format pass, alone**

Run: `npm i -D @biomejs/biome && npx biome check --write .`
Expected: a formatting-only diff of roughly **300 code lines** at width 100, or ~57 at width 110. (An
earlier estimate of ~2,039 was wrong: it counted every line over 100 columns, but 1,896 of the 2,195 are
*comments*, and Biome does not rewrap comments. Measure before and after with
`git diff --stat` and `git diff -w --stat`; the two should be nearly identical.)

- [ ] **Step 3: Wire the lint gate and commit**

`"lint": "biome check ."`, `"lint:fix": "biome check --write ."`, `lint` first in `verify`.

```bash
git add -A biome.json package.json
git commit -m "chore: adopt biome (one devDependency, one config) and apply the formatting pass"
```

### Task 0.6: License, ignore hygiene, and script naming

**Files:** create `LICENSE`; `.gitignore`; rename the two root scripts; root `package.json`; README.

- [ ] **Step 1:** Add MIT `LICENSE` (**open question §11.2**: do not guess the holder; ask first).
- [ ] **Step 2:** `.gitignore`: add `*.tgz` (so `npm pack` cannot dirty the worktree) and
  `docs/audit/` **if** the evidence is not to be versioned (open question §11.3).
- [ ] **Step 3:** `git mv scripts/verify-live.ts scripts/verify-catalog.ts`,
  `git mv scripts/verify-live-socket.ts scripts/verify-socket.ts`; wire
  `verify:catalog` / `verify:socket` / `probe:guest`; update the usage comments inside both scripts
  (they say `node --import tsx` while the npm script uses the `tsx` CLI), the README command block, and
  the two cross-references at `packages/headless/src/auth/guest.ts:44` and
  `packages/headless/tests/session.test.ts:7`. Change `verify-socket.ts`'s imports at `:47-49` from
  `../packages/headless/src/client.js` to `@mg.js/headless`, and that single change makes it the command
  that proves Task 0.1 worked.
- [ ] **Step 4:** `chmod 644` the three scripts currently mode 600.
- [ ] **Step 5: Commit** as one commit (renames + references must land together).

**Phase 0 exit criteria:** `npm run verify` green from a clean checkout with `npm ci`; artifact
assertions execute; `npm run size` enforces a budget; the test project typechecks; `npm run lint` clean.

---

## Phase 1: Critical defects and credentials

Four critical findings plus the two credential leaks. Each task is independent and can be reviewed
alone; the fixes are small and the tests matter most.

### Task 1.1: Prototype pollution and index padding in the patch applier

**Status: COMPLETE**. All three vectors are closed (the container walk, the `add` leaf
write, and `deleteAt`), and padding is bounded at `MAX_ARRAY_PADDING = 10_000`. `deepClone`'s lost-key
bug is fixed in the same commit (`Object.fromEntries`). The six new cases in the `applyPatch`
hostile-path suite and the `deepClone` unsafe-key suite fail 5-of-6 against the previous source; a
separate probe confirms `Object.getOwnPropertyNames(Object.prototype)` is unchanged at 12.

**Files:** `packages/common/src/state/patch.ts`, `packages/common/src/state/pointer.ts`, tests.

**Interfaces:** `applyPatch` keeps its signature; add an internal
`isForbiddenToken(token: string): boolean` (true for `__proto__`, `constructor`, `prototype`) and
`isCanonicalIndex(token: string): number | null` (non-empty, no leading zeros, `< 2**32 - 1`).

- [ ] **Step 1: Failing test for pollution**

```ts
// packages/common/tests/state/patch.test.ts
it('refuses a patch path that would pollute Object.prototype', () => {
  const outcome = applyPatch({}, [{ op: 'add', path: '/__proto__/pwned/inner', value: 1 }]);
  assert.equal(outcome.failed, 1);
  assert.equal(({} as Record<string, unknown>)['pwned'], undefined, 'Object.prototype must be clean');
});
```

Run: `npx tsx --test packages/common/tests/state/patch.test.ts`
Expected: FAIL. `Object.prototype.pwned` is `{ inner: 1 }` (the audit measured `applied: 0, failed: 1`
and yet pollution happened, because the write at `patch.ts:180` runs before the failure is recorded).

- [ ] **Step 2: Failing test for index padding**

```ts
it('refuses a non-canonical array index instead of padding the array', () => {
  const doc: Record<string, unknown> = { data: { arr: [] } };
  const outcome = applyPatch(doc, [{ op: 'add', path: '/data/arr/20000000/x', value: 1 }]);
  assert.equal(outcome.failed, 1);
  assert.equal((doc['data'] as { arr: unknown[] }).arr.length, 0);
});
```

Expected: FAIL: the array becomes 20,000,001 long in a few hundred ms.

- [ ] **Step 3: Implement the guards**

In `ensureContainer`: skip and fail on a forbidden token; use `Object.defineProperty` (or
`Object.create(null)`-safe assignment) for the write instead of `record[token] = slot`. In the array
path: reject a non-canonical index rather than assigning past the end. Keep `pointer.ts:85`'s existing
leaf guard and make both use the same helpers so the two paths cannot disagree.

- [ ] **Step 4: Fix the second, separate bug in the same function**

`deepClone` at `patch.ts:366` drops keys (the audit flagged it as a lost-key bug, not pollution). Add a
test with an object containing `__proto__`-free but unusual keys (`''`, `'0'`, `'a.b'`, `'~'`) and fix
the walk.

- [ ] **Step 5: Run everything**

Run: `npm test -w @mg.js/common` → all pass, including the two new tests.
Run: `npm run typecheck` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/common/src/state packages/common/tests
git commit -m "fix(common): reject forbidden tokens and non-canonical indices in JSON-Patch paths"
```

### Task 1.2: WorldScene layers must be visible

**Files:** `packages/bootstrapped/src/render/world.ts`, tests.

**Why it is critical:** `world.ts:480` sets `container.visible = false` and nothing anywhere sets it
back (`grep` over `src`, `tests` and `dist` finds no `visible = true`), while `world.ts:399` adds every
sprite into that container. **No scene can display a sprite.**

**Status: landed**. Both defects are fixed, along with the `setLayerVisible(name, visible)` affordance the
invariant test needed in order to name a layer (`false` for an unknown name, so a typo is distinguishable
from a hidden layer; it is not recorded as a `Restore`, since the container is scene-owned and
`exit()` destroys it). The test file is `packages/bootstrapped/tests/world.test.ts` (not the
`tests/render/world-scene.test.ts` path sketched below; the package mirrors `src` paths one level up).

Two fixture traps found while writing it, recorded because a copy of this fixture would otherwise hide the
defect it exists to catch: the label-search root must not be the world itself (a *labelled* stage aliases
the search, and then `hideUnderlying` hides the stage, masking defect B), and a fake `Graphics` has to
extend the fake container because real Pixi's does and `addSprite` reaches for `addChild`. The foreign-write
test needs a slot with three distinct values: with a boolean, the stale restore and the foreign restore
coincide and the bug is unobservable, which is how the first version of that test passed pre-fix.

- [ ] **Step 1: Failing test**

```ts
it('leaves the layer container visible after enter()', () => {
  const scene = makeWorldScene(...);
  scene.enter();
  assert.equal(scene.layerContainerFor('actors').visible, true);
});
```

Run: `npx tsx --test packages/bootstrapped/tests/render/world-scene.test.ts` → FAIL.

- [ ] **Step 2: Fix the visibility**

Set the container visible (it is scene-owned and destroyed on exit, so suppression was never needed),
**or** if suppression is required by the game, record it in `restores` via
`recordAndSet(this.restores, container, 'visible', false)` so it is restored, and expose
`setLayerVisible(name, visible)` for callers. Add the test that whichever choice was made holds.

- [ ] **Step 3: Fix the suppression-restore hazard in the same file**

`world.ts:840-853` records a *second* scene's value as its own no-op and then restores unconditionally
(`:289-300`), so two scenes cannot coexist. Make the restore skip when the current value is not ours
(the same identity-guard rule as §6 I2), and cover it with a two-scene test.

- [ ] **Step 4: Verify + commit**

Run: `npm test -w @mg.js/bootstrapped` → pass.
`git commit -m "fix(bootstrapped): a scene layer can be visible again, and suppression restores safely"`

### Task 1.3: The renumbering handle must not hand back a detached machine

**Files:** `packages/bootstrapped/src/coexistence/renumber.ts`, `brand.ts`, tests.

**Why it is critical:** when the install slot is already ours, `brand.ts:231-233` returns `'reused'`
without wrapping, but `renumber.ts:502` has already built a new machine and returns it, so the caller
numbers commands into a counter nobody reads while `active: true` is reported. Two live rewriters (or a
dead one that looks live) breaks invariant I1 and poisons the session with `invalid_sequence`.

**Status: Steps 1, 2 and 4 landed** (subject: "one live renumbering machine, not a detached
second one", not the message drafted below). Implemented with a `WeakMap` keyed by the branded wrapper,
since `brand.ts` brands the function and carries no payload: a reachable machine is adopted (`reason:
'reused'`, `release()` false), an unreachable one, a different copy of the module, is refused (`reason:
'already-installed'`, `renumberer: null`), and a safety-net branch covers the case where `classifySlot`
and `installHook` disagree about an inherited branded `send`. Breaking contract change: `renumberer` is
now `Renumberer | null`, with a new `reason`. Verified by an independent whole-tree gate in an isolated
worktree (exit 0, 506 tests reported; see the baseline correction at `:25`; 0 skipped, bundle within budget), which the reviewer reproduced rather than
taking on report.

Two things the review turned up that are **not** in this task's scope and are recorded here so they are
not lost:

- **Step 3 landed**, and it was larger than the one-line summary above, so the
  summary is corrected here. The duplication is worse than "in spirit": the two copies took different
  routes, because `applyRenumbering` pre-filtered on `length < 16` / `includes('QuinoaCommand')` and then
  `JSON.parse`d, while `applyRenumberingToString` used `parseEnvelope` and added an `isOurs` guard. They
  agreed in behaviour only because `Renumberer.rewrite` re-checks `isOurs` itself, so the outer guard was
  redundant. Two further things the summary did not carry, both from audit report 20 §4:
  - a **third** gate copy in `client.ts`'s `rewriteOutboundObject`, with the same redundant guard; and
  - the raw-socket path called the rewriter **unguarded** while the room path wrapped its interceptor for
    this reason ("a rewrite failure must never drop the game's frame"). A throw therefore escaped into
    the game's own `send` and the frame was never sent. Invariant I7 was broken, and the outcome is
    worse than the duplicate sequence that renumbering exists to prevent. Fixed in with a fail-first test
    that measures whether
    the host's frame actually went out.
- There are **two renumbering mechanisms**, not one: the client renumbers through
  `attachment.setOutboundRewriter` (`client.ts:457-470`), and `installRenumberHook` wraps a `send` slot
  for third-party mods. `installRenumberHook` has **no production caller**: only tests and the package
  export. Whichever of the two is meant to be *the* single rewriter, DESIGN §6 I1 should say so, because
  a mod that installs on the same slot the attachment already rewrites has both of them on the wire. This
  belongs with Phase 3's dedupe, not with the identity fix.

- [x] **Step 1: Failing test** (landed)

```ts
it('returns the live renumberer when the slot is already installed, never a detached one', () => {
  const first = installRenumberHook({ page, onForeignHook: () => {} });
  const second = installRenumberHook({ page, onForeignHook: () => {} });
  assert.equal(second.renumberer, first.renumberer, 'the same live machine');
  assert.equal(second.active, true);
  assert.equal(page[HOOK_KEY], /* exactly one wrapper */);
});
```

Expected: FAIL: `second.renumberer` is a fresh, unwired machine.

- [x] **Step 2: Implement** (landed)

On `'reused'`, return the *existing* machine from the brand registry (or return
`{ active: true, renumberer: null, reason: 'already-installed' }` if the existing one is not
addressable). Never build before deciding. Add a test that exactly one rewriter consumes exactly one
sequence number for one command, and that `release()` leaves the slot empty.

- [x] **Step 3: Also close the raw-socket gap the audit found** (landed)

Both gate copies and both `asEnvelope` copies now reach `coexistence/envelope.ts`, and
`applyRenumberingToString` is a re-export of `applyRenumbering` rather than a second implementation.
The raw-socket call is guarded so a rewriter fault cannot drop the host's frame.

**Ruling: where the single home went.** This step text said `common/protocol/codec.ts`; audit report 20's
own fix paragraph (§4) says a new `bootstrapped/src/coexistence/envelope.ts`. I followed the report, for
three reasons: both consumers are in `bootstrapped`; `headless` never renumbers, so a `common` home would
widen the shared package's API for a userscript-only concern and invite a copy there; and report 20's table
row that cites `codec.ts` is inconsistent with its own fix paragraph: `codec.ts` holds no envelope
predicate, only the inbound `parseFrame` with `'QuinoaCommandResult'` in its known-types set. Cost if wrong:
one small module moves later, and Phase 3.3 is where that call belongs. The audit's suggested name
`parseQuinoaEnvelope` was not taken, because `parseEnvelope` is already the published name and renaming it
would churn the exports surface for no gain.

- [x] **Step 4: Verify + commit** (landed)

`git commit -m "fix(bootstrapped): one live renumberer, and the handle always points at it"`

### Task 1.4: No credential leaves the transport

**Files:** `packages/headless/src/client.ts`, `transport/runtime.ts`, `auth/session.ts`,
`common/src/log.ts`, a new `common/src/redact.ts`, tests.

**Status: landed, and the provider gap it left is closed.** The delivered fix
covered the probe path; `CookieAuthProvider.prepare()` still interpolated an unvalidated token, so the same
token was refused by `probeSession` and accepted by a connect. The rule now lives in `auth/cookie.ts`, beside
the header it protects, and both entry points call it, as the audit prescribed
(`docs/audit/00-index.md:155`: "add `assertCookieHeaderSafe` in `auth/cookie.ts`"). It is one function rather
than two so the two paths cannot drift, and `MgConfigError` moved to a new `errors.ts` because the provider
may not import `session.ts`, which imports it.

**Interfaces:** `redactCredential<T>(value: T): T` deep-copies the value, replacing the value of any key
matching `/^(cookie|authorization|set-cookie|mc_jwt)$/i` and any string matching the JWT shape with
`'[redacted]'`. `resolveCookie(cookie)` centralises Cookie construction.

- [ ] **Step 1: Failing tests**

```ts
it('never emits the session cookie in an event payload', () => {
  const seen: unknown[] = [];
  client.on('headers-dropped', (e) => seen.push(e));
  client.connect();                    // with a Cookie header in the factory
  assert.ok(!JSON.stringify(seen).includes('mc_jwt'));
});

it('refuses a token that would inject a header, and does not echo it in an error', async () => {
  await assert.rejects(() => probeSession({ token: 'x\r\nCookie: mc_jwt=evil' }), (e: Error) => {
    assert.ok(!e.message.includes('evil'));
    return true;
  });
});
```

Expected: FAIL on both (`client.ts:158, 692-694` re-emits the header bag; `session.ts:173-175` builds a
header from an unvalidated token and `:224` copies `error.message` into a field documented "safe to
log").

- [ ] **Step 2: Implement**

Redact at the boundary: every event payload and log record passes through `redactCredential`; validate
the token shape before it reaches a header (reject CR/LF and anything not matching the expected cookie
value charset) and throw an `MgConfigError` whose message names the field, never the value; change
`probeSession`'s `reason` to a classified enum. **Note the breaking change** (event payload key renamed
`headersUnsupported` → `headers-dropped`, `reason` becomes an enum) and record it in the commit body.

- [ ] **Step 3: Fail closed when headers cannot be sent**

`runtime.ts:172`: an injected `webSocketFactory` is assumed header-capable, so the cookie is silently
dropped and the client still reports `isReady: true`. Detect capability and either use
`requireHeadersForAuth` (already an option) or refuse to report ready. Test: a factory with no header
support plus a cookie plus `requireHeadersForAuth: true` must not reach `ready`.

- [ ] **Step 4: Verify + commit**

Run: `npm test -w @mg.js/headless` and `npm test -w @mg.js/common`.
`git commit -m "fix(headless): keep the session cookie out of events, logs and errors"`

### Task 1.5: Teardown is total

**Files:** `bootstrapped/src/attach/raw-socket.ts`, `jotai/bridge.ts`, `client.ts`,
`render/world.ts`, `headless/src/transport/client.ts`, tests.

**Landed (all five rows):**
- `raw-socket.release` listener leak: done in (3 tests, `raw-socket.test.ts`).
- `StandaloneTransport.dispose` orphaned socket: done in (7 tests,
  `transport-dispose.test.ts`). Reading it for the fix turned up two more halves of the same defect, both
  fixed there: `dispose()` also stranded an in-flight `connect()` (that promise settles from inside the
  socket's own listeners, which dispose was detaching first, so the caller waited on a socket that no
  longer existed, so a test that awaited it would have hung rather than failed), and it left the socket
  generation valid, which `detachSocket`'s own comment says must not happen on a path that cannot remove
  every listener.

**Still owed:** nothing in this task. All five rows are closed; the two left at the last update landed in
. The `WorldScene` row belongs to task 1.2, which owns that file, and the `raw-socket` row's
`transport/client.ts` sibling is in the headless package.

The `jotai` row was a real defect, settled by reading the shipped game bundle rather than guessing: it
contains `globalThis.jotaiAtomCache = globalThis.jotaiAtomCache || {cache:new Map,get(...)}` followed by
`.get(key, atom)` once per atom module, so the game *keeps* our synthetic holder and registers into it. The
comment's "still empty of the game's atoms" condition was the one that mattered and the code never tested
it. An adopted holder now stays and only our `get` comes out of it.

Two follow-ups from this task, both deferred to Phase 4's lifecycle contract rather than
fixed piecemeal: `uninstall()` never clears `attachment`/`attachmentPromise`, so a reinstalled client is
clean but never re-attaches (so the plan's "no wrapper" assertion is a guard, not fail-first
evidence); and `bootstrapped` has no `stop()`: the shipped name is `uninstall()`, so the table below says
`stop()` where it means `uninstall()`.

- [x] **Step 1: Write one failing test per leak** (each asserts the observable post-`stop()` state):

| Leak | Test |
|---|---|
| `raw-socket.release()` never removes the listeners it added (`:235,269` vs `:443-464`) | after `stop()`, dispatch a `message`/`close` event on the fake socket and assert no handler ran |
| `jotai.release()` deletes the game's live `jotaiAtomCache` (`bridge.ts:500-502`) | with a fake game cache, after `stop()` the cache object is still the page's, and the synthetic `get` is gone |
| `install()` after `uninstall()` leaks a permanent page hook (`client.ts:362, 636-638`) | `uninstall(); install()` → `stop()` → assert the page has no `__mgjs` key and no wrapper |
| `WorldScene` suppression restores someone else's value (`:840-853, 289-300`) | two scenes: exit the first, assert the second's value is intact |
| `StandaloneTransport.dispose()` orphans a live socket (`transport/client.ts:387-394`) | after `dispose()` with an open socket, the fake socket's `close` was called |

- [x] **Step 2: Implement each fix** so the test passes, preferring "record and restore" over "guess".
- [x] **Step 3:** Run `npm test -w @mg.js/bootstrapped` and `-w @mg.js/headless`; then
  `git commit -m "fix: uninstall restores every listener, cache, hook and socket it took"`

### Task 1.6: Latch the stand-in Welcome

**Files:** `packages/bootstrapped/src/attach/room-connection.ts`, tests.

**Why:** the stand-in `Welcome` is emitted on **every** patch frame (`room-connection.ts:502`), and each
one re-seeds the sequencer (`common/src/client.ts:535` → `common/src/protocol/sequencer.ts:302-304`) and
clears the outstanding command ledger, so a real command can be renumbered or dropped mid-flight. (The
stale citations this task shipped with, `:479`, `client.ts:547` and `actions/sequencer.ts`, are corrected
here; the module is `protocol/sequencer.ts`.)

**Status: landed.** Both steps done, plus a third defect found while fixing it: a subscriber
served by both `subscribeToWelcome`'s replay *and* the frame path saw one session start twice, so the frame
path now skips handlers already replayed while still announcing to every other subscriber (that negative
has its own test, because a skip that quietly stopped reaching new subscribers would be worse than the
duplicate).

Two residuals, both left unfixed:

- **The latch depends on attach being synchronous.** Every welcome subscriber is registered before the
  latch can fire because binding and handing the sink to the transport happen in one step
  (`attach/detect.ts` tick → `upgradeAttachment`), while patch frames arrive from the socket's events. That
  is documented at the latch and not enforced; an attach path that awaited in between would need
  replay-on-subscribe, or the session would sit un-ready, the bug the stand-in exists to fix.
- **`CommandSequencer.seed` clears the ledger on *every* seed** (`protocol/sequencer.ts:302-304`), so a
  build that re-fires a **real** `Welcome` mid-session still rewinds the counter and drops
  in-flight commands. Latching the stand-in cannot help there; the real Welcome is treated as
  authoritative. Whether `seed` should be idempotent within a session is a Phase 2 question (I5-adjacent),
  not a Phase 1 one.

- [x] **Step 1: Failing test:** two patch frames after a missed Welcome produce **one** welcome event,
  and the sequencer's `next` is unchanged by the second frame.
- [x] **Step 2: Latch it** (emit once per session; keep updating `lastFullState` internally), and keep
  the existing re-ask of the identity resolver at read time.
- [x] **Step 3:** `git commit -m "fix(bootstrapped): the stand-in Welcome fires once per session"`,
 landed, whose subject is longer than the drafted one.

**Phase 1 exit criteria:** the four critical findings are closed with tests that fail first; the
credential paths are covered by a token-absence test; `npm run verify` green.

---

## Phases 2 through 8: scoped work packages

Each phase is one PR-sized unit that leaves `verify` green. Write a detailed step-by-step plan in this
directory before starting a phase. Task sizes are the audit's, not guesses; the evidence is in the
linked report.

### Status, and where each phase's evidence lives

Added after the fact, because this document never carried a completion record and a reader had to infer one
from the per-phase plans. Each line names the phase's own plan and where its boundary evidence is, so the claim
can be checked rather than trusted. Four of the seven phase plans have a *closure* section (Phases 5 through 8); the
rest record their evidence per task or in the coordinator's ledger, and saying so is more useful than a bare
"done".

| Phase | Status | Plan | Boundary evidence |
|---|---|---|---|
| 0: make the gates real | complete | §Phase 0 below | each task's deliverable verified present in the tree and exercised by the gate; see the note below on why its step boxes are unticked |
| 1: critical defects and credentials | complete | §Phase 1 below | 1.3/1.5/1.6 carry landed SHAs inline; 1.1/1.2/1.4 verified in the tree; see the note below |
| 2: wire hardening | complete | `2026-09-13-phase-2-wire-hardening.md` | per-task SHAs; last task `2.9` at the boundary, review closures after it. All 48 of its checkboxes are ticked and its baseline carries a "Correction, Phase 2 close" block (which also retired the earlier "unticked and owed a booking commit" note here). |
| 3: one home per helper | complete | `2026-09-13-phase-3-one-home-per-helper.md` |: verify exit 0, `verify:catalog` 11/11 PASS (version 1169), `verify:socket` exit 0 |
| 4: one client contract | complete | `2026-09-13-phase-4-one-client-contract.md` |: verify exit 0, 807 tests / 0 fail / 0 skipped, `verify:socket` exit 0 |
| 5: structure (the folder rule) | complete | `2026-09-13-phase-5-structure.md` | closure section: at the boundary, 876 tests, both live checks pass, bundle 322,654 B. **Two acceptance lines recorded not met** (file sizes; stale figures) |
| 6: inert surface, implement or delete | complete | `2026-09-13-phase-6-inert-surface.md` | closure section: at the boundary, 888 tests, both live checks pass, bundle 321,783 B |
| 7: missing capabilities | complete | `2026-09-13-phase-7-missing-capabilities.md` | closure section:, verify exit 0, 904 tests / 0 fail / 0 skipped, both live checks pass, bundle 325,179 B |
| 8: docs, CI, release identity | complete | `2026-09-13-phase-8-docs-ci-identity.md` | closure section:, verify exit 0, **905 tests / 0 fail / 0 skipped**, `verify:catalog` 11/11 PASS (version 1169), `verify:socket` exit 0, bundle 323,039 B. **Two acceptance lines recorded as not met**: "first CI run green" is owed to the first push (this repository has no remote), and no install/auto-update path exists until a public release |

**Phases 0 through 8 are all closed**, which is the whole programme: §6's invariants, §3's contract, §4's structure,
§5's conventions, §7's gates and §8's docs each map to a task, and each task to a commit.

**On the unticked `[ ]` boxes in the Phase 0 and Phase 1 sections.** Those two sections predate the per-task
records, and their step checkboxes were never ticked; Phase 1.3, 1.5 and 1.6 are the only steps carrying a
landed SHA. They are left unticked on purpose, because several steps are diagnostics (*"prove the
assertions skip today"*, *"`assert(x > 0 || true)`"*, *"reproduce the failure"*) whose evidence is gone by
design once the fix lands: ticking them would assert something the tree cannot confirm. What *was* verified for
those phases is that each task's deliverable exists and the gate exercises it:
`.npmrc` with a committed lockfile that `npm ci` resolves; `tsconfig.tests.json`; the reordered `verify`;
`bundle-budget.test.ts`; `biome.json`; an MIT `LICENSE`; `*.tgz` ignored;
`scripts/verify-{catalog,socket}.ts` renamed and mode 644; `state/patch.ts`'s `MAX_ARRAY_PADDING` and
prototype-pollution guards with `tests/patch.test.ts`; `setLayerVisible` with `tests/world.test.ts`; and
`probeSession` (`session.ts:208`), which does not log the rejected value.

**Do not read the per-phase plans' status text as current.** Phase 2's and Phase 3's carry stale baselines (500
and 566 tests against 905 today) and Phase 5's closure section records two acceptance figures that were already
wrong when they were written. The counts to trust are the ones a run prints; every phase plan's acceptance
figures should be re-measured rather than compared against.

### Phase 2: Wire hardening (invariants I4, I5)

| Task | Files | Change | Acceptance |
|---|---|---|---|
| 2.1 Frame ceiling | `common/src/protocol/codec.ts` | Reject inbound frames over a named `MAX_FRAME_BYTES` with a recorded outcome instead of parsing them | Hostile-input test at the boundary ±1 |
| 2.2 Real byte cap in HTTP | `common/src/catalog/http.ts` | Count **bytes** while streaming, abort at `maxBytes`; `:80-82` currently compares a string length after buffering everything | Test with a >cap body asserts abort, not truncation |
| 2.3 Redirect and URL policy | `common/src/catalog/http.ts`, `protocol/connect-url.ts` | `redirect: 'error'` (or an allow-list), `encodeURIComponent` for `version`/`room` in the connect URL (`connect-url.ts:57`) | Test with a `//evil` room name and a 302 response |
| 2.4 Bounded caches | `bootstrapped/src/render/sprite.ts` (`:75-97,170`) and every other cache | Each cache declares `maxEntries`, destroys on eviction, and releases the value it replaces | Test: insert past the bound → the evicted texture was destroyed |
| 2.5 Cancellable waits | `headless/src/client.ts:562`, `reconnect.ts:344` | `disconnect()` must not block for a whole backoff; the sleep takes an abort signal | Test: `disconnect()` during backoff resolves in <50 ms |
| 2.6 Honest reconnect accounting | `headless/src/client.ts:915, 805` | A failed pre-open attempt must either continue the chain or report `stopped` with a reason, never `willReconnect: true` then silence | Test reproduces the audit's destroyed-connection scenario |
| 2.7 Reconnect + version | `headless/src/room-socket.ts`, `version.ts` | `RoomSocket` gains reconnect; version resolution sets a non-zero exit / typed error instead of silently returning `null` | Tests for both, incl. a malformed version payload |

> **Phase 2 anchor drift (verified after Phase 3).** Some rows above no longer resolve as written.
> Task 2.5's `reconnect.ts:344` was the non-abortable `setTimeout(resolve, delayMs)` at the boundary; the file
> has since grown to 378 lines and that (now signal-aware) sleep sits elsewhere. Task 2.5's
> `headless/src/client.ts:562` and Task 2.6's `client.ts:915, 805` were invalidated by Phase 3's 3.2
>, which deleted the hand-written emitter from `client.ts`; at the boundary, `:562` was an `on`
> return of `Unsubscribe`, not a cancellable wait. The symbol names are authoritative; these line numbers
> are not, and `docs/plans/2026-09-13-phase-2-wire-hardening.md` (outside this pass's write scope; its own
> close-out pass is in flight) carries the same drift.

### Phase 3: One home per helper (invariant: duplication)

**Status: COMPLETE.** Detailed plan: `docs/plans/2026-09-13-phase-3-one-home-per-helper.md`. Landed as
 (3.1 `Unsubscribe`) · (3.2 one `Emitter`) · (3.3 envelope
predicates, landed early) · (3.4 `pollUntil`/`watchUntil`) · (3.4b `unrefTimer`)
 (3.5 one sequence validator) · (3.6 reconnect-policy identity) · (3.7a
`detach`) · (3.7b `getGraphicsCtor`) · (3.7c `isRiveLike`) · (3.7d
`asGraphics`) · (3.7e warn-once) · (3.8 `PreviousFn`); supporting commits
(Task 1.3 Step 3 close-out), (DESIGN §4.2 `poll.ts` row), (DESIGN I3/I4/I5). The
Phase 3 plan's exit criteria guessed "nine commits"; the actual set is the fourteen above. Phase 2 review
closures carried into this record: (a non-canonical frontier cannot fail a live command) and
 (stable close/open/ready, and a superseded refresh cannot stop a session).

Measured after Phase 3: `npm test` **736 tests / 0 fail / 0 skipped** (bootstrapped 181, common 386,
headless 169); `npm run size` 291.2 KiB (298,233 B), within budget. Every baseline figure this document
states as "490"/"500" is the *reported* count, not the true one; see the baseline correction at the top.

The audit found **seven** reimplementations. Each task: pick the surviving copy, move it to its owner,
delete the others, and add a test at the new home so a fourth copy cannot appear.

| Task | Duplication (report 20) | Target owner |
|---|---|---|
| 3.1 `Unsubscribe` | declared 3× (`state/store.ts:24`, `transport/types.ts:15`, `headless/room-socket.ts:54`); `state/index.ts:19-20` documents a workaround for it | `common/src/unsubscribe.ts`: landed; the three anchors in this row are deleted (the one declaration is `unsubscribe.ts:12`) |
| 3.2 Emitter | 3 implementations (`common/emitter.ts`, `headless/client.ts:982-995`, `bootstrapped` event maps) | `common/src/emitter.ts`, with `on/once/off/clear`: landed; `headless/client.ts:982-995` is deleted |
| 3.3 Envelope predicates: **landed early** (closing Task 1.3 Step 3) | the 3 gate copies and 2 `asEnvelope` copies are one module now, and `applyRenumberingToString` is a re-export of `applyRenumbering` | settled at `bootstrapped/src/coexistence/envelope.ts`: the row's `common/protocol/codec.ts` contradicts report 20 §4's own fix paragraph, and `codec.ts` holds no envelope predicate. Reasoning under Task 1.3 Step 3. The fourth-copy guard is `tests/envelope-owner.test.ts` (function identity). Still open from 1.3: **which of the two renumbering mechanisms is canonical** |
| 3.4 Deadline polling | 5 loops (`attach/detect.ts` ×2, `render/ctors.ts`, `jotai/bridge.ts`, `attach/transport.ts`) plus test helpers, but the `verify-live*` anchor was false: those scripts contain no poll loop (`git grep -n "const tick = " -- scripts` → 0) | `common/src/poll.ts` (`pollUntil`/`watchUntil`/`unrefTimer`): landed, |
| 3.5 Sequence validation | **10** copies with **divergent rules** (integer vs finite); report 20 said 5; the verified inventory is at `2026-09-13-phase-3-one-home-per-helper.md:2570` | `common/src/protocol/codec.ts` (`asSequence`, integer ≥ 0): landed |
| 3.6 Retry tickers | **1**, not 2: `attach/detect.ts` has no delay calculation (`git grep -n "computeBackoff\|BackoffPlan\|ReconnectConfig" -- packages/bootstrapped` → 0), so no shared helper exists; the landed change is reconnect-policy identity | `headless/reconnect.ts` re-exports `common/src/protocol/types.ts`'s `DEFAULT_RECONNECT`: landed; `attach` keeps only its watch (delivered by 3.4) |
| 3.7 `asEnvelope` / `getGraphicsCtor` / `asGraphics` / `isRiveHostLike` / `detachNode` / warn-once | 2× each; warn-once 3× with 3 resets | `render/text.ts`, `render/ctors.ts`, new `render/warn-once.ts`. `coexistence/outbound.ts` is never created; the envelope predicate's home is `coexistence/envelope.ts` (3.3). Landed, |
| 3.8 The `previous` hook signature | `InstallHookOptions.wrap` types `previous` as `(...args: never[]) => unknown` (`coexistence/brand.ts:207`), which makes it uncallable in a type-checked way, so every chaining site escapes the type: hand-written casts at `catalog/bundle.ts:328` and `coexistence/renumber.ts:519`, plus `Reflect.apply` in `coexistence.test.ts:141`. Found while fixing the Phase 0 test type errors. | one `type PreviousFn = (this: unknown...args: unknown[]) => unknown` in `coexistence/brand.ts`: landed (`brand.ts:198`); the row's cast anchors (`bundle.ts:328`, `renumber.ts:519`, `coexistence.test.ts:141`) were already corrected in the Phase 3 plan's own table and are now deleted |

Bound each task to one helper so a reviewer can reject one without the others.

### Phase 4: One client contract

| Task | Change | Acceptance |
|---|---|---|
| 4.1 Define `MgClient`/`ClientReport` | `common/src/client/contract.ts` per DESIGN §3.2 | Compiles; no behaviour change yet |
| 4.2 Adopt it in `ClientCore` | Rename verbs to `start`/`stop`, move the event map to the shared emitter, expose `report` | Suite green; public renames listed in the commit body |
| 4.3 Adopt it in `HeadlessClient` | Same verbs/events/report; `connect/disconnect` become deprecated-free aliases removed in the same commit | Suite green |
| 4.4 Adopt it in `BootstrappedClient` | `install/uninstall/ready` → `start/stop` + `isReady`; `attachmentReport`/`stats` roll into `report` | Suite green; userscript still builds |
| 4.5 Options convergence | one `features: {}` object, one polarity, delete the duplicate `autoReconnect`/`reconnect.enabled` pair and the five `disableX` flags | A test asserts every documented option changes observable behaviour |
| 4.6 Error hierarchy | `MgError` + `MgProtocolError`/`MgConfigError`/`MgTransportError`; wire outcomes return Results; catalog `load()` stops swallowing into an unpassed callback | Suite green; `report.errors` populated in a forced-failure test |

### Phase 5: Structure (the folder rule)

Follow `docs/audit/40-structure-packages.md` §4 and `41-structure-repo.md` §5 for the exact order.

**Scope decision. CHOSEN: A, the full target.** All three layers above land in this phase, in the order
the tasks list them. The `exports`-map half (`5.3`) is pulled forward to run *before* Phase 0, because
`@mg.js/headless/auth` resolving to a module with no auth providers is a bug rather than a style choice,
and because its acceptance check is the thing that proves the workspace install (Task 0.1) works.

| Scope | Files | What it includes | What it leaves alone | Buys |
|---|---|---|---|---|
| **A: full target** | 66 → ~105 | Everything below, plus: `protocol/` hands the command story to `actions/` (`forms→registry.ts`, `sequencer.ts`, `result-codes.ts`); the five misleading `types.ts` renames; `catalog/` → `live-catalog/`; `userscript.ts` → `entry/{userscript,badge}.ts`; `attach/transport.ts` → `attached-transport.ts`; `transport/client.ts` → `standalone.ts`; `session.ts` → `auth/session.ts`; 7 new `exports` subpaths | none | The folder names finally describe what the modules do; "adding an action" means touching one folder |
| **B: middle (recommended)** | 66 → ~88 | All 11 barrels and the `exports` map fix; the four big-file splits (`headless/client.ts`→8, `bootstrapped/client.ts`→5, `room-connection.ts`→6, `world.ts`→5); `realm.ts`→`page/`; `storage.ts`→`storage/`; `jotai/bridge.ts`→4 | The pure renames and the `catalog/`/`entry/` moves; keeps six `exports` subpaths as they are | Fixes the broken `@mg.js/headless/auth` subpath and the 920-to-1025-line files, with roughly half the review surface of A |
| **C: minimal** | 66 → ~72 | Barrels in `headless`/`bootstrapped` + the corrected `exports` map only | Every split and rename | Two commits; fixes "where do I add an export" and the subpath bug; the four giant files stay giant |

**A split that is worth doing regardless of scope:** task 5.3. `@mg.js/headless/auth` currently resolves
to `dist/auth/types.js`, which contains `StaticAuthProvider` and **neither** real provider, so the
documented import path yields `undefined`. It is a five-line fix (a barrel plus one `exports` entry) and
it can be pulled forward out of Phase 5 whenever convenient.

| Task | Change | Acceptance |
|---|---|---|
| 5.1 Dedupe first, no moves | Phase 3 proves this is safe | none |
| 5.2 `common` layout, alone | Per scope: `forms→actions/registry`, `sequencer`/`result-codes→actions`, `types→params`/`wire`/`defs`/`seam` | `exports` keys unchanged; suite green |
| 5.3 `headless` barrels + `exports` **in one commit** | add `auth/index.ts`, `transport/index.ts`; `session.ts→auth/`; point `./auth` and `./transport` at barrels | **Both** `tsc -b` and a runtime `import('@mg.js/headless/auth')` listing the providers |
| 5.4 `bootstrapped` barrels + `page/`+`storage/` splits in one commit | 11 importers of `realm.ts` move together | Suite green |
| 5.5 Big-file splits, one per commit | Per scope: `live-catalog/`, `entry/`, `render/world-scene.ts`, `attach/room-connection.ts`, `bootstrapped/client.ts`, `headless/client.ts`; each keeps a re-export facade so it is revertable | Suite green after each |
| 5.6 Tests mirror source | `tests/<mirrored-path>.test.ts` + `tests/integration/` + `tests/fixtures/` | The 27 invisible gaps become empty slots; `npm test` finds every file |

### Phase 6: Inert surface, implement or delete

Every item is either wired to observable behaviour with a test, or removed (breaking changes allowed).
`FormFallback`/`setFormFallback`/`isFallbackEnabled`, `RemoteJsonSource.setETag`, `GetCtorsOptions.page`,
`hasCapturedGet`, `emptyCatalogSource`, `EMPTY_STARTUP_SINK` (→ `createEmptySink()`),
`EMPTY_STARTUP_SINK`'s duplicate teardown registration, `KEEPALIVE_*` if unused, plus the audit's
remaining unverified `unused-code` findings in `docs/audit/21-xcut-unused-api.md`.

**Acceptance:** a test asserts each surviving option/endpoint changes behaviour; the deleted names are
listed per commit.

### Phase 7: Missing capabilities

| Task | Source | Deliverable |
|---|---|---|
| 7.1 Userscript lifecycle handle | audit `missing-capability` | `startUserscript()` returns a handle with `stop()` that removes the badge host, listeners and intervals; tested with a DOM stub |
| 7.2 Never clobber `window.__mgjs` | `userscript.ts:205-210` vs `realm.ts:239` | Reuse the namespace instead of overwriting it; test that a second load still works |
| 7.3 Raw-socket welcome replay | `raw-socket.ts` | Late subscribers get the existing welcome; test with a subscriber added after the frame |
| 7.4 Renderer-recreation recovery | `render/world.ts` | Detect a replaced renderer and rebuild; test with a swapped fake renderer |
| 7.5 Pointer/input + tile-object + outgoing-command observer + DOM panel | README "missing features" | Each as its own task with its own test; scope them before starting |

### Phase 8: Docs, CI, release identity

| Task | Change | Acceptance |
|---|---|---|
| 8.1 Docs split | README ≈150 lines; `docs/{protocol,attachment,sessions,close-codes,announcements,verification,provenance}.md`; vendor the two protocol HTML sources with SHA-256 | Every README link resolves; the two known-broken references (`README.md:144`, `:292`) are fixed |
| 8.2 CI | `.github/workflows/ci.yml` = `npm ci && npm run verify` on Node 22 + userscript artifact; `live.yml` = manual/weekly only | First run green; `npm ci` succeeding proves Task 0.1 |
| 8.3 Make the metadata honest: **no release yet** | Point `build.ts`'s `DOWNLOAD_URL` and the userscript `@namespace` at `QenuDev/MG.js` (today's value names a different owner and 404s); add `repository`, `license`, `engines`, `sideEffects`, and `files: ["dist","src","!dist/.tsbuildinfo"]`; keep `private: true` and leave `publishConfig` out until publication is real | `npm pack --dry-run` ships no `.tsbuildinfo` and does not contain the userscript; every URL in the banner resolves to the real repo. **Distribution stays deferred**: the repo is private and has no releases, and Tampermonkey cannot read a release asset through its unauthenticated update check, so auto-update cannot work until the repo is public; the README should say that plainly rather than imply an install path that does not exist |
| 8.4 Naming | root `name: mg.js`, `engines: >=22`, `ws` declared once at one version; align the four `0.1.0`s | `npm ls` clean |

---

## Self-review

**Spec coverage.** Every §6 invariant maps to tasks: I1→1.3, I2→1.2/1.5, I3→1.4, I4→1.1/2.1 to 2.3,
I5→2.4 to 2.7, I6→1.6, I7→7.1/7.2, I8→0.3/0.4, I9→§7 config rules (Phase 8.4 plus the per-package `types`
edit). §3's contract→Phase 4; §4's structure→Phase 5; §5's conventions→Phases 0.5, 3, 4.5, 4.6, 5.6;
§7's gates→Phase 0; §8's docs→Phase 8.1; `missing-capability` findings→Phase 7. No spec section is
unmapped.

**Placeholder scan.** Phase 0 and Phase 1 tasks carry the exact config, tests, commands and expected
outputs. Phases 2 through 8 are scoped rather than step-specified, and the plan says so up front
and requires a detailed plan per phase before execution; the alternative is 400 pages of speculative
steps that would go stale as soon as Phase 1 changes a signature.

**Type consistency.** `MgClient.start/stop`, `ClientReport`, `MgError`, `redactCredential`,
`isForbiddenToken`, `isCanonicalIndex`, `pollUntil`, `createWarnOnce`, `setLayerVisible`,
`installRenumberHook`'s handle shape, and `verify`'s script names are each named once and reused. Task
4.1 defines the contract that 4.2 to 4.4 consume; Task 0.1 defines `.npmrc` that 8.2 depends on.

**Open questions that blocked two tasks** (0.6 needed the license holder; 8.3 needed the release repo) **were
both answered before those tasks ran**, and DESIGN §11 records the answers: a pseudonymous holder is enough for
MIT, and the release repo is `QenuDev/MG.js`, which is private with no releases, so 8.3 shipped honest metadata
rather than an auto-update path that cannot work.

## Execution handoff

Phase 0 is a prerequisite for everything else and is the recommended first PR. Two ways to run it:

1. **Subagent-driven (recommended)**: one fresh subagent per task, review between tasks, fast
   iteration. Best fit here because Phase 0's tasks touch config, tests and the whole repo's
   formatting, and each is independently reviewable.
2. **Inline execution**: execute tasks in this session in batches with checkpoints after each task.

Phase 1 can start in parallel with none of Phase 0 except Task 0.2 (its new tests must typecheck) and
Task 0.3 (its artifact assertions must run).

**Which phase do you want first?**
