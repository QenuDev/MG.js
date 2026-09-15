# xcut/unused+api-surface: dead code and public API surface

Scope: whole repo (`packages/*/src`, `packages/*/tests`, `scripts`). Method: enumerated every `export`
declaration under `src`, resolved each package's real public surface by walking the `exports` map entries
(`packages/*/package.json`) through the emitted `dist/**/*.d.ts`, then grepped every name across
`src`, `tests`, `scripts`, `README.md` and `docs`. Counts below are word-boundary matches outside the
declaring file and outside barrels.

Surface sizes: `@mg.js/common` 252 public names, `@mg.js/headless` 64, `@mg.js/bootstrapped` 232.

---

## Resolution: what happened to each finding (added after execution; read this before planning from the findings)

This report is kept as evidence, so its findings are left exactly as written. None of them is open. Every line
number below is the audit's, and it is stale: Phases 3-6 moved and renamed most of the files it names, so
re-derive from the tree rather than trusting an anchor here.

| § | Finding | Outcome |
|---|---|---|
| 1 | `formFallback` stored and never observed | **Fixed by deletion**, Phase 6 batch 4. `FormFallback`, `FormRegistryOptions.formFallback`, `setFormFallback` and the private `isFallbackEnabled` are gone. The audit's own first-choice fix was to *give the switch a real state*; the reason that was not taken is measured rather than preferred: `isFallbackEnabled` returned a constant `false`, so the only branch reading the fallback was unreachable and `'strict'` had no consumer, and the method's JSDoc documented the no-op as intended, which makes deletion the honest disposition rather than a loss of capability. The test that kept it alive (`common/tests/forms.test.ts`, which passed `formFallback: 'wrap'` and asserted nothing about it) was rewritten to assert what it actually checked, plus the live `setActionForm` opt-in. |
| 2 | `state/paths.ts`: 14 of 18 symbols have no consumer, and the module has no test | **Fixed name by name**, Phase 6 batch 6. Eight deleted (`signatureOf`, `slotGarden`, `slotInventory`, `playerCoins`, `ACTIVITY_ACTION_FIELD`, `ACTIVITY_PET_PATH`, `PLAYER_DISCORD_ID_FIELD`, `PLAYER_DISCORD_ID_FIELD_LEGACY`), ten kept, and `packages/common/tests/state/paths.test.ts` now pins each survivor against the field guide's literal. **One correction to this report's own reading:** "Only `player`, `activityLogs`, `playerCount` and `findPlayerIndex` are called" is true only of *tests*: `common/tests/store.test.ts` is their sole consumer, and in `src` all 18 were dead. `signatureOf` was the strongest deletion: it implemented the string-signature diffing `state/store.ts` opens by rejecting, since this library receives a patch stream and never polls. |
| 3 | `asEnvelope` implemented twice | **Already fixed before this report's phase ran**, Phase 3.3, (landed early, closing Task 1.3 Step 3). One home at `coexistence/envelope.ts`, re-exported by `client.ts`. The `getGraphicsCtor` half of the section was closed by Phase 3.7c, and the now-purposeless alias it left behind (`getSpriteGraphicsCtor`) was deleted in Phase 6 batch 5. |
| 4 | Two exported functions have no caller and are in no barrel | **Fixed by deletion**, Phase 6 batch 1: `hasCapturedGet` and `emptyCatalogSource` are gone. `hasCapturedGet` was indeed in no barrel, so it was reachable only by deep import. |
| 5 | `Unsubscribe` declared twice in `@mg.js/common` | **Already fixed before this report's phase ran**, Phase 3.1. One declaration in `common/src/unsubscribe.ts`; `state/store.ts` and `transport/seam.ts` import it, and both barrels re-export it. |

Two things this report could not have known, recorded so the same work is not queued twice: the eight
`state/paths.ts` deletions plus the four other Phase 6 removals are pinned by
`packages/headless/tests/integration/removed-surface.test.ts`, so re-adding one fails a test by name; and the
frozen root snapshot in `common/tests/symbol-parity.test.ts` went from 133 names to 125 to match.

