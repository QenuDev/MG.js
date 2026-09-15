# Phase 3: One home per helper (invariant: duplication). Execution plan

> **For agentic workers:** this plan implements the Phase 3 row of
> `docs/plans/2026-09-13-code-consistency.md:684-700`. Use `superpowers:subagent-driven-development` or
> `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax. One commit per task; **every commit
> leaves `npm run verify` green** (lint → typecheck src+tests → build → test → size).
>
> **Do not start a task whose predecessor has not been committed**, and do not run two tasks at once: five
> of these tasks edit `headless/src/client.ts`, `bootstrapped/src/client.ts` or
> `bootstrapped/src/coexistence/renumber.ts`, and concurrent edits to those three files will conflict.

> **Status: COMPLETE (bookkeeping pass, after the fact).** All eight tasks landed: 3.1 · 3.2
> · 3.3 + (early, plus) · 3.4 · 3.4b · 3.5
> · 3.6 · 3.7a · 3.7b · 3.7c · 3.7d · 3.7e
> · 3.8, along with (DESIGN §4.2 `poll.ts` row) and (DESIGN I3/I4/I5).
> Phase 2 review closures recorded with the phase: (a non-canonical frontier cannot fail a live
> command) and (stable close/open/ready, and a superseded refresh cannot stop a session).
>
> **Note on this document's checkboxes.** The header above promises `- [ ]` step syntax; the document as
> actually written contains **zero** checkbox lines (every task is a numbered `**Change.**` list and an
> `**Acceptance.**` list). There was therefore nothing literal to tick. Completion is recorded the way the
> master plan recorded Phase 0 and Phase 1: a `**Status: COMPLETE**` line under each task heading naming
> its commit(s) and what landed, with a `**Correction(s)**` note next to every claim the executors found
> to be false or stale. The original text is left in place so a reader can see where the plan was wrong.
> Verified at the end of the phase: `npm test` **736 tests / 0 fail / 0 skipped** (bootstrapped 181,
> common 386, headless 169) and `npm run size` 291.2 KiB (298,233 B), within budget.

**Goal:** collapse each of the eight duplications report 20 found into one surviving implementation at its
owner, add a test at each new home that fails if a further copy appears, and record the behaviour change each
merge makes.

**Architecture:** new homes are `common/src/unsubscribe.ts`, `common/src/poll.ts`,
`common/src/protocol/codec.ts` (`asSequence`), `bootstrapped/src/coexistence/envelope.ts` (committed as
), `bootstrapped/src/render/warn-once.ts`, and the existing
`common/src/emitter.ts` / `headless/src/reconnect.ts` / `bootstrapped/src/render/ctors.ts` /
`bootstrapped/src/render/text.ts` / `bootstrapped/src/coexistence/brand.ts`. `common` stays platform-free
(DESIGN §6 I9): the new `poll.ts` names **no** timer global, and the scheduler and clock are
injected, and nothing added here references `window`, `document`, `fetch` or `node:*`.

**Tech stack:** TypeScript 5.9 (NodeNext ESM, `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`,
`noUnusedParameters`), `node:test` + `node:assert/strict` via `tsx`, Biome (`lineWidth: 110`), npm
workspaces.

**Spec:** `docs/DESIGN.md` §3.1 (layer rule), §4.2 (target tree), §4.3 (tests mirror source), §6 I1/I2/I4/I5/I7/I9.
Evidence: `docs/audit/20-xcut-duplication.md` (primary), `docs/audit/22-xcut-conventions.md` §4,
`docs/audit/25-xcut-architecture.md` §6.

**Every anchor below was re-opened against the working tree** at the boundary, not against the master plan's or
the audit's line numbers: those were written before Phases 0 and 1 and several have drifted. Symbol names are
authoritative, the quoted code is authoritative, and the line numbers are current as. Where a
citation refers to a state that no longer exists, the commit it refers to is named.

## Global constraints

Copied verbatim in force from the master plan (`docs/plans/2026-09-13-code-consistency.md:29-47`) and not
repeated per task:

- Relative imports always end in `.js` in `src`; tests may import `../src/x.ts` (`tsconfig.tests.json`
  sets `allowImportingTsExtensions`). Bootstrapped tests use `.ts`; common and headless tests use `.js`.
- `common` stays platform-free: zero runtime dependencies, no `node:*`, no DOM globals, no `ws`.
- `headless` and `bootstrapped` never import each other, directly or through `packages/*/src` paths.
- The userscript stays one self-contained file; `npm run build` proves it.
- `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters` stay on for source *and*
  tests. `tsc -b --force` and `tsc -p tsconfig.tests.json` both exit 0.
- Banned everywhere **including tests**: `any`, `as any`, `@ts-ignore`, `@ts-expect-error`, non-null `!`.
- No public option may be inert; no test may be unable to fail (I8).
- Behaviour changes need a test that fails before and passes after. Pure refactors need the existing suite
  green and an unchanged public surface.
- Breaking changes are allowed (pre-1.0) but each one is **named in the commit body**.
- Commit style matches the log: `fix(common): ...`, `refactor(bootstrapped): ...`, `test(common): ...`, with a body
  that names the surface change.

## Working-tree state: read this before starting

> **Historical, superseded at the end of the phase.** This section describes the tree as it stood
> *before* Phase 3 began (Phase 2 Task 2.1 uncommitted; Task 3.3 the only landed task). It is kept as the
> record of the starting state. Every task below has since landed, the working tree is clean, and the
> Phase 2 Task 2.1 conflict it warns about was resolved by landing 2.1 first. Do not act on it.

**Task 3.3 is done and committed.** It moved while this plan was being written, so re-run
`git log --oneline -5` and `git status --porcelain` before starting anything.

```
 docs(plan): Task 1.3 Step 3 is closed, and it was bigger than the summary said
 fix(bootstrapped): a rewriter fault must not eat the host's frame
 refactor(bootstrapped): give the QuinoaCommand envelope predicate one home
```

 created `packages/bootstrapped/src/coexistence/envelope.ts` and
`packages/bootstrapped/tests/envelope-owner.test.ts`, deleted `asEnvelope`/`parseEnvelope` from
`bootstrapped/src/client.ts` (now re-exports at `:942`) and `asEnvelope` from `renumber.ts` (now a re-export at
`:57`), dropped the redundant `isOurs` guard, and made `applyRenumberingToString` a pure alias
(`client.ts:955`) so the client carries no second implementation at all. added the missing guard at
the raw-socket seam with a test. closed master-plan Task 1.3 Step 3 in the master plan itself.

**So Task 3.3 needs no further work.** Its section below is kept as the record of what landed and why, in the
shape a reviewer needs: it is the reference implementation the other tasks are measured against, and its
"Correction to the brief" is the reason task 3.7 does not create `coexistence/outbound.ts`.

**Phase 2 Task 2.1 is in the working tree right now, uncommitted, and it edits
`packages/common/src/protocol/codec.ts`**. That is the same file task 3.5 must edit. Current uncommitted state:

```
 M packages/common/src/protocol/codec.ts          MAX_FRAME_BYTES (:66), utf8ByteLength (:76), parseFrame(raw, {maxBytes}) (:93)
 M packages/common/src/protocol/index.ts          exports MAX_FRAME_BYTES, utf8ByteLength
 M packages/common/src/client.ts                  the core's inbound switch
 M packages/headless/src/transport/client.ts      passes maxPayload
 M packages/common/tests/client.test.ts
 M packages/headless/tests/transport-keepalive.test.ts
?? packages/common/tests/protocol/               (2.1's new tests)
?? packages/headless/tests/transport-frame-cap.test.ts
```

**Good news, precisely checked:** 2.1 did **not** touch `extractFrontier`'s body. It only shifted it, from
`codec.ts:126` to **`codec.ts:167`**. So 3.5's two hunks are *content-identical* and merely relocated: no
semantic conflict, only a textual one. **Therefore: land 2.1 (or wait for the agent that owns it), then apply
3.5's `codec.ts` edit on top with `extractFrontier` at `:167`.** Do not run 3.5 concurrently with 2.1. Those
two would edit adjacent lines of one function's home file and the rebase would cost more than the wait. 3.5's
other seven files are untouched by 2.1, so they can be staged at any time. Everything else in Phase 3 is
file-disjoint from Phase 2.

**Tooling caveat for this workspace.** The graphflow-interposed `read` tool served **stale indexed content**
for `packages/bootstrapped/src/attach/raw-socket.ts`: 534 lines while the file on disk was 544, i.e. the
pre- revision. Every line number in this plan was therefore taken with `grep -n` / `sed -n` against
the working tree, not with `read`. Do the same when you verify a step: `wc -l` the file first if a citation
looks short by one hunk, and prefer `grep -n` for a symbol's location.

## Ordering and the dependency rule

**3.1 and 3.2 do not gate any other task.** No task consumes `Unsubscribe` or `Emitter` as an input. The
helpers 3.5/3.7 need (`asSequence`, `asEnvelope`, `isRiveLike`, `detach`) are unrelated to them. The real
constraint between tasks is **shared files**, because five tasks edit the two `client.ts` files and
`renumber.ts`. Execution order is therefore chosen so that no two consecutive tasks edit the same file and
no task starts on a dirty file it does not own:

| # | Task | Files it owns | Why here |
|---|---|---|---|
| 1 | **3.3** | **DONE**: (dedupe) + (raw-socket guard) + (master-plan close-out) | nothing left to do; read it as the worked example for the rest of the phase |
| 2 | **3.1** | `common/src/unsubscribe.ts` (new), `state/store.ts`, `state/index.ts`, `transport/types.ts`, `transport/index.ts`, `headless/room-socket.ts` | `common`-only plus one headless file; the widest fan-out (9 importers) and the cheapest, so land it early while the tree is clean |
| 3 | **3.2** | `common/emitter.ts`, `headless/client.ts`, `headless/transport/client.ts`, `bootstrapped/attach/transport.ts` | must precede 3.5 and 3.6, which both edit `headless/client.ts` |
| 4 | **3.5** | `common/protocol/codec.ts`, `protocol/index.ts`, `protocol/sequencer.ts`, `protocol/envelope.ts`, `common/client.ts`, `bootstrapped/{client,coexistence/renumber,attach/room-connection,attach/raw-socket}.ts` | after 3.3 (shares `renumber.ts` and `client.ts`) and after 3.2 (shares `headless/...` only via `common`) |
| 5 | **3.4** | `common/poll.ts` (new), `bootstrapped/attach/detect.ts`, `render/ctors.ts`, `jotai/bridge.ts`, `catalog/bundle.ts`, 3 test helpers | after 3.5, because 3.4's `attach/transport.ts` edit and 3.5's `bootstrapped/client.ts` edit are independent but 3.7 wants `ctors.ts` frozen |
| 6 | **3.4b** | same files as 3.4 + `headless/client.ts:625` | a second, separately rejectable commit on the files 3.4 just touched |
| 7 | **3.6** | `headless/reconnect.ts`, `headless/client.ts` (doc line only), `headless/tests/backoff.test.ts`, `headless/tests/layering.test.ts` (new) | after 3.2/3.5, which both touch `headless/client.ts`; its own code change is one file |
| 8 | **3.7** | `bootstrapped/render/{warn-once.ts (new),world.ts,text.ts,sprite.ts,graphics.ts,rive.ts,ctors.ts}` | after 3.4, which owns `ctors.ts`'s polling function |
| 9 | **3.8** | `bootstrapped/coexistence/brand.ts`, `catalog/bundle.ts`, `coexistence/renumber.ts`, `attach/raw-socket.ts`, `tests/coexistence.test.ts` | after 3.5 and 3.7, which touch `renumber.ts` and `bundle.ts`-adjacent render files |

**Completion (every row landed, in this order):** 3.3 / · 3.1 · 3.2
3.5 · 3.4 · 3.4b · 3.6 · 3.7a · 3.7b · 3.7c
3.7d · 3.7e · 3.8.

---

## Task 3.3: One envelope predicate (committed; only the raw-socket guard is owed)

**Status: COMPLETE**: (consolidation into `bootstrapped/src/coexistence/envelope.ts`) +
 (the raw-socket rewriter guard) + (master-plan Task 1.3 Step 3 close-out). The heading's
"only the raw-socket guard is owed" was paid; nothing further was owed. Guards:
`bootstrapped/tests/envelope-owner.test.ts` (function identity) and the fault test in `raw-socket.test.ts`.

**Correction (recorded, intent left intact).** This section's home disagrees with the audit by design:
report 20 §4 and the master-plan table named `common/protocol/codec.ts`, but that file holds no envelope
predicate (`git grep -n "asEnvelope" -- packages/common` → 0 hits) and the audit's "three copies" counted a
pre-parse gate, not a third file. The plan's "Correction to the brief" above is the accepted resolution;
the master-plan row now reads "settled at `bootstrapped/src/coexistence/envelope.ts`".

**Surviving copy.** `bootstrapped/src/coexistence/envelope.ts` is new and committed. It is the
best copy because it is the only one that (a) documents the 16-character bound as a *fast path* rather than a
decision, (b) is total over `unknown` (`parseEnvelope`'s doc: "a non-string, an unparseable string, and a
string that is JSON but not an envelope all answer `null`"), and (c) is already covered by a test at the new
home.

**Correction to the brief, with evidence.** The brief (and the master plan table at
`:693`, and master-plan `:516`) route this to `common/protocol/codec.ts`. That anchor is wrong twice over:

1. `common/src/protocol/codec.ts` contains **no envelope predicate**. Its exports are `parseFrame`,
   `serializeFrame`, `extractPatches`, `extractFrontier` (`protocol/codec.ts:57, 83, 104, 126`; barrel at
   `protocol/index.ts:5-11`). A repo-wide `git grep -n "asEnvelope" -- packages/common` returns nothing.
2. The third copy in the audit's "three" is `client.ts`'s `parseEnvelope` (a *pre-parse gate*), not a
 third file. The real pre-change inventory (before) is **two functions × two files**:
   `renumber.ts:436-441` + its gate in `applyRenumbering`, and `client.ts:942-946` + `client.ts:955-963`.

Route it to `common` anyway and you must move a helper whose only consumers are in `bootstrapped` down into
`common`, in a package whose target tree (DESIGN §4.2:262) places it in `coexistence/`, and you would put an
*untyped* predicate next to `common/src/protocol/envelope.ts`'s `isWrappedFrame` (`:134`), which is a
different thing (a *typed* guard over an already-built union). DESIGN §3.1 rule 2 (a helper that exists in
two packages is a missing common module) does not apply: this helper exists in one package.
**Recommendation: keep the landed home, `bootstrapped/src/coexistence/envelope.ts`.** What the brief's ruling
actually pins down ("keep the cheap pre-filter as a fast path, drop the redundant guard, route every copy
through one predicate") is honoured exactly by the landed work. If the reviewer insists on `common`, the only
edit is a `git mv` plus import updates. The module has no `bootstrapped`-specific imports, so both homes
typecheck; note that `bootstrapped/src/index.ts` would then need `asEnvelope`/`asCommandEnvelope` pointed at
the common re-export.

**Copies deleted**: already done; quoted as they were **before** that commit:

```ts
// packages/bootstrapped/src/coexistence/renumber.ts:436-441: DELETED
export function asEnvelope(frame: unknown): CommandEnvelope | null {
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return null;
  const record = frame as Record<string, unknown>;
  if (record['type'] !== 'QuinoaCommand') return null;
  return record;
}

// packages/bootstrapped/src/client.ts:942-946: DELETED
export function asEnvelope(value: unknown): CommandEnvelope | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return record['type'] === 'QuinoaCommand' ? record : null;
}

// packages/bootstrapped/src/client.ts:955-963: DELETED
export function parseEnvelope(raw: string): CommandEnvelope | null {
  if (typeof raw !== 'string' || raw.length < 16) return null;
  if (!raw.includes('QuinoaCommand')) return null;
  try {
    return asEnvelope(JSON.parse(raw));
  } catch {
    return null;
  }
}
```

and the redundant guard, `packages/bootstrapped/src/client.ts:977`:

```ts
  if (renumberer.isOurs(envelope.requestId)) return data;   // DELETED: rewrite() re-checks at renumber.ts:333
```

 also went further than this task's brief required: `applyRenumberingToString`'s **body** is gone
entirely, replaced by an alias at `packages/bootstrapped/src/client.ts:955`:

```ts
export { applyRenumbering as applyRenumberingToString } from './coexistence/renumber.js';
```

That is strictly better than keeping a string-path implementation that shares the gate but not the code. The
third copy of the *shape* is gone, not just the third copy of the predicate. It also means `parseEnvelope`'s
public home is `envelope.ts`, and `client.ts:942`'s `export { asEnvelope, parseEnvelope }` is a pure
re-export.

**Change.**

1. **Nothing to do: verify it instead.** `git show --stat and confirm the four acceptance
 greps below. is the right fix and it was placed at the **call site** rather than inside the shared
   function (step 2 explains why that is the better of the two shapes). If a later task needs to touch
   `raw-socket.ts`, the guard is a self-contained hunk.

2. **3.3a (landed):** the guard sits at the seam, not inside the shared function:

   ```ts
 // packages/bootstrapped/src/attach/raw-socket.ts:325-342: as committed
   wrap: (previous) =>
     function interceptedSocketSend(this: unknown, data: unknown): unknown {
       // A rewrite failure must never drop the game's frame. `coexistence/renumber.ts` wraps its own hook
       // for this reason (…), but this path calls the rewriter directly, so the promise has to be
       // kept here as well: a throw would otherwise escape into the host's own `send` and the frame would
       // never leave the browser. Sending the original is the safe answer (I7).
       let result: unknown;
       try {
         result = rewriteForCoexistence(data);
       } catch {
         result = data;
       }
       if (typeof previous === 'function') {
         return (previous as (this: unknown, d: unknown) => unknown).call(this, result);
       }
       return original.call(this, result);
     } as (...args: never[]) => unknown,
   ```

   This is the **other** correct shape, and with `applyRenumberingToString` now an alias it is the *better*
   one: the room path guards every interceptor at the seam (`room-connection.ts:413-423`, *"An interceptor
   that throws leaves the payload as it was; never drop the host's frame"*), so guarding at the seam here
   makes both attachment paths symmetrical, and it also protects a caller that installs its own rewriter
   through `installOutboundRewriter` (`raw-socket.ts:512-521`). The one thing it does **not** do is make
   `applyRenumbering(data, renumberer)` itself total, so a direct caller can still throw. That is acceptable
   because `applyRenumbering` is no longer reached from a game-owned call path on its own; note it in the
   commit body so the next reader knows the totality lives at the seam.

3. Keep every public name. `bootstrapped/src/index.ts:51` (`asEnvelope` from `./client.js`) and `:174`
   (`asEnvelope as asCommandEnvelope` from `./coexistence/renumber.js`) keep working because `client.ts:942`
   and `renumber.ts:57` now *re-export* rather than declare. `CommandEnvelope` likewise
   (`renumber.ts:57`). Confirm with `git grep -n "asEnvelope" -- packages/bootstrapped/src/index.ts` after the
   commit.

4. **Do not** create `bootstrapped/src/coexistence/outbound.ts`. DESIGN §4.2:262 lists it; Phase 3 does not
   need it, and creating an empty module to satisfy a tree diagram is worse than recording the deviation.
   Note it in the commit body so Phase 5.2/5.4 can decide.

**Test first.** `packages/bootstrapped/tests/envelope-owner.test.ts` is the right shape and is committed: its
structural test asserts **function identity** (`assert.equal(asEnvelopeFromClient, asEnvelope)`) so a fourth
copy is a different object and fails.

For 3.3a the failing-first test is behavioural and is committed, in
`packages/bootstrapped/tests/raw-socket.test.ts`:

```ts
describe('bindRawSocket: a fault in the rewriter must not eat the host frame', () => {
  it('forwards the original frame when the coexistence rewriter throws', () => {
    const page = pageWithSocket();
    const binding = bindRawSocket({ page: page as unknown as PageRealm });
    try {
      assert.equal(
        installOutboundRewriter(binding, () => { throw new Error('the rewriter exploded'); }),
        true,
        'the rewriter seam must be reachable, or this test proves nothing at all',
      );
      const Patched = page['WebSocket'] as new (url: string) => CountingSocket;
      const socket = new Patched(ROOM_URL);
      const frame = '{"type":"QuinoaCommand","commandSequence":7}';
      assert.doesNotThrow(() => socket.send(frame), "a rewriter fault must not surface in the game's send");
      assert.deepEqual(socket.sent, [frame], 'the host frame must still go out, unrenumbered');
    } finally {
      binding.release();
    }
  });
});
```

Observed before, at the call-site guard's absence: `socket.send(frame)` **throws** `Error: the rewriter
exploded` out of `interceptedSocketSend`, so the frame never reaches `socket.sent`. That is a desync, which the
rewriter's own doc calls strictly worse than the duplicate sequence it exists to prevent. Revert the
`raw-socket.ts` hunk alone to watch it go red.

**Acceptance.**

- `npm test -w @mg.js/bootstrapped` green, including the two identity assertions and the raw-socket fault test.
- `npm run verify` green.
- Exactly one copy remains: `git grep -c "function asEnvelope" -- packages/bootstrapped/src` → `1`
  (`envelope.ts:59`); `git grep -c "function parseEnvelope" -- packages/bootstrapped/src` → `1`
  (`envelope.ts:77`); `git grep -n "isOurs(envelope.requestId)" -- packages/bootstrapped/src` → exactly one
  hit, `renumber.ts:333`, inside `rewrite`; `git grep -n "MIN_ENVELOPE_LENGTH\|length < 16" -- packages/bootstrapped/src` → the constant's declaration plus its single use, both in `envelope.ts`.
- The string path is gone, not just deduped: `git grep -c "JSON.parse" -- packages/bootstrapped/src/attach/raw-socket.ts` → `0`, and `client.ts` contains no `Function` body for `applyRenumberingToString` (only `:955`'s re-export).
- Add the repo-wide scan to the phase gate (`packages/bootstrapped/tests/one-home.test.ts`, Verification
  plan below) so a fourth copy is caught by `npm test`, not by a grep a reviewer has to remember.

**Risk / revert.** Drift between the merged copies, as it was:

- `renumber.ts`'s `asEnvelope` gated on `record['type'] !== 'QuinoaCommand'`; `client.ts`'s returned
  `record['type'] === 'QuinoaCommand' ? record : null`. **Identical** for every input (both reject `null`,
  non-objects and arrays; both return the same reference). The landed survivor keeps the `renumber.ts`
  formulation, so the *returned reference* is unchanged for every caller.
- `renumber.ts`'s gate lived in `applyRenumbering` as `data.length < 16` then `data.includes(...)`; the
  client's lived in `parseEnvelope`. The survivor hoists the constant to `MIN_ENVELOPE_LENGTH = 16`
  (`envelope.ts:33`) gives the same value, the same order and the same result.
- The command **`JSON.parse` count along the string path drops from two to one**: `applyRenumberingToString`
  parsed the raw string itself (via `parseEnvelope`) *and* `applyRenumbering` re-parsed the same string. After
  the alias there is one parse, in `parseEnvelope`. That is a performance improvement, not a behaviour change,
  and `envelope-owner.test.ts`'s "our own frame consumes no number" characterisation pins the observable half.
- The one real behaviour change is 3.3a, and it is a **tightening**: a throwing `rewrite` previously
  propagated into the host's `send`. Name it in the commit body ("a rewriter throw is swallowed at the
  raw-socket seam, matching the room path; the shared `applyRenumbering` stays non-total by design").
- Revert: `git revert <commit>` for the dedupe and `git revert <commit>` for the guard. The guard is a
  self-contained hunk and the two are independent, so either can be reverted alone.

---

## Task 3.1: `Unsubscribe`, one declaration, in `common/src/unsubscribe.ts`

**Status: COMPLETE**: `common/src/unsubscribe.ts:12` is the one declaration; the three copies
(`state/store.ts`, `transport/types.ts`, `headless/room-socket.ts`) and `state/index.ts`'s workaround
comment are gone. Guard: `packages/common/tests/unsubscribe.test.ts` (source-text scan over
`packages/*/src`).

**Correction (the acceptance as written was unsatisfiable).** The check at `:518` expects
`git grep -n "export type Unsubscribe" -- packages` → one hit. It returns **two**:
`common/src/unsubscribe.ts:12` and `common/tests/unsubscribe.test.ts:16`, because the new guard's own
regex literal `/^\s*export type Unsubscribe\b\s*=/m` contains the searched text. The grep means "one
declaration" only when scoped to `packages/*/src`. The companion check at `:519`
(`type Unsubscribe` in `packages/headless` → 0) does hold.

**Surviving copy.** The declaration is one line with no behaviour, so "best" means *the home that removes the
workaround*. DESIGN §4.2:220 names it: `unsubscribe.ts  NEW: the single Unsubscribe declaration`. The master
plan table (`:691`) agrees. **This supersedes `docs/audit/22-xcut-conventions.md`'s recommendation** to keep
it in `common/src/transport/types.ts`. That file is about the transport seam, and `state` and `emitter` both
return an `Unsubscribe` without being transports. Record the supersession in the commit body.

**Copies deleted**: exactly three, all declarations:

```ts
// packages/common/src/state/store.ts:22-23
/** Detaches a subscriber. */
export type Unsubscribe = () => void;
```

```ts
// packages/common/src/transport/types.ts:14-15
/** Detaches a listener. */
export type Unsubscribe = () => void;
```

```ts
// packages/headless/src/room-socket.ts:53-54
/** Detaches a listener. */
export type Unsubscribe = () => void;
```

and the documented workaround it forced, `packages/common/src/state/index.ts:18-20`:

```ts
// `Unsubscribe` is intentionally not re-exported here: `./transport/index.js` exports the same shape,
// and the package barrel re-exports both, so exporting it twice would be ambiguous.
export type { ObservableStoreOptions, StateChange, StateSubscriber } from './store.js';
```

**Change.**

1. Create `packages/common/src/unsubscribe.ts`:

   ```ts
   /**
    * The one declaration of "a function that detaches a listener".
    *
    * `Unsubscribe` is the return type of every subscription in this repository: the transport seam
    * (`onMessage`/`onOpen`/`onClose`), the store (`subscribe`/`subscribeAll`), the emitter, and the events
    * on all four client classes. It was declared three times: here, in `transport/types.ts`, and again in
    * `@mg.js/headless`'s `room-socket.ts`. That forced `state/index.ts` to carry a comment explaining
    * which of the two identical names it was *not* exporting. A type with three homes is three chances to
    * change one and not the others, and a consumer importing both packages got a nominal clash for what is
    * one concept.
    */
   export type Unsubscribe = () => void;
   ```

2. `common/src/state/store.ts`: delete lines 22-23, add `import type { Unsubscribe } from '../unsubscribe.js';`
   beside the existing imports (`:17-20`). Internal uses at `:196, 225, 244` are unchanged.
3. `common/src/transport/types.ts`: delete lines 14-15, add the same import (path `'../unsubscribe.js'`).
   Internal uses at `:68, 71, 74` unchanged.
4. `common/src/state/index.ts`: replace the comment block with
   `export type { Unsubscribe } from '../unsubscribe.js';` (add it to the `:20` line group). This *adds* a
   name to `@mg.js/common/state`; nothing is removed, because the package barrel already advertised it.
5. `common/src/transport/index.ts:10`: keep the re-export, retarget the target file:
   `export type { ... Unsubscribe } from '../unsubscribe.js';` (the other five names stay in `./types.js`, so
   split the statement).
6. `common/src/index.ts`: the two `export *` (`:45, :46`) now re-export the *same declaration* twice. That is
   legal (**verified**: TS 5.9.3, `tsc --strict --module nodenext`, exit 0, with `index.ts` star-exporting two
   modules that both re-export one `type Unsubscribe` from a third). Add an explicit line anyway, above
   `:45`, because an explicit export wins over a star export and it makes the intent legible:
   `export type { Unsubscribe } from './unsubscribe.js';`
7. `common/src/client.ts:43`: `import type { StateChange, Unsubscribe } from './state/store.js';` becomes
   two imports: `StateChange` from `./state/store.js`, `Unsubscribe` from `./unsubscribe.js`.
8. `headless/src/room-socket.ts`: delete lines 53-54 and add `Unsubscribe` to the existing
   `@mg.js/common` type import at `:41-49`. There is no new import edge: the file already imports
   `buildConnectUrl` from the same package on `:50`.
9. **Do not** add `Unsubscribe` to `headless/src/index.ts`. That file states its rule at `:16-18` ("It
   re-exports nothing from `@mg.js/common` by design"), and nothing disappears: `@mg.js/headless` never
   exported the name. This is a deliberate deviation from audit 22 §4's "re-exporting it from `common` and
   from `headless/src/index.ts`".
10. No `package.json` `exports` change: no new subpath and no new public name.

**Test first.** A type alias has no runtime identity, so the only honest "fourth copy cannot appear" test is a
**source-declaration scan**. New file `packages/common/tests/unsubscribe.test.ts`:

```ts
/**
 * `Unsubscribe` has exactly one declaration.
 *
 * A type alias is erased at runtime, so there is no value to compare and no way to catch a second copy
 * with a behavioural assertion. The copy *is* the declaration, so the assertion is on the source text,
 * the same technique `build-output.test.ts` and `exports-map.test.ts` already use on artifacts.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DECLARATION = /^\s*export type Unsubscribe\b\s*=/m;

function everySourceFile(): string[] {
  const out: string[] = [];
  for (const pkg of ['common', 'headless', 'bootstrapped']) {
    const root = join(repoRoot, 'packages', pkg, 'src');
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.ts')) out.push(join(entry.parentPath, entry.name));
    }
  }
  return out;
}

void test('exactly one file in `packages/*/src` declares `Unsubscribe`', () => {
  const declaring = everySourceFile().filter((file) => DECLARATION.test(readFileSync(file, 'utf8')));
  assert.deepEqual(
    declaring.map((file) => file.slice(repoRoot.length + 1)),
    ['packages/common/src/unsubscribe.ts'],
    'a second declaration is a second identity for one concept',
  );
});

void test('the three consumers reach that one declaration', () => {
  const store = readFileSync(join(repoRoot, 'packages/common/src/state/store.ts'), 'utf8');
  const transport = readFileSync(join(repoRoot, 'packages/common/src/transport/types.ts'), 'utf8');
  const socket = readFileSync(join(repoRoot, 'packages/headless/src/room-socket.ts'), 'utf8');
  for (const [name, source] of [
    ['state/store.ts', store],
    ['transport/types.ts', transport],
    ['headless/room-socket.ts', socket],
  ] as const) {
    assert.match(source, /from '\.\.\/unsubscribe\.js'|Unsubscribe,/s, `${name} must import it, not declare it`);
  }
});
```

