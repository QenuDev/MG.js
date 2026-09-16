# mg.js: design and consistency standard

**Status:** proposed, for review. Nothing in here has been implemented yet.
**Evidence base:** `docs/audit/00-index.md` (index), `docs/audit/01..25-*.md` (per-area reports),
`docs/audit/30-verified-*.md` (adversarial verification), `docs/audit/40-structure-packages.md` and
`docs/audit/41-structure-repo.md` (file-organization audits).
**Audit provenance:** 18 subsystem and cross-cutting agents reported 89 findings; 29 were then
re-verified by 5 independent agents that had to open every cited line: 23 confirmed, 5 partially
corrected, 1 refuted. The remaining 60 findings were never independently verified and are marked as
such in the index.

---

## 1. What this document is for

`mg.js` grew feature-first: each subsystem works, is unusually well commented, and is tested. What it
does not yet have is a *stated* shape. The audit found the cost of that in concrete terms: four client
classes with four different lifecycles, one helper reimplemented per package with copies that already
disagree (five deadline-poll loops, three emitters, five sequence-number validators), a folder layout
that gives a folder to one 100-line file and leaves a 454-line one bare, and public options that are
read by nothing.

This document fixes the shape. It is the standard the improvement plan (`docs/plans/`) argues from, and
the reference for reviewing future changes. It has four parts:

| Part | Question it answers |
|---|---|
| §3 Architecture | What are the layers, and what may depend on what? |
| §4 Structure | Where does a file live, and when does a concept get a folder? |
| §5 Conventions | How do we name, type, error, log, and test? |
| §6 Invariants | What must never be true, and how is each one enforced? |

§7 covers tooling and gates, §8 documentation, §9 the decisions already taken, §10 what we are
*not* doing, §11 what still needs a human answer.

### Decisions already taken (they shape everything below)

- **D1: Breaking changes are allowed.** All four packages are pre-1.0, private, and unpublished.
  Prefer the right shape over back-compat aliases. No deprecation shims.
- **D2: Adding tooling is allowed.** Biome (one devDependency, one config) rather than ESLint +
  Prettier. A formatter's first full-repo pass is expected and accepted.
- **D3: Missing capabilities are in scope**, not just refactoring: the audit's `missing-capability`
  findings are work items, not notes.

---

## 2. The system in one page

`mg.js` is four packages over one protocol.

- **`@mg.js/common`**: the platform-free core. It holds the Quinoa wire protocol, a JSON-Patch document store,
  the 72 typed game actions, and a catalogue of live shop/weather data. **Zero runtime dependencies.
  No `node:*`, no DOM globals, no `ws`.**
- **`@mg.js/headless`**: a standalone Node client with its own WebSocket transport, `mc_jwt` cookie auth,
  reconnect and backoff policy, version resolution. Its dependency on `ws` is optional and exists only
  because Node's global `WebSocket` cannot send headers.
- **`@mg.js/bootstrapped`**: an in-page client for a game that is already running. It replaces
  `window.WebSocket`, wraps the game singleton `MagicCircle_RoomConnection`, bridges jotai atoms,
  exposes pixi render helpers, and runs a *coexistence* layer that shares one command sequence counter
  with the game's own code. It also builds to **one standalone Tampermonkey userscript**.
- **`@mg.js/art`**: what the library knows about *drawing* a garden — which sprite a thing is drawn from, how
  large and where it lands, what a mutation paints over it, in what order the layers stack, and the pixels when
  a consumer needs a picture rather than a description. Four entries, split by what each may import: the model
  and the `bundle` extractor import nothing, `source` imports `common/catalog`, and `node` is the only entry
  allowed `node:zlib`. It is a package of its own rather than more of `common` because the game states its art
  tables in its own bundle and publishes them as an endpoint nowhere: the rule below — a consumer could have
  learned it by asking the server — has no answer for an art position, so the value cannot live in the package
  that rule defines.

The two platform packages never import each other. Both import `common`, and `common` imports nothing. `art` is
the fourth, and its edges are narrower than that sentence's shape suggests: nothing imports it — the userscript
must not, because it has a bundle-size budget — and only its `source` entry imports `common`.

---

## 3. Architecture

### 3.1 Layers, and the rule between them

```
              ┌─────────────────────────── @mg.js/bootstrapped ───────────────────────────┐
              │ entry (userscript, badge)                                                  │
              │   page (realm, namespace, override)                                        │
              │   attach (detect, raw-socket, room-connection, sink, upgrade, transport)   │
              │   coexistence (brand, renumber, envelope)   jotai (detect, registry)       │
              │   render (ctors, pixi, sprite, text, graphics, rive, world-scene, facade)  │
              │   live-catalog   storage   diagnostics                                     │
              └────────────────────────────────────┬──────────────────────────────────────┘
                                                   │
   ┌─────────────────────── @mg.js/headless ───────┴──────┐
   │ client (policy: lifecycle, reconnect, supersession)  │
   │   transport (owning a socket)   auth (proving who we are)   version   room-socket │
   └───────────────────────────────┬──────────────────────┘
                                   │
        ┌──────────────────────────┴──────────────────────────┐
        │                    @mg.js/common                    │
        │ client (ClientCore, composition root, events)       │
        │   actions (registry, params, game-actions, handle,  │
        │            sequencer, result-codes)                 │
        │   protocol (wire, envelope, codec, connect-url,     │
        │             close-codes, id)                        │
        │   state (patch, pointer, paths, store)              │
        │   catalog (defs, source, http, platform-source,     │
        │            remote-json-source, static-source, weather) │
        │   transport (the seam)   emitter   errors   log     │
        └─────────────────────────────────────────────────────┘
                                   ▲
              only `source` imports │  (the one edge here that points up)
        ┌──────────────────────────┴──────────────────────────┐
        │                      @mg.js/art                     │
        │ model (frame box, placement, crop and plant recipes)│
        │   bundle (predicates over a parsed game chunk)      │
        │   source (the version, the atlas packs, the image)  │
        │   node (KTX2 → RGBA, frame crop, the PNG codec)     │
        └─────────────────────────────────────────────────────┘
```

**The dependency rule.** A layer may import from the layer below it and from its own layer's shared
primitives. It may not import upward, and it may not reach sideways into another platform package.

| From | May import | May **not** import |
|---|---|---|
| `common/protocol` | `common/errors` | anything else in the repo |
| `common/state` | `common/protocol`, `common/errors` | sockets, fetch, DOM |
| `common/actions` | `common/protocol`, `common/state`, `common/errors` | transport implementations |
| `common/catalog` | `common/errors` | DOM globals (see §6 I9) |
| `common/client` | every `common/*` layer | any platform package |
| `art` (model, `bundle`) | nothing at runtime | `common`, another package, `node:*` |
| `art/source` | `common/catalog` **through its exports map** | the platform packages |
| `art/node` | `node:zlib`, `node:fs`, the vendored transcoder | `common` |
| `headless/*` | `common` **through its exports map** | `bootstrapped`, or `packages/*/src` by path |
| `bootstrapped/*` | `common` through its exports map | `headless`, `art`, or the game's internals by guess |

Three rules fall out of this table and are worth stating on their own:

