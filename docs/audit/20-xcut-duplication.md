# 20: Cross-cutting duplication

Scope: `packages/*/src`, `packages/*/tests`, `scripts`. Every citation was opened; `grep` was used to check
callers before calling a copy dead or duplicated. Each finding names the one home the logic should have.

## 1. The sequence-number validator is written five times and two of the copies disagree (high / correctness / breaking: no)

`common/src/protocol/codec.ts:126-131` (`extractFrontier`) accepts **any finite number**, because it returns
`Number.isFinite(value) ? value : null` at `:130`. Four bootstrapped copies require an **integer ≥ 0**:
`bootstrapped/src/client.ts:927-932` (`readWelcomeFrontier`), `attach/room-connection.ts:245-248`
(`asSequence`), `attach/raw-socket.ts:159-163` (inline), `coexistence/renumber.ts:445-448` (`asSequence`).

Why it matters: `common/src/client.ts:546-548` seeds the core sequencer from
`typeof message.executedCommandSequence === 'number'`, so a `Welcome` carrying
`executedCommandSequence: 2.5` seeds the core's counter while `readWelcomeFrontier` returns `null` at
`bootstrapped/src/client.ts:250-252` and the renumberer is never seeded, the exact opposite of that line's
stated invariant, *"Seed both counters from the same fact, so they cannot disagree"*. A renumberer starting
at 0 in a session whose frontier is N can re-issue a sequence the game already used.

Fix: one `asSequence(value: unknown): number | null` (integer ≥ 0) in `common/src/protocol/codec.ts`;
`extractFrontier` becomes `asSequence(record.executedCommandSequence)` and all four bootstrapped copies
import it (already re-exported via `common/src/protocol/index.ts`).

## 2. `Emitter` is reimplemented three times, and the copies disagree about listener failures (high / duplication / breaking: no)

Home: `common/src/emitter.ts:14-79` (exported at `common/src/index.ts:25`). Copies:
`headless/src/client.ts:271`, `:472-498` (`on`/`once`), `:982-995` (`emit`);
`headless/src/transport/client.ts:144-146`, `:481-509` (`emitMessage`/`emitOpen`/`emitClose`);
`bootstrapped/src/attach/transport.ts:122-124`, `:142-148`, `:160-166`, `:452-458`, `:461-474` (three handler
sets, five hand-written dispatch loops). ≈140 duplicated lines, and the copies are **not** equivalent:

- `emitter.ts:64-66` swallows a listener exception; `headless/src/client.ts:991-993` logs it via
  `this.logger.error`, so two "same" event buses have different failure semantics.
- `emitter.ts:44-49` deletes an event's empty `Set`; `headless/src/client.ts:483-485` deletes only the
  listener, so every event name ever subscribed leaves an empty `Set` behind.
- `off`/`listenerCount`/`removeAllListeners` (`emitter.ts:44,71,76`) are absent from `HeadlessClient`. That
  omission is the only reason `destroy()` hand-clears the map (`headless/src/client.ts:591`).

Fix: `class HeadlessClient extends Emitter<HeadlessClientEvents>` (override `emit` to keep the logging
policy); give each transport a private `Emitter<{message:[string];open:[];close:[TransportCloseInfo]}>` and
keep `onMessage/onOpen/onClose` as adapters over `emitter.on(...)`.

## 3. The deadline-poll is written five times, with three different end-of-window outcomes (high / duplication / breaking: no)

No home exists. `attach/detect.ts:286-303` (`waitForAttachment`, which resolves the empty attachment at
`:297`); `detect.ts:384-412` (`watchForRoomConnection`, which stops and calls `onTimeout` at `:405`);
`render/ctors.ts:833-865` (`getCtors`, which **rejects** with `PixiCtorsTimeoutError` at `:852`);
`jotai/bridge.ts:452-476` (silent `return` at `:472`); `attach/transport.ts:173-183` (**no deadline at all**,
rescheduled forever and stopped only by `close()`/`stopPolling` at `:478-489`). Each also re-derives the
injectable `schedule`/`cancelSchedule` options.

The Node-timer teardown is copied four more times, three ways: `attach/transport.ts:481-486` (`'unref' in`),
`jotai/bridge.ts:491-495` (same, differently spelled), `catalog/bundle.ts:349-350` (`isPlainObject` +
`timer['unref']`), `headless/src/client.ts:574` (`.unref?.()`).