Observed failure before the change: test 1 fails with
`expected [ 'packages/common/src/state/store.ts', 'packages/common/src/transport/types.ts', 'packages/headless/src/room-socket.ts' ] to deeply equal [ 'packages/common/src/unsubscribe.ts' ]`.
That is three real copies, found by the same mechanism that will guard the fix.

**Acceptance.**

- `npm run verify` green. `tsc -b --force` proves the star-export disambiguation; `tsc -p tsconfig.tests.json`
  proves `readdirSync(..., { recursive: true })` and `entry.parentPath` typecheck (Node 20.12+; the workspace
  floor is `node >= 20`, and `@types/node@^24` declares both. If `parentPath` is absent in the installed
  types, use `join(entry.path, entry.name)`).
- `git grep -n "export type Unsubscribe" -- packages` → one hit.
- `git grep -rn "type Unsubscribe" -- packages/headless` → zero hits.
- No surface disappears: `node -e "import('@mg.js/common').then(m=>...)"` is unnecessary (a type has no runtime
  presence); instead run `npm run build && npm test -w @mg.js/headless` (the `exports-map.test.ts` built-export
  assertions) and confirm the emitted `packages/headless/dist/room-socket.d.ts` still types `onWelcome` as
  `(): Unsubscribe` with `Unsubscribe` imported from `@mg.js/common`.

**Risk / revert.** Drift between the three copies:

- `state/store.ts`'s doc said *"Detaches a subscriber"*, `transport/types.ts`'s and `room-socket.ts`'s said
  *"Detaches a listener"*. Cosmetic only; the survivor uses the subscriber-neutral wording.
- All three were `() => void`, so there is **zero structural drift**, and this is the safest task in the phase.
- Declaration-file change: `packages/headless/dist/room-socket.d.ts` will now `import type { Unsubscribe }
  from '@mg.js/common'` instead of declaring it inline. Any consumer that wrote
  `import type { Unsubscribe } from '@mg.js/headless'` was already broken (the name was never exported).
  Confirm with `git grep -n "Unsubscribe" -- README.md docs` before committing, and if the README documents
  such an import, that is a doc bug to fix in the same commit.
- Revert: `git revert <sha>`; the three declarations come back verbatim.

---

## Task 3.2: one `Emitter`, with a per-host listener-failure policy

**Status: COMPLETE** for Survivor `common/src/emitter.ts` (with `on/once/off/clear` and the
per-host failure policies); the hand-written dispatch loops in `headless/src/client.ts` and
`bootstrapped/src/attach/transport.ts` are gone. Guards: `common/tests/emitter.test.ts`,
`headless/tests/emitter.test.ts`, `bootstrapped/tests/emitter.test.ts`.

**Corrections (the acceptance as written was unsatisfiable).** Both checks at `:809` are false over the
scope they name:

- `git grep -n "listeners = new Map" -- packages` → the plan says `0`; it returns **4**:
  `common/src/emitter.ts:15` (the surviving copy, by design) plus three test doubles
  (`bootstrapped/tests/raw-socket.test.ts:39`, `bootstrapped/tests/room-upgrade.test.ts:96`,
  `headless/tests/helpers/fake-socket.ts:35`).
- `git grep -c "for (const handler of \[\.\.\.this" -- packages/bootstrapped packages/headless` → the plan
  says `0`; it returns **4**, all in test doubles (`bootstrapped/tests/attach.test.ts:91,96` and
  `room-upgrade.test.ts:432,454`). That is, the suite's own test doubles contain the literal the check
  forbids.

Both only mean "gone from `src`" if scoped to `packages/*/src`, which the plan's own phase-gate table
(`:2509`) does for the emitter-dispatch row.

**Surviving copy.** `packages/common/src/emitter.ts` (73 lines). It is already public
(`common/src/index.ts:19-20`), already the base class of `ClientCore`
(`common/src/client.ts:133`, `export class ClientCore extends Emitter<ClientEvents>`), already
zero-dependency and platform-free, and its `off` is the only one of the copies that **deletes an emptied
`Set`** (`emitter.ts:42`), which the headless copy does not.

**Copies deleted.**

```ts
// packages/headless/src/client.ts:288: the hand-rolled listener map
private readonly listeners = new Map<keyof HeadlessClientEvents, Set<(...args: never[]) => void>>();
```

```ts
// packages/headless/src/client.ts:503-517: `on`, with a detacher that leaks the empty Set
  on<TKey extends keyof HeadlessClientEvents>(
    event: TKey,
    listener: (...args: HeadlessClientEvents[TKey]) => void,
  ): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (...args: never[]) => void);
    return () => {
      set?.delete(listener as (...args: never[]) => void);
    };
  }
```

```ts
// packages/headless/src/client.ts:519-529: `once`
  once<TKey extends keyof HeadlessClientEvents>(
    event: TKey,
    listener: (...args: HeadlessClientEvents[TKey]) => void,
  ): Unsubscribe {
    const off = this.on(event, ((...args: HeadlessClientEvents[TKey]) => {
      off();
      listener(...args);
    }) as (...args: HeadlessClientEvents[TKey]) => void);
    return off;
  }
```

```ts
// packages/headless/src/client.ts:1047-1060: the private dispatch loop
  private emit<TKey extends keyof HeadlessClientEvents>(
    event: TKey,
    ...args: HeadlessClientEvents[TKey]
  ): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as (...a: HeadlessClientEvents[TKey]) => void)(...args);
      } catch (error) {
        this.logger.error(`listener for "${String(event)}" threw`, error);
      }
    }
  }
```

and the hand-clear at `packages/headless/src/client.ts:642` (`this.listeners.clear();`).

Two more dispatch families:

```ts
// packages/headless/src/transport/client.ts:152-154: three parallel Sets
  private readonly messageHandlers = new Set<(raw: string) => void>();
  private readonly openHandlers = new Set<() => void>();
  private readonly closeHandlers = new Set<(info: TransportCloseInfo) => void>();
```
```ts
// packages/headless/src/transport/client.ts:531-559: three hand-written dispatch loops
  private emitMessage(raw: string): void {
    for (const handler of [...this.messageHandlers]) {
      try { handler(raw); } catch (error) { this.lastErrorValue = error; }
    }
  }
  private emitOpen(): void { /* identical shape */ }
  private emitClose(info: TransportCloseInfo): void { /* identical shape */ }
```

```ts
// packages/bootstrapped/src/attach/transport.ts:122-124: three parallel Sets
  private readonly messageHandlers = new Set<(raw: string) => void>();
  private readonly openHandlers = new Set<() => void>();
  private readonly closeHandlers = new Set<(info: TransportCloseInfo) => void>();
```
plus its **five** dispatch loops that iterate `[...this.messageHandlers]` or `[...this.closeHandlers]`
directly: `:142-148`, `:160-166`, `:291-297`, `:452-458`, `:461-474`.

**Change.**

1. `common/src/emitter.ts`: make the failure policy an overridable hook and give the surface one name for
   "drop everything":

   ```ts
   /**
    * Called when a listener throws.
    *
    * The default is to swallow, because this emitter carries state-sync events and one throwing subscriber
    * must not prevent the others from seeing the update or unwind into the socket's message handler. A host
    * that needs to *observe* the failure (to log it, or to record it) overrides this rather than
    * reimplementing `emit`.
    */
   protected onListenerError(_event: keyof TEvents, _error: unknown): void {
     // Intentionally isolated.
   }

   emit<TKey extends keyof TEvents>(event: TKey, ...args: TEvents[TKey]): void {
     const set = this.listeners.get(event);
     if (!set) return;
     for (const listener of [...set]) {
       try {
         (listener as unknown as Listener<TEvents[TKey]>)(...args);
       } catch (error) {
         this.onListenerError(event, error);
       }
     }
   }

   /** Drop every listener. */
   clear(): void {
     this.listeners.clear();
   }

   /** @deprecated Use {@link clear}. Kept so the existing callers keep working. */
   removeAllListeners(): void {
     this.clear();
   }
   ```

   `on`, `once`, `off`, `listenerCount` are unchanged. Additive only.

2. `headless/src/client.ts`:
   - `export class HeadlessClient extends Emitter<HeadlessClientEvents> {` (replacing `export class
     HeadlessClient {`, `:272`).
   - **Convert `HeadlessClientEvents` from an `interface` to a `type` alias** (`:139`). This is required, not
     cosmetic: `Emitter<TEvents extends EventMap>` constrains `TEvents` to
     `Record<string, unknown[]>`, and an interface has no implicit index signature. **Verified** with
     `tsc --strict`: `error TS2344: Type 'IfaceEvents' does not satisfy the constraint 'EventMap'. Index
     signature for type 'string' is missing in type 'IfaceEvents'.` The `type` alias form compiles. This is
     the same reason `common/src/client.ts:55-58` documents for `ClientEvents`.
   - Delete the `listeners` field (`:288`), `on` (`:503-517`), `once` (`:519-529`) and the private `emit`
     (`:1047-1060`).
   - Add the policy override:

     ```ts
     protected override onListenerError(event: keyof HeadlessClientEvents, error: unknown): void {
       this.logger.error(`listener for "${String(event)}" threw`, error);
     }
     ```

   - `destroy()` (`:638-643`): `this.clear();` instead of `this.listeners.clear();`.
   - **Breaking/surface notes for the commit body:** (a) `HeadlessClientEvents` becomes a type alias, so
     `declare module '@mg.js/headless' { interface HeadlessClientEvents { ... } }` augmentation stops merging.
     That is pre-1.0 and allowed, and no code in this repo does it; (b) `HeadlessClient.emit` becomes public
     (inherited) where it was `private`; that only widens, and `ClientCore.emit` is already public.
     `eventNames()` (`:538-549`) is unchanged.

3. `headless/src/transport/client.ts`:
   - Replace the three Sets (`:152-154`) with
     `private readonly events = new Emitter<TransportEvents>();` where
     `type TransportEvents = { message: [string]; open: []; close: [TransportCloseInfo] };` (a `type`, for
     the same index-signature reason).
   - `onMessage`/`onOpen`/`onClose` (`:378-397`) become one-liners: `return this.events.on('message', handler);`
     etc.
   - Delete `emitMessage`/`emitOpen`/`emitClose` (`:531-559`) and call `this.events.emit('message', raw)`,
     `this.events.emit('open')`, `this.events.emit('close', info)` at `:476` and `:502` and `:270`.
   - Add `protected override onListenerError(_event: keyof TransportEvents, error: unknown): void { this.lastErrorValue = error; }`.
   - `dispose()`'s three `.clear()` calls (`:440-442`) become `this.events.clear()`.

