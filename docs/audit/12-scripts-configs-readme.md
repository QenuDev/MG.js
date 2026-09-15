# Audit 12: scripts/, build.ts, package.json, tsconfig, README

Scope: `scripts/{verify-live,verify-live-socket,probe-guest-encoding}.ts`,
`packages/bootstrapped/scripts/build.ts`, root + 3 package `package.json`,
`tsconfig.base.json` / `tsconfig.json` / `packages/*/tsconfig*.json`, `.gitignore`, `README.md`.
Every claim below was checked against the files, and executed where it is a behaviour claim.

---

## F1: `npm run verify` runs the tests *before* the userscript build, so all 16 standalone-artifact assertions silently skip

**Severity: high · category: tests · breaking: no**

`package.json:17`:

```
"verify": "npm run typecheck && npm test && npm run build",
```

The only assertions that prove the userscript is standalone live in
`packages/bootstrapped/tests/build-output.test.ts`, and every one is guarded by a *computed* skip flag
taken at import time: `build-output.test.ts:50` `const built = existsSync(artifactPath)`, then
`{ skip: !built && 'not built yet' }` on all 16 tests (lines 71, 81, 90, 99, 120, 133, 145, 161, 178, 192, 203, 208, 212, 220). The file documents the gap itself at `build-output.test.ts:20-25`:
"`node --test` may be run before `build:userscript`", which is a normal state for a fresh checkout.

`npm test` (line 14) is the second step, while `npm run build`, the step that *creates* the artifact, is
the third. So in the documented verification order the artifact does not exist when the tests run.
Observed, with the artifact moved aside and the file run exactly as `npm test` runs it:

```
# tests 16
# pass 0
# fail 0
# skipped 16          (exit code 0)
```

`verify` still prints success. The WARNING at `build-output.test.ts:51-56` goes to `console.warn`
under `node --test`, so it is swallowed into TAP comment lines (`# [mg.js] WARNING: ...`) that nobody
reads in CI output. The four invariants the repo treats as required for release are therefore not
checked by `npm run verify` at all, only by an ad-hoc `npm run build && npm test`: `0 import / 0
export / 0 require / 0 unbundled @mg.js specifiers` (lines 220-224), banner at byte 0 (line 81), the
grants/run-at (line 99), and "installs itself" (line 192).

**Fix.** Change `package.json:17` to `"verify": "npm run typecheck && npm run build && npm test"` so
the artifact exists before the test step; and in `build-output.test.ts:50`, gate the skip on an
explicit opt-out (`process.env.MG_ALLOW_UNBUILT_TESTS`) so a missing artifact fails by default.

---

## F2: `packages/headless/tsconfig.test.json` is referenced by nothing; no test file in any package is type-checked

**Severity: high · category: correctness · breaking: no**

`packages/headless/tsconfig.test.json` exists, sets `noEmit`/`composite:false` and includes
`["src/**/*.ts", "tests/**/*.ts"]`, and is the *only* config in the repo that includes a `tests/`
glob (`packages/*/tsconfig.json` all say `"include": ["src/**/*.ts"]`). But `tsconfig.json:3-7`
references only the three emit configs, `package.json:13` `"typecheck": "tsc -b --force"` therefore
builds only those, and `grep -rn "tsconfig.test"` over the repo (excluding `node_modules`) returns
**no matches**, not in a script, not in the README, not in any other config.

Verified by injecting a deliberate type error into a test file and running the exact typecheck command
(file restored from backup immediately afterwards):

```
printf '\nconst __probe: number = "definitely-not-a-number";\n' >> packages/common/tests/store.test.ts
./node_modules/.bin/tsc -b --force     → TSC_EXIT=0
```

So the README's claim at `README.md:297`,
`tsc -b --force  exit 0  strict, incl. noUncheckedIndexedAccess + noUnusedLocals`, describes 66 source
files, while the 22 test files that the "490 tests" figure is drawn from (`README.md:298`) are
unchecked. `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals` and `noUnusedParameters`
(`tsconfig.base.json:10-17`) do not apply to any `tests/**` file. A test that indexes an array
without a guard, or that is dead because it references a renamed export, compiles and "passes" until
it is run.

