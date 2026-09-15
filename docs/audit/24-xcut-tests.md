# 24. Cross-cutting audit: tests and verification

Scope: `packages/*/tests/**`, `scripts/verify-live*.ts`, `packages/bootstrapped/tests/build-output.test.ts`.
Baseline measured: `npm test` → **490 tests / 490 pass / 0 skipped, 90.6 s**; headless alone 99 tests / 4.3 s.

## Coverage map (src file → test file, by import)

Method: parse every `import`/`from` in each test file, resolve `.js`→`.ts` and workspace specifiers
(`@mg.js/common` → `packages/common/src/index.ts`), and record the `src/` files each test reaches **directly**.
Transitive reachability was discarded as misleading: `client.ts` imports the whole render layer, so `WorldScene`
counts as "reachable" from any test that builds a `BootstrappedClient` with `disableRender: true`.

**22 of 66 src files are imported by no test file.** Highest-risk clusters:

1. `packages/bootstrapped/src/userscript.ts` (302 lines): the production entry point, and the only package file
   not even transitively reachable (with `index.ts` barrels, harmless).
2. `packages/bootstrapped/src/render/{world,rive,pixi,graphics,sprite,text}.ts`: **2 682 lines, zero tests**.
   Every client-constructing test passes `disableRender: true` (`catalog-sources.test.ts:26`,
   `room-upgrade.test.ts:279,488,515`), so none of it executes; `ctors.test.ts` covers `render/ctors.ts` only.
   `world.ts:840-855` `recordAndWrapNoop`/`recordAndSet` and `WorldScene.exit()`'s restore unwinding are the
   same teardown-and-restore class of risk as F4, untested.
3. `packages/common/src/catalog/http.ts` (118 lines): the hostile-upstream boundary; see F7.

Also untested: `bootstrapped/src/jotai/bridge.ts` (727), `bootstrapped/src/storage.ts` (454),
`bootstrapped/src/attach/raw-socket.ts` (504), `common/src/emitter.ts`, `common/src/protocol/id.ts`.
`headless/src/*` is the best-covered package: 8 of 9 files have a direct test.

---

## Findings

### F1 (CRITICAL): an `|| true` assertion makes the `send()` pass-through test vacuous
`packages/headless/tests/room-socket.test.ts:214-217`:
`assert.ok(server.commands.length > 0 || true, 'send() must not throw for a hand-built frame');`
`x || true` is a tautology. The test it belongs to (`:204` "sends a pre-built payload verbatim through `send()`")
sends `{ scopePath: ['Room'], type: 'UsurpHost' }` and `'pong'` at `:210`/`:212` and asserts nothing about either.
*Why:* `RoomSocket.send` is the documented escape hatch for hand-built frames; a regression that drops, reorders
or mutates the payload passes green. This is the only assertion in the repository that cannot fail.
*Fix:* assert the recorded values: `assert.deepEqual(server.roomFrames.map((f) => f.type), ['UsurpHost'])`
(`roomFrames` is real, `mock-server/server.ts:179`) and `assert.equal(server.commands.length, 0)` after the
`'pong'`, since a verbatim pass-through must add no command. *breaking: no.*

### F2 (CRITICAL): no hostile-wire-input test; `/__proto__` patch paths pollute `Object.prototype`
`packages/common/src/state/pointer.ts:24-27` splits the pointer and unescapes `~1`/`~0`, rejecting only a missing
leading `/`; nothing rejects `__proto__`, `constructor` or `prototype`. `packages/common/src/state/patch.ts:260`
then does `(parent.value as Record<string, unknown>)[key] = patch.value`, so
`[{ op: 'add', path: '/__proto__/polluted', value: true }]` resolves `parent.value` to `Object.prototype` and
writes through it. `grep '__proto__|constructor|prototype' packages/common/tests/patch.test.ts` → 0 hits out of
115 assertions.
*Why:* `applyPatch` consumes inbound `RoomFrame` patches, and in `@mg.js/bootstrapped` it runs inside the game's
page realm, so polluting `Object.prototype` can break the host game page, the brief's critical bar.
*Fix:* add `packages/common/tests/patch.test.ts` → `it('refuses __proto__ and constructor tokens rather than walking
into Object.prototype')`, and guard the source by exporting `function isUnsafeToken(token: string): boolean` from
`packages/common/src/state/pointer.ts` (`token === '__proto__' || token === 'constructor' || token === 'prototype'`)
thrown from `parsePointer`. *breaking: no.*