Why it matters: the five identical loops drift on the only question a caller cares about, what a timeout *means*
(resolve empty / reject / callback / silence / never). A caller cannot predict one from another, and the
fifth can only be stopped by a close, so a page that never opens pins a timer for the page's life.

Fix: `pollUntil<T>(options: {attempt: () => T | null; timeoutMs: number; intervalMs: number; schedule?;
cancelSchedule?; onTimeout?}): Promise<T | null>` plus `unrefTimer(timer: unknown): void` in a new
`bootstrapped/src/util/poll.ts` (or `common/src/poll.ts`, since `watchForRoomConnection` predates the rest).
`waitForAttachment` supplies its empty-attachment `onTimeout`; `getCtors` the rejecting one.

## 4. The renumbering gate exists three times, and only one path guards the host's send (medium / duplication / breaking: no)

`coexistence/renumber.ts:546-573` (`applyRenumbering`), guarded by its caller at `:511-517`, which documents
*"a rewrite failure must never drop the game's frame"*; `bootstrapped/src/client.ts:730-735`
(`rewriteOutboundObject`: gate + `isOurs` + `rewrite`); `client.ts:973-984` (`applyRenumberingToString`:
gate + `parseEnvelope` + `isOurs` + `rewrite` + `stringify`).

`asEnvelope` is copied too (`renumber.ts:437-442` vs `client.ts:942-946`), as is the pre-parse gate
(`length < 16`, `includes('QuinoaCommand')`), at `renumber.ts:552-553` vs `client.ts:956-957`. The comment
justifying the copy, *"Local rather than imported from `coexistence/renumber.ts` so the two modules stay
independent"* (`client.ts:937-938`), is false: `client.ts:79` already imports `Renumberer` from that same
module.

The consequence of the split: the room path runs interceptors inside try/catch
(`attach/room-connection.ts:386-396`, *"never drop the host's frame"*), but the raw-socket path calls the
rewriter **unguarded** (`attach/raw-socket.ts:304`), and the closure it holds leaves
`renumberer.rewrite(...)` unguarded (`client.ts:978`), and only its own `JSON.parse`/`JSON.stringify` are
in try/catch (`:958-962`, `:980-983`). A throw from `rewrite` escapes into the game's own `send`.

Fix: one `bootstrapped/src/coexistence/envelope.ts` exporting `asEnvelope(frame: unknown):
CommandEnvelope | null` and `parseQuinoaEnvelope(raw: string): CommandEnvelope | null`; delete
`client.ts:942-946`/`:973-984` and route the string path through `applyRenumbering`; wrap
`rewriteForCoexistence(data)` at `raw-socket.ts:304` the way `room-connection.ts:389-393` does.

## 5. `CLOSE_CODE_LABELS` is a second, hand-written copy of the enum under a "cannot drift" comment (medium / consistency / breaking: no)

`close-codes.ts:173-177` claims the table is *"Built from the enum rather than hand-written twice, so the two
can never drift"*; `:178-197` is a literal. The enum declares `Normal = 1000` and `GoingAway = 1001`
(`:47-52`) and the table omits both, while `analyzeClose` derives `known`/`label` from it at `:251-252`. So
`analyzeClose(1000)`/`analyzeClose(1001)` return `known: null, label: null`, contradicting `known`'s own doc
(*"null for anything not in the game's enum"*, `:146-147`). A future code added to the enum and to
`TERMINAL_CODES` (`:212-219`) but not to the table is still reported *"not present in the game's own
close-code enum. Reconnecting by default."* (`:429-441`). `common/tests/connect-url.test.ts:156-183` asserts
only the 18 application labels, so nothing catches it.

Fix: derive it as `export function closeCodeLabel(code: number): string | null` over the enum
(alias-suppressed) in `close-codes.ts`, plus a parity test over `Object.keys(CLOSE_CODE_LABELS)`; at
minimum add 1000/1001 and correct the comment.

## 6. `DEFAULT_RECONNECT` is duplicated as a literal under a "cannot drift" comment (medium / duplication / breaking: no)