1. **Policy lives in the client, mechanism lives in the layer.** `renumbering` is a *policy* that
  belongs in `bootstrapped/coexistence`, and a client only configures it. Today `client.ts` holds the
  renumbering gate three separate times (`renumber.ts:546-573`, `client.ts:730-735`, `client.ts:973-984`)
  and the raw-socket copy is unguarded; that is mechanism leaking into three owners.
2. **A helper that exists in two packages is a missing `common` module**, unless it is
  platform-specific. The audit's duplication pass found seven such cases.
3. **`packages/*/src` may not be imported across packages.** `scripts/verify-socket.ts:47-49` currently
  imports `../packages/headless/src/client.js`; the exports map exists precisely so it does not have to.

### 3.2 One client contract

The audit's sharpest architectural finding is that the four client classes
(`ClientCore`, `HeadlessClient`, `BootstrappedClient`, `RoomSocket`) share no interface: different
constructor shapes, different start verbs, different readiness concepts, different event naming, and
different identity access. They are meant to feel like one library, so they must *be* one interface.

```ts
// packages/common/src/client/contract.ts
export interface MgClient<TEvents extends EventMap> {
  /** Lifecycle, idempotent: a second start() while running is a no-op, not a second connection. */
  start(): Promise<void>;
  /** Total teardown, idempotent, never throws: every global, listener, timer and socket is released. */
  stop(reason?: string): Promise<void>;

  readonly events: Emitter<TEvents>;
  readonly isReady: boolean;
  /** Null means "not known yet", never a placeholder string (see §6 I6). */
  readonly selfPlayerId: string | null;
  readonly lastError: MgError | null;
  /** JSON-safe diagnostics. The same object every client can print on failure. */
  readonly report: ClientReport;
}

export interface ClientReport {
  readonly kind: 'common' | 'headless' | 'bootstrapped';
  readonly started: boolean;
  readonly ready: boolean;
  readonly attachment: string | null;   // bootstrapped only; null elsewhere
  readonly socketsSeen: number;
  readonly renumbering: boolean;
  readonly errors: readonly MgErrorSummary[];
  readonly version: string;
}
```

Rules that come with it:

- **`start`/`stop`, not `connect`/`disconnect`/`install`/`uninstall`/`destroy`.** One verb pair, in
  every package, with the semantics above. `RoomSocket` becomes a thin `MgClient` too, or it is
  renamed to say it is a one-shot test helper.
- **Event names are `<noun>:<past-tense-verb>` in one namespace**: `ready`, `close`, `reconnect`,
  `error`, `frame`, `patch`, `welcome`, `headers-dropped`. Today `headersUnsupported` (camelCase) sits
  beside `sessionSuperseded` and `willReconnect`.
- **Every client emits the same lifecycle events** with the same payload shapes; a platform client adds
  events, never renames them.
- **`report` is the only diagnostic surface.** `BootstrappedClient.attachmentReport`,
  `client.stats`, `client.status`, and the userscript badge all read from it.

### 3.3 Where each policy lives

| Policy | Owner | Contract |
|---|---|---|
| close-code classification | `common/protocol/close-codes.ts` | `analyzeClose(code, reason, opts) → CloseAnalysis`, pure, one table |
| retry timing (backoff, jitter, clamp) | `headless/reconnect.ts` | `planRetry(analysis, attempt) → BackoffPlan`, pure |
| when to retry at all | `headless/client.ts` | the only place that *decides*; drives `planRetry` |
| supersession confirmation | `headless/client.ts` | never auto-reconnect a real 4250/4300; explicit `confirmSupersededReconnect()` |
| sequence numbering | `common/actions/sequencer.ts` | one counter, one `settle()`, no other module re-implements it |
| coexistence renumbering | `bootstrapped/coexistence/renumber.ts` | exactly one live rewriter (I1) |
| catalogue freshness | `common/catalog/source.ts` | per-source TTL/dedupe; no negative caching |
| how much to keep in memory | the owner of each cache | every cache declares a bound (I5) |

---

## 4. Structure

### 4.1 The folder rule

The audit found four different treatments for "one concept, 400-700 lines": `common/transport/` is a
folder holding one substantive file plus a barrel; `bootstrapped/jotai/` is a folder holding one
727-line file with no barrel; `bootstrapped/realm.ts` (386 lines, 11 importers) and `storage.ts`
(454 lines) are bare files. No contributor can infer the rule. So:

> **A concept gets a folder when it has ≥2 modules or it is a published subpath. Otherwise it is a bare
> file named after the concept. Every folder has an `index.ts` barrel. No module imports a barrel,
> because barrels are leaves.**

The last clause is not stylistic: the repo currently has **zero** barrel-induced cycles, and that
property is what makes barrels safe here.

Two supporting rules:

- **`types.ts` only if it holds only types.** Five of five current `types.ts` files hold runtime values
  or classes (`protocol/types.ts` exports `isKeepalivePing`, `catalog/types.ts` exports
  `emptyCatalog()`, `headless/auth/types.ts` exports the `StaticAuthProvider` class). Rename to the
  concept: `protocol/wire.ts`, `catalog/defs.ts`, `transport/seam.ts`, `actions/params.ts`,
  `auth/providers.ts`.
- **Testing is a reason to split, not an excuse.** `bootstrapped/client.ts` reaches into its own private
  state (`client['captureHandle']` at `:852`) to build a facade; that is a missing seam, not a shortcut.

### 4.2 Target tree

`common` (34 → 35 files):

```
packages/common/src/
  index.ts                    explicit re-exports only (no `export *`)
  unsubscribe.ts              NEW: the single `Unsubscribe` declaration
  client.ts                   ClientCore, the composition root, stays bare
  emitter.ts  errors.ts  log.ts
  poll.ts                     the one deadline poll: pollUntil/watchUntil/unrefTimer
  protocol/                   the wire: bytes <-> messages
    index.ts  wire.ts  envelope.ts  codec.ts  connect-url.ts  close-codes.ts  id.ts
  actions/                    the commands we send; the whole 72-action surface lives here
    index.ts  registry.ts     <- protocol/forms.ts
    params.ts                 <- actions/types.ts
    game-actions.ts           <- actions/actions.ts
    handle.ts  sequencer.ts   <- protocol/sequencer.ts
    result-codes.ts           <- protocol/result-codes.ts
  state/                      index.ts  pointer.ts  patch.ts  store.ts  paths.ts
  catalog/                    index.ts  defs.ts (was types.ts)  source.ts  http.ts
                              platform-source.ts  remote-json-source.ts  static-source.ts  weather.ts
  transport/                  index.ts  seam.ts (was types.ts)
```

`headless` (12 → 22 files): the 1025-line client splits along the seams the audit verified. `auth/`
and `transport/` gain barrels and the `exports` map stops pointing at member files, so that
`@mg.js/headless/auth` resolves to a file with no auth providers *today*:

```
packages/headless/src/
  index.ts  errors.ts  client.ts (≈450)  client-options.ts  client-events.ts  client-session.ts
  connect-attempt.ts  connect-url.ts  handshake.ts  reconnect-scheduler.ts  supersession.ts
  reconnect.ts  room-socket.ts  version.ts
  transport/  index.ts  standalone.ts (was client.ts)  runtime.ts  headers.ts
  auth/       index.ts  providers.ts (was types.ts)  cookie.ts  guest.ts  session.ts (was src/session.ts)
```