**Fix.** Add `"typecheck:tests": "tsc -b --force packages/common/tsconfig.test.json packages/headless/tsconfig.test.json packages/bootstrapped/tsconfig.test.json"` to `package.json`, add sibling
`tsconfig.test.json` files to `packages/common` and `packages/bootstrapped` matching the headless one
(`noEmit: true, composite: false, types: ["node"], include: ["src/**/*.ts","tests/**/*.ts"]`), and
chain it into `"verify"`.

---

## F3: `verify-live-socket.ts` converts any connection failure into a pass and exit 0

**Severity: high · category: correctness · breaking: no**

`scripts/verify-live-socket.ts:126`:

```ts
if (sawSessionExpired || !client.isReady) {
```

`client.isReady` is false for *every* failure that never reached a `Welcome`, not only the documented
4840 case: a DNS failure, a TLS abort, a proxy refusal, a network-less CI runner, or the script's own
`OVERALL_TIMEOUT_MS` rejection (lines 38-43). All take this branch, which prints three
`report(..., true, ...)` lines ("transport reached the server", "handshake frames were sent", "server
closed with 4840 SessionExpired" at lines 129-138), sets `failures = 0` at line 178, and exits 0 at
line 195. The error is classified at lines 120-124, but the `!client.isReady` fallback at line 126
overrides that classification.

Consequence: the one script whose purpose is to detect transport regressions cannot fail unless a
`Welcome` arrives *and* a later assertion fails, so a total loss of connectivity reports
`LIVE SOCKET CHECK PASSED`.

**Fix.** Change line 126 to `if (sawSessionExpired)` alone, and assert the transport claim with
`report('transport reached the server', client.stats.stopped !== undefined || sawSessionExpired, ...)`
instead of passing `true`; when neither holds, fall through to the `failures += 1` branch at line 180.

---

## F4: `probe-guest-encoding.ts` ends with an unconditional `process.exit(0)`, so a failing probe reports success to the shell

**Severity: medium · category: correctness · breaking: no**

`scripts/probe-guest-encoding.ts:147-155` computes `anyWelcome`, prints either "a Welcome was
received" or "no variant produced a Welcome", then calls `process.exit(0)` regardless: `anyWelcome` is
used only to choose a string. The same file treats a per-attempt failure as `-1` at line 115
(`ws.on('error', () => finish(-1))`) and a timeout as `null` at line 84, so the information needed for
a real exit code is already in `results`.

This is not a defence of the negative result: that result is legitimate and `README.md:307` documents
it. The defect is that exit 0 makes the two outcomes indistinguishable to a script or a `&&` chain,
which matters because the script is listed in the README verification block as if it were a check. It
is also the only one of the three `scripts/*.ts` files that never sets `process.exitCode`.

**Fix.** Exit non-zero when the probe could not reach a verdict, matching the other two scripts
(`verify-live.ts:124`, `verify-live-socket.ts:195`):

```ts
const transportReached = results.some((r) => r.opened);
process.exitCode = transportReached ? 0 : 1;   // 0 only if the server actually answered
```

---

## F5: `ws` is declared three ways at two different version ranges, and two of the declarations contradict the code's own comment

**Severity: medium · category: consistency · breaking: no**

`packages/headless/package.json:31-41` declares `ws` as **both** `optionalDependencies` and
`peerDependencies`, each `"^8.19.0"`, with `peerDependenciesMeta.ws.optional: true`, which is redundant
once the package is already an optionalDependency: npm resolves it from `optionalDependencies` and the
peer range is never the authority. Root `package.json:25-26` devDepends on `"ws": "^8.18.0"`, a
different minor floor; the lockfile hoists one `node_modules/ws` at `8.21.3`, so nothing breaks today,
but two ranges for one package in one workspace is a silent-divergence hazard.

The declarations also contradict the source. `packages/headless/src/transport/runtime.ts:9-11` says
the package "has **zero runtime dependencies**", with `ws` a devDependency used only by the test mock
server. `runtime.ts:33-37` explains `loadWebSocketAdapter` is a try/catch dynamic import. But
`ws` is a devDependency of the *root* only, and `packages/headless/package.json` has no
`devDependencies` block, so the mock server's `import 'ws'` works only because npm hoists a root
devDependency into the workspace's resolution path. The package declares neither what its own tests
need nor the absence of the runtime dependency it claims not to have.

**Fix.** In `packages/headless/package.json`, drop `optionalDependencies` and keep one source of truth:
`"peerDependencies": { "ws": "^8.19.0" }, "peerDependenciesMeta": { "ws": { "optional": true } }, "devDependencies": { "ws": "^8.19.0", "@types/ws": "^8.5.13" }`; align the root `package.json` devDependency
to `"^8.19.0"` so one range governs the workspace.

---

## Lower-severity observations (not counted as findings)

- **`README.md:299` build stats are stale.** It claims `magicgarden.user.js, 276.2 KiB (282,800 B)`;
  a fresh `tsx packages/bootstrapped/scripts/build.ts` on the clean tree (`git diff --stat HEAD --
  packages scripts` empty) emits **283,362 B (276.7 KiB)**, per `build.ts:148`, so the README figure
  is off by 562 bytes. "12 @-keys" undercounts too: 12 `// @` lines but 13 keys, because
  `@description` wraps (`build.ts:81`).
- **`package.json:12` `"build:userscript"` is a pass-through** duplicating
  `packages/bootstrapped/package.json:20`; `package.json:11` already invokes the same command with
  `-w`. Two names for one action.
- **`.gitignore`/secrets: clean.** Covers `node_modules/`, `dist/`, `*.tsbuildinfo`, `*.log`,
  `.npm-cache`; no `.env`-style file exists. `MC_JWT` is never taken via `argv`, echoed, or logged:
  only README samples (`README.md:91,106`) and `room-socket.ts:87` mention it, and
  `packages/headless/src/auth/cookie.ts:88-93` renders it `mc_jwt present (N chars)`. Nothing here is
  destructive or state-changing.
- **`README.md:7` says "all 71 actions" while `README.md:425` says "the 72-method typed surface".**
  `actions.ts:4` settles it ("72 methods covering all 71 distinct wire strings"), so line 7 is wrong.
- **`tsconfig.base.json` omits `noImplicitReturns`, `noUncheckedSideEffectImports` and
  `allowUnreachableCode: false`**, and leaves `"exactOptionalPropertyTypes": false` unexplained. Not a
  rule violation; noted only because the config otherwise reads as a maximal strictness set.

## What works well here

- `packages/bootstrapped/scripts/build.ts` gets the easy-to-miss parts right: the Tampermonkey block
  is a `banner` (build.ts:129), not a post-hoc prepend, so it cannot drift below leading output;
  `format: 'iife'` + `platform: 'browser'` + `sourcemap: false` (119-128) are each justified in-file
  against the userscript's execution model; and the version is read from `package.json` (95-103).
- The build is **deterministic** (two runs, byte-identical MD5 `7fec3deb3c0aa88fb45b6dfa48dc2f15`) and
  `result.errors` is re-checked and thrown at `build.ts:136-139`, not trusted to esbuild's exit path.
- `build-output.test.ts` is a strong artifact test where it runs: banner position, the grants,
  absence of `import`/`export`/`require`/dynamic `import(`/`node:` specifiers (lines 120-161), *and*
  positive controls that the bundle contains real implementation (`__mgjs`, `__PIXI_APP_INIT__`,
  `MagicCircle_RoomConnection`, `QuinoaCommand`, `__mgjsWrapped`, at lines 161-177).
- All three `scripts/*.ts` distinguish themselves from the test suite correctly (docstrings at
  `verify-live.ts:5-7`, `verify-live-socket.ts:4-5`), are documented as opt-in in `README.md:282-288`,
  and none is destructive. `verify-live.ts:71-77` also tolerates legitimately-null live data rather
  than asserting on a value the server is free not to send.
- The `@mg.js/common` direction holds in the config layer: `packages/*/tsconfig.json` reference
  `../common`, and `tsconfig.json:3-7` is a pure solution file (`"files": []`), so common ← headless
  and common ← bootstrapped are enforced by project references, not convention.