### F3 (HIGH): credential policy is untested; the JWT-bearing `Cookie` header reaches a public event and CI logs
`packages/headless/src/transport/client.ts:215` passes the full header bag, `this.onHeadersUnsupported(this.headers)`,
to `packages/headless/src/client.ts:692-693`, which re-emits it publicly as
`emit('headersUnsupported', { headers: dropped, runtime })`. That bag is where `CookieAuthProvider` put
`Cookie: mc_jwt=<jwt>`. The only consumer test, `integration.test.ts:205`, destructures `{ runtime }` and discards
`headers`, so nothing asserts the token cannot reach a log record, event payload or error message; the sole leak
test is `connect-url.test.ts:236-238`. Separately `mock-server/server.ts:295` records
`headers: { ...req.headers }` on every upgrade and `integration.test.ts:299, :311, :379, :433` interpolate
`JSON.stringify(server.upgrades, null, 2)` into assertion messages: a *failing* cookie-authenticated test prints
the raw `Cookie` header into CI output.
*Why:* "leaks a credential" is the project's own critical bar and the only enforcement is a string check on one
field of one unit test; any new listener or log sink that serialises the event leaks the session.
*Fix:* add `packages/headless/tests/integration.test.ts` →
`it('never mirrors mc_jwt into events, logs or error messages')` using `MemoryLogSink` (`common/src/log.ts:53`)
with a sentinel token, asserting no `LogRecord` field contains it; redact `headers` in the `headersUnsupported`
payload in `packages/headless/src/client.ts`; and make `integration.test.ts:196` pass
`auth: new CookieAuthProvider({ token })` while asserting the server saw the `Cookie` header. *breaking: no.*

### F4 (HIGH): the userscript install path has no uninstall and no test
`packages/bootstrapped/src/userscript.ts:168` `startUserscript()` returns the client and registers no teardown:
the badge poll `setInterval` created at `:232` is never cleared; `BadgeHandle.destroy()` (`:134-136`) has no
caller; `globalThis.__mgjs` assigned at `:210` is never deleted. `client.uninstall()` only calls
`deleteNamespace`, which deletes `page[NAMESPACE_KEY]` (`realm.ts:384`), not the sandbox global. `:298-302` calls
`startUserscript()` and discards the result, so nothing can reach the timers. No test imports `userscript.ts`.
The author expected one: `userscript.ts:282-286` `unref`s both timers "in a non-browser context (tests, SSR)".
*Why:* the package's stated MUST is that it "uninstall cleanly, restoring every global, listener, timer and wrapped
method it took". A reload or disable leaves a 500 ms interval, a DOM badge and a global holding a torn-down client,
and `client.uninstall()`, well tested in `catalog-sources`/`room-upgrade`, cannot reach any of them.
*Fix:* `packages/bootstrapped/src/userscript.ts` →
`export function startUserscript(): UserscriptHandle | null` with
`interface UserscriptHandle { client: BootstrappedClient; uninstall(): void }` whose `uninstall()` does
`clearInterval(timer)`, `badge?.destroy()`, `delete globalThis.__mgjs`, then `client.uninstall()`; add
`packages/bootstrapped/tests/userscript.test.ts` using `installRealmOverride` plus a fake `document`, asserting
every global is restored and no timer survives. *breaking: yes (return type changes).*

### F5 (HIGH): neither release gate can fail
**(a)** `packages/bootstrapped/tests/build-output.test.ts:51-63` gates all 16 standalone-userscript assertions on
`existsSync(artifactPath)`. Measured: moving `dist/magicgarden.user.js` aside gives
`# pass 0 / # fail 0 / # skipped 16` and **exit code 0**. `dist/` is gitignored (`.gitignore:2`) and
`package.json` `"verify": "npm run typecheck && npm test && npm run build"` tests **before** it builds, so on a
clean checkout the "single standalone file" property, the package's one hard requirement, is never checked by
the gate meant to check it. It also never checks *freshness*: it asserts on whatever artifact is on disk, and that
artifact is assembled from `packages/common/dist/*.js` (bundle comments at lines 24, 41, 448 ...), so
`build-output.test.ts:58`'s advice to run `build:userscript` alone can embed a stale `@mg.js/common`.
**(b)** `scripts/verify-live-socket.ts:158` `if (sawSessionExpired || !client.isReady) {`: the second disjunct
matches *any* failure to become ready (DNS, TLS, bad version, wrong handshake). Inside, `:161-171` call
`report(label, true, ...)` with a hardcoded `true` for "transport reached the server", "handshake frames were sent"
and "server closed with 4840 SessionExpired", and `:178` sets `failures = 0`, **erasing** failures already counted
at `:83-92`. It then prints "LIVE SOCKET CHECK PASSED" and exits 0; the only check that the reverse-engineered
protocol matches the deployed server certifies three claims it never measures. `:70-75` also never `clearTimeout`s
or `unref`s the 45 s deadline and `:148` is a fixed 6 s sleep, so a run holds the event loop up to 45 s after the
work is done.
*Fix:* export `buildUserscript(options: { outfile?: string }): Promise<{ bytes: number }>` from
`packages/bootstrapped/scripts/build.ts` and build into a temp file from a `before()` hook in `build-output.test.ts`;
in `verify-live-socket.ts` report the measured `sawSessionExpired`, drop `failures = 0`, and `clearTimeout(deadline)`
in a `finally`. *breaking: no.*

