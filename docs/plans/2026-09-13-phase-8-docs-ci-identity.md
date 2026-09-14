# Phase 8: Docs, CI, release identity

Master plan's four tasks, verbatim from the phase table. Written from measurement at the boundary (Phases 0 to 7
complete; `npm run verify` **904 tests / 0 fail / 0 skipped**; bundle 325,179 B; both live checks pass).

Unlike Phases 6 and 7, this phase changes almost no behaviour: it is the phase where the *repository's claims
about itself* get audited. That makes the failure mode different and worth naming up front: a wrong edit here
does not break a test, it ships a URL that 404s, an install instruction that cannot work, or a CI job that
tests a different Node than the one the code requires. So every task below states the **evidence** it is
allowed to rest on, and the acceptance is something a reader can check rather than something a test proves.

## What is measured today

| Fact | Value | Where |
|---|---|---|
| Root package name / version / engines | `mgjs`, `0.1.0`, `node >=20` | `package.json` |
| Package names / versions | `@mg.js/{common,headless,bootstrapped}`, all `0.1.0` | `packages/*/package.json` |
| Already aligned? | **yes**: all four are `0.1.0`, so 8.4's "align the four" is already true and must be *verified*, not changed |  |
| `license` | `MIT` at the root only; absent from all three packages | `package.json` |
| `repository` | **absent everywhere** |  |
| `files` | `["dist"]` in each package; no root `files`, no `sideEffects` | `packages/*/package.json` |
| `private` | `true` everywhere, which is correct, and 8.3 keeps it |  |
| `ws` | **two versions**: root devDependency `^8.18.0`, headless peerDependency **and** devDependency `^8.19.0` | `package.json`, `packages/headless/package.json` |
| `DOWNLOAD_URL` | `https://github.com/magicgarden-js/mg.js/releases/latest/download/magicgarden.user.js`: the owner is not this repo's, and the release does not exist | `scripts/build.ts:58` |
| `@namespace` | `https://magicgarden.js/` | `scripts/build.ts:80` |
| The real repo | `QenuDev/MG.js`, private, **no releases** | stated by the master plan; not verifiable from inside the repo |

## Task 8.1: the docs split

**The deliverable.** `README.md` down to ≈150 lines, with the depth moved to
`docs/{protocol,attachment,sessions,close-codes,announcements,verification,provenance}.md`, and the two protocol
HTML sources vendored under `docs/sources/` with their SHA-256 recorded.

**Steps.**

1. **Inventory before moving anything.** Map each README section to its destination and check for a reader who
   would be stranded: the README's own cross-references, `docs/DESIGN.md`'s links, source comments that say
   "see the README", and any test that asserts on README text (`integration/build-output.test.ts` asserts on the
   *bundle banner*, not the README, so verify that rather than assume it).
2. **Move, then trim, in that order.** A section that moves keeps its wording; only afterwards is the README's
   remainder rewritten to be a front door (what the package is, install, quick start, where the depth lives).
   Doing it the other way round loses text that nobody notices is gone.
3. **Every link must resolve.** That is this task's acceptance, and the two known-broken references are
   already recorded in DESIGN: `README.md:144` (the `window.__mgjs` promise, **already corrected in 7.2**) and
   the old `:292` mock-server citation (**corrected in 5.8**). So the known list is now empty and the acceptance
   is a fresh link check across the README and the new docs.
4. **Vendor the two protocol HTML files with a SHA-256 each.** They currently live outside the repo; a hash
   without the file is not evidence, and a file without a hash cannot be checked. `docs/provenance.md` records
   where each came from, and the hash must be of the committed bytes.
5. **State the install reality plainly**, which is 8.3's point arriving in the docs: the repo is private, has no
   releases, and Tampermonkey's unauthenticated update check cannot read a release asset, so **there is no
   auto-update path today**. The README must say that rather than imply an install that does not exist.

