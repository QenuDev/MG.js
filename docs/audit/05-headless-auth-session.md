# Audit 05: `@mg.js/headless` auth, session, version and room-socket

Scope: `packages/headless/src/auth/{cookie,guest,types}.ts`, `session.ts`, `version.ts`, `room-socket.ts`,
with `client.ts`, `transport/client.ts`, `transport/headers.ts` and `reconnect.ts` read as the call sites
that give those files their behaviour. Every finding below was read at the cited line.

---

## 1. The `mc_jwt` token is emitted verbatim in the `headersUnsupported` event payload

**Severity:** high · **Category:** security · **Breaking:** yes

**Evidence.** `client.ts:158` declares `headersUnsupported: [{ headers: ConnectHeaders; runtime: string }]`,
and `client.ts:692-694` fills it with the *unmodified* bag:
`onHeadersUnsupported: (dropped) => { this.emit('headersUnsupported', { headers: dropped, runtime: runtime.description }); }`.
`dropped` is the transport's `this.headers` (`transport/client.ts:213-215`), built by `buildConnectHeaders`
(`transport/headers.ts:77-95`), whose `ConnectHeaders` carries `Cookie?: string` (`transport/headers.ts:49`).
On the authenticated path that value is literally `mc_jwt=<jwt>`.

**Why it matters.** This is the only place in the package where the credential leaves the object graph.
Everything else is careful: `CookieAuthProvider.prepare()` returns a note of `mc_jwt present (N chars)`
(`auth/cookie.ts:88-94`), and `auth/types.ts:52-56` states the rule: the note "Must **not** carry the
token itself: this value is written to a log sink". `MemoryLogSink.snapshot()` exists
"for a bug-report dump" (`common/src/log.ts:52-64`), so a host that writes
`socket.on('headersUnsupported', (e) => logger.warn(e))`, the obvious reaction to a degradation warning,
puts a live session token into a shareable artefact. The only test reads `runtime`
(`tests/integration.test.ts:205`), so nothing catches it.

Reachability is narrower than "always", so this is high and not critical: at the default
`requireHeadersForAuth: true` the client throws at `client.ts:669-675` *before* the transport exists, so the
event cannot fire. It fires exactly when a caller sets `requireHeadersForAuth: false` to debug the
degradation, that is, for the caller most likely to log it. `RoomSocketOptions = HeadlessClientOptions`
(`room-socket.ts:81`), so the facade exposes the same path.

**Fix.** Emit names, not values: `headersUnsupported: [{ headerNames: string[]; redacted: string[]; runtime: string }]`,
derived at `client.ts:692-694` from `Object.keys(dropped)` plus the names whose value was withheld. The
minimal non-breaking stop-gap is `{ ...dropped, Cookie: dropped.Cookie ? '<redacted>' : undefined }`, but the
right shape for a diagnostic event is names.

---

## 2. `StandaloneTransport.dispose()` detaches a live socket without closing it

**Severity:** high · **Category:** correctness · **Breaking:** no

**Evidence.** `transport/client.ts:386-394`: `dispose()` runs `clearOpenTimer()`, `detachSocket()`, clears
the handler sets and sets `currentState = 'closed'`, but it never calls `socket.close()`. `detachSocket()`
(`transport/client.ts:457-472`) only removes four listeners and nulls the reference. `HeadlessClient`
calls it from `detachTransport()` (`client.ts:956-961`), which `openConnection()` runs as its *first*
statement (`client.ts:604-606`). `HeadlessClient.connect()` has no already-open guard (`client.ts:528-542`)
and its class doc advertises that "`connect()` may be called again after a close" (`client.ts:250-252`).

**Why it matters.** `connect()` on a client whose socket is still open tears the old socket out of the event
graph while leaving it OPEN on the wire: no close frame, no `close` event, and no reference from this
package, a leaked TCP connection that also keeps the Node event loop alive. The replacement socket opens with the
same `clientDocumentId` and player identity, so the server sees two concurrent sessions for one player: the
supersession case this client's own docs say "loses each other's session and nothing gets saved"
(`client.ts:835-838`). `destroy()` is safe only because `disconnect()` closes first (`client.ts:564-578`),
so the suite never shows it.

