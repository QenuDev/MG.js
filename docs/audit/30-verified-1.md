# Adversarial verification: findings batch 1

Every line below was opened by me in this session. Probes were run with `node --import tsx` against the
real sources (`/tmp/pp.mts`, `/tmp/re2.mts`, `/tmp/re3.mts`) and against the real test runner.

---

## 1. Prototype pollution through the create-missing container walk: CONFIRMED (critical)

Opened: `packages/common/src/state/patch.ts:154-187` (the `ensureContainer` object branch is 175-183),
`patch.ts:198-211`, `patch.ts:228-261`, `packages/common/src/state/pointer.ts:85`.

What is true: the object branch reads `record[token]` (patch.ts:177) and writes `record[token] = slot`
(patch.ts:180) with no own-property guard, while `pointer.ts:85` does guard with `hasOwnProperty`.
`Object.prototype.__proto__` is an accessor, so `record['__proto__']` is the prototype, which *is* an
object, so the code descends into it and executes `record[token] = {}` with token `pwned` at line 180.
Measured with `{op:'add',path:'/__proto__/pwned/inner',value:1}` on a plain `{}`:
`applied 0 failed 1` (`Parent path "/__proto__/pwned" does not exist.`) yet `Object.prototype.pwned = {}`
and `for (const x in {})` yields `["pwned"]`. Realm-wide, enumerable, on a patch the library reports as
failed. That is the worst possible signalling. Line numbers in the original evidence (177-180 → correct;
"365-366" for deepClone → wrong, see below).

Correction to the finding: the deepClone half is overstated. `deepClone` (patch.ts:361-369) uses
`out[key] = ...` at 366, which for a `__proto__` key sets the *clone's* prototype, as measured:
`deepClone(JSON.parse('{"__proto__":{"x":1},"a":2}'))` gives own keys `['a']` and prototype `{x:1}`,
with `Object.prototype.x === undefined`. That is a *lost key* on a `__proto__`-named field, not
pollution; the server's JSON never carries one. Fixing line 180 fixes the finding; hardening deepClone
is optional correctness polish, not part of the vulnerability.

## 2. WorldScene layer containers created permanently invisible: CONFIRMED (critical)

Opened: `packages/bootstrapped/src/render/world.ts:453-499` (`container.visible = false` at 480),
`world.ts:369-406` (`layer.container.addChild?.(sprite)` at 399), `world.ts:527-537`.

What is true: `buildLayers` sets `container.visible = false` at 480 outside any restore record, and
`addSprite` adds every sprite into exactly that container (399). Repo-wide `grep -rn "visible"` over
`packages/bootstrapped/{src,tests}` and over `dist` finds no `visible = true`, no `setLayerVisible`,
no unhide path, and the only other writers are the recorded hides at 535 and 607. In Pixi a container's
`visible = false` suppresses its whole subtree, so `addSprite` can never put a pixel on screen and
`enter()` yields hidden tiles plus an invisible overlay. The module's stated purpose (§18 items 1-2)
is unreachable; `packages/bootstrapped/tests/` has no `world.test.ts` (only attach, build-output,
catalog-sources, coexistence, ctors, room-upgrade) so nothing catches it.

## 3. installRenumberHook hands back a detached Renumberer on a reused slot: CONFIRMED (critical)

Opened: `packages/bootstrapped/src/coexistence/renumber.ts:499-539` (fresh machine at 502, handle at
529-538), `packages/bootstrapped/src/coexistence/brand.ts:227-233` (`isBranded` short-circuit returns
`{outcome:'reused'}` without calling `wrap`), `renumber.ts:532-534` (`active` compares the slot to
`install.wrapper`).

What is true: the fresh `Renumberer` is built at 502 *before* `installHook` runs; on the `'reused'`
path `wrap` is never called, so the wrapper already in the slot closes over the *first* machine, and
the second handle returns the new, unused one. `active` is nonetheless `true` for both handles
(it only compares the slot identity), and `RenumberHookHandle` exposes no outcome flag, so a caller
cannot tell. Reproduced (`/tmp/re3.mts`): hook A on a shared machine that has observed sequence 40,
then `installRenumberHook` again → `hookB.active === true`, `hookA.renumberer === hookB.renumberer`
is `false`, and the number `hookB.renumberer.claimNext()` hands the caller is not the number the live
wrapper stamps (`shared.isOurs('mine-1') === false`).