4. `bootstrapped/src/attach/transport.ts`:
   - Same substitution (`:122-124` → `private readonly events = new AttachedTransportEvents = ...`), the five
     loops replaced by `this.events.emit(...)`, and `onMessage`/`onOpen`/`onClose` (`:391-425`) become
     adapters.
   - **No `onListenerError` override**: this transport's current behaviour is to swallow silently, with the
     comment *"must never reach the game's dispatch"*. `Emitter`'s default already does exactly that.
   - Keep `this.detachers` (`:125`), which are sink subscriptions, not event listeners.

**Test first.** New `packages/common/tests/emitter.test.ts`. Before the change `onListenerError` and `clear`
do not exist, so it fails to compile *and* the behavioural assertion fails; write the behavioural half so it
runs:

```ts
void test('a throwing listener is isolated and reported to onListenerError', () => {
  const seen: Array<[string, unknown]> = [];
  class Probe extends Emitter<{ ping: [number] }> {
    protected override onListenerError(event: keyof { ping: [number] }, error: unknown): void {
      seen.push([String(event), error]);
    }
  }
  const probe = new Probe();
  const order: string[] = [];
  probe.on('ping', () => { order.push('first'); });
  probe.on('ping', () => { throw new Error('bad handler'); });
  probe.on('ping', (n) => { order.push(`third:${n}`); });
  probe.emit('ping', 7);
  assert.deepEqual(order, ['first', 'third:7'], 'one bad handler must not stop the others');
  assert.equal(seen.length, 1);
});

void test('off deletes an emptied event, and clear drops every listener', () => {
  const e = new Emitter<{ a: []; b: [] }>();
  const off = e.on('a', () => {});
  assert.equal(e.listenerCount('a'), 1);
  off();
  assert.equal(e.listenerCount('a'), 0);
  e.on('a', () => {}); e.on('b', () => {});
  e.clear();
  assert.equal(e.listenerCount('a') + e.listenerCount('b'), 0);
});

void test('a reused detacher cannot resurrect a listener after destroy', () => {
  // Characterises the leak the headless copy had: its detacher captured the *Set* and deleted from it
  // after `clear()` had replaced nothing, so a detacher kept past destroy silently did nothing, while
  // `listenerCount` (which the copy did not have) is what would have shown the leak.
  const e = new Emitter<{ a: [] }>();
  const off = e.on('a', () => {});
  e.clear();
  off();
  assert.equal(e.listenerCount('a'), 0);
});
```

And new `packages/headless/tests/emitter.test.ts`:

```ts
void test('HeadlessClient is an Emitter, and keeps its own failure policy', () => {
  assert.ok(new HeadlessClient({ version: '9999' }) instanceof Emitter, 'extends, does not re-implement');
});

void test('headless src declares no listener map of its own', () => {
  const source = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /new Map<keyof HeadlessClientEvents/, 'the map has one home: Emitter');
  assert.match(source, /class HeadlessClient extends Emitter<HeadlessClientEvents>/);
});
```

Observed failures before: `TS2339: Property 'onListenerError' does not exist` / `Property 'clear' does not
exist`; `expected HeadlessClient{} to be an instance of Emitter`; and the source scan matches
`new Map<keyof HeadlessClientEvents` at `client.ts:288`. Three independent failures.

**Acceptance.**

- `npm run verify` green, `npm test -w @mg.js/headless` green (the `on`/`once`/`eventNames` behaviour is
  covered by `headless/tests/integration.test.ts` and `room-socket.test.ts`).
- `git grep -n "listeners = new Map" -- packages` → 0; `git grep -c "for (const handler of \[\.\.\.this" -- packages/bootstrapped packages/headless` → 0.
- `node --input-type=module -e "import('@mg.js/headless').then(m => console.log(new m.HeadlessClient() instanceof (await import('@mg.js/common')).Emitter))"` after `npm run build` → `true`.
- Add to the phase gate's source scan: no `packages/*/src` file outside `common/src/emitter.ts` contains
  `for (const listener of [` over a listener set.
- Bundle size still inside budget (`npm run size`). This task *shrinks* the userscript.

**Risk / revert.** Drift between the four dispatch behaviours, and how the merge preserves each:

| copy | failure policy | where it lands after the merge |
|---|---|---|
| `common/src/emitter.ts:56-60` | swallow, no record | `Emitter`'s default `onListenerError` |
| `headless/src/client.ts:1056-1058` | `this.logger.error(...)` | `HeadlessClient.onListenerError` override |
| `headless/src/transport/client.ts:535-537, 545-547, 555-557` | `this.lastErrorValue = error` | `StandaloneTransport.onListenerError` override |
| `bootstrapped/src/attach/transport.ts` (5 loops) | swallow | `Emitter`'s default |

Other drift, enumerated:

- **Detacher behaviour.** `emitter.ts`'s `on` returns `() => this.off(event, listener)`, which deletes the
  emptied `Set`; `headless/src/client.ts:514-516` returned `() => { set?.delete(...) }`, which leaves an empty
  `Set` per event name ever subscribed and keeps a stale `Set` alive after any future `clear()`. The merge is
  a **fix** (the map can no longer retain a `Set` for an event nobody listens to), not a regression; it is
  observable only through `listenerCount`, which the headless copy did not have. Name it in the commit body.
- **Iteration snapshot.** `emitter.ts:55` and `headless/src/client.ts:1053` both iterate `[...set]`;
  `bootstrapped/src/attach/transport.ts:142, 160` also spread. No drift.
- **`once` re-entrancy.** `emitter.ts:29-35` and `headless/src/client.ts:520-529` are the same
  call-`off`-then-`listener` sequence. No drift.
- **`common`'s `ClientCore` keeps swallowing** (it never overrode `emit`), so no existing `common` test
  changes meaning.
- Revert: `git revert <sha>`. The three deleted dispatch families come back verbatim; the only subtlety is
  the `interface`→`type` change for `HeadlessClientEvents`, which a revert also restores.

---

## Task 3.4: `pollUntil` / `watchUntil`, one deadline poll

**Status: COMPLETE**, with the DESIGN §4.2 `poll.ts` row added. The five production
loops (`attach/detect.ts` ×2, `render/ctors.ts`, `jotai/bridge.ts`, `attach/transport.ts`) and the test
helpers are one implementation in `common/src/poll.ts`, re-exported at `common/src/index.ts:43`. Guard:
`common/tests/poll.test.ts` (327 lines at the boundary, 369 after 3.4b), plus the pre-existing call-site tests.

**Corrections (all verified against the tree).**

- **Wrong package for the I9 guard.** `:1263` places the platform-free guard at
  `packages/bootstrapped/tests/poll-platform-free.test.ts`. It landed in **`common`** instead:
  `packages/common/tests/poll.test.ts:303`, `` `common/src/poll.ts` names no timer global and no platform
  API ``, which is where DESIGN §4.3's mirror rule puts a `common` module's guard. No bootstrapped
  `poll-platform-free.test.ts` exists.
- **The timing regression net was misattributed.** `:1289` says the first-attempt pin is `attach.test.ts`'s
  "does not fire before the interval" assertions. `attach.test.ts` (501 lines) contains **no** such test, and
  `grep -n 'interval\|fire before\|firstAttempt'` gives 0 matches. The pin is
  `common/tests/poll.test.ts:132` (`firstAttempt: 'afterInterval' waits one interval before the first
  attempt`), which is exactly where the same paragraph says to assert it.
