# Audit 06: `@mg.js/headless` client + transport

Scope: `packages/headless/src/client.ts`, `src/transport/{client,headers,runtime}.ts`, `src/reconnect.ts`, `src/index.ts`.
Method: full read of every file in scope, plus three throwaway runtime probes against the repo's own `ws`
mock server (`npx tsx`, files deleted after use). Every number below is measured, not inferred.

---

## 1. A reconnect that fails before the socket opens kills the chain forever, while `close` reported `willReconnect: true`: HIGH

- **Category:** correctness · **Breaking:** no
- **Evidence:** `client.ts:915` `scheduleReconnect()` starts with `if (this.reconnectTask !== null) return;`,
  and `this.reconnectTask` is only cleared in the task's `.finally` (`client.ts:937-941`). When the running
  retry fails, `openConnection`'s catch (`client.ts:761-766`) calls `handleSyntheticClose` → `handleClose`
  → `policy.planRetry` → `afterClose` → `scheduleReconnect` (`client.ts:803, 862`), all from *inside* that
  task, so the guard drops the plan silently. `client.ts:805` has already emitted
  `close {willReconnect: true}`.
  Probe (mock server, 4400 close, then the next attempt fails in `resolver.resolveDetailed()`):
  `upgrades=1 ready=false stopped=null isConnecting=false`; events
  `['close code=4400 willReconnect=true', 'reconnect plan.attempt=1 delay=20', 'close code=1006 willReconnect=true']`.
  No fourth event, no further upgrade.
- **Why it matters:** any transient failure on the retry path, whether an offline version fetch, DNS/ECONNREFUSED,
  `NoWebSocketError` or the `requireHeadersForAuth` throw, silently converts an infinite-retry client into a
  dead one after exactly one attempt. `stopped` is never emitted and `client.stopped` stays `null`, so a
  host has no signal at all: the documented default (`maxAttempts: Infinity`) is a lie.
- **Fix:** stop routing the retry result through the same guard. Make `handleClose`/`afterClose` return the
  `BackoffPlan | null` instead of calling `scheduleReconnect`, and have one loop consume it:
  `private async runRetryLoop(plan: BackoffPlan, analysis: CloseAnalysis): Promise<void>` that awaits
  `ReconnectPolicy.sleep`, calls `openConnection`, and re-plans from the returned plan on failure. Then
  `client.ts:915`'s guard can be deleted (or keyed on an epoch so only a *concurrent* schedule is refused).

## 2. An injected `webSocketFactory` is assumed header-capable, disabling the `requireHeadersForAuth` guard: HIGH

- **Category:** security / api-design · **Breaking:** no
- **Evidence:** `runtime.ts:168-176` returns `supportsHeaders: true` for *any* injected factory
  (`description: 'injected WebSocket constructor'`, documented as an assumption that it honours an
  `options.headers` bag), and
  `client.ts:669-675` gates both the thrown error and the warning on `runtime.supportsHeaders`. The caller
  has no way to declare the opposite.
  Probe: `new HeadlessClient({ auth: new CookieAuthProvider({token:'probe-secret-jwt'}),
  webSocketFactory: globalThis.WebSocket })` → `connect()` **resolves**, `waitUntilReady()` resolves,
  `isReady=true`, no `headersUnsupported` event, and the mock server sees `cookie = null`, `origin = null`.
