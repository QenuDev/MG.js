# Adversarial verification of batch 3 (`common/client`, `common/catalog`, `headless/auth+session`, `headless/client+transport`)

Verified by opening every cited line **and** by executing probes with `tsx` against the repo's own
`tests/mock-server/server.ts` and against `ClientCore` with a hand-rolled `Transport`. Probe outputs are
quoted verbatim; scratch probe files were removed afterwards. **All six findings reproduce.**

---

## 1. ping() can never succeed: the Pong reply that carries its id is discarded
**Verdict: confirmed; severity high (unchanged).**
Opened: `packages/common/src/actions/actions.ts:96`, `packages/common/src/protocol/types.ts:190-192`,
`packages/common/src/client.ts:300-355, 418-466, 535-536`, `packages/common/src/actions/handle.ts:81-124`.
True: `ping()` sends flat `{"scopePath":["Room","Quinoa"],"type":"Ping","id":...}` (Ping is `form:'flat'`, so
`sequence` is `-1` and no `QuinoaCommandResult` can ever correlate it). `handleRawFrame`'s `case 'Pong':
return;` (535-536) is the only inbound handling of `PongMessage`; the sole settle paths left are
`handleCommandResult` and `expirePending` (451-462), which always settles `ok:false, confirmed:false`.
Probe: fed `Welcome` then `{"type":"Pong","id":12345}`; the handle returned
`rejected:MgCommandUnconfirmedError:Command "Ping" (... sequence -1) was not confirmed` after the ack timeout.
`grep -rn "\.ping(" packages` has no hits, so the blast radius is library consumers, not this repo.
Fix: keep the recommended `pingsByWireId: Map<number,string>` keyed on `params.id` (actions.ts:96 uses
`Date.now()`), settled in `case 'Pong'` with `matchMethod:'requestId'`. If correlation is not wanted,
make `ping()` a `sendRaw`/fire-and-forget instead of returning a handle that always rejects.

## 2. Unvalidated entity payloads become fake entities and hide `missing`
**Verdict: confirmed; severity high (unchanged).**
Opened: `packages/common/src/catalog/source.ts:157-176, 232, 243-256, 264-274`,
`packages/common/src/catalog/platform-source.ts:126-152`, `packages/common/tests/catalog.test.ts:121-135`.
True: any non-array entity payload goes through `normalizeEntityMap` and is stored with provenance, and
`remaining.delete(kind)` (line 172) then keeps the kind out of `missing`. Probe: a source returning
`{error:'rate limited'}` produced `plants=[{"id":"error","value":"rate limited"}]`,
`provenance.plants='evil'`, and `missing` **without** `plants`; `normalizeEntityMap('oops')` → `[]`.
`PlatformApiSource` validates and throws, so the exposure is `RemoteJsonSource` (arbitrary base URL,
2xx body) and third-party sources.
Correction to the recommendation: *validating the normalised array is not enough.*
`{error:'rate limited'}` normalises to `{id:'error',value:'rate limited'}`, which already satisfies
"non-null object with a string id". Validate the **input** shape in `assignKind`: accept an array whose
every element is a non-null object with a string `id`, or a record whose **every value is a non-null
object** (the key supplies the id, the form pinned by `catalog.test.ts:121-135`); throw otherwise so the
existing `catch` at 173-175 leaves the kind in `missing`. `String(value)` at 232 only mangles `version`
into `"[object Object]"`, which is worth fixing in the same pass.

## 3. mc_jwt token emitted verbatim in the headersUnsupported event payload
**Verdict: confirmed; severity high (unchanged).**
Opened: `packages/headless/src/client.ts:158, 663-694`, `packages/headless/src/transport/client.ts:83,
213-215`, `packages/headless/src/transport/headers.ts:88`, `packages/headless/src/auth/cookie.ts:81-93,
135-139`, `packages/headless/src/auth/types.ts:52-56`.
True: the callback receives `this.headers` unmodified and `client.ts:693` re-emits it. Probe:
`StandaloneTransport` with a header-less runtime and `Cookie: mc_jwt=SECRET.JWT.VALUE` logged
`CALLBACK PAYLOAD {"Origin":...,"User-Agent":"UA","Cookie":"mc_jwt=SECRET.JWT.VALUE"}`.
Note the trigger is narrower than "any requireHeadersForAuth:false caller": with an authenticated
provider `client.ts:663-667` forces `preferAdapter`, so a header-less runtime needs `ws` to be
unresolvable; on the guest path the event still fires, but carries only `Origin`/`User-Agent` (no
secret). `cookie.ts:88-94` redacts the same value in the log note, so the codebase is inconsistent with
itself here. Fix as recommended (header *names*, or redacted values); it breaks the exported event type
(`breaking: yes`).

## 4. StandaloneTransport.dispose() orphans a live socket; a second connect() leaks it
**Verdict: confirmed; severity high.**
Opened: `packages/headless/src/transport/client.ts:340-358, 386-394, 457-470`,
`packages/headless/src/client.ts:606-609, 956-962`.
True: `dispose()` clears the open timer, detaches every listener and drops the socket reference, but it
never calls `socket.close()`, so an OPEN socket survives with no owner. `openConnection` calls
`detachTransport()` first (606), so a `connect()` issued while already open disposes the live transport
and opens a second one. Probe: after `connect()`→ready→`connect()`, the server reported
`openSockets 1→2`, `connectionCount 2`, both upgrades carrying the identical
`clientDocumentId "76e29ba9-..."`, and `openSockets === 1` **after `destroy()`**, so the leaked socket is
unreachable from the client forever. The "unrecoverable data loss" framing is not demonstrated (the
server-side supersede semantics are not tested here); the certain harm is the orphaned live socket plus a
second session on one documentId. Fix as recommended: in `dispose()` mark `manualClose` and call
`this.close(1000,'transport disposed')` before `this.detachSocket()`; the real `close` event is queued
asynchronously, so the subsequent detach still suppresses it.

## 5. A reconnect that fails before the socket opens kills the chain forever, while close reported willReconnect:true
**Verdict: confirmed; severity high (unchanged).**
Opened: `packages/headless/src/client.ts:755-768, 787-806, 814-863, 905-935`,
`packages/headless/src/transport/client.ts:301-315`.
True: the retry runs *inside* the promise stored in `reconnectTask`, so when the retry's failure reaches
`afterClose` → `scheduleReconnect`, the guard at `client.ts:915` (`if (this.reconnectTask !== null)
return;`) swallows it; `.finally` then nulls `reconnectTask` and nothing ever reschedules. Probe
(4400 close, then the server stopped): events `["close@...:willReconnect=true","reconnect@..."]`, then at
t+20 s a second `close...willReconnect=true`; `acceptedConnections 1`, `connectionAttempt 2`,
`client.stopped === null`, no `stopped` event, still nothing at t+45 s. Mechanism detail:
the failed retry only settles after the full 20 s open timeout (`transport/client.ts:305-315`) because
undici's global `WebSocket` fires `error` without a matching `close` for ECONNREFUSED, so the chain dies
*loudly* (a second `willReconnect:true`) and then silently. Fix: the recommended `runRetryLoop` refactor
is right; the minimal version is to re-plan from the synthetic close inside the retry task's own `catch`
instead of relying on re-entry through `scheduleReconnect`.

## 6. An injected webSocketFactory is assumed header-capable, so the auth cookie is silently dropped
**Verdict: confirmed; severity high (unchanged).**
Opened: `packages/headless/src/transport/runtime.ts:104-115, 165-176`,
`packages/headless/src/client.ts:660-694`, `packages/headless/src/transport/client.ts:211-225`.
True: the `injected` branch hard-codes `supportsHeaders: true` (172), so the `client.ts:669-676` throw is
never reached for `requireHeadersForAuth:true`, and `onHeadersUnsupported` never fires. Probe with
`webSocketFactory: globalThis.WebSocket` + `CookieAuthProvider`: `thrown=null`,
`isReady=true`, `headersUnsupported=[]`, upgrade `cookie=null`, and `user-agent: "node"`, so `Origin`
and `User-Agent` are dropped too. Fix as recommended: add `supportsHeaders?` to
`AcquireWebSocketOptions` / `webSocketSupportsHeaders?` to `HeadlessClientOptions`, treat
`factory === globalThis.WebSocket` as `false`, and keep the existing description honest.