**Fix.** Close before detaching, in `dispose()`:
`this.close(1000, 'transport disposed'); this.clearOpenTimer(); this.detachSocket(); ...`.
`close()` is already idempotent and already sets `manualClose` (`transport/client.ts:341-363`), so no
signature changes and `classifyClose` still yields `stop`.

---

## 3. `probeSession()` interpolates the token raw, so a shape `CookieAuthProvider` accepts is mis-diagnosed

**Severity:** medium · **Category:** consistency · **Breaking:** no

**Evidence.** `session.ts:173-175`:
`if (options.token !== undefined && options.token.length > 0) { headers.Cookie = \`${SESSION_COOKIE_NAME}=${options.token}\`; }`.
The dominant pattern in the package is the opposite: `auth/cookie.ts:71-73` discriminates a whole `Cookie`
header from a bare token (`value.includes('mc_jwt')`) and `toCookieHeader` (`auth/cookie.ts:81-86`,
re-exported at `index.ts:76`) is the single normaliser. `probeSession` neither calls it nor trims.

**Why it matters.** `auth/cookie.ts:24-28` accepts a full cookie string because "both are what a
browser's devtools hands you", so a caller reusing one `mc_jwt` string for both the provider and the probe
sends `Cookie: mc_jwt=mc_jwt=eyJ...`; the server reads `mc_jwt=eyJ...` as the token, answers 401, and
`probeSession` (whose whole purpose is to "diagnose a bad token in one request instead of an unexplained
close", `session.ts:24-26`) reports `outcome: 'unauthorized'` and "missing, expired or invalid". A valid
token is declared dead. Pasted-cookie whitespace is not normalised either (the provider trims at
`cookie.ts:82,127`; the probe does not).

**Fix.** Add `export function buildProbeCookie(token: string): string` to `session.ts`, throwing `TypeError`
on `/[\r\n]/` and otherwise returning `toCookieHeader(token, options.extraCookies)`; call it at
`session.ts:174`.

---

## 4. The default auth provider is the path this package documents as dead, and its failure is a bare close code

**Severity:** medium · **Category:** api-design · **Breaking:** no

**Evidence.** `client.ts:307`: `this.authProvider = options.auth ?? new GuestAuthProvider();`. The same
package documents, quoting the developers' announcement, that anonymous room websockets "will no longer be
supported" and that every guest permutation is closed with `4840 SessionExpired` (`auth/guest.ts:41-45`,
`50-62`; `session.ts:19-22`).

**Why it matters.** A default-constructed `HeadlessClient` cannot connect to the live server, and the code is
honest about that only in comments. On the wire: `analyzeClose` maps 4840 to `renew-session`,
`shouldReconnect: true`, `isBounded: true` (`common/src/protocol/close-codes.ts:390-402`), so `planRetry`
(`reconnect.ts:314-331`) makes up to `coldStartFastRetries` (3, `common/src/protocol/types.ts:287-295`)
backed-off retries that cannot succeed, then stops with
`reason: 'Reconnect refused: disposition "renew-session" (...)'` (`client.ts:848-855`). Nothing in that string
says "the anonymous path was removed; supply an `mc_jwt`", nothing warns at construction, and `probeSession`,
built for this diagnosis, is never suggested. It is a bounded loop, not an infinite one, but it
still burns ~3 connect attempts before telling the caller something they cannot act on.

**Fix.** One `logger.warn` in the constructor when `this.authProvider.authenticated === false`, naming
`GuestAuthProvider` and the remedy; and in `afterClose` map `analysis.disposition === 'renew-session'` to a
reason that says re-authentication is required. Both additive.

---