`common/src/protocol/types.ts:287-295` vs `headless/src/reconnect.ts:45-53`, introduced by *"Mirrors
`DEFAULT_RECONNECT` from the common package so the two cannot drift"* (`reconnect.ts:44`). Nothing links
them; the seven values agree today only because a human kept them in step. The headless doc also contradicts
itself: `HeadlessClientOptions.reconnect` points callers at `DEFAULT_RECONNECT`
(`headless/src/client.ts:201`) while `ReconnectPolicy` merges `DEFAULT_RECONNECT_POLICY`
(`reconnect.ts:247`).

Fix: `export { DEFAULT_RECONNECT as DEFAULT_RECONNECT_POLICY } from '@mg.js/common';` in
`headless/src/reconnect.ts`. `DEFAULT_RECONNECT` is already public (`common/src/protocol/index.ts:27`
through `common/src/index.ts:15`), so the exported name and type are unchanged.

## 7. The bootstrapped test fixtures are duplicated and have drifted (medium / tests / duplication / breaking: no)

`FakeRoomConnection` exists twice (`bootstrapped/tests/attach.test.ts:52-97`,
`bootstrapped/tests/room-upgrade.test.ts:45-81`), and they are not the same fixture. attach's records
frame/welcome handlers and delivers them (`emitFrame`/`emitWelcome`, `:83-96`), while room-upgrade's
`subscribeToRoomFrames`/`subscribeToWelcome` return no-ops and can never deliver a frame (`:74-80`), so every
test using it is blind to frame handling. `isCommandSessionReady` is `false` in attach (`:53`) but hardcoded
`true` in room-upgrade (`:48`), making the `trySendMessageNow → false` branch unreachable there. A third
variant, `NoWelcomeRoomConnection` (`room-upgrade.test.ts:390-418`), is the only one that can deliver
patches, so each of the three drives exactly one of the paths the binding supports.

The synthetic `Welcome`/state tree is declared 4-6× at different depths: `common/tests/client.test.ts:82-92`
(plus `store.test.ts:18-32`, `patch.test.ts:28-34`) carries a populated `players`/`userSlots[0]` tree,
`mock-server/server.ts:208-220` a different one, `attach.test.ts:113-121` an empty one, with `welcome()`'s
argument order swapped between the first two.

Around it: two `makeClient(page)` factories for the same class (`catalog-sources.test.ts:22-31` vs
`room-upgrade.test.ts:275-285`); two hand-driven socket fakes that behave differently
(`room-upgrade.test.ts:89-119` always accepts `send`; `headless/tests/transport-keepalive.test.ts:28-104`
honours `readyState` and throws); `unusableConnection()` (`room-upgrade.test.ts:84-86`) duplicated as an
inline literal (`attach.test.ts:150`); and three predicate-wait loops (`headless/tests/integration.test.ts:79-90`
`until`, `room-upgrade.test.ts:151-157` `waitUntil` (which throws a bare `Error` instead of naming what it
waited for), and an inline loop at `headless/tests/room-socket.test.ts:193-196` with no message at all).

Fix: one `bootstrapped/tests/fixtures/room-connection.ts` exporting `makeRoomConnection()` (the attach
version, which can actually deliver), `makePageWith(connection)` and `makeScheduler()`; plus one shared
`until(predicate, description, {timeoutMs, intervalMs})` per package.

## 8. `probeSession` re-implements `fetchJson`'s timeout, abort and header plumbing (medium / duplication / breaking: no)

`headless/src/session.ts:164-228` hand-rolls `AbortController` + `setTimeout(..., 10_000)` + `clearTimeout` +
`fetch` + `AbortError` classification, which `common/src/catalog/http.ts:50-110` already implements. The copy
has drifted: it sends only `Accept`/`Origin` (`session.ts:169-172`) where every catalogue request sends
`DEFAULT_HEADERS`, `User-Agent` included (`http.ts:10-14`, `:67`), and it has no size cap (`http.ts:81-87`).
It also adds the third copy of `.replace(/\/+$/, '')` base-URL normalisation (`session.ts:164`; also
`catalog/platform-source.ts:73`, `catalog/remote-json-source.ts:67`). Fix: add `export async function
fetchResponse(url: string, options: FetchJsonOptions = {}): Promise<Response>` and
`export function normaliseBaseUrl(url: string): string` to `common/src/catalog/http.ts` and use both.