**Risk.** This is the largest text move in the programme and the only one no test can fail on. Mitigation is
mechanical: move whole sections, keep every heading as a heading, and finish with a link check plus a
`git diff --stat` that shows the total line count is conserved apart from deliberate cuts.

## Task 8.2: CI

**Deliverable.** `.github/workflows/ci.yml` = `npm ci && npm run verify` on Node 22, uploading the built
userscript as an artifact; `.github/workflows/live.yml` = the live checks, `workflow_dispatch` plus a weekly
schedule, never on push.

**Steps.**

1. Write `ci.yml` with two things the master plan calls out: **Node 22** (and 8.4 raises `engines` to match, so
   the two must agree, because a CI running a Node the package does not claim is a green light for an unsupported
   configuration), and `npm ci` rather than `npm install`, which is also the proof that Task 0.1's lockfile work
   holds.
2. Upload `packages/bootstrapped/dist/magicgarden.user.js` as an artifact, so a run's output is inspectable
   without reproducing the build.
3. Write `live.yml` as manual + scheduled **only**. The live checks reach the real service; a push-triggered
   network dependency would make every commit's status depend on someone else's uptime.
4. **Validation honesty:** neither workflow can be executed here. What *can* be checked locally is that the
   YAML parses, that `npm ci` succeeds against the committed lockfile, and that `npm run verify` is what CI
   runs, so there is no second definition of the gate. The "first run green" acceptance is therefore **owed
   to the first push**, and this plan says so rather than claiming it.

## Task 8.3: make the metadata honest, still with no release

**Deliverable.** `build.ts`'s `DOWNLOAD_URL` and the userscript `@namespace` point at the real repository; each
package gains `repository`, `license`, `engines`, `sideEffects` and a `files` list that ships source and excludes
build metadata; `private: true` stays; no `publishConfig`.

**Steps.**

1. **Decide what the banner should say when there is no release to point at.** Today's `DOWNLOAD_URL` is a
   404-shaped lie in a file users read. Two honest options: point at the real repository's releases path (which
   will 404 until a release exists, but names the right owner and becomes correct the day one is cut), or omit
   the update directive entirely until distribution is real. The second is the more honest *today*; the first is
   the one that needs no second change later. Choose one explicitly and record the choice and its consequence in
   the commit body. Leaving it implicit is what produced the current value.
2. Add the metadata fields per package, keeping versions aligned at `0.1.0` (already true) and `private: true`.
3. `files: ["dist", "src", "!dist/.tsbuildinfo"]` as the master plan specifies, then **prove it with
   `npm pack --dry-run`**: the tarball must contain no `.tsbuildinfo` and must not contain the userscript.
4. `sideEffects` is a real claim about the bundle, not a formality. `false` is wrong for
   `@mg.js/bootstrapped`, whose entry has top-level side effects by design (that is what `entry/main.ts`
   is for). So the value must be established per package rather than copied.

## Task 8.4: naming

**Deliverable.** Root `name: mg.js`; `engines: >=22` (matching CI); `ws` declared once at one version.

**Steps.**

1. Root `name` → `mg.js` (today `mgjs`). Check what reads it: the lockfile records workspace names, and
   `scripts/` may print it. `npm ls` afterwards is the check.
2. `engines.node` → `>=22`, which must equal CI's Node version and the `@types/node` major's expectation. Three
   places can disagree here and only one of them is the source of truth. Name it in the commit body.
3. `ws`: root devDependency `^8.18.0` vs headless `^8.19.0` (peer **and** dev). One version, one place. The
   peer range stays the *declared* contract; the dev/root copy is what the tests install, and they must agree or
   the mock server tests exercise a version no consumer is promised.
4. **Verify the alignment claim rather than assuming it**: all four packages are already `0.1.0`, so 8.4's
   "align the four `0.1.0`s" is satisfied and the task is to keep it that way as 8.3 adds fields.

## Also owed to this phase

