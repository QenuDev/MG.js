# Cross-cutting conventions: audit of the whole repository

Scope: `packages/*/src` (66 files), `packages/*/tests` (21 `*.test.ts` + 1 mock server), `scripts/` (3 files),
`tsconfig*.json`, `package.json`, `README.md`. Every count below was produced by running the grep/tsc command
over the tree, not by sampling. Line numbers are the lines I opened.

## Derived conventions (the dominant pattern per axis)

| Axis | Dominant pattern | Count / citation | Deviations |
| --- | --- | --- | --- |
| File naming | 100% kebab-case, no camelCase/PascalCase filenames | 9 hyphenated names (`close-codes.ts`, `remote-json-source.ts`), 0 mixed-case | none |
| Folder layout | one folder per domain **in `common` only**; `headless` is flat + `auth/`+`transport/`; `bootstrapped` is 5 folders + 3 flat files | `common/src/{protocol,actions,state,catalog,transport}` | `bootstrapped/src` keeps `client.ts`,`storage.ts`,`realm.ts`,`userscript.ts` at the root next to 5 folders, inconsistent but co-located |
| Barrels | `index.ts` in every folder **of `common`**; `headless`/`bootstrapped` have exactly one root barrel | 6 barrels: `common/src/index.ts` + 5 sub-barrels; `headless/src/index.ts`; `bootstrapped/src/index.ts` | `common` uses `export *` (7 wildcards); `headless`/`bootstrapped` hand-enumerate; see §4 |
| Class vs factory | `class` for stateful objects, `createX`/`buildX` plain functions for data/closures | 47 `export class` vs 13 `createX` + 9 `buildX` | `createLogger`+`ConsoleLogSink` (both) is the only place both idioms ship together |
| Getters | read-only derived state is a **getter**, never a `getX()` method; zero non-null assertions anywhere | 112 `get x()` in src, 0 `!` postfix in src | none |
| `null` vs `undefined` | `null` is the explicit "absent" value; `?:` optional is the "not supplied" case | 331 `\| null` vs 110 `\| undefined`; 487 `?:` | `exactOptionalPropertyTypes: false`, so 110 `\| undefined` are redundant (e.g. `headless/src/reconnect.ts:79`) |
| Error strategy | `throw new MgXError` from the `MgError` hierarchy for programmer/protocol faults; results carried in `CommandResult`; events for async | 39 `throw new` (common 15, headless 15, bootstrapped 9); 10 classes in `common/src/errors.ts`; 0 `Result<T>` | none material |
| JSDoc | every src file opens with a `/** ... */` block; doc comments are prose, `@param` rare | 66/66 file headers; 495 documented vs 115 undocumented `export`; only 23 `@param`, 33 `@returns`, 0 `@example` | `common/src/actions/types.ts` holds ~60 undocumented param interfaces (documented on the method in `actions.ts` instead) |
| Comments | heavy prose + em-dashes + `// ---...---` section banners | 640 em-dashes; 58 banners in 11 files | none |
| Tests | `node:test` + `node:assert/strict`, import source by relative path, fixture helper per file | 22 test files, all with a file header JSDoc | structure split: §3 |
| Import order | value import first, then `import type` for the same module | 23 value-first vs 17 type-first files; 0 inline `import { type X }`; 0 `../../` (depth never exceeds `../`) | `common`'s own barrels invert it (type-first, 6/6) |
| Cast discipline | `as` only behind `as unknown as` for page/third-party boundaries; never `any` | 32 `as unknown` (30 `as unknown as`), 12 `as const`, **0 `as any`**, 0 `@ts-ignore`/`@ts-expect-error` | none |
| Constants | protocol/interaction numbers live beside their type, named `SCREAMING_SNAKE` | `KEEPALIVE_PING`, `GAME_GRID_MS` (`catalog/types.ts:220`), `DEFAULT_RECONNECT` | two competing reconnect defaults (see "Also worth fixing"); numeric separators inconsistent: §6 |
| `export type` placement | a separate `export type { ... }` statement, never inline `type` in a value export | 100 `export type`/`type` decls, 0 `export { type X }` | package-level ordering reverses: `common/src/index.ts:21-22` type-then-value, `headless/src/index.ts:41-42` value-then-type |

## Findings

### 1. No test file (or script) is in any TypeScript project: `tsc -b --force` exits 0 while test code has type errors
**severity:** high · **category:** tests · **breaking:** no

`packages/common/tsconfig.json:8` is `"include": ["src/**/*.ts"]`; the same for `headless/tsconfig.json:8` and
`bootstrapped/tsconfig.json:8`; root `tsconfig.json:3-7` references only those three. `packages/headless/tsconfig.test.json`
exists and includes `tests/**/*.ts`, but **nothing references it** (`grep -rn "tsconfig.test"` outside `node_modules`
returns nothing), and `bootstrapped`/`common` have no test project at all. `scripts/*.ts` is likewise uncovered.