`bootstrapped` (20 → 48 files): `realm.ts` splits into a `page/` folder, `storage.ts` gets one, the
four big files split along their verified seams, and the userscript's badge separates from its entry
point:

```
packages/bootstrapped/src/
  index.ts (≈90)  client.ts (≈380)  diagnostics.ts  build-info.ts
  page/       index.ts  realm.ts  namespace.ts  override.ts
  storage/    index.ts  types.ts  backends.ts  typed.ts
  attach/     index.ts  detect.ts  attached-transport.ts (was transport.ts)  raw-socket.ts
              room-connection.ts  sink.ts  room-frame.ts  room-identity.ts
              room-connection-probe.ts  upgrade.ts
  coexistence/ index.ts  brand.ts  renumber.ts  outbound.ts
  jotai/      index.ts  detect.ts  write.ts  registry.ts
  render/     index.ts  ctors.ts  pixi.ts  sprite.ts  text.ts  graphics.ts  rive.ts
              world-scene.ts (was world.ts)  world-geometry.ts  tile-view.ts
              cinematic-claims.ts  warn-once.ts  facade.ts
  live-catalog/ index.ts  object-keys-source.ts  scoring.ts     (was catalog/)
```

**Landed vs planned, as of the Phase 5 closure.** The trees above are *intent*: they were
written from the audit, before any split, and three of their assumptions did not survive contact. Read them
with these corrections, which are measured rather than argued:

- **`client.ts (≈380)` is wrong, and the plan records it as not met.** `bootstrapped/src/client.ts` is
  **1179** lines and `headless/src/client.ts` **1178** after their extractions, because each extraction
  leaves a thin adapter behind, and the class bodies are `this`-bound: `openConnection` alone touches ~25
  private fields and 240 `this.` references span the class. Cutting them means either publishing ~30
  internals or introducing a session-state object and rewriting every field access; that is a
  behaviour-bearing refactor with its own risk budget, not a structure task. The measured file-size
  survey, including the four other files over 500 lines (`common/src/client.ts` 1029,
  `coexistence/renumber.ts` 661, `render/world-scene.ts` 651, plus the two pre-excepted `ctors.ts` and
  `jotai/bridge.ts`), is in `docs/plans/2026-09-13-phase-5-structure.md`'s closure section.
- **The `attach/` and `room-*` names differ from this tree, and the landed names are better.**
  `sink.ts`, `room-frame.ts`, `room-identity.ts`, `room-connection-probe.ts` and `upgrade.ts` were not
  created. What exists is `detect.ts`, `attached-transport.ts`, `raw-socket.ts`,
  `room-types.ts`/`room-binding.ts`/`room-frames.ts`/`room-sink.ts` with `room-connection.ts` as the facade
  over them. `upgrade.ts` is still owed, and the audit pairs it with `coexistence/outbound.ts`, which is
  also not created.
- **`jotai/` was not split** (`detect.ts`/`write.ts`/`registry.ts` do not exist; `bridge.ts` remains at 777
  lines) and `render/world-scene.ts` gained a sibling this tree does not list, `world-warnings.ts`, because
  the warn-once callers were what the split exposed. `page/`, `storage/`, `live-catalog/` and the
  `render/` geometry/view/claims files landed as drawn.
- **`entry/` has since left the package entirely, and that is a correction to this tree rather than a phase
  failure.** `main.ts`, `userscript.ts` and `badge.ts` are an *application* of this library: they start a
  client, publish the page namespace and render a status badge. They now live in the
  `bootstrapped-example` repository, which consumes `@mg.js/bootstrapped` through its entry point. The split
  landed exactly as drawn; only its home changed. The seam needed nothing invented: nothing under `src/`
  imported `entry/`, the root barrel never re-exported it, and every primitive it needed was already public.
  Its bundler, its banner and its size budget went with it. See §10.
- **§4.3's test numbers are stale.** The finding's *shape* survived and its figures did not, in both
  directions: measured at the closure, there are **73** `*.test.ts` files under `packages/*/tests` (the audit
  counted 63) and **9** of them import no source module at all, which is neither 5 nor the 5 the plan
  re-measured either, because splitting `attach.test.ts` and adding the structural and bundle-budget
  guards moved both numbers. Mirroring source paths is what landed; the counts to trust are the ones a run
  prints, not the ones in this paragraph or in the plan.

Two renames carry a warning: the userscript's `@namespace` + `@name` are Tampermonkey's update
identity, so `build.ts`'s `DOWNLOAD_URL` (currently a **404**) and `@namespace` must be fixed in the
same commit, before any release exists.

### 4.3 Tests mirror the source

```
packages/<pkg>/tests/
  <mirrored/source/path>.test.ts     render/world-scene.test.ts, attach/sink.test.ts,
                                     protocol/codec.test.ts, actions/registry.test.ts
  integration/                       build-output.test.ts  session.test.ts  room-upgrade.test.ts …
  fixtures/                          mock-server.ts, fake-sockets.ts, page.ts
```

Today tests are named after *subsystems* (`attach.test.ts`, `transport-keepalive.test.ts`), so 27 of 66
source files are untested in a way nobody can see: only 5 of 22 test basenames match a source basename,
and two different `connect-url.test.ts` files test different modules. Mirroring the path makes a missing
test an empty slot rather than an invisible one.

---

## 5. Conventions

Derived from what the codebase already does consistently; each line also names the deviation to fix.

### Naming and files

| Rule | Dominant today | Deviation to fix |
|---|---|---|
| kebab-case files, one concept each | yes, everywhere | `forms.ts` (it is an action registry), `catalog/bundle.ts` (it hooks `Object.keys`) |
| PascalCase types, camelCase values, `SCREAMING_SNAKE` module constants | yes | none |
| `DEFAULT_*` for exported defaults, `MAX_*`/`MIN_*` for bounds | mostly (`DEFAULT_RECONNECT`, `MAX_SCAN_DEPTH`) | `KEEPALIVE_PING` is a payload, not a bound, so it is fine, but must be documented as such |
| no magic numbers inline | mostly | `world.ts` holds two tile-size sources; `MAX_PAD` does not exist at all (see I4) |

### Types and API shape

- **Return `null` for "known absent", reserve `undefined` for "not supplied".** The codebase already
  reads this way (`readFrontier(): number | null`, `selfPlayerId: string | null`); make it explicit and
  never give a caller `undefined` where `null` means something.
- **`readonly` on every public property; hand out copies, never internal arrays/maps.**
- **Options are one object with one polarity.** Replace the five `disableX: true` flags and the
  duplicate `autoReconnect` / `reconnect.enabled` pair with:
  ```ts
  features?: { renumbering?: boolean; jotai?: boolean; catalog?: boolean; platformCatalog?: boolean; render?: boolean }
  ```
  Absent means default-on for the ones that must never be off by accident (renumbering), default-off for
  the rest, and each default is stated in the doc comment.
