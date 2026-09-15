# Phase 4 execution plan: One client contract (invariants I6, I7, I8)

> Written against the phase close (Phase 3's last commit). Every `file:line` below was taken with
> `grep -n` / `sed -n` / `wc -l` against the working tree, **never** with the `read` tool, which has
> served stale indexed content in this repo. If a citation looks one revision short, `wc -l` the file
> before believing it.
>
> **Concurrent writer warning.** While this plan was being written, another agent was editing
> `docs/plans/2026-09-13-code-consistency.md`, `docs/plans/2026-09-13-phase-2-wire-hardening.md`,
> `docs/plans/2026-09-13-phase-3-one-home-per-helper.md`, `packages/common/src/protocol/sequencer.ts`,
> `packages/common/tests/sequencer.test.ts` and `packages/bootstrapped/tests/coexistence.test.ts` in
> the same working tree. The master plan's `### Phase 4` heading ("One client contract") was at
> `:719` when this plan was scoped and at `:752` when it was finished. **Re-locate every plan-document
> citation by heading or quoted text, not by line number.** All source citations below were verified
> against files that writer is not touching; none of them cites `sequencer.ts` or `coexistence.test.ts`.

**Goal.** Make the four client-shaped classes (`ClientCore`, `HeadlessClient`, `BootstrappedClient`,
`RoomSocket`) one contract, as `docs/DESIGN.md:123-170` (§3.2) specifies: one verb pair
(`start`/`stop`), one lifecycle event namespace with one payload shape, one identity accessor that is
`string | null` and never a placeholder, and one JSON-safe diagnostic surface (`report: ClientReport`).
Then pay the three debts the earlier phases deferred here and the five verified defects the audit
found in the same code.

**Invariants served.**

- **I6: identity is a resolved value, never a placeholder.** `RoomSocket.playerId` returns `''`
  before the first `Welcome` (`headless/src/room-socket.ts:260-262`) where `null` is the honest
  answer; `ClientCore.welcome` survives a close while `selfPlayerId` is cleared
  (`common/src/client.ts:221` vs `:611`, cleared nowhere); `ClientReport.selfPlayerId` is the single
  identity surface.
- **I7: the userscript fails safe.** `install()`/`uninstall()` become `start()`/`stop()` on an async
  seam, so the userscript's synchronous `try/catch` (`bootstrapped/src/userscript.ts:189-194`) must
  move onto a promise; `stop()` must be total and never throw.
- **I8: a gate must be able to fail.** `common/tests/client.test.ts:673` asserts `a > a`, which is
  always `false`; `GameActions.ping`'s branch has no test and cannot succeed; the catalog's only
  production wiring passes no `onSourceError`, so a failure leaves no trace anywhere. Each is closed
  by a test that fails first.

**Ordering rationale.** The constraint between tasks is **shared files**, not concepts.
`common/src/client.ts` is edited by 4.2, 4.2b, 4.2c and 4.2d; `common/src/index.ts` by 4.1, 4.6 and
4.2; `headless/src/client.ts` by 4.2b, 4.3 and 4.5; `bootstrapped/src/client.ts` by 4.4 and 4.5;
`headless/src/reconnect.ts` by 4.5 only. So the order below never has two consecutive tasks on one
file, and no task starts on a file another task has left dirty.

| # | Task | Files it owns | Why here |
|---|---|---|---|
| 1 | **4.0** | `common/src/state/store.ts` | The only task on `store.ts`. Must precede 4.6, which gives its two rejections a named class. |
| 2 | **4.1** | `common/src/client-contract.ts` (new), `common/src/version.ts` (new), `common/src/index.ts` | Types only, no behaviour change. Everything else imports it. |
| 3 | **4.6** | `common/src/errors.ts`, `headless/src/errors.ts`, `common/src/protocol/{forms,envelope}.ts`, `common/src/catalog/{source,types}.ts`, both `index.ts` | **Moved ahead of the adoption tasks** (the master plan puts it last). `ClientReport.errors` is typed by `MgErrorSummary` (4.1) and populated by the adopters (4.2 through 4.4), and `stop()` must record typed errors rather than throw; defining the hierarchy first avoids a second pass over the same three client files. |
| 4 | **4.2** | `common/src/client.ts` + its callers | The core's verb pair must be settled before the two wrappers forward it. |
| 5 | **4.2b** | `common/src/client.ts` | Audit 03 F1, verified high. Serializes behind 4.2 because it is the same file. |
| 6 | **4.2c** | `common/src/client.ts` | Audit 03 F2 + F8. Same file again, for the same reason. |
| 7 | **4.2d** | `common/src/client.ts` | Audit 03 F7, I6. Last core-only commit, so `common/src/client.ts` is frozen when 4.3 starts. |
| 8 | **4.3** | `headless/src/client.ts`, `headless/src/room-socket.ts` | Needs a final core (4.2 through 4.2d) and the error hierarchy (4.6). |
| 9 | **4.4** | `bootstrapped/src/client.ts`, `bootstrapped/src/userscript.ts` | Independent of 4.3 (the two packages never import each other); after 4.6 for `report.errors`, after 4.2 for the core's verbs. |
| 10 | **4.5** | `bootstrapped/src/client.ts`, `headless/src/client.ts`, `common/src/protocol/types.ts`, `headless/src/reconnect.ts` | Last: it rewrites the option reads inside the two constructors that 4.3 and 4.4 just rewrote, and it changes the meaning of the attempt counter that 4.3's `report` publishes. |

**Independent and reorderable:** 4.0 and 4.1 touch disjoint files and may land in either order.
4.3 and 4.4 are file-disjoint and may land in either order (4.3 first only because it is smaller).

---

## Global constraints

Copied in force from the master plan's **Global constraints** section
(`docs/plans/2026-09-13-code-consistency.md`, under the heading of that name) and not
repeated per task:

- **NodeNext ESM.** Relative imports in `src` always end in `.js`. Tests import `../src/foo.js`
  (`common`, `headless`) or `../src/foo.ts` (`bootstrapped`); `tsconfig.tests.json` sets
  `allowImportingTsExtensions`.
- **`common` stays platform-free**: `"lib": ["ES2022"]`, `"types": []`, zero runtime dependencies, no
  `node:*`, no DOM globals, no `ws`, no global `fetch`. `headless` and `bootstrapped` never import
  each other, directly or through `packages/*/src` paths.
- **The userscript stays one self-contained file**: no external imports, no `eval`, no second output
  chunk. `npm run build` proves it; `npm run size` is the only gate that sees it.
- **`strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters` stay on** for source
  *and* tests. `tsc -b --force` and `tsc -p tsconfig.tests.json` both exit 0.
- **Banned everywhere, including tests:** `any`, `as any`, `@ts-ignore`, `@ts-expect-error`, non-null
  `!`. Biome is `check .` with `lineWidth: 110` and `includes: ["**", "!docs"]`, so this file is not
  linted but every file it names is.
- **Test-first is mandatory and the failure must be observed** before the fix. Record the failing
  assertion's output in the commit body or in `.logs/`.
- **One commit per task.** Behaviour changes need a test that failed before and passes after; pure
  refactors need the existing suite green and the public surface identical unless the task says
  otherwise.
- **Breaking changes are allowed (pre-1.0) and each one is named in the commit body.** This phase is
  almost entirely breaking, which is intended.
- **Commit style** matches the log: `refactor(common): ...`, `fix(headless): ...`, `feat(common): ...`, with
  a body that names the surface change.

**Baseline at the time of writing.** At the phase close, `npm run verify` green: **736 tests**
(bootstrapped 181, common 386, headless 169), bundle **291.3 KiB (298 255 B)**, within budget. The
last recorded full run is `.logs/verify-final.log` (`# tests 180 / 386 / 169`); 3.8 added
one bootstrapped test, which is the 181. Re-run `npm run verify` before Task 4.0 and use *that*
number if it differs.

**Working-tree state.** Clean. Phase 4 has not started; nothing below is implemented. `.logs/` is
untracked and gitignored.

---

## Task 4.0: `waitFor` releases its subscription when the predicate throws (deferral, I5)

### Problem

`ObservableStore.waitFor` (`common/src/state/store.ts:233-269`) is the primitive both clients build
readiness waits on. `finish()` is the *only* thing that unsubscribes:

```ts
245:      const finish = (fn: () => void): void => {
246:        unsubscribe();
247:        if (timer !== null) clearTimeout(timer);
248:        options.signal?.removeEventListener('abort', onAbort);
249:        fn();
250:      };
...
254:      unsubscribe = this.subscribe(path, (change) => {
255:        if (predicate(change.value)) finish(() => resolve(change.value as T));
256:      });
```

A caller's `predicate` that throws propagates out of the subscription handler, where `deliver`
(`:308-311`) catches it and says nothing:

```ts
308:  private deliver(subscription: Subscription, change: StateChange): void {
309:    try {
310:      subscription.handler(change);
311:    } catch {
```

So `finish` never runs: the subscription is never removed from `this.subscriptions` and, with no
`timeoutMs`, the returned promise never settles at all. With a `timeoutMs` the timer still fires and
rejects, so the entry is released, but only after the full timeout, and the rejection names a
timeout that did not happen. `abort` listeners leak the same way. This is the recorded F13
(`docs/DESIGN.md:519-521`, the phase-2 plan's **F13**, `.logs/ledger.md:106-107`).

There is a second, smaller half: `:238-239` calls the predicate **before** the promise exists:

```ts
238:    const existing = this.get(path);
239:    if (predicate(existing)) return Promise.resolve(existing as T);
```

A throwing predicate here escapes synchronously out of a method whose declared return type is
`Promise<T>`, so `waitFor(...).catch(handler)` never runs the handler.

### Change

1. `common/src/state/store.ts:239`: move the first predicate call inside a `try` and return a
   rejected promise: `catch (error) { return Promise.reject(error); }`.
2. `:254-256`: evaluate the predicate in `try/catch` inside the handler and finish before rethrowing
   nothing. Exactly:

```ts
unsubscribe = this.subscribe(path, (change) => {
  let satisfied: boolean;
  try {
    satisfied = predicate(change.value);
  } catch (error) {
    finish(() => reject(error));
    return;
  }
  if (satisfied) finish(() => resolve(change.value as T));
});
```

No new export, no new constant, no signature change. The rejections stay bare `Error`s in this
commit; Task 4.6 types them.

### Test first

`packages/common/tests/store.test.ts`, in the existing `waitFor` describe block
(`:237`), two new cases:

- `'releases its subscription when the predicate throws'`: subscribe a counting handler first, then
  call `waitFor(path, () => { throw new Error('bad predicate'); })`, trigger a patch at that path,
  and assert the returned promise rejects with `'bad predicate'` **and**
  `store.stats.subscribers` is back to 1 (the counter subscriber) rather than 2.
- `'rejects rather than throwing when the predicate throws on the first read'`: call
  `waitFor('/nope', () => { throw new Error('bad predicate'); })` inside
  `await assert.rejects(...)`, i.e. prove it does not throw synchronously.

**Failure mode before the fix.** The first test hangs (no rejection without a timeout) and
`store.stats.subscribers` reads 2; the second throws out of the call and `assert.rejects` never gets a
promise. Neighbouring existing case `'removes its subscription after resolving, so it does not leak'`
(`:259`) shows the intended shape.

### Acceptance

Both tests pass; `store.test.ts`'s existing five `waitFor` cases stay green; `npm run verify` exit 0.

### Risk / revert

Low. The only behavioural widening is that a throwing predicate now rejects instead of hanging, which is
strictly more informative, and `store.test.ts:183` (`'keeps working when a subscriber throws'`) proves
a throwing *subscriber* still cannot break the store, which this does not touch. Revert is the single
commit; no facade.

---

## Task 4.1: Define `MgClient`, `ClientReport` and `MgErrorSummary`

### Problem

The four client classes share no interface. Concretely, at HEAD:

| axis | `ClientCore` | `HeadlessClient` | `BootstrappedClient` | `RoomSocket` |
|---|---|---|---|---|
| start | n/a (constructor attaches) | `connect()` `:638` | `install(): this` `:364` | `connect()` `:151` |
| stop | `dispose()` `:229` | `disconnect()` `:677`, `destroy()` `:711` | `uninstall()` `:642` | `disconnect()` `:207`, `destroy()` `:237` |
| ready | `isReady` `:255` | `isReady` `:431` | `isReady` `:304`, `ready(): Promise<Attachment>` `:447` | `isReady` `:294` |
| identity | `selfPlayerId: string \| null` `:260` | `selfPlayerId: string \| null` `:426` | `selfPlayerId: string \| null` `:295` | `playerId: string` (**`''`**) `:260` |
| diagnostics | `stats` (typed) `:285` | `stats: Record<string, unknown>` `:558` | `report(): BootstrapReport` `:811` | `stats: Record<string, unknown>` `:309` |
| events | `extends Emitter<ClientEvents>` `:150` | `extends Emitter<HeadlessClientEvents>` `:280` | **none** | `on*` methods `:349-470` |

`ClientReport`, `MgErrorSummary`, `MgClient` and `MgTransportError` do not exist anywhere in
`packages/*/src`. `MgConfigError` exists only in `headless/src/errors.ts:19` as a **second hierarchy
root** (`extends Error`, not `MgError`).

### Change

New file `packages/common/src/client-contract.ts` exporting exactly:

```ts
export interface MgErrorSummary {
  readonly name: string;    // 'MgProtocolError'
  readonly code: string;    // error.code
  readonly message: string; // redacted by the producer, see 4.6
}

export type ClientKind = 'common' | 'headless' | 'bootstrapped';

export interface ClientReport {
  readonly kind: ClientKind;
  readonly started: boolean;
  readonly ready: boolean;
  /** Bootstrapped only: the attachment kind. `null` elsewhere and before the first attempt. */
  readonly attachment: string | null;
  readonly socketsSeen: number;
  readonly renumbering: boolean;
  readonly errors: readonly MgErrorSummary[];
  readonly version: string;
}

export interface ClientCloseEvent { readonly info: TransportCloseInfo }

export type MgClientEvents = {
  open: [];
  ready: [];
  close: [ClientCloseEvent];
};

export interface MgClient<TEvents extends MgClientEvents> {
  start(): Promise<void>;
  stop(reason?: string): Promise<void>;
  readonly events: Emitter<TEvents>;
  readonly isReady: boolean;
  readonly selfPlayerId: string | null;
  readonly lastError: MgError | null;
  readonly report: ClientReport;
}

/** `unknown` in, JSON-safe summary out. Never throws; never copies a credential. */
export function summarizeError(error: unknown): MgErrorSummary;
```

`summarizeError` reads `name`/`code`/`message` defensively (`error instanceof Error` first, then
`typeof (error as { code?: unknown }).code === 'string'`), falls back to
`{ name: 'Error', code: 'unknown', message: String(error) }`, and passes `message` through
`redactCredentialString` from `common/src/redact.ts`, because a summary is by definition a thing that gets
printed (I3).

New file `packages/common/src/version.ts` exporting `export const MG_VERSION = '0.1.0';` and
`packages/bootstrapped/src/realm.ts:55` becomes
`export const BUNDLE_VERSION = MG_VERSION;`: same name, same value, one home for the number Phase 8.4
will move.

`packages/common/src/index.ts` gains `export * from './client-contract.js';` and
`export { MG_VERSION } from './version.js';`.

**Documented divergences from DESIGN.** `docs/DESIGN.md:129` says the file is
`common/src/client/contract.ts`; `docs/DESIGN.md:216-275`'s target tree keeps `client.ts` bare and
lists no `client/` folder, and `docs/DESIGN.md:191-194`'s folder rule forbids a one-module folder. The
tree and the rule win: `common/src/client-contract.ts`. Record it in the commit body and, if the human
prefers, add a one-line correction to §3.2 in Phase 8.

`ClientCloseEvent` is a **wrapper** (`{ info }`), not `TransportCloseInfo` itself, because
`Common/src/client.ts:223` currently emits the bare info while `headless/src/client.ts:998` emits
`{ info, analysis, willReconnect }`. Wrapping the core's payload is what makes
`HeadlessCloseEvent extends ClientCloseEvent` possible (4.3) so the two clients' `close` shapes are
one shape with extra fields, per §3.2's "a platform client adds events, never renames them".

### Test first

New `packages/common/tests/client-contract.test.ts`:

- `'summarizeError is total and JSON-safe'`: feeds `new MgProtocolError('x')`, `new TypeError('t')`,
  `'a string'`, `null`, and `{ code: 42 }`, and asserts every result is
  `JSON.parse(JSON.stringify(result))`-equal to itself and has three string fields.
- `'summarizeError redacts a credential'`: `new MgError('Cookie: mc_jwt=SECRET.JWT.VALUE', 'x')` in,
  a summary whose `message` does not contain `SECRET.JWT.VALUE` out.
- `'MG_VERSION and BUNDLE_VERSION are the same string'`: `assert.equal(BUNDLE_VERSION, MG_VERSION)`
  in `packages/bootstrapped/tests/client-lifecycle.test.ts` (the cross-package identity assertion is
  the one that cannot be faked by a restated literal).

**Failure mode before the fix.** The file does not exist, so `tsc -p tsconfig.tests.json` fails to
resolve `../src/client-contract.js`; the `summarizeError` cases fail to compile. There is no
runtime-failing test in this task because it adds no behaviour. That is intended, and the task's
acceptance is compilation plus those three cases.

### Acceptance

`npm run typecheck` exit 0; `npm run build` exit 0; `npm test -w @mg.js/common` reports 386 + 2 and
`npm test -w @mg.js/bootstrapped` reports 181 + 1; `npm run verify` exit 0.

### Risk / revert

Near zero: additive only, nothing implements `MgClient` yet. The one real risk is the `BUNDLE_VERSION`
re-export creating a `common` → `bootstrapped` import; it is the other direction (`bootstrapped`
imports `common`) and is already the case everywhere. Revert is the commit.

---

## Task 4.6: One error hierarchy, and nothing swallows (moved before adoption)

### Problem

`common/src/errors.ts:4-6` promises "Every failure this package can produce is a named class, so
callers can branch on type rather than on message text". Four things falsify it:

1. **A second hierarchy root.** `headless/src/errors.ts:19` declares
   `export class MgConfigError extends Error` with its own `code` and default
   `'config_invalid_token'`. `isMgError` (`common/src/errors.ts:144`) returns `false` for it. Its own
   header (`:15-17`) says it is there only because "the common taxonomy has no `MgConfigError` yet".
2. **`MgTransportError` does not exist.** Transport and HTTP failures are bare `Error`s; `03`'s F6
   notes that a caller's mistake (unknown action, `forms.ts:441`) and a dead socket are
   indistinguishable by type.
3. **Client faults are bare.** `HeadlessClient.requireCore` (`headless/src/client.ts:1265-1267`)
   throws `new Error(...)` for the condition `MgNotReadyError` (`errors.ts:130`) exists for;
   `buildFrame` throws bare for a bad sequence (`common/src/protocol/envelope.ts:118-123`).
4. **The catalog's only production wiring loses its failures.** `source.ts:169-171` is
   `this.onSourceError?.(source.id, kind, error)`, and the single real consumer
   (`bootstrapped/src/client.ts:407`, `new CatalogClient({ sources })`) passes no callback, so with
   every endpoint down `catalog.missing` is all 11 kinds and nothing anywhere records why, cached for
   the full 300 s TTL. `DomainCatalog` (`catalog/types.ts:174-192`) has `missing` and `provenance` but
   no `errors`.

### Change

`packages/common/src/errors.ts`:

- Add `export type MgErrorDisposition = 'fatal' | 'retry' | 'ignore';` and give `MgError` a third
  constructor argument `disposition: MgErrorDisposition = 'fatal'` stored as
  `readonly disposition`. Positional, so `new MgError(msg, code)` keeps working.
- Add `export class MgTransportError extends MgError` with `readonly kind: 'socket' | 'http'` and a
  default disposition of `'retry'`; `code` defaults to `'transport_failure'`.
- Add `export class MgConfigError extends MgError`, `code` defaulting to `'config_invalid'`,
  disposition `'fatal'`, and **keep headless's `'config_invalid_token'` as an accepted explicit
  code** so `auth/cookie.ts:188-196` keeps its stable string.
- `MgProtocolError` keeps its name and `'protocol_error'` code; add `disposition: 'ignore'` as its
  default, because a frame this package cannot parse is explicitly non-fatal
  (`common/src/client.ts:68-70`'s `unparsed` doc).
- Add `export function toMgError(value: unknown, fallbackCode: string): MgError` for the two bare
  throw sites, so the message is preserved and the type is branchable.

`packages/headless/src/errors.ts`: delete the class, replace the file body with
`export { MgConfigError } from '@mg.js/common';` (an explicit re-export, not a re-declaration, so the
identity `isMgError(new MgConfigError('x')) === true` is assertable). Keep
`packages/headless/src/index.ts:48`'s export line unchanged so the public name does not move.

Throw-site conversion, all inside `common`:

- `common/src/protocol/forms.ts:441`: `throw new MgProtocolError(\`Unknown action "${name}"...\`)`.
- `common/src/protocol/envelope.ts:119-122`: `throw new MgProtocolError(...)`.
- `headless/src/client.ts:1267`: `throw new MgNotReadyError(\`Cannot use "${what}" before start()...\`)`.
- `common/src/state/store.ts:252,260` (Task 4.0's rejections): `MgTransportError` for the timeout,
  `MgConfigError` for the abort, since an aborted wait is a caller decision, not a transport fault.
- `common/src/state/pointer.ts:21`: `throw new MgProtocolError(...)` so `applyPatch`'s one remaining
  throw is branchable (`02`'s F2).

Never-swallow, `common`:

- `CatalogClientOptions` gains `onSourceError` **required**. Breaking, and named in the commit body.
- `DomainCatalog` gains `readonly errors: Partial<Record<CatalogKind, MgErrorSummary>>`; `loadAll`
  records `summarizeError(error)` in its `catch` (`source.ts:169-171`) alongside the callback, so the
  failure survives even with no callback. `emptyCatalog()` (`catalog/types.ts:195`) gains `errors: {}`.
- `bootstrapped/src/client.ts:407` passes
  `onSourceError: (sourceId, kind, error) => this.logger.warn('catalog source failed', { sourceId, kind, error: summarizeError(error) })`.

### Test first

New `packages/common/tests/errors.test.ts`:

- `'MgConfigError from headless is an MgError'`: `assert.equal(isMgError(new MgConfigError('x')), true)`
  and `assert.equal(new MgConfigError('x').disposition, 'fatal')`.
- `'isMgError branches a caller mistake from a dead socket'`: `getActionSpec('Nope')` throws an
  `MgProtocolError`; `assert.throws(() => getActionSpec('Nope'), MgProtocolError)`.
- `'every MgError subclass carries a disposition'`: construct all ten and assert the field is one of
  the three literals.
- `'summarizeError never prints a credential'`: already in 4.1; keep it passing.

`packages/common/tests/catalog.test.ts` gains:

- `'records a source failure even when no callback is given'`: build a `CatalogClient` whose only
  source throws, `await client.load()`, and assert `catalog.errors.plants?.code === 'source_failure'`
  and `catalog.missing` still contains `'plants'`.

**Failure mode before the fix.** `assert.equal(isMgError(new MgConfigError('x')), true)` fails with
`false` (the class extends `Error`, not `MgError`). The catalog case reads `undefined`. Captured
before/after goes in the commit body.

### Acceptance

`npm run verify` exit 0. `grep -rn "throw new Error" packages/common/src` returns only
`errors.ts`-adjacent internals, not `forms.ts`, `envelope.ts` or `pointer.ts`. `report.errors`
populated in a forced-failure test: add
`packages/headless/tests/client-contract.test.ts` case `'report.errors names why the version could not
be resolved'` using a `ScriptedVersionSource(['MALFORMED'])` and asserting
`client.report.errors.some((e) => e.code === 'version_unavailable')`: this needs 4.1's type and
4.3's `report`, and it is the master plan's own acceptance line; it lands in 4.3 and is listed here so
it is not forgotten.

### Risk / revert

Medium, since this is the phase's widest fan-out. Two specific risks:

- Making `onSourceError` required is a **public breaking change** with three in-repo call sites
  (`bootstrapped/src/client.ts:401`, plus tests). `grep -rn "new CatalogClient" packages` lists them
  all; land them in the same commit.
- Redirecting `headless/src/errors.ts` to a re-export changes `instanceof` behaviour across the
  dual-`common`-copy seam (`headless/src/client.ts:83` resolves `@mg.js/common` from `dist` while
  `scripts/verify-socket.ts:47-49` resolves source). Verify with `npm run verify:socket` before
  committing; if `isMgError` fails there, keep the local class and add
  `Object.setPrototypeOf(MgConfigError.prototype, MgError.prototype)` instead, naming the compromise
  in the commit body.

Revert is the commit. `MgError`'s new third argument is additive, so 4.2/4.3/4.4 do not depend on it.

---

## Task 4.2: `ClientCore` adopts `MgClient`

### Problem

`ClientCore` is the composition root (`common/src/client.ts:150`) and already has `isReady` (`:255`),
`selfPlayerId: string | null` (`:260`), `lastError: unknown` (`:280`) and `stats` (`:285`), but it has
no `start`, its `stop` is called `dispose` (`:229`), its `lastError` is `unknown` where the contract
wants `MgError | null`, its diagnostics are named `stats`, and its `close` payload is the bare
`TransportCloseInfo` (`:223`), which is a different shape from the headless client's.

Its `lastError` assignment is also untyped: `:381` and `:393` both do `this.lastErrorValue = error;`
with `error: unknown`, and nothing converts it. `report.errors` needs the conversion.

`handleWelcome` (`:610-652`) restates `asSequence`'s body:

```ts
622:    let seed: number | null = isCanonicalSequence(frontier) ? frontier : null;
623:    if (seed === null) {
624:      const live = this.getFrontierOption?.();
625:      if (isCanonicalSequence(live)) seed = live;
626:    }
```

Compare `common/src/protocol/codec.ts:201`: `return isCanonicalSequence(value) ? value : null;`. Line
622 is character-equivalent to it and line 625 is the same rule again. Phase 3.5 left it
because its scan matched the *rule's body* (`Number.isInteger(...)`), not this shape.

### Change

`packages/common/src/client.ts`:

1. `ClientEvents` (`:59-92`): `close: [ClientCloseEvent]` instead of `[TransportCloseInfo]`, importing
   the type from `./client-contract.js`; `oversizedFrame`'s long doc comment is unchanged. The emit at
   `:223` becomes `this.emit('close', { info })`. Every `core.on('close', ...)` in the repo is updated in
   this commit: `headless/src/client.ts:922` (`core.on('close', (info) =>` → `({ info }) =>`) and any
   test.
2. `ClientCoreOptions` (`:94-148`) gains `version?: string` (defaults to `MG_VERSION`).
3. Add `private started = false;` and `private stopped = false;`.
4. Replace `dispose(): void` (`:229-248`) with:

```ts
async stop(reason = 'Client stopped.'): Promise<void> { … }   // never throws, idempotent
async start(): Promise<void> { … }                            // throws MgConfigError if this.stopped
```

   `stop()`'s body is today's `dispose()` body verbatim plus `this.stopped = true;` and
   `this.stoppedReason = reason;`. It is declared `async` so it can never throw synchronously. It is
   already idempotent: the `readyWaits` set is drained by `settle`, `detach()` walks a spliced array,
   `clearSubscribers`/`removeAllListeners` are idempotent. `start()` sets `started = true` and returns;
   the transport seam is constructor-only (`attachTransport()` at `:202`), so a core cannot open a
   second connection, so `start()` is honest bookkeeping, and its doc comment must say exactly that. The
   `store` option's doc (`:105-118`) still says "`attachTransport()` is private and only `dispose()`
   releases the old listeners": update both names to `start()`/`stop()` in the same hunk.
5. `get lastError(): MgError | null`: return `this.lastErrorValue` and assign through
   `toMgError(error, 'client_failure')` at `:381` and `:393`.
6. Replace `get stats()` (`:285-303`) with `get report(): ClientCoreReport` where
   `export interface ClientCoreReport extends ClientReport { ackMode; pending; state; sequencer }` is
   declared beside `ClientCoreOptions`. Every field of today's `stats` is preserved under its existing
   name and type, plus `kind: 'common'`, `started: this.started`, `ready: this.readyState`,
   `attachment: null`, `socketsSeen: 0`, `renumbering: false`,
   `errors: this.lastErrorValue === null ? [] : [summarizeError(this.lastErrorValue)]`,
   `version: this.versionOption`.
7. `get events(): Emitter<ClientEvents> { return this; }`: the class already *is* the emitter, so this
   is a one-line alias, not a second bus.
8. `handleWelcome` `:621-626` becomes
   `const seed = asSequence(frontier) ?? asSequence(this.getFrontierOption?.());` with
   `import { asSequence } from './protocol/codec.js';` replacing the `isCanonicalSequence` import at
   `:35`. Equivalent for `frontier === 0` because `asSequence` returns `null`, not a default.
9. `packages/common/src/index.ts`: `export type { ClientCoreReport, ClientCoreOptions, ClientEvents }`
   and keep `ClientCore`.

Callers, all mechanical, one commit: `headless/src/client.ts:705` and `:743` and `:1247`
(`this.core?.dispose()` → `void this.core?.stop(...)`; 4.3 rewrites these anyway, so here they become
`this.core?.stop('...')` with no `void`), `bootstrapped/src/client.ts:689`
(`attemptTeardown('core dispose', () => this.core.dispose())` → `() => void this.core.stop('mg.js stopped')`),
and every `.dispose()`/`.stats` in `packages/common/tests/client.test.ts` (`:613`, `:636`, `:638`,
`:668`, `:873`, `:913`, `:940`) plus `store.stats`, which is `ObservableStore.stats` and is
not renamed; only `client.stats` becomes `client.report`.

Also fix the vacuous assertion this task's own subject matter lives next to:
`packages/common/tests/client.test.ts:673` is
`assert.equal(second.store.version > first.client.store.version, false)` and `:667` already
established `second.store === first.client.store === shared`, so it compares a number with itself and
can never fail (I8). Replace with `const before = shared.version;` captured before `:670`, then
`assert.ok(shared.version > before, 'replaceRoot bumped the same store')`.

### Test first

`packages/common/tests/client.test.ts`:

- `'stop() is idempotent and never throws'`: `await client.stop()` twice; both resolve; `client.report.started === true`, `client.report.ready === false`.
- `'start() after stop() is an MgConfigError'`:
  `await assert.rejects(client.start(), MgConfigError)`.
- `'report carries the version and an empty error list'`:
  `client.report.version === MG_VERSION`, `client.report.kind === 'common'`, `client.report.errors`
  deep-equals `[]`.
- `'close carries a wrapped TransportCloseInfo'`: subscribe to `close`, deliver a close on the fake
  transport, assert the received object has an `info` whose `code` matches.
- `'the store-identity assertion can fail'`: the `:673` replacement.

**Failure mode before the fix.** `'stop() is idempotent'` fails to compile (`stop` does not exist);
the store-identity line as written never fails, which is the defect. Demonstrate it by temporarily
passing `store: undefined` at `:665` and showing the suite still goes green, then record that in the
commit body.

### Acceptance

`npm run verify` exit 0; `npm run test:common` green; `git grep -n "\.dispose()" packages/common/tests`
returns nothing; `git grep -n "client\.stats\|core\.dispose" packages` returns nothing outside
`dist/`.

### Risk / revert

Medium. The `close` payload change is breaking and reaches `headless`. The `stats` → `report` rename
touches 29 test call sites in `client.test.ts`. A scripted rename is fine, but every one must be read,
because `store.stats` must not move. `stop()` returning a promise where `dispose()` returned `void` is a
breaking change for anyone calling it from a non-async context; there are no such callers in-repo
(`grep -rn "\.dispose()" packages/ scripts`). Revert is the commit; `stop()`'s body is `dispose()`'s
body, so the revert is literal.

---

## Task 4.2b: `stop()` must not wipe a caller-supplied store (audit 03 F1, verified high)

### Problem

`ClientCoreOptions.store` exists for one documented reason (`common/src/client.ts:105-118`): a
reconnect builds a new `ClientCore`, and without passing the previous store the caller's cached
`client.store` reference silently dies. The option's own doc says so.

`stop()` then destroys exactly that: `common/src/client.ts:245` is

```ts
245:    this.store.clearSubscribers();
```

unconditionally, and `store.clearSubscribers()` (`common/src/state/store.ts:272-274`) is
`this.subscriptions.clear()`. So a caller who correctly supplies the store across a reconnect has
every subscription dropped the moment the old core stops, which is the exact failure the option was added to
prevent. Verified high in `docs/audit/00-index.md:41-43` (`03`'s F1) and still live at HEAD.

Compounding it: **no in-repo caller ever passes `store`.** `headless/src/client.ts:866-874` constructs
`new ClientCore({ transport, sequencer, ackMode, logger, autoHandledKeepalive: false })` with no
`store`, so `HeadlessClient` builds a brand-new store on every reconnect and the option is inert in
the only client that reconnects (I8).

### Change

`packages/common/src/client.ts`:

- `private readonly ownsStore: boolean;` assigned in the constructor as
  `this.ownsStore = options.store === undefined;`.
- `:245` becomes `if (this.ownsStore) this.store.clearSubscribers();`.
- The `dispose`/`stop` doc comment gains one sentence: "A store the caller supplied is left alone;
  its subscriptions outlive this core by design."

`packages/headless/src/client.ts`: hoist the store across a reconnect. Add
`private previousStore: ObservableStore | null = null;`, set it in `openConnection`'s replacement path
`this.previousStore = this.core?.store ?? this.previousStore;` immediately before the existing
`this.core?.stop(...)` call, and pass `store: this.previousStore ?? undefined` into the
`new ClientCore({ ... })` at `:866`. The constructor's existing option doc comment is corrected: it
currently claims `@mg.js/common` does not let a caller supply the store, which is false.

### Test first

`packages/common/tests/client.test.ts`:

- `'stop() leaves a caller-supplied store's subscribers alone'`: the `:655` store-identity test's
  setup, then `await second.stop()` and assert `shared.stats.subscribers === 1` (the caller's
  subscription) and that a subsequent `shared` patch still delivers.
- `'stop() clears the subscribers of a store it created'`: `makeClient()`, subscribe, `await
  client.stop()`, assert `client.store.stats.subscribers === 0`.

New `packages/headless/tests/reconnect-store.test.ts`:

- `'the store identity and its subscriptions survive a reconnect'`: with the existing
  `mock-server` fixture, connect, subscribe to a path, force a close with a reconnectable code, await
  the second `ready`, assert `client.store` is the same object and the subscription fired.

**Failure mode before the fix.** The common case fails on `assert.equal(shared.stats.subscribers, 1)`
with `0`. The headless case fails on `assert.notEqual(second, first)` because the two are different stores.

### Acceptance

`npm run verify` exit 0. `git grep -n "ownsStore" packages/common/src/client.ts` finds the field and
its one read.

### Risk / revert

Low and narrowly scoped, but it changes when a store's subscriptions are dropped. The `ownsStore`
branch is a strict narrowing: the only clients that change behaviour are the ones that pass `store`,
and there is exactly one (a test) until this commit adds the headless path. Revert is the commit.

---

## Task 4.2c: `ping()` is answered, and `sendRaw` honours the readiness gate (audit 03 F2 + F8)

### Problem

`GameActions.ping` (`common/src/actions/actions.ts:95-97`) sends `{ type: 'Ping', id }` and receives a
direct `Pong` (`common/src/protocol/types.ts:189-194`, `id?: number`). The core discards it:

```ts
603:      case 'Pong':
604:        return;
```

Nothing settles the handle, so `expirePending` rejects it with `MgCommandUnconfirmedError` after the
`commandMs` timeout (`transport/types.ts:96-103`) even though the ping succeeded on the wire.
Verified high (`docs/audit/00-index.md:44-46`), and `ping` has no test anywhere. `AckMatchMethod`
already has the member this needs (`'requestId'` at `common/src/actions/handle.ts:25`), so no type
change is required.

`sendRaw` (`common/src/client.ts:412-414`) is two lines:

```ts
412:  sendRaw(frame: Record<string, unknown>): void {
413:    this.transport.send(serializeFrame(frame));
414:  }
```

It neither checks `readyState` (unlike `send`, `:346-363`, which throws `MgNotReadyError`) nor records
`lastErrorValue` on a transport failure. An attachment's send-hook path can therefore push a
sequence-bearing frame before `Welcome` and see no error at all.

### Change

`packages/common/src/client.ts`:

- `handleRawFrame`'s `case 'Pong'` (`:603-604`) becomes a call to a new
  `private handlePong(message: PongMessage): void`. It resolves the outstanding handle whose
  `message.id` matches `PendingCommand`'s stamped `requestId`: the ping's `id` is the value
  `GameActions.ping` put on the wire and `serializeFrame`'s flat form carries it, so the match is by
  value, with a first-pending fallback only when `message.id === undefined`. The settled
  `CommandResult` is `{ ok: true, confirmed: true, matchMethod: 'requestId', action: 'Ping',
  requestId, raw: message }`. No type change: `AckMatchMethod` already includes `'requestId'`
  (`common/src/actions/handle.ts:25`).
- `sendRaw` gains the gate and the bookkeeping:

```ts
sendRaw(frame: Record<string, unknown>): void {
  if (!this.readyState) throw new MgNotReadyError('Cannot send a raw frame before Welcome…');
  try { this.transport.send(serializeFrame(frame)); }
  catch (error) { this.lastErrorValue = toMgError(error, 'send_failed'); throw error; }
}
```

  Re-throwing is deliberate: `sendRaw` is the seam a host's send hook calls, and silently eating a
  failed write would be the failure mode I8 exists to prevent. `lastError`/`report.errors` gain the
  record.

### Test first

`packages/common/tests/client.test.ts`:

- `'ping() resolves on the Pong reply instead of ageing out'`: `makeClient()`, deliver `welcome()`,
  `const handle = client.actions.ping({ id: 7 })`, `transport.deliverJson({ type: 'Pong', id: 7 })`,
  `const result = await handle`, assert `result.ok === true` and `result.matchMethod === 'requestId'`.
  Use `ackMode: 'strict'` so a `fifo` accident cannot pass it.
- `'ping() still ages out when no Pong arrives'`: same but deliver a `Pong` with a different `id`,
  `await assert.rejects(handle.result, /was not confirmed/)`. This is the negative control that keeps
  the first test honest.
- `'sendRaw refuses before Welcome'`: `assert.throws(() => client.sendRaw({ type: 'X' }), MgNotReadyError)`.
- `'sendRaw records a transport failure in lastError'`: a fake transport whose `send` throws;
  `assert.throws(...)`; `client.lastError?.code === 'send_failed'`.

**Failure mode before the fix.** The first test's `await handle` rejects with
`MgCommandUnconfirmedError: Command "Ping" ... was not confirmed` after the timeout; the `sendRaw` gate
test does not throw and the transport receives the frame.

### Acceptance

`npm run verify` exit 0; `git grep -n "ping(" packages/common/tests` finds a caller (today there is
none, per audit 03 F2).

### Risk / revert

Medium. Matching a `Pong` by `id` is only safe while `id` is echoed, which the docs promise
(`forms.ts:59`). If the negative-control test cannot be made to pass, the correct fallback is to
resolve the handle only when `id` is present and matches, and let an absent `id` keep today's
timeout. State that in the commit body. `sendRaw`'s new gate is breaking only for a caller that used
it as a pre-`Welcome` escape hatch; `ClientCore.sendRaw` has exactly **one** in-repo caller,
`common/tests/client.test.ts:410`, which already delivers a `welcome()` first (`:409`). The
`sendRaw` names in `bootstrapped` (`attach/room-connection.ts:127,888`, `attach/raw-socket.ts:436`,
`attach/detect.ts:117`) are a *different* method on the `Attachment` sink seam and are untouched.
Revert is the commit.

---

## Task 4.2d: `welcome` and `selfPlayerId` agree across a close (audit 03 F7, I6)

### Problem

The core's close detacher clears one half of the identity pair:

```ts
218:    this.detachers.push(
219:      this.transport.onClose((info) => {
220:        this.readyState = false;
221:        this.selfPlayerIdValue = null;
```

`welcomeValue` is assigned only in `handleWelcome` (`:611`) and cleared **nowhere**, not by the close
handler, not by `stop()`. So after a close, `client.selfPlayerId` is `null` while
`client.welcome?.selfPlayerId` still names the player who is no longer connected. Two accessors for one
fact that disagree is what I6 forbids, and the disagreement is invisible from `report` because
`ClientReport` has one `selfPlayerId`. Verified in `docs/audit/00-index.md` via `03`'s F7; still live
at HEAD.

### Change

`packages/common/src/client.ts`:

- `:218-225`'s close handler adds `this.welcomeValue = null;` next to `:221`, with a comment naming the
  reason: a `Welcome` describes a session that has ended.
- `stop()`/`dispose()`'s body adds `this.welcomeValue = null;` beside `this.readyState = false;`
  (`:247`), so a stopped core has no session at all.
- `get welcome()`'s doc (`:265`) gains: "`null` whenever `selfPlayerId` is `null`. A `Welcome` outlives
  neither a close nor a `stop()`."

Nothing else changes: `welcome`'s type is already `WelcomeMessage | null`, and every reader already
null-checks (`bootstrapped/src/client.ts:254`, `userscript.ts`).

### Test first

`packages/common/tests/client.test.ts`:

- `'a close clears the welcome and the identity together'`: deliver `welcome()`, assert
  `client.welcome !== null && client.selfPlayerId !== null`, deliver a close on the fake transport,
  assert `client.welcome === null`, `client.selfPlayerId === null`, `client.isReady === false`.
- `'stop() clears the welcome'`: deliver `welcome()`, `await client.stop()`, assert `client.welcome === null`.

**Failure mode before the fix.** The first test's `assert.equal(client.welcome, null)` fails with the
full `WelcomeMessage` object.

### Acceptance

`npm run verify` exit 0. `git grep -n "welcomeValue" packages/common/src/client.ts` shows an assignment
in `handleWelcome`, the close handler, and `stop()` and nowhere else.

### Risk / revert

Low, but it is a real behaviour change: a caller that read `client.welcome` after a close to report
which session died now gets `null`. Mitigate by keeping the last session in `report`: add
`readonly selfPlayerId: string | null` to `ClientReport` in this commit (it is already in `MgClient`,
and DESIGN's list omits it because it predates the field), so the diagnostic path is not lost. Name
the change in the commit body. Revert is the commit.

---

## Task 4.3: `HeadlessClient` adopts `MgClient`; `RoomSocket` stops lying about identity

### Problem

`HeadlessClient` (`headless/src/client.ts:280`) is a client with its own dialect. It has
`connect()` (`:638`), `disconnect()` (`:677`) **and** `destroy()` (`:711`), where DESIGN §3.2 wants one
`start`/`stop`; `stats: Record<string, unknown>` (`:558`) where the contract wants a typed `report`;
`error: unknown` (`:493`) where the contract wants `lastError: MgError | null`; a `close` payload shape
(`HeadlessCloseEvent`, `:132-137`) that is not the core's; and a deprecated-in-place event
`headersUnsupported` (`:175`) sitting beside its replacement `'headers-dropped'` (`:183`).

`RoomSocket` (`headless/src/room-socket.ts`) is the fourth client. It has its own
`connect`/`disconnect`/`destroy` (`:151`, `:207`, `:237`) and, worse for I6:

```ts
260:  get playerId(): string {
261:    return this.client?.selfPlayerId ?? '';
262:  }
```

`''` is a placeholder where `null` means "not known yet". That is DESIGN §3.2's identity rule verbatim, and
`RoomSocket` is the one client `docs/DESIGN.md:145-146` says must either become an `MgClient` or be
renamed to admit it is a test helper. It also has 15 `on*` subscription methods (`:349-470`) and a
`RoomSocketEventSurface` union (`:85-93`) instead of one `events`.

`stats` is read in 29 test call sites overall; `client.stats` for the headless client is read in
`headless/tests/*` and nowhere in `src`, so the rename is a test-only sweep.

### Change

`packages/headless/src/client.ts`:

1. `HeadlessCloseEvent` (`:132-137`) becomes `export interface HeadlessCloseEvent extends ClientCloseEvent { analysis: CloseAnalysis; willReconnect: boolean }`. `info` moves into the base, so the field names a caller already destructures (`integration.test.ts:279`, `:352`) keep working.
2. `HeadlessClientEvents` (`:147-184`): delete `headersUnsupported`. It is documented as deprecated in favour of `'headers-dropped'` (`:166-175`), its payload is the redacted bag, and DESIGN §3.2 names the camelCase name as the one to remove. `HeadlessClientEvents` gains `extends MgClientEvents` via an explicit type alias:
   `export type HeadlessClientEvents = Omit<MgClientEvents, 'close'> & { close: [HeadlessCloseEvent]; ... the seven existing events ... }`.
3. `connect()`/`disconnect()`/`destroy()` become `start()`/`stop(reason?)`. `stop()`'s body is today's `destroy()` body with two changes: it sets `stoppedReason = reason ?? 'Stopped by this client.'` instead of `disconnect()`'s hardcoded string (`:682`), and it validates the optional `reason`. `disconnect()`'s softer body is not preserved as a separate name, because DESIGN §3.2 is explicit ("`start`/`stop`, not `connect`/`disconnect`/`install`/`uninstall`/`destroy`"), and `destroy()` already calls `disconnect()` first (`:712`). Every in-repo caller moves in this commit: `headless/src/room-socket.ts:169`, `:178`, `:214`, `:242`; `scripts/verify-socket.ts:262`, `:386`; the `headless/tests/*` sweep.
4. `get error()` (`:492-495`) → `get lastError(): MgError | null`, returning `this.lastErrorConverted` where every assignment to `this.lastError` (`:946` and the constructor) goes through `toMgError(error, 'connect_failed')`. Keep a `get error()` **out**: it is the contract's name and it is two commits old; name the removal in the commit body.
5. `get stats()` (`:557-573`) → `get report(): HeadlessReport`, `export interface HeadlessReport extends ClientReport { connectionAttempt; reconnectAttempt; documentId; version; versionFresh; url; willReconnect; coldStart; stopped; core }`. `kind: 'headless'`, `started`/`ready`/`selfPlayerId`/`errors`/`version` from the base, `attachment: null`, `socketsSeen: this.connectionAttemptValue`, `renumbering: false`.
6. `get events(): Emitter<HeadlessClientEvents> { return this; }`.
7. `requireCore` (`:1265-1267`) throws `MgNotReadyError` (it is Task 4.6's list, landed here because the file is already open).
8. Pass the previous store across a reconnect. This is Task 4.2b's headless half; if 4.2b already landed it, only the comment needs touching.

`packages/headless/src/room-socket.ts`:

9. `get playerId()` (`:260-262`) → `get selfPlayerId(): string | null { return this.client?.selfPlayerId ?? null; }`. Keep `playerId` as a **one-line alias that returns the same value** and document it as the reference name, removed in Phase 5.6. `RoomSocket` mirrors the reference `RoomSocketEvents` typedef, and this file's own header (`:35-41`) says so; deleting it is a Phase 5 rename, not a Phase 4 contract change.
10. `connect()`/`disconnect()`/`destroy()` become `start()`/`stop(reason?)`; keep the existing "already been called" throw (`:154`) but as `MgConfigError`, since it is a caller mistake about options, not a transport fault.
11. `get stats()` (`:309`) → `get report()`, same shape as `HeadlessClient.report` plus `queuedSubscriptionCount`.
12. `get events(): Emitter<RoomSocketEventSurface>`: a thin adapter over the existing `on*` methods is **not** what DESIGN asks for; instead expose `readonly events = this.client?.events`, so a caller can subscribe to the underlying client's map once `start()` has run, and document the `null` before `start()`. Do not re-implement a bus.
13. `headless/src/index.ts`: export `HeadlessReport`.

### Test first

New `packages/headless/tests/client-contract.test.ts` (the master plan's 4.6 acceptance lives here):

- `'a HeadlessClient satisfies MgClient'`: a compile-time assignment
  `const client: MgClient<HeadlessClientEvents> = new HeadlessClient({...})` plus the runtime
  assertions `typeof client.start === 'function'`, `typeof client.stop === 'function'`,
  `client.report.kind === 'headless'`.
- `'stop() is idempotent and takes a reason'`: `await client.stop('test')` twice, both resolve,
  `client.stopped === 'test'`.
- `'report.errors names why the version could not be resolved'`:
  `new HeadlessClient({ versionOptions: { source: new ScriptedVersionSource(['MALFORMED']) } })`,
  `await assert.rejects(client.start())`, `client.report.errors.some((e) => e.code === 'version_unavailable')`.
- `'the deprecated headersUnsupported event is gone'`: `assert.equal(client.eventNames().includes('headersUnsupported' as never), false)`.
- `'a close payload carries info, analysis and willReconnect'`: subscribe to `close`, force a close,
  assert all three keys.

New `packages/headless/tests/room-socket-contract.test.ts`:

- `'selfPlayerId is null before Welcome, never a placeholder'`: a fresh `RoomSocket`,
  `assert.equal(socket.selfPlayerId, null)`, then after `start()` + `welcome`, a string.
- `'start() after start() is an MgConfigError'`.

**Failure mode before the fix.** `client.report` is `undefined` (`stats` is the name);
`socket.selfPlayerId` does not exist and `socket.playerId` is `''`; `eventNames()` contains
`'headersUnsupported'`; `assert.rejects(client.start())` fails because `start` does not exist.

### Acceptance

`npm run verify` exit 0; `npm run verify:socket` (needs a live endpoint; skip with a note if not
available) still connects; `git grep -n "client.stats\|\.connect()\|\.disconnect()\|\.destroy()"
packages/headless scripts` returns nothing outside `dist/` and `room-socket.ts`'s own legacy alias
comment; `exports-map.test.ts` green, which proves `HeadlessClient`, `RoomSocket` and the auth/version
subpaths still resolve.

### Risk / revert

High risk: the widest public-surface change in the phase. Mitigations: (a) `RoomSocket.playerId` stays as
an alias, so the reference-shaped surface is not broken in the same commit that renames the verbs;
(b) `headersUnsupported`'s removal is the one deletion with external callers, and `integration.test.ts:205`
is its only consumer, so delete that destructure in this commit; (c) `stop()` merging `disconnect()` and
`destroy()` changes what a caller's listeners survive. If the reviewer rejects (c), the revert path is
to keep `stop()` as `destroy()` and add `pause()`, which is a facade, not a second verb. State that in
the commit body as the alternative considered. Revert is the commit plus its test sweep.

---

## Task 4.4: `BootstrappedClient` adopts `MgClient`

### Problem

`BootstrappedClient` is the only client with **no emitter at all** (`bootstrapped/src/client.ts:182`,
plain `class`), so a mod must reach through `client.core.on`. Its verbs are `install(): this` (`:364`)
and `uninstall(): void` (`:642`); its readiness is `ready(): Promise<Attachment>` (`:447`) and
`isReady` (`:304`); its diagnostics are a method `report(): BootstrapReport` (`:811`), a **name
collision** with the contract's `report: ClientReport` getter, plus `attachmentReport` (`:335`) and
`attachmentKind` (`:316`). `stats` does not exist on this client (only `client.store.stats`), so
DESIGN's `client.stats` refers to `report()`.

Two details make the adoption more than a rename:

- `install()` returns `this` so a mod can write
  `const client = new BootstrappedClient().install()`, a pattern in `userscript.ts:190`,
  `index.ts:31`, `client.ts:362`'s own doc, and `README.md:138`. `start(): Promise<void>` cannot be
  chained.
- `install()` mutates its lifecycle flags before the first fallible call (`:365-373`) and
  `uninstall()` (`:643-644`) is one-way, so `install(); uninstall(); install()` re-runs every hook
  while the second `uninstall()` returns immediately and releases none of it
 (`docs/audit/00-index.md:80-82`, verified high; the fix covered the attachment memos, not
  the flags).

### Change

`packages/bootstrapped/src/client.ts`:

1. `async start(): Promise<void>` replaces `install()`: the body of `:364-445` with `return this`
   changed to a bare `return` (keep the `void` overload's chaining out of the public surface). The
   synchronous throw at `:373` (`requirePage()`) becomes a rejection, so `userscript.ts`
   must change. `started`/`stopped` bookkeeping: `this.installed = true` moves to **after** the last
   fallible step (`:411`'s `PixiStage.capture`), per `docs/audit/00-index.md:97-100`; `:365-366`'s
   early-return guard stays first; add `if (this.stopped) throw new MgConfigError('A stopped client
   cannot be restarted. Construct a new BootstrappedClient.')`, which also closes the
   `install(); uninstall(); install()` leak by making the second install loud instead of silent (I7:
   fail loudly rather than half-install).
2. `async stop(reason = 'mg.js stopped.'): Promise<void>` replaces `uninstall()`: the body of `:642-728`
   unchanged (`attemptTeardown` already makes it total) plus `this.installed = false`,
   `this.stopped = true`, and a single `try { requirePage() } catch { return }` guard at the top so
   `stop()` cannot throw on a page that has gone away. That is the documented "never throws" clause.
3. `waitForAttachment(): Promise<Attachment>` replaces `ready()` (`:447-509`). `ready`'s attachment
   value has no home in the contract, and `start()` must not await a 20 s poll (its own doc at `:442-446`
   says `kind: 'none'` is a legitimate answer). Keep `isReady` unchanged; rename the internal
   `void this.ready().catch(...)` at `:430` accordingly.
4. `get report(): BootstrappedReport` replaces `report()` (`:811-850`); the body becomes the getter's
   body with `attachment: this.attachmentKind` (a `string | null`, per `ClientReport`'s doc),
   `socketsSeen: this.attachment?.report.socketsSeen ?? 0`,
   `renumbering: this.attachmentReport?.renumberingInstalled === true`,
   `started`/`ready`/`errors`/`version` from the base, and the whole existing `BootstrapReport`
   retained as `detail`. `export interface BootstrappedReport extends ClientReport { detail: BootstrapReport }`.
   Build `detail.attachment` from the **resolved** `this.attachmentReport` getter rather than
   `this.attachment?.report`, which is the stale snapshot `docs/audit/00-index.md:186` reports.
5. `get attachmentReport()` (`:335-347`) keeps its name and becomes a documented one-line read of
   `this.report.detail.attachment`. It is read in eight test sites and by the userscript poll
   (`userscript.ts:234`, `:273`); keeping the name is what makes this commit revertable.
6. `get events(): Emitter<ClientEvents> { return this.core; }`: the core already emits `open`, `ready`,
   `close`, `welcome`, `state` and the rest, so this is a zero-copy adoption, not a second bus. Note in
   the doc that the client adds no events of its own in Phase 4.
7. `get lastError(): MgError | null`: `this.core.lastError`.
8. Import `MgConfigError` from `@mg.js/common`; `packages/bootstrapped/src/index.ts` exports
   `BootstrappedReport` and drops nothing (keep `BootstrapReport`).

`packages/bootstrapped/src/userscript.ts`:

9. `:188-194`: `startUserscript()` keeps its **synchronous** signature (`BootstrappedClient | null`)
   because it is called at module scope (`:298-302`) and its result is published as `globalThis.__mgjs`
   (`:210`). The body becomes:

```ts
const client = new BootstrappedClient();
client.start().catch((error: unknown) => {
  console.error('[mg.js] start() failed:', error);
});
```

   and the `console.error` line for the no-page case stays. `void` the floating promise in a way that
   Biome accepts (`void client.start().catch(...)`).
10. `:31-32` of `packages/bootstrapped/src/index.ts` and `README.md:138`: the doc example becomes
    `const client = new BootstrappedClient(); await client.start(); await client.waitForAttachment();`.
    `docs/` is excluded from lint but the source doc block is not.
11. `registerTeardown`: the badge and the two 500 ms pollers (`userscript.ts:233`, `:269`) must be
    cleared through `onTeardown` so `stop()` actually releases them (I7). This is the one *new*
    behaviour in this task; without it `stop()` is "total" only in name. Add
    `onTeardown(() => { clearInterval(timer); clearInterval(reportTimer); badge?.destroy(); }, page)`.

### Test first

`packages/bootstrapped/tests/client-lifecycle.test.ts` (existing; the guards live here):

- `'start() resolves and is idempotent'`: `await client.start()` twice; `client.report.started === true`.
- `'stop() is total and never throws'`: `await client.stop()`, then `await client.stop()` again;
  assert `client.report.started === false`, `client.attachmentReport === null`,
  `client.report.detail.storage.roundTrips === false`.
- `'start() after stop() is an MgConfigError'`: `await assert.rejects(client.start(), MgConfigError)`.
- `'a failed start() does not claim to be installed'`: a `page` whose `requirePage` throws;
  `await assert.rejects(client.start())`; `assert.equal(client.report.started, false)`.
- `'the report is the resolved attachment, not the stale snapshot'`: drive the raw-socket →
  room-connection upgrade, then assert `client.report.renumbering === client.attachmentReport?.renumberingInstalled`.
- `'events reach a caller through client.events'`: `client.events.on('ready', ...)` fires when the core
  readies.

`packages/bootstrapped/tests/build-output.test.ts` is unchanged and is the "userscript still builds"
acceptance.

**Failure mode before the fix.** `client.start` is `undefined`; `client.report.started` reads
`undefined` because `report()` is a function returning an object without that field;
`await assert.rejects(client.stop())` fails because `stop` does not exist. The `install(); uninstall();
install()` leak (`docs/audit/00-index.md:80-82`) is demonstrated first by a scratch probe showing
`refCount` staying at 1 and `keysBranded` staying true after two `uninstall()`s. Record that output in
the commit body.

### Acceptance

`npm run verify` exit 0 **including `npm run size`**: the userscript is 291.3 KiB and the badge/poller
teardown adds a few bytes; a jump over the ceiling means the `events` getter grew a second bus.
`packages/bootstrapped/tests/build-output.test.ts` green proves the one-file constraint.

### Risk / revert

High. Four specific risks: (a) `start()` losing `this`-chaining is a break with four in-repo
consumers, all listed above; (b) `requirePage()`'s synchronous throw becomes a rejection, so the
userscript's `catch` must move. If the floating-promise pattern is rejected, the alternative is
`start(): this` plus a separate `waitForStart()`, which keeps the chain but abandons DESIGN §3.2's
signature, and that must be named in the commit body; (c) making a second `start()` after `stop()`
throw is a behaviour change for the `install`/`uninstall`/`install` cycle the test exercises.
Read that test first and rewrite it rather than letting it fail; (d) `report()` → `report`
is a silent semantic change for a caller that used the method as a value (`client.report` was a
function before). Revert is the commit; `attachmentReport` and `BootstrapReport` keep their names, so a
revert restores `install`/`uninstall` alone.

---

## Task 4.5: One polarity, and one attempt number

### Problem

**One.** Two option spellings for one switch, and five negative flags for five features the same class
reports positively:

- `bootstrapped/src/client.ts:119,121,123,130,132` declare `disableRenumbering`, `disableJotai`,
  `disableCatalog`, `disablePlatformCatalog`, `disableRender`; the class's own `BootstrapReport`
  (`:168-171`) reports `render: { enabled }`, `jotai: { enabled }`, `catalog: { enabled }` for the same
  five.
- `headless/src/client.ts:229` declares `autoReconnect?: boolean` documented as "equivalent to
  `reconnect: { enabled: false }`", and `:364` resolves three sources for one boolean:
  `options.reconnect?.enabled ?? options.autoReconnect ?? true`. `common/src/protocol/types.ts:257`
  already carries `ReconnectConfig.enabled`.
- `common/src/protocol/types.ts:267,293` puts `coldStartFastRetries: 3` in the reconnect config, and
  `headless/src/reconnect.ts` reads it for **two unrelated policies**: the cold-start fast-retry window
  at `:160` (`context.coldStart && context.attempt <= Math.max(0, config.coldStartFastRetries)`) and
  the bounded-close retry cap at `:332` (`if (close.isBounded && prospective > Math.max(1,
  this.config.coldStartFastRetries)) return null;`), while the comment at `:328-331` claims the two
  "stay independent of each other's defaults". Raising it to 10 to get a wider fast-retry window also
  lets a bad cookie be retried nine times. (Audit 06 §"Other observations"; DESIGN `:535`; F12.)

**Two.** The attempt counter counts the wrong thing, twice over.

- `ReconnectPolicy.nextAttempt` (`headless/src/reconnect.ts:273-281`) increments `attemptValue` and is
  called **only** from `planRetry` (`:336`), so the initial connection is never counted. The first
  retry therefore reports `attempt: 1`, while the URL for that same retry is written from a different
  counter, `client.ts:769`'s `connectionAttemptValue`, as `2` (`:783`). `computeBackoff` is written for
  the URL's numbering. `:174`'s `const step = Math.max(0, context.attempt - 2)` and its comment both
  say "attempt 1 is the first connection and is never itself a retry". Measured: attempts 1, 2, 3 give
  `1500, 1500, 3000` where `:112-115`'s doc promises `1500, 3000, 6000`, and `backoff.test.ts:216`
  bakes the wrong convention in. `report.connectionAttempt` and `report.reconnectAttempt` disagree for
  the client's whole life. (Audit 06 §5, `00-index.md:184`, F11; deferred to Phase 3.6, which
 only unified the default-policy literal and did not touch this.)
- `attemptValue` advances inside `planRetry`, i.e. **before** the planned attempt opens. Three paths
  in `scheduleReconnect` (`headless/src/client.ts:1133-1205`) return without opening: the
  `localShutdown` check (`:1136`), the superseded-plan check (`:1170`), and the
  version-refresh-failure stop (`:1176-1179`). Each of those has already consumed a budget unit, so
  `canRetry()` (`reconnect.ts:304`) can refuse a retry that was inside `maxAttempts` and
  `client.ts:1070` can print `Reconnect budget exhausted after ${this.policy.attempt} attempts.` for
  attempts that were never made.

### Change

`packages/common/src/protocol/types.ts`:

- `ReconnectConfig` (`:255-285`) gains `boundedRetryCap: number` with default `3` in
  `DEFAULT_RECONNECT` (`:287-295`), documented as "the most consecutive retries of a *bounded*
  disposition (`4800`, auth failure) this policy will schedule; `maxAttempts` stays the caller's hard
  cap".
- `coldStartFastRetries` keeps its name and value `3` and its doc narrows to the fast-retry window
  only.

`packages/headless/src/reconnect.ts`:

- `:332` reads `config.boundedRetryCap` instead of `coldStartFastRetries`; the comment at `:328-331`
  now tells the truth.
- One attempt number. `nextAttempt` becomes `nextAttempt(close: CloseAnalysis | null, attempt: number)
  : BackoffPlan`, taking the attempt number as a parameter instead of owning a counter;
  `planRetry(close: CloseAnalysis, attempt: number): BackoffPlan | null` passes it through and checks
  `attempt + 1 < config.maxAttempts` for the budget. `attemptValue` and its `get attempt()` (`:257-260`)
  are deleted; `markEstablished()` (`:290-293`) keeps clearing `coldStartValue` only. The class stops
  being the owner of the number, which is the honest split: `HeadlessClient` writes the number into the
  URL, so `HeadlessClient` owns it.

`packages/headless/src/client.ts`:

- `:996` and `:1103` become `this.policy.planRetry(analysis, this.connectionAttemptValue)`, the *URL's*
  counter, read before `openConnection` increments it (`:769`), so the planned attempt number and the
  number written into that attempt's `clientConnectionAttempt` are the same integer by construction.
- `:364` becomes `this.reconnectEnabled = options.reconnect?.enabled ?? true;`; `autoReconnect`
  (`:228-229`) is **deleted**. Name it in the commit body: it is a public option with zero test
  coverage (`git grep -n autoReconnect packages/*/tests` is empty) and one documented meaning.
- `report.reconnectAttempt` now reports `this.connectionAttempt`'s value at the last close, so the two
  fields in `report` agree; if a distinct "planned retries" number is still wanted, compute it as
  `this.connectionAttemptValue - 1` at read time rather than keeping a second counter.

`packages/bootstrapped/src/client.ts`:

- `BootstrappedClientOptions` (`:119-132`): delete the five `disableX` flags and add
  `features?: { renumbering?: boolean; jotai?: boolean; catalog?: boolean; platformCatalog?: boolean; render?: boolean }`
  with each default stated in the doc comment per DESIGN `:317-318`: `renumbering` defaults **on**
  ("must never be off by accident"); `jotai`, `catalog`, `platformCatalog` and `render` default **off**
  in the sense that the flag being absent means the feature is enabled only when its precondition
  holds, i.e. the five reads become `this.features.renumbering !== false`, `... jotai !== false`, etc.,
  with `platformCatalog` keeping today's on-by-default. Each of the five reads at `:249`, `:401`,
  `:404`, `:411`, `:466`, `:471`, `:604` is rewritten to go through one `private readonly features`
  object resolved once in the constructor.

### Test first

New `packages/bootstrapped/tests/options.test.ts`: the master plan's own acceptance, "a test asserts
every documented option changes observable behaviour":

- `'features.render: false suppresses the Pixi capture'`: `new BootstrappedClient({ features: { render: false } })`,
  assert `report.detail.render.enabled === false` and `report.detail.render.ctorsRecovered === false`.
- `'features.jotai: false leaves the bridge null'`: assert `report.detail.jotai.enabled === false`.
- `'features.catalog: false captures no tables'`: assert `report.detail.catalog.tables` is empty.
- `'features.renumbering: false installs no rewriter'`: assert `report.renumbering === false` after
  attachment.
- `'features.platformCatalog: false makes no platform request'`: with a counting stub fetch, assert
  zero calls.

`packages/headless/tests/backoff.test.ts`:

- `'the first retry after a Welcome waits one base delay, the second waits two'`: the existing
  `:198-217` case, rewritten: `markEstablished()`, then
  `planRetry(close, 1)` → `delayMs === 1500`, `planRetry(close, 2)` → `3000`, `planRetry(close, 3)` →
  `6000`, matching `computeBackoff`'s doc. **This is the F11 failure**: today's numbers are
  `1500, 1500, 3000`.
- `'coldStartFastRetries no longer caps a bounded retry'`: `config: { coldStartFastRetries: 10, boundedRetryCap: 2 }`,
  an `analyzeClose(AuthFailed, ..., false)` close, assert exactly two plans and `null` on the third.
  **Failure before the fix**: with the cap read from `coldStartFastRetries` the third plan is not
  `null`.
- `'a plan that never opens does not consume the budget'`: a `HeadlessClient` with
  `reconnect: { maxAttempts: 3 }` whose `start()` is superseded by a second `start()` while a backoff
  is pending; assert the third genuine attempt is still scheduled and `client.stopped` does not read
  `Reconnect budget exhausted`. **Failure before the fix**: the superseded plan has already advanced
  the counter, so the third attempt is refused.
- `'report.connectionAttempt equals report.reconnectAttempt at the last close'`.

**Failure mode before the fix.** The rewritten `:198-217` case fails on the second assertion with
`1500 !== 3000`; the bounded-cap case fails on `assert.notEqual(plan3, null)` when it should be `null`;
the superseded-plan case fails with `stopped === 'Reconnect budget exhausted after 3 attempts.'`.
Capture all three in the commit body. This is the phase's largest behaviour change.

### Acceptance

`npm run verify` exit 0. `git grep -n "disableRenumbering\|disableJotai\|disableCatalog\|disablePlatformCatalog\|disableRender\|autoReconnect" packages/*/src` returns nothing. `git grep -n "coldStartFastRetries" packages/headless/src/reconnect.ts` returns only the cold-start branch. `npm run verify:socket`: the live path is where `clientConnectionAttempt` is observable; if no endpoint is available, say so in the commit body rather than claiming it.

### Risk / revert

High. The attempt-number fix changes the retry cadence callers actually see: the first retry after an
established session now waits `baseDelayMs` where it waited `baseDelayMs` and the second doubles where
it did not. Timings move later, which is the documented behaviour but is a real change. Mitigations:
the option rename is breaking with a named alternative in the commit body; `boundedRetryCap` defaults
to `3`, so the bounded-retry count for a default configuration is unchanged; and `coldStartFastRetries`
keeps its name and value, so only its *second* meaning is removed. If the reviewer wants the cadence
frozen, the fallback is to keep `attempt - 1` in `computeBackoff` and fix only the message and
`canRetry` accounting, which leaves the docstring wrong, so it must be named as the compromise. Revert
is the commit; `report.reconnectAttempt`'s deletion is the only field a caller loses.

---

## Findings beyond the table

### The recorded deferrals

**D1: `store.ts` `waitFor` leaks its subscription and timer (I5). → TASK 4.0.** Evidence: the
`finish`-only cleanup at `store.ts:245-250`, the predicate inside the handler at `:254-256`, and
`deliver`'s swallow at `:308-311`. Recorded at `docs/DESIGN.md:519-521` (F13), the phase-2 plan's
**F13** finding ("`store.ts`'s subscription wait can leak"), `.logs/ledger.md:106-107`. Not a defect
of `deliver`, since a throwing *subscriber* must not
break the store (`store.test.ts:183`), but `waitFor` must not put a caller's predicate where that
policy applies.

**D2: `patch.ts`'s `add /arr/-` append path and `MAX_ARRAY_PADDING`. → NOT A TASK. Defer with a
named home: Phase 7.** The recorded claim (DESIGN `:522-524`, the phase-2 plan's **F16**) is that
the `-` path "is not covered by `MAX_ARRAY_PADDING`", which is literally true and materially
misleading. `MAX_ARRAY_PADDING = 10_000` (`patch.ts:135`) bounds **holes created by one operation**, not
array length: its doc says "The most holes one operation may create in an array", and the three guards
read `index > current.length + MAX_ARRAY_PADDING` (`:150` in `setAt`, `:209` in `ensureContainer`,
`:292` in `applyOperation`'s `add`). The `-` path (`:142-144` `parent.push(value)`, and `:284-287`
`parent.value.push(patch.value)`) grows an array by **exactly one** element per operation and cannot
create a hole, so there is nothing for a padding guard to bound. What is unbounded is total state size
across frames, and that is not closable at the patch layer, because one frame may legally replace the
whole tree with up to `MAX_FRAME_BYTES`; DESIGN `:523-524` says so itself. A real bound needs a new
public policy (`ApplyPatchOptions.maxNodes` or audit 23's `maxPad`), a decision about what happens
when it trips (drop the batch, or close), and therefore its own observable-behaviour test (I8). That
is a missing capability, not a wire bound: **Phase 7**. Note also that the ledger's blanket warning
(`.logs/ledger.md:108`) that "patch padding" is stale text refers to the Phase 1.1 prototype-pollution
fix, which this is not, but this item is stale in its own way and should be annotated rather than
planned.

**D3: `coldStartFastRetries` doubles as the bounded-close cap (F12). → TASK 4.5.** Evidence:
`reconnect.ts:160` (fast-retry window) and `:332` (bounded-close cap), with the "stay independent"
claim at `:328-331`. Also flagged by audit 06 and DESIGN `:535`.

**D4: `attempt` counts plans issued, not attempts made. → TASK 4.5.** Evidence: `reconnect.ts:273-281`
(`attemptValue += 1`, called only from `planRetry` at `:336`), the three no-open returns in
`scheduleReconnect` (`headless/src/client.ts:1136`, `:1166-1167`, `:1172-1176`), `canRetry()`'s read of
the inflated counter (`reconnect.ts:304`), and the message at `client.ts:1070`. This is the same
counter as F11 (the plan-vs-URL off-by-one, `reconnect.ts:174`'s `attempt - 2`, `backoff.test.ts:216`),
so both are one commit: fixing one without the other would just move the error. F11 was deferred to
Phase 3.6; unified the default-policy literal and **did not** touch the numbering, so the
ledger's "attempt off-by-one → Phase 3.6" is therefore outstanding, not closed.

**D5: `VersionResolver.invalidate()` has no callers. → NOT A TASK. Defer with a named home: Phase 6.**
Evidence: `headless/src/version.ts:220-223` declares it; `grep -rn "\.invalidate()" packages scripts`
(including tests) returns nothing. It is an inert public method, which is exactly Phase 6's charter
("Inert surface: implement or delete"), and `.logs/ledger.md:76` already assigns it there. The
recommendation for Phase 6 is **delete**, because `refresh()` (`:216-218`) is the unconditional
re-resolve a caller actually wants and `invalidate()` cannot be reached through any documented flow.

**D6: the `uninstall` attachment leak. → CLOSED. Do not plan it.**
("fix(bootstrapped): stop handing out the attachment uninstall() released") cleared both memos; the
code is at `bootstrapped/src/client.ts:674` (`this.attachment = null`) and `:679`
(`this.attachmentPromise = null`), with `client-lifecycle.test.ts` gaining the reinstall guard. What
remains is the **flag** leak (`install()` after `uninstall()`), which is a different defect and is
Task 4.4's item 1.

**D7: `handleWelcome` may be a near-copy of the sequence-validator shape. → Half a task; folded into
4.2.** Verified and real, but narrower than "near-copy": `common/src/client.ts:622` is
`isCanonicalSequence(frontier) ? frontier : null`, character-equivalent to `asSequence`'s whole body
(`common/src/protocol/codec.ts:201`), and `:625` applies the same rule again. Phase 3.5
missed it because its exactly-one-declaration scan matched `Number.isInteger(...)`, which is the
*rule's* body, while this call site has the *read's* shape. The one-line fix
(`asSequence(frontier) ?? asSequence(this.getFrontierOption?.())`) is behaviour-identical including the
`frontier === 0` case, because `asSequence` returns `null` rather than a default. Folded into 4.2
rather than given its own commit; there is no test that can fail first, so it must be named in the
commit body as a pure refactor.

### Defects found beyond the table and the deferrals

**E1: `dispose()` wipes a caller-supplied store's subscribers (audit 03 F1, verified high). → TASK
4.2b.** `common/src/client.ts:245`. Also: no in-repo caller passes `store`
(`headless/src/client.ts:866-874`), so the option is inert in the only client that reconnects.

**E2: `ping()` can never succeed (audit 03 F2, verified high). → TASK 4.2c.** `client.ts:603-604`
discards the `Pong`; `expirePending` then rejects with `MgCommandUnconfirmedError`. `ping` has no
caller and no test.

**E3: `sendRaw` bypasses the readiness gate and the error bookkeeping (audit 03 F8). → TASK 4.2c.**
`client.ts:412-414`.

**E4: `welcome` survives a close while `selfPlayerId` is cleared (audit 03 F7, I6). → TASK 4.2d.**
`client.ts:221` versus `:611`; `welcomeValue` is cleared nowhere, not even by `stop()`.

**E5: `RoomSocket.playerId` returns `''` as a placeholder (I6). → TASK 4.3.** `room-socket.ts:260-262`.
`null` is the honest answer and the contract's type; `''` is indistinguishable from a real empty id.

**E6: `common/tests/client.test.ts:673` asserts `a > a`, so it can never fail (I8). → TASK 4.2.**
`second.store === first.client.store` is established at `:667`; a `store: undefined` mutation keeps the
suite green.

**E7: `MgConfigError` is a second hierarchy root (audit-invisible). → TASK 4.6.**
`headless/src/errors.ts:19` extends `Error`, so `isMgError` is `false` for it; no file in `docs/audit/`
mentions the class. `MgTransportError` does not exist anywhere.

**E8: the catalog's only production wiring discards every source failure. → TASK 4.6.**
`common/src/catalog/source.ts:169-171` (`this.onSourceError?.(...)`) with
`bootstrapped/src/client.ts:407` passing nothing; `DomainCatalog` (`catalog/types.ts:174-192`) has no
`errors`. This is the master plan's "catalog `load()` stops swallowing into an unpassed
callback".

**E9: `docs/DESIGN.md` §3.2's `common/src/client/contract.ts` contradicts §4.2's target tree.
→ Judgement call, resolved in 4.1.** §3.2's path is a comment; §4.2's tree keeps `client.ts` bare and
lists no `client/` folder, and §4.1's folder rule forbids a one-module folder. Plan uses
`common/src/client-contract.ts`; recommend annotating §3.2.

**E10: audit 22 §5's `autoHandledKeepalive` sub-claim is false. → NOT A DEFECT, no change.**
`22-xcut-conventions.md:137-141` says the `true` branch is "unreachable from this repo" because "both
call sites pass `false`". The two `src` call sites do (`headless/src/client.ts:873`,
`bootstrapped/src/client.ts:244`), but `common/tests/client.test.ts:838-850` constructs a core with
`autoHandledKeepalive: true` and asserts `transport.sent` becomes `['pong']`, so the branch is live and
tested. The option is a deliberate seam ("the transport does this itself"), not an inert flag. Note
also that 22's cited line numbers for it (`client.ts:111`, `:505`, `:705`, `:242`) are all stale; the
real ones are `:128`, `:565`, `:873`, `:244`.

**E11: `ClientReport.selfPlayerId` is missing from DESIGN's sketch. → Added in 4.2d.** DESIGN
`:131-141` lists `selfPlayerId` on `MgClient` but not on `ClientReport`; a diagnostic that cannot name
the session's identity is the one thing a bug report needs. Additive.

**E12: the `-` token on a non-array parent writes a literal `-` key (noted, not planned).**
`common/src/client.ts`; more precisely `common/src/state/patch.ts:284-287` handles `-` only when
`Array.isArray(parent.value)`; `:311`'s `isForbiddenToken(key)` does not cover `-`, so `add /room/-`
against an object parent creates a property named `-` that `resolvePointer` can never read back
(`Number('-')` is `NaN`, so `:208` refuses it). It is a spec deviation with no security consequence
(the array case pads nothing, the object case allocates one property), it predates Phase 1.1, and
fixing it means refusing `-` on non-arrays, which is a behaviour change to a documented server-quirk
tolerance. **Not planned; record it in Phase 6's inert-surface sweep or leave it.**

---

## Verification plan for the phase

**Per task (every commit):**

```bash
npm run verify        # lint → typecheck(src+tests) → build → test → size. Must exit 0
```

plus the task's own `git grep` acceptance lines from its section. **Green at the baseline means:** exit
0, **736 tests** (bootstrapped 181, common 386, headless 169), `# fail 0`, `# skipped 0`, and
`[size] bundle ... within budget`. Each task adds tests, so the numbers rise monotonically; the useful
assertion is `# fail 0` and that `# skipped 0` never moves (I8). If a task's count does not rise,
either the test did not run (`node --test` discovers `tests/**/*.test.ts` per package) or it was
appended to a file the runner skips. Check with
`npm test -w @mg.js/common 2>&1 | grep -c "^# tests"` rather than trusting a summary.

**Targeted commands**

| command | proves |
|---|---|
| `npm run test:common` | `store.test.ts`, `client.test.ts`, `client-contract.test.ts`, `errors.test.ts`, `catalog.test.ts` |
| `npm run test:headless` | `client-contract.test.ts`, `room-socket-contract.test.ts`, `backoff.test.ts`, `exports-map.test.ts` |
| `npm run test:bootstrapped` | `client-lifecycle.test.ts`, `options.test.ts`, `build-output.test.ts` (the one-file userscript) |
| `npm run typecheck` | `tsc -b --force` **and** `tsc -p tsconfig.tests.json`; the tests are typechecked by the second |
| `npm run size` | the userscript stayed one chunk and inside budget after 4.4's `events`/badge changes |
| `git grep -n "\.dispose()\|client\.stats\|autoReconnect\|disable"` | the renames are complete |

**Live checks** (`verify:socket`, `verify:catalog`, `probe:guest` exist and need the network):

- `npm run verify:socket`: run before and after **4.2, 4.3 and 4.5**. 4.2's `close`-payload wrapper and
  4.3's `stop()` merge are observed on a real close; 4.5's attempt numbering is observable only here,
  because `clientConnectionAttempt` is written into a real URL. It exits 2 when it could not connect
  and 1 when the close code is not 4840, so a network outage is distinguishable from a regression. If
  it exits 2, say so in the commit body rather than claiming green.
- `npm run verify:catalog`: run after **4.6**, which makes `onSourceError` required and adds
  `DomainCatalog.errors`.
- `npm run probe:guest`: run after **4.6** only, to confirm the `MgConfigError` re-export did not
  change the cookie rejection path. It exits 1 if any encoding is accepted.

**Phase exit criteria**

- `npm run verify` exit 0, `# fail 0`, `# skipped 0`, bundle inside budget.
- `MgClient`, `ClientReport` and `MgErrorSummary` exist in `common` and are implemented by
  `ClientCore`, `HeadlessClient` and `BootstrappedClient`; `RoomSocket`'s identity and verbs obey the
  same rules with `playerId` kept as a documented reference alias.
- Every verb in the table at the top of this plan is `start`/`stop`, in all three packages, with
  `isReady`, `selfPlayerId: string | null`, `lastError: MgError | null`, `events` and `report`. No
  `connect`, `disconnect`, `install`, `uninstall`, `destroy`, `dispose` or `stats` remains on a client
  class.
- Each deferral has a disposition in the commit log: D1 task 4.0; D2 deferred to Phase 7 with the
 reason; D3/D4 task 4.5; D5 deferred to Phase 6; D6 closed; D7 folded into 4.2.
- The baseline line in the master plan, the paragraph that reads "**Baseline at the time of
  writing:** `tsc -b --force` exit 0, 490 tests reported", is corrected to the same figure this plan
  uses, the `### Phase 4` heading ("One client contract") gains a `**Status: COMPLETE**` line naming the
  ten-plus commits, and every row of the Phase 4 table is either marked done with a SHA or annotated
  with where it moved. (Another agent was editing this file while the plan was written; locate the
  heading, do not trust its line number.)
- `docs/DESIGN.md` gains three annotations: §3.2's `client/contract.ts` path (E9), the
  `ClientReport.selfPlayerId` omission (E11), and the stale F16 text under §5 I5 (D2). Nothing else in
  it changes.

## Master-plan anchor corrections (all verified against the working tree at the boundary)

The Phase 4 table cites files, not lines, so no anchor is *falsified*, but three of its claims are
one revision behind, and the earlier phases' line numbers in DESIGN's invariant notes are stale
throughout. Corrected here so an executor does not chase them:

| master plan / DESIGN says | actual at HEAD |
|---|---|
| 4.1 file: `common/src/client/contract.ts` | `common/src/client-contract.ts` (see E9) |
| DESIGN `:519-521` "`store.ts:245-261`, predicate at `:255`" | `store.ts:233-269`, predicate at `:239` and `:255` |
| DESIGN `:522` "`patch.ts:142-144`" | correct: `setAt`'s `-` branch; the second path is `:284-287` |
| DESIGN `:534` "the retry counter is off by one ... (F11, Phase 3.6)" | still outstanding; did not touch it. Now Task 4.5 |
| DESIGN `:535` "`coldStartFastRetries` conflates two policies (F12, Phase 4.5)" | correct; now Task 4.5 |
| audit 22 `:137-141` `autoHandledKeepalive` at `client.ts:111,505` | `common/src/client.ts:128,565`; the call sites are `headless:873`, `bootstrapped:244`; the claim itself is false (E10) |
| audit 03's `client.ts:214` for `dispose()`'s clear | `common/src/client.ts:245` |
| audit 03's `client.ts:535-536` for the `Pong` drop | `common/src/client.ts:603-604` |
| audit 03's `client.ts:195-198` for the close clearing identity | `common/src/client.ts:218-225` |
| audit 06's `reconnect.ts:322` for the bounded cap | `reconnect.ts:332` |
| audit 06's `client.ts:915` for `scheduleReconnect`'s early return | `headless/src/client.ts:1133-1135` |
| `docs/audit/00-index.md:176`'s `headless/src/client.ts:308` for the three-source boolean | `headless/src/client.ts:364` |
| the master plan's own `### Phase 4` heading | `:719` when scoped, `:752` when finished, and moving; locate by heading |