### F6 (MEDIUM): two assertions that cannot fail, in the two files that most need to be able to
- `packages/common/tests/store.test.ts:92`: `assert.equal(store.get('/data/players')?.valueOf !== undefined, true)`.
  Every non-null value has `valueOf`, so it passes for the pre-replacement array too and does not test the test's
  own claim at `:84` ("replaces the whole tree"). Fix: `assert.deepEqual(store.get('/data/players'), [])`.
- `packages/common/tests/client.test.ts:558`:
  `assert.equal(second.store.version > first.client.store.version, false)`. `:552` already established
  `second.store === first.client.store === shared`, so this compares a number with itself and is always false.
  Fix: capture `const before = shared.version` before `:555` and assert `assert.equal(shared.version, before + 1)`.
*Why:* both guard regressions the files explicitly document as such (see the REGRESSION note at
`client.test.ts:541-543`) and neither can detect its regression. *breaking: no.*

### F7 (MEDIUM): malformed-HTTP paths of the catalogue are untested, and the size cap does not bound memory
`packages/common/src/catalog/http.ts:50` `fetchJson` is imported by `platform-source.ts:21` and
`remote-json-source.ts:18` but by no test file. Never executed: the `maxBytes` branch (`:81-87`), the
`AbortError`/timeout branch (`:101-105`) and `safeText` (`:112-118`). The only non-2xx exercise,
`catalog.test.ts:416-421` (`Response('nope', { status: 500 })`), runs `http.ts:71-78` but asserts only the
downstream fallback (`:424`), never `HttpError.status` or `bodyPreview`. `:80` also buffers the whole body with
`response.text()` **before** comparing `text.length > maxBytes`, so the cap documented at `:22-23` as bounding
"a hostile or broken endpoint" does not bound memory at all.
*Why:* this is the boundary against a hostile or broken upstream; a regression that accepts an HTML error page as
JSON, ignores the cap, or hangs passes the whole suite.*Fix:* add `packages/common/tests/http.test.ts` with `it('rejects an HTML error page as invalid JSON, not a
TypeError')`, `it('enforces maxBytes before parsing')` and `it('reports a timeout when the server never
responds')` (`fetch = () => new Promise(() => {})`, `timeoutMs: 5`); bound the read in `fetchJson` by streaming
or checking `Content-Length` before buffering. *breaking: no.*

### F8 (MEDIUM): duplicated fixtures have already drifted
There is no shared fixture module. In `bootstrapped/tests/`: `class FakeRoomConnection` is declared **twice with
opposite defaults**: `attach.test.ts:52` (`isCommandSessionReady = false`, `sent: {via, payload}[]`) and
`room-upgrade.test.ts:45` (`isCommandSessionReady = true`, separate `sendMessageCalls`/`trySendCalls`);
`makeClient(page)` twice (`catalog-sources.test.ts:22`, `room-upgrade.test.ts:275`); and the
`installRealmOverride` + `try/finally` + `client.uninstall()` + `restore()` block appears 11 times. In
`common/tests/`: `catalog.test.ts` holds **9 copies** of the `globalThis.fetch` save/restore monkey-patch
(`:306-313, 321-337, 342-375, 383-409, 415-428, 435-442, 447-455, 460-477, 482-489`) around process-global mutable
state; the live weather block is copied from `weather.test.ts:28-46` into `catalog.test.ts:347-361`; the
room-state literal is written three ways (`client.test.ts:87-90`, `patch.test.ts:30-31`, `store.test.ts:20-30`).
In `headless/tests/`: `mock()` + `after()` teardown is duplicated (`integration.test.ts:30-58` vs
`room-socket.test.ts:22-46`) and the reconnect literal is identical at `integration.test.ts:456-463` and `:526-533`.
*Why:* the two `FakeRoomConnection`s model the same game object with contradictory `isCommandSessionReady` defaults, so a
new test copied from the wrong neighbour silently exercises the other branch, which is drift in the model of the host.
*Fix:* add `packages/bootstrapped/tests/helpers/fake-room-connection.ts` exporting
`class FakeRoomConnection { constructor(options?: { isCommandSessionReady?: boolean }) }` plus
`withPage(page: PageRealm, fn: () => void): void`; `packages/common/tests/fixtures.ts` exporting `ROOM_STATE`,
`WEATHER_BLOCK`, `CONNECT_OPTS` and `withFetchStub(impl)`; and
`packages/headless/tests/mock-server/harness.ts` exporting `startTrackedMockServer()`. *breaking: no.*

