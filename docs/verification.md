# Verification

```bash
npm run verify            # lint + typecheck(src and tests) + build + all tests + bundle size
npm run test:common       # pure-core unit tests
npm run test:headless     # headless client against a real ws mock server
npm run test:bootstrapped # in-page client, incl. the built userscript's own properties
npm run verify:catalog    # opt-in: exercises the catalogue layer against magicgarden.gg
npm run verify:socket      # opt-in: a real socket against the live game server (needs a build)
npm run probe:guest       # opt-in: are all 5 guest encodings still refused?
```

Unit tests cover the pure core: every wire string and its form classification, envelope shape per form, both sequencer strategies including forward-jump and backward-heal, RFC 6902 application including the `/child` contradiction and the documented create-missing behaviour, connect-URL JSON-encoding value by value, the verified 18-code close table, and catalogue merging.

`@mg.js/headless` is exercised end to end against a **real `ws` server** (`packages/headless/tests/fixtures/mock-server.ts`): a real TCP connection, a real RFC 6455 handshake, real text frames, real JSON-Patch batches. That matters because the two things most likely to be wrong are whether the handshake frames can legally be sent before `Welcome`, and whether the close/`analyzeClose`/backoff path actually reconnects. Those two are precisely what a mocked transport would not catch.

As of the run recorded at the previous release. It is kept as history, **not** as the current numbers; the
entry at the foot of this file is the current one:

```
npm run lint       exit 0     biome, 108 files, no diagnostics
tsc -b --force     exit 0     strict, incl. noUncheckedIndexedAccess + noUnusedLocals
tsc -p tsconfig.tests.json
                   exit 0     the same strictness applied to every test file and script
500 tests / 0 fail                common 284 · headless 103 · bootstrapped 113, 0 skipped
npm run build      exit 0     -> magicgarden.user.js, 277.8 KiB (284,467 B)
                                    banner at byte 0, 12 @-keys,
                                    0 import / 0 export / 0 require / 0 unbundled @mg.js specifiers,
                                    installs itself, logs, renders a badge
npm run size       exit 0     fail >600 KiB, warn >500 KiB, fail <75 KiB (a stub)
verify:catalog         ALL PASSED catalogue layer vs the live game API
verify:socket          PASSED     real socket vs the live game server (observed 4840 on v1166)
probe:guest            negative   all 5 guest encodings rejected 4840 on v1166
```

The three opt-in scripts need the internet, so by design they are **not** part of `npm run verify`: a
test that needs the internet is a flaky test. They are also allowed to fail: each classifies what it
measured and exits non-zero for anything that is not the documented outcome (0 = documented behaviour
observed, 1 = unexpected server behaviour, 2 = could not connect).

---

## 2026-09-14: the Phase 8 boundary

Docs-only change; no source file was touched. The whole gate, plus both opt-in live checks, re-run at the
boundary commit:

```
npm run lint       exit 0     biome, 203 files checked, no diagnostics
tsc -b --force     exit 0     strict, incl. noUncheckedIndexedAccess + noUnusedLocals
tsc -p tsconfig.tests.json
                   exit 0     the same strictness applied to every test file and script
905 tests / 0 fail                bootstrapped 268 · common 438 · headless 199, 0 skipped
npm run build      exit 0     -> magicgarden.user.js, 315.5 KiB (323039 B)
npm run size       exit 0     within budget (fail >600 KiB, warn >500 KiB)
verify:catalog     exit 0     11/11 PASS, version 1169
verify:socket      exit 0     LIVE SOCKET CHECK PASSED, the documented 4840 SessionExpired
```

The counts in the entry above are lower and its version is older; that entry is the run recorded at the
previous release, and this one was current at the time it was written.

## 2026-09-14: after the userscript extraction

The userscript left the repository, and its bundle, banner and size budget went with it: `npm run
build` is now `tsc -b` alone and `npm run size` no longer exists here. So the `magicgarden.user.js` and
`npm run size` lines above describe a gate this repository no longer runs, and the "one current number"
claim they end with is superseded by this entry.