To prove it matters, run the orphan config by hand:

```
$ npx tsc -p packages/headless/tsconfig.test.json --noEmit
packages/headless/tests/integration.test.ts(502,28): error TS2339: Property 'superseded' does not exist on type 'never'.
packages/headless/tests/integration.test.ts(503,28): error TS2339: Property 'delayMs' does not exist on type 'never'.
```

and the bootstrapped suite, probed with an ad-hoc config that includes `src` + `tests`:

```
packages/bootstrapped/tests/attach.test.ts(267,34): error TS2783: 'type' is specified more than once, so this usage will be overwritten.
packages/bootstrapped/tests/coexistence.test.ts(141,30): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'never'.
packages/bootstrapped/tests/attach.test.ts(27,15): error TS6196: 'InboundMessage' is declared but never used.
```

`integration.test.ts:502` narrows `plans` to `never[]` because `@types/node` declares `assert.deepEqual` as
`asserts actual is T`, and line 483 asserts `deepEqual(plans, [])`; lines 501-503 then compile as `never`.
`attach.test.ts:267` is `serialiseFrame({ type: 'Welcome', ...welcomeMessage('p_42', 7) })`, and the spread overwrites
the literal `type`, so the fixture does not contain what it says. Neither is caught by `npm run verify`, and
`README.md:297` ("tsc -b --force exit 0 strict, incl. noUncheckedIndexedAccess + noUnusedLocals") reads as if the
whole tree were covered.

**Why it matters:** the 490 green tests are unverified against `strict` + `noUncheckedIndexedAccess`. A test that
does not typecheck is a test whose assertion is not checked by the compiler, and the two above are already wrong.
**Fix:** add `packages/common/tsconfig.test.json` and `packages/bootstrapped/tsconfig.test.json` (copy the headless
one) and add all three as `references` in root `tsconfig.json`, so `tsc -b --force` covers tests; add a
`tsconfig.scripts.json` for `scripts/**`. Then fix the four errors.

### 2. Tests import sources with a `.ts` extension, violating the NodeNext `.js` rule: 21 occurrences
**severity:** medium · **category:** consistency · **breaking:** no

Two examples: `packages/bootstrapped/tests/coexistence.test.ts:27`, whose import reads
`} from '../src/coexistence/brand.ts';`, and `packages/common/tests/weather.test.ts:24-25`, where both
the value and the type import end in `.ts`. Exactly
`packages/bootstrapped/tests/*` (5 files, 19 imports) plus `common/tests/weather.test.ts` (2) do this; the other
15 test files use `.js` (46 imports), as does all of `src` (0 `.ts` extensions). The orphan test project above
proves this is not merely stylistic: `error TS5097: An import path can only end with a '.ts' extension when
'allowImportingTsExtensions' is enabled`, 19 times. This is a direct violation of the standing constraint
"relative imports end in `.js`" and it is the reason the deviation survived: finding 1 means nothing ever compiled
these lines.

**Why it matters:** the moment tests are typechecked (finding 1) the `.ts` files fail; and a contributor who copies
a bootstrapped test into `common` inherits the wrong extension.
**Fix:** rewrite them to `.js`: `bootstrapped/tests/{attach,catalog-sources,coexistence,ctors,room-upgrade}.test.ts`
and `common/tests/weather.test.ts`, and let finding 1 be the guard that keeps them right.

### 3. Test structure is split along package lines: `describe`/`it` in `common`+`headless`, flat `void test(...)` in `bootstrapped`+`weather`
**severity:** medium · **category:** consistency · **breaking:** no

`describe` blocks: 63 across 14 files: all 8 non-weather `common/tests` files (`common/tests/sequencer.test.ts:18,19`)
and all 6 `headless/tests` files. Flat `void test(`: 123 across 7 files, which are **all 6** `bootstrapped/tests` files
(`bootstrapped/tests/coexistence.test.ts:40`) plus `common/tests/weather.test.ts:48`. `node:test`'s `it` appears
only inside `describe`; there are 0 floating `test(` calls, so the `void` prefix is deliberate on one side and
unnecessary on the other. There is no naming rule either: describe-side names are third-person declaratives
("seeds the next value from executedCommandSequence + 1"), flat-side names are the same style, so only the
nesting differs, and there are no section banners in `common`/`headless` tests where `bootstrapped` uses
`// ---...---` banners (`coexistence.test.ts:36-38`) to group what `describe` groups elsewhere.