---

## 1. `FormRegistry`'s form-fallback control is inert: `formFallback` is stored and never observed

- **Severity:** medium · **Category:** correctness · **Breaking:** no
- **Evidence:** `packages/common/src/protocol/forms.ts:528-530` declares
  `private isFallbackEnabled(_name: string): boolean { return false; }`, where the parameter is ignored and the
  return is a constant. The only place `this.fallback` is ever read is `forms.ts:496`, inside `formOf`:
  `if (spec.form === 'flat' && this.fallback === 'wrap' && this.isFallbackEnabled(name))`. Because the third
  conjunct is always `false`, that branch is unreachable and `this.fallback` cannot affect any result.
  `FormRegistryOptions.formFallback` (`forms.ts:468`) is written at `487`, and the public
  `setFormFallback(fallback: FormFallback): void` (`forms.ts:515`) writes the same field. A repo-wide grep
  for `formFallback|isFallbackEnabled` returns only `forms.ts` plus
  `packages/common/tests/forms.test.ts:121`, which asserts that
  `new FormRegistry({ formFallback: 'wrap' }).formOf('Ping') === 'flat'`, i.e. the test codifies the no-op.
- **Why it matters:** `setFormFallback` is documented at `forms.ts:514` as "Set the fallback policy for
  `flat` actions", and the guide's recovery for an action that starts silently failing is exactly "try
  wrapping it". The JSDoc at `forms.ts:519-527` promises a caller can "turn this on" and puts that promise in
  terms of enabling it on purpose, and no public API exists that does. So an option and a public setter accept values, validate nothing, and change
  nothing: the documented escape hatch for silent action failures is unreachable.
- **Fix:** give the switch a real state. In `packages/common/src/protocol/forms.ts` add
  `private fallbackEnabled = false;`, change `setFormFallback(fallback: FormFallback): void` to set
  `this.fallback = fallback; this.fallbackEnabled = fallback === 'wrap';`, and make
  `private isFallbackEnabled(name: ActionName | string): boolean` return `this.fallbackEnabled`. If the
  recovery is not wanted at all, delete `formFallback` (`468`), `setFormFallback` (`515`) and
  `isFallbackEnabled` (`528`) rather than shipping a control with no effect. Either way `formOf` should stop
  evaluating a permanently-false conjunct.

## 2. `state/paths.ts`: 14 of 18 exported symbols have no consumer, and the module has no test

- **Severity:** medium · **Category:** unused-code · **Breaking:** yes
- **Evidence:** for each name exported by `packages/common/src/state/paths.ts`,
  `grep -rnE "\bNAME\b" packages scripts --include=*.ts` (excluding `paths.ts`) returns **0** for
  `ROOM_ROOT` (`:15`), `GAME_ROOT` (`:18`), `PLAYERS` (`:21`), `PLAYER_DISCORD_ID_FIELD` (`:29`),
  `PLAYER_DISCORD_ID_FIELD_LEGACY` (`:30`), `HOST_PLAYER_ID` (`:33`), `CHAT` (`:36`), `playerCoins` (`:39`),
  `USER_SLOTS` (`:49`), `ACTIVITY_ACTION_FIELD` (`:62`), `ACTIVITY_PET_PATH` (`:65`), `slotGarden` (`:68`),
  `slotInventory` (`:73`) and `signatureOf` (`:78`). Only `player` (`:44`), `activityLogs` (`:57`),
  `playerCount` (`:94`) and `findPlayerIndex` (`:105`) are called. All 18 are public: `state/index.ts:24`
  does `export * from './paths.js'` and `index.ts:17` re-exports that barrel. There is no
  `packages/common/tests/paths.test.ts` (`tests/` holds catalog, client, connect-url, envelope, forms,
  patch, sequencer, store, weather only), and the docs do not use the helpers either. `README.md:119`
  hand-writes `client.store.get('/data/players/0/coins')` and `README.md:140` hand-writes
  `client.store.subscribe('/child/data/userSlots/0/data/activityLogs', ...)`, which are the exact strings that
  `playerCoins(0)` and `activityLogs(0)` produce.