## Smaller copies of the same shape

- **The mock server re-implements a transport helper, and has drifted:** `mock-server/server.ts:548-558`
  (`toText`) vs `headless/src/transport/runtime.ts:244-258` (`decodeSocketPayload`). `toText` returns `''`
  and does not unwrap `{data}` where `decodeSocketPayload` returns `null` and recurses, so an undecodable
  client frame is logged as empty (`server.ts:373`). The keepalive is hardcoded `'ping'` at `server.ts:357`,
  `:517`, `:646` instead of `KEEPALIVE_PING` (`common/src/protocol/types.ts:205`).
- **The `QuinoaCommand` envelope literal is built four times although `src` exports the builder:**
  `coexistence.test.ts:204-213`, `attach.test.ts:333-339` and twice in `room-upgrade.test.ts:342-348`,
  `:367-374`, all byte-equal to `buildWrappedFrame` (`common/src/protocol/envelope.ts:79-97`).
- **Entity-map and object-shape guards duplicated, with drift:** `catalog/bundle.ts:211-220` (`asEntryList`
  requires every value to be an object) vs `common/src/catalog/source.ts:264-274` (`normalizeEntityMap`
  fabricates `{id, value}` for scalars), and the bundle comment at `:207-209` concedes that overlap. The
  "non-null non-array object" guard is hand-rolled ~9× (`codec.ts:68`, `catalog/weather.ts:96,114`,
  `catalog/remote-json-source.ts:111`, `catalog/source.ts:266`, `catalog/bundle.ts:152-153`, `client.ts:943`,
  `renumber.ts:438`) and two copies omit the array check: `attach/room-connection.ts:764`,
  `attach/raw-socket.ts:154`.
- **Connect-URL quoting is asserted twice across packages, against two extraction helpers:**
  `common/tests/connect-url.test.ts:34-133` (via `searchParams`) and `headless/tests/connect-url.test.ts:28-48`,
  `:60-130` (via its own `rawQuery`/`rawParam`/`jsonEncoded`) assert the same six §1.3/§1.4 rules for the same
  `buildConnectUrlDetailed`. The headless header (`:12-15`) justifies itself with a false premise: it says
  `searchParams` "would happily accept `web` where the wire needs `\"web\"`" but
  `common/tests/connect-url.test.ts:53` asserts `params.get('surface') === '"web"'`, which fails for `web`.
- **A shipped mistake also has three homes:** `new CookieAuthProvider(process.env.MC_JWT!)` at `README.md:97`,
  `README.md:108` and `packages/headless/src/room-socket.ts:87`, against the real options object
  (`headless/src/auth/cookie.ts:103-107`); the test covering the provider uses the correct object form
  (`headless/tests/connect-url.test.ts:232`), so the mistake survived. `scripts/probe-guest-encoding.ts:42`,
  `:63-68`, `:112` likewise re-implement `randomUuid`, `randomRoomSlug`
  (`common/src/protocol/id.ts:17-42`, `:50-68`) and `isKeepalivePing` (`common/src/protocol/types.ts:212`).

## What works well here

- The **transport seam** (`common/src/transport/types.ts:43-75`) is implemented once per package with no copy
  of the protocol core: URL building lives only in `common/src/protocol/connect-url.ts:50-87`, close
  classification only in `common/src/protocol/close-codes.ts:245+`, and both clients call them
  (`headless/src/client.ts:640`, `headless/src/room-socket.ts:337`).
- Retry/backoff has a real single home: `computeBackoff` (`headless/src/reconnect.ts:117-187`) is pure and
  the only place a delay is calculated, and `planRetry` (`:314-331`) re-derives no disposition from a code.
- `isKeepalivePing` (`common/src/protocol/types.ts:212`) is shared by both transports, and
  `bootstrapped/src/attach/transport.ts:498` re-exports the same function instead of copying it.
- The catalogue HTTP layer is centralised: `PlatformApiSource` and `RemoteJsonSource` both go through
  `fetchJson`/`DEFAULT_HEADERS` (`common/src/catalog/http.ts:50`), so UA handling and the timeout exist once.
- Timer injection and the fake-page seam are *injected dependencies* (`installRealmOverride`,
  `options.schedule`) rather than duplicated monkey-patching.