**Why it matters:** the suite has two shapes for one job, split exactly where files are most likely to be copied
from. A contributor adding a `common` test has to choose against 8-to-1 local evidence, then rewrite it to move it.
**Fix:** standardise on `describe`/`it` (the 14-file majority, and the shape `node:test` reports as a tree) and
convert the 7 flat files; delete the banner workaround in `bootstrapped/tests/coexistence.test.ts:36`.

### 4. Barrel strategy is `export *` in `common` and hand-enumerated elsewhere, and it has already forced a hand-written exclusion plus a redundant re-export
**severity:** medium · **category:** duplication · **breaking:** yes (removing a duplicate `Unsubscribe` export)

`packages/common/src/index.ts:15-19` re-exports five sub-barrels with `export *`; `packages/headless/src/index.ts`
and `packages/bootstrapped/src/index.ts` enumerate every symbol explicitly with a per-line provenance comment.
`common`'s wildcards have produced two hand-maintained workarounds:

- `packages/common/src/state/index.ts:19-21`: "`Unsubscribe` is intentionally not re-exported here: `./transport/index.js`
  exports the same shape, and the package barrel re-exports both, so exporting it twice would be ambiguous."
  In fact the identical one-line type is declared three times: `common/src/state/store.ts:24`,
  `common/src/transport/types.ts:15`, `headless/src/room-socket.ts:54`. `@mg.js/common` and `@mg.js/headless`
  therefore both export a name `Unsubscribe` that are different nominal types, so a file importing both needs an alias.
- `packages/common/src/actions/index.ts:6-7`: `export type { ShopKey, CrystalIntent } from './types.js';` immediately
  followed by `export * from './types.js';`. The explicit line is dead weight; `export *` already exports both.

`export *` also means adding an export to any `common` module silently changes the package's public surface, while
in `headless`/`bootstrapped` forgetting to edit `index.ts` silently withholds it. Neither behaviour is tested:
no test asserts a barrel surface.

**Why it matters:** "where do I put the export?" has two opposite answers and one of them has already produced a
duplicate declaration and a dead re-export that a new contributor will read as meaningful.
**Fix:** pick hand-enumeration for `common/src/index.ts` too (drop the five `export *`), delete the redundant line
`common/src/actions/index.ts:6`, and declare `Unsubscribe` once in `common`: `export type Unsubscribe = () => void;`
in `common/src/transport/types.ts`, re-exporting it from `common` and from `headless/src/index.ts`, deleting
`headless/src/room-socket.ts:54`.

### 5. Options polarity is inconsistent inside a single package: `disableX: true`, `enabled: true` and `autoReconnect: false` all mean "off"
**severity:** medium · **category:** api-design · **breaking:** yes

`packages/bootstrapped/src/client.ts:119-132` declares five negative flags (`disableRenumbering`, `disableJotai`,
`disableCatalog`, `disablePlatformCatalog`, `disableRender`), while the same class's own report type uses the
positive form for the same five features: `bootstrapped/src/client.ts:168-171`
(`render: { enabled: boolean }`, `jotai: { enabled: boolean }`, ...). `common/src/protocol/types.ts:257` uses
`enabled: boolean` in `ReconnectConfig`, and `headless/src/client.ts:202-204` ships **both** spellings for one
switch: `reconnect?: Partial<ReconnectConfig>` (carrying `enabled`) and `autoReconnect?: boolean`, with line 203
documenting `autoReconnect` as "equivalent to `reconnect: { enabled: false }`". `headless/src/client.ts:308` then
resolves three sources for one boolean: `options.reconnect?.enabled ?? options.autoReconnect ?? true`.

**Why it matters:** a caller cannot guess, and `ClientCoreOptions.autoHandledKeepalive` (`common/src/client.ts:111`)
is a fourth spelling with the same problem in the other direction: its `true` branch (`ClientCore` sending the pong
at `common/src/client.ts:505`) is unreachable from this repo, because both call sites pass `false`
(`headless/src/client.ts:705`, `bootstrapped/src/client.ts:242`). Two ways to say one thing also means two ways to
be surprised by precedence.
**Fix:** make every switch positive and single, e.g. `BootstrappedClientOptions.features?: { renumbering?: boolean; jotai?: boolean;
catalog?: boolean; platformCatalog?: boolean; render?: boolean }` (default `true` each), and delete
`HeadlessClientOptions.autoReconnect` in favour of `reconnect: { enabled: false }`.

### 6. Numeric literals are inconsistent: `60000` vs `60_000` for the same value in the same repository
**severity:** low · **category:** consistency · **breaking:** no