### F9 (MEDIUM): the mock server can hang the runner, and one negative assertion is vacuous
`packages/headless/tests/mock-server/server.ts:354-358` starts a `setInterval` (default 1000 ms, `:262`) that is
never `unref`d; `stop()` (`:527-542`) clears `internals.sockets` then awaits `wss.close()`/`httpServer.close()`
with no timeout, no `closeAllConnections()` and a swallowed `terminate()` failure, so the callback can never fire
and `stop()` has no recovery path. `integration.test.ts:405` and `:481` are fixed 120 ms watch windows for
negative assertions, and `room-socket.test.ts:228` is a fixed 150 ms window for "disconnect() must suppress
reconnect" that `makeSocket` already made unfalsifiable by setting `reconnect: { enabled: false }`
(`room-socket.test.ts:55`). `until()` defaults to 5000 ms over 7 call sites and `waitUntilReady()` to 15 000 ms
(`common/src/transport/types.ts:102`) over 14, with no `--test-timeout`, so a Welcome-path regression blocks CI
for minutes rather than failing fast. Literal sleeps total only 410 ms (810 ms with configured server delays), so
this is a robustness ceiling, not a live flake.
*Fix:* `.unref()` the ping interval and add `httpServer.closeAllConnections()` plus a stop timeout in
`packages/headless/tests/mock-server/server.ts`; replace the `room-socket.test.ts:228` sleep with an event-based assertion and add `--test-timeout=10000` to the `test` script. *breaking: no.*

### F10 (LOW): `verify-live*.ts` as a release gate
The live scripts are correctly kept out of the network-less suite, and `verify-live.ts` does **not** duplicate
coverage in the wrong direction: `restockCountdown` (`:106`), `weatherAt` (`:95`) and the shop-shape checks
(`:46-56`) already have unit counterparts in `weather.test.ts`/`catalog.test.ts`, and the one thing only it checks,
that the *deployed* `PlatformApiSource` still parses, belongs in a live script. The asymmetry is the
reverse: `package.json:18` registers `verify:live` → `scripts/verify-live.ts` but nothing names
`scripts/verify-live-socket.ts`, the more important check, which cannot be run from any npm script.
*Fix:* add `"verify:live:socket": "tsx scripts/verify-live-socket.ts"` to `package.json`. *breaking: no.*

---

## What works well here

- `packages/bootstrapped/tests/coexistence.test.ts` (103 assertions) is the model for the rest: specific values
  rather than truthiness, referential-identity checks where the invariant is "every byte untouched" (`:232-234`),
  and a message on every non-obvious claim saying *why* it is the invariant (`:280-282`, `:323-325`).
  `room-upgrade.test.ts:330-385` then proves the one-chooser renumbering property end to end, through both the
  room-object path and a socket-level bypass, asserting one sequence number consumed per command.
- Assertion discipline is good overall: `assert.ok(` is ~3 % of assert calls (35 of ~1 100), and the two files
  with the most assertions (`coexistence.test.ts`, `patch.test.ts`) have zero.
- `build-output.test.ts`'s *content* is exactly right: banner at byte 0, `@grant unsafeWindow`,
  `@run-at document-start`, no ESM/`require`/`@mg.js/` residue, and a loud warning when it skips. F5(a) is about
  *when* it runs, not what it checks.
- `session.test.ts` separates "the token is bad" from "the protocol is wrong" per HTTP status with exact codes and
  asserts the absent-cookie case as a real absence (`:85-91`), the right shape for auth behaviour.
- Close-code policy is well covered where it lives: `common/tests/connect-url.test.ts:155-316` pins the
  disposition matrix (4250/4300/4710/4840/4800/4900, supersede confirmation, unknown-code fallback) and
  `backoff.test.ts` covers the reconnect policy that consumes it.
