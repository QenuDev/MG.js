# Phase 5 execution plan: Structure (the folder rule)

> Written against the phase close (Phase 4's last commit). Every `file:line` below was taken with
> `grep -n` / `sed -n` / `wc -l` / `find` against the working tree, **never** with the `read` tool,
> which has served stale indexed content in this repo. If a citation looks one revision short,
> `wc -l` the file before believing it.
>
> **No concurrent writer was observed** while this plan was written (`git status --porcelain` was
> clean). The master plan's `### Phase 5: Structure (the folder rule)` heading was at `:763` when this
> plan was scoped and has drifted from `:755` at earlier readings. **Locate every plan-document
> citation by heading or quoted text, not by line number.**

**Goal.** Make the three source trees obey `docs/DESIGN.md` §4.1 (*a concept gets a folder when it
has ≥2 modules or is a published subpath, otherwise a bare file named after the concept; every folder
has an `index.ts` barrel; no module imports a barrel*) by moving and splitting modules along seams
that already exist, updating every import site, barrel, `exports` entry and config path the moves
touch, and mirroring test paths to source paths so a missing test is an empty slot rather than an
invisible one. **No behaviour changes.** Phase 5 is a pure structural phase; every task is a move plus
the imports and config that point at it.

**Invariants served.**

- **I1: one renumbering rewriter is live, ever.** Phase 1 gave `coexistence/renumber.ts` its
  one slot; Phase 5 relocates `coexistence/envelope.ts` and splits `attach/room-connection.ts` without
  changing either mechanism. The split's acceptance is that I1's test still passes unchanged.
- **I2: take nothing without restoring it.** The `page/` split separates `installRealmOverride` from
  `claimInstall`/`releaseInstall`/`onTeardown`/`deleteNamespace`; the refcount semantics must survive
  the move byte-for-byte. `client-lifecycle.test.ts:34` imports `BUNDLE_VERSION` and
  `installRealmOverride` from `realm.ts` and is the guard.
- **I9: `common` is platform-free, and the compiler says so.** Every `common` task is a same-package
  move, so the package's compile surface (`lib`, `types`, dependencies) cannot widen. Any task that
  accidentally adds a cross-package import to `common` is caught by the existing project reference
  graph: `common/tsconfig.json` has no `references`, so it cannot resolve `@mg.js/headless`.

**Also served, indirectly:** §4.3 (tests mirror source), and §7's rule that a gate must be *able* to
fail (Task 5.7 exists partly because `render-owner.test.ts`'s structural walk would silently pass on an
empty directory; see **F7**).

## Decision check: scope A, confirmed with two corrections

The master plan's Phase 5 table records **"Scope decision"**, then *"CHOSEN: A, the full target ... 66 → ~105"*.
That decision is **correct and this plan follows it**. Scope A's content list maps cleanly onto
DESIGN §4.2's target trees: the `protocol/` → `actions/` handoff, the five `types.ts` renames, the
`catalog/` → `live-catalog/` move, `userscript.ts` → `entry/`, `attach/transport.ts` →
`attached-transport.ts`, `transport/client.ts` → `standalone.ts`, `session.ts` → `auth/session.ts`, the
new `exports` subpaths, and the big-file splits all appear verbatim in §4.2.

Two corrections are required, both **documentation defects, not scope disagreements**:

1. **"66 → ~105" is stale on both ends, and neither end is currently true.** The audit that produced 66
   (`docs/audit/40-structure-packages.md:3`: *"66 source files, 21,291 lines, 22 test files"*) is two
   phases behind. At HEAD: **76 source files, 24,534 lines, 63 `*.test.ts` + 2 non-test helpers**. The
   measured target of scope A is **76 → 86 source files** (§2's per-package table). "~105" was never a
   computed target. It does not follow from 66 by any of scope A's moves (which are net *-2* in
   `common`), so it is best read as an estimate made before the tree was counted. **DESIGN §4.2 wins
   for *shape*, and the counted tree wins for *numbers*.** The numbers change no task.
2. **Phase 5's one marked "worth doing regardless of scope" task is already done.** The Phase 5 prose
   says that `@mg.js/headless/auth` *"currently resolves to `dist/auth/types.js`"*, that it *"is a five-line
   fix"*, and that it *"can be pulled forward out of Phase 5 whenever convenient."* It was pulled
   forward and landed in Phase 0: `packages/headless/package.json`'s `"./auth"` now targets `./dist/auth/index.js`, and
   `packages/headless/tests/exports-map.test.ts:116-122` asserts every subpath targets an
   `index.js`. Similarly the task table records 5.1 as **"Dedupe first, no moves"** with the note
   *"Phase 3 proves this is safe"*, so it is Phase 3's deliverable and is complete. **Task 5.1 therefore
   has no work left; this plan records it as done and starts at 5.2.**

**Not in scope, named so it is not silently assumed:** the *contents* of the big files do not get
rewritten (only relocated); `common/src/index.ts` keeps its five `export *` lines even though DESIGN
§4.2's comment says *"explicit re-exports only"*. That is a surface change with a real break risk and
is **F1**, deferred to Phase 6; and `headless/tsconfig.test.json` stays (dead but not in the way, so
**F4**, Phase 8.4).

---

## Global constraints

These apply to every task and are not repeated per task.

- **NodeNext ESM: relative imports end in `.js`.** 446 of 504 relative specifiers do. **58 do not**.
  They end in `.ts` and exist only because `tsconfig.tests.json:13` sets `allowImportingTsExtensions`.
  A move must rewrite the specifier *and* keep its existing suffix: `bootstrapped/tests/*` keeps `.ts`,
  `headless/tests/*` and `common/tests/*` keep `.js` except for the six `.ts` files listed in
  Task 5.8. Do **not** normalise suffixes in this phase. That is a separate breaking change.
- **Tests import `../src/foo.ts`.** A test at `tests/<mirror>.test.ts` uses `../src/...`; a test one
  directory deeper uses `../../src/...`.
- **`strict` + `noUncheckedIndexedAccess` + `noUnusedLocals` + `noUnusedParameters` stay on** for
  source *and* tests. `tsc -b --force` and `tsc -p tsconfig.tests.json` must both exit 0.
- **Banned everywhere including tests:** `any`, `as any`, `@ts-ignore`, `@ts-expect-error`, and
  non-null `!`. A move must not introduce one; a move that *reveals* one is a bug in the move.
- **Biome `lineWidth: 110`**, `indentWidth: 2`, single quotes, semicolons, trailing commas, LF;
  `files.includes: ["**", "!docs"]` so `docs/` is excluded from lint *and format*. `biome check .`
  must exit 0. Biome 2.x key is `includes`, not `include`/`ignore`.
- **`common` is platform-free.** Same-package moves only; no new dependency, no `node:*`, no DOM.
- **`headless` and `bootstrapped` never import each other**, directly or by `packages/*/src` path.
  `packages/headless/tests/layering.test.ts:54-68` asserts this over every `.ts` under
  `packages/<pkg>/src`, and `:70-77` asserts `bootstrapped` computes no backoff.
- **Tests mirror source paths (§4.3).** `tests/<mirrored/source/path>.test.ts`, plus
  `tests/integration/` and `tests/fixtures/` for the files that belong to neither.
- **Test first, and the failure must be observed.** For a pure move there is no failing-first
  *behavioural* test. Inventing one would produce a test that cannot fail. The honest pair is: (a) the
  existing suite still passes, and (b) a **structural guard that can fail at the new home** (a
  symbol-parity assertion, a path scan that would go empty, or an `exports`-target assertion). Every
  task below names which guard it adds or re-points. **A "test" that would pass on an empty file, a
  wrong path or a moved-away module is rejected.**
- **One commit per task.** Commit bodies follow the repo's `type(scope): lowercase sentence` style and
  name any breaking change explicitly (pre-1.0 breaking changes are allowed but every one is listed).
- **Never `git add -A`; never stage `docs/`.** Stage the exact paths each task names.
- **Every commit leaves `npm run verify` green:** `lint → typecheck(src+tests) → build → test → size`.
- **No behaviour change.** If a task's diff changes more than paths, specifiers and barrel contents,
  stop: the move is wrong, not the task.

## Ordering rationale and file ownership

Order is forced by three facts: `common` is the bottom layer both other packages consume; an `exports`
map edit and the file move it points at **must never be split across commits**, because `tsc -b` does
not read `exports`, and the `./auth` bug stayed green that way; and a facade must exist before its
callers are re-pointed.

| # | Task | Owns these paths (exclusive write) |
|---|---|---|
| 5.1 | *(already done: Phase 3)* | none |
| 5.2 | `common/protocol` renames + `actions/` handoff | `common/src/protocol/*`, `common/src/actions/*`, `common/src/state/{store,patch}.ts`, `common/src/client.ts`, `common/src/index.ts` |
| 5.3 | `common` `transport/seam.ts` + `catalog/defs.ts` (no `exports` change) | `common/src/transport/*`, `common/src/catalog/*`, `common/tests/{catalog,client,client-contract,unsubscribe}*`, `scripts/verify-catalog.ts` |
| 5.4 | `common` built-surface net (test-only) | `common/tests/exports-map.test.ts`, `common/tests/symbol-parity.test.ts` |
| 5.5 | `headless` client split + `transport/standalone.ts` (+ `auth/types.ts`→`providers.ts`) | `headless/src/*` (all), `headless/tests/*` import lines |
| 5.6 | `bootstrapped` barrels + `page/` + `storage/` (+ `attach/transport.ts`→`attached-transport.ts`) | `bootstrapped/src/index.ts`, `bootstrapped/src/page/*`, `bootstrapped/src/storage/*`, the six new barrels, `bootstrapped/src/attach/transport.ts`, **the 11 `realm` importers + 2 `storage` importers + 5 `attach/transport` importers in one commit** |
| 5.7 | `bootstrapped` big-file splits, one commit each | `bootstrapped/src/{live-catalog,entry,render,attach}/*`, `bootstrapped/src/client.ts`, `bootstrapped/scripts/build.ts` |
| 5.8 | tests mirror source | `packages/*/tests/*` (all), the structural-test literals |

**Sequential dependencies (must not be reordered).** 5.2 → 5.3 (both edit `common/src/protocol/index.ts`
and `common/src/client.ts`); 5.3 → 5.4 (5.4 asserts the built tree 5.3 produced); 5.2-5.3 → 5.5 and
5.6 (both packages import `@mg.js/common`, and 5.5's `headless/src/client.ts` split consumes the
`common` barrels as re-pointed); 5.6 → 5.7 (`client.ts` imports `realm`, `storage`, `catalog/bundle`
and `render/world` (each split moves a file `client.ts` imports); 5.5+5.7 → 5.8 (never move a test
twice); 5.1-5.7 → the phase verification.

**Independent of each other, given the above:** nothing. Phase 5 is a rename cascade; every task
changes paths another task's acceptance greps. **Do not parallelise two tasks from this plan in one
working tree.**

**Within 5.7, ascending risk** (each keeps a facade so it is independently revertable): `catalog/bundle.ts`
→ `live-catalog/`, then `userscript.ts` → `entry/`, then `render/world.ts`, then
`attach/room-connection.ts`, then `bootstrapped/client.ts`. That is the audit's own §5 order minus
`headless/client.ts`, which this plan runs **earlier, as Task 5.5**, because it is the lower-risk
package and establishes the facade convention 5.7 copies: the audit's ordering is about review
comfort, not correctness.

**The six config/hardcoded-path files a move can silently break** (every task must check the ones it
touches): `common/package.json` + `headless/package.json` (`exports` targets), `biome.json:38` (the
`close-codes.ts` override), `packages/bootstrapped/scripts/build.ts:46,47,95`, `scripts/assert-bundle-size.ts:113`,
`packages/headless/tsconfig.test.json` (dead), and the tsconfigs' `include: ["src/**/*.ts"]`, which
needs **no edit** for a folder move, only for a *rename of the `src` root itself* (which Phase 5 does
not do).

---

## Task 5.1: Dedupe first, no moves *(already done: Phase 3)*

**Problem.** The master plan's table records 5.1 as *"Dedupe first, no moves"* with the note *"Phase 3
proves this is safe"*. It is a placeholder carried forward from the audit's ordering advice
(`docs/audit/40-structure-packages.md` §4's order list), not a deliverable.

**Change.** None. Phase 3 (`docs/plans/2026-09-13-phase-3-one-home-per-helper.md`) landed the dedupe:
`applyRenumberingToString` is a re-export of `applyRenumbering`
(`bootstrapped/src/coexistence/renumber.ts`), and `redactCredential`, `pollUntil`, `createWarnOnce`,
`setLayerVisible` and friends each have one home. Verified present at HEAD.

**Test first / Acceptance.** No test; this task has no code change.

**Risk / revert.** None.

---

## Task 5.2: `common`: the `protocol` renames, and `protocol/` hands the command story to `actions/`

### Problem

`docs/audit/40-structure-packages.md` §4:

> `actions/` owns *"the commands we send"*: the whole 72-action surface*. `registry.ts # move <-
> protocol/forms.ts (ACTION_SPECS: wire/form/category/params)`; `params.ts # rename <- actions/types.ts
> (52 param interfaces)`; `game-actions.ts # rename <- actions/actions.ts (72 methods +
> GAME_ACTION_METHOD_COUNT)`; `sequencer.ts # move <- protocol/sequencer.ts`; `result-codes.ts # move
> <- protocol/result-codes.ts`

and DESIGN §4.1's supporting rule:

> **`types.ts` only if it holds only types.** Five of five current `types.ts` files hold runtime values
> or classes (`protocol/types.ts` exports `isKeepalivePing` and similar). Rename to the concept:
> `protocol/wire.ts`, `catalog/defs.ts`, `transport/seam.ts`, `actions/params.ts`, `auth/providers.ts`.

At HEAD this is unaddressed: `common/src/protocol/` holds `types.ts` (352 lines **with** the runtime
`isKeepalivePing` and the `SCOPE_QUINOA`/`SCOPE_ROOM` constants) plus the three modules that are really
about *commands we send* (`forms.ts` (538), `sequencer.ts` (546), `result-codes.ts` (124)) while
`actions/` holds the equally misleadingly-named `actions.ts` and `types.ts`. The layer split
`protocol` = *bytes ↔ messages* vs `actions` = *the 72 commands* is invisible in the tree, and every
`protocol/` module that reads a command story has to know about `actions` concepts anyway:
`protocol/envelope.ts:11` imports `getActionSpec` from `protocol/forms.ts`, which is an `actions`
concern.

### Change

Pure `git mv` + specifier rewrite. **No symbol is renamed, added or removed**; the `common` root barrel
keeps exporting every name it exports today.

| before | after | notes |
|---|---|---|
| `common/src/protocol/types.ts` | `common/src/protocol/wire.ts` | holds `isKeepalivePing` + `SCOPE_*` + `KEEPALIVE_*` (runtime) |
| `common/src/protocol/forms.ts` | `common/src/actions/registry.ts` | `ACTION_SPECS`, `FormRegistry`, `getActionSpec`, `scopeForForm`, `ACTION_NAMES`, `FLAT_ALLOWLIST` |
| `common/src/protocol/sequencer.ts` | `common/src/actions/sequencer.ts` | `CommandSequencer`, `MonotonicStrategy`, `FrontierAnchoredStrategy`, `MAX_REPORTED_STALE`, `isCanonicalSequence` |
| `common/src/protocol/result-codes.ts` | `common/src/actions/result-codes.ts` | `ResultCode`, `interpretRejection`, `parseResultCode` |
| `common/src/actions/types.ts` | `common/src/actions/params.ts` | 52 param interfaces + `CrystalIntent`, `ShopKey` |
| `common/src/actions/actions.ts` | `common/src/actions/game-actions.ts` | `GameActions`, `GAME_ACTION_METHOD_COUNT` |

**Every import site that must change** (verified with `grep -rn --include='*.ts'`):

`protocol/types.ts` → `wire.js` (11 sites):
- `common/src/protocol/codec.ts:11,12`
- `common/src/protocol/connect-url.ts:15`
- `common/src/protocol/envelope.ts:21,22`
- `common/src/protocol/forms.ts:17,18` (becomes `actions/registry.ts` → `../protocol/wire.js`)
- `common/src/protocol/index.ts:70,78`
- `common/src/state/patch.ts`, `common/src/state/store.ts` (both import `protocol/types.js`)
- `common/src/client.ts:53`
- `common/tests/patch.test.ts`, `common/tests/envelope.test.ts`

`protocol/forms.ts` → `actions/registry.js` (4 sites):
- `common/src/protocol/envelope.ts:10,11` → `../actions/registry.js`
- `common/src/protocol/index.ts:29,38` → **delete these two blocks** (the specifier moves to
  `actions/index.ts`)
- `common/src/client.ts:40,41` → `./actions/registry.js`
- `common/tests/forms.test.ts`, `common/tests/errors.test.ts`, `common/tests/envelope.test.ts`

`protocol/sequencer.ts` → `actions/sequencer.js` (3 sites):
- `common/src/client.ts:44`
- `common/src/protocol/index.ts:42,48` → **delete**, re-export from `actions/index.ts`
- `common/tests/sequencer.test.ts`

`protocol/result-codes.ts` → `actions/result-codes.js` (6 sites):
- `common/src/protocol/sequencer.ts:24` (becomes `actions/sequencer.ts` → `./result-codes.js`)
- `common/src/protocol/index.ts:40,41` → **delete**
- `common/src/errors.ts`, `common/src/client.ts:43`, `common/src/actions/handle.ts:20`
- `common/tests/errors.test.ts`, `common/tests/connect-url.test.ts`

`actions/types.ts` → `actions/params.js` (4 sites):
- `common/src/actions/index.ts:6,7`
- `common/src/actions/actions.ts:71` (becomes `game-actions.ts` → `./params.js`)
- `common/src/client.ts` (none, because it imports `GameActions` from `./actions/actions.js:22`)

`actions/actions.ts` → `actions/game-actions.js` (2 sites):
- `common/src/actions/index.ts:3`
- `common/src/client.ts:22`

**Barrels.** `common/src/actions/index.ts` (7 lines) must lose its *"redundant export-then-star at
:6-7"*, the audit's words, because `export type { CrystalIntent, ShopKey } from './types.js'` at `:6`
is a strict subset of the `export *` at `:7`. Replace the whole file with:

```ts
/** The typed action surface, the registry that describes it, and the handles it returns. */

export type { CrystalIntent, ShopKey } from './params.js';
export * from './params.js';
export { GAME_ACTION_METHOD_COUNT, GameActions } from './game-actions.js';
export type { AckMatchMethod, CommandFailureReason, CommandResult, CommandSender } from './handle.js';
export { CommandHandle, failureResult } from './handle.js';
export { CommandSequencer, FrontierAnchoredStrategy, MAX_REPORTED_STALE, MonotonicStrategy } from './sequencer.js';
export type { CommandSequencerOptions, OutstandingCommand, SequenceStrategy } from './sequencer.js';
export { interpretRejection, parseResultCode, ResultCode } from './result-codes.js';
export type { CommandRejection } from './result-codes.js';
export type { ActionCategory, ActionSpec, FormFallback, FormRegistryOptions } from './registry.js';
export {
  ACTION_NAMES,
  ACTION_SPECS,
  defaultFormRegistry,
  FLAT_ALLOWLIST,
  FormRegistry,
  getActionSpec,
  scopeForForm,
} from './registry.js';
```

`common/src/protocol/index.ts` loses the six lines that moved (`:29,38` from `forms.js`;
`:40,41` from `result-codes.js`; `:42,48` from `sequencer.js`) and gains nothing. `protocol/index.ts`'s
remaining re-exports are `close-codes.js`, `codec.js`, `connect-url.js`, `envelope.js`, `id.js`,
`wire.js`. **This is the one edit in Phase 5 that can silently drop a public name.** The six lines (verified at
`protocol/index.ts:29,36-48`) carry **13 runtime-visible exports**: `ACTION_SPECS`, `FormRegistry`,
`getActionSpec`, `scopeForForm`, `ACTION_NAMES`, `FLAT_ALLOWLIST`, `CommandSequencer`,
`FrontierAnchoredStrategy`, `MonotonicStrategy`, `MAX_REPORTED_STALE`, `interpretRejection`,
`parseResultCode`, `ResultCode`), plus nine type-only members (`ActionCategory`, `ActionSpec`,
`FormFallback`, `FormRegistryOptions`, `CommandRejection`, `CommandSequencerOptions`,
`OutstandingCommand`, `SequenceStrategy`, `SequenceStrategy`'s siblings). Task 5.4's symbol-parity
test is what proves none was lost.

`common/src/index.ts` needs **no edit**: it does `export * from './protocol/index.js'` (`:50`) and
`export * from './actions/index.js'` (`:15`), so the names move between barrels transparently.

**One invisible specifier to fix:** `common/tests/sequencer.test.ts:16` imports `MAX_REPORTED_STALE as
MAX_REPORTED_STALE_PUBLIC` from `../src/index.js`, the only test that imports a package barrel. It
must keep working (it must: `MAX_REPORTED_STALE` is still exported by `actions/index.js` → `index.ts`).

### Test first

**No new behavioural test.** A rename that keeps every export cannot change behaviour, and a test
written to fail before the move would have to assert on a *path*, which is the structural guard below,
not a behavioural test. The evidence is:

1. **The existing suite stays green.** `npm run test:common` → **423 tests, 0 fail, 0 skipped**, with
   `sequencer.test.ts`, `forms.test.ts`, `errors.test.ts`, `envelope.test.ts`, `patch.test.ts`,
   `connect-url.test.ts` and `catalog.test.ts` all still discovered.
2. **The structural guard at the new home (added in Task 5.4, but the intent is fixed here).**
   `common/tests/symbol-parity.test.ts` asserts the *set* of names exported by `common/src/index.ts`
   equals a snapshot taken **before** this task, in commit 5.2's parent. The snapshot is captured by
   `node --import tsx -e "import('./packages/common/src/index.ts').then(m=>console.log(Object.keys(m).sort().join('\n')))"`
   and stored as a sorted array literal. This test **can** fail: deleting one of `protocol/index.ts`'s
   six moved lines drops 15 names and fails 15 assertions.

### Acceptance

- `grep -rn "protocol/forms\|protocol/sequencer\|protocol/result-codes\|protocol/types\|actions/types\|actions/actions" packages/common/src packages/common/tests` returns **no import line** (prose in comments is allowed; the audit's own §2 quotes are not in `src`).
- `grep -rn "export \* from './types.js'" packages/common/src/actions/index.ts` returns nothing.
- `npm run typecheck` exits 0: `tsc -b --force` **and** `tsc -p tsconfig.tests.json`.
- `npm run verify` exits 0, `[size] bundle ... within budget`, `# fail 0`, `# skipped 0`.
- **Bundle check (this task changes what the bundler can pull in only if a barrel stops re-exporting):**
  `ls -l packages/bootstrapped/dist/magicgarden.user.js` → **must be 319887 bytes**. Any other
  number means the move changed the module graph; investigate before committing. Headroom is 7,793 B
  against `FAIL_BYTES = 320 * 1024` (`scripts/assert-bundle-size.ts:40`).

### Risk / revert

| silent break | why | detection |
|---|---|---|
| a stale `.js` suffix that now names nothing | `tsc -b` fails, but only if the emitting project is rebuilt, since `tsc -b` is incremental | `npm run typecheck` runs `tsc -b --force` |
| a barrel that stops re-exporting | `protocol/index.ts`'s six deleted lines are re-added under `actions/index.ts`; miss one and a public name vanishes while `tsc -b` stays green (nothing imports it internally) | Task 5.4's symbol-parity test |
| `isCanonicalSequence` becomes unreachable | it is re-exported from `sequencer.ts:32` and consumed only by `common/tests/sequencer.test.ts` and `state/` consumers | `test:common` |
| Biome override mis-points | `biome.json:38`'s `noDuplicateEnumValues` override names `close-codes.ts`, which this task does **not** move | `npm run lint` |

**Revert:** one commit. No facade is needed, because every consumer is inside `common` and is in the same
commit.

---

## Task 5.3: `common`: `transport/seam.ts`, `catalog/defs.ts`, and the `exports` map stays put

### Problem

Two DESIGN §4.1 violations remain in `common` after 5.2. First, the `types.ts` rule:
`common/src/transport/types.ts` (103 lines) exports `DEFAULT_LIFECYCLE_TIMEOUTS`, a runtime value, so
the file is misnamed; the audit says rename it to `transport/seam.ts`. Second,
`common/src/catalog/types.ts` (253 lines) exports `CATALOG_KINDS`, `emptyCatalog()`, `GAME_GRID_MS` and
`restockCountdown()`, four runtime values, so it is `catalog/defs.ts`, not `types.ts`.

The third finding is the one that matters most and the audit states it precisely:

> **The one thing that must never be split across commits: an `exports` map edit and the file move it
> points at.** `tsc -b` does not read `exports`, which is precisely how `@mg.js/headless/auth` came to
> resolve to a file with no auth providers while the build stayed green.

`common`'s six `exports` keys (`.`, `./protocol`, `./actions`, `./state`, `./catalog`, `./transport`)
all point at `index.js` barrels today, so **no subpath target changes in this task**. The point is to
keep it that way while two member files move *underneath* those barrels, and to add the test that would
have caught the `headless/auth` class of bug in `common`, which has none today.

### Change

| before | after |
|---|---|
| `common/src/transport/types.ts` | `common/src/transport/seam.ts` |
| `common/src/catalog/types.ts` | `common/src/catalog/defs.ts` |

**Import sites for `transport/types.js` → `transport/seam.js`** (5):
- `common/src/transport/index.ts:11,12`
- `common/src/client.ts:56,57`
- `common/src/client-contract.ts`
- `common/tests/client.test.ts`, `common/tests/client-contract.test.ts`
- `common/tests/unsubscribe.test.ts:46` reads `packages/common/src/transport/types.ts` **as a literal
  path**. Both are listed below.

**Import sites for `catalog/types.js` → `catalog/defs.js`** (8):
- `common/src/catalog/index.ts:29,30`
- `common/src/catalog/platform-source.ts:22`
- `common/src/catalog/remote-json-source.ts:19`
- `common/src/catalog/source.ts:17,18`
- `common/src/catalog/static-source.ts:10`
- `common/tests/catalog.test.ts` (2 sites)
- `scripts/verify-catalog.ts:15`: a **root** script reaching into `packages/common/src` by relative
  path

**`common/package.json` `exports`:** no target changes; keys stay
`.`, `./protocol`, `./actions`, `./state`, `./catalog`, `./transport`. Adding the seven scope-A subpaths
(`./poll`, `./redact`, `./emitter`, `./log`, `./errors`, `./live-catalog`, `./client-contract`) is
**not** in this task. Both **F1** and **F2** are deferred.

**`biome.json`:** needs no edit for these two moves (the only override names `close-codes.ts`), but the
task must confirm `npm run lint` still formats both files, since Biome's `files.includes: ["**", "!docs"]`
has no per-path allowlist, so a rename is invisible to it.

**Hardcoded paths a move breaks (non-import):** four `common` tests read source files by literal string.
Two break here:

- `packages/common/tests/unsubscribe.test.ts:46` reads `readFileSync(join(repoRoot,
  'packages/common/src/transport/types.ts'), 'utf8')` → `transport/seam.ts`.
- `packages/common/tests/unsubscribe.test.ts:47`: `packages/headless/src/room-socket.ts` (unchanged
  here).
- `packages/common/tests/poll.test.ts:305-311` walks `packages/<pkg>/src` and asserts the only
  declarer of the poll helpers is `['packages/common/src/poll.ts']` (unaffected), and `:352` names
  `packages/headless/tests/*.test.ts` (5.8's concern).

### Test first

1. **A structural guard that can fail: `common/tests/exports-map.test.ts` (new, mirrors
   `headless/tests/exports-map.test.ts`).** `common` has **no** exports test today; only `headless`
   does. This test reads `packages/common/package.json`'s `exports`, resolves every `default` target the
   way Node would, asserts the built file exists, `await import()`s it, and asserts the subpath reaches
   the names a caller is told to use. It also asserts every target ends in `index.js` (the barrel rule,
   `headless/tests/exports-map.test.ts:116-122`'s twin). **It can fail two ways:** a target that does not
   exist after the rename (build not run, or a barrel dropped), and a target that is not a barrel.
   It **skips** rather than fails when `dist/` is absent, printing the loud `run npm run build` warning,
   exactly as the headless twin does (`exports-map.test.ts:20-26`). Phase 0 Task 3 established that
   pattern, and failing on a fresh checkout would make the suite order-dependent.
2. **A second assertion that the rename actually landed** (a test that would pass on the *old* tree is
   worthless): the same file asserts `existsSync('packages/common/src/transport/seam.ts')` **and**
   `!existsSync('packages/common/src/transport/types.ts')`. This is the part that fails before the move.
3. The existing suite stays green: `npm run test:common` → **423 tests, 0 fail, 0 skipped**.

### Acceptance

- `node -e "import('@mg.js/common').then(m=>console.log(Object.keys(m).length))"` after `npm run build`
  prints the same count as before the task (capture it first; the parity test in 5.4 pins the exact set).
- `node -e "const p=require('./packages/common/package.json');console.log(Object.keys(p.exports).join(' '))"`
  → `. ./protocol ./actions ./state ./catalog ./transport`, and every `default`/`types` target
  ends in `/index.js` / `/index.d.ts`.
- `npm run verify` exits 0; `# skipped 0`; bundle **319887 B**.

### Risk / revert

An `exports` subpath that points at a moved member file is the documented failure mode. Here it cannot
happen because no target changes, but the new `common/tests/exports-map.test.ts` is what makes that
statement checkable rather than assumed. `scripts/verify-catalog.ts:15` is the one *root* file that
breaks and would break the `verify:catalog` **live** check (not part of `npm run verify`, so the gate
would stay green while the script rots), so it must be fixed in this commit. Revert: one commit.

---

## Task 5.4: `common`: the symbol-parity net (test-only, no source change)

### Problem

Tasks 5.2 and 5.3 move 15 exported symbols between barrels and rename six modules. Nothing in the repo
asserts that a *rename* preserved the public surface: the existing `exports-map.test.ts` lives in
`headless` only, and its `REQUIRED_RUNTIME_EXPORTS` list is *"small and behavioural on purpose"* by
its own comment (`:44`); it names perhaps a dozen symbols. The audit's own framing is the risk:

> **The one thing that must never be split across commits: an `exports` map edit and the file move it
> points at.** `tsc -b` does not read `exports`.

The same is true of barrel membership: `tsc -b` reads it, but **nothing consumes `protocol/index.ts`'s
`getActionSpec` internally**, so deleting that re-export compiles green and breaks every external
caller.

### Change

One new test file, `packages/common/tests/symbol-parity.test.ts`, and nothing else. Its mechanism:

```ts
// The set is frozen at the value measured before Task 5.2, by:
//   node --import tsx -e "import('./packages/common/src/index.ts').then(m=>console.log(Object.keys(m).sort().join('\n')))"
// Measured: 133 names. (headless: 40, bootstrapped: 146, captured after 5.7, per its own task.)
const EXPECTED_EXPORTS: readonly string[] = [ /* 133 sorted names, verbatim */ ];

void test('common/src/index.ts exports the names it exported before the structure phase', async () => {
  const mod = (await import('../src/index.js')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(mod).sort(), [...EXPECTED_EXPORTS].sort());
});
```

The `133` is not decoration: if the six moved re-export blocks are dropped from `protocol/index.ts`
without landing in `actions/index.ts`, **13 value exports vanish** (`ACTION_SPECS`, `FormRegistry`,
`getActionSpec`, `scopeForForm`, `ACTION_NAMES`, `FLAT_ALLOWLIST`, `CommandSequencer`,
`FrontierAnchoredStrategy`, `MonotonicStrategy`, `MAX_REPORTED_STALE`, `interpretRejection`,
`parseResultCode`, `ResultCode`), and `deepEqual` on sorted arrays names which are missing.

`assert.deepEqual` on sorted key arrays reports *both* directions: a dropped name and an accidentally
added one. **This test can fail**. It fails the moment one of
`protocol/index.ts`'s six moved re-export blocks is not re-added to `actions/index.ts`.

An optional second case asserts the *layering* half of the same idea cheaply: every symbol exported by
`common/src/protocol/index.ts` must also be exported by `common/src/index.ts`, i.e. no barrel is a dead
end. This is what makes a future `protocol/` reorganisation unable to silently orphan a name.

**Do not** add the same test for `headless` and `bootstrapped` in this task. `headless` already has
`exports-map.test.ts`; `bootstrapped`'s surface changes in 5.6 and 5.7, and a parity snapshot captured
now would have to be re-captured three times. Capture `bootstrapped`'s after 5.7, as a follow-up inside
5.6's commit. See 5.6's "Test first".

### Test first

This task *is* the test; it is written before 5.2 and 5.3 would otherwise have nothing to catch them.
Because the snapshot must be taken from the pre-move tree, **execute this task's snapshot capture
before Task 5.2**, then land the file in 5.4 (or, equivalently, capture it in 5.2's parent commit and
add the file in 5.2. The plan's task numbering follows the master plan's, and the ordering table above
lists 5.2 → 5.3 → 5.4 as write order). Concretely: run the capture command **first**, save its output to
`/tmp/common-exports-before.txt`, and paste it into the test.

**Failure observed before the fix:** the test as written against the *pre-5.2* tree passes (that is
expected: the snapshot is the pre-5.2 tree). To observe a real red, temporarily delete one block from
`common/src/actions/index.ts` after the move and watch the assertion name the missing symbols.

### Acceptance

- The test is discovered and passes: `npm run test:common 2>&1 | grep -c "exports the names"`
  → `1`, and the count is **424** (423 + 1).
- `# skipped 0`.

### Risk / revert

The only risk is a **stale snapshot**: if a later phase legitimately adds or removes a `common` export,
this test fails and must be updated *in that commit*, and that failure is the review signal a parity
test is for. Name that in the test's header comment. Revert: one commit, deletes one file.

---

## Task 5.5: `headless`: the 1404-line `client.ts` splits, and `transport/client.ts` → `standalone.ts`

### Problem

`packages/headless/src/client.ts` is **1404 lines**, the largest file in the repo after
`bootstrapped/client.ts`, and its own section banners show the seams the audit verified:

```
437:  // ----  (accessors)
655:  // ----  (connect)
805:  // ----  (stop / teardown)
```

The audit's proposed split (`docs/audit/40-structure-packages.md` §4) is `client.ts` → `ctor`,
`accessors`, `connect`, `disconnect` plus a facade of ~450 lines, with `client-options.ts`,
`client-events.ts`, `client-session.ts`, `connect-attempt.ts`, `connect-url.ts`, `handshake.ts`,
`reconnect-scheduler.ts` and `supersession.ts` extracted. DESIGN §4.2 says the same: *"the 1025-line
client splits along the seams the audit verified"*, and the line count has since grown to 1404, which
makes the case stronger, not weaker.

Second, the misnamed member file: `headless/src/transport/client.ts` (579 lines) holds the class
`StandaloneTransport` in a file called `client.ts`, and `headless/src/transport/index.ts:9` documents
why that is wrong: the `"./transport"` subpath *"used to point at `client.js`, one member file"*. The
barrel fixed the *subpath*; the *filename* still says `client`. DESIGN §4.2: `standalone.ts (was
client.ts)`.

### Change

**5.5a: `transport/client.ts` → `transport/standalone.ts`.** Import sites:
- `headless/src/transport/index.ts:9` (the `export type { StandaloneTransportOptions }` block)
- `headless/src/client.ts` (the `StandaloneTransport` import)
- `headless/tests/transport-keepalive.test.ts`, `transport-frame-cap.test.ts`,
  `transport-dispose.test.ts`, `helpers/fake-socket.ts`

No `exports` change: `"./transport"` already targets `./dist/transport/index.js`.

**5.5b: split `headless/src/client.ts` into nine files + a facade.** Each new file gets its content
`git mv`-style (cut, not rewritten); `client.ts` keeps every existing `export` as a re-export so that
`index.ts:45` (`export { appendAuthQuery, HANDSHAKE_ACTIONS, HANDSHAKE_GAME_NAME, HeadlessClient } from
'./client.js'`), `transport/index.ts` and `room-socket.ts` keep compiling unchanged.

| new file | content moved out of `client.ts` |
|---|---|
| `client-options.ts` | the `HeadlessClientOptions` interface and its defaults |
| `client-events.ts` | `HeadlessClientEvents`, `HeadlessCloseEvent`, `HeadlessReport` |
| `client-session.ts` | the internal session/attempt state record |
| `connect-attempt.ts` | the socket-open attempt body and its timeout/port plumbing |
| `connect-url.ts` | `joinHost` (`:1378`) made module-local, plus the URL assembly it serves |
| `handshake.ts` | the `HANDSHAKE_ACTIONS` / `HANDSHAKE_GAME_NAME` constants and the handshake sequence |
| `reconnect-scheduler.ts` | the reconnect scheduling + backoff wiring that calls `reconnect.ts` |
| `supersession.ts` | the superseded-attempt bookkeeping |
| `client.ts` (facade, ~400) | `HeadlessClient` plus re-exports of the eight above |

`headless/src/index.ts` gains **no** new names; `appendAuthQuery` and the two `HANDSHAKE_*` constants
stay exported from `client.ts` by re-export.

**`headless/tsconfig.json` needs no edit:** `include: ["src/**/*.ts"]` picks up new files
automatically, and `rootDir: "./src"` with `outDir: "./dist"` keeps `dist/` mirroring `src/`. There are
**no project references to update** inside a package, and `tsconfig.json`'s three references are
package-level only.

### Test first

A 1404-line file split into nine is the highest-risk move in the phase, because the *only* thing that
proves it worked is that `HeadlessClient` still behaves. The honest evidence, in order of strength:

1. **The existing behavioural suite, unchanged.** `npm run test:headless` → **184 tests, 0 fail, 0
   skipped**. Nine headless test files import `../src/client.js` directly
   (`client-contract.test.ts`, `integration.test.ts`, `disconnect-race.test.ts`, `credential-leak.test.ts`,
   `connect-supersedes-backoff.test.ts`, `emitter.test.ts`, `transport-*.test.ts`,
   `superseded-attempt.test.ts`, `reconnect-*.test.ts`, `version-loop.test.ts`). Because the facade keeps
   `client.js` as a file exporting the same names, **not one of those imports changes**, which is the
   facade's purpose and its acceptance.
2. **A path-stability guard that can fail: extend `headless/tests/exports-map.test.ts`.** After the
   split, add a case asserting `Object.keys(await import('../src/client.js'))` is a superset of the
   names `headless/src/index.ts` imports from `./client.js`, i.e. the facade still exports everything
   the barrel asks of it. A split that forgets to re-export `HeadlessReport` fails.
3. **`npm run size`.** `headless` cannot be reachable from the userscript. I-layering forbids
   `bootstrapped` importing `headless`, and `headless/tests/layering.test.ts:54-68` asserts it, so a
   `headless`-only split *should* leave the artifact byte-identical. **Verify rather than assume:**
   `grep -c "headless" packages/bootstrapped/dist/magicgarden.user.js` → `0`, and the artifact stays
   **319887 B**.

### Acceptance

- `wc -l packages/headless/src/client.ts` is between 350 and 500; no new file exceeds 500 lines.
- `git grep -n "from './transport/client.js'" packages/headless` → no matches (including tests).
- `grep -rn "StandaloneTransport" packages/headless/src/transport/index.ts` still re-exports it.
- `npm run verify` exits 0; **184 headless tests**, 0 fail, 0 skipped; bundle 319887 B.

### Risk / revert

The silent failures here are a stale `.js` suffix inside the *new* files (caught by `tsc -b --force`) and
a facade that stops re-exporting (caught by (2)). The risk is **module-level state**: if two of
the nine new files each hold a copy of something that was a single `const` (a `WeakSet` of seen
sockets, a counter), behaviour changes without any type error. Mitigation: **nothing moves that is
mutable module state**, and the extraction is grep-verified: every `let`/`const` at module scope in
`client.ts` must appear in exactly one of the nine new files. `git grep -c "^let \|^const "` before and
after the split must agree. Revert: one commit; the facade means nothing outside `headless/src` can
tell.

---

## Task 5.6: `bootstrapped`: five barrels, `realm.ts` → `page/`, `storage.ts` → `storage/`: one commit

### Problem

`bootstrapped` has **no folder barrel at all** except the root `index.ts`: `attach/`, `render/`,
`coexistence/`, `jotai/` and `catalog/` have no `index.ts`, so `src/index.ts` (368 lines) imports 18
member files by full path (`./attach/detect.js`, `./render/world.js`, and others). This is the audit's
sharpest structural contrast:

> **`common/src/` is the only package with a complete, consistent barrel discipline.** Copy this to
> the other two packages; do not invent a fourth convention.

and the master plan's 5.4 says the same: *"`bootstrapped` barrels + `page/`+`storage/` splits in one
commit: 11 importers of `realm.ts` move together"*.

The two bare files are the folder-rule violation §4.1 names explicitly: *"`bootstrapped/realm.ts` (386
lines, 11 importers) and `storage.ts` (454 lines) are bare files. No contributor can infer the rule."*
At HEAD `realm.ts` is **388** lines and has **11 source importers** plus 7 test importers; `storage.ts`
is **454** lines with 2 source importers.

### Change

**5.6a: five barrels, added, and `src/index.ts` re-pointed at them.** New files:

```
bootstrapped/src/attach/index.ts
bootstrapped/src/coexistence/index.ts
bootstrapped/src/jotai/index.ts
bootstrapped/src/render/index.ts
bootstrapped/src/catalog/index.ts
```

Each re-exports what `src/index.ts` already pulled from that folder's members, no more, no
less. Re-pointing `src/index.ts`'s 18 specifiers is the mechanical half; **the acceptance is that its
exported name set is unchanged** (see Test first). `bootstrapped/package.json` has a **single**
`exports` key (`"."`), so no `exports` edit is required and none may be added in this task.

**5.6b: `realm.ts` → `page/` with a facade.** §4.2's target:

```
bootstrapped/src/page/  index.ts  realm.ts  namespace.ts  override.ts
```

| new file | contents (current `realm.ts` line ranges) |
|---|---|
| `page/realm.ts` | the `getPage`/`requirePage`/`hasPage`/`installRealmOverride` slot and the module doc block (`:110-196`) |
| `page/namespace.ts` | `RealmNamespace`, `getNamespace`, `peekNamespace`, `defineGlobal`, `readGlobal`, `undefineGlobal`, `onNamespaceEvent`, `emitNamespaceEvent`, `claimInstall`, `releaseInstall`, `onTeardown`, `deleteNamespace`, `NAMESPACE_KEY`, `BUNDLE_VERSION` (`:54-108`, `:222-388`) |
| `page/override.ts` | `RealmOverrideOptions` and the cross-realm registry slot it feeds (`:110-166`) |
| `page/index.ts` | **the facade**: re-exports every name `realm.ts` exports today |

**`src/realm.ts` is kept as a one-line re-export shim in this commit** (`export * from './page/index.js'`)
so the 11 source importers and 7 test importers keep compiling, and the *deletion* of the shim is a
follow-up commit after `src/index.ts` and the in-package importers point at `./page/index.js`. **Why
keep the shim at all:** §4.2's tree does not list it, so it must eventually go; but deleting it in the
same commit means 18 import sites and a four-way file split land together, which is the review surface
the audit warned about. **Import sites that must be re-pointed in this commit** (verified): `catalog/bundle.ts:60,61`,
`storage.ts:51,52`, `render/pixi.ts:45,46`, `render/ctors.ts:49,50`, `client.ts:83,96`,
`userscript.ts:38`, `jotai/bridge.ts:53,54`, `attach/detect.ts:34,35`, `attach/room-connection.ts:46,47`,
`attach/raw-socket.ts:49,50`, `index.ts:69,88`, plus 7 test files.

**5.6c: `storage.ts` → `storage/`.** §4.2: `storage/  index.ts  types.ts  backends.ts  typed.ts`.
`storage/types.ts` is a legitimate `types.ts` (it holds only interfaces); `backends.ts` gets
`resolveGreasemonkeyApi`, `selectBackend`, `probeStorage`, `WebStorageLike`, `GreasemonkeyApi`;
`typed.ts` gets `TypedStorage` and `createStorage`; `index.ts` re-exports. Import sites:
`bootstrapped/src/index.ts` (2), `bootstrapped/src/client.ts` (2).

### Test first

1. **A barrel/name-set guard that can fail: `bootstrapped/tests/barrels.test.ts` (new).** For each of
   the six barrels (`attach`, `coexistence`, `jotai`, `render`, `catalog`, `page`, plus
   `storage` and the root `index.js`), `await import()` it and assert its exported name set equals a
   snapshot taken **before** the move. This is the *only* thing that catches a barrel that re-exports
   one name too few, and that is the failure mode a 368-line root barrel rewrite invites. It
   also asserts the §4.1 leaf rule directly: for every `.ts` under `bootstrapped/src`, the file's
   specifiers must not include `'./index.js'` or `'../index.js'`. The rule *"No module imports a
   barrel"*, which today holds and which six new barrels make worth policing (see **F5**).
2. **The refcount/teardown behaviour must survive the `page/` split byte-for-byte.**
   `client-lifecycle.test.ts:34` imports `BUNDLE_VERSION` and `installRealmOverride` from `../src/realm.ts`
   and exercises `claimInstall`/`releaseInstall`; `raw-socket.test.ts`, `jotai.test.ts`,
   `options.test.ts`, `room-upgrade.test.ts`, `catalog-sources.test.ts`, `attach.test.ts` all import
   `installRealmOverride`. All seven keep passing **without their import lines changing** (they go
   through the shim).
3. Existing suite green: `npm run test:bootstrapped` → **202 tests**, 0 fail, 0 skipped.

**Failure observed before the fix:** the barrel name-set snapshot test is written against the current
tree, where five of the six barrels **do not exist**, so it fails with `Cannot find module
'../src/attach/index.js'`. That is a real, observed red (a missing-module failure, not a tautology),
and it goes green when 5.6a lands. This is the closest thing to a failing-first test a pure move admits;
state it that way in the commit body rather than pretending a behavioural test exists.

### Acceptance

- `find packages/bootstrapped/src -name index.ts` → 8 (`attach`, `catalog`, `coexistence`, `jotai`,
  `page`, `render`, `storage`, root).
- `wc -l packages/bootstrapped/src/index.ts` ≤ 120 (from 368); `realm.ts` and `storage.ts` no longer
  exist as substantive files.
- `grep -rn "from '\./realm\.js'\|from '\.\./realm\.js'" packages/bootstrapped/src` → only the shim's own
  file, if it is kept, or nothing.
- `npm run verify` exits 0; **202 bootstrapped tests**, 0 fail, 0 skipped; bundle **319887 B** (check
  this one carefully: `index.ts` is not reachable from `userscript.ts`, but the five new barrels are
  reachable from the modules the userscript does pull in, and a barrel that widens a `export *` can
  change esbuild's reachability analysis).
- `packages/bootstrapped/tests/build-output.test.ts` still passes. It asserts the artifact has no
  `import`/`export` statement and no `@mg.js/` string (`:246-252`), which a barrel mistake could break.

### Risk / revert

The 11-importer coupling is why this is one commit: a half-moved `realm.ts` breaks most of the package.
The shim makes the commit revertable without touching 18 call sites. The userscript entry
(`src/userscript.ts:37,38` imports `./client.js` and `./realm.js`) must be checked by name. If a
barrel edit changes what `client.js` pulls in, `build-output.test.ts` catches the *shape* but only
`npm run size` catches the *bytes*. Revert: one commit; the shim means `src/` is bit-identical in
behaviour.

---

## Task 5.7: `bootstrapped`: the big-file splits, one commit each

### Problem

Four files are 400-990 lines with verified internal seams, and the audit's order (§5) is explicit:
*"Big-file splits, one file per commit, ascending risk: `catalog/bundle.ts`→`live-catalog/`;
`userscript.ts`→`entry/`; `render/world.ts`→5 modules; `attach/room-connection.ts`→4 modules;
`bootstrapped/client.ts`→4 modules; `headless/client.ts`→8 modules. Each keeps `client.ts` /
`world-scene.ts` / `room-connection.ts` as a re-export facade so `src/index.ts` and every existing test
keeps compiling. That facade is what makes each split independently revertable."*

(`headless/client.ts` is Task 5.5 in this plan; it runs earlier because it is the lower-risk package.)

Current sizes: `render/world.ts` 988, `attach/room-connection.ts` 949, `render/ctors.ts` 897,
`jotai/bridge.ts` 777, `bootstrapped/client.ts` 1290, `catalog/bundle.ts` 428, `userscript.ts` 312.

### Change: six sub-tasks, six commits

**5.7a `catalog/bundle.ts` → `live-catalog/`.** DESIGN §4.2: `live-catalog/ index.ts
object-keys-source.ts scoring.ts (was catalog/)`. Import sites: `bootstrapped/src/index.ts` (2),
`bootstrapped/src/client.ts` (2), `bootstrapped/tests/catalog-sources.test.ts`. Also re-point the *new*
`catalog/index.ts` from 5.6a. If 5.7a happens after 5.6a, that barrel is rewritten here, so the two are
sequential and not independent.

**5.7b `userscript.ts` → `entry/{userscript.ts,badge.ts}`.** The badge markup/interval is `:205-210`'s
neighbourhood plus the status-badge block `build-output.test.ts:225-228` asserts. **`build.ts:46`
hardcodes `resolve(packageRoot, 'src/userscript.ts')`**, so that path must be updated to
`src/entry/userscript.ts` **in the same commit**, and `build-output.test.ts:61`'s skip-warning string
mentions `packages/bootstrapped/scripts/build.ts` (unaffected). This is the one sub-task where the
*bundle entry point* changes path: `esbuild` resolves it fresh, so the artifact must be **byte-identical
apart from the banner**. Verify with `npm run size` (319887 B) and
`grep -c "==UserScript==" packages/bootstrapped/dist/magicgarden.user.js` → `2` (the open and close
markers).

**5.7c `render/world.ts` → 5 modules.** §4.2: `world-scene.ts (was world.ts) world-geometry.ts
tile-view.ts cinematic-claims.ts ... facade.ts`. Exports today split cleanly:
`WorldScene` + `WorldSceneConfig`/`WorldSceneOptions`/`SpriteOptions` → `world-scene.ts`;
`readGeometry`/`asFiniteNumber`/`WorldGeometry` → `world-geometry.ts`;
`collectTileViews`/`findRenderLayerCtor`/`asGraphics` → `tile-view.ts`;
`activeCinematicClaims`/`resetCinematicClaims`/`CinematicClaimHooks` → `cinematic-claims.ts`;
`recordAndWrapNoop`/`recordAndSet`/`resetWorldWarnings` → `warn-once`-adjacent, so `facade.ts` keeps
them. `world.ts` becomes the facade. Import sites: `bootstrapped/src/index.ts` (2),
`bootstrapped/src/client.ts` (2), `bootstrapped/tests/world.test.ts`.
**`render-owner.test.ts:98` hardcodes `['packages/bootstrapped/src/render/ctors.ts',
'packages/bootstrapped/src/render/world.ts']`** as the expected offender list of a source scan. A
rename makes that literal wrong, and the test **fails loudly** (good). Update the literal in this
commit. `render-owner.test.ts:25` also hardcodes `RENDER_ROOT` to `packages/bootstrapped/src/render`,
which still exists.

**5.7d `attach/room-connection.ts` → 4 modules + facade.** Import sites:
`attach/detect.ts`, `attach/raw-socket.ts`, `attach/transport.ts`, `bootstrapped/src/index.ts`,
`bootstrapped/tests/{attach,emitter,room-upgrade,sequence-owner}.test.ts`. **Note the invisible
specifier:** `bootstrapped/src/client.ts:1249` holds `satisfies import('./attach/room-connection.js').AttachedSink`
in **type position**, so a `grep "from '"` census misses it entirely. Search for `import('` as well as
`from '` in every task of this phase.

**5.7e `bootstrapped/client.ts` (1290) → composition root + 4 modules.** §4.2: `client.ts (≈380)
diagnostics.ts build-info.ts`, plus the audit's `:163-173, 794-834` split for `buildBootstrapReport`.
The audit also flags a *reason* to split beyond size: *"`bootstrapped/client.ts` reaches into its own
private state (`client['captureHandle']` at `:852`) to build a facade; that is a missing seam, not a
shortcut"*. The split is where that seam gets a name. Import sites: `bootstrapped/src/index.ts`,
`bootstrapped/src/userscript.ts` (now `entry/userscript.ts`).

**5.7e: the detailed step-by-step plan, written before the first edit.** Measured against the file as
it stands at 1290 lines, not against the audit's 994-line revision, so the audit's line numbers are
re-derived rather than trusted:

| Step | Move | From (current numbering) | To |
|---|---|---|---|
| a | `BUNDLE_VERSION` | `page/namespace.ts:23` (the audit's `realm.ts:55`) | `src/build-info.ts`: build identity is not a realm concern |
| b | `BootstrapReport`, `BootstrappedReport` | `client.ts:196-217` | `src/diagnostics.ts`, re-exported from `client.ts` |
| c | `report` getter body, `errorSummaries`, `buildDetail` | `client.ts:498-566` | `src/diagnostics.ts` as **pure functions of a named input struct** |
| d | `RenderFacade`, `createRenderFacade`, `cinematicHooks` | `client.ts:172-193`, `1171-1222` | `src/render/facade.ts`, re-exported from `client.ts` |
| e | the `client['captureHandle']` reach-in | `client.ts:1177` | a `RenderSeam` parameter: `createRenderFacade({ capture: () => this.captureHandle, jotai: () => this.jotaiValue })` |
| f | the module-state guard the plan asked for | n/a | `tests/module-state.test.ts`, as an allow-list (see step 3 below) |

**Why (c) is pure functions and not a `Diagnostics` class.** `buildDetail` reads eight of the client's
private fields (`:527-564`). A class in another file would need eight accessors, which is more surface than the
method it removes. A struct parameter makes the dependency explicit, countable, and testable without a
page, a storage backend or an attached socket, which is the actual defect: today the only way to exercise
the diagnostic surface is to build a whole client.

**Test first, in this order.**

1. `tests/diagnostics.test.ts`: `buildDetail(input)` returns the documented shape, and the
   `attachment === null` branch (the `kind: 'none'` default at `:531-539`) is reachable by calling the
   function, not by starting a client. This test cannot compile before (c).
2. `tests/build-info.test.ts`: `BUNDLE_VERSION === MG_VERSION` and is a non-empty string; the
   cross-package identity assertion `client-lifecycle.test.ts:203` already makes, restated at the new
   home so the move is not silent.
3. `tests/module-state.test.ts`: **the plan's mitigation 3 rewritten**, because as written it cannot
   fail: it says `git grep -c "^let \|^const "` before and after must agree, and `client.ts` declares
   zero module-scope `let`/`var` (one `const`, at `:1235`, and `const` is not mutable state). The repo
   *does* have **13 module-scope `let`s in five files** under `bootstrapped/src` (`page/override.ts:24`,
   `render/pixi.ts:118-123`, `render/world-scene.ts:101`, `render/ctors.ts:281-288`,
   `jotai/bridge.ts:166-175`), so a blanket "no module-scope `let`" guard, the shape 5.5b used for
   `headless` where the claim is true, would be a false statement here. Instead the guard pins that
   set as an allow-list, so a split that *adds* one fails, which is the one split failure no type error
   catches. It carries a control test proving the predicate notices a `let`, because
   `assert.deepEqual([], [])` also passes for a scanner that read no bytes.
4. `render/render-facade.test.ts`: the seam, asserted as an API property: `createRenderFacade` accepts a
   plain `{ capture, jotai }` object and needs no `BootstrappedClient`, reads `capture` **lazily** (a
   handle installed after construction is visible through `client.render.capture`), and omits the
   cinematic hooks when there is no bridge.

**Not in this task, with the reason.** The audit's structure report proposes two further extractions,
`coexistence/outbound.ts` and `attach/upgrade.ts` (`:801-961` here). Both are deferred, because they move
private lifecycle state across a module boundary in the package's trickiest path (the socket-to-room
upgrade) for ~180 lines, and 5.7e's stated target is the diagnostics/report split plus the seam. The
consequence is recorded as correction 8: **§4.2's `client.ts (≈380)` target is not met by 5.7e**, and the
Phase 5 acceptance line "no source file in `bootstrapped/src` exceeds 500 lines except `ctors.ts` and
`jotai/bridge.ts`" is **not met for `client.ts`** at the end of this task. Preferring the honest
measurement over the tidy claim is what DESIGN §6/I8 calls for; the remainder gets a named task rather than
a silent exception.

**5.7f `render/ctors.ts` (897) and `jotai/bridge.ts` (777).** Not in §4.2's target tree as splits, and
**not required by the scope-A list**. Leave them: §4.2 lists `ctors.ts` as a single file. Recorded as
**F6**.

### Test first

Each sub-task copies 5.5's and 5.6's pattern, because they are the same kind of move:

1. **A name-set guard per facade.** `bootstrapped/tests/barrels.test.ts` (from 5.6) is extended so that
   `world.js`, `room-connection.js`, `client.js` and the entry module each export the same name set as
   before the split. A moved symbol that is not re-exported fails by name.
2. **The existing suite, unchanged in its import lines.** `npm run test:bootstrapped` → **202**, 0 fail,
   0 skipped after each of the six commits. `world.test.ts`, `attach.test.ts`, `emitter.test.ts`,
   `room-upgrade.test.ts`, `sequence-owner.test.ts`, `catalog-sources.test.ts`, `client-lifecycle.test.ts`
   are the consumers.
3. **Module-state census per split**, as in 5.5: `git grep -c "^let \|^const "` before and after must
   agree for each split file, because a duplicated module-level `const` is the one split failure no
   type error catches.
4. **`npm run size` after 5.7b specifically.** This is the only sub-task that moves the bundle entry.

### Acceptance

- After each sub-task: `npm run verify` exit 0, **202 bootstrapped tests**, 0 fail, 0 skipped,
  bundle **319887 B**.
- No source file in `bootstrapped/src` exceeds 500 lines except `ctors.ts` (897) and `jotai/bridge.ts`
  (777), which this phase leaves open (F6).
- `grep -rn "from '\./attach/room-connection\.js'\|import('\./attach/room-connection\.js')"` returns the
  facade call sites only.
- `npx tsx packages/bootstrapped/scripts/build.ts` (or `npm run bundle`) still writes
  `dist/magicgarden.user.js` and `npm run size` says `within budget`.

### Risk / revert

Six commits, each with a facade, so any one reverts alone. The failures that can hide: a split that
duplicates module-level state (mitigation 3); `build.ts`'s entry path left pointing at the old
`userscript.ts` (esbuild would fail loudly with *"Could not resolve"*, so this one is safe); and a facade
that stops re-exporting a symbol only a *consumer outside the repo* uses (mitigation 1).

---

## Task 5.8: Tests mirror the source

### Problem

DESIGN §4.3, verbatim:

> Today tests are named after *subsystems* (`attach.test.ts`, `transport-keepalive.test.ts`), so 27 of
> 66 source files are untested in a way nobody can see: only 5 of 22 test basenames match a source
> basename, and two different `connect-url.test.ts` files test different modules. Mirroring the path
> makes a missing test an empty slot rather than an invisible one.

**The audit's numbers are stale.** Measured at HEAD from actual imports: **63 `*.test.ts` + 2
non-test helpers**; **26 test basenames match an imported source basename**; **36 test files import no
module whose basename equals their own** (list in the table below); **5 import no source module at all**
(`build-output.test.ts`, `render-owner.test.ts`, `common/tests/unsubscribe.test.ts`,
`headless/tests/layering.test.ts`, `headless/tests/exports-map.test.ts`). So the *shape* of the finding
survives and the *number* does not: 36 tests have no source-shaped name, against 5 that did at audit
time; the gap closed partly because Phase 3 named files after their concepts.

### Change

**5.8a: `tests/integration/` and `tests/fixtures/`.** Per §4.3's own tree:

| file | new home | why |
|---|---|---|
| `bootstrapped/tests/build-output.test.ts` | `bootstrapped/tests/integration/` | asserts on the built artifact, not on a module |
| `headless/tests/integration.test.ts` | `headless/tests/integration/` | already named for it |
| `bootstrapped/tests/room-upgrade.test.ts` | `bootstrapped/tests/integration/` | end-to-end upgrade path |
| `headless/tests/layering.test.ts` | `headless/tests/integration/` | a whole-repo boundary scan |
| `headless/tests/exports-map.test.ts` | `headless/tests/integration/` | reads built artifacts |
| `headless/tests/mock-server/server.ts` | `headless/tests/fixtures/mock-server.ts` | a fixture, not a `*.test.ts` |
| `headless/tests/helpers/fake-socket.ts` | `headless/tests/fixtures/fake-socket.ts` | "helpers" is not a §4.3 directory |

**5.8b: mirror the rest.** Because `node --test "tests/**/*.test.ts"` **already expands recursively**
(`node --fs` `globSync('tests/**/*.test.ts')` returns 19/19 in `packages/common`), this task changes
*names*, not discoverability; do not claim otherwise in the commit body. The moves that matter:

| current | mirrored | imports that change |
|---|---|---|
| `common/tests/catalog.test.ts` | `common/tests/catalog/index.test.ts` | `../src/...` → `../../src/...` |
| `common/tests/credential-log.test.ts` | `common/tests/log.test.ts` | none |
| `headless/tests/backoff.test.ts` | `headless/tests/reconnect.test.ts` | none |
| `headless/tests/runtime-headers.test.ts` | `headless/tests/transport/headers.test.ts` | `../../src/...` |
| `headless/tests/transport-keepalive.test.ts` | `headless/tests/transport/runtime.test.ts` | `../../src/...` |
| `headless/tests/transport-frame-cap.test.ts` | `headless/tests/transport/standalone.test.ts` | `../../src/...` |
| `headless/tests/transport-dispose.test.ts` | `headless/tests/transport/standalone-dispose.test.ts` | `../../src/...` |
| `headless/tests/room-socket-contract.test.ts` | `headless/tests/room-socket.test.ts` (merged) | none |
| `headless/tests/emitter.test.ts` | `headless/tests/client-events.test.ts` | none |
| `bootstrapped/tests/attach.test.ts` | split: `attach/detect.test.ts`, `attach/room-connection.test.ts` | `../../src/...` |
| `bootstrapped/tests/emitter.test.ts` | `bootstrapped/tests/attach/transport.test.ts` | `../../src/...` |
| `bootstrapped/tests/warn-once.test.ts` | `bootstrapped/tests/render/warn-once.test.ts` | `../../src/...` |
| `bootstrapped/tests/ctors.test.ts` | `bootstrapped/tests/render/ctors.test.ts` | `../../src/...` |
| `bootstrapped/tests/coexistence.test.ts` | `bootstrapped/tests/coexistence/renumber.test.ts` | `../../src/...` |
| `bootstrapped/tests/envelope-owner.test.ts` | `bootstrapped/tests/coexistence/envelope.test.ts` | `../../src/...` |
| `bootstrapped/tests/jotai.test.ts` | `bootstrapped/tests/jotai/bridge.test.ts` | `../../src/...` |
| `bootstrapped/tests/catalog-sources.test.ts` | `bootstrapped/tests/live-catalog/sources.test.ts` | `../../src/...` |
| `bootstrapped/tests/options.test.ts` | `bootstrapped/tests/client-options.test.ts` | none |
| `bootstrapped/tests/sequence-owner.test.ts` | `bootstrapped/tests/attach/sequence-owner.test.ts` | `../../src/...` |
| `bootstrapped/tests/raw-socket.test.ts` | `bootstrapped/tests/attach/raw-socket.test.ts` | `../../src/...` |
| `bootstrapped/tests/client-lifecycle.test.ts` | `bootstrapped/tests/client.test.ts` | none |

The remaining files (`client.test.ts`, `patch.test.ts`, `store.test.ts`, `poll.test.ts`,
`errors.test.ts`, `forms.test.ts`, `sequencer.test.ts`, `redact.test.ts`, `weather.test.ts`,
`unsubscribe.test.ts`, `connect-url.test.ts` ×2, `sprite.test.ts`, `rive.test.ts`, `world.test.ts`,
`session.test.ts`, `version.test.ts`, `auth/cookie.test.ts`, `protocol/codec.test.ts`,
`catalog/http.test.ts`, `catalog/remote-json-source.test.ts`, `connect-supersedes-backoff.test.ts`,
`credential-headers.test.ts`, `credential-leak.test.ts`, `disconnect-race.test.ts`, `reconnect-*.test.ts`,
`superseded-attempt.test.ts`, `version-loop.test.ts`, `client-contract.test.ts` ×2) already either
mirror a source basename or are integration-shaped and move under 5.8a.

**5.8c: fix the hardcoded test literals the moves invalidate.** These are the tests that read source
by literal path, and **they are the ones that can silently pass on a moved tree**:

- `common/tests/poll.test.ts:288,297,298` walk `packages/<pkg>/src` and `tests`; `:311` literal
  `'packages/common/src/poll.ts'`; `:352` `'packages/headless/tests/reconnect-chain.test.ts:1'` and
  `'packages/headless/tests/version-loop.test.ts:2'`; `:424` `'packages/headless/src/client.ts'`.
- `common/tests/unsubscribe.test.ts:39,45,46,47`: `poll.ts`, `state/store.ts`, `transport/types.ts`
  (→ `seam.ts` in 5.3), `headless/src/room-socket.ts`.
- `common/tests/emitter.test.ts:144,153`: `packages/common/src/emitter.ts`.
- `bootstrapped/tests/render-owner.test.ts:25,62,73,85,98,110,120`: `RENDER_ROOT` and six literals.
- `bootstrapped/tests/sequence-owner.test.ts:48,68,73`: `packages/common/src/protocol/codec.ts`.
- `bootstrapped/tests/emitter.test.ts:71`: `new URL('../src/attach/transport.ts', import.meta.url)`,
  which becomes `attached-transport.ts` if the audit's rename is taken (DESIGN §4.2 lists it; **F3**).
- `bootstrapped/tests/build-output.test.ts:38,61`: artifact path and the skip-warning string.

**Add a guard so this cannot regress:** a case in the new `bootstrapped/tests/barrels.test.ts` (or a
small `headless/tests/integration/structural-paths.test.ts`) that asserts **every** literal
`'packages/<pkg>/src/...'` string appearing in any test file resolves to an existing file. That single
scan turns all of the above into loud failures instead of silent passes (F7).

### Test first

Move tests only, so the evidence is: **the same 809 tests are still discovered and still pass**, and the
new structural-path guard fails before 5.8c and passes after. Per-package assertions after every move
batch: **common 423+1 (the 5.4 parity test) = 424, headless 184, bootstrapped 202**, 0 fail, 0 skipped, for an
`npm test` total of **810**. If a moved file stops being discovered, the count drops and that is the red.

### Acceptance

- `npm test` → 810 tests, 0 fail, 0 skipped; per-package 424 / 184 / 202.
- `grep -rn "tests/helpers\|tests/mock-server" packages` → nothing.
- The structural-path guard passes and fails when one literal is corrupted by hand (observed).
- `npm run verify` exit 0; bundle 319887 B.

### Landed: the numbers this section predicted were stale, and here are the measured ones

Both acceptance figures above were written against the tree as it stood when the plan was drafted and were
already wrong before 5.8 started: the suite had grown to **876** tests across **common 434 / headless 196 /
bootstrapped 246** (from 810 / 424 / 184 / 202), and the bundle had reached **322,654 B** (from 319,887). The
task's real invariant is the one its own "Test first" names: *the same tests are still discovered and still
pass*, so the counts are reported as measured, before and after, rather than compared to a stale target:

| | before 5.8 | after 5.8 |
|---|---|---|
| total | 872 | **876** |
| common | 434 | 434 |
| headless | 192 | **196** |
| bootstrapped | 246 | 246 |

Headless gains four because the structural-path guard this task adds lives there (it is a whole-repo scan, as
`layering.test.ts` is). Everything else is unchanged, which is the assertion that matters: **moving and
splitting test files neither loses nor duplicates a test.**

**The guard's acceptance line was observed, not argued.** The criterion above asks that it *"passes and fails
when one literal is corrupted by hand"*. Renaming a single literal in `common/tests/emitter.test.ts` to
`packages/common/src/emitter-renamed-hand.ts` produced one failure, naming the site:

```
not ok 2 - every packages/<pkg>/src or /tests path named by a test exists
    +   'common/tests/emitter.test.ts:153 -> packages/common/src/emitter-renamed-hand.ts'
```

and reverting restored 4/4. The same failure mode is also pinned permanently in-process by the guard's own
control case, so the evidence does not rest on this transcript.

Two commits, because the mechanical and editorial halves fail differently:

1. 26 files relocated (`tests/integration/`, `tests/fixtures/`, and mirrored basenames), plus the
   structural-path guard, plus nine prose corrections. **This is where the interesting failures were**, and
   none of them came from the import rewrite: five paths were built rather than imported, so no specifier
   rewrite could see them. `build-output.test.ts` resolved the artifact from `'../dist'` and **silently
   skipped 16 tests**. A skip reads as "the build has not run yet", not as a broken path, which is
   the failure mode this task exists to make visible.
2. The 5.8b remainder: `tests/attach.test.ts` (552 lines, 23 tests) split into `attach/detect.test.ts`
   (6 tests) + `attach/room-connection.test.ts` (17 tests), with the shared fixtures moved to
   `tests/fixtures/attach-fixtures.ts`; and `room-socket-contract.test.ts` (7 tests) merged into
   `room-socket.test.ts` (16 → 23 tests). Verified by hashing every test block before and after: all 23 + 23
   bodies byte-identical, none missing, none extra, because "the count is the same" is also true of a suite
   that lost one test and gained another.

### Correction 9: the split preserved an assertion that could not fail

Splitting `attach.test.ts` verbatim also preserved a defect: `room-connection.test.ts` carried

```ts
assert.deepEqual(received, [JSON.stringify({ type: 'RoomFrame' })].length === 0 ? [] : received);
```

The array literal's length is always 1, so the ternary always takes its right-hand branch and the line
compares `received` with itself. It asserted nothing, and it **survived Task 0.4's sweep for assertions that
cannot fail**. That sweep looked for literal tautologies and for assertions in files with no failure path,
while this one is *computed*: the expression reads as a conditional expectation. It is now
`assert.deepEqual(received, ['ping'], 'the frame arrives byte-for-byte')`, which passes, and which would fail
if the transport ever synthesised an envelope on the host's behalf. A sweep for `assert.x(a, a)` and for
tertiary shapes in assertion arguments found no other instance in the repository.

The fixture side of the same split produced a second, milder finding: three different classes named
`FakeRoomConnection` now stood in the tree (the Appendix-A reference implementation, a ten-line minimum shape
that proves what `detectAttachment` accepts, and a socket-modelling fake for the upgrade path). Merging them
would delete what two of them assert, so they are renamed for what they are: `MinimalRoomConnection`,
`UpgradeRoomConnection`, and the reference one; and the fixture module records why they coexist, because the
next reader's instinct will be to deduplicate them.

### Risk / revert

Reordering tests does not change production code, so the bundle cannot move, but **a renamed test file
that is no longer matched by the glob is a silent loss of coverage.** The per-package count assertions
above are the only thing standing between that and a green-but-hollow suite. Revert: one commit.

### Phase 5 closure: measured, with two acceptance lines not met and named

**Boundary evidence at the boundary.** `npm run verify` exit 0: lint, typecheck (src + tests), build, **876
tests / 0 fail / 0 skipped** (common 434, headless 196, bootstrapped 246). `npm run verify:catalog` exit 0, printing
`ALL LIVE CHECKS PASSED` (`.logs/phase5-close-catalog.log`). `npm run verify:socket` exit 0, printing `LIVE SOCKET
CHECK PASSED (documented behaviour observed)` (`.logs/phase5-close-socket.log`). Bundle **322,654 B**, up
32,893 B from the 289,761 B pre-programme baseline, and within budget.

Landed, in order: 5.1-5.4, 5.5a, 5.5b-1/2/3, 5.6a-d, 5.7a-e, 5.8a/b, plus the size-budget task and the 5.5b
re-scope. `5.7f` is a no-op (F6: `ctors.ts` and `jotai/bridge.ts` are listed as single files in
§4.2 and are not in the scope-A list).

**Acceptance line 1: "no source file in `bootstrapped/src` exceeds 500 lines except `ctors.ts` and
`jotai/bridge.ts`" is NOT met.** Measured at the boundary, over 500 lines:

| file | lines | why it is where it is |
|---|---|---|
| `bootstrapped/src/client.ts` | 1179 | the composition root; needs the class-body decomposition 5.5b re-scoped |
| `headless/src/client.ts` | 1178 | the same re-scope, unchanged from 5.5b |
| `common/src/client.ts` | 1029 | `ClientCore`; no task in this phase ever proposed splitting it |
| `render/ctors.ts` | 897 | explicitly excepted by the line above (F6) |
| `jotai/bridge.ts` | 777 | explicitly excepted by the line above (F6) |
| `coexistence/renumber.ts` | 661 | not a split target in any task of this phase |
| `render/world-scene.ts` | 651 | a 5.7c *product*: `world.ts` was 988 and is now five modules |

So the line above was met for the files this phase was actually asked to split, and missed for seven. Two of
the seven were pre-excepted, one was never in scope, and four are homed: the two `client.ts` class bodies to
the 5.5b follow-on plan (their own risk budget), and `renumber.ts` / `world-scene.ts` to that same plan, since
the only honest way to cut them is the same `this`-bound decomposition; "cut, not rewritten" is not available
for either. Recording the number rather than adding an exception is what DESIGN §6/I8 calls for.

**Acceptance line 2: the stale figures.** "810 tests / 424-184-202" and "bundle 319887 B" were wrong before
this phase's test work began; the measured values are in the 5.8 section above.

**What Phase 5 bought, in one line each.** `common` is platform-free and single-purpose per module; every
package has one barrel per folder with a pinned name set, and no leaf module imports a barrel; the page realm,
storage, render world, room connection and client diagnostics each have a named home instead of a 990-1400
line file; and three guards exist that did not (module-scope mutable state, the `client.js` surface, the
structural path scan), two of which replaced mitigations the plan itself had written that could not fail.

---

## Findings beyond the table

Each with evidence and a disposition. **T** = becomes a task here; **D** = deferred to a named home;
**N** = not a defect.

### F1: `common/src/index.ts` uses `export *` where DESIGN §4.2 says "explicit re-exports only". [D → Phase 6]

`common/src/index.ts:15,16,50,53,54` are five `export *` lines (`actions`, `catalog`, `protocol`,
`state`, `transport`); DESIGN §4.2's tree annotates the same file *"explicit re-exports only (no `export
*`)"*. Scope A does not list it, and Phase 6 is "Inert surface: implement or delete", which is the right
home: replacing five `export *` with explicit lists is a **public-surface** change (it will drop
whatever is currently leaked but unintended) and deserves its own review. **DESIGN is right; the scope
list is silent; Phase 6 wins.** Note it in the Phase 6 scoping.

### F2: Seven `common` subpaths in scope A's prose have no task and are not in DESIGN §4.2. [D → Phase 8.3]

Scope A's table claims *"7 new `exports` subpaths"*; it does not name them, no task adds them, and
DESIGN §4.2's trees list only `common`'s five folder barrels + root. Two of the candidates are real
gaps: `@mg.js/common/poll` and `@mg.js/common/redact` are documented-by-name concerns a consumer might
want without the whole core. **Deferred, because it is a distribution decision, not a structure one.**
`exports` is publish surface, and the packages are `"private": true` with no release
(DESIGN §11, Phase 8.3). Named home: Phase 8.3, which already owns `files`/`sideEffects`/`npm pack`.

### F3: `attach/transport.ts` → `attached-transport.ts` is in scope A and §4.2 but in no task. [T → folded into 5.6a]

`bootstrapped/src/attach/transport.ts` (471 lines) holds the class `AttachedTransport`, which is
the same `StandaloneTransport`-in-`client.ts` misnaming that task 5.5 fixes on the headless side. It is a
one-line `git mv` plus 4 import sites (`bootstrapped/src/index.ts` ×2, `bootstrapped/src/client.ts`,
`bootstrapped/tests/attach.test.ts:34`, `bootstrapped/tests/emitter.test.ts:18-20,71`). **Folded into
5.6a**, where `attach/index.ts` and the root barrel are being rewritten anyway; do not give it its own
commit. DESIGN §4.2 wins over the task table's silence.

### F4: `packages/headless/tsconfig.test.json` is dead config. [D → Phase 8.4]

`grep -rn "tsconfig.test"` over the repo returns nothing outside `docs/`; no `package.json` script, no
root config, no code references it. It duplicates a subset of root `tsconfig.tests.json` and would
silently drift. Named home: Phase 8.4 ("Naming, `npm ls` clean"), which is the config-hygiene task.
**Not deleted here** because Phase 5's constraint is "no behaviour change" and deleting a config is a
different review.

### F5: The §4.1 leaf rule ("no module imports a barrel") is unenforced. [T → 5.6 Test first]

The rule holds today: **zero** matches for `from './index.js'` / `from '../index.js'` in any
`packages/*/src`, and the only barrel importer anywhere is `common/tests/sequencer.test.ts:16`, yet
nothing asserts it. `headless/tests/exports-map.test.ts:116-122` asserts the *inverse* direction
(subpaths must target barrels). Phase 5 adds six new barrels to `bootstrapped`, tripling the
opportunity to violate it. Disposition: the leaf-rule scan goes into `bootstrapped/tests/barrels.test.ts`
(5.6) and, being a whole-repo property, is worth a shared home if a later phase consolidates structural
guards.

### F6: `render/ctors.ts` (897) and `jotai/bridge.ts` (777) are large but correctly shaped. [N]

§4.2's target tree lists both as single files, and no scope-A line names a split. §4.1's rule is about
*folders*, not line counts; `ctors.ts` is a cache/сtor-resolution module with no second concept in it,
and `bridge.ts` is one bridge. **Not a defect.** If a later phase wants them smaller, that is a
functional refactor, not structure.

### F7: `render-owner.test.ts` and its siblings can silently pass on a moved tree. [T → 5.8c]

Six tests read source by literal path (`render-owner.test.ts:25,62...120`; `poll.test.ts:311,352,424`;
`unsubscribe.test.ts:39,45-47`; `emitter.test.ts:153` ×2; `sequence-owner.test.ts:73`). Their scans walk
`packages/*/src` and assert on an **expected-offender list**; if the module they name is renamed, the
scan finds nothing and the expected list is compared against `[]`, which fails, but only *for the ones that
assert a non-empty list*. The dangerous ones are the scans that assert `deepEqual(offenders, [])`:
`layering.test.ts:54-68`, `transport`-boundary scans, and `poll.test.ts:305` (*"exactly one file
declares the poll helpers"*), and on an empty or mis-rooted directory, "exactly one file" becomes "zero
files" and passes. Disposition: **5.8c adds a scan that asserts every `'packages/<pkg>/src/...'`
literal in every test file resolves to an existing path**, which converts the whole class into loud
failure. This is the I8-flavoured finding of the phase: *a gate that cannot fail is not a gate.*

### F8: Root `scripts/verify-*.ts` bypass the `exports` map with 7 deep relative imports. [D → Phase 8.2, partial fix in 5.3]

DESIGN §3.1 rule 3: *"`packages/*/src` may not be imported across packages. `scripts/verify-socket.ts:47-49`
currently imports `../packages/headless/src/client.js`; the exports map exists precisely so it does not
have to."* The `verify-socket.ts:47-49` instance is already fixed (it now imports `'@mg.js/headless'` at
`:66`), but seven deep relative imports remain: `probe-guest-encoding.ts:45`,
`verify-catalog.ts:13-16`, `verify-socket.ts:67,68`. They work only because `tsx` resolves source
directly. **Disposition: 5.3 must fix the one it breaks (`verify-catalog.ts:15`'s `catalog/types.js`);
the rest are deferred to Phase 8.2**, which brings CI up and is where a script that only works
unbuilt should be re-pointed at `@mg.js/common`. Until then, note that these scripts are **not** in
`npm run verify`, so a broken one leaves the gate green.

### F9: every audit metric in the two structure reports is stale, and one is pointedly so. [N: documentation]

`docs/audit/40-structure-packages.md:3` says *"66 source files, 21,291 lines, 22 test files"*; HEAD is
**76 / 24,534 / 63 test files + 2 helpers**. `docs/audit/41-structure-repo.md`'s baseline says *"bundle
276.2 KiB (282,800 B)"* and *"# tests 490"*; HEAD is **319,887 B** and **809 tests**. The 282,800 →
319,887 growth (37 KB, **+13%**) under a 320 KiB hard gate is the one that changes behaviour: the
audit's §1 claim says *"The `export *` barrels are tree-shaken correctly"* and that this *"is NOT a bundle problem"*. It was
verified against 282,800 B, i.e. **37 KB and one hard-gate headroom of 7,793 B ago**. That claim is
still *directionally* true (nothing in scope A adds a dependency), but it is no longer *verified*, and
Phase 5 of all phases is the one that rewires barrels. **Not a defect in the code; a defect in the
evidence.** Disposition: this plan's Verification plan makes the byte count a per-task assertion rather
than a phase-end one; correct the two audit baselines when the phase closes.

### F10: `common/src/index.ts` has no `exports`-map test, unlike `headless`. [T → 5.3]

Verified: `ls packages/common/tests | grep -i export` → nothing; only `headless` has
`exports-map.test.ts`. `common` is the package *both others* consume, and its six subpaths are the
seam. Task 5.3 adds the file.

### F11: the new `exports-map`/`parity` tests must skip, not fail, before a build. [N: design note]

Documented so an executor does not "improve" it away: `headless/tests/exports-map.test.ts:20-26`
explains that failing when `dist/` is absent makes the suite order-dependent, and Phase 0 Task 3
established the pattern by making 16 previously-skipped artifact assertions actually run *inside*
`npm run verify`. Both new common tests copy that behaviour. **A skipped test in `npm test` is the
correct outcome for a missing artifact; a failing one is not.**

---

## Verification plan for the phase

**Per task (every commit):**

```bash
npm run verify        # lint → typecheck(src+tests) → build → test → size. Must exit 0
```

**Green at the baseline** (measured at the phase close for this plan, not copied from the master plan):
exit 0, **809 tests**: **bootstrapped 202, common 423, headless 184**, with `# fail 0`, `# skipped 0`, and
the line `[size] bundle 312.4 KiB (319887 B)` with `within budget`. Note the printed *delta* is measured against
`BASELINE_BYTES = 314_423` (`scripts/assert-bundle-size.ts:53`, captured post-Phase-4.5) and is
therefore **+5,464 B**, not zero; that delta does not gate; only `FAIL_BYTES` does. The master plan's
*"736 tests (bootstrapped 181, common 386, headless 169)"* is one phase stale; Task 5.4 and 5.6 add
tests, so the totals rise during Phase 5 (5.4: common 424 = 133-name parity + 1; 5.6: one new
bootstrapped file whose case count must be recorded in the commit body; 5.8: **-1 to +N**, see below).
**The invariant is `# fail 0` and `# skipped 0`, and that no existing test disappears.** Task 5.8 is
the only task that can legitimately move the count: `room-socket-contract.test.ts` is merged **into**
`room-socket.test.ts` (its `describe` blocks move; the case count is unchanged) and
`bootstrapped/attach.test.ts` is **split** into `attach/detect.test.ts` and
`attach/room-connection.test.ts` (the case count is unchanged too: the same `test()`/`describe()`
calls, redistributed). So the per-package counts must still read **424 / 184 / 202** after 5.8, and any
other number is a lost or duplicated test.

**The bundle is the phase's one real numeric risk.** `scripts/assert-bundle-size.ts:40` sets
`FAIL_BYTES = 320 * 1024 = 327,680`; the artifact is **319,887 B**, which is **7,793 B of headroom**, with the
**300 KiB (307,200 B) warning line already crossed** (`:43`). Phase 5 moves code and should not change
reachability, but six barrels are added (5.6) and the bundle entry moves (5.7b), so:

> **Correction (2026-09-13, before 5.2 started).** The thresholds in this section are no longer the gate.
> `FAIL_BYTES` is now **600 KiB (614,400 B)** and `WARN_BYTES` **500 KiB (512,000 B)**, raised on the
> maintainer's explicit instruction once the artifact reached 319,887 B, which is 7,793 B under a ceiling a
> *file-moving* phase could have tripped, with the old 300 KiB warning already firing on every run and
> therefore carrying no information. The instruction below is unaffected and still stands: a task may not
> change the byte count silently. But the literal **"headroom is 7,793 B"** and every **`320 KiB` /
> `300 KiB`** figure in this document are pre-raise figures, kept as the record of what the plan was
> written against. Two consequences for execution: the per-task bundle checks must still compare against
> **319,887 B** (that is what makes them discriminating, not the ceiling), and the `assert-bundle-size.ts`
> line numbers quoted here (`:40`, `:43`) have shifted by the header comment that records the raise.
> `BASELINE_BYTES` was **not** refreshed on purpose. It is 5,464 B behind the artifact, and refreshing
> it in a commit that does not explain that growth would hide it.

```bash
# before any task that touches reachability (5.6, 5.7b, and 5.2/5.3's barrel rewrites):
ls -l packages/bootstrapped/dist/magicgarden.user.js     # expect 319887
# after: must be byte-identical. If it is not, do not commit; find what became reachable.
node --import tsx -e "import('./scripts/assert-bundle-size.ts').then(m=>console.log(m.checkBundleSize(319887)))"
```

**A task may not cross the gate, and a task that changes the number at all must say by how much and
why in its commit body.** The plan's working assumption, to be *checked*, not trusted, is that
`bootstrapped` never imports `headless` (asserted by `headless/tests/layering.test.ts:54-68`), so
5.5 and 5.6 cannot move the number. Verify, do not assume:
`grep -c "headless" packages/bootstrapped/dist/magicgarden.user.js` → `0`.

**Targeted commands**

| command | proves |
|---|---|
| `npm run test:common` | 423 (+1 after 5.4), covering the barrel/rename survivors: `sequencer.test.ts`, `forms.test.ts`, `errors.test.ts`, `envelope.test.ts`, `patch.test.ts` |
| `npm run test:headless` | 184, and after 5.5, that all eleven `../src/client.js` importers still resolve through the facade |
| `npm run test:bootstrapped` | 202 (+ N after 5.6), and after 5.6/5.7, that `build-output.test.ts`'s one-chunk assertions still hold |
| `npm run size` | the artifact stayed one chunk and inside budget |
| `npm run typecheck` | **both** `tsc -b --force` (reads `exports`? **no**) and `tsc -p tsconfig.tests.json` (the 58 `.ts` specifiers) |
| `node -e "import('@mg.js/common').then(m=>console.log(Object.keys(m).sort().join('\n')))"` | the built, resolved subpath surface, which `tsc -b` cannot see |
| `grep -rn "from '\./index\.js'\|from '\.\./index\.js'" packages/*/src` | zero, which is the §4.1 leaf rule |

**Live checks** (`verify:socket`, `verify:catalog`, `probe:guest` need the network and are **not** part
of `npm run verify`):

- `npm run verify:catalog`, run **after 5.3**, which edits `scripts/verify-catalog.ts:15`. It exits 2
  when it cannot reach the network and 1 on a catalog regression, so an outage is distinguishable from
  a rename breakage; if it exits 2, say so in the commit body rather than claiming green.
- `npm run verify:socket`, run **after 5.5**, whose split touches `HeadlessClient`.
- `npm run probe:guest`, run **after 5.3**; it imports `../packages/common/src/protocol/close-codes.js`
  (`:45`), and `close-codes.ts` is the one file `biome.json:38` names.

**Phase exit criteria**

- `npm run verify` exit 0; `# fail 0`; `# skipped 0`; bundle **≤ 327,680 B** (target: 319887 B,
  unchanged).
- Every scope-A move has landed: `protocol/` holds only `index.ts`, `wire.ts`, `envelope.ts`,
  `codec.ts`, `connect-url.ts`, `close-codes.ts`, `id.ts`; `actions/` holds `index.ts`, `registry.ts`,
  `params.ts`, `game-actions.ts`, `handle.ts`, `sequencer.ts`, `result-codes.ts`; `transport/` holds
  `index.ts`, `seam.ts`; `catalog/` holds `index.ts`, `defs.ts`, seven sources; `headless/transport/`
  holds `index.ts`, `standalone.ts`, `runtime.ts`, `headers.ts`; `headless/auth/` holds `index.ts`,
  `providers.ts`, `cookie.ts`, `guest.ts`, `session.ts`; `bootstrapped` has eight barrels, a `page/`
  and a `storage/` and a `live-catalog/` and an `entry/`, and no source file over 500 lines except
  `ctors.ts` and `jotai/bridge.ts` (F6).
- **Still open by choice:** `auth/types.ts` → `providers.ts` (DESIGN §4.2 lists it; the task table
  does not). Fold it into 5.5 if the executor wants it in this phase; it is 3 import sites
  (`headless/src/auth/index.ts:33,35`, `headless/src/client.ts`, and three test files) and carries no
  `exports` change, since `"./auth"` already targets the barrel. **Recommended: take it in 5.5**, so
  the probe's own check, `node -e "import('@mg.js/headless/auth').then(m=>console.log(Object.keys(m)))"`
  That probe verifies a tree whose filenames match DESIGN.
- The master plan's `### Phase 5: Structure (the folder rule)` heading gains a `**Status: COMPLETE**`
  line naming the commits, and its three stale claims are corrected: **5.1 is done (Phase 3)**, **5.3's
  "worth doing regardless of scope" exports fix landed in Phase 0**, and **"66 → ~105" becomes
  "76 → 86 source files"** with a pointer to §2 of this plan.

## Document corrections (all verified against the working tree at the boundary)

| master plan / DESIGN / audit says | actual at HEAD |
|---|---|
| master plan Phase 5: *"66 → ~105"* (scope A) | **76 → 86 source files**, measured; 66 was the audit-era count |
| master plan Phase 5: *"`@mg.js/headless/auth`"* and *"is a five-line fix"* and *"can be pulled forward"* | already fixed; `headless/package.json` `"./auth"` → `./dist/auth/index.js`, asserted at `exports-map.test.ts:116-122` |
| master plan table row 5.1 *"Dedupe first, no moves"* | complete in Phase 3; no work remains |
| master plan table row 5.3 *"add `auth/index.ts`, `transport/index.ts`; `session.ts→auth/`"* | all three landed in Phase 4 (0/4); `session.ts` is still at `headless/src/session.ts`; **only the `session.ts` → `auth/session.ts` half is outstanding** |
| master plan: *"736 tests (bootstrapped 181, common 386, headless 169)"* | **809** (bootstrapped 202, common 423, headless 184) |
| audit 40 `:3` *"66 source files, 21,291 lines, 22 test files"* | **76 / 24,534 / 63 `*.test.ts` + 2 helpers** |
| audit 40 §1: bundle *"282,800 bytes"*, *"zero occurrences of `RemoteJsonSource`"*, and that it is *"NOT a bundle problem"* | **319,887 B**, +37,087 B since; the claim is directionally true but was verified 37 KB and 7,793 B of gate headroom ago |
| audit 40 §1: *"`common/package.json`'s `exports` map (6 entries) mirrors them 1:1"* | still true (`. ./protocol ./actions ./state ./catalog ./transport`), so record it as correct |
| audit 41: *"`npm run verify`"* ... *"# tests 490"*, and *"`.npm-cache/ 64K"* ... *"ORPHAN: no .npmrc exists"* | 809 tests; `.npmrc` and `.npm-cache/` state changed in Phase 0/8; re-verify before citing |
| DESIGN §4.2: `common` *"34 → 35 files"*, `headless` *"12 → 22"*, `bootstrapped` *"20 → 48"* | measured at HEAD: **39 / 15 / 22**; §4.2's target *shape* stands, its file *counts* are audit-era |
| DESIGN §4.2: `common/src/index.ts` *"explicit re-exports only (no `export *`)"* | five `export *` lines at `:15,16,50,53,54`; deferred to Phase 6 as **F1** |
| DESIGN §4.2: `page/` *"index.ts realm.ts namespace.ts override.ts"* | at HEAD `realm.ts` is one 388-line file; 5.6b creates the folder |
| DESIGN §4.2: `catalog/` in `bootstrapped` → `live-catalog/` | still `bootstrapped/src/catalog/bundle.ts` (428), still open as 5.7a |
| DESIGN §4.2: `auth/providers.ts (was types.ts)` | still `headless/src/auth/types.ts` (101), folded into 5.5 in this plan |
| DESIGN §4.2: `attach/attached-transport.ts (was transport.ts)` | still `attach/transport.ts` (471), folded into 5.6a as **F3** |
| DESIGN §4.2: `render/world-scene.ts (was world.ts)` | still `render/world.ts` (988), still open as 5.7c |
| DESIGN §4.3: *"27 of 66 source files are untested"*, and that *"only 5 of 22 test basenames match"* | **36 of 63 test files have no source-shaped basename**; 26 do match. Re-measured from actual imports |
| DESIGN §3.1 rule 3: *"`scripts/verify-socket.ts:47-49` currently imports `../packages/headless/src/client.js`"* | fixed; it imports `'@mg.js/headless'` at `:66`. Seven deep relative imports remain in the three root scripts (**F8**) |
| `tsconfig.tests.json:4-5`: *".ts imports in 21 places"* | **58 specifiers in 20 files**. Correct the comment when convenient; not a Phase 5 task |
| `docs/audit/40` §5 order names `headless/client.ts`→8 last | this plan runs it **first among the splits** (5.5), before the `bootstrapped` splits, because it is the lower-risk package and sets the facade convention; the audit's *"ascending risk"* order is about review comfort, not correctness, and 5.5→5.7 keeps the same shape |

### Corrections found while landing 5.2 and 5.4 (2026-09-13)

1. **5.4 landed before 5.2, and on purpose.** The plan's own "Test first" asks for the snapshot to be
   captured pre-move; this put the net up pre-move instead, so 5.2's riskiest failure mode is guarded by a
 test that already existed. `packages/common/tests/symbol-parity.test.ts` is committed at the boundary.
2. **5.2's import-site list is incomplete.** It omits `protocol/sequencer.ts`'s own
   `import { asSequence, isCanonicalSequence } from './codec.js'`, which becomes `../protocol/codec.js`
   once the file lives in `actions/`. `tsc -b` catches it; the list would not have.
3. **5.2's `actions/index.ts` replacement block contradicts its own prose.** The prose says the file
   "must lose its redundant export-then-star at `:6-7`"; the code block it then prescribes *keeps*
   `export type { CrystalIntent, ShopKey } from './params.js';` above `export * from './params.js'`. The
   prose is right: `export *` re-exports types too. The line was dropped, and the claim was **proved**
   rather than assumed: a `tsc -p tsconfig.tests.json` probe importing both types from `@mg.js/common`
   exits 0, and its control (a misspelled name) fails with TS2305, so the probe discriminates.
4. **The 5.2 bundle check is `319,891`, not the `319,887` this plan demands**, and the plan was right to
   demand an explanation rather than a shrug. Attribution, measured against a clean pre-move build in the
   same tree: path-comment bytes 983 → 987 (**exactly +4**), the same **27** bundled modules, the same
   **8667** code lines, and an order-insensitive hash of all bundled code that is **byte-identical**
   (`6d0599d59902539fb95b9951b2e6feac`). The 1,618-line diff is esbuild reordering modules because
   Biome's `organizeImports` re-sorted the changed import specifiers, and esbuild traverses in import
   order. So the move changed no module's reachability, a stronger result than the size equality the
   plan asked for, which a compensating pair of changes could have satisfied by accident.
5. **5.3's reference lists miss four non-import sites**, three of which would have left a lying comment or a
   silently stale test: `common/src/unsubscribe.ts:6` and `bootstrapped/src/attach/transport.ts:6` both
   name `` `transport/types.ts` `` in prose, and `common/tests/unsubscribe.test.ts:50` labels its fixture
   `'transport/types.ts'` (the same test the plan correctly flags at `:46` for a literal path). All four are
   updated. The lesson generalises: a rename's blast radius includes comments and fixture labels, and
   `grep` for the *basename*, not only for import specifiers, is what finds them.
6. **5.3's byte result: 319,889, and the model now predicts it.** Path comments `catalog/types.js` →
   `defs.js` and `transport/types.js` → `seam.js` are -1 each, so -2 from 5.2's 319,891, measured as
   path-comment bytes 987 → 985, 27 modules, and an order-insensitive code hash identical to 5.2's. After
   two tasks the accounting is closed: every byte of drift so far is a module's *name in a comment*, and no
   bundled code has moved at all.
7. **5.5b is being landed incrementally, and its stated mitigation was vacuous.** Three things, all
   measured rather than argued:
   - The risk section's guard, *"every `let`/`const` at module scope in `client.ts` must appear in exactly
     one of the nine new files; `git grep -c "^let \|^const "` before and after must agree"*, **cannot
     fail.** `client.ts` declares **zero** module-scope `const`/`let`, so the count is 0 before and 0
     after whatever the split does, and `const` is not mutable state anyway. Replaced by
     `headless/tests/module-state.test.ts`, which asserts no `let`/`var` at module scope under
     `headless/src` (0 today; `common`/`bootstrapped` have 13, so the guard is scoped where the claim is
     true), refuses to pass if it scans no files, and carries its own control. Mutation-verified: injecting
     one `let` fails it, naming the file.
   - The stated evidence (2), *"a split that forgets to re-export `HeadlessReport` fails"*, and it is **mostly
     `tsc`'s job already**: removing a type re-export from the facade fails `index.ts` with TS2724. The
     facade guard earns its place on a narrower claim, now recorded in its own comment: `tsx` strips types
     without checking them, so under a bare `npm test` a value export that has become type-only is
     `undefined` at runtime with nothing to notice. Mutation-verified both ways.
   - **The acceptance target of 350-500 lines is not reachable by the described method.** The class body is
     1065 lines with **240** `this.` references; four of the nine prescribed modules
     (`connect-attempt`, `reconnect-scheduler`, `supersession`, `client-session`) are method bodies over up
     to 25 private fields, so "cut, not rewritten" is false for them. Extracting them means either
     exposing ~30 internals (a real public-API change) or introducing a session-state object and rewriting
     every `this.field`. That is the largest and riskiest change in the programme, for a file-size metric rather
     than a behavioural one. So 5.5b lands as **incremental commits** (which the master plan's 5.5 row
     already prescribes: *"big-file splits, one per commit"*), taking the zero-semantics-risk extractions
     first, and the class-body decomposition is re-scoped as its own task with its own risk budget instead
     of being smuggled into a structure phase.

   **5.5b increments landed** (each verified green, each independently revertable):

   | increment | commit | what moved | `client.ts` |
   |---|---|---|---|
 | 5.5b-1 | | `client-events.ts` (close event, events map, report), `client-options.ts` | 1404 → 1232 |
 | 5.5b-2 | | `connect-url.ts` (`joinHost`, `appendAuthQuery`, and `buildAttemptUrl`, the URL block lifted out of `openConnection`) | 1232 → 1203 |
 | 5.5b-3 | | `handshake.ts` (both constants and the send sequence) | 1203 → 1178 |

   **Remaining, re-scoped out of Phase 5:** `client-session.ts`, `connect-attempt.ts`,
   `reconnect-scheduler.ts`, `supersession.ts`, and the ~180 lines of accessors. Every one of them is
   `this`-bound: `openConnection` alone touches ~25 private fields and 240 `this.` references span the
   class, so the choice is between making ~30 internals public (a real public-API change, visible in
   `.d.ts`) and introducing a session-state object and rewriting every `this.field`. That is a behaviour-
   bearing refactor of the package's central class, and it deserves its own plan, its own test strategy
   and its own risk budget rather than riding along inside a structure phase whose stated premise was
   "cut, not rewritten". The 350-500 line target stays on the record as **not met**, with this reason.

8. **5.7e: §4.2's `client.ts (≈380)` target is not met, and the plan's module-state mitigation was vacuous
 for the second time.** Measured, where the file was **1290** lines and the class alone
   **940** physical / 463 code lines:
   - **The plan's line citations are stale.** `bootstrapped/src/client.ts:163-173, 794-834` and the
     `:852` reach-in come from the 994-line revision the audit read, not the file as it stood.
     `buildBootstrapReport`, the name the audit uses, exists in **no source file at all** (docs only).
     Re-derived: the `BootstrapReport` shape is `195-205`, `buildDetail` is `526-566`, and the
     `client['captureHandle']` reach-in is **`1177`**.
   - **`client.ts` ends 5.7e at 1182 physical lines, not ≈380.** The three named files explain only part of
     it: `diagnostics.ts` (-95 net) and `render/facade.ts` (-53 net), because each extraction leaves a thin
     adapter behind. Closing the rest needs the audit's *other* two splits (`attach/upgrade.ts` ←
     `:801-961`, `coexistence/outbound.ts` ← `:1063-1165`), which 5.7e's stated target does not include and
     which move private lifecycle state through the socket-to-room upgrade path. So the Phase 5 acceptance
     line *"no source file in `bootstrapped/src` exceeds 500 lines except `ctors.ts` and
     `jotai/bridge.ts`"* is **not met for `client.ts`**, recorded, not excepted.
   - **The mitigation cannot fail, again.** *"`git grep -c "^let \|^const "` before and after must agree"*:
     `client.ts` declares **zero** module-scope `let`/`var`, so 0 agrees with 0 whatever the split does.
     `tests/module-state.test.ts` replaces it, and **cannot** use 5.5b's blanket form, because
     `bootstrapped/src` has **13 module-scope `let`s in five files**, so "there are none" would be
     a false statement about the repo. The guard pins that set as an allow-list of per-file counts, so a
     split that moves a `let` into a new module or adds one to an existing file fails. Mutation-verified:
     appending one module-scope `let` to a new module fails it by name.
   - **The seam had a second defect the audit did not name.** The facade's `capture` is a **getter read
     lazily**: `createRenderFacade(this)` runs in the constructor, while the handle is really assigned in
     `start()`. The seam must therefore be a thunk (`{ captureHandle: () => this.captureHandle, jotai: () =>
     this.jotai }`), and a later "cleanup" to an eager read would pin `client.render.capture` to `null`
     forever, with no type error, and before this task no test. Now asserted in `tests/render/facade.test.ts`.
   - **The bracket access was hiding a redundant cast.** Element access on a `private` field is not a
     visibility error in TypeScript, so `client['captureHandle']` typechecked without the
     `as PixiCaptureHandle | null` beside it; the cast is what made the reach-in look like a typing
     necessity. It was the only `client['...']` site in the repository.
   - **A guard the plan asked for and 5.7 never added.** "Test first" point 1 requires a name-set guard for
     `world.js`, `room-connection.js`, `client.js` and the entry module; only the *folder* barrels had one,
     and `barrels.test.ts` matched nothing for `client`. `CLIENT_SURFACE` is now pinned against
     `../src/client.js` directly (7 values); the root-surface case alone would not do, because it reads
     `src/index.ts`, which re-exports these names: a name dropped from both places would take two failures
     to spot, and the type re-exports have no runtime evidence at all.
   - **5.7e's own extraction exposed a guard whose predicate was a shape, not its claim.**
     `render-owner.test.ts`'s *"warn-once has one implementation and three callers"* matched
     `/new Set<string>()/` as a proxy for the memo, and failed on `render/facade.ts`'s cinematic-claim
     refcount (`const owners = new Set<string>()`). That failure was correct in that the guard noticed a new
     `Set<string>` under `render/`, and wrongly, in that the new one is not a warn-once. The proxy was
     replaced by the implementation's actual identity (`function createWarnOnce(`, the same form the two
     neighbouring predicate guards use), and the "three callers" half of the test's name, which nothing
     asserted, is now pinned too. An inline re-implementation is still caught, by the adjacent
     `console.warn(` guard. This is the second guard in the programme found to be answering a question
     other than the one it claims (see item 7), and both were found by *using* them.