`_` separators: 30 occurrences, concentrated in `bootstrapped` and `common/catalog`
(`common/src/catalog/source.ts:63` = `300_000`, `common/src/catalog/types.ts:220` = `300_000`). No separators:
`common/src/protocol/types.ts:290` = `60000`, `:292` = `30000`, `common/src/transport/types.ts:92-96` = `20000`/`15000`/`10000`.
`headless/src/reconnect.ts` writes `60_000` (`:48`) and `30_000` (`:50`) for the same values
`common/src/protocol/types.ts` writes as `60000`/`30000`, and `headless/src/reconnect.ts:44` claims the two
"cannot drift" while the file is a copy of `common`'s constant. `60_000` (30) beats `60000` (16) fleet-wide, but
not inside `common/src/protocol`.
**Fix:** adopt `_` for ≥5 digits everywhere and delete the duplicate (below).

## The three worst inconsistencies for a new contributor

1. **Nothing but `src` is typechecked** (§1). The first thing a contributor does, changing a source file and
   running `npm run typecheck`, gives a false green, because `common/tsconfig.json:8` and its two siblings exclude
   `tests/`, and `headless/tsconfig.test.json` is referenced by nothing. Two of the tests are already
   type-broken (`headless/tests/integration.test.ts:502` on `never`, `bootstrapped/tests/attach.test.ts:267` where
   the spread overwrites `type`). Cost: every test edit is unverified, and `README.md:297` says otherwise.
2. **Tests have two shapes and two import-extension conventions, split exactly by package** (§2, §3). `common` and
   `headless` tests use `describe`/`it` and `.js`; `bootstrapped` tests use flat `void test(...)` and `.ts`
   (19 of 21 `.ts` imports), a direct violation of the standing rule and of `common/tests/sequencer.test.ts:18-19`
   vs `bootstrapped/tests/coexistence.test.ts:40`. Cost: every test written in one package is wrong in the other.
3. **There is no single answer to "where does a public symbol live?"** (§4). `common/src/index.ts:15-19` re-exports
   five sub-barrels with `export *`; `headless/src/index.ts:41-42` and `bootstrapped/src/index.ts:48-49` enumerate
   each symbol by hand. `common`'s wildcards already forced `common/src/state/index.ts:19-21`'s exclusion comment
   and `common/src/actions/index.ts:6`'s dead re-export, and left the identical `Unsubscribe` declared at
   `common/src/transport/types.ts:15` and `headless/src/room-socket.ts:54`.

Also worth fixing, not ranked: `DEFAULT_RECONNECT` (`common/src/protocol/types.ts:287`) is exported but never
consumed anywhere; `headless/src/reconnect.ts:45` re-declares it as `DEFAULT_RECONNECT_POLICY` while the comment on
line 44 claims they cannot drift, which is false by construction (§6), so delete `DEFAULT_RECONNECT_POLICY` and let
`headless/reconnect.ts:247` spread `DEFAULT_RECONNECT` from `@mg.js/common`. Separately, `scripts/verify-live.ts:13-16`
and `scripts/verify-live-socket.ts:47-49` reach across package boundaries into `../packages/*/src/*.js`.

## What works well here

- **Cast discipline is exemplary**: 0 `as any`, 0 `@ts-ignore`/`@ts-expect-error`, 0 non-null assertions across
  66 source files; 30 of the 32 `as unknown` casts sit in `bootstrapped` on page/third-party boundaries
  (`bootstrapped/src/userscript.ts` 6, `bootstrapped/src/attach/raw-socket.ts` 6), the rest on unknown-JSON and
  heterogeneous-listener edges (`common/src/protocol/codec.ts:79`, `common/src/emitter.ts:63`), and `as const` (12)
  is used for constant tables. The one exception is `headless/src/version.ts:154`, where
  `new PlatformApiSource() as unknown as VersionSource` is provably unnecessary: I compiled
  `const s: VersionSource = new PlatformApiSource();` on its own and it typechecks, since `VersionSource` is a
  structural subset of `CatalogSource` by design (see the comment at `headless/src/version.ts:47-49`).
- **Documentation density is real, not nominal**: 66/66 source files open with a file-level JSDoc block, 495 of 610
  exports are documented, and the comments record *why* (protocol-doc citations, rejected alternatives) rather
  than restating the code, e.g. `common/src/client.ts:1-23` on the three ack modes.
- **Layering is actually enforced by the tree**: `common` imports no `node:*`, no `ws` and touches no DOM global;
  no `../../` relative import exists anywhere; `headless` and `bootstrapped` never import each other.
- **Naming is monomorphic where it counts**: 100% kebab-case filenames, one barrel per `common` folder, a single
  `MgError` hierarchy, and read-only derived state exposed as getters (112) rather than `getX()` methods.
- **`node:test` hygiene**: 490 test cases (123 flat + 367 `it`), every file with a header JSDoc explaining the risk
  being covered, fixture helpers per file (`attach.test.ts:114` `welcomeMessage()`), and a real RFC 6455 mock
  server (`headless/tests/mock-server/server.ts`) rather than a stubbed transport.