## 5. `RoomSocket.connect()` assigns `this.client` before awaiting, so a failed first connect poisons the instance

**Severity:** medium · **Category:** correctness · **Breaking:** no

**Evidence.** `room-socket.ts:126-129`:
`const client = new HeadlessClient(merged); this.client = client; await client.connect();`. Also,
`room-socket.ts:113-118` rejects every later `connect()` with "already been called".
`disconnect()`/`destroy()` early-return only when `this.client === null` (`room-socket.ts:154,179`).

**Why it matters.** The likeliest first-connect failures, namely a transient `platform/v1/version` fetch failure
(`version.ts:243-247`), DNS/TLS failure, or the 20s open timeout (`transport/client.ts:301-313`), leave an
object where no connection was ever made but `connect()` can never be called again. The only escape is a new
`RoomSocket` plus re-wiring every subscription and the `pendingSubscriptions` queue, which no error message
says. The guard cannot distinguish "already connected" from "already failed once".

**Fix.** Assign after the await:
`const client = new HeadlessClient(merged); await client.connect(); this.client = client;` keeping the
`pendingSubscriptions` drain after the assignment (`room-socket.ts:140`, already correct). A rejection then
leaves `this.client === null`, so the guard stays honest and the call is retryable.

---

## 6. No inbound frame-size cap, and the `unparsed` event carries the whole frame

**Severity:** medium · **Category:** missing-capability · **Breaking:** no

**Evidence.** `transport/runtime.ts:244-257` (`decodeSocketPayload`) decodes any payload with no length
check; `common/src/protocol/codec.ts:57-80` (`parseFrame`) `JSON.parse`s it with no cap and returns
`{ kind: 'unparsed', text: raw }`; `common/src/client.ts:498-510` slices the raw text only for the debug
*log* (`raw.slice(0, 200)`) and then emits the unsliced value: `this.emit('unparsed', { raw })`. A
repository grep for `maxFrame|MAX_FRAME|frameSize|maxMessage` returns nothing; the only byte cap in the tree
is on the HTTP catalogue path (`common/src/catalog/http.ts:82`).

**Why it matters.** Nothing constrains what the far end, or a MITM on a `tls: false` deployment
(`client.ts:176-181`), can push in a single frame. One oversized frame is buffered by the runtime, copied by
`TextDecoder`, retained as `raw` in the emitted event and re-parsed by every listener: unbounded memory and
CPU from one message, with no cap and no disconnect.

**Fix.** Add `maxFrameBytes?: number` (default e.g. 8 MiB) to `StandaloneTransportOptions`, enforce it in
`handleMessage` before `emitMessage`, and close with a documented code; have `parseFrame` reuse the truncated
text it already computes so `unparsed` cannot retain unbounded input.

---

## What works well here

- `version.ts` is the strongest file in the subtree: single-flight dedupe (`version.ts:211-219`), a TTL that
  the explicit `refresh()` bypasses because a `4710` demanded it (`version.ts:196-209`), and a
  stale-beats-nothing fallback (`version.ts:237-248`): the three behaviours the documented `4710` loop needs.
- `CookieAuthProvider` cannot exist without a credential (`cookie.ts:104-111`) and refuses an empty one at
  prepare time (`cookie.ts:127-133`), and its `mc_jwt` discriminator fixes the earlier `includes('=')` bug
  (`cookie.ts:59-73`).
- `requireHeadersForAuth` defaulting to `true` (`client.ts:228-239, 318-320`) turns the most likely
  credential-downgrade mistake into a loud, self-explaining throw instead of a mystery close.
- Supersession is a human decision, not a retry: `planRetry` refuses, `confirmationRequired` is emitted, and
  only `confirmSupersededReconnect()` sets `reclaimSupersededSession=true` (`client.ts:833-863, 875-894`).
- `auth/types.ts:52-56` states the log-leak rule for `note` and `cookie.ts:88-94` obeys it, and that is what
  makes finding 1 an internal inconsistency rather than an open design question.