Qualification on the stated mechanism: "the caller's frame is renumbered again" holds only when the
live machine is already in the active phase; while it is passive it merely *observes* the frame, so
the immediate symptom is a counter the caller believes it owns and the wrapper does not. The
invalid_sequence freeze needs the live machine to have claimed before. The structural defect, two
counters neither aware of the other and unobservable from the API, is confirmed.

## 4. `npm run verify` tests before building, so 16 assertions skip: CONFIRMED (critical)

Opened: `package.json:17`, `packages/bootstrapped/tests/build-output.test.ts:51-63` (16 `skip: !built`
guards, all derived from `built = existsSync(artifactPath)` at 51).

What is true: `verify` is `npm run typecheck && npm test && npm run build`, so on a fresh checkout the
userscript artifact does not exist when `npm test` runs, and every one of the 16 assertions in
`build-output.test.ts` carries the same `{ skip: !built && 'not built yet' }` option, including the
banner-at-byte-0 assertion (71-77), the no-ESM-import/export and no-`require` assertions (114, 126),
and the unbundled-specifier guard (220). The module's own header (20-25) argues for the skip; a warning
that never fails is what the release gate actually consists of. There is no `MG_ALLOW_UNBUILT_TESTS`
escape hatch (grep: absent). With the artifact present the same 16 tests pass, so the suite is green
either way and the ordering is the only difference.

## 5. Tile suppression is not identity-guarded nor multi-scene safe: PARTIAL (real: high, not critical)

Opened: `packages/bootstrapped/src/render/world.ts:840-853` (`recordAndWrapNoop`), `world.ts:289-300`
(unconditional restore loop), `world.ts:513-517`, `packages/bootstrapped/src/client.ts:858-864`.

What is true: `recordAndWrapNoop` never checks whether the slot already holds *our* no-op, so a second
`WorldScene` entering the same prototype-backed tile records `value: <our suppressed fn>` and
`wasAbsent: false` (measured by reading 845-848: the own property exists, and `target[key]` is the
no-op). On exit, 293-295 writes `restore.target[restore.key] = restore.value` unconditionally with no
`hasOwnProperty`/identity check, so the no-op goes back as an own property and permanently shadows the
prototype `draw` for that tile. The farm tile never redraws and the reusable scene never restores it.
The authors knew about `wasAbsent` (the comment at 835-838 describes this failure mode) but not
about two scenes on one tile. `client.ts:858-864` returns a fresh scene per call with no registry, so
the multi-scene case is reachable through the public facade, and a foreign mod that replaced `draw`
between enter and exit is likewise clobbered by 295.

Why not critical: it is bounded to tiles a scene actually entered, needs two scenes (or a foreign
patch) for permanence, and is not exploitable or credential-bearing, unlike findings 1 and 4. It is a
real bug on a normal path → high. Correction to the evidence: the restore loop is at 290-299, not
"290-295".

## 6. `|| true` makes RoomSocket's send() pass-through test unable to fail: CONFIRMED (critical)

Opened: `packages/headless/tests/room-socket.test.ts:204-218`, `packages/headless/tests/mock-server/server.ts:177`,
`server.ts:424`.

What is true: the assertion is `assert.ok(server.commands.length > 0 || true, ...)` at 214-217, which
is `assert.ok(true)` for every possible program state. A `grep -rn "|| true" packages` finds this as the
only occurrence, so it is an accident, not a house style. The test sends a hand-built room payload at
210 and the bare keepalive string at 212, and asserts nothing about either: it cannot detect a `send()`
that drops, mutates, or throws on the documented hand-built-frame escape hatch. `MockServer.commands`
(server.ts:177) only records parsed commands with a `type`, so the `'pong'` path is not observable
through it, so the finding's recommendation to add a raw-frames helper is the right
fix rather than merely tightening the existing assert.