**Audit 11 §2** (`docs/audit/11-bootstrapped-client-userscript.md:55`): *"A failed `install()` leaves the client
claiming to be installed, and `uninstall()` itself throws (high)"*. **Landed, and the finding turned
out to be mostly stale.** Reading `start()` end to end showed the two claims it makes are both false today:

- `uninstall()` throwing was already fixed: `stop()` uses `getPage()`, and Phase 7's 7.2 removed the namespace
  clobber that made it throw at all.
- "Claiming to be installed" is false: `installed = true` is set only at the *end* of `start()`, so after a
  failed start `isInstalled` and `report.started` both read false, and `stop()` releases on `ownsClaim` rather
  than on `installed`.

The real defect is one the audit did not name, and it is worse than a one-off leak: `ownsClaim` and
`claimInstall(page)` run **before** every fallible step, and `start()`'s re-entry guard is
`if (this.installed) return` with `installed` still false, so a retry **claims a second time** while `stop()`
releases exactly one. N failed starts leave N-1 claims and the namespace outlives the client. `start()` now
spans its fallible range in a `try` and gives the claim back on the way out, through a `releaseClaim()` that
`stop()` shares so the refcount policy has one home. The test injects a logger whose first `info()` throws,
a deterministic failure *after* the claim exists without needing a hostile page, and asserts the refcount
is zero after the failed start, then one after a retry, then that a stop removes the namespace. The refcount
assertion was red before the fix.

## Acceptance mapping

| Task | Verified how |
|---|---|
| 8.1 | Every link in the README and the new docs resolves; the two protocol HTML files are committed with SHA-256s that match their bytes; the README states the private-repo/no-release reality. |
| 8.2 | YAML parses; `npm ci` succeeds locally against the lockfile; `npm run verify` is the gate CI runs. **"First run green" is owed to the first push**, and is stated as owed rather than claimed. |
| 8.3 | `npm pack --dry-run` ships no `.tsbuildinfo` and no userscript; every URL in the banner resolves to the real repository; `sideEffects` is established per package. |
| 8.4 | `npm ls` is clean and shows one `ws` version; `engines`, CI's Node and the types agree; the four versions are still `0.1.0`. |
| Phase gate | `npm run verify` exit 0 per commit, plus both live checks at the boundary. |

## Risk / revert

The riskiest item is **8.1**, a text move nothing can test, and the mitigation is the order: move whole
sections first, trim afterwards, then check links. **8.3's banner decision** is the one that can mislead users,
so the plan requires the choice and its consequence to be recorded instead of defaulted. **8.4's
`engines`** can silently invalidate CI if the three places disagree. Everything here reverts in one commit, and
none of it touches runtime behaviour except 8.3's banner and the audit-11 §2 fix.

---

## Closure

Closed at the boundary. Every figure below was re-measured at the boundary from the committed tree, not copied
from a task's own report, and the two acceptance lines that cannot be met here are recorded as owed.

**Boundary evidence.** `npm run verify` at the boundary commit, plus both live checks:

```
lint              exit 0   203 files checked, no diagnostics
typecheck         exit 0   tsc -b --force, then tsconfig.tests.json (src and tests)
build             exit 0
test              exit 0   905 tests, 0 fail, 0 skipped (bootstrapped 268 · common 438 · headless 199)
size              exit 0   bundle 323039 B (315.5 KiB), +8616 B vs the 314423 B baseline
verify:catalog    exit 0   11/11 PASS, version 1169: shops, weather, restock countdown all shaped
verify:socket     exit 0   built the URL, resolved version 1169 live, handshook, then the documented
                           4840 SessionExpired after 1135 ms
```

**Acceptance mapping, with how each line was actually checked:**

