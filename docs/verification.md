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




---

## 2026-10-19: build 1650, and the data the packages ship

The game moved to build 1650. The art extractor, the state model and the action surface were brought to it,
and the shipped artefacts were regenerated rather than hand-edited.

```
npm run verify            exit 0
  lint                     323 files, no diagnostics
  tsc -b + tests tsconfig  exit 0
  tests                    1,237 / 0 fail
                           art 228 · bootstrapped 238 · common 566 · headless 205
  art:sync --check         1650 current (offline; fixture reproduces the committed data)
  docs:check               866 symbols, 46 modules
npm run verify:catalog    ALL LIVE CHECKS PASSED (11/11 shops, weather, restock)
```

What is committed for 1650:

- `packages/art/data/1650.json` and `packages/art/fixtures/bundle-1650/`
- 724 sprite names, 73 plants, 125 display flags, 23 anchors, 11 mutations, 7 item kinds, 4 tile kinds
- the 1650 z-ladder on each mutation art record (`zIndex`, `tallPlantZIndex`), with Hydro at 2/-1 and Lunar at 4/4
- 108 wire strings / 109 methods, including the 1650 `MoveItem`/`LogItem` pair, the quest/NPC/capsule/credits
  commands, and `PlaceCrystal`'s tool-item payload (`{itemType:"Tool", toolId}` or `{itemType:"Tool", itemId}`)

The protocol guide under `docs/sources/` is untouched. The vendored API reference was updated to the 1650
surface (its `GameActions` table now mirrors the library's 108 wire strings / 109 methods), and
`docs/provenance.md` records both the new hash and the original vendored hash so the rewrite is auditable.

---

## 2026-10-20: 0.2.2 — the attach path, identity, and reconnects

The reported symptom was `mg-crop-match` saying `waiting for your garden` while the garden was already in the
tree. Three independent causes were reproduced against the published 0.2.0 packages; 0.2.1 shipped those
fixes, and 0.2.2 adds the host-reconnect fix described below.

```
npm run verify            exit 0
  lint                     323 files, no diagnostics
  tsc -b + tests tsconfig  exit 0
  tests                    1,248 / 0 fail
                           art 228 · bootstrapped 244 · common 571 · headless 205
  art:sync --check         1650 current (offline; fixture reproduces the committed data)
  docs:check               865 symbols, 46 modules
```

**1. The room Welcome was consumed before the transport could see it.** Build 1650's
`subscribeToWelcome` replays the publication synchronously, inside `bindRoomConnection`'s eager subscription.
`sawWelcome` became true while `welcomeHandlers` was empty, and the transport's later `sink().onWelcome` only
added a handler. The patch-path stand-in was gated on `!sawWelcome`, so no Welcome ever reached `ClientCore`:
the store stayed empty and `isReady` stayed false. The sink now replays the retained state to a late
subscriber, and the stand-in carries the real Welcome's `publishedAtServerMs` and the publication's frontier.

**2. The raw socket's replay carried `state: null`.** A Welcome frame that arrived in the gap between binding
the socket and attaching the transport was replayed with an id and a frontier but no snapshot, and
`ClientCore` answered it by replacing the root with an empty tree. `ScrapeResult` now retains the Welcome's
`fullState` and `publishedAtServerMs`, so the replay seeds the same state the frame carried.

**3. `selfPlayerId` never reached `StateReader`.** The reader's `self` reads its own `selfPlayerId` field, and
only `ClientCore.handleWelcome` assigned it. `client.selfPlayerId` had a read-time fallback, so a live session
could print a valid id in the badge and still read `state.self === null` all session. `ClientCore.adoptSelfPlayerId`
now writes both fields, `BootstrappedClient.syncSelfPlayerId` calls it on every `selfPlayerId`/`state` read, and
both paths are gated on `ClientCore.isClosed` so a retained seam cannot resurrect a dead session.

Identity sources are now, in order: the core's Welcome, the raw-socket seam (including the initial raw-socket
attachment, not only the post-upgrade one), and `__jotaiStore`'s `playerIdAtom`. The upgrade watch now passes
the resolver to the binding it creates. `JotaiBridge` adopts the supplied store at install and on every retry
tick and uses `jotaiAtomCache` only as the label-to-atom registry; it patches no atom `read` and no atom
`write`.

**Slot join.** `slotIndexFor` now accepts an index-aligned `userSlots` entry that carries no id at all. It still
searches every slot for a real match and never assumes a slot that names a different player.

**Reconnects.** A host socket that was replaced used to leave the core closed forever: the transport reported
the replacement as a fresh `open`, but `ClientCore`'s close latch was permanent, so the new `Welcome` was
dropped. The latch now clears on `open` for `transport.kind === 'attached'` only, never after `stop()`, and
the next `Welcome` replaces the store root and identity on the same core. A frame that arrives before the
one-second readiness poll produces the `open` edge itself, so a reconnect cannot lose its Welcome in that
gap. `standalone` transports keep the old terminal close. `ClientCore` emits `reopened` before the new
`open`, `client.report` gains `closed` and `reopens`, and the page namespace emits `reopened` with the core
report.

**Packaging.** `@mg.js/bootstrapped` and `@mg.js/headless` declared `"@mg.js/common": "^0.1.0"`, which excludes
0.2.x; a normal install of 0.2.0 therefore resolved common 0.1.6. Both now require `^0.2.2`, and
`MG_VERSION` (the value reports and the page namespace stamp) is 0.2.2 rather than the 0.1.0 literal it had
carried since the first release.

The vendored protocol guide and API reference are unchanged by this release: no wire message, action or game
data changed, and `docs/api-surface.json` matches its 865 symbols (the removed pre-1604 atom-write helper is
the one symbol fewer).