- **Why it matters:** this is precisely the failure `client.ts:229-243` says the package refuses to allow
  ("a downgrade would send a connection with no credential at all and the server would close it with a bare
  4840 SessionExpired"). Passing the global (or an undici/polyfill constructor) explicitly is the natural
  mistake the docs invite ("pass `import('ws').WebSocket`"), and it silently produces an anonymous session
  reported as ready. `headers.ts:16-24` states the package "must not pretend"; here it does.
- **Fix:** add `supportsHeaders?: boolean` to `AcquireWebSocketOptions` and
  `webSocketSupportsHeaders?: boolean` to `HeadlessClientOptions`, thread it into
  `acquireWebSocketRuntime(options: AcquireWebSocketOptions): Promise<WebSocketRuntime>`, and
  short-circuit detection in the injected branch: `if (options.factory === globalCtor) supportsHeaders = false`.

## 3. `disconnect()` blocks for the entire pending backoff: MEDIUM

- **Category:** correctness · **Breaking:** no
- **Evidence:** `client.ts:562` awaits `awaitReconnect()`, which awaits `this.reconnectTask`
  (`client.ts:945-954`), a task whose first statement is `await ReconnectPolicy.sleep(plan)`
  (`client.ts:930`, `reconnect.ts:341-346`), and that sleep is explicitly not cancellable.
  Probe: `reconnect: {baseDelayMs: 5000, maxDelayMs: 5000}`, force-close 4400, then `disconnect()` took
  **5256 ms**.
- **Why it matters:** with defaults (`supersededBaseDelayMs: 30_000`, `maxDelayMs: 60_000`) a shutdown in
  the middle of a superseded backoff hangs the caller for up to a minute; `destroy()` inherits it. The code
  already refuses to let the *close wait* hang (`client.ts:567-568` bounds it at 300 ms), but this path has the
  same hazard unbounded.
- **Fix:** make the sleep interruptible: `static async sleep(plan: BackoffPlan, signal?: AbortSignal)`
  holding the timer handle and rejecting/returning on `abort`; add `private readonly retryAbort =
  new AbortController()` to `HeadlessClient` and abort it at the top of `disconnect()`.

## 4. The superseded backoff branch omits the post-jitter `maxDelayMs` clamp: MEDIUM

- **Category:** consistency / correctness · **Breaking:** no
- **Evidence:** `reconnect.ts:138` returns
  `Math.max(0, Math.round(bounded * jitterFactor(config.jitter, random)))`, bounded and jittered but **not**
  clamped, while the ordinary branch at `reconnect.ts:174-177` does
  `Math.min(config.maxDelayMs, ...)`, and the comment at `reconnect.ts:170-173` states clamp-after-jitter is
  the required invariant ("with the default `jitter: 0.25` a documented 60s cap yields up to 75s").
  Measured with `DEFAULT_RECONNECT_POLICY` and `random: 1`: attempt 2 → 37 500 ms (base is 30 000),
  attempts 3+ → **75 000 ms** with `maxDelayMs: 60_000`; the ordinary branch returns exactly 60 000.
- **Why it matters:** one of the two branches silently breaks the cap the class documents as a server-politeness
  contract, and `plan.capped` is `true` while `delayMs > maxDelayMs`, a self-contradictory plan to any
  consumer that trusts either field.
- **Fix:** wrap the superseded return in the same clamp:
  `delayMs: Math.min(config.maxDelayMs, Math.max(0, Math.round(bounded * jitterFactor(config.jitter, random))))`.

## 5. `ReconnectPolicy` counts retries; `computeBackoff` expects 1-based connection numbers: MEDIUM

- **Category:** correctness / api-design · **Breaking:** yes
- **Evidence:** `nextAttempt` only ever runs from `planRetry` (`reconnect.ts:267-274, 330`), so the counter
  advances only when a retry is planned; the initial connection is never counted. `reconnect.ts:62-68`
  claims the opposite ("Attempt 1 is the *first* connection; the first reconnect is attempt 2 ... the same
  number is used for the URL and for the backoff, and the two can never disagree"), and `client.ts:631,645`
  writes `clientConnectionAttempt = 2` into the URL of that same first retry. `computeBackoff`'s
  `step = max(0, attempt - 2)` (`reconnect.ts:164`) then sees 1, so its documented sequence
  `1500, 3000, 6000` is measurably `1500, 1500, 3000` (verified: `computeBackoff` with attempts 1,2,3 →
  1500, 1500, 3000). `backoff.test.ts:216-220` asserts `attempt === 1` for the first retry, baking the
  wrong convention in, so the suite cannot catch it.
- **Why it matters:** one extra un-backed-off retry before escalation (less polite than documented), the
  `reconnect` event's `plan.attempt` is off by one against the connection the URL actually asked for, and
  `stats.reconnectAttempt` disagrees with `stats.connectionAttempt` for the whole life of the client.
- **Fix:** pass the connection number in and delete the private counter's dual role:
  `planRetry(close: CloseAnalysis, connectionAttempt: number): BackoffPlan | null` and
  `nextAttempt(close: CloseAnalysis | null, connectionAttempt: number): BackoffPlan`, called from
  `client.ts:803` as `this.policy.planRetry(analysis, this.connectionAttemptValue)`.

---

## Other observations (not scored)

- **No read-idle watchdog / client heartbeat.** The only timer in the transport is the open timeout
  (`transport/client.ts:301-315`); nothing notices an absence of inbound frames, and `send()` only checks
  `readyState === 'open'` (`transport/client.ts:326-332`). A half-open socket (NAT rebind, host death
  without FIN) leaves `isReady === true` indefinitely and commands vanish into the kernel buffer.
- **`disconnect()` does not await `this.connectTask`** (`client.ts:556-584`), so a `disconnect()` racing an
  in-flight `connect()` can return while `openConnection` still creates a transport, sets `this.core` and
  emits `open`/`ready` afterwards; `destroy()`'s `activeTransport?.dispose()` (`client.ts:589`) is a no-op
  if the transport does not exist yet, leaking that socket.
- **`coldStartFastRetries` conflates two policies** (`reconnect.ts:150` fast-retry window and
  `reconnect.ts:326` bounded-close cap) despite the comment claiming they "stay independent of each other's
  defaults", so raising it to 10 also lets a bad cookie be retried 9 times.

## What works well here

- Close-code policy really is single-sourced: `classifyClose` → `analyzeClose`, used by both `handleClose`
  and `confirmSupersededReconnect`, so the 4250/4300-vs-heartbeat rule cannot drift; reclaiming is gated
  behind an explicit human confirmation and never auto-retried.
- Header honesty is designed, not accidental: `buildConnectHeaders` always computes the set, and the
  header-less global is reported through `onHeadersUnsupported`/`headersUnsupported` rather than pretended.
- Every socket listener body is wrapped and every subscriber loop is isolated, so no handler can throw into
  an `EventTarget` and kill a long-running bot; `handleClose` is idempotent per generation.
- Pending commands are not leaked across a reconnect: `ClientCore.dispose()` → `rejectAllPending`
  (`common/src/client.ts:205-213`) runs before the new core is built, so in-flight handles settle rather
  than hang.
- The reconnect trigger point (`Welcome`, not socket `open`) is the right one, and the reasoning is
  documented with the alternative it rejects.
