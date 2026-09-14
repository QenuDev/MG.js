Audit complete. Read-only: I modified nothing (verified: `git status` shows only the pre-existing ` M .gitignore` plus sibling agents' untracked scratch files).

**Two scope warnings before the findings:**
- My first `ls -a` at 13:11 showed **no `docs/`**. A `docs/` dir appeared at 13:45 containing only `docs/audit/_probe.md` (`written-by: subagent`), a sibling agent's write probe, not real docs infrastructure.
- `git status` now also shows untracked root files `probe-reconnect.ts`, `scratch-audit-02{,b,c,d}.ts` from concurrent agents. Treat those as session debris, not repo state.

Baseline re-verified live: `npm run verify` exit 0, `# tests 490 / # pass 490 / # fail 0`, bundle 276.2 KiB (282,800 B).

---

# 1. Current top-level layout

```text
mg.js/
├── .git/
├── .gitignore          6 lines: node_modules/ dist/ *.tsbuildinfo .DS_Store *.log .npm-cache
│                       ← UNCOMMITTED: `git diff` shows `-.npm-cache/` `+.npm-cache`
├── .npm-cache/         64K (_cacache, _logs). ORPHAN: no .npmrc exists anywhere,
│                       and `npm config get cache` = $HOME/.npm
├── node_modules/       node_modules/@mg.js/ holds ONE symlink: common -> ../../packages/common
│                       (no headless, no bootstrapped)
├── package.json        33 lines. name "mgjs", private, workspaces packages/*, engines node>=20
├── package-lock.json   lockfileVersion 3. Its `packages` keys are ONLY "", 
│                       node_modules/@mg.js/common, packages/common
├── README.md           432 lines, 22 headings (1 H1 + 13 H2 + 8 H3)
├── scripts/            3 files: verify-live.ts (130), verify-live-socket.ts (201),
│                       probe-guest-encoding.ts (155)
├── tsconfig.base.json  26 lines: the only shared compiler preset
├── tsconfig.json       8 lines: "files": [] + 3 project references
└── docs/               ⚠ sibling-agent probe only (docs/audit/_probe.md)
```

ABSENT at root (each checked with `-e`): `.npmrc`, `.editorconfig`, `.github`, `LICENSE`, `LICENSE.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`, `biome.json`, `eslint.config.js`, `.prettierrc`, `examples`, `.nvmrc`.

**Script chain** (`package.json:10-20`): `verify` (`:17`) = `typecheck` → `test` → `build`. `typecheck` (`:13`) = `tsc -b --force`. `test` (`:14`) = three *hand-written* globs. `build` (`:11`) = `tsc -b && npm run build:userscript -w @mg.js/bootstrapped`. `verify:live` (`:18`) sits *outside* `verify`. `clean` (`:19`) = `tsc -b --clean && rm -rf packages/*/dist`. There is no lint, no format check, no CI, no bundle-size gate. `test:unit`/`test:integration` (`:15-16`) map to common-only/headless-only, and bootstrapped has no named script.

---

# 2. Ranked problems

### P1: `npm install` cannot run, and the lockfile knows 1 of 3 workspaces. [CATASTROPHIC]

**Evidence.**
- `npm pack --dry-run` fails outright: `{"code":"EROFS","summary":"EROFS: read-only file system, open '$HOME/.npm/_cacache/tmp/1ff28cc2'"}`
- `npm ls --depth=0` logs `npm error Log files were not written due to an error writing to the directory: $HOME/.npm/_logs`
- `npm config get cache` → `$HOME/.npm`; no `.npmrc` in the repo or `$HOME`
- `.npm-cache/` exists (64K) and is ignored at `.gitignore:6`, but the workaround was applied by hand and never encoded
- `package-lock.json` `packages` contains only `""`, `node_modules/@mg.js/common`, `packages/common`
- Live consequence: `ls -la node_modules/@mg.js` → only `common`; `npm ls --depth=0` → `UNMET DEPENDENCY @mg.js/bootstrapped@file:...` + `UNMET DEPENDENCY @mg.js/headless@file:...`, `npm error code ELSPROBLEMS`

**Cost.** No reproducible install, `npm ci` impossible, CI impossible from this lock, and every future contributor hits EROFS. It is the root cause of the other install-shaped problems.
**Change.** Commit a root `.npmrc` with `cache=.npm-cache`; regenerate `package-lock.json` with `npm install`; assert `npm ls --depth=0` is clean and that `node_modules/@mg.js/` has three symlinks; prove it with `npm ci`.

### P2: `npm run verify` never typechecks 22 test files or 4 scripts, and 18 real errors already exist. [HIGH]

**Evidence.** `tsconfig.json:2` is `"files": []`; every package tsconfig says `"include": ["src/**/*.ts"]` (e.g. `packages/common/tsconfig.json:8`). Typechecking tests with an ad-hoc noEmit project produces 18 errors, including:
- `packages/common/tests/client.test.ts(501,26): error TS2345: Argument of type 'CommandHandle' is not assignable to parameter of type 'Promise<unknown> | (() => Promise<unknown>)'`
- `packages/common/tests/forms.test.ts(223,29): error TS18046: 'frame.command' is of type 'unknown'`
- `packages/common/tests/client.test.ts(704,11): error TS6133: 'delegated' is declared but its value is never read`
- `packages/bootstrapped/tests/attach.test.ts(27,15): error TS6196: 'InboundMessage' is declared but never used`
- `packages/headless/tests/integration.test.ts(502,28): error TS2339: Property 'superseded' does not exist on type 'never'`

The one attempt to fix this, `packages/headless/tsconfig.test.json`, is referenced by **nothing**: grep for `tsconfig.test` across `*.json/*.ts/*.md/*.yml` (excluding `node_modules`) returns zero matches, and reports 2 errors when actually run. The 4 scripts are outside every project too, though an ad-hoc project over them passes (exit 0), so nothing is hidden there; nothing enforces it either.
**Cost.** `strict` + `noUnusedLocals` is enforced on `src` only, so the loudest claim in the repo is half-true.
**Change.** Delete `packages/headless/tsconfig.test.json`; add root `tsconfig.tests.json`; `typecheck` becomes `tsc -b --force && tsc -p tsconfig.tests.json`; fix the 18 errors in the same commit.

### P3: `npm run typecheck` is a BUILD in disguise; `npm test` fails on a clean checkout. [HIGH, subtle]

**Evidence.** `package.json:13` `"typecheck": "tsc -b --force"` has no `--noEmit`, and package tsconfigs emit (`outDir`, `declaration` in `tsconfig.base.json:19-22`). Six test files import the bare specifier and therefore need built dist: `packages/headless/tests/backoff.test.ts:18`, `:19`, `packages/headless/tests/connect-url.test.ts:21`, `packages/headless/tests/transport-keepalive.test.ts:21`, `packages/bootstrapped/tests/attach.test.ts:26-27`; that specifier resolves to `packages/common/dist/index.js` via `packages/common/package.json:9-13` + `main` at `:7`. Proven empirically by moving `packages/common/dist` aside:
```
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module
#   '.../node_modules/@mg.js/common/dist/index.js' imported from
#   .../packages/headless/tests/connect-url.test.ts
# pass 0
# fail 1
```
(Dist restored immediately; re-ran that file: 22 pass / 0 fail.)
**Cost.** `verify` passes only because the "typecheck" step emits as a side effect. Any future move to a true `--noEmit` check silently breaks the suite.
**Change.** Make it explicit: keep `typecheck:src` = `tsc -b --force` (it *is* the build), and either have `test` depend on it or point tests at `@mg.js/common` src through a path/`imports` map.

### P4: There is no way to obtain the product, and the shipped userscript's updater points at a 404. [HIGH]

**Evidence.** `.gitignore:2` (`dist/`) ignores `packages/bootstrapped/dist/magicgarden.user.js`, and `git check-ignore -v` confirms rule `.gitignore:2:dist/`, so the 276 KiB product is never committed. All three packages are `"private": true` (`package.json:4`, `packages/common/package.json:4`, `packages/headless/package.json:4`, `packages/bootstrapped/package.json:4`), so npm is not a channel either. No `.github/`, no `repository` field anywhere. Meanwhile `packages/bootstrapped/scripts/build.ts:56-58` hardcodes
```ts
const DOWNLOAD_URL =
  'https://github.com/magicgarden-js/mg.js/releases/latest/download/magicgarden.user.js';
```
inlined as `@downloadURL`/`@updateURL` at `build.ts:88-89`, and that URL returns **HTTP 404**, as does `https://github.com/magicgarden-js/mg.js`. The configured remote is a different owner: `origin https://github.com/QenuDev/MG.js.git` (also 404 unauthenticated).
**Cost.** Tampermonkey's update check can never succeed; the only install path is "clone and build", which P1 currently blocks.
**Change.** Fix `@downloadURL`/`@updateURL` to the real repo and add `.github/workflows/ci.yml` uploading the userscript as an artifact (release asset on tag). Do *not* commit the userscript. Also add `*.tgz` to `.gitignore`: `git check-ignore mg.js-common-0.1.0.tgz` reports NOT ignored, so `npm pack` dirties the worktree.

### P5: Script surface is inconsistently named, half-unreachable, and one package has no test script. [MEDIUM-HIGH]

**Evidence.** `packages/headless/package.json:26-28` is `scripts: {"build": "tsc -b"}` only, with no `test`, despite headless holding 7 of 22 test files, while `packages/common/package.json:38-41` and `packages/bootstrapped/package.json:18-22` both have one. Root `package.json:14` hand-enumerates three globs, so a fourth package silently stops being tested. `scripts/verify-live-socket.ts` and `scripts/probe-guest-encoding.ts` are unreachable from any npm script (only README:287 and README:305/345); `probe-guest-encoding.ts` has no run comment at all. Names are inconsistent for what they are: `verify-live.ts` tests the catalogue only. `scripts/verify-live.ts:7` and `scripts/verify-live-socket.ts:7` both say `node --import tsx ...` while `package.json:18` uses the `tsx` CLI. `packages/bootstrapped/scripts/build.ts:141-148` only *logs* `bundle.size`; the sole size assertion is the vacuous `assert.equal(stats.size > 20_000, true, ...)` at `packages/bootstrapped/tests/build-output.test.ts:68`.
**The two-directory split is principled, not accidental:** `build.ts` anchors every path on `import.meta.url` (`build.ts:36-37`), so it is `npm run -w`-safe and package-scoped, and a test names it (`build-output.test.ts:58-59`). The root `scripts/` are repo-level, cross-package operator diagnostics. The defect is naming and wiring.
**Change.** Give headless a `test` script; root `test` becomes `npm run test --workspaces --if-present`; rename to `scripts/verify-catalog.ts` / `scripts/verify-socket.ts`; wire all three; add `scripts/assert-bundle-size.ts` (hard 320 KiB, warn 300 KiB against today's 282,800 B).

### P6: Config drift: `@types/node` leaks into the "platform-free" core; DOM lib is global; the test config is dead. [MEDIUM]

**Field-by-field.** `tsconfig.base.json` (26 lines) sets target ES2022, lib ES2022+DOM+DOM.Iterable, NodeNext module+resolution, strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes:false, noImplicitOverride, noFallthroughCasesInSwitch, noUnusedLocals, noUnusedParameters, isolatedModules, verbatimModuleSyntax:false, skipLibCheck, forceConsistentCasingInFileNames, declaration, declarationMap, sourceMap, composite, esModuleInterop, resolveJsonModule, and **no `types` field**. The three package tsconfigs are byte-identical in `compilerOptions` (`rootDir ./src`, `outDir ./dist`, `tsBuildInfoFile ./dist/.tsbuildinfo`) and differ only in `references` (common has none; headless/bootstrapped reference `../common`) and `include`.

*Deliberate:* `exactOptionalPropertyTypes:false`, `verbatimModuleSyntax:false`, ES2022, and DOM, because common really does use `fetch` (`packages/common/src/catalog/http.ts:66`) and `globalThis.crypto` (`packages/common/src/protocol/id.ts:18,52`).
*Accidental:* because base has no `types`, root's `@types/node` (`package.json:22`) is auto-included in every package. I proved `@mg.js/common` compiles clean with `"types": []` (tsc exit 0) while `@mg.js/headless` does not (`packages/headless/src/client.ts(574,34): error TS2339: Property 'unref' does not exist on type 'number'`, same at `transport/client.ts(315,22)`). So the "platform-free" claim in `packages/common/package.json:6` is unenforced: common could `import 'node:fs'` today and tsc would not complain. Also `packages/common/src/index.ts:6` claims it "never touches a DOM" while DOM lib is on and `fetch` is used. `ws` drifts: root `package.json:28` `^8.18.0` vs `packages/headless/package.json:33,36` `^8.19.0`, declared *triply* (`optionalDependencies` + `peerDependencies` + `peerDependenciesMeta.optional` at `:32-42`). And `0.1.0` is duplicated in 4 manifests with no sync mechanism.
**Change.** `"types": []` in `packages/common/tsconfig.json`; `"types": ["node"]` in headless; `"types": ["node","tampermonkey"]` in bootstrapped; align `ws`; collapse the triple declaration.

### P7: Publish surface would ship build junk and broken source maps, and every metadata field is missing. [MEDIUM]

**Evidence.** `npm pack --dry-run --cache .npm-cache` (the `--cache` is needed because of P1): common → 138 entries, 152,759 B tarball, 590,479 B unpacked, and the file list *starts* with `dist/.tsbuildinfo` (40,835 B of TS build cache: `tsBuildInfoFile` is `./dist/.tsbuildinfo` per `packages/common/tsconfig.json:6`, and `files: ["dist"]` at `:35-37` ships the whole directory). Headless → 50 entries, 101,822 B. Bootstrapped → 83 entries, 308,296 B, including `dist/magicgarden.user.js`, so the userscript would ride inside the npm package. All `.js.map`/`.d.ts.map` ship while `src/` does not, so `declarationMap: true` (`tsconfig.base.json:20`) produces maps pointing at absent files. `license`, `repository`, `author`, `sideEffects`, `publishConfig`, `engines` are ABSENT in all four manifests (`engines` exists only at root, `package.json:30-32`).

Every `main`/`types`/`exports` target **does** resolve (verified per package). `packages/headless/package.json:18-21` maps `./auth` → `dist/auth/types.js`, a file named `types.js` that emits a real runtime class (`StaticAuthProvider`, 2,203 B): misleading name, not broken. All three entrypoints are side-effect-free (`packages/common/src/index.ts`, `packages/headless/src/index.ts`, `packages/bootstrapped/src/index.ts` contain only re-exports/declarations; bootstrapped's barrel never imports `src/userscript.ts`), so `"sideEffects": false` is safe for all three: the self-installing entry is unreachable through `exports` and is bundled by esbuild directly.
**Change.** `"files": ["dist", "src", "!dist/.tsbuildinfo"]`; `"sideEffects": false`; `"license": "MIT"` everywhere; `"engines": {"node": ">=22"}` in headless only (common boots in a browser; headless's zero-dep default needs `globalThis.WebSocket`, per `packages/headless/src/index.ts:20`); `"publishConfig": {"access": "public"}` for the scope. Root `engines.node: ">=20"` (`package.json:31`) is wrong for the dev toolchain: `--test` with a quoted glob (`package.json:14`) needs Node ≥22; local runtime is v22.22.0 / npm 10.9.4.

### P8: README is the docs folder, and two references are already broken. [MEDIUM]

**Evidence.** 432 lines; the 13 H2s own 81+25+32+16+14 = **168 README-appropriate lines** vs **250 lines of reference material** (~58%): `## Where this comes from` (15), `## The three outbound forms` (26), `## Sequence integrity` (51), `## Ack correlation, honestly` (62), `## Attachment...` (192), `## Developer announcements this library encodes` (238-279), `## Sessions...` (328-387), `## Close codes...` (388-418).

Provenance points **outside the repo**: `README.md:17` says "the two documents in `../docs/`" while `README.md:19-20` say `docs/quinoa-protocol-docs.html` / `docs/quinoa-api-reference.html`, and those files exist only at `$HOME/Documents/dsh_workspaces/MG/docs/` (104,897 B + 74,671 B), one level above the repo. Broken today: `README.md:292` cites `tests/mock-server/server.ts`, which does not exist at that path (it is `packages/headless/tests/mock-server/server.ts`); `README.md:144` says `see "Render layer" below` and no such heading exists anywhere. `README.md:419-432` `## Layout` is stale (only `scripts/verify-live.ts`, two bare package lines). No TOC, no license section, no development section. `README.md:305` reports `probe-guest-encoding` results for a script with no documented run command.
**Change.** Keep README ≈150 lines; move the eight reference H2s to `docs/`; vendor the two HTML sources under `docs/sources/` with SHA-256 in `docs/provenance.md`; fix README:144 and README:292; update the command block at README:282-288 in lockstep with the script rename.

### P9: Naming: four names, three disagreeing repo identities, one orphan cache dir. [LOW, cheap]

**Evidence.** `mgjs` (`package.json:2`) · `mg.js` (folder name, npm scope in 49 src references, `README.md:422`) · `magicgarden.js` (`README.md:1`, `package.json:6`, userscript `@name` at `build.ts:78`) · `https://magicgarden.js/` (`build.ts:79`, not a resolvable URL). And `magicgarden-js/mg.js` (`build.ts:57`) vs the actual `origin` `QenuDev/MG.js` vs no `repository` field. `.npm-cache/` is ignored at `.gitignore:6` and nothing reads it. Also 3 of 4 scripts are mode 600 (`scripts/verify-live-socket.ts`, `scripts/probe-guest-encoding.ts`, `packages/bootstrapped/scripts/build.ts` are `-rw-------`; `scripts/verify-live.ts` is `-rw-r--r--`).
**Change.** Root `"name": "mg.js"`; add `"license": "MIT"`; keep `@mg.js/*` (it is in 49 source comments) and use "magicgarden.js" only as the prose display name. Set `@namespace` to the real repo URL **and** fix `DOWNLOAD_URL` in the same commit, because Tampermonkey keys update identity on `@namespace` + `@name`, so changing it after the first release breaks update detection for existing installs. `chmod 644` the scripts.

---

# 3. Proposed root layout

```text
mg.js/
├── .github/
│   └── workflows/
│       ├── ci.yml               + push/PR: node 22, npm ci, npm run verify;
│       │                          uploads packages/bootstrapped/dist/magicgarden.user.js
│       └── live.yml             + workflow_dispatch + weekly cron ONLY (never on PR):
│                                  npm run verify:catalog && npm run verify:socket
├── .gitignore                   ~ add *.tgz; settle .npm-cache/ vs .npm-cache;
│                                  drop *.tsbuildinfo (redundant: tsBuildInfoFile is under ignored dist/)
├── .npmrc                       + NEW: cache=.npm-cache: fixes P1's EROFS, makes the ignore entry true
├── .npm-cache/                  = keep, gitignored, now actually referenced
├── LICENSE                      + NEW: MIT
├── README.md                    ~ 432 to ~150 lines: pitch, package table, quick start, Verification
│                                  summary, Known limitations, Layout, links into docs/
├── biome.json                   + NEW: space/2, lineWidth 100, single quotes, semicolons,
│                                  trailing commas all, lf, organizeImports, recommended rules
├── docs/
│   ├── design.md                + MOVE README §§Design decisions to know (167-191),
│   │                              Attachment… (192-237): also home of the design doc being written
│   ├── protocol.md              + MOVE README §§The three outbound forms (26-50),
│   │                              Sequence integrity (51-61), Ack correlation (62-85)
│   ├── announcements.md         + MOVE README §Developer announcements this library encodes (238-279)
│   ├── sessions.md              + MOVE README §Sessions: how a headless client actually authenticates (328-387)
│   ├── close-codes.md           + MOVE README §Close codes: where this beats the documentation (388-418)
│   ├── verification.md          + MOVE README §Verification results ledger (294-308), appended per release
│   ├── provenance.md            + MOVE README §Where this comes from (15-25) + SHA-256 of both sources
│   ├── improvement-plan.md      + NEW (being written): README links it from a "Status / plan" heading
│   └── sources/
│       ├── quinoa-protocol-docs.html  + VENDOR the 104,897 B file README:17 points at (currently outside)
│       └── quinoa-api-reference.html  + VENDOR the 74,671 B file
├── package.json                 ~ name→mg.js, license→MIT, engines→>=22, new scripts block, +@biomejs/biome
├── package-lock.json            ~ REGENERATE (P1)
├── tsconfig.base.json           = keep as the shared preset, unchanged (the leak is fixed per package)
├── tsconfig.json                = unchanged: files:[] + 3 references
├── tsconfig.tests.json          + NEW: noEmit, composite:false, declaration:false,
│                                  allowImportingTsExtensions:true, types:[node,tampermonkey],
│                                  include packages/*/src + packages/*/tests + scripts/** +
│                                  packages/bootstrapped/scripts/**
├── packages/…                    (src/tests owned by the other agent)
│   ├── common/tsconfig.json            ~ add "types": []
│   ├── headless/tsconfig.json          ~ add "types": ["node"]
│   ├── headless/tsconfig.test.json     − DELETE (dead; superseded by root tsconfig.tests.json)
│   ├── bootstrapped/tsconfig.json      ~ add "types": ["node","tampermonkey"]
│   └── bootstrapped/scripts/build.ts   = KEEP in packages/: package-scoped, import.meta.url-anchored,
│                                         and referenced by build-output.test.ts:58-59
└── scripts/                     (repo-level, operator-run, cross-package: the split is principled)
    ├── verify-catalog.ts        ~ RENAME from verify-live.ts (it exercises the catalogue API only)
    ├── verify-socket.ts         ~ RENAME from verify-live-socket.ts; ALSO change imports at :47-49 from
    │                              '../packages/headless/src/client.js' to '@mg.js/headless', which makes it
    │                              the one command that proves workspace resolution (P1) works
    ├── probe-guest-encoding.ts  = keep the name; add the missing run comment
    └── assert-bundle-size.ts    + NEW: fail >320 KiB, warn >300 KiB (current 282,800 B): takes over the
                                   vacuous >20_000 assert at build-output.test.ts:68
```

**Root `package.json` scripts block:**

```json
"scripts": {
  "lint": "biome check .",
  "lint:fix": "biome check --write .",
  "typecheck": "tsc -b --force && tsc -p tsconfig.tests.json",
  "typecheck:src": "tsc -b --force",
  "test": "npm run test --workspaces --if-present",
  "test:common": "npm test -w @mg.js/common",
  "test:headless": "npm test -w @mg.js/headless",
  "test:bootstrapped": "npm test -w @mg.js/bootstrapped",
  "build": "tsc -b && npm run bundle -w @mg.js/bootstrapped",
  "bundle": "npm run bundle -w @mg.js/bootstrapped",
  "size": "tsx scripts/assert-bundle-size.ts",
  "verify": "npm run lint && npm run typecheck && npm test && npm run build && npm run size",
  "verify:catalog": "tsx scripts/verify-catalog.ts",
  "verify:socket": "tsx scripts/verify-socket.ts",
  "probe:guest": "tsx scripts/probe-guest-encoding.ts",
  "clean": "tsc -b --clean && rm -rf packages/*/dist"
}
```

Gate map: `lint` is Biome lint **and** format check in one pass (no separate `format:check`) · `typecheck` = src projects + one noEmit project over tests and scripts · `test` = all three packages, discovered not enumerated (needs the new `test` in `packages/headless/package.json`) · `build` = dist + userscript · `size` = the budget gate · live smoke = `verify:catalog`/`verify:socket`, **excluded** from `verify` and run only by `live.yml`, because they need the internet (`scripts/verify-live.ts:4-5` and `scripts/verify-live-socket.ts:4-5` both state the reason). `packages/bootstrapped/package.json` renames `build:userscript` → `bundle`; the string at `packages/bootstrapped/tests/build-output.test.ts:58-59` (`or: npm run build:userscript`) changes in the same commit.

---

# 4. What NOT to add

- **`.editorconfig`**: Biome already owns indent/EOL/quotes; a second source of truth will drift.
- **`CONTRIBUTING.md`**: one maintainer, no external PRs; the two non-obvious rules (no Node built-ins in `src`, run `verify` before pushing) belong in a 10-line README "Development" section.
- **`SECURITY.md`**: no disclosure channel exists; the real security content (`mc_jwt` cookie, header limits) is already README "Known limitations" (README:316-319).
- **`CHANGELOG.md`**: nothing is tagged yet and `docs/verification.md` already carries the dated ledger; add at the first tag, generated from commits.
- **`examples/`**: `scripts/verify-socket.ts` becomes the consuming example once it imports `@mg.js/headless`; a separate examples package is a second build to keep green.
- **ESLint + Prettier**: two toolchains and a plugin matrix for a repo with zero lint config; Biome is one devDep and one file.
- **`.nvmrc` / `packageManager`**: CI pins Node 22 and `engines: ">=22"` states the requirement; corepack+npm is not worth the friction.
- **husky / lint-staged / commitlint**: local hooks on a single-maintainer pre-1.0 repo; `ci.yml` is the enforcement point.
- **changesets / semantic-release**: release automation before the first release; `0.1.0` in four manifests is a one-line `npm version --workspaces` problem.
- **Collapsing the three package tsconfigs into a shared `tsconfig.package.json`**: 6 identical lines × 3; the indirection costs more than the duplication, and the real bug is the missing per-package `types`.
- **Typedoc / generated API site**: 66 files with unusually good doc comments; a build to maintain before anyone has asked.
- **A docs TOC generator**: the README link list is 8 lines.

**Ranked top three to add now: 1. `LICENSE`** (zero cost; without it nobody may legally use or contribute) · **2. `.github/workflows/ci.yml`** (the only thing that turns "490 passing tests, tsc exits 0" from a claim into a check, and it is what proves P1 via `npm ci`) · **3. `biome.json` + the `lint` gate** (one devDep, one file, and it makes P2's config work the last time anyone formats by hand).

---

# 5. Migration cost and order

Baseline is green (490/490, exit 0, 276.2 KiB); `npm run verify` takes ~91 s, dominated by tests. Each step ends with `npm run verify`.

**Step 1: Install foundation.** Blocks everything: nothing else is testable until this lands. Add `.npmrc` (`cache=.npm-cache`), regenerate `package-lock.json` via `npm install`, confirm `npm ls --depth=0` is clean and `node_modules/@mg.js/` has three symlinks, then run `npm ci` once to prove the lock. Expect movement, because everything is caret-ranged (`typescript ^5.9.0` → 5.9.3, `@types/node ^24.0.0` → 24.13.4), so the fresh lock may pick newer patch/minor versions; re-run `verify` and pin any offenders in this same commit rather than chasing them later.

**Step 2: Typecheck hole.** Root config + 18 test fixes must land **together**, or `verify` goes red. Add `tsconfig.tests.json`, delete `packages/headless/tsconfig.test.json`, change root `typecheck`, and fix the 18 errors (list in P2) in one commit. The test project must set `allowImportingTsExtensions: true`, must not be composite, and must be invoked with `tsc -p` (not `tsc -b`), because the extension convention is already split: 19 `.ts` imports under `packages/bootstrapped/tests` and 2 under `packages/common/tests` (e.g. `packages/bootstrapped/tests/attach.test.ts:28`, `packages/common/tests/weather.test.ts:25`) vs 19 `.js` under `packages/headless/tests` and 31 under `packages/common/tests`. Normalising those 21 imports to `.js` is a separate later commit and belongs to the src/tests owner. The 18 fixes are in the other agent's files, so route this as one PR.

**Step 3: Formatter, alone.** Add `biome.json` + `@biomejs/biome`, then one `chore: apply biome format` commit. Measured over `packages/*/src`, `packages/*/tests`, `scripts`, `packages/bootstrapped/scripts`: 27,816 lines ≤100 cols, 2,039 at 101-110, 21 >120, max 236; zero tabs, zero CRLF, zero trailing whitespace, single quotes and 2-space indent already dominant. At `lineWidth: 100` the diff is ~2,039 lines; `lineWidth: 110` cuts it to ~156. Land this **before** the docs split and the renames, so neither is confounded, and wire `lint` into `verify` only after this commit.

**Step 4: Docs split, atomic with README edits.** Create `docs/`, move the eight H2 blocks, and in the same commit add the README link list, rewrite README:282-288, and repoint the one internal anchor `README.md:264` (`#sessions-how-a-headless-client-actually-authenticates`), which resolves against README:328 today and dies the moment that section moves. Fix the two pre-existing breakages while in there: README:292 and README:144. Vendor the two HTML sources and hash them, or README:17 stays a pointer into a directory no cloner has.

**Step 5: Script renames and wiring, atomic.** `git mv` the two root scripts plus README:283-288, plus the usage comments at `scripts/verify-live.ts:7` and `scripts/verify-live-socket.ts:7` (both say `node --import tsx` while the npm script uses the `tsx` CLI), plus the two cross-references in `packages/headless/src/auth/guest.ts:44` and `packages/headless/tests/session.test.ts:7`, and those two are the other agent's files, so skipping them reproduces the same rot that broke README:144 and README:292. Rename `build:userscript` → `bundle` and update `build-output.test.ts:58-59`. Add `assert-bundle-size.ts` here, before CI depends on it.

**Step 6: Config and publish surface.** Per-package `types`, `ws` alignment, the `files`/`sideEffects`/`engines`/`publishConfig`/`license` edits, and a `npm pack --dry-run` proof per package (requires Step 1). Keep `private: true` until P4's release decision, but add the metadata now so the eventual flip is one line.

**Step 7: CI last**, because it must be green on its first run. `ci.yml` = `npm ci && npm run verify` on Node 22 + userscript artifact upload; `live.yml` = `workflow_dispatch` + weekly, never gating a PR. This is also the acceptance test for Step 1: if `npm ci` from the regenerated lock fails, P1 was not actually fixed.

**Cross-owner conflicts to route:** the 18 test type errors, the 21 `.ts`→`.js` test-import normalisation, and the two script cross-references all live in `packages/*/src` and `packages/*/tests`, which I do not own. Nothing in my scope can complete P2 or Step 5 without those edits.