- **Acceptance (c) at `:1277` is false.** `git grep -c "Date.now() - startedAt\|Date.now() - start" --
  packages/*/src` → the plan says `0`; it returns `bootstrapped/src/catalog/bundle.ts:1`
  (`` :338 capture.detachedAfterMs = Date.now() - startedAt; ``, which is the capture-window metric, not a
  deadline poll, and never in 3.4's scope).
- **Acceptance (d) at `:1279` is false.** `git grep -c "const tick = " -- packages/*/src` → the plan says
  `0`; it returns `common/src/poll.ts:1` (`` :101 const tick ``), the survivor's own loop. The check cannot
  pass as written.

**Surviving copy.** None exists; the five loops disagree on the only interesting question. The survivor's
*shape* is `attach/detect.ts:361-416` (`watchForRoomConnection`): it is the only copy that already takes both
`schedule` and `cancelSchedule`, already has a `stop()` that suppresses a pending delivery, and already
separates "found" from "timed out with a callback". `render/ctors.ts:824-876`'s rejection message is the best
error text and is preserved by moving the rejection to the call site.

**Copies deleted.**

```ts
// packages/bootstrapped/src/attach/detect.ts:270-307: `waitForAttachment`'s loop
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 250;
  const schedule =
    options.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const page = options.page ?? getPage();
  const startedAt = Date.now();

  return await new Promise<Attachment>((resolve) => {
    const attempt = (): void => {
      const candidate = detectAttachment({ ...options, page });
      if (candidate.kind !== 'none') { resolve(candidate); return; }
      candidate.release();
      if (Date.now() - startedAt >= timeoutMs) {
        resolve(detectAttachment({ ...options, page }));
        return;
      }
      schedule(attempt, intervalMs);
    };
    schedule(attempt, intervalMs);
  });
```

```ts
// packages/bootstrapped/src/attach/detect.ts:375-385, 387-415: the `cancelled`/`timer`/`tick`/`stop` body
  let cancelled = false;
  let timer: unknown = null;
  const startedAt = Date.now();
  const stop = (): void => { cancelled = true; if (timer !== null) { cancelSchedule(timer); timer = null; } };
  const tick = (): void => { /* hasRoomConnection / detectAttachment / deadline / reschedule */ };
  timer = schedule(tick, intervalMs);
  return stop;
```

```ts
// packages/bootstrapped/src/render/ctors.ts:843-875: `getCtors`'s loop
  return await new Promise<PixiCtors>((resolve, reject) => {
    const startedAt = Date.now();
    let attempts = 0;
    const attempt = (): void => {
      attempts += 1;
      const root = explicitStage ?? stageRoot ?? capturedApplication?.stage ?? null;
      const derived = root === null ? null : deriveCtors(root);
      if (derived !== null) { …; if (hasCoreCtorSet(derived)) { resolve(derived); return; } }
      if (Date.now() - startedAt >= timeoutMs) { reject(new PixiCtorsTimeoutError(/* … */)); return; }
      schedule(attempt);
    };
    attempt();
  });
```

```ts
// packages/bootstrapped/src/jotai/bridge.ts:471-500: the `retryForMs`/`deadline`/`tick` body
  const retryForMs = options.retryForMs ?? 90_000;
  const retryIntervalMs = options.retryIntervalMs ?? 500;
  const schedule = options.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  if (retryForMs > 0) {
    const deadline = Date.now() + retryForMs;
    let lastSize = -1;
    const tick = (): void => {
      if (!active) return;
      /* Map walk … */
      if (Date.now() >= deadline || capturedSet !== null) return;
      timer = schedule(tick, retryIntervalMs);
    };
    timer = schedule(tick, retryIntervalMs);
  }
```

```ts
// packages/bootstrapped/src/attach/transport.ts:170-183: the readiness poll with NO deadline
    const pollMs = options.readinessPollMs ?? 1_000;
    if (pollMs > 0) {
      const schedule = options.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
      const tick = (): void => {
        if (this.closed) return;
        this.syncReadiness();
        this.timer = schedule(tick, pollMs);
      };
      this.timer = schedule(tick, pollMs);
    }
```

and the three test loops: `packages/headless/tests/integration.test.ts:75-83` (`until`),
`packages/bootstrapped/tests/room-upgrade.test.ts:149-156` (`waitUntil`), and the two inline loops in
`packages/headless/tests/room-socket.test.ts:192-196` and `:215-218`.

**Drift, enumerated** (this is where a blind merge changes behaviour):

| site | first attempt | end-of-window outcome | window | interval | scheduler signature |
|---|---|---|---|---|---|
| `detect.ts` `waitForAttachment` `:289-306` | **after** one interval | resolve the *empty* attachment | 20 000 | 250 | `(cb, delayMs)` |
| `detect.ts` `watchForRoomConnection` `:387-414` | **after** one interval | `stop()` + `onTimeout()` | 90 000 | 500 | `(cb, delayMs)` |
| `ctors.ts` `getCtors` `:843-875` | **immediately** (`attempt()` at `:874`) | **reject** with `PixiCtorsTimeoutError` | 15 000 | rAF | **`(cb)` only**, no delay parameter |
| `jotai/bridge.ts` `:476-500` | **after** one interval | silent `return` | 90 000 | 500 | `(cb, delayMs)` |
| `attach/transport.ts` `:174-183` | **after** one interval | **none**, runs until `close()` | ∞ | 1 000 | `(cb, delayMs)` |
| tests: `until` `:76-83` | immediately (predicate first) | `assert.fail` naming the description | 5 000 | 10 | built-in `setTimeout` |
| tests: `waitUntil` `:150-156` | immediately | `throw new Error('condition was not met in time')`, which **names nothing** | 3 000 | 5 | built-in |
| tests: `room-socket.test.ts` `:192-196`, `:215-218` | immediately | silent; the following `assert.equal` reports | 3 000 | 10 | built-in |

**Change.**

1. Create `packages/common/src/poll.ts`. It names no timer global, and the scheduler and clock are injected,
   so it is platform-free by construction and survives Phase 7's tightening of `common`'s `lib`/`types`
   (DESIGN §6 I9). `Date.now` is ES2022 and is the only default.

   ```ts
   /**
    * The one deadline poll, and the one cancellable watch built on it.
    *
    * ## Why this is in `common` rather than in `bootstrapped`
    *
    * The identical loop was written five times: twice in `bootstrapped/attach/detect.ts`, once in
    * `render/ctors.ts`, once in `jotai/bridge.ts` and once in `attach/transport.ts`, and a sixth and seventh
    * time as test helpers in `headless/tests` and `bootstrapped/tests`. The copies disagree about the only
    * question that matters: what a timeout *means* (resolve a fallback / reject / call back / fall silent /
    * never). A caller cannot predict one from another. DESIGN §3.1 rule 2: a helper used from two
    * packages is a missing `common` module.
    *
    * ## Why the scheduler is injected and not defaulted
    *
    * `common` compiles with no DOM and no `node:*` (I9). A `setTimeout` default here would be a new I9
    * violation and would break the moment `common`'s `lib` is narrowed to `ES2022`. So `schedule` is
    * required and each package supplies its own: `setTimeout` in `bootstrapped`, and a fake in tests, which
    * is what makes these loops testable without real time.
    *
    * ## Why there are two functions and not one
    *
    * `pollUntil` answers "wait for it" and `watchUntil` answers "tell me if it ever appears and give me a way
    * to stop looking". A watch cannot be expressed as an awaitable promise without giving the caller a
    * promise it can never cancel, which is the leak (`watchForRoomConnection` is started at
    * `document-start` and outlives the caller that would have awaited it).
    */

   /** How to schedule, cancel and read time. Injected so `common` needs no timer global. */
   export interface PollClock {
     /** Run `callback` after `delayMs`. Returns whatever {@link PollClock.cancelSchedule} understands. */
     schedule: (callback: () => void, delayMs: number) => unknown;
     /** Cancel a handle returned by {@link PollClock.schedule}. Omitted when the caller never cancels. */
     cancelSchedule?: (handle: unknown) => void;
     /** Now, in ms. Default `Date.now`. */
     now?: () => number;
   }

   /** The options both poll forms share. */
   export interface PollOptions<T> extends PollClock {
     /** One attempt. Return the value when it is ready, `null` while it is not. */
     attempt: (attempt: number) => T | null;
     /**
      * Give up after this long. `Number.POSITIVE_INFINITY` means "no deadline" and is legal only for a
      * watch whose handle is always retained and always released, never for a `pollUntil`.
      */
     timeoutMs: number;
     /** How long to wait between attempts. */
     intervalMs: number;
     /**
      * Whether the first attempt runs now or after one interval. Default `'now'`.
      *
      * Both are correct answers to different questions: a caller that has *already* tried and failed
      * (`waitForAttachment` probes once before starting the poll) must not retry into the same frame, while
      * a caller that has not (`getCtors`) must not wait a whole frame to report a value that is already
      * there. Making this explicit is what stops the merge from silently changing either.
      */
     firstAttempt?: 'now' | 'afterInterval';
   }

   /** Options for {@link watchUntil}. */
   export interface WatchUntilOptions<T> extends PollOptions<T> {
     /** Called once, with the first non-null attempt. Never called after the stop has run. */
     onFound: (value: T) => void;
     /** Called once, with the number of attempts made, when the window closes with nothing found. */
     onTimeout?: (attempts: number) => void;
   }

   /** Options for {@link pollUntil}. */
   export interface PollUntilOptions<T> extends PollOptions<T> {
     /** What the window closing means. Default: give up and answer `null`. */
     onTimeout?: (attempts: number) => T | null;
   }

   /**
    * Start a deadline poll. Returns the stop function.
    *
    * The stop is total: it cancels a pending tick *and* suppresses a delivery that is already in flight, so
    * a caller which stops from inside `attempt` is never handed a value afterwards.
    */
   export function watchUntil<T>(options: WatchUntilOptions<T>): () => void {
     const now = options.now ?? Date.now;
     const startedAt = now();
     let stopped = false;
     let handle: unknown = null;
     let attempts = 0;

     const stop = (): void => {
       stopped = true;
       if (handle !== null) {
         options.cancelSchedule?.(handle);
         handle = null;
       }
     };

     const tick = (): void => {
       handle = null;
       if (stopped) return;
       attempts += 1;
       const value = options.attempt(attempts);
       if (stopped) return;
       if (value !== null) {
         stopped = true;
         options.onFound(value);
         return;
       }
       if (now() - startedAt >= options.timeoutMs) {
         stopped = true;
         options.onTimeout?.(attempts);
         return;
       }
       handle = options.schedule(tick, options.intervalMs);
     };

     if (options.firstAttempt === 'afterInterval') handle = options.schedule(tick, options.intervalMs);
     else tick();
     return stop;
   }

   /** Poll until `attempt` answers non-null, or the window closes. */
   export function pollUntil<T>(options: PollUntilOptions<T>): Promise<T | null> {
     return new Promise<T | null>((resolve) => {
       watchUntil<T>({
         ...options,
         onFound: (value) => {
           resolve(value);
         },
         onTimeout: (attempts) => {
           resolve(options.onTimeout?.(attempts) ?? null);
         },
       });
     });
   }
   ```

2. Export both from `packages/common/src/index.ts` (`export type { PollClock, PollOptions, PollUntilOptions,
   WatchUntilOptions } from './poll.js'; export { pollUntil, watchUntil } from './poll.js';`). **No
   `package.json` `exports` change**: `poll.ts` is a bare `common/src` module, which §4.1 permits (like
   `emitter.ts`, `errors.ts`, `log.ts`, `unsubscribe.ts`) and which the `.` barrel already reaches.
   **Also update `docs/DESIGN.md` §4.2's `common` tree** to add the `poll.ts` row; it is currently absent, and
   this is the one doc edit this task owes.

3. `attach/detect.ts`:
   - `waitForAttachment` (`:270-307`) becomes:

     ```ts
     const timeoutMs = options.timeoutMs ?? 20_000;
     const intervalMs = options.intervalMs ?? 250;
     const schedule =
       options.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
     const page = options.page ?? getPage();

     return await pollUntil<Attachment>({
       attempt: () => {
         const candidate = detectAttachment({ ...options, page });
         if (candidate.kind !== 'none') return candidate;
         candidate.release();
         return null;
       },
       // Deferred: `detectAttachment` was already tried immediately above (`:278-280`), so a synchronous
       // first retry would repeat the same failing probe in the same frame.
       firstAttempt: 'afterInterval',
       timeoutMs,
       intervalMs,
       schedule,
       // Hand back the empty attachment rather than rejecting: a mod loaded on a page that will never have
       // the object should still start, and its `transport.state` will say `'idle'` honestly.
       onTimeout: () => detectAttachment({ ...options, page }),
     });
     ```

   - `watchForRoomConnection` (`:361-416`) becomes a thin wrapper that keeps its exact contract (returns
     `stop`, calls `onFound` once, calls `onTimeout` once) on top of `watchUntil`, with
     `firstAttempt: 'afterInterval'`, `timeoutMs: options.timeoutMs ?? 90_000`,
     `intervalMs: options.intervalMs ?? 500`, and the same `cancelSchedule` default. The
     `hasRoomConnection` → `detectAttachment` → release-if-unusable body moves verbatim into `attempt`,
     returning the candidate or `null`.
4. `render/ctors.ts` `getCtors` (`:843-875`): `attempt` returns the derived set when `hasCoreCtorSet`, else
   `null`; `firstAttempt: 'now'` (the default); `schedule: (cb) => schedule(cb)`, an explicit adapter,
   because this site's scheduler is 1-argument (`requestAnimationFrame`) and *ignores* the interval by
   design (documented at `ctors.ts:791-800`). Keep the `PixiCtorsTimeoutError` text exactly: capture `root`
   and the attempt count through a closure written by `attempt`, and throw after the await returns `null`:

   ```ts
   let lastRoot: unknown = null;
   let attempts = 0;
   const derived = await pollUntil<PixiCtors>({
     attempt: (n) => { attempts = n; /* … */ },
     timeoutMs, intervalMs: 16, schedule: (cb) => { schedule(cb); },
   });
   if (derived !== null) return derived;
   throw new PixiCtorsTimeoutError(`mg.js: could not recover the Pixi constructor set within ${timeoutMs}ms …`);
   ```

   The message is asserted by `bootstrapped/tests/ctors.test.ts`; keep it byte-identical.
5. `jotai/bridge.ts` (`:466-500`): `watchUntil` with `firstAttempt: 'afterInterval'`, `timeoutMs:
   retryForMs` (skip the whole watch when `retryForMs <= 0`, preserving the current `if (retryForMs > 0)`
   guard), `intervalMs: retryIntervalMs`, `attempt` returning the atom set when `capturedSet !== null`. Note
   the current code returns on `capturedSet !== null` from *inside* the deadline check, so the merge must
   make `onFound` the stop, which it is.
6. `attach/transport.ts` (`:170-183`): `watchUntil` with `timeoutMs: Number.POSITIVE_INFINITY`,
   `firstAttempt: 'afterInterval'`, and `onFound: () => this.syncReadiness()`, because this poll's "value"
   is the readiness edge, and `syncReadiness` itself is idempotent (it returns early when the state has not
   changed, `:448`). Store the returned stop in `this.timer`'s place as `this.stopWatch` and call it from
   `stopPolling` (`:478-489`) and at the start of `attachSink` (`:313`) if a watch is re-armed there.
   **This is the one site with no deadline**, and it must stay that way: the readiness watcher is not waiting
   for something that may never arrive, it is observing a level, and it is stopped by `close()`. I5's
   "a timer without a retained handle" is the half that applies, and it is satisfied. Say so in the
   docstring; do not add a fabricated deadline.
7. Tests: replace `until` (`integration.test.ts:75-83`) and `waitUntil` (`room-upgrade.test.ts:149-156`)
   with `pollUntil` calls that pass `onTimeout`-driven assertions, and the two `room-socket.test.ts` inline
   loops with `pollUntil`. `until`'s `description` becomes the `onTimeout` assertion message, so the
   *better* message (integration's names what it waited for; room-upgrade's does not) wins for both.
   `packages/headless/tests/integration.test.ts` and `packages/bootstrapped/tests/room-upgrade.test.ts` both
   already import from `@mg.js/common` (check before editing; `integration.test.ts` imports
   `analyzeClose`/`CloseCode`).

**Test first.** New `packages/common/tests/poll.test.ts`, driven entirely by a fake scheduler so it needs no
real time and no `node:timers`:

```ts
/** A scheduler the test drives by hand: `run()` fires the ticks queued so far. */
function fakeClock(start = 0) {
  const queue: Array<{ at: number; callback: () => void; handle: unknown }> = [];
  let now = start;
  let nextHandle = 0;
  return {
    schedule: (callback: () => void, delayMs: number): unknown => {
      const handle = nextHandle++;
      queue.push({ at: now + delayMs, callback, handle });
      return handle;
    },
    cancelSchedule: (handle: unknown): void => {
      const i = queue.findIndex((q) => q.handle === handle);
      if (i >= 0) queue.splice(i, 1);
    },
    now: (): number => now,
    /** Advance to the next queued tick (never past the one with the smallest `at`), and fire it. */
    runNext(): boolean {
      if (queue.length === 0) return false;
      queue.sort((a, b) => a.at - b.at);
      const next = queue.shift();
      if (next === undefined) return false;
      now = next.at;
      next.callback();
      return true;
    },
  };
}

void test('pollUntil answers the first non-null attempt and stops scheduling', () => {
  const clock = fakeClock();
  let calls = 0;
  const promise = pollUntil<string>({
    attempt: () => (++calls >= 3 ? 'ready' : null),
    timeoutMs: 1_000, intervalMs: 100, ...clock,
  });
  for (let i = 0; i < 5; i += 1) clock.runNext();
  assert.equal(await promise, 'ready');
  assert.equal(calls, 3);
  assert.equal(clock.runNext(), false, 'nothing is scheduled after the answer');
});

void test('the deadline closes the window, calls onTimeout, and stops', async () => { /* … */ });

void test('a stop during attempt suppresses the delivery', async () => { /* … */ });

void test('pollUntil is total: an attempt that throws is the caller’s problem, not a hung promise', () => {
  // Documents the boundary: `pollUntil` does not swallow `attempt`'s throw (the sites that need totality
  // catch inside `attempt`), so this is asserted rather than assumed.
  assert.rejects(pollUntil({ attempt: () => { throw new Error('boom'); }, timeoutMs: 1, intervalMs: 1, ...fakeClock() }));
});
```

Observed failure before the change: the module did not exist, so the import failed with
`Cannot find module '../src/poll.js'` / `TS2307: Cannot find module`. After 3.4's edit, the pre-existing
`ctors.test.ts`, `attach.test.ts`, `jotai.test.ts` and `room-upgrade.test.ts` are the regression net for the
adopted call sites; run them before and after each site's edit, not only at the end.

Plus `packages/bootstrapped/tests/poll-platform-free.test.ts` (the I9 guard for a new `common` module):

```ts
void test('common/src/poll.ts names no timer global', () => {
  const source = readFileSync(new URL('../../common/src/poll.ts', import.meta.url), 'utf8');
  for (const banned of ['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'requestAnimationFrame', 'window.', 'document.']) {
    assert.ok(!source.includes(banned), `common/src/poll.ts must not name ${banned} (DESIGN I9)`);
  }
});
```

**Acceptance.**

- `npm run verify` green.
- `git grep -c "Date.now() - startedAt\|Date.now() - start" -- packages/*/src` → `0`.
- `git grep -n "pollUntil\|watchUntil" -- packages/common/src/index.ts` → both exported.
- One loop remains: `git grep -c "const tick = " -- packages/*/src` → `0`.
- Behaviour preserved per site: `npm test -w @mg.js/bootstrapped` (covers `waitForAttachment`,
  `watchForRoomConnection`, `getCtors`, the bridge and the readiness poll) and
  `npm test -w @mg.js/headless` (covers the two converted test helpers).
- Add the `poll.ts` row to `docs/DESIGN.md` §4.2's `common` tree.

**Risk / revert.** The table above is the drift list; the three that a careless merge gets wrong:

1. **First-attempt timing.** Three sites defer, one is immediate. Defaulting to `'now'` and forgetting
   `firstAttempt: 'afterInterval'` at `detect.ts` and `bridge.ts` would change the observed timing of
   `attach.test.ts`'s "does not fire before the interval" assertions. The parameter exists for this reason;
   assert it in `poll.test.ts` (a `'afterInterval'` case that schedules before running).
2. **The end-of-window meaning.** `getCtors` *rejects*; `waitForAttachment` *resolves a fallback*;
   `watchForRoomConnection` *calls back*; the bridge *falls silent*; the readiness poll *never ends*. The
   merge keeps all five by making the loop agnostic (`T | null` + `onTimeout`) and pushing the meaning to
   each call site. A merge that made `pollUntil` reject would break `attach.test.ts`; one that made it
   resolve would break `ctors.test.ts`'s timeout assertion.
3. **Scheduler arity.** `ctors.ts`'s is `(cb) => void`; the poll's is `(cb, delayMs) => unknown`. Passing it
   directly is a type error (good) and passing `(cb) => schedule(cb)` silently ignores `intervalMs` (bad but
   harmless, because rAF re-fires each frame, which is the documented intent at `ctors.ts:791-800`). State it
   in the comment so the next reader does not "fix" it into a 16 ms timer.
- Revert: `git revert <sha>`; each call site's original body is in this plan verbatim, so a partial revert is
  also possible per site.

---

## Task 3.4b: `unrefTimer`, one Node-timer teardown (separate commit, separately rejectable)

**Status: COMPLETE**: One `unrefTimer` in `common/src/poll.ts:161` (declaration), re-exported
at `common/src/index.ts:43`; the four spellings are gone (`bootstrapped/src/catalog/bundle.ts`,
`bootstrapped/src/userscript.ts`, `headless/src/transport/client.ts`, `jotai/bridge.ts`). Guard:
`common/tests/poll.test.ts`.

**Corrections.** The acceptance at `:1412` expects `'unref' in\|unref?.()` → `1` in `packages/*/src`. It
returns **2** in `common/src/poll.ts`: the doc comment at `:153` names the check and the real guard is at
`:163`. There is also **1** at `headless/src/client.ts`. The same line's "noted `headless/src/client.ts:625`
exception" is a **stale anchor**: the line had already moved to `:698` in (3.2), which the
ordering table requires to land *before* 3.4b.

This is a **different helper** from 3.4 (it cancels a handle's hold on the event loop, it does not poll), so it
gets its own commit and can be rejected without touching 3.4. Audit 20 §3 found the duplication
("The Node-timer teardown is copied four more times, three ways"); the master plan's Phase 3 table never
makes it a task, and that is why it is listed here with its own boundary.

**Surviving copy.** `packages/bootstrapped/src/attach/transport.ts:481-486` is the only copy that both guards
the shape with `'unref' in` and wraps the call in `try/catch`:

```ts
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      try {
        (this.timer as { unref: () => void }).unref();
      } catch {
        // Not a Node timer after all.
      }
    }
```

**Copies deleted.**

```ts
// packages/bootstrapped/src/jotai/bridge.ts:537-540: no try/catch: a throwing unref propagates out of release()
      if (timer !== null && typeof timer === 'object' && 'unref' in (timer as object)) {
        // Node timers: do not hold the process open. Browsers return a number here.
        (timer as { unref: () => void }).unref();
      }
```

```ts
// packages/bootstrapped/src/catalog/bundle.ts:346-348: no try/catch, and gated on `isPlainObject`
    if (timer !== null && isPlainObject(timer) && typeof timer['unref'] === 'function') {
      (timer['unref'] as () => void)();
    }
```

```ts
// packages/headless/src/client.ts:625: optional call, no shape guard, no try/catch
        setTimeout(resolve, 300).unref?.();
```

**Change.** Add to `packages/common/src/poll.ts` (same module as 3.4, the timer-plumbing home; if 3.4
is rejected, put this in a new `common/src/timers.ts` instead, and this task stands alone either way):

```ts
/**
 * Ask a Node timer not to hold the process open. A browser's numeric handle is left alone.
 *
 * Written structurally, as `'unref' in timer`, rather than by importing `node:timers`, because `common` is
 * platform-free (I9) and the browser's `setTimeout` returns a number. The four copies this replaces were
 * three different spellings of the same two checks, and two of them omitted the `try/catch`, so a timer-like
 * object whose `unref` throws took down the caller's teardown path.
 */
export function unrefTimer(timer: unknown): void {
  if (timer === null || typeof timer !== 'object') return;
  if (!('unref' in timer)) return;
  const { unref } = timer as { unref?: unknown };
  if (typeof unref !== 'function') return;
  try {
    unref.call(timer);
  } catch {
    // Not a Node timer after all.
  }
}
```

Adopt it at `attach/transport.ts:481-486`, `jotai/bridge.ts:537-540`, `catalog/bundle.ts:346-348`. **Leave
`headless/src/client.ts:625` alone**. That line is inside `disconnect()`, which Phase 2 Task 2.5 owns
("Cancellable waits"); note it in the commit body as the one remaining copy, with a pointer to 2.5, rather
than colliding with an in-flight task.

**Test first.** `packages/common/tests/poll.test.ts` (same file as 3.4's, or `timers.test.ts`):

```ts
void test('unrefTimer leaves a browser handle alone and never throws', () => {
  assert.doesNotThrow(() => unrefTimer(42));
  assert.doesNotThrow(() => unrefTimer(null));
  assert.doesNotThrow(() => unrefTimer({}));
  assert.doesNotThrow(() => unrefTimer({ unref: 'not a function' }));
  // The drift this closes: bridge.ts and bundle.ts called `unref` with no guard, so this threw.
  assert.doesNotThrow(() => unrefTimer({ unref: () => { throw new Error('unref blew up'); } }));
});

void test('unrefTimer calls unref on the object, with the object as this', () => {
  const calls: string[] = [];
  const timer = { unref(this: unknown) { calls.push(this === timer ? 'bound' : 'unbound'); } };
  unrefTimer(timer);
  assert.deepEqual(calls, ['bound']);
});
```

Observed failure before: `TS2307: Cannot find module '../src/poll.js'` (or
`Property 'unrefTimer' does not exist`).

**Acceptance.** `npm run verify` green;
`git grep -c "'unref' in\|unref?.()" -- packages/*/src` → `1` (inside `unrefTimer`) plus the one noted
`headless/src/client.ts:625` exception;
`git grep -n "isPlainObject(timer)" -- packages` → `0`.

**Risk / revert.** Drift, enumerated: (a) `bridge.ts` and `bundle.ts` had **no** `try/catch`, so a throwing
`unref` propagated. The merge is a tightening, and it is only reachable with a hostile timer-like object;
(b) `bundle.ts` gated on `isPlainObject` (excludes arrays and functions), which the structural guard does not,
so an array with an `unref` property would now be unref'd, harmless; (c) `bridge.ts` cast
`(timer as object)` before `'unref' in`, which is the same check with a cast; (d) `client.ts:625` used
`unref?.()`, which is the same intent spelled as optional chaining. Zero behaviour change for a real timer.
Revert: `git revert <sha>`.

---

## Task 3.5: one sequence validator, integer ≥ 0

**Status: COMPLETE**: `asSequence` (integer ≥ 0) is the one validator at
`common/src/protocol/codec.ts:200`, re-exported from `protocol/index.ts`; the weak `Number.isFinite` copies
in `renumber.ts`, `sequencer.ts`, `envelope.ts`, `client.ts`, `attach/room-connection.ts` and
`attach/raw-socket.ts` are gone. Guards: `bootstrapped/tests/sequence-owner.test.ts` and
`common/tests/protocol/codec.test.ts`.

**Corrections.** (a) **The count.** The master-plan row and report 20 say **five** copies; this section
hedges ("five(six...ten)") and the appendix (Additional duplication #1, `:2570`) settles on **ten**. The
canonical number is **ten**, and the master-plan row now says so. (b) **The anchor.** The "Copies deleted"
quote labels `extractFrontier` as `common/src/protocol/codec.ts:126-131`. That anchor was stale before this
task started: Phase 2 Task 2.1 had already moved `extractFrontier` to `:167` (this plan's own "Working-tree
state" says so), and 3.5 then replaced the body with `asSequence` at `:200`.

**Surviving copy.** The **integer ≥ 0** rule, and it must move to `common/src/protocol/codec.ts` (the audit's
stated home; `common/src/protocol` is the wire-contract layer, and the barrel already re-exports from it).
The four bootstrapped integer copies are the best *implementation* (one line, same predicate); the two
`Number.isFinite` copies are the **weaker** rule and lose.

**Why integer ≥ 0 is correct, not a preference.** `commandSequence` and `executedCommandSequence` are counters
the server compares for equality: the protocol's own failure mode is `invalid_sequence`, and
`Renumberer.rewrite` *stamps* `nextValue`, which is `frontier + 1` or `highestSeen + 1`
(`renumber.ts:302, 160`). A frontier of `2.5` therefore makes us **send `3.5`**, which no counter comparison
accepts. DESIGN I4 independently requires a canonical check before untrusted data becomes an index or a bound,
and a sequence is used as both (`patch`-free but arithmetic). A finite-but-fractional counter is malformed
input, and the honest reading of malformed input is "no evidence".

**Copies deleted.**

```ts
// packages/common/src/protocol/codec.ts:126-131: the finite rule
export function extractFrontier(message: unknown): number | null {
  if (message === null || typeof message !== 'object') return null;
  const record = message as Record<string, unknown>;
  const value = record.executedCommandSequence;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
```

```ts
// packages/bootstrapped/src/client.ts:926-932: integer rule, and the same function as extractFrontier
export function readWelcomeFrontier(message: unknown): number | null {
  if (message === null || typeof message !== 'object') return null;
  const value = (message as { executedCommandSequence?: unknown }).executedCommandSequence;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  return null;
}
```

```ts
// packages/bootstrapped/src/attach/room-connection.ts:244-248
/** Read an integer sequence out of an unknown value. */
function asSequence(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}
```

```ts
// packages/bootstrapped/src/attach/raw-socket.ts:159-161: inline
  const rawSequence = record['executedCommandSequence'];
  const executedCommandSequence =
    typeof rawSequence === 'number' && Number.isInteger(rawSequence) && rawSequence >= 0 ? rawSequence : null;
```

```ts
// packages/bootstrapped/src/coexistence/renumber.ts:424-427 (current tree)
function asSequence(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}
```

and **four further weak copies inside `renumber.ts` alone**, which report 20's count of "five" misses and
which contradict the integer `asSequence` in the same file:

```ts
// renumber.ts:158: the constructor seed
    if (seed !== undefined && Number.isFinite(seed)) { this.highestSeen = seed; this.nextValue = seed + 1; … }
// renumber.ts:242: observeFrontier, the live read
    if (typeof frontier !== 'number' || !Number.isFinite(frontier)) return;
// renumber.ts:361: the adopt/heal target
    const target = typeof frontier === 'number' && Number.isFinite(frontier) ? frontier : this.frontier;
// renumber.ts:376: the scraped-frame read
    if (!Number.isFinite(executedCommandSequence)) return;
```

Two more, in `common`:

```ts
// packages/common/src/protocol/sequencer.ts:116
  observeFrontier(frontier: number): void {
    if (!Number.isFinite(frontier)) return;
// packages/common/src/protocol/sequencer.ts:195 and :222: the same `Number.isFinite` shape
```

and one at the build boundary, `packages/common/src/protocol/envelope.ts:117`:
`if (typeof commandSequence !== 'number' || !Number.isFinite(commandSequence)) { throw ... }`.

**Change.**

1. `packages/common/src/protocol/codec.ts`: add before `extractFrontier` (which is at **`:167`** once Phase 2
   Task 2.1 has landed, and at `:126` before it). The body is identical either way, so this hunk is
   content-identical and only its line number moves):

   ```ts
   /**
    * Read a wire sequence number.
    *
    * A sequence is a **non-negative integer**. It is a counter the server answers with `invalid_sequence`
    * for anything else, and because the next value we stamp is `frontier + 1`, a fractional frontier
    * becomes a fractional `commandSequence` on the wire. `Number.isFinite` was the rule in six places and it
    * lets `2.5` through; DESIGN I4 forbids turning untrusted data into an index or a bound without a
    * canonical check.
    */
   export function asSequence(value: unknown): number | null {
     if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
     return value;
   }

   export function extractFrontier(message: unknown): number | null {
     if (message === null || typeof message !== 'object') return null;
     const record = message as Record<string, unknown>;
     return asSequence(record.executedCommandSequence);
   }
   ```

2. `packages/common/src/protocol/index.ts:6-11`: export `asSequence` alongside `extractFrontier`.
   `common/src/index.ts:42`'s `export *` carries it to `@mg.js/common`.
3. `packages/common/src/protocol/sequencer.ts`: `observeFrontier` (`:115-120`), `:195` and `:222` route
   through `asSequence` (`const checked = asSequence(frontier); if (checked === null) return;`).
   `reseed(executedCommandSequence: number)` (`:128-132`) keeps its signature; it is documented as already
   validated by the caller. However `common/src/client.ts:539-541` now validates before calling it.
4. `packages/common/src/protocol/envelope.ts:117`: `if (asSequence(commandSequence) === null) { throw ... }`,
   keeping the message byte-identical.
5. `packages/common/src/client.ts:539-541`: place the equivalent null check here

   ```ts
   const frontier = asSequence(message.executedCommandSequence);
   if (frontier !== null) this.sequencer.seed(frontier);
   ```

   This is the line the audit's headline bug runs through: `typeof ... === 'number'` seeded the core from
   `2.5` while `readWelcomeFrontier` refused it, so the core's counter and the renumberer's disagreed about
   where the session started, in direct contradiction of `bootstrapped/src/client.ts:248-249`'s *"Seed both
   counters from the same fact, so they cannot disagree"*.
6. `packages/bootstrapped/src/client.ts:926-932`: **delete the body**; the public name survives as a
   re-export, because `readWelcomeFrontier` and `extractFrontier` are the same function:

   ```ts
   export { extractFrontier as readWelcomeFrontier } from '@mg.js/common';
   ```

   **Verified:** `bootstrapped/src/index.ts:55` hand-enumerates `readWelcomeFrontier` from `./client.js`, so
   that line keeps working unchanged. `git grep -n readWelcomeFrontier -- packages` before editing to confirm
   nothing else imports it by a different route.
7. `packages/bootstrapped/src/attach/room-connection.ts:244-248` and
   `packages/bootstrapped/src/coexistence/renumber.ts:424-427`: delete the private `asSequence`; import it
   from `@mg.js/common`. `raw-socket.ts:159-161` calls it inline.
8. `renumber.ts:158, 242, 361, 376`: route through `asSequence`. `:158` becomes
   `const seed = asSequence(options.executedCommandSequence); if (seed !== null) { ... } else { this.frontier = null; }`.
9. No `exports`-map change and no new public name: `asSequence` is an addition to `@mg.js/common`.

**Test first.** New `packages/common/tests/codec.test.ts` (mirrors `protocol/codec.ts`; DESIGN §4.3 says the
file does not exist yet, and this is its first occupant; add `parseFrame`/`serializeFrame`
coverage only if it is free, since 3.5 is one helper):

```ts
void test('asSequence accepts only a non-negative integer', () => {
  assert.equal(asSequence(0), 0);
  assert.equal(asSequence(7), 7);
  assert.equal(asSequence(2.5), null, 'a fractional counter is malformed, not a lower bound');
  assert.equal(asSequence(-1), null);
  assert.equal(asSequence(Number.NaN), null);
  assert.equal(asSequence(Number.POSITIVE_INFINITY), null);
  assert.equal(asSequence('3'), null);
  assert.equal(asSequence(null), null);
  assert.equal(asSequence(undefined), null);
});

void test('extractFrontier refuses a fractional frontier instead of reporting it', () => {
  assert.equal(extractFrontier({ executedCommandSequence: 4 }), 4);
  assert.equal(extractFrontier({ executedCommandSequence: 2.5 }), null);
  assert.equal(extractFrontier({ executedCommandSequence: '4' }), null);
  assert.equal(extractFrontier(null), null);
});
```

Observed failure before: `TS2307: Cannot find module '../src/codec.js'` / `asSequence is not a function`, and
once `extractFrontier` is reached, `assert.equal(extractFrontier({executedCommandSequence: 2.5}), null)` fails
with `Expected "actual" to be strictly equal: 2.5 !== null`.

The **behaviour-change test** is the audit's own scenario, at the integration level, in
`packages/bootstrapped/tests/coexistence.test.ts` (which already has `Renumberer` and an `envelope` fixture):

```ts
void test('a fractional Welcome frontier seeds neither counter, so they cannot disagree', () => {
  const renumberer = new Renumberer();
  const core = new CommandSequencer();
  const welcome = { type: 'Welcome', executedCommandSequence: 2.5, selfPlayerId: 'p' };
  // Both of these are what `common/src/client.ts` and `bootstrapped/src/client.ts` now do with a Welcome.
  const frontier = extractFrontier(welcome);
  if (frontier !== null) core.seed(frontier);
  if (frontier !== null) renumberer.observeFrontier(frontier);
  assert.deepEqual([core.next, renumberer.next], [1, 1], 'both counters stay at the seed, or neither moves');
});
```

Observed failure before: after `core.seed(2.5)` and no renumberer seed, `[core.next, renumberer.next]` is
`[3.5, 1]`; the two disagree, which is the bug.

Add `packages/bootstrapped/tests/sequence-owner.test.ts`, the "no fourth copy" scan:

```ts
const SEQUENCE_VALIDATOR = /Number\.isInteger\((value|rawSequence|frontier|seed|executedCommandSequence)\)/;

void test('the sequence rule is written once, in common/protocol/codec.ts', () => {
  const offenders = everySourceFile()            // packages/*/src/**, as in Task 3.1's helper
    .filter((f) => !f.endsWith('packages/common/src/protocol/codec.ts'))
    .filter((f) => SEQUENCE_VALIDATOR.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, [], 'a sequence validated anywhere but its home can disagree about the rule');
});

void test('no source file validates a sequence with Number.isFinite', () => {
  // The weak rule must not come back: this is the copy that let `2.5` through.
  const offenders = everySourceFile()
    .filter((f) => /Number\.isFinite\((\w*[Ss]equence|\w*frontier|\w*seed)\)/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});
```

Both fail before the change (the first names `bootstrapped/src/client.ts`,
`attach/room-connection.ts`, `attach/raw-socket.ts`, `coexistence/renumber.ts`; the second names
`coexistence/renumber.ts`). `bootstrapped/tests` can read `common/src` as text; that is a file read, not an
import, and it does not touch the layer graph.

**Acceptance.**

- `npm run verify` green. `tsc -p tsconfig.tests.json` is what proves `readWelcomeFrontier`'s re-export
  resolves to a `(message: unknown) => number | null`.
- `git grep -n "function asSequence" -- packages` → exactly one hit, `common/src/protocol/codec.ts`.
- `git grep -n "Number.isFinite(frontier\|Number.isFinite(seed\|Number.isFinite(executedCommandSequence\|Number.isFinite(commandSequence" -- packages/*/src` → `0`.
- `npm test -w @mg.js/common` + `-w @mg.js/bootstrapped` green, including the new disagreement test.
- Behaviour changes named in the commit body (see below).

**Risk / revert.** Drift between the five(six...ten) copies, and the behaviour change each merge makes:

| # | site (before) | rule | after | behaviour change |
|---|---|---|---|---|
| 1 | `codec.ts:130` `extractFrontier` | finite | `asSequence` | `2.5` → `null`. `ClientCore.handleStateFrame` no longer forward-jumps the sequencer on a fractional RoomFrame frontier, so `BootstrappedClient.readFrontier()` (`client.ts:714-722`) falls through to the sequencer's own value. **Tightening on malformed input only.** |
| 2 | `common/src/client.ts:539` | `typeof === 'number'` | `asSequence` | a `Welcome{2.5}` no longer seeds the core sequencer. This is the fix, not a regression. |
| 3 | `bootstrapped/client.ts:930` `readWelcomeFrontier` | integer ≥ 0 | same, via `extractFrontier` | none; the functions are identical for every input (verified line by line: both require a non-null object, both read the top-level `executedCommandSequence`). |
| 4 | `room-connection.ts:246` | integer ≥ 0 | same | none. |
| 5 | `raw-socket.ts:161` | integer ≥ 0 | same | none. |
| 6 | `renumber.ts:425` | integer ≥ 0 | same | none. |
| 7 | `renumber.ts:158` seed | finite | integer | `Renumberer({ executedCommandSequence: 2.5 })` now leaves `frontier: null`, `nextValue: 1` (was `2.5` / `3.5`). Tightening. |
| 8 | `renumber.ts:242` | finite | integer | a fractional scraped frontier no longer advances `highestSeen`/`nextValue`. Tightening. |
| 9 | `renumber.ts:361` | finite | integer | a fractional `getFrontier()` target no longer heals to `2.5 + 1`. Tightening. |
| 10 | `renumber.ts:376` | finite | integer | as 8. |
| 11 | `sequencer.ts:116, 195, 222` | finite | integer | `observeFrontier(2.5)` stops advancing `frontierValue`. Tightening; `CommandSequencer.observeFrontier` is public, so name it. |
| 12 | `envelope.ts:117` | finite | integer | `buildFrame({ form: 'wrapped', commandSequence: 2.5 })` now **throws** where it used to build a frame. This is a *stricter* change on a *local* caller, and the only one that can surface as a new exception. Every internal caller feeds it `sequencer.take()`/`peek()`, which are integers ≥ 0 once #2 lands, so no internal path changes. Name it in the commit body. |

- Revert: `git revert <sha>`. The one-shot risk is #12 for a third-party caller who was passing a fractional
  sequence; there is no such caller in the repo (`git grep -n "commandSequence" -- packages scripts` before
  committing), so the revert risk is theoretical.

---

## Task 3.6: retry tickers, the honest answer is that there is no shared helper here

**Status: COMPLETE**: the landed change is the one this section argues for:
`common/src/protocol/types.ts`'s `DEFAULT_RECONNECT` is the one literal, and
`headless/src/reconnect.ts`'s `DEFAULT_RECONNECT_POLICY` is now a re-export of it. No attach-side code
changed, which matches *"3.6's attach half is delivered by 3.4"*, as the section says. Guards:
`headless/tests/layering.test.ts` (new; value identity) and the extended `headless/tests/backoff.test.ts`.

**Correction.** The acceptance at `:1704` expects
`git grep -n "maxDelayMs: 60_000\|baseDelayMs: 1500" -- packages` → one hit, inside
`common/src/protocol/types.ts`. It returns **two**: `common/src/protocol/types.ts:289` and
`headless/tests/reconnect-abort.test.ts:88` (a test fixture spelling the literal). The grep means "one
source literal" only when scoped to `packages/*/src`.

**Finding, with evidence.** The brief's premise, "2 (`headless/reconnect.ts`, `bootstrapped/attach/detect.ts`)",
is **not supported by the code**. They are not the same helper:

- `headless/src/reconnect.ts`'s `computeBackoff` (`:117-185`) is a **pure delay calculator**. Its inputs are a
  `ReconnectConfig` and a `BackoffContext` (`{ attempt, close, coldStart, random }`, `:61-99`), and its output
  is a `BackoffPlan` with `delayMs`, `capped`, `rawDelayMs` and a human `reason` (`:83-97`). Its decisions are
  exponential doubling, a supersede base, a cold-start fast window, a jitter factor and a clamp.
- `bootstrapped/src/attach/detect.ts` has **no delay calculation at all**. Its two functions are *deadline
  polls* with a fixed interval: `waitForAttachment` (`:270-307`, 250 ms, 20 s) and `watchForRoomConnection`
  (`:361-416`, 500 ms, 90 s). Neither takes an attempt number, a close, or a random source, and neither
  produces a delay. `git grep -n "computeBackoff\|BackoffPlan\|ReconnectConfig" -- packages/bootstrapped`
  returns nothing.
- The only numeric overlap is `500` (a poll interval) vs `1500` (a backoff base). The only *structural*
  overlap is "run something again later", which is `setTimeout`.
- **Resolution of the layering tension:** because the two are not the same helper, nothing needs to live in
  `common`, and the `headless`/`bootstrapped` import ban (DESIGN §3.1:109-110) is never tested. If a future
  change *did* want `computeBackoff` in `bootstrapped`, DESIGN §3.1 rule 2 would force it into `common/`;
  `computeBackoff`'s only `common` dependency is the `ReconnectConfig` *type* and `CloseAnalysis`, so the move
  is possible, but it would put a retry *policy* below the client that owns the policy, which §3.1's rule 1
  ("policy lives in the client, mechanism lives in the layer") forbids. **The side that wins is the
  status quo: `computeBackoff` stays in `headless/reconnect.ts`, and `attach` keeps only its watch (which
  task 3.4 moves onto `common/src/poll.ts`'s `watchUntil`).** So 3.6's attach half is *delivered by 3.4*, and
  this task has no attach-side code change.
- **What 3.6 actually owes** is the one thing that *is* a copy: `DEFAULT_RECONNECT_POLICY`
  (`headless/src/reconnect.ts:44-53`) is a byte-for-byte literal twin of
  `common/src/protocol/types.ts:287-295`, under a comment that claims they cannot drift.

**Surviving copy.** `common/src/protocol/types.ts:287-295` holds the value; the public *name* survives in
headless.

**Copies deleted.**

```ts
// packages/headless/src/reconnect.ts:44-53
/** Default policy. Mirrors `DEFAULT_RECONNECT` from the common package so the two cannot drift. */
export const DEFAULT_RECONNECT_POLICY: ReconnectConfig = {
  enabled: true,
  baseDelayMs: 1500,
  maxDelayMs: 60_000,
  jitter: 0.25,
  supersededBaseDelayMs: 30_000,
  coldStartFastRetries: 3,
  maxAttempts: Number.POSITIVE_INFINITY,
};
```

**Change.** `packages/headless/src/reconnect.ts`:

```ts
/**
 * The default policy, taken from its one home rather than restated.
 *
 * This used to be a literal copy of `DEFAULT_RECONNECT` under a comment claiming the two "cannot drift".
 * A copy under a cannot-drift comment is the one thing that certainly can: the seven values agreed only
 * because a person kept them in step. Re-exporting the object also makes the identity assertable, which is
 * what `tests/backoff.test.ts` now does.
 */
export { DEFAULT_RECONNECT as DEFAULT_RECONNECT_POLICY } from '@mg.js/common';
```

`headless/src/reconnect.ts:223`'s `{@link DEFAULT_RECONNECT_POLICY}` and `:243`'s
`{ ...DEFAULT_RECONNECT_POLICY, ...options.config }` both keep working (a re-exported binding is a local
binding). `headless/src/index.ts:55-60` keeps exporting the name. `common/src/protocol/index.ts:67` already
exports `DEFAULT_RECONNECT`. **No surface change**: same name, same type, same values.

Then fix the doc contradiction audit 20 §6 found: `headless/src/client.ts:218` says options fall back to
`DEFAULT_RECONNECT` while `reconnect.ts:247` merged `DEFAULT_RECONNECT_POLICY`. After this change the two
names are the same object, so the sentence becomes true; add one clause
(`...which is `DEFAULT_RECONNECT_POLICY``) rather than leaving a reader to verify it.

**Test first.** Add to `packages/headless/tests/backoff.test.ts` (which already imports
`DEFAULT_RECONNECT_POLICY` at `:23` and spreads it at `:28`):

```ts
it('DEFAULT_RECONNECT_POLICY is the common package’s object, not a twin', () => {
  // Identity, not deep equality: two objects with the same seven numbers is the state this test
  // exists to forbid, and `assert.deepEqual` would pass on the bug.
  assert.equal(DEFAULT_RECONNECT_POLICY, DEFAULT_RECONNECT, 'one object, re-exported under both names');
});
```

(`import { DEFAULT_RECONNECT } from '@mg.js/common';` alongside the existing `analyzeClose, CloseCode` import.)
Observed failure before: `Expected "actual" to be strictly equal`. That means two distinct objects, which is
the bug.

The **boundary** between the two tickers gets a guard too, in a new `packages/headless/tests/layering.test.ts`:

```ts
void test('`bootstrapped` and `headless` never import each other', () => {
  // DESIGN §3.1:109-110. Nothing tested this before, and 3.6 proposes moving a helper across it.
  for (const [pkg, banned] of [['bootstrapped', '@mg.js/headless'], ['headless', '@mg.js/bootstrapped']] as const) {
    const offenders = everySourceFileIn(pkg).filter((f) => readFileSync(f, 'utf8').includes(`'${banned}'`));
    assert.deepEqual(offenders, [], `${pkg} must not import ${banned}`);
  }
});

void test('`bootstrapped` computes no retry delay: the backoff has one home', () => {
  const offenders = everySourceFileIn('bootstrapped')
    .filter((f) => /computeBackoff|BackoffPlan|maxDelayMs/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, [], 'a delay calculated in two packages can disagree about the cadence');
});
```

**Be honest about this pair:** both pass *before* the change. They are a characterisation guard for a boundary
that is currently respected, not a failing-first test. Write them in the same commit and record in the
commit body that the "before" run was a pass. The failing-first test for 3.6 is the identity assertion above.
A pure-refactor task with no behaviour change is the case where the honest "before" is a
characterisation test; the alternative (inventing a behaviour change to have a red test) is worse.

**Acceptance.**

- `npm run verify` green.
- `git grep -n "maxDelayMs: 60_000\|baseDelayMs: 1500" -- packages` → one hit, inside
  `common/src/protocol/types.ts`.
- `node --input-type=module -e "const a = await import('./packages/common/dist/index.js'); const b = await import('./packages/headless/dist/index.js'); console.log(a.DEFAULT_RECONNECT === b.DEFAULT_RECONNECT_POLICY)"` after `npm run build` → `true`.
- `headless/package.json` still lists `@mg.js/common` as a dependency (it does), and a re-export adds no new
  external dependency and the userscript is unaffected (this file is not in the bundle).

**Risk / revert.** Drift, enumerated: the two literals are **numerically identical**:
`enabled: true, baseDelayMs: 1500, maxDelayMs: 60_000 / 60000, jitter: 0.25, supersededBaseDelayMs: 30_000 /
30000, coldStartFastRetries: 3, maxAttempts: Number.POSITIVE_INFINITY`. The *only* difference is the digit
separator (`60_000` in headless, `60000` in common; audit 22 §6), so the merge has **zero behaviour change**,
and the test that proves it is an identity check rather than a value check. One consequence to note: the
values can no longer be changed for headless alone; a caller that wants a different cadence already passes
`reconnect: { ... }`. Revert: `git revert <sha>`.

---

## Task 3.7: the five small helpers in `render/` (and the one the brief assigns to `outbound.ts`)

**Status: COMPLETE**: five commits, one per helper: (3.7a `detach`), (3.7b
`getGraphicsCtor`), (3.7c `isRiveLike`), (3.7d `asGraphics`), (3.7e
warn-once). `coexistence/outbound.ts` was never created, exactly as this section says. Guards:
`bootstrapped/tests/render-owner.test.ts` (all five) plus `warn-once.test.ts`, `render/rive.test.ts` and
the extended `ctors.test.ts`/`world.test.ts`.

Six helpers are named; **five have a real dedupe**, and the sixth (`asEnvelope`) is owned by task 3.3. The
brief assigns it to `bootstrapped/src/coexistence/outbound.ts`, but 3.3 already placed it in
`bootstrapped/src/coexistence/envelope.ts` (and DESIGN §4.2:262's `outbound.ts` never gets created; see 3.3).
This task therefore does not touch `asEnvelope` and does not create `outbound.ts`.

### 3.7a `detachNode` (`world.ts`) ≡ `detach` (`text.ts`), target owner `render/text.ts`

**Status: COMPLETE** for `detach`, which survives at `render/text.ts:195`; `world.ts`'s private
`detachNode` is gone.

**Surviving copy.** `packages/bootstrapped/src/render/text.ts:195-213` (`detach`): already exported, already
imported by two modules (`graphics.ts:43`, `rive.ts:62`), already documented with the reason `removeChildren`
is preferred. `world.ts`'s copy is module-private and comments nothing.

**Copies deleted.**

```ts
// packages/bootstrapped/src/render/world.ts:914-933
/** Remove a node from its parent using whichever removal method exists. Never throws. */
function detachNode(node: PixiDisplayObject): void {
  const parent = node.parent;
  if (parent === null || parent === undefined) return;
  if (typeof parent.removeChildren === 'function') {
    try {
      parent.removeChildren(node);
      return;
    } catch {
      // Fall through.
    }
  }
  if (typeof parent.removeChild === 'function') {
    try {
      parent.removeChild(node);
    } catch {
      // Already detached.
    }
  }
}
```

**Change.** Delete it; add `import { detach } from './text.js';` to `world.ts` (it currently imports only
`ctors.js`, `sprite.js`, `pixi.js` and adds no cycle, since `text.ts` imports only `ctors.js`, verified).
Rename the three call sites (`world.ts:338, 452, 666`) from `detachNode(...)` to `detach(...)`. No public name
changes: `detachNode` was never exported and `detach` already is (`bootstrapped/src/index.ts:273`).

**Drift, enumerated.** **None.** The two bodies are line-for-line identical apart from comments and the name
(`world.ts:914-933` vs `text.ts:188-213`). This is the safest of the six.

### 3.7b `getGraphicsCtor` (`sprite.ts`) ≡ `getGraphicsCtor` (`ctors.ts`), target owner `render/ctors.ts`

**Status: COMPLETE** for `getGraphicsCtor`, which survives at `render/ctors.ts:791`; `sprite.ts`'s copy
is gone (its public name is preserved through the package barrel).

**Surviving copy.** `packages/bootstrapped/src/render/ctors.ts:782-788`, which takes the stage, falls back to
`stageRoot` then `capturedApplication?.stage`, and is the one `PixiStage` adapts (`pixi.ts:321-323`).

**Copies deleted.**

```ts
// packages/bootstrapped/src/render/sprite.ts:304-312
export function getGraphicsCtor(): (new (...args: unknown[]) => PixiGraphics) | null {
  return PixiStage.getGraphicsCtor(PixiStage.stage);
}
```

**Change.** Delete it. `bootstrapped/src/index.ts:261` (`getGraphicsCtor as getSpriteGraphicsCtor`, sourced
from `./render/sprite.js`) is retargeted to `./render/ctors.js` on the `:205` line group, so the public name
`getSpriteGraphicsCtor` survives. `sprite.ts`'s import of `PixiStage` (`:39`) may become unused. Check with
`noUnusedLocals`, which will fail the build if it does.

**Drift, enumerated.** *None observable.* Route comparison: `sprite`'s copy was
`getGraphicsCtorImpl(getStageRoot())` (because `PixiStage.stage` is a getter for `getStageRoot()`,
`pixi.ts:290-292`); `ctors`' is `getGraphicsCtorImpl(stage)` where `stage` is optional, and when it is not a
container the body falls back to `stageRoot ?? capturedApplication?.stage`
(`ctors.ts:784`). For `stage === null`, `isContainerLike(null)` is false, so both resolve to
`stageRoot ?? capturedApplication?.stage`, identical. The **arity** differs (0 vs 1 optional), which is a
widening of the public signature and the one thing to name in the commit body.

### 3.7c `isRiveHostLike` (`world.ts`) ≡ `isRiveLike` (`ctors.ts`), target owner `render/ctors.ts`

**Status: COMPLETE** for `isRiveLike`, which survives at `render/ctors.ts:383`; `world.ts`'s
`isRiveHostLike` is gone, and the predicate now accepts an artboard-only node (the widening is named in
the commit body).

**Correction (stale anchor).** The point at `:1961` cites `ctors.ts:384` for the
`'rive' | 'artboard' | 'stateMachine'` key test. It is now `ctors.ts:385`, because 3.7c's own edit added a line
above it. (The companion `world.ts:911` anchor names the copy this task deleted, so it is historical.)

**Surviving copy.** `packages/bootstrapped/src/render/ctors.ts:382-386` (`isRiveLike`): exported
(`bootstrapped/src/index.ts:212`), covered by `ctors.test.ts`'s decoy tests, and already the predicate
`isTextLike`/`isSpriteLike` build on (`ctors.ts:398, 427`).

**Copies deleted**: there are **three**, not two, because a delegated repo-wide scan found a third key test in
`rive.ts` that **omits `'artboard'`**.

```ts
// packages/bootstrapped/src/render/world.ts:907-912
/** Structural test for "this is a Rive host, i.e. a pet-ish node". Mirrors `ctors.ts`'s `isRiveLike`. */
function isRiveHostLike(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return 'artboard' in record || 'stateMachine' in record || 'rive' in record;
}
```

```ts
// packages/bootstrapped/src/render/rive.ts:398: `isArtboardLike`'s structural fallback
  // Structural signal as a fallback: the Rive runtime object model, or a state-machine reference.
  return 'stateMachine' in record || 'rive' in record;
```

**Change.** Delete `isRiveHostLike`; import `isRiveLike` from `./ctors.js` (already imported for types at
`world.ts:58`, so merge into that import as a value import); change the single call site `world.ts:641` to
`isRiveLike(node)`. In `rive.ts:398`, the fallback becomes `return isRiveLike(record);`, and `rive.ts` already
imports from `./ctors.js` (`:61`).

**Drift, enumerated: two real differences.**

1. **A missing key.** `ctors.ts:384` tests `'rive' | 'artboard' | 'stateMachine'`; `world.ts:911` tests
   `'artboard' | 'stateMachine' | 'rive'` (same set, order only); `rive.ts:398` tests **`'stateMachine' |
   'rive'`** and **omits `'artboard'`**. So a node carrying only an `artboard` property is Rive-like to
   `ctors` and `world` and *not* to `rive.isArtboardLike`. Consequence at `rive.ts:398`: a genuine artboard
   reached through the structural fallback is rejected, so `wrapArtboard` refuses it. This is a **correctness
   bug**, and the direction of the fix is unambiguous: take the wider, documented, tested set. Name it in the
   commit body as a behaviour change with the test that pins it (below).
2. **Functions.** `ctors.ts`'s `isObject` (`:357-358`) is
   `value !== null && (typeof value === 'object' || typeof value === 'function')`; `world.ts`'s is
   `value === null || typeof value !== 'object' → false`, which rejects **functions** (and `rive.ts:392`'s
   `record` is built from `typeof value === 'object'` too, so check its guard before editing). So a *callable*
   object carrying `artboard`/`stateMachine`/`rive` is `true` under `isRiveLike` and was `false` under both
   copies. Consequence at `world.ts:641` (inside a `findNode` walk looking for pet nodes): the predicate
   becomes strictly **wider**, so a callable Rive host is now found where it was previously skipped. That is
   the desired direction: a found-but-wrong node fails inside the wrapper's own `try/catch` (a pet label that
   throws is caught), while a skipped real host means the feature silently does nothing.

**Test first, and the one that fails before the change.** `ctors.test.ts` already covers `isRiveLike`; add the
missing-key case there, where it belongs, and add the shape case to `rive`'s coverage:

```ts
// packages/bootstrapped/tests/ctors.test.ts
void test('isRiveLike accepts any one of the three Rive hosts, including an artboard-only node', () => {
  // The drift this pins: `rive.ts`'s structural fallback tested only two of the three keys, so an
  // artboard-only node was Rive-like to two modules and not to the third.
  assert.equal(isRiveLike({ artboard: {} }), true);
  assert.equal(isRiveLike({ stateMachine: {} }), true);
  assert.equal(isRiveLike({ rive: {} }), true);
  assert.equal(isRiveLike({ artboard: {}, stateMachine: {}, rive: {} }), true);
  assert.equal(isRiveLike({ text: 'hi' }), false);
});
```

Observed before, for the `rive.ts` half: read `rive.ts:388-399` and note that
`isArtboardLike({ artboard: {} })` (a node with only an `artboard`) returns `false` while
`isRiveLike({ artboard: {} })` returns `true`. That is the failing assertion; add it to whichever suite covers
`wrapArtboard` (`packages/bootstrapped/tests/rive` coverage lives in `world.test.ts`/`ctors.test.ts` today, so
run `git grep -ln isArtboardLike -- packages/bootstrapped/tests` before choosing).

### 3.7d `asGraphics` (`world.ts`) ≡ `isGraphicsLike` (`ctors.ts`), target owner `render/ctors.ts`

**Status: COMPLETE** for `asGraphics`, which survives at `render/world.ts:986` and now delegates to
`isGraphicsLike` (`render/ctors.ts:444`), so `null`/`undefined` answer `null` instead of throwing. That is the
one real behaviour change this section predicts, pinned in `world.test.ts`.

**Surviving copy.** `packages/bootstrapped/src/render/ctors.ts:443-446` (`isGraphicsLike`): the predicate, and
the one `getGraphicsCtor` searches with (`ctors.ts:786`) and `ctors.ts:445` documents.

**Copies deleted.**

```ts
// packages/bootstrapped/src/render/world.ts:1002-1006
export function asGraphics(container: PixiDisplayObject): PixiGraphics | null {
  return typeof container.clear === 'function' && typeof container.roundRect === 'function'
    ? (container as PixiGraphics)
    : null;
}
```

**Change.** `asGraphics` is the *narrowing* flavour of the same predicate, so keep the public name and make it
delegate, because the duplication is the test, not the return type:

```ts
export function asGraphics(container: PixiDisplayObject): PixiGraphics | null {
  return isGraphicsLike(container) ? (container as PixiGraphics) : null;
}
```

`world.ts` already imports from `./ctors.js` (type-only at `:58`; add `isGraphicsLike` as a value import).
`bootstrapped/src/index.ts:286` and `:211` keep exporting `asGraphics` and `isGraphicsLike`. The alternative,
deleting `asGraphics` and making callers narrow, is a breaking public removal for no gain; do the delegation.

**Drift, enumerated: one real difference, and it is a latent crash.** The two bodies test the same two
members (`world.ts` in the order `clear` then `roundRect`; `ctors.ts:445` in the order `roundRect` then
`clear`, the same pair with no short-circuit difference), and the only other difference is the return type. But
`ctors.ts`'s first line is a **receiver guard** (`if (!isObject(value)) return false;`, `:444`) that
`world.ts:1003` does **not** have: it dereferences `container.clear` directly. `container` is typed
`PixiDisplayObject`, so a TypeScript caller cannot pass `null`, but a JavaScript caller (or a caller that
reached it through the userscript's own namespace object, which is page-shared) can, and `null.clear` **throws
a `TypeError`** where `isGraphicsLike(null)` answers `false`. So the delegation does not merely remove a
duplicated predicate; it turns a crash into `null`, and that is what the function's own return type and its
"convenience" doc (`world.ts:996-1001`) already promise. **Name this in the commit body as a behaviour
change**, and pin it:

```ts
// packages/bootstrapped/tests/world.test.ts
void test('asGraphics answers null for anything that is not a Graphics, including null itself', () => {
  // Before the delegation this threw: `world.ts` dereferenced `.clear` with no receiver guard, while
  // `isGraphicsLike` (the predicate it was duplicating) guarded first.
  assert.equal(asGraphics(null as unknown as PixiDisplayObject), null);
  assert.equal(asGraphics(undefined as unknown as PixiDisplayObject), null);
  assert.equal(asGraphics({} as unknown as PixiDisplayObject), null);
  assert.equal(asGraphics({ clear() {}, roundRect() {} } as unknown as PixiDisplayObject) !== null, true);
});
```

Observed before: `throws TypeError: Cannot read properties of null (reading 'clear')` on the first assertion.
That is the failing-first test for 3.7d.

### 3.7e warn-once ×3, with three resets. Target owner `bootstrapped/src/render/warn-once.ts` (new)

**Status: COMPLETE**: the one implementation is `render/warn-once.ts` (`createWarnOnce`); the
three per-caller memos and their resets are gone, and each caller keeps its own memo via the factory.

**Surviving copy.** None; the *best* is `graphics.ts:274-283` (single-key signature, prefix formatting, and a
`try/catch` around `console.warn`), with `rive.ts`'s documented `unsupported` early-return kept at its call
site and `world.ts`'s operation-key width generalised.

**Copies deleted.**

```ts
// packages/bootstrapped/src/render/graphics.ts:274-288
const warned = new Set<string>();
function warnOnce(message: string, error: unknown): void {
  if (warned.has(message)) return;
  warned.add(message);
  try {
    console.warn(`[mg.js] ${message} (further occurrences suppressed)`, error);
  } catch {
    // No console available.
  }
}
/** Clear the warn-once memo. Exported for tests, which must not be silenced by a previous case. */
export function resetWarnOnce(): void {
  warned.clear();
}
```

```ts
// packages/bootstrapped/src/render/rive.ts:429-447
const warnedKeys = new Set<string>();
function defaultRiveErrorHandler(failure: RiveFailure): void {
  if (failure.unsupported) return;
  const key = `${failure.operation}:${failure.name ?? ''}`;
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  try {
    console.warn(`[mg.js] Rive ${failure.operation} failed (further occurrences suppressed)`, failure.error);
  } catch {
    // No console.
  }
}
/** Clear the warn-once memo. Exported for tests. */
export function resetRiveWarnings(): void {
  warnedKeys.clear();
}
```

```ts
// packages/bootstrapped/src/render/world.ts:978-993
const warnedOperations = new Set<string>();
function defaultWorldErrorHandler(operation: string, error: unknown): void {
  if (warnedOperations.has(operation)) return;
  warnedOperations.add(operation);
  try {
    console.warn(`[mg.js] WorldScene ${operation} failed (further occurrences suppressed)`, error);
  } catch {
    // No console.
  }
}
/** Clear the warn-once memo. Exported for tests. */
export function resetWorldWarnings(): void {
  warnedOperations.clear();
}
```

**Change.** Create `packages/bootstrapped/src/render/warn-once.ts`:

```ts
/**
 * Warn at most once per key, in one implementation.
 *
 * ## Why one factory and not one shared memo
 *
 * The failure paths that use this run at frame rate; a `console.warn` per frame is its own performance
 * problem and it also buries the *first* occurrence, which is the only informative one. Three modules grew
 * the same helper (`graphics.ts`, `rive.ts`, `world.ts`), each with its own memo and its own exported reset.
 *
 * The memo stays **per caller** (the factory), because collapsing them into one shared `Set` would make
 * `resetWarnOnce()` in `graphics.ts` silence a warning in `world.ts` for the rest of the process. That is a
 * behaviour change no test would catch and no reader would expect. What had three homes was the
 * *implementation*, and that is what this module owns.
 *
 * ## Why the message is a parameter and not derived from the key
 *
 * The three callers key differently (`graphics` keys on the whole message, `rive` on
 * `operation:name`, `world` on `operation`) and format differently (`[mg.js] Rive setTextRunValue failed`,
 * `[mg.js] WorldScene addSprite failed`). Deriving the text from the key would change two of the three
 * consoles, so the key and the text are separate arguments and every existing string is reproduced exactly.
 */

/** A warn-once function with its own reset. */
export interface WarnOnce {
  /** Log `message` and `error` the first time `key` is seen; stay silent for every later `key`. */
  (key: string, message: string, error: unknown): void;
  /** Forget every key. */
  reset(): void;
}

/** Create an independent warn-once memo. One per module, so one module's reset cannot silence another's. */
export function createWarnOnce(): WarnOnce {
  const seen = new Set<string>();
  const call = ((key: string, message: string, error: unknown): void => {
    if (seen.has(key)) return;
    seen.add(key);
    try {
      console.warn(`[mg.js] ${message} (further occurrences suppressed)`, error);
    } catch {
      // No console available.
    }
  }) as WarnOnce;
  call.reset = (): void => {
    seen.clear();
  };
  return call;
}
```

Then, preserving every call site and every exported reset:

- `graphics.ts`: `const warn = createWarnOnce();`, keep the local adapter so `:162`/`:197` do not change:

  ```ts
  const warn = createWarnOnce();
  function warnOnce(message: string, error: unknown): void {
    warn(message, message, error);
  }
  /** Clear the warn-once memo. Exported for tests, which must not be silenced by a previous case. */
  export function resetWarnOnce(): void {
    warn.reset();
  }
  ```

- `rive.ts`: `const warn = createWarnOnce();` and
  `warn(\`${failure.operation}:${failure.name ?? ''}\`, \`Rive ${failure.operation} failed\`, failure.error);`,
  with the `if (failure.unsupported) return;` line kept **before** the call (it is a "do not log this class at
  all" rule, not a warn-once rule). `resetRiveWarnings()` delegates to `warn.reset()`.
- `world.ts`: `warn(operation, \`WorldScene ${operation} failed\`, error)` and `resetWorldWarnings()`
  delegates.
- `bootstrapped/src/index.ts:229, 247, 293` keep exporting the three reset names unchanged.
- Do **not** add a `warn-once` row to DESIGN §4.2's bootstrapped tree: it already lists
  `render/... warn-once.ts` at `:266`. (Check it; if the row is absent in the version you read, add it.)

**Test first.** New `packages/bootstrapped/tests/warn-once.test.ts`:

```ts
void test('createWarnOnce logs the first key once and stays silent afterwards', () => {
  const lines: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]): void => { lines.push(args); };
  try {
    const warn = createWarnOnce();
    warn('addSprite', 'WorldScene addSprite failed', 'first');
    warn('addSprite', 'WorldScene addSprite failed', 'second');
    warn('removeSprite', 'WorldScene removeSprite failed', 'third');
    assert.deepEqual(lines, [
      ['[mg.js] WorldScene addSprite failed (further occurrences suppressed)', 'first'],
      ['[mg.js] WorldScene removeSprite failed (further occurrences suppressed)', 'third'],
    ]);
    warn.reset();
    warn('addSprite', 'WorldScene addSprite failed', 'fourth');
    assert.equal(lines.length, 3, 'reset forgets every key');
  } finally {
    console.warn = original;
  }
});

void test('two memos are independent', () => {
  const a = createWarnOnce();
  const b = createWarnOnce();
  const lines: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]): void => { lines.push(args); };
  try {
    a('k', 'm', 1);
    a.reset();
    b('k', 'm', 2);
    assert.equal(lines.length, 2, 'a reset in one module must not silence another module');
  } finally {
    console.warn = original;
  }
});
```

plus the "no fourth copy" scan in `packages/bootstrapped/tests/render-owner.test.ts`:

```ts
void test('warn-once has one implementation and three callers', () => {
  const render = everySourceFileIn('bootstrapped').filter((f) => f.includes('/render/'));
  const declaring = render.filter((f) => /warned\w*\s*=\s*new Set<string>/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(declaring.map(basename), ['warn-once.ts'], 'a fourth memo is a fourth warn-once');
});

void test('the three helpers have one home each', () => {
  const sources = new Map(everySourceFileIn('bootstrapped').map((f) => [f, readFileSync(f, 'utf8')]));
  const count = (re: RegExp): string[] =>
    [...sources].filter(([, s]) => re.test(s)).map(([f]) => f.slice(f.indexOf('packages/')));
  assert.deepEqual(count(/function detach(Node)?\s*\(/), ['packages/bootstrapped/src/render/text.ts']);
  assert.deepEqual(count(/function getGraphicsCtor\s*\(/), ['packages/bootstrapped/src/render/ctors.ts']);
  assert.deepEqual(count(/function isRive(Host)?Like\s*\(/), ['packages/bootstrapped/src/render/ctors.ts']);
  assert.deepEqual(count(/function (asGraphics|isGraphicsLike)\s*\(/),
    ['packages/bootstrapped/src/render/ctors.ts', 'packages/bootstrapped/src/render/world.ts'],
    'asGraphics is the narrowing form of the one predicate, and it must delegate');
});
```

Observed failures before: the `warn-once.ts` module does not exist (module-not-found); the first scan names
`graphics.ts`, `rive.ts`, `world.ts` (three memos); the helper scan names `text.ts` + `world.ts` for
`detach(Node)`, `ctors.ts` + `sprite.ts` for `getGraphicsCtor`, `ctors.ts` + `world.ts` for
`isRive(Host)?Like`.

**Acceptance.**

- `npm run verify` green, including `bootstrapped/tests/world.test.ts`, `ctors.test.ts` and
  `render`-adjacent coverage.
- `git grep -n "console.warn(" -- packages/bootstrapped/src/render` → exactly one hit, inside `warn-once.ts`.
  (The bare words `console.warn` also appear in three *comments* (`graphics.ts:270`, `rive.ts:112`,
  `world.ts:125`), and `console.warn(` appears at `graphics.ts:279`, `rive.ts:438` and `world.ts:984` before
  the change. After it, the three call sites are gone and only `warn-once.ts` logs. Note that
  `coexistence/brand.ts:299`, `storage.ts:336, 379` and `userscript.ts:225, 275` also warn, with no
  once-per-key memo: they are not warn-once callers and are out of scope.)
- `git grep -c "function detachNode" -- packages` → `0`.
- `npm run size` inside budget. This task shrinks the bundle.

**Risk / revert.** Drift per helper is enumerated under 3.7a-3.7e; the four observable changes in the whole
task are (i) `getGraphicsCtor`'s arity (3.7b, a widening), (ii) `isRiveLike`'s acceptance of callables (3.7c,
a widening), (iii) `rive.isArtboardLike`'s structural fallback now accepting an `artboard`-only node (3.7c, a
correctness fix that widens), and (iv) `asGraphics(null)` returning `null` instead of throwing a `TypeError`
(3.7d, a hardening). Everything else is byte-identical behaviour, and every one of the four has a test that
fails before it, and that is what makes this task reviewable as five separately rejectable edits rather than
one
big "dedupe 3.7". Revert per sub-task: 3.7a-3.7e are five independent edits in different files, so any one can
be reverted alone; the only shared artefact is `warn-once.ts` (3.7e's own file).

---

## Task 3.8: `PreviousFn`, make the `previous` hook callable instead of escaped

**Status: COMPLETE**: `export type PreviousFn = (this: unknown...args: unknown[]) => unknown`
is at `bootstrapped/src/coexistence/brand.ts:198` and re-exported from `bootstrapped/src/index.ts`; the
`args: never[]` signature and the escapes in `catalog/bundle.ts`, `coexistence/renumber.ts` and
`coexistence.test.ts` are gone. Guard: `coexistence.test.ts`. This section's acceptance greps were
re-checked against the tree and all hold.

**Surviving copy.** The type is new; the *home* is `coexistence/brand.ts`, where `InstallHookOptions` is
declared (`:188-208`) and where both the classification and the chaining live.

**Copies deleted**: three type escapes plus the signature that forced them.

```ts
// packages/bootstrapped/src/coexistence/brand.ts:196-207
  /**
   * Build the wrapper, given the function currently in the slot.
   *
   * Called only when we are actually installing. `previous` is `undefined` when the slot held no
   * function, and is the function that was there otherwise, which for a `'foreign'` classification is
   * the other mod's wrapper, and must be called through rather than discarded.
   *
   * Typed with `unknown` arguments rather than a generic function type: the two hooks this package
   * installs take different shapes (`(data: unknown) => void` and `(payload: unknown) => boolean`), and a
   * single generic parameter that fit both would only be satisfied by casts at every call site.
   */
  wrap: (previous: ((...args: never[]) => unknown) | undefined) => (...args: never[]) => unknown;
```

Note the doc's own claim, *"a single generic parameter that fit both would only be satisfied by casts at
every call site"*, is the bug: `never[]` arguments make `previous` **uncallable through its type**; that is
why every chaining site casts. `unknown[]` fits both shapes without a cast.

```ts
// packages/bootstrapped/src/catalog/bundle.ts:324-328
        if (typeof previous === 'function') {
          return (previous as (this: unknown, v: unknown) => unknown).call(this, value);
        }
        return [];
      } as (...args: never[]) => unknown,
```

```ts
// packages/bootstrapped/src/coexistence/renumber.ts:592-593, 618
        if (typeof previous === 'function') {
          (previous as (this: unknown, d: unknown) => void).call(this, outgoing);
          return;
        }
        …
      return brandWrapper(wrapper, `renumber:${key}`) as (...args: never[]) => unknown;
```

```ts
// packages/bootstrapped/src/attach/raw-socket.ts:327-331
          if (typeof previous === 'function') {
            return (previous as (this: unknown, d: unknown) => unknown).call(this, result);
          }
          return original.call(this, result);
        } as (...args: never[]) => unknown,
```

```ts
// packages/bootstrapped/tests/coexistence.test.ts:140-146
    wrap: (previous) =>
      function wrapper(this: unknown, value: unknown): void {
        calls.push('ours');
        // `previous` is typed `(...args: never[]) => unknown` by `installHook` on purpose (its two
        // callers take different shapes), so it cannot be invoked through a typed call.
        if (previous !== undefined) Reflect.apply(previous, this, [value]);
      } as (...args: never[]) => unknown,
```

and the same escape in two more test sites, `coexistence.test.ts:166` and `:175`
(`return (() => undefined) as unknown as (...args: never[]) => unknown;`).

**Change.**

1. `brand.ts`: add, above `InstallHookOptions`:

   ```ts
   /**
    * The function a hook chains onto, typed so it can actually be called.
    *
    * `(...args: never[]) => unknown` reads as "takes no argument that can be supplied": a `never[]`
    * parameter list makes the function *uncallable through its type*, so every chaining site had
    * to escape the type system to call it: two hand-written `as` casts, a third in a test, and a
    * `Reflect.apply`. `unknown[]` is the honest type of "whatever shape the slot held", and the wrapper's
    * author is the one who knows that shape; that is the contract a hook API can keep.
    */
   export type PreviousFn = (this: unknown, ...args: unknown[]) => unknown;
   ```

   and change the signature, deleting the false paragraph from the doc:

   ```ts
     /**
      * Build the wrapper, given the function currently in the slot.
      *
      * Called only when we are actually installing. `previous` is `undefined` when the slot held no
      * function, and is the function that was there otherwise, which for a `'foreign'` classification is
      * the other mod's wrapper, and must be called through rather than discarded. Its arguments are the
      * caller's responsibility: see {@link PreviousFn}.
      */
     wrap: (previous: PreviousFn | undefined) => (...args: unknown[]) => unknown;
   ```

2. `brand.ts:237`: `(existing as (...args: never[]) => unknown)` becomes `(existing as PreviousFn)`.
3. `bundle.ts:309-328`: delete both casts, and widen the wrapper's parameter from `never` to `unknown`
   (the `never` was there only to satisfy the old `wrap` return type):

   ```ts
     wrap: (previous) =>
       function captureObjectKeys(this: unknown, value: unknown): unknown {
         …
         if (previous !== undefined) return previous.call(this, value);
         return [];
       },
   ```

4. `renumber.ts:601-619`: `previous.call(this, outgoing);` (no cast) and
   `return brandWrapper(wrapper, \`renumber:${key}\`);` (no cast: `brandWrapper<T extends object>(fn: T, label):
   T` returns the wrapper's own type, `brand.ts:96`).
5. `raw-socket.ts:324-331`: delete both casts, `return previous.call(this, result);`.
6. `coexistence.test.ts:140-146`: `if (previous !== undefined) previous.call(this, value);`, delete the cast
   and replace the comment with a pointer to `PreviousFn`; `:164-176`: `return () => undefined;` with no
   casts.
7. Leave `headless/src/client.ts:288/513/515` alone, because task 3.2 deletes them. Leave
   `headless/tests/helpers/fake-socket.ts:35/71/80` alone for this task; see "Additional duplication".

**Test first: the typechecker is the test.** This is a types-only change, so the failing-first step is
mechanical and stronger than a runtime assertion:

1. Delete the three casts in `bundle.ts`, `renumber.ts`, `raw-socket.ts` and the `Reflect.apply` in
   `coexistence.test.ts` **first**, leaving `brand.ts` untouched.
2. Run `npx tsc -p tsconfig.tests.json` and observe the failures. Expected
   `TS2349: This expression is not callable. Type 'never' has no call signatures.` at
   `bundle.ts:325`, `renumber.ts:593`, `raw-socket.ts:328`, and
   `TS2349`/`TS2554` at `coexistence.test.ts:145`. Record the exact output in the commit body.
3. Then change `brand.ts`. Re-run: exit 0.
4. After the type change, `brand.ts:618`-equivalent and `:331` casts are *also* unnecessary
   (`brandWrapper` returns `T`), so their removal is verified by the same compile.

A runtime test accompanies it, because the *behaviour* must not change: extend
`coexistence.test.ts`'s existing chaining test (`:129-155`) to assert the chain still calls through with the
right `this` and arguments. It already does (`calls` deep-equals `['ours', 'foreign:x']`), and after the
change it does so **without any cast**, which is the whole point. Add one case for an arity the old type
could not express:

```ts
void test('PreviousFn lets a wrapper call through with more than one argument', () => {
  const seen: unknown[] = [];
  const target: Record<string, unknown> = { send: (...args: unknown[]): void => { seen.push(args); } };
  installHook({
    target, key: 'send', label: 'test.send',
    wrap: (previous) => function wrapper(this: unknown, a: unknown, b: unknown): void {
      previous?.call(this, a, b);
    },
  });
  (target['send'] as (a: unknown, b: unknown) => void)('x', 'y');
  assert.deepEqual(seen, [['x', 'y']]);
});
```

This test **cannot be written today**: `previous?.call(this, a, b)` is `TS2349` under
`(...args: never[]) => unknown`. That is the observed "before" failure.

**Acceptance.**

- `npx tsc -p tsconfig.tests.json` exit 0 **with no `as` cast at any chaining site**. That, not the exit code
  alone, is the proof.
- `npx tsc -b --force` exit 0.
- `npm run verify` green.
- `git grep -n "args: never\[\]" -- packages/*/src packages/*/tests` → hits only in
  `headless/tests/helpers/fake-socket.ts` (see below), `0` in `packages/bootstrapped`.
- `git grep -n "Reflect.apply" -- packages` → `0`.
- `git grep -c "export type PreviousFn" -- packages` → `1`.
- No public name changes: `installHook`, `InstallHookOptions`, `InstalledHook`, `InstallOutcome` and
  `PreviousFn` (new) are all still exported from `coexistence/brand.ts`. `PreviousFn` is a *new* public name;
  decide whether to add it to `bootstrapped/src/index.ts`'s hand-enumerated exports. **Recommendation: yes**,
  because it is the type a caller writing a `wrap` needs, and hand-enumeration exists so a name cannot be
  silently
  withheld. Add it to the brand group and name the addition in the commit body.

**Risk / revert.** Drift, enumerated: the three call sites escaped the type in three *different* ways:
`bundle.ts` and `raw-socket.ts` with `as (this: unknown, ...) => unknown`, `renumber.ts` with
`as (this: unknown, ...) => void`, and the test with `Reflect.apply(previous, this, [value])`. All three were
working around one signature. The merge removes all of them; the **behaviour is unchanged**, because each
escaping call already passed `this` and the same arguments. Verify each of the three by reading the diff, and
note that `Reflect.apply` returns the callee's return value where `previous.call(...)` does too, so the test's
return type (`void`) is preserved by the wrapper's declared `: void`. One genuine widening: a wrapper may now
declare any parameter list, including one the old type rejected, and that is deliberate. It is a *type-level*
widening only (the runtime did it already, via the cast). Revert: `git revert <sha>`, and the casts come back
exactly as they were.

---

## Verification plan for the phase

**Per task (every commit):**

```bash
npm run verify          # lint → typecheck(src+tests) → build → test → size. Must exit 0
```

plus the task's own `git grep` acceptance lines from its section.

**Phase gate: one new test file, run by `npm test`.** Create
`packages/bootstrapped/tests/one-home.test.ts` (or extend the per-task scans into it) so the phase's
"no fourth copy" rule is executed by the suite rather than by a reviewer's memory. It asserts, over
`packages/*/src/**/*.ts` read as text:

| helper | exactly-one-declaration pattern | home |
|---|---|---|
| `Unsubscribe` | `/^\s*export type Unsubscribe\b\s*=/m` | `common/src/unsubscribe.ts` |
| the emitter dispatch loop | `/for \(const listener of \[\.\.\./` | `common/src/emitter.ts` |
| `asEnvelope` / `parseEnvelope` | `/function (asEnvelope\|parseEnvelope)\s*\(/` | `coexistence/envelope.ts` |
| the deadline poll | `/Date\.now\(\) - start/` and `/const tick = /` | `common/src/poll.ts` |
| the Node-timer teardown | `/'unref' in/` | `common/src/poll.ts` (plus the documented `client.ts:625`) |
| the sequence rule | `/Number\.isInteger\((value\|frontier\|seed\|rawSequence\|executedCommandSequence)\)/` | `common/src/protocol/codec.ts` |
| `Number.isFinite` on a frontier/sequence | `/Number\.isFinite\(\w*(sequence\|frontier\|seed)\)/` | nowhere |
| `DEFAULT_RECONNECT` values | `/maxDelayMs: 60_000/` | `common/src/protocol/types.ts` |
| `detach` / `getGraphicsCtor` / `isRiveLike` / `isGraphicsLike` | as in 3.7's scan | `render/text.ts`, `render/ctors.ts` |
| warn-once memos | `/warned\w*\s*=\s*new Set<string>/` | `render/warn-once.ts` |
| `args: never[]` in bootstrapped | `/args: never\[\]/` | nowhere |
| `Reflect.apply` | `/Reflect\.apply/` | nowhere |

**Correction (the `warn-once memos` row).** The pattern `/warned\w*\s*=\s*new Set<string>/` matches
**nothing** (`git grep -n "warned.*new Set<string>" -- packages` → 0). The surviving declaration is
`const seen = new Set<string>()` at `render/warn-once.ts:35`, and the three per-caller memos the row wanted
to forbid are gone. The row's *home* is right; its regex is wrong.

A source scan is not a type-level guarantee, so it is paired with the *behavioural* test each task adds at the
new home. Where a helper is a value (`Emitter.clear`, `pollUntil`, `createWarnOnce`, `PreviousFn`'s
callability), the structural assertion is `assert.equal(fnA, fnB)` or a real call, which is strictly stronger.

**Public-surface check.** `npm run build && npm test -w @mg.js/headless` runs `exports-map.test.ts`, which
imports every `exports` target and asserts its documented names. No task adds an `exports` subpath, so the map
should not change; if it does, that is a signal a task moved a module rather than a helper.

**Bundle check.** `npm run size` (`scripts/assert-bundle-size.ts`) is the only gate that sees the userscript;
3.2, 3.4, 3.7 and 3.8 all change its input. Expect a net decrease; a net *increase* means a loop was copied
back in.

**Phase exit criteria.**

- [x] `npm run verify` exit 0, bundle inside budget, no test skipped. **Done.** `npm run verify` exit 0;
  `npm test` 736 / 0 fail / 0 skipped (bootstrapped 181, common 386, headless 169); `npm run size` 291.2 KiB
  (298,233 B), within budget.
- [x] Every row of the table above has exactly one home. **Done**, by each task's acceptance greps, with the
  one exception recorded under the table (`warn-once memos`, whose regex matches nothing).
- [x] Every behaviour change named in a commit body has a test that failed before it: 3.3a (the rewriter throw),
  3.5's twelve drift rows (including the `Welcome{2.5}` disagreement), 3.7b's arity, 3.7c's two widenings,
  3.7d's `null` hardening, 3.6's identity assertion. **Done**: each change is named in the commit body
 (`git show -s --format=%B` on,) and pinned
  by the tests those commits add. The failing-first runs were not re-executed in this bookkeeping pass.
- [x] `docs/DESIGN.md` §4.2 gains the `common/src/poll.ts` row (3.4) and nothing else changes there. **Done**:
 row at `docs/DESIGN.md:223`; separately updated §6 I3/I4/I5.
- [x] The master plan's Phase 3 table is corrected on the four anchors this plan falsifies
  (`common/protocol/codec.ts` for 3.3, `verify-live*` for 3.4, `attach/detect.ts` for 3.6, and
  `coexistence/outbound.ts` for 3.7), and `docs/plans/2026-09-13-code-consistency.md`'s Phase 3 heading gets a
  "Status: COMPLETE" line naming the nine commits, the same convention Phase 0 and Phase 1 used. **Done**,
  in `2026-09-13-code-consistency.md`; the "nine commits" guess is corrected there to the actual fourteen.
- [x] The exit note records the three deferred findings with evidence and a recommendation, so they survive the
  phase: `findNode`'s budget off-by-one (item 21), the four-way install/restore family (item 15), and the
  inert `DEFAULT_LIFECYCLE_TIMEOUTS.openMs` (item 14). Do not fix them in this phase; do not drop them either.
  **Done**: the plan has no separate "exit note" section, so items 14, 15 and 21 in "Additional duplication"
  carry the evidence and an explicit disposition, and that is what survives the phase.

---

## Additional duplication found (report 20 missed or under-counted)

1. **`Renumberer` validates a frontier twice, two different ways, inside one file.** `renumber.ts:158, 242,
   361, 376` use `Number.isFinite`, while `renumber.ts:425`'s own `asSequence` requires an integer ≥ 0. So one
   file accepts a fractional frontier when seeding and rejects a fractional `commandSequence` when rewriting.
   Report 20 counts "five" copies; the real number is **ten** (`codec.ts:130`, `client.ts:930`,
   `room-connection.ts:246`, `raw-socket.ts:161`, `renumber.ts:425` + `renumber.ts:158/242/361/376` +
   `sequencer.ts:116/195/222` + `envelope.ts:117`). Disposition: **task 3.5**, row 7-12 of its drift table.
2. **`readWelcomeFrontier` and `extractFrontier` are the same function, in two packages.**
   `bootstrapped/src/client.ts:926-932` vs `common/src/protocol/codec.ts:126-131`: same guard, same field,
   same return. Report 20 lists `readWelcomeFrontier` only as an *integer-rule* copy and never notices the
   whole function is duplicated. Disposition: **task 3.5**, step 6 (`readWelcomeFrontier` becomes a re-export).
3. **The Node-timer `unref` teardown is four copies in three spellings.** `attach/transport.ts:481-486`
   (guarded + `try/catch`), `jotai/bridge.ts:537-540` (guarded, no `try/catch`, so a throwing `unref` escapes
   `release()`), `catalog/bundle.ts:346-348` (`isPlainObject` gate, no `try/catch`), `headless/client.ts:625`
   (`unref?.()`). Report 20 §3 mentions it as a footnote to the poll; the master plan never makes it a task.
   The two unguarded copies are a real (if narrow) I7 hazard. Disposition: **task 3.4b**.
4. **Three near-identical finite-number readers in `render/`.** `world.ts:796-798` `asFiniteNumber` (exported),
   `graphics.ts:259-264` `readNumber` (projection over `width`/`height`), `sprite.ts:116-128` `readSize`
   (same core plus `> 0` and a holder walk). Report 20 does not mention them. Disposition: **a follow-up task
   (3.9), not this phase**: `asFiniteNumber` is already the surviving public name and the two others are
   different projections, so the merge is `readNumber`/`readSize` delegating, which is mechanical but touches
   three render files that 3.7 already touches. Keep 3.7 to its six helpers.
5. **`interceptOutbound`'s "never drop the host's frame" policy is implemented twice, once correctly and once
   not.** `room-connection.ts:413-423` wraps every interceptor in `try/catch`; `raw-socket.ts:326` calls the
   rewriter bare. Report 20 §4 raises the consequence but frames it as part of the envelope split, not as a
   duplicated policy. Disposition: **task 3.3a**.
6. **`common/src/actions/index.ts:6-7`'s explicit re-export is dead** (`export type { CrystalIntent, ShopKey }
   from './types.js';` immediately before `export * from './types.js';`). Noted by audit 22 §4. It is a
   duplicated *export*, not an implementation. Disposition: **leave it to Phase 5.2** (the barrel rewrite is
   that task's whole subject); record it here so 3.1's `state/index.ts` fix is not mistaken for the same
   change.
7. **The master plan's 3.4 anchor names `scripts/verify-live*`, which are not polls.** The scripts were renamed
 (`verify-live.ts → verify-catalog.ts`, `verify-live-socket.ts → verify-socket.ts`, the commit) and use
   `Promise.race` deadlines, not poll loops: `scripts/verify-socket.ts:228-234` builds one deadline promise and
   races it at `:262`, `:286`, `:330`, clearing it at `:354`. There is no `pollUntil`-shaped loop in `scripts/`.
   Disposition: **correct the anchor** (Verification plan, exit criteria); no dedupe needed. `verify-catalog.ts`
   has no polling at all.
8. **`(...args: never[]) => void` as a listener-map element type is the same anti-pattern as `previous`.**
   `headless/tests/helpers/fake-socket.ts:35, 71, 80` declare a `Set<(...args: never[]) => void>`, which is
   uncallable through its type. Task 3.2 deletes the production instances
   (`headless/src/client.ts:288/513/515`); the test helper remains. Disposition: **follow-up**, not 3.8,
   3.8 is about one hook signature and a reviewer should be able to reject the fake-socket change without
   touching `PreviousFn`. Prefer `Listener<unknown[]>` from `@mg.js/common`.
9. **Report 20's "3 copies" of `asEnvelope` counts a file that has none.** `common/src/protocol/codec.ts` has
   no envelope predicate, and the master plan at `:516` and the Phase 3 table at `:693` both route the fix
   there. The real pre-change inventory is two functions × two files. Disposition: recorded in **task 3.3**,
   with the landed home (`coexistence/envelope.ts`) recommended over the anchor.
10. **Report 20's warning about two renumbering mechanisms is unresolved and belongs here.** Master plan
    `:485-490`: `bootstrapped/src/client.ts:460-470` and `:600-604` renumber through
    `attachment.setOutboundRewriter`, while `installRenumberHook` (`renumber.ts:558`) wraps a `send` slot for
    third-party mods and has **no production caller** (`git grep -n installRenumberHook -- packages scripts` →
    only tests and the package export). A mod that installs on the slot the attachment already rewrites puts
    two rewriters on one wire, which is I1's failure mode. Disposition: **out of scope for Phase 3** (it is a
    policy question for DESIGN §6 I1, as the master plan itself says); record it so the Phase 3 dedupe is not
    mistaken for having settled it.

### Found by a delegated repo-wide scan, and spot-verified

These came from a separate duplication hunt that read the tree at the boundary; the ones below were re-checked
by opening the cited lines (three were re-checked again at the boundary after the tree moved: the render and
script files were untouched by 3.3's commits, so their line numbers still hold). They are **not** in Phase 3's
scope), the master plan's seven reimplementations stay bounded, but three of them are latent bugs and belong
on the Phase 2/5 backlog with a named disposition rather than in a report nobody re-reads.

11. **A fourth emitter: the namespace event bus re-implements `Emitter`'s core.**
    `bootstrapped/src/realm.ts:293-311` (`onNamespaceEvent`) and `:314-331` (`emitNamespaceEvent`) reproduce
    get-or-create `Set`, **prune the emptied `Set`** (`:308-309`, the same teardown `emitter.ts:42` has) and
    swallow a throwing listener with the same reasoning. Report 20 §2 counts three Emitter copies and misses
    this one. It is not an `Emitter` *instance*; the map lives on a page-shared namespace object
    (`realm.ts:90`) so two loads can share it, and that is why the fix is free functions
    (`subscribeIn(map, event, handler)` / `emitIn(map, event, args)`) exported from `common/src/emitter.ts`
    and called by both, not a substitution. **Disposition: follow-up task (3.10), after 3.2**. It needs
    3.2's `onListenerError` hook to exist before the two can share one dispatcher.

12. **The Rive key test exists three times and one copy lost a key, a correctness drift.**
    `ctors.ts:382-386` tests `'rive' | 'artboard' | 'stateMachine'`; `world.ts:908-912` tests
    `'artboard' | 'stateMachine' | 'rive'` (same set, different order); `rive.ts:398` tests only
    **`'stateMachine' | 'rive'`**, which omits `'artboard'`. So a node carrying only `artboard` is Rive-like to
    two modules and not to the third. The three also disagree on functions: `ctors.ts:357-359`'s `isObject`
    accepts `typeof === 'function'`, the other two reject it (this is 3.7c's drift, and it has a *third*
    instance). Disposition: **task 3.7c**, extended, since `rive.ts:398`'s fallback also calls `isRiveLike`
    from `ctors.js`, and the "no fourth copy" scan in 3.7 covers all three. This is the one item in this list
    that Phase 3 should absorb rather than defer, because 3.7 already touches all three files and the change is
    one line each.

13. **`asOutboundString` lies about its return type, and it is reachable.**
    `packages/bootstrapped/src/attach/raw-socket.ts:171-178` is declared `(frame: unknown): string | null` but
    returns `JSON.stringify(frame)` from inside its `try`. `JSON.stringify(undefined)` **returns** `undefined`
    rather than throwing (so does a function or a symbol), and TS's `JSON.stringify` overload says `string`,
    and that is why `strict` does not catch it. The room path's sibling guards this explicitly
    (`room-connection.ts:829-831` returns `null` for `undefined`). **Disposition: a one-line fix worth doing
    now**: `const json = JSON.stringify(frame); return json ?? null;`, but it is not a duplication task, so
    attach it to phase 2's wire-hardening work rather than to 3.7/3.8. Flagged because it is a real type lie
    in a frame path.

14. **`DEFAULT_OPEN_TIMEOUT_MS` shadows `DEFAULT_LIFECYCLE_TIMEOUTS.openMs`, and the "home" copy is dead.**
    `headless/src/transport/client.ts:110-111` declares `const DEFAULT_OPEN_TIMEOUT_MS = 20_000;` with the
    comment *"mirroring `DEFAULT_LIFECYCLE_TIMEOUTS.openMs`"* (repeated in prose at `:86`), while
    `common/src/transport/types.ts:100-104` declares the real object. **Verified:** `git grep -n
    "DEFAULT_LIFECYCLE_TIMEOUTS"` finds exactly one reader, `common/src/client.ts:160`'s merge, and
    `openMs` is then **never read**: `ClientCore` uses only `welcomeMs` (`:270`) and `commandAckMs`
    (`:375`), and `HeadlessClient` forwards only `openTimeoutMs` (`headless/src/client.ts:263, 340, 746`). So
    changing `openMs` changes nothing, and this is report 20 §6's `DEFAULT_RECONNECT` shape in a second place
    with the duplication *inverted* (the canonical copy is the dead one). Disposition: **follow-up**:
    default from `DEFAULT_LIFECYCLE_TIMEOUTS.openMs`; a consumer of a documented option that is inert is an I8
    finding, and I8 belongs to Phase 8.1/2, not 3.

15. **The identity-guarded install/restore pattern has four homes, two of them hand-rolled.**
    `coexistence/brand.ts` is the documented one (`installHook` `:227-252`, `restoreSlot` `:269-279`, and
    `catalog/bundle.ts:222-226` says it uses it precisely so a second call reports `'reused'`). The
    hand-rolled ones are `render/pixi.ts:131-141` + `:243-250` (its own `HookSlot`, `readHook`, `callThrough`)
    and `render/world.ts:153-168` + `:319-332` + `:875-905` (`Restore`, reverse-order unwind,
    `recordAndWrapNoop`, `recordAndSet`). **Verified drift:** the absence test differs, in that
    `brand.ts:275-277` deletes the slot when `original === undefined` (its doc explains why: an own
    `undefined` property shadows a prototype member and `'send' in X` changes), while
    `world.ts:880, 900` keys on `Object.hasOwn(target, key)` and therefore *restores an own `undefined`*.
    Opposite outcomes for the same input. The idempotence difference is worse: `pixi.ts` and `world.ts` have
    no brand, so a userscript plus an importing mod double-wrap the Pixi init hooks. That is the failure
    `bundle.ts:222-226` says the shared installer prevents (DESIGN I2). Disposition: **out of scope for Phase
    3**: it is not a duplicated *helper* but a duplicated *mechanism*, and routing `pixi.ts` through
    `installHook` changes hook identity and therefore I2's test surface. It belongs with Phase 5.4's
    `realm.ts`/`render/` splits or its own task; record it so it is not lost.

16. **The Pixi texture-construction ladder is written twice, with a throw-vs-null drift.**
    `render/sprite.ts:184-201` (`withFrom.from(source)` → `new TextureCtor(source)` → `new TextureCtor({
    source })`) and `render/world.ts:952-973` are the same three routes with the same guard; the drift is the
    third route: `sprite.ts:201` lets it throw, `world.ts:969-971` catches and returns `null`. The *cache*
    difference (`sharedTextures` keyed by string vs a `WeakMap` keyed by the `<img>` element) is deliberate and
    documented at `world.ts:935-942`; the construction ladder is not. Disposition: **follow-up** (extract
    `constructTexture(TextureCtor, source, cache)` in `sprite.ts`, inject the cache); 3.7 already edits both
    files, so it could ride along, but a reviewer should be able to reject it without rejecting 3.7, which is
    the phase's stated rule, so it stays out.

17. **`describeClose` is byte-identical in two scripts, doc comment included.**
    `scripts/verify-socket.ts:93-96` and `scripts/probe-guest-encoding.ts:111-114` declare the same function
    *and* the same JSDoc. It is also a fourth place that formats a close code beside
    `analyzeClose`/`CLOSE_CODE_LABELS` (`common/src/protocol/close-codes.ts:245-252`), so it inherits report
    20 §5's missing `1000`/`1001` labels. Disposition: **fold into Phase 2's `closeCodeLabel` work** (report 20
    §5); if that is deferred, `scripts/lib/` is the right home. Not Phase 3.

18. **The default origin is a literal in three modules.**
    `common/src/catalog/platform-source.ts:65`, `headless/src/session.ts:206` and
    `headless/src/transport/headers.ts:31` (`DEFAULT_ORIGIN`) each spell `'https://magicgarden.gg'`, on top of
    the three `.replace(/\/+$/, '')` copies report 20 §8 already lists. `common/src/protocol/connect-url.ts:18`'s
    `DEFAULT_HOST` is a *host*, not this value, so it is not the shared home. Disposition: **follow-up**
    (one `DEFAULT_ORIGIN` in `common`, imported by both headless sites); low risk, no behaviour change.

19. **Duplicated test fixtures beyond report 20 §7.** §7 names two `FakeRoomConnection`s and two
    `makeClient` factories; the tree has **three** `FakeWebSocket`s
    (`client-lifecycle.test.ts:25-44`, `room-upgrade.test.ts:88-118`, plus the headless keepalive one §7 names)
    and **three** `makeClient` factories for `BootstrappedClient` (`catalog-sources.test.ts:21`,
    `client-lifecycle.test.ts:46`, `room-upgrade.test.ts:274`), a duplicated `servers[]`/`afterEach` teardown
    loop (`headless/tests/integration.test.ts:40-53` ≡ `credential-leak.test.ts:40-53`), two `stubFetch`
    helpers with different arities (`session.test.ts:30-40` vs `credential-headers.test.ts:26-33`), and a
    byte-identical abort-aware fetch stub (`session.test.ts:111-118` ≡ `credential-headers.test.ts:119-126`).
    **Verified as a set** by name and line; not re-read line by line. Disposition: **Phase 6/7 test work**
    (DESIGN §4.3's `tests/fixtures/`), not Phase 3, but note that the duplicated *headless* client factory
    has a behaviour difference that matters: `integration.test.ts`'s passes `maxDelayMs: 80` and no
    `openTimeoutMs` (so it rides item 14's unlinked 20 s literal) while `credential-leak.test.ts`'s passes
    `openTimeoutMs: 2000` and no `maxDelayMs`. Record it against item 14.

20. **The script CLI wrapper is duplicated four ways.** The
    `process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)` guard plus a
    fatal-error handler appears at `scripts/verify-socket.ts:394-399` and
    `scripts/probe-guest-encoding.ts:338-343`, with the no-catch variant at
    `scripts/assert-bundle-size.ts:114-116` and **no guard at all** at `scripts/verify-catalog.ts:158-161`
    (which therefore runs `main()` on import, an I8-adjacent hazard). The PASS/FAIL reporter drifts in width
    (`verify-socket.ts:216-219` `padEnd(36)` vs `verify-catalog.ts:27-30` `padEnd(34)`). Disposition:
    **Phase 8.2** (the live scripts and CI), where the scripts are already in scope; a `scripts/lib/report.ts`
    is the home.

21. **`findNode`'s budget is off by one against its own siblings, a real, reachable inconsistency.**
    **Verified by reading all three loops:**

    ```ts
    // ctors.ts:495-496: inside `findNode`, AFTER the node is popped and visited
    budget -= 1;
    if (budget <= 0) return null;      // the predicate has not run yet
    ```
    ```ts
    // ctors.ts:550: findAllNodes
    while (queue.length > 0 && budget > 0) { … budget -= 1; … }
    // world.ts:848: collectTileViews, the same shape
    while (stack.length > 0 && budget > 0) { … budget -= 1; … }
    ```

    So `findNode(root, predicate, n)` tests at most **n - 1** nodes, and
    `findNode(root, predicate, 1)` returns `null` **without calling the predicate at all**, while
    `findAllNodes(root, predicate, 1)` tests exactly one. All three document the same `limit`
    ("`DEFAULT_FIND_LIMIT = 25_000`", `ctors.ts:462`), and `findNode` is the only one that validates it
    (`:484`: `findAllNodes` and `collectTileViews` silently return `[]` for a bad limit). `findAllNodes` also
    reads `children` **bare** (`ctors.ts:562`) where `findNode` wraps the read in `try/catch` (`:507-512`), so
    a throwing `children` getter escapes `findAllNodes`, and `findAllNodes` is what
    `recoverTextureAndRectangle` (`ctors.ts:603`) walks live game nodes with. Disposition: **follow-up task
    (3.9/Phase 6)**, not Phase 3, because it is one helper family (`walkTree`) and a reviewer should be able to
    reject it without rejecting 3.7. It is the only *behavioural* bug in this list reachable from a
    documented public API (`findNode(root, p, 1)`), so it should not sit in a report: put it in the Phase 3
    exit note as "found, deferred, with evidence".

22. **`asGraphics` crashes on `null` where its twin guards, folded into 3.7d.** Verified above: `world.ts`
    dereferences `.clear` with no receiver guard while `ctors.ts:444` guards with `isObject`. Disposition:
    **task 3.7d**, with the failing-first test now written into that section.

### Found by the second (headless/attach) scan, and re-verified here

23. **CRITICAL, and not a duplication finding: `uninstall()` never clears the attachment.**
    `BootstrappedClient.uninstall()` releases the attachment through `attemptTeardown`
    (`bootstrapped/src/client.ts:662-664`) but **never sets `this.attachment = null`**, and
    `attachmentPromise` is likewise never reset. **Verified by grep:** `this.attachment =` appears only at
    `:455` and `:591` (both assignments that *create* an attachment), and `this.attachmentPromise` appears only
    at `:194` (declaration), `:442`, `:444` and `:484`. So after `install() → uninstall()`, the next
    `ready()` short-circuits on `:441` (`if (this.attachment !== null) return this.attachment;`) and hands
    back a **released** attachment, a torn-down object whose `sink` and hooks are gone. Two consequences,
    both in the "take nothing without restoring it" family (DESIGN I2):
    - the second `install()` is never given a live attachment, so it reports ready against a corpse;
    - `attachmentPromise` is a *permanent* memo, so even after a hypothetical reset of `this.attachment`, the
      first call's promise would win.
    This is the **attachment half of the same lifecycle bug** Phase 1 Task 1.5 fixed for page hooks (the audit
    recorded `BootstrappedClient.install()` after `uninstall()` leaking a permanent page hook at
    `client.ts:362, 636-638`); the hook half landed, this half did not. **Disposition: do NOT fold into
    Phase 3 because it is a behaviour fix, not a dedupe.** Route it to Phase 2 (which already owns `client.ts`
    lifecycle work) or as its own one-commit fix with a test that asserts
    `install() → uninstall() → ready()` re-attaches and that the returned attachment is not the released one.
    Flagged here because the same scan that found it found item 24's duplication in the same five lines, and a
    reviewer fixing one will be looking at the other.
24. **The single-flight async memo is written four times, and the `BootstrappedClient` copy is the defective
    one.** `headless/src/version.ts:211-219` (`if (this.inFlight !== null) return this.inFlight; const promise
    = this.load().finally(() => { this.inFlight = null; }); this.inFlight = promise; return promise;`),
    `headless/src/client.ts:588-592` (guarded at `:580`), `headless/src/client.ts:995-1008`
    (`scheduleReconnect`, guarded at `:982`), and `bootstrapped/src/client.ts:440-444` (**no reset**, and the
    field is assigned **after** the async IIFE is invoked). **Verified:** the last one is
    `this.attachmentPromise = (async (): Promise<Attachment> => { ... await waitForAttachment(...) ... })();`.
    The IIFE runs before the assignment, so a re-entrant `ready()` during its synchronous prologue passes both
    guards and starts a **second** `waitForAttachment`, with its own 20 s window and its own poll loop. The
    other three copy the correct order (assign, *then* return; clear in `finally`). **Drift beyond that:**
    `connect()` resets four fields before the memo (`:581-586`) where `version.fetch` has no prologue;
    `scheduleReconnect` returns `void` and swallows an `openConnection` failure into a debug log where
    `connect()` propagates the rejection. **Disposition: not Phase 3** (a generic idiom, and three of the four
    are correct), but the ordering defect is a one-line fix and belongs with item 23's lifecycle work.
25. **The inert "nothing is attached" sink is written twice, with two different type-check surfaces.**
    `attach/detect.ts:112-128` (`export function createEmptySink(): AttachedSink`, called at `:230`) and
    `client.ts:911-925` (`export const EMPTY_STARTUP_SINK = { ... } satisfies import('./attach/room-connection.js').AttachedSink`,
    handed to `new AttachedTransport({ sink: EMPTY_STARTUP_SINK })` at `client.ts:228`) carry the same seven
    member bodies. **Verified drift:** (a) allocation, fresh object per call vs one module-level singleton;
    (b) **the type check differs**: one is a return annotation, the other a `satisfies`, so a newly required
    `AttachedSink` member is caught in only one place; (c) comments and the `kind: 'none' as const` spelling.
    Both are live paths (pre-attachment vs no-attachment), so editing one silently changes only one of the two
    states. **Disposition: a good follow-up** (`client.ts` becomes
    `export const EMPTY_STARTUP_SINK: AttachedSink = createEmptySink();`), small, zero behaviour change, and
    it removes the second type-check surface. Not Phase 3 (it is not one of the seven).
26. **Synthetic abnormal close (`1006`) is built three ways.**
    `headless/client.ts:972-978` (`reason: error instanceof Error ? error.message : 'connect attempt failed'`),
    `bootstrapped/attach/transport.ts:463-470` (`reason: "the host game's connection is no longer usable"`,
    the only copy whose comment says *why* `wasManual: false` matters), and the real normaliser at
    `headless/transport/client.ts:486-494` (`wasManual: this.manualClose`, `code: typeof event.code === 'number'
    ? event.code : 1006`). **Drift:** both synthetic copies hardcode `{1006, false, false}` while the normaliser
    derives all three; nothing links the synthetic trio to `analyzeClose`'s reconnect-worthy classification, so
    a change to the classification can leave the two synthetic sites lying. **Disposition: follow-up**, one
    `syntheticAbnormalClose(reason: string): TransportCloseInfo` beside `TransportCloseInfo` in
    `common/src/transport/types.ts`. Not Phase 3.
27. **The frontier high-water mark is written twice.** `attach/raw-socket.ts:202-205` (`noteFrontier(value:
    number | null)`, which no-ops on `null`) and `attach/room-connection.ts:572-575`
    (`observeFrontier(value: number)` relies on all three callers guarding first, `:473`, `:557`, `:617`).
    **Verified:** the monotonic
    comparison is identical; only the null contract differs, so the two attachment paths stay consistent only
    because the same predicate was copied. **Disposition: follow-up**:
    `raiseHighWater(current: number | null, value: number | null): number | null`. Note the tempting-looking
    merge with 3.5's `asSequence` is **wrong**: 3.5 validates a *rule* (integer ≥ 0), this tracks a *maximum*,
    and folding them would put a monotonic accumulator in a validator. Recorded explicitly so 3.5 does not
    absorb it.
28. **`welcomeToFrame` is a fourth safe-stringify copy, and item 13's target is dead code.**
    **Verified by grep:** `asOutboundString` has **no caller** anywhere in `packages/*/src`. Only the
    definition (`raw-socket.ts:171`), a re-export (`raw-socket.ts:544`) and the package barrel
    (`bootstrapped/src/index.ts:109`). So item 13's recommendation changes from "fix the `JSON.stringify`
    type lie" to **delete `asOutboundString` and its two exports**, which removes the lie by removal.
    `attach/transport.ts:75-89` (`welcomeToFrame`) then becomes the third live copy of the
    `try { return JSON.stringify(x) } catch { return null }` core besides `room-connection.ts:843-847` and
    `:859-863`. **Disposition: fold the `asOutboundString` deletion into Phase 3's exit cleanup** (it is dead
    code introduced by the same 3.3 area, and a public export that nothing calls is also an unused-API finding
    for report 21), but keep `welcomeToFrame` out of scope.

Smaller items from the same scans, **verified as described and dispositioned as follow-ups** (each is a few
lines, none is Phase 3's scope, and each is recorded here so it is not re-discovered): the detach-then-destroy
sequence written five times with three different destroy-argument policies (`world.ts:337-342, 451-456,
665-670` with `{children: true}`; `text.ts:177-186` with no arguments and a silent `false`;
`graphics.ts:189-200` with a latch and warn-once); "call the displaced previous function through" written four
times with three contracts (`pixi.ts:150-157` swallows and drops the return value and omits `this`;
`bundle.ts:324-327` must propagate and substitutes `[]`; `bridge.ts:402` must propagate;
`renumber.ts:592-595` discards), which is the same concern task 3.8 touches, so **re-read 3.8's diff against
`pixi.ts`'s `callThrough` before landing it**; `rive.ts`'s `setTextRunValue`/`fireTrigger`
(`:168-186`, `:204-222`) inline copies of its own `callInput` (`:340-358`) while only
`setBooleanInput`/`setNumberInput` call it; the jotai atom-cache walk duplicated inside `install`
(`bridge.ts:432-441` vs `:482-495`, the tick adding a `size !== lastSize` growth gate); the
node-option application block ×4 (`text.ts:114-118`, `sprite.ts:293-300`, `rive.ts:270-275`,
`graphics.ts:240-241`) where `rive.ts:275` always assigns `zIndex` (so `zIndex: undefined` yields `1_000_000`
where the other three leave the node default) and `sprite.ts:296-299` drops `width` unless `height` is also
given; and `isTextShaped` (`text.ts:83-87`) vs `isTextLike` (`ctors.ts:396-415`), where the weaker guard is
the one `updateText:155` actually uses.

## Master-plan anchor corrections (all verified against the working tree)

| master-plan anchor | says | actually |
|---|---|---|
| `:691` `state/store.ts:24` | `Unsubscribe` at line 24 | line **23** |
| `:693` `renumber.ts:546-573`, `client.ts:973-984` | the renumbering gate copies | `renumber.ts` `applyRenumbering` is at **`:635-649`** (and at `:635` before too); `client.ts:955` is now a **re-export alias**, so the client copy no longer exists |
| `:693` `common/protocol/codec.ts` | a copy of the envelope predicate | **no envelope predicate in that file**; the third copy is `client.ts`'s `parseEnvelope` |
| `:694` `verify-live*` | five deadline polls, one in the live scripts | the scripts have **no poll loop** (see Additional duplication #7) |
| `:696` `bootstrapped/attach/detect.ts` | a retry ticker sharing a helper with `headless/reconnect.ts` | **not the same helper**; `attach` has no delay calculation (task 3.6) |
| `:697` `coexistence/outbound.ts` | the owner of `asEnvelope` | DESIGN §4.2:262 lists the file, but the predicate's landed home is `coexistence/envelope.ts`; `outbound.ts` stays uncreated |
| `:698` `brand.ts:207`, `bundle.ts:328`, `renumber.ts:519`, `coexistence.test.ts:141` | the `previous` escapes | `brand.ts:207` ✔, `bundle.ts:328` ✔, `renumber.ts` **`:593`/`:618`**, `coexistence.test.ts` **`:145`** |
| `docs/audit/20` §2 `headless/client.ts:271, 472-498, 982-995, 591` | the emitter copies | `:288`, `:503-517`, `:519-529`, `:1047-1060`, `:642` |
| `docs/audit/20` §3 `detect.ts:286-303`, `:384-412`, `ctors.ts:833-865`, `jotai/bridge.ts:452-476`, `attach/transport.ts:173-183` | the five polls | `:289-306`, `:387-414`, `:843-875`, `:471-500`, `:174-183` |
| `docs/audit/22` §4 | put `Unsubscribe` in `transport/types.ts` | superseded by the master plan and DESIGN §4.2:220, which put it in `common/src/unsubscribe.ts` |