- **Why it matters:** fourteen exported names are public maintenance surface with zero coverage and zero
  dogfooding. The documentation that motivated them writes the raw strings instead. `signatureOf` (`:78`)
  is not a path helper at all ("a stable signature for a value, for cheap change detection on large
  arrays") and nothing calls it; `store.ts:7-14` records that string-signature diffing was explicitly
  rejected in favour of patch operations, which makes `signatureOf` vestigial from a design that was not
  adopted.
- **Fix:** either adopt or drop. Adoption: keep `ROOM_ROOT`/`GAME_ROOT`/`PLAYERS`/`USER_SLOTS`/`CHAT`/
  `HOST_PLAYER_ID` and add `packages/common/tests/paths.test.ts` asserting
  `playerCoins(0) === '/data/players/0/coins'` and `activityLogs(0) === '/child/data/userSlots/0/data/activityLogs'`,
  then use them at `README.md:119` and `README.md:140`. Removal (the pre-1.0 shape): delete
  `signatureOf` (`:78`), `slotGarden` (`:68`), `slotInventory` (`:73`), `playerCoins` (`:39`),
  `ACTIVITY_ACTION_FIELD` (`:62`), `ACTIVITY_PET_PATH` (`:65`) and the two `PLAYER_DISCORD_ID_FIELD*`
  constants, which nothing in the repo consumes.

## 3. `asEnvelope` is implemented twice with identical behaviour; both copies are published under different names

- **Severity:** medium · **Category:** duplication · **Breaking:** no
- **Evidence:** `packages/bootstrapped/src/client.ts:942-946` and
  `packages/bootstrapped/src/coexistence/renumber.ts:437-442` are two separate `export function asEnvelope`
  implementations with the same predicate (non-null object, not an array, `record['type'] === 'QuinoaCommand'`)
  and the same return. Both reach consumers through the package barrel:
  `packages/bootstrapped/src/index.ts:48` exports the `client.ts` one as `asEnvelope`, and
  `packages/bootstrapped/src/index.ts:162` exports the `renumber.ts` one as `asEnvelope as asCommandEnvelope`.
  The same barrel repeats the pattern for `getGraphicsCtor`: `render/ctors.ts:771`
  `getGraphicsCtor(stage: unknown)` is exported at `index.ts:191`, while `render/sprite.ts:310`
  `getGraphicsCtor()` (different arity, delegates to `PixiStage`) is exported at `index.ts:252` as
  `getSpriteGraphicsCtor`.
- **Why it matters:** two identical predicates on the outbound-frame path will drift, and a reader of the
  published `dist/index.d.ts` sees two same-named functions whose only distinguishing information is a
  barrel alias, and that alias is the exact ambiguity it was added to paper over. `client.ts` already imports
  `Renumberer` and `CommandEnvelope` from `coexistence/renumber.js` (`client.ts:79-80`), so there is no
  dependency reason for the copy.
- **Fix:** keep one implementation. In `packages/bootstrapped/src/coexistence/renumber.ts:437` retain
  `export function asEnvelope(frame: unknown): CommandEnvelope | null`, delete `client.ts:942-946` and add
  `import { asEnvelope } from './coexistence/renumber.js';`, then change `index.ts:48` to source the name
  from `./coexistence/renumber.js` and drop the `asCommandEnvelope` alias. For the other pair, rename
  `packages/bootstrapped/src/render/sprite.ts:310` to
  `export function getGraphicsCtorFromStage(): (new (...args: unknown[]) => PixiGraphics) | null` and delete
  the `getSpriteGraphicsCtor` alias at `index.ts:252`.

## 4. Two exported functions have no caller anywhere and are not part of any public barrel

- **Severity:** low · **Category:** unused-code · **Breaking:** no
- **Evidence:** `packages/bootstrapped/src/jotai/bridge.ts:161`
  `export function hasCapturedGet(): boolean { return capturedGet !== null; }`. A grep for `hasCapturedGet`
  over `packages` and `scripts` returns that declaration line only. Its siblings `hasCapturedSet` and
  `getCapturedSet` are published at `index.ts:308`/`:307`; `hasCapturedGet` is not, so it is neither API nor
  used internally. `packages/bootstrapped/src/client.ts:988`
  `export function emptyCatalogSource(): CatalogSource`, whose own JSDoc says "A catalogue source the client
  can hand to `CatalogClient` when nothing live was recovered", but grep returns only the declaration, and
  `index.ts:48` lists the `client.js` names to re-export and omits it.
- **Why it matters:** both are dead code with no test, no caller and no published name. They read as
  supported helpers, so they will be copied, maintained and eventually relied on; `emptyCatalogSource` is
  also a claim about client behaviour ("the client can hand") that no code path implements.
- **Fix:** delete both functions. If `hasCapturedGet` is wanted as API, publish it beside
  `hasCapturedSet` in `packages/bootstrapped/src/index.ts` (`export { hasCapturedGet, ... } from './jotai/bridge.js';`)
  and add a case to `packages/bootstrapped/tests/` that drives a write and asserts it flips to `true`.

## 5. `Unsubscribe` is declared twice inside `@mg.js/common`

- **Severity:** low · **Category:** consistency · **Breaking:** no
- **Evidence:** `packages/common/src/state/store.ts:24` and `packages/common/src/transport/types.ts:15` both
  declare `export type Unsubscribe = () => void;`. `client.ts:39` imports the `state/store.js` copy;
  `transport/index.ts:10` publishes the `transport/types.js` copy. `state/index.ts:19-20` documents the
  collision as the reason it refuses to re-export the name at all: "`./transport/index.js` exports the same
  shape, and the package barrel re-exports both".
- **Why it matters:** one contract has two sources of truth in one package. Widening the detach contract
  (e.g. to `() => void | Promise<void>`) in one file silently leaves `Transport.onMessage` and
  `ObservableStore.subscribe` describing different things, and the public barrel has already been shaped
  around the ambiguity instead of resolving it.
- **Fix:** declare it once. In `packages/common/src/transport/types.ts:15` keep
  `export type Unsubscribe = () => void;` (that module is a leaf: it has no imports) and in
  `packages/common/src/state/store.ts:24` replace the declaration with
  `export type { Unsubscribe } from '../transport/types.js';`. Both existing barrels keep exporting the same
  single symbol; `state/index.ts:19-20` can then re-export it without ambiguity.

---

## What works well here

- Every package barrel is an explicit named re-export list with per-group comments; there is no wildcard
  leakage from internal modules and no deep-import path exists in the `exports` maps.
- `@mg.js/headless`, `@mg.js/bootstrapped` and `@mg.js/common` do not export overlapping protocol
  vocabulary: each keeps a single source of truth, and the userscript entry (`src/userscript.ts:299`)
  actually invokes its own entry point rather than shipping a do-nothing bundle.
- `emptyCatalogSource`'s and `hasCapturedGet`'s siblings (`hasCapturedSet`, `getCapturedSet`) are all used
  or published, so the dead exports are isolated rather than symptomatic.
- `@mg.js/common` has zero runtime dependencies and no `node:` import (`grep -rn "from 'node:"`
  over `packages/common/src` returns nothing); `ws` is reached only through a guarded dynamic
  `import('ws')` at `packages/headless/src/transport/runtime.ts:198`.
- `close-codes.ts`'s nine deprecated aliases are not dead weight: `AuthFailed` is used in
  `packages/common/src/errors.ts:58` and `Superseded`/`SupersededByNewerSession` in
  `packages/headless/tests/backoff.test.ts:97,112`.