- **No inert surface.** Every exported option is read somewhere, and every public method either works or
  is deleted. The audit found eight violations, including `FormFallback`/`setFormFallback` (changes
  nothing), `isFallbackEnabled` (returns `false` unconditionally), `RemoteJsonSource.setETag` (no
  caller can supply an ETag), `GetCtorsOptions.page` (declared, documented, never read), and
  `hasCapturedGet`/`emptyCatalogSource` (no caller at all).

### Errors

One hierarchy, three delivery channels, no fourth:

```ts
class MgError extends Error { readonly code: MgErrorCode; readonly disposition: 'fatal'|'retry'|'ignore'; readonly cause?: unknown }
class MgProtocolError extends MgError {}   // malformed wire data
class MgConfigError   extends MgError {}   // bad options, missing required capability
class MgTransportError extends MgError {}  // socket/HTTP failure, carries disposition
```

- **Throw** only for programmer error and impossible states.
- **Return a Result** for anything the remote can get wrong: `PatchOutcome`, `WriteResult`,
  `CommandResult`. The wire never throws.
- **Emit** for lifecycle facts (`close`, `reconnect`, `headers-dropped`, `source-error`).
- **Never swallow.** A `catch {}` is allowed only where the comment says what is being protected and
  what the caller sees instead. `CatalogSource.load()` currently swallows every source failure into an
  optional callback that production wiring never passes, so failures are invisible in the only place
  that matters. Default it to a logger and expose `report.errors`.

### Logging

- `log.ts` keeps one sink interface with an injectable writer; levels are honest (`child().setLevel()`
  currently reports one level and filters by another).
- **Redaction happens at the boundary, not at the call site.** Any object crossing into a log line, an
  event payload, or an error message goes through `redactCredential(value)`. See I3.

### Imports and modules

- **Every relative import ends in `.js`.** 21 test imports use `.ts` today and fail `tsc` with TS5097.
- `import type` for type-only imports; no value import of a type-only module.
- **No module imports a barrel**; no `export *` in a public entry point (it already caused a real
  collision: `Unsubscribe` is declared twice in `common`, and `state/index.ts` carries a comment
  explaining the workaround).
- **`as` is allowed only at a validated boundary**, next to the check that justifies it, or replaced by
  a type guard. `codec.ts:104-118` casts wire patches without validating `path`; that is the shape to
  eliminate.

### Comments and docs