| Task | Commit | Acceptance, and the check |
|---|---|---|
| 8.1 | | Every link resolves: 12 relative links across 9 files, 0 unresolved, checked independently twice; both HTML sources committed with `sha256sum` matching the recorded hashes; README:78 states the private-repo/no-release reality |
| 8.2 | | Workflow parses; `npm ci` and `npm run verify` are what it runs, so the gate has one definition; the artifact step carries `if-no-files-found: error`; Node 22 on both jobs |
| 8.3 | | `npm pack --dry-run` in all three packages ships no `.tsbuildinfo` and no userscript; the banner's `@namespace`/`@downloadURL`/`@updateURL` all name `QenuDev/MG.js`; `sideEffects` set per package |
| 8.4 | | `npm ls ws` shows one version (`8.21.3`, deduped); all four packages state `engines.node >=22`, matching CI and the types; the four versions are still `0.1.0` |
| audit 11 §2 | | The refcount assertion was red before the fix and green after; the finding's own two claims were stale |

**Acceptance lines NOT met, recorded rather than papered over:**

1. **"First CI run green" is owed to the first push.** This repository has no remote, so `ci.yml` has never
   executed anywhere. What is verified locally is that `npm ci` resolves against the lockfile and that
   `npm run verify`, the exact command the workflow runs, exits 0. "CI is green" is not claimed.
2. **A working install/auto-update path is owed to a public release.** Tampermonkey's update check cannot
   authenticate, so no release asset can be fetched from a private repo. 8.3's deliverable was therefore
   *honest* metadata: the banner points at the real repo, and the README says the auto-update path does not
   exist instead of implying one.

**Corrections this phase produced.** Each came from re-measuring a claim rather than reading a report:

- **C1: the 71-vs-72 action count (audit 12's surviving README finding).** The split carried the
  contradiction into the new front door. Ground truth: 71 distinct `wire:` entries
  (`packages/common/tests/forms.test.ts:41`), split 9 room / 15 flat / 47 wrapped (`:47`), 72 methods
  (`:142`), the 72nd being `fuseCrystal`, which emits `PlaceCrystal` with a merge intent rather than
  owning a wire string. README:7 and README:147 now state the distinction once; `docs/protocol.md` is
  its home.
- **C2: a dead path inside a faithfully moved section.** `docs/protocol.md` named `protocol/forms.ts`,
  which Phase 5 renamed to `actions/registry.ts`. The conservation sweep reproduced its source exactly;
 the source was already wrong. Fixed.
- **C3: three stale `DESIGN` §8 statements:** the README line count (432, and it was 456 by then), the
  claim that the vendored sources "currently live outside the repo" (the copies do not; only the
  originals do, and `provenance.md` now says exactly that), and a forward reference to "Task 8.1's README
 split" for render documentation that has now landed. Fixed.
- **C4: audit 11 §2 was mostly stale, and the real defect was worse than the one it named.** Its two
  claims, that `uninstall()` throws and that a failed `install()` leaves the client claiming to be
  installed, are both false today; `installed = true` is set only at the *end* of `start()`. The defect it
  missed is that `start()` claimed the namespace before every fallible step while its re-entry guard read
  `installed`, so a retry claimed a **second** time while `stop()` released one: N failed starts left N-1
  claims and the namespace outlived the client. The fix spans the fallible range in a
  `try` and gives the claim back through the `releaseClaim()` that `stop()` shares.
- **C5: conservation had to be argued mechanically.** 442 of 456 pre-split README lines survive verbatim;
  the 14 that do not are 10 deliberate rewrites of lines that had become false, plus 4 identical `---` rules
  the multiset match attributed arbitrarily. Established by fingerprinting the pre-split README
  (`.logs/readme-pre-*.txt`) and searching for phrases, not by reading a diff.

**Docs debt left in place, and why:**

- 25 `README.md:NNN` citations survive in `docs/audit/*` and `docs/plans/*`. Those are dated records, and a
  citation into a README that has since been rewritten is a historical statement; rewriting them would
  falsify the record. `docs/DESIGN.md` has none.
- `DESIGN` §4.2's structural targets are partly unmet: the `attach/upgrade.ts`, `coexistence/outbound.ts`
  and class-body splits. They are recorded in DESIGN and the ledger as their own plan, not as Phase 8 work.