```
npm run lint       exit 0     biome, 195 files checked, no diagnostics
tsc -b --force     exit 0     strict, incl. noUncheckedIndexedAccess + noUnusedLocals
tsc -p tsconfig.tests.json
                   exit 0     the same strictness applied to every test file and script
878 tests / 0 fail             0 skipped
npm ci --dry-run   exit 0     the lockfile moved with the dependency removals
```

**The 30 fewer tests are not a loss.** Five were the application's own, and twenty-five were in
`bundle-budget.test.ts` and `integration/build-output.test.ts`, tests of the userscript artifact, which now
run in `bootstrapped-example` next to the bundle they measure.

---

## 2026-09-14: the packages became publishable

Metadata and prose only; no source file was touched, and `docs:check` confirms the API surface did not move.
The three packages dropped `private: true`, gained `publishConfig.access: "public"` and a `prepack` that runs
`tsc -b`, gained a README each, and `headless`/`bootstrapped` moved their `@mg.js/common` dependency from the
exact pin `0.1.0` to `^0.1.0`. The whole gate re-run:

```
npm run lint       exit 0     biome, 200 files checked, no diagnostics
tsc -b --force     exit 0     strict, incl. noUncheckedIndexedAccess + noUnusedLocals
tsc -p tsconfig.tests.json
                   exit 0     the same strictness applied to every test file and script
878 tests / 0 fail             common 441 · headless 199 · bootstrapped 238, 0 skipped
npm run build      exit 0     tsc -b, three package builds
npm run docs:check exit 0     593 symbols, 36 modules, unmoved, as a metadata change should leave it
```

`npm pack --dry-run -w <package>` matters more than the gate here, because it is the only check that exercises
`prepack` and the `files` list together:

```
@mg.js/common        197 files   232.5 kB packed / 1.0 MB unpacked     0 .tsbuildinfo   39 src/
@mg.js/headless       97 files   158.8 kB packed / 648.8 kB unpacked   0 .tsbuildinfo   19 src/
@mg.js/bootstrapped  227 files   345.4 kB packed / 1.4 MB unpacked     0 .tsbuildinfo   45 src/
```

Two of those columns were assumptions until this run and are measurements after it: that `prepack` fires on
`npm pack` and therefore on `npm publish`, so a stale `dist/` cannot ship; and that `!dist/.tsbuildinfo` really
excludes the file from the tarball. The README needs no `files` entry: npm always includes it.

**Nothing is on the registry yet, and the gate cannot say otherwise.** Publishing needs an authenticated
publisher, so the first upload is a manual one and is not recorded here. `docs/DESIGN.md` records the
distribution decision as D13; D12 was about a userscript this repository does not build, and it now says so.

---

## 2026-09-14: the first publication, and a consumer that proves it

0.1.0 of all three packages is on the public registry under `@mg.js`. The first upload of a package cannot come
from `.github/workflows/release.yml`: a trusted publisher is configured in a package's settings page on
npmjs.com, and there is no settings page until the package exists.

What matters is not the registry saying yes but a consumer with no access to this repository.
`bootstrapped-example` moved its two dependencies from `file:../mg.js/packages/...` to `^0.1.0` and, with no
sibling checkout on the path, installed and verified:

```
rm -rf node_modules && npm ci     exit 0     11 packages, all from the registry
npm run verify                    exit 0     5 tests, 0 fail
                                             bundle 318.9 KiB, within budget
npm ls @mg.js/common              deduped    one copy, not two
node_modules/@mg.js/*             real directories, not symlinks into this repository
```

**One trap is worth writing down: changing `file:` to a range in `package.json` is not enough.** `npm install`
updated the declared spec and kept the symlinks, because the linked package's own version (0.1.0) already
satisfied `^0.1.0`, so the tree was valid and npm had no reason to re-resolve. `package.json` looked right,
the lockfile's root dependencies looked right, and `npm ci` would still have failed on a runner looking
for `../mg.js/packages/bootstrapped`. Deleting `package-lock.json` as well as `node_modules`, and then
reinstalling, is what records `https://registry.npmjs.org/...` and drops `link: true`. A check that reads
`package.json` cannot see this; only the lockfile's `resolved` fields can.