The comment density and rationale-first style here is an asset; keep it. Rules: JSDoc on every
exported symbol; a module header saying what the module is and is not; explain *why*, cite the line that
proves it; no commented-out code; no claim that the code does not enforce (the audit found several:
"sprite.ts is the only texture creation path", "CLOSE_CODE_LABELS is built from the enum", "release()
runs an emptiness test").

### Tests

- **`describe`/`it`, one style.** `common` and `headless` use it (63 `describe`, 367 `it`); the 7
  bootstrapped files use flat `void test()` (123 occurrences). Standardise on `describe`/`it`.
- **A test must be able to fail.** `room-socket.test.ts:214-217` asserts `x > 0 || true`, and 16
  userscript assertions `skip` when the bundle is missing, which, given `verify` tests *before* it
  builds, is always. Both are gates that cannot fail; see I8.
- **No sleep-based waiting.** Use the deadeline-poll helper (`pollUntil`) with a predicate and a
  timeout, and never leave a `setInterval` without a handle the test can clear.
- **Every defect fix lands with the test that would have caught it**, which for this audit means: a
  hostile-input test for every parser, a teardown test for every patcher, and a credential test for
  every auth path.

---

## 6. Invariants

These are the rules whose violation is a bug by definition. Each states *why*, *how it is enforced*,
and the *violations* the audit found. The plan closes them across phases, with Phase 0 taking I8's gates,
Phase 1 the critical defects (I1, I2) and the credential boundary (I3), and Phase 2 the wire bounds (I4,
I5). I3, I4 and I5 below are re-verified against that tree; I1, I2 and I6-I9 still carry their
audit-era violation lists.

### I1: Exactly one renumbering rewriter is live, ever

Two rewriters consume two sequence numbers for one command, and a gap poisons every later command with
`invalid_sequence`. **Enforced by:** one install slot, a branded identity check, an outcome field on
the handle, and a test that two installs yield one live machine. **Violation:**
`installRenumberHook` returns a *detached* `Renumberer` when the slot is already ours, while reporting
`active: true`, and the caller then numbers into a machine nobody reads (critical; `renumber.ts:502`,
`brand.ts:231-233`, `renumber.ts:532-534`).

### I2: Take nothing without restoring it

Every patch of a global, a host object, or a game object is identity-guarded, recorded, and reversed in
reverse order by `stop()`. `stop()` is total: no listener, timer, socket, wrapper, global, or captured
store survives. **Enforced by:** a `stop()`-then-assert test per patcher; a branded marker so we never
restore someone else's replacement. **Violations (8 findings, the largest theme):** `raw-socket.release()`
never removes the `message`/`close` listeners it added (`raw-socket.ts:235,269` vs `:443-464`);
`jotai.release()` deletes the *game's* live `jotaiAtomCache` on an identity check alone and leaves the
synthetic `get` in place (`bridge.ts:500-502`); `BootstrappedClient.install()` after `uninstall()`
leaks a permanent page hook (`client.ts:362, 636-638`); `WorldScene` layer suppression records a second
scene's value as its own no-op and restores unconditionally (`world.ts:840-853, 289-300`);
`StandaloneTransport.dispose()` orphans a live socket (`transport/client.ts:387-394`).

### I3: No credential ever leaves the transport

The token *value* appears in exactly one place: the `Cookie` header at connect time. (The literal string
`mc_jwt` also appears in the redaction rules that keep the value out of everywhere else; `redact.ts:36`
keys on it.) The value is never an event payload, a log line, an error message, a URL, a stored value, or
a "safe to log" field.
**Enforced by:** one validator, `validateCookieHeaderValue` (`headless/src/auth/cookie.ts:139`), run
before any value becomes a header on both paths, in `cookie.ts:259` in `CookieAuthProvider.prepare` and in
`session.ts:161` in `buildProbeCookie`, plus `redactCredential`/`redactCredentialString`
(`common/src/redact.ts:65,81`) applied at the log boundary inside the logger's `scrub`
(`common/src/log.ts:135-169`, which rewrites `.message`, `.stack` *and* the `.cause` chain) and to the
dropped header bag (`headless/src/client.ts:860-867`, which emits header *names* as `headers-dropped`).
Tests: `common/tests/log.test.ts:20,38,49`, `common/tests/redact.test.ts`,
`headless/tests/credential-leak.test.ts:107`, `headless/tests/credential-headers.test.ts:35,102`,
`headless/tests/auth/cookie.test.ts:39`.
**Violations (1, narrowed):** an injected `webSocketFactory` that is neither the global constructor nor
declares `supportsConnectHeaders` is still *assumed* header-capable
(`headless/src/transport/runtime.ts:198-204`); a factory that silently discards `options.headers` drops
the cookie with no `headers-dropped` event and can still reach `isReady: true`. The assumption is
deliberate, since there is no feature test for a third constructor argument, and it is stated in the runtime's
`description`, and it is pinned by `headless/tests/transport/headers.test.ts:67`.
**Closed in Phase 1** (audit defects, kept for history): `headersUnsupported` no longer re-emits the raw
bag: the value is `redactCredential(dropped)` and `headers-dropped` carries `Object.keys(dropped)` only
`probeSession` no longer interpolates an unvalidated token, because the shared validator runs
first, and no longer copies `error.message` into `reason` verbatim, since it is redacted
with `redactCredentialString`, with the stack and cause chain scrubbed; the
detectable half of the factory assumption is closed too: the global WHATWG constructor is recognised as
header-incapable and `supportsConnectHeaders` is honoured, and `requireHeadersForAuth`
defaults to `true`, so an authenticated provider on a header-less runtime throws `MgConfigError` and sets
`headersBlocked` before a socket exists (`headless/src/client.ts:367,820-830`).
**Verified against the tree at Phase 2 close** (the phase close, 2026-09-13; Phase 2's last commit).

### I4: Untrusted data never becomes a key, an index, or code

Wire frames, patch paths, HTTP bodies, and the page's own bundle text are attacker-influenced. They may
be parsed, validated, and copied, but never used as a property key without a guard, never as an array
index without a canonical check, never as a bound for growth, never `eval`'d.
**Enforced by:** `FORBIDDEN_TOKENS`/`isForbiddenToken` (`common/src/state/patch.ts:118,121`) refusing
`__proto__`/`constructor`/`prototype` before any lookup, plus `Object.hasOwn` in `resolvePointer`
(`pointer.ts:85`) so an inherited slot is unreachable; the canonical `isArrayIndex` (`patch.ts:103`,
applied at `:204` and `:288`) and `MAX_ARRAY_PADDING = 10_000` (`patch.ts:135`, applied at `:150`, `:209`,
`:292`); `MAX_FRAME_BYTES = 8 MiB` (`codec.ts:75`) checked before the keepalive test and `JSON.parse`
(`codec.ts:110-112`), whose `oversized` outcome carries no payload (`codec.ts:42`), dropped by the core as
numbers only (`common/src/client.ts:566-573`), backed by `maxPayload` and `close(1009)` in the headless
transport (`headless/src/transport/client.ts:249,497-511`) and by a byte count in the bootstrapped
raw-socket scrape (`raw-socket.ts:153`); `readCapped` (`catalog/http.ts:86`) counting `byteLength` while
streaming and cancelling the reader on overflow (`:120-121,134`), with a `content-length` pre-check
(`:92-107`) and a bounded error preview (`:169,181`); `redirectPolicy` defaulting to `'error'`
(`http.ts:39,161`); `assertSinglePathSegment` plus per-segment `encodeURIComponent`
(`connect-url.ts:51-64,87-90`); `RemoteJsonSource` pinning its base origin and resolving each URL once
(`remote-json-source.ts:107-118`).
Tests: `common/tests/patch.test.ts:433-480`, `common/tests/protocol/codec.test.ts:28-71`,
`common/tests/catalog/http.test.ts:58,160`, `common/tests/connect-url.test.ts:151-214`,
`common/tests/catalog/remote-json-source.test.ts:34`, `headless/tests/transport/standalone.test.ts:46`,
`bootstrapped/tests/attach/raw-socket.test.ts:162`.
**Violations (1, narrowed):** where the container walk descends into an existing array, the index test is
`Number.isInteger(Number(token))` (`patch.ts:207`) rather than `isArrayIndex`, and `setAt` does the same
(`patch.ts:147-155`), so a non-canonical numeric token (`1e3`, `0x10`) still resolves as an index instead of
being refused. `MAX_ARRAY_PADDING` bounds it (effective maximum index `length + 10_000`), so the denial of
service is gone; the *canonical check* half of the rule is what is still not applied on that path.
**Closed in Phase 1-2** (audit defects, kept for history): `ensureContainer`'s unguarded
`record[token] = slot` let `add /__proto__/pwned/inner` pollute `Object.prototype`, and it is refused
before the lookup now; `/data/arr/20000000/x` padded 20 million slots in 238 ms, which is refused past
`length + 10_000`; there was no inbound frame bound at all, and `MAX_FRAME_BYTES` now bounds the codec,
the transport and the userscript's scrape (on a browser or `undici` socket the runtime
materialises the frame before the check, so the protocol-level `maxPayload` bound applies only under `ws`);
`maxBytes` compared a *string length* after buffering the whole body, and is now a streaming byte cap
that cancels and aborts; catalogue fetches followed redirects with no policy
from a caller-shaped `baseUrl`, and now default to `redirect: 'error'`; the connect URL
interpolated `version`/`room` unencoded, and now encodes them and guards to one segment; and
the related finding that `RemoteJsonSource` could be retargeted by `baseUrl`/`paths` is closed by origin
pinning and resolve-once. An untrusted `executedCommandSequence` can no
longer become the command counter either: `isCanonicalSequence` (integer ≥ 0, `sequencer.ts:34`) is the one
frontier rule, and the readiness gate opens only on a seeded counter
(`common/src/client.ts:622,625,628,643`).
**Verified against the tree at Phase 2 close** (the phase close, 2026-09-13; Phase 2's last commit).

### I5: Every wait has a deadline; every buffer has a bound

No unbounded cache, queue, retry loop, or listener set; no `await` without a timeout; no timer without a
retained handle.
**Enforced by:** `createTextureCache` declaring `DEFAULT_TEXTURE_CACHE_ENTRIES = 256`, validating any
override as a positive integer, and routing every destroy through `destroyIfUnshared`
(`sprite.ts:98,129,169-207`); the frame ceiling described under I4; `ReconnectPolicy.sleep(plan, signal)`
(`reconnect.ts:353`) with `disconnect()` aborting `reconnectAbort` (`headless/src/client.ts:327,689`) and
both backoff branches jittering *then* clamping to `maxDelayMs` (`reconnect.ts:142,181`); the core's
`dispose()` settling every entry in `readyWaits` and clearing its timer
(`common/src/client.ts:178,229-236,305-331`); `willReconnect` reading the live task rather than the policy
(`headless/src/client.ts:514`), a parked plan drained (`:1132,1181-1182`) and a superseded attempt
abandoning rather than clobbering (`:1160`); the sequencer's `MAX_REPORTED_STALE = 1024` bound
(`common/src/protocol/sequencer.ts:294,414-416`); `RoomSocket`'s reconnect accessors
(`room-socket.ts:302,312,360`) and a strict `VersionResolver.refresh()` (`version.ts:216`).
Tests: `bootstrapped/tests/render/sprite.test.ts:165,292,354`,
`common/tests/client.test.ts:957,982,992`, `common/tests/sequencer.test.ts:269`,
`headless/tests/reconnect.test.ts`, `reconnect-abort.test.ts:40`, `connect-supersedes-backoff.test.ts`,
`reconnect-chain.test.ts:120`, `superseded-attempt.test.ts:154`, `transport-dispose.test.ts:60`,
`room-socket.test.ts`, `version.test.ts:38`, `version-loop.test.ts:97`.
**Violations (none of the audit's four remain; four findings from the Phase 2 re-audit are still open):**
three pre-socket `await`s in `connect()` have no deadline: `resolver.resolveDetailed()`
(`headless/src/client.ts:756`), `authProvider.prepare()` (`:769`, which awaits a caller-supplied
`getCookie()`) and `acquireWebSocketRuntime()` (`:808`); every in-repo path behind them is bounded, but a
caller-supplied provider or resolver that never settles hangs `connect()` forever (Phase 2 plan F10,
deferred because the fix is a new public `prepareTimeoutMs` option and so owes its own test).
`waitFor`'s `finish()` is what unsubscribes and clears the timer, and a caller predicate that throws inside
the subscription callback skips it, so the entry and its timer survive
(`common/src/state/store.ts:245-261`, predicate at `:255`) (F13, deferred to Phase 4). The `add`-append
path (`-`) is not covered by `MAX_ARRAY_PADDING`, so repeated frames can still grow an array without bound
(`patch.ts:142-144`) (F16, deferred to Phase 4 as a state-size policy: the tree's size is
server-authoritative, since one frame may replace it with up to `MAX_FRAME_BYTES`). `RoomSocket.on()`
before a `connect()` queues its handler, and the detacher it returns only sets a `cancelled` flag
(`room-socket.ts:412-429`), so an unsubscribed closure is retained until `connect()`, `disconnect()` or
`destroy()` clears the queue. That is the same class as F18, of which only the `disconnect`/`destroy` half was
fixed. Literal residues of "no timer without a retained handle": `setTimeout(callback, 16)`
(`bootstrapped/src/render/ctors.ts:813`), a discarded poll handle
(`bootstrapped/src/attach/detect.ts:303,305`) and a 300 ms `unref()`'d settle
(`headless/src/client.ts:706`), each one-shot and bounded within its own delay. They are listed because
the clause as written has no boundedness carve-out.
**Deferred as a missing capability or an accounting convention, not as an unbounded wait:** no inbound
read-idle watchdog (Phase 7.6); the retry counter is off by one against the connect URL (F11, Phase 3.6);
`coldStartFastRetries` conflates two policies (F12, Phase 4.5); two drained-but-never-cleared `Set`s whose
key spaces are closed (`headless/src/client.ts:582`, `bootstrapped/src/attach/transport.ts:122-124,262`)
(F19).
**Closed in Phase 2** (audit defects, kept for history): the sprite texture cache was an unbounded `Map`
that orphaned the texture it replaced, and it is now bounded, validated, and destroyed through one guarded
path the inbound frame buffer had no cap, and `MAX_FRAME_BYTES`, `maxPayload` and the
userscript's scrape bound now cover it; reconnect accounting could promise
`willReconnect: true` and then stop retrying forever, because a failed pre-open attempt continues the chain, a
parked plan is drained, and a superseded attempt (parked or in flight) abandons instead of tearing down the
replacement connection; `disconnect` blocked for a whole backoff because
the sleep was uncancellable, and it now takes an abort signal, `disconnect()` aborts it, `waitUntilReady`'s
timer is retained, and `dispose` settles every outstanding wait; `RoomSocket` could
not see a reconnect and a `4710` could loop forever when the version could not be re-resolved.
`reportedStale` was also bounded here, a finding the audit did not list.
**Still owed by this invariant:** no test asserts each timer is cleared, and nothing under `packages/*/tests`
counts handles or tracks a `clearTimeout`, so the audit's enforcement clause to that effect was
unsubstantiated; the nearest proxies are `common/tests/client.test.ts:982,992` and
`headless/tests/reconnect-abort.test.ts:41`.
**Verified against the tree at Phase 2 close** (the phase close, 2026-09-13; Phase 2's last commit).

### I6: Identity is a resolved value, never a placeholder

`selfPlayerId` is `string | null`; `null` means "not known yet" and is the honest answer. Readiness and
identity are separate facts, so a session can be ready and anonymous. **Enforced by:** the type, plus a
test that a ready-but-anonymous session reports `null`. **Violation:** the stand-in `Welcome` re-fires
on every patch frame (it is not latched), so `client.ts:547 → sequencer.ts:302-305` re-seeds the counter
and clears the outstanding command ledger (`room-connection.ts:479`).

### I7: The userscript fails safe

One file, no external imports, no `eval`. A failure inside it must never break the host page: every
hook is wrapped, every error is caught and reported, and the badge never throws into the game's
callbacks. It also never overwrites a page global it did not create; `userscript.ts:205-210` currently
clobbers `window.__mgjs`, which is the realm namespace `realm.ts:239` created, so the next
`getNamespace()` throws.

### I8: A gate must be able to fail

Every check in `verify` fails when it should. No `skip` that is always taken, no `|| true`, no
hardcoded `PASS`, no exit-0-on-error.

**Status: enforced since Phase 0 landed.** The audit's most damaging cluster was here, and each item is
now closed: `verify` builds *before* it tests, so the 16 userscript assertions execute (they reported
113/113 instead of 97/113 + 16 skipped); `room-socket.test.ts` asserts the bare `'pong'` reached the
server byte-for-byte instead of `length > 0 || true`; `verify-socket.ts` reads the close code off the
event and exits 2 when it could not connect, 1 when the code is not the documented 4840, and no longer
prints `PASS` for an outage, and it cannot print *nothing* either, because the verdict is printed
before the teardown; `probe-guest-encoding.ts` exits 1 if any encoding is accepted; and the bundle size
is a real budget with a floor and a ceiling (`scripts/assert-bundle-size.ts`), shared with the artifact
test rather than restated. `test` discovers packages instead of three hand-written globs, and
`tsc -p tsconfig.tests.json` means the tests are typechecked too.

**Corrected later:** two of those, the userscript's own assertions and the size budget, turned out to be
about an *application* rather than a library, and left with it. The reasoning still stands; the subject
changed. See §10.

**Still owed by this invariant:** the live scripts are not yet in CI (Phase 8.2), and a `--test` run
that finds no files still exits 0, which nothing currently checks.

### I9: `common` is platform-free, and the compiler says so

`common` compiles with `"lib": ["ES2022"]` and `"types": []`, so `fetch`, `AbortController`, `document`,
and `node:*` are compile errors. Browser-safe HTTP is injected as a function, not called globally.
**Violations:** the shared base config applies `DOM` + root `@types/node` to every package, so
`common` could `import 'node:fs'` today and still compile; it already calls the global `fetch` and
`new AbortController()` (`catalog/http.ts:55, 66`) despite the package header promising it "never touches
a DOM". The `headless` package is the one that needs `types: ["node"]`; `bootstrapped` needs
`["node", "tampermonkey"]`.

---

## 7. Tooling and gates

`npm run verify` is the single gate and must mean: **lint → typecheck (source *and* tests) → build →
test → size**.

```
lint      biome check .                       one devDependency, one config
typecheck tsc -b --force && tsc -p tsconfig.tests.json    tests are typechecked too
build     tsc -b
test      npm run test --workspaces --if-present          discovered, not three hand-written globs
docs:check node scripts/api-docs/check.mjs    the published surface still matches §10's manifest
```

**The `size` line left with the userscript.** It read `tsx scripts/assert-bundle-size.ts`, which measured
`dist/magicgarden.user.js`, an application's artifact, so this repository's gate was partly measuring an
application it no longer contains. It now runs in `bootstrapped-example`, beside the bundle it measures, and
`build` lost its matching `npm run bundle -w @mg.js/bootstrapped` half.

Non-negotiable details:

- **`build` runs before `test`.** The artifact tests exist to verify the artifact; ordering them after
  it is the whole point. `verify`'s order is the bug, not the tests.
- **`typecheck` covers tests and scripts.** 18 real type errors currently live in test files, and
  `tsc -b --force --listFilesOnly | grep tests/` matches nothing. `packages/headless/tsconfig.test.json`
  exists, is referenced by nothing, and fails when actually run.
- **The install must be reproducible first.** `npm install` cannot run on this machine (the default npm
  cache is read-only), `package-lock.json` knows only 1 of 3 workspaces, and `node_modules/@mg.js/` holds
  one symlink instead of three. A committed `.npmrc` with `cache=.npm-cache` fixes it; `npm ci` proves it.
- **Live checks stay out of `verify`** (they need the internet) and run in their own workflow, but they
  must be able to fail: they report measured values and set a non-zero exit code.
- **CI is the enforcement point** (`.github/workflows/ci.yml`: `npm ci && npm run verify` on Node 22,
  uploading the built userscript as an artifact; `live.yml` on schedule/manual only).

Config rules: `common` gets `"types": []` and `"lib": ["ES2022"]`; `headless` gets `"types": ["node"]`;
`bootstrapped` gets `"types": ["node", "tampermonkey"]`; the three package tsconfigs stay duplicated on
purpose, at 6 lines each, because a shared preset costs more indirection than it saves; `ws` is declared
once, as an optional peer at one version, with a devDependency for the tests.

### Deliberate lint deviations

Biome's recommended preset is on, with exactly two exceptions, both recorded in `biome.json`. Each is a
case where the codebase does by design what the rule is right to flag in general:

| Rule | Scope | Why |
|---|---|---|
| `complexity/useLiteralKeys` | off repo-wide | Every site is quoted index access on an untyped wire record, as in `record['selfPlayerId']`, `roomConnection['present']` and `globalObject['unsafeWindow']`. The quotes are the signal that the key came off the socket or out of a global bag rather than from a declared shape; property access reads identically. |
| `suspicious/noDuplicateEnumValues` | off for `packages/common/src/protocol/close-codes.ts` only | That enum carries `@deprecated` aliases for the field guide's alternate names for the same numeric codes (`Unspecified4100` → `ReconnectInitiated`), so duplicates are intended. Scoped to the one file so the rule still catches a copy-paste mistake in any other table. |

Two further diagnostics were suppressed *locally* rather than configured away, because the rule is right
in general and this is one intentional exception with a comment: `CommandHandle.then` (the class exists
to be awaitable) and nothing else.


---

## 8. Documentation

`README.md` was 456 lines, most of it reference material, so the reference now lives in `docs/` and the
README is an introduction again. Task 8.1 landed the split as 157 lines plus seven topic documents:

```
README.md                 157 lines: pitch, package table, quick start, verification summary,
                          known limitations, layout, links into docs/
docs/DESIGN.md            this document
docs/protocol.md          the three outbound forms, sequence integrity, ack correlation
docs/attachment.md        how attachment works (raw socket, room object, the upgrade, the renumbering seam)
docs/sessions.md          how a headless client authenticates (mc_jwt, OAuth, why guests get 4840)
docs/close-codes.md       the 18-code table and where it beats the documentation
docs/announcements.md     the developer announcements this library encodes
docs/verification.md      the dated evidence ledger, appended per release
docs/provenance.md        where the protocol came from + SHA-256 of the vendored sources
docs/sources/*.html       the two third-party protocol documents, vendored with their SHA-256s
                          (the originals live outside this repo; these copies are the evidence)
docs/audit/*              this audit, kept as evidence
docs/plans/*              the improvement plans
```

Both live defects this paragraph used to name are fixed. The README cited the headless mock-server fixture by
a path that was already wrong when this note was written; Task 5.8 moved that fixture to
`packages/headless/tests/fixtures/mock-server.ts`, and the citation (plus eight source comments that named
moved test files) now points at the current homes, which is also why Task 5.8's structural guard exists: a
path in prose is a claim nothing checks. The second was a forward reference in the README
quick-start to a **"Render layer" section that was never written**; rather than invent the section, the
dangling promise is gone. Real render documentation arrived with the 8.1 split, which put the render surface
into the README's Bootstrapped section alongside the working `client.render.getCtors()` snippet.

---

## 9. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Breaking API changes allowed pre-1.0 | Unpublished, single consumer; aliases would fossilise the wrong shapes |
| D2 | Biome, not ESLint + Prettier | One devDependency, one config; the repo has zero lint config today |
| D3 | Missing capabilities are in scope | The audit's `missing-capability` findings are work items |
| D4 | Folder rule: ≥2 modules or a published subpath | Removes the four-way inconsistency; makes "where does this go" answerable |
| D5 | Barrels everywhere, explicit re-exports, no `export *` in entries | One rule for all four packages; already caused a real name collision |
| D6 | One `MgClient` contract for all clients | Four divergent lifecycles is the audit's top architectural finding |
| D7 | Errors: throw for programmer error, Result for the wire, events for lifecycle | Removes "which one is it this time?" |
| D8 | Tests mirror source paths | Makes the 27 untested files visible as empty slots |
| D9 | Invariants are enforced by tests, not by comments | The audit found five comments asserting checks that do not exist |
| D10 | Keep the `@mg.js/*` scope and the `common`/`headless`/`bootstrapped` names | 49 source references, README, and the exports map agree; renaming buys nothing |
| D11 | Node ≥ 22 for `headless`, engines stated per package | `--test` with a quoted glob and `globalThis.WebSocket`; `common` stays runtime-agnostic |
| D12 | Distribute the userscript as a GitHub release asset, now **moved**: the userscript is `bootstrapped-example`'s artifact, not this repository's | The current `@downloadURL` points at a 404 repo, so auto-update can never work |
| D13 | Publish the four packages to the public npm registry under the `@mg.js` scope | The alternative was a git or release-tarball dependency, the approach `bootstrapped-example` used: it works, but it pins every consumer to a URL a human must edit per release and gives no range resolution. Local iteration needs `npm link` either way, so that is not a differentiator |

Each package carries `publishConfig.access: "public"`, because a scoped package is published *restricted* by
default, and restricted publication needs a paid plan, the most common way a first scoped publish fails. Each
also carries a `prepack` that runs `tsc -b`, so a stale `dist/` cannot be published by forgetting to build. The
three move in lockstep at one version, and `headless`/`bootstrapped` depend on `@mg.js/common` by range rather
than by exact pin: a consumer that also depends on `common` then resolves one copy instead of two, and two copies
would mean two `Store` classes in one process.

**D12 outlived its subject.** It decided to distribute *the userscript* as a
GitHub release asset, and the userscript is not this repository's artifact: `bootstrapped-example` builds the
bundle and owns the banner, the size budget and the release. So the asset, and the `@downloadURL` that points at
it, belongs to *that* repository's releases, which is where the banner points now. This repository is a wrapper:
it publishes packages (D13), and no release of it carries, or ever will carry, a `magicgarden.user.js`. The
banner's `@namespace` stays `https://github.com/QenuDev/MG.js` on purpose, naming the project rather than the
repository that builds one particular script, because Tampermonkey treats it as the update identity and it must
not change after the first install.

---

## 10. Not doing (YAGNI)

`.editorconfig` (Biome owns format), `CONTRIBUTING.md` and `SECURITY.md` (one maintainer; the real rules
belong in a 10-line README "Development" section), `CHANGELOG.md` and changesets before the first
release, husky/lint-staged/commitlint (CI is the gate), collapsing the three package tsconfigs, a docs TOC
generator, and committing any built artifact. The userscript is the case that motivated the last one, and it
has since left the package altogether: `bootstrapped-example` owns its bundle, its banner and its size
budget, and this repository commits neither.

**Superseded: an `examples/` package.** Declined here on the grounds that "the live scripts become the
example". That is no longer the arrangement: the userscript is an application, and it has its own repository,
which *is* the example.

**Reversed: `typedoc`.** It was declined here with the reason "the doc comments are the API docs". Measured,
that was false: 3 of 50 param interfaces and 15 of 110 fields carried a doc comment, and a reference generated
from the declarations showed `headless` and `bootstrapped` publishing 14 internals as though they were public
API. The rationale asserted that the documentation existed; it did not, and a consumer had no way to read the
API without reading the source of a library whose entire purpose is to be consumed.

Two things were wrong, and they needed different fixes. The **tags** were the smaller half: `@internal` on
those 14 declarations, so `excludeInternal` stops presenting them as surface. The **tool** was the other:
`typedoc` is now a root devDependency, and the reference is generated from the declarations.

**The gate is `npm run docs:check`, and it compares a manifest, not the output.** Committing the reference
itself would mean 600+ markdown files or ~10 MB of HTML, the artifact-committing this section already
declines, and a diff no reviewer reads. Generating it only on demand means nothing notices when an export is
added, renamed or dropped, which is how the internals got published in the first place. So
`docs/api-surface.json`, holding module → kind → symbol names with 36 modules and 593 symbols in ~20 KB, is
committed, `docs:check` regenerates it from the declarations and fails on any difference, and `verify` runs
it. The HTML is written to `.docs-api/` and gitignored, for a human to read; the manifest is what the gate
diffs.

**What the gate does not claim.** It catches the structural half: what exists, where, and of what kind. It
cannot catch prose, because a doc comment can be rewritten without the manifest changing. That is the half
that was measured broken, so it is the half that is now enforced. **Cost, stated plainly:** `typedoc` and its
transitive dependencies are dev-only (nothing reaches the three published packages), but it is the largest
addition to this repository's dependency tree and it contradicts D2's "one devDependency" spirit. It was
accepted because the alternative was a library whose API could only be learned by reading it.

**Two candidates rejected during Phase 7's scoping of "missing capabilities", recorded here so they are not
re-proposed.** Both were in the master plan's Task 7.5 row and neither has a source anywhere else: no README
promise, no audit finding, no half-built code:

- **A pointer/input observation surface.** No documented game input API exists in this repository, `PageRealm`
  has no input global, and `render/world-geometry.ts` produces tile geometry only, so there is no screen→tile
  transform to answer "which tile is under the cursor" with. It would also capture input the game owns at
  frame rate, the hazard `attach/raw-socket.ts`'s own header treats as first-class, and break silently on any
  client update. The boundary is stated where the application lives: `bootstrapped-example`'s `userscript.ts`
  says *"This is a wrapper, not a mod. It has no feature UI of its own: that is what a mod built **on**
  it provides."*
- **A DOM panel.** One already exists: `bootstrapped-example`'s `badge.ts` builds a shadow-isolated, collapsible
  host with a detail pane, and its `userscript.ts` fills it with nine lines of live report. Generalising
  `BadgeHandle` into a panel API in *this* library would be speculative surface, the mirror image of what
  Phase 6 removed, and it now is not this package's surface at all.

---

## 11. Open questions for the human

**Answered:**

1. **Release identity: there are no releases and the GitHub repo is private.** So the fix is to point
   `@namespace` and `@downloadURL` at the real repo (`QenuDev/MG.js`) instead of the wrong owner, and
   to *defer distribution*: Tampermonkey cannot fetch a release asset from a private repo over its
   unauthenticated update check, so auto-update is impossible until the repo is public. Publishing to npm
   stays off (`private: true`). Consequence for the plan: Phase 8.3 becomes "make the metadata correct
   and the URL honest", not "ship a release".
   **Superseded, twice over.** The userscript has since left this repository, so `@downloadURL` names
   `MG.js-bootstrapped-example`'s release asset and not this repository's: the "real repo" for a
   *userscript* is the one that builds it. And npm publication is no longer off the table; it is D13.
2. **License: a pseudonym is enough.** OSI's MIT text requires only that "the above copyright notice"
   travel with copies; the holder field is an identifier, and a handle is what most individual
   maintainers write. A legal name starts to matter only when ownership has to be *proven* (enforcement,
   registration, a DMCA claim), and the repo is private and undistributed today.
   ([OSI MIT text](https://opensource.org/license/mit), [what the license requires](https://safeguard.sh/resources/blog/what-is-the-mit-license))
3. **`docs/audit/` stays versioned**: the repo is private, and the evidence is the argument for every
   decision in §3-§6. It is committed.

4. **Structural target: decided on scope A, the full target** (~105 files from 66). All three layers land in
   Phase 5: barrels and the corrected `exports` map, the misleading renames, and the splits. The
   `exports`-map half is pulled forward to run *before* Phase 0, because `@mg.js/headless/auth` resolves
   to a module with no auth providers today, which is a bug rather than a style question.
5. **Biome `lineWidth`: decided at 110.** Measured: of the 2,195 lines longer than 100 columns, 1,896 are
   comments that Biome will not rewrap and only 299 are code, so 100 would cost ~299 rewrapped lines and
   110 costs ~57. (The structure audit's ~2,039 figure counted every long line, comments included.) The
   long comments stay long at any width, because they are the house style.

---

## 12. What the audit found, in numbers

89 findings: **4 critical**, 18 high, 8 medium (verified), plus 60 reported-but-unverified (mostly
medium/low). 8 merged root-cause themes:

1. untrusted wire/patch/URL data reaching assignment keys, structural writes, or unguarded buffering (6)
2. teardown and uninstall paths that leak listeners, sockets, timers, hooks, captured stores, or full
   state (8)
3. test gates that cannot fail, plus test code no TypeScript project ever checks (6)
4. one helper or contract reimplemented per package, with copies that have already diverged (7)
5. reconnect/retry lifecycle and counters that diverge from the reported close/attempt/shutdown state (5)
6. WorldScene and renderer lifecycle: invisible layers, unguarded suppression, one-pet penning, no
   recovery after renderer recreation (5)
7. public options, setters and API endpoints that are inert, unread, or silently discarded (8)
8. credentials and auth headers reaching events, logs and failure messages, or silently dropped (4)

The four critical findings are stated plainly below, because two of them mean the library does less than
it claims: **`Object.prototype` can be polluted by a patch path**, **no WorldScene layer can ever display
a sprite** (the layer container is set `visible = false` and nothing ever sets it back), **the renumbering
hook can hand back a detached counter while reporting `active: true`**, and **the release gate that is
supposed to catch the first two cannot fail**: 16 artifact assertions skip on every run.
