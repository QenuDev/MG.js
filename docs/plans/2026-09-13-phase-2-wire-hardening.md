# Phase 2: Wire hardening (invariants I4, I5) implementation plan

> **For agentic workers:** this is the step-by-step plan for Phase 2 of
> `docs/plans/2026-09-13-code-consistency.md`. Execute it task by task with
> `superpowers:executing-plans` or `superpowers:subagent-driven-development`. Steps use checkbox
> (`- [ ]`) syntax. **Every test-first step must be observed failing before the fix is written**, for the
> reason stated in the task; do not "write both halves and watch them pass".

**Phase goal:** close the two invariant gaps DESIGN §6 records for the wire boundary, which are I4 ("untrusted
data never becomes a key, an index, or code") and I5 ("every wait has a deadline; every buffer has a bound").
The closure bounds every inbound buffer, enforces the declared byte cap for real, takes the redirect and URL
policy seriously, bounds the caches that hold disposable resources, and makes the reconnect loop both
cancellable and honest about what it is doing.

**Spec:** `docs/DESIGN.md` §6 I4 (`:425-439`) and I5 (`:440-449`) name the defects verbatim, including
several line numbers that predate Phases 0 and 1; where they have drifted, this plan cites the current
line. Evidence: `docs/audit/05-headless-auth-session.md` §6, `06-headless-client-transport.md` §1/§3/§4,
`03-common-client-actions.md` F2/F3/F5, `04-common-catalog.md` §3, `20-xcut-duplication.md` §1/§8,
`23-xcut-security.md` §5. **All `file:line` references below were re-verified against the working tree
after Phase 1 landed** (the phase close); the audit reports' own numbers are stale in several places.

**Baseline:** Phases 0 and 1 are committed; `npm run verify` is green (500 tests, 0 fail, 0 skipped).

> **Correction, Phase 2 close (2026-09-13).** The "500 tests" figure is stale. The tree Phase 2 actually
> branched from (the last Phase 1 commit) reported **566 tests (138 bootstrapped / 294 common /
> 134 headless)**, 0 fail, 0 skipped. Phase 2 closes at **736 tests (181 / 386 / 169)**, 0 fail, 0 skipped,
> bundle `298233 B` (291.2 KiB) within budget. The same stale number appears again in the Verification plan;
> see "Phase 2 close" at the end of this document for the nine SHA groups and the review closures.

## Global constraints (inherited from the master plan, not repeated per task)

- NodeNext ESM: **relative imports end in `.js`**. `strict` + `noUncheckedIndexedAccess` +
  `noUnusedLocals` + `noUnusedParameters`.
- **Banned everywhere, including tests:** `any`, `as any`, `@ts-ignore`, `@ts-expect-error`, non-null `!`.
- Tests: `node:test` + `node:assert/strict`, `describe`/`it`, under `packages/<pkg>/tests/**` mirroring the
  source path. Optional properties must be narrowed (`const x = obj.note ?? ''`); **only
  `tsc -p tsconfig.tests.json` typechecks tests**; `tsx` running them does not, so a type error in a test
  is invisible to `npm test` and must be caught by `npm run typecheck`.
- Biome: `lineWidth: 110`, recommended preset. `docs/` is excluded from lint.
- `common` is intended to be platform-free, and `packages/common/tsconfig.json` inherits
  `"lib": ["ES2022", "DOM", "DOM.Iterable"]` from `tsconfig.base.json`. Use web-standard globals only
  (`TextEncoder`/`TextDecoder`/`Response`/`ReadableStream` are fine, and `fetch` is *injected* nowhere:
  `catalog/http.ts` calls the global). **Do not introduce `node:*` or `Buffer` in `common`.**
- Gate: `npm run verify` = `lint` → `typecheck` (src + tests) → `build` → `test` → `size`. **Every task
  ends with one commit that leaves it green.**
- Breaking changes are allowed (pre-1.0) and must be named in the commit body.

## Ordering rationale

Every task is one commit and the suite must be green between them, so all nine run sequentially. The
order is chosen to minimise rebasing on the same files and to respect one real dependency:

| Task | Files touched | Why it is here |
|---|---|---|
| **2.1** Frame ceiling | `common/protocol/codec.ts`, `common/client.ts`, `headless/transport/client.ts` | Changes the exported `ParseResult` union and the core's inbound switch. Landing it first means no later task writes against the old shape. |
| **2.2** Real byte cap | `common/catalog/http.ts` | Independent of 2.1. Must precede 2.3 (same file). |
| **2.3** Redirect + URL policy | `common/catalog/http.ts`, `common/protocol/connect-url.ts`, `common/catalog/remote-json-source.ts` | Builds directly on 2.2's rewrite of the same request function. |
| **2.4** Bounded caches | `bootstrapped/render/sprite.ts` | **Fully independent**: a different package with no shared symbol. Can be executed in parallel by a second engineer; it is placed here because it shares no file with anything else. |
| **2.5** Cancellable waits | `headless/reconnect.ts`, `headless/client.ts`, `common/client.ts` | Touches the reconnect loop; 2.6 builds on the abort plumbing (the parked plan must not be rescheduled after an abort). |
| **2.6** Honest reconnect accounting | `headless/client.ts` | Same two functions as 2.5 (`scheduleReconnect`/`afterClose`); must land after. |
| **2.7** Reconnect + version | `headless/room-socket.ts`, `headless/version.ts`, `headless/client.ts` | The RoomSocket reconnect surface is only meaningful once 2.6 makes the chain survive a failed attempt; the version half extends `afterClose` again. |
| **2.8** Canonical frontier + readiness gate | `common/client.ts`, `common/protocol/sequencer.ts` | Last in `common` so it rebases on 2.1's switch and 2.5's `waitUntilReady` change. |
| **2.9** Command-ledger reconciliation | `common/client.ts`, `common/protocol/sequencer.ts` | Same two files as 2.8; one more pass over `settlePending`. |

Independent pairs if two engineers work in parallel: **{2.1, 2.2 → 2.3}** with **{2.4}**; then
**{2.5, 2.6, 2.7}** with **{2.8, 2.9}** (2.8/2.9 and 2.1 both touch `common/client.ts`, so they are
serialised against it).

---

## Task 2.1: Frame ceiling (`MAX_FRAME_BYTES`)

**Status: complete.** Landed · review closed. The review close corrected two claims in
this task's own text; see the correction notes below.

**Files:** modify `packages/common/src/protocol/codec.ts`, `packages/common/src/client.ts`,
`packages/headless/src/transport/client.ts`; create `packages/common/tests/protocol/codec.test.ts`,
`packages/headless/tests/transport-frame-cap.test.ts`.

**Problem.** Nothing bounds an inbound frame, in any transport. `parseFrame` parses whatever string it is
handed, with no length check (`codec.ts:57-80`):

```ts
export function parseFrame(raw: string): ParseResult {
  if (raw === undefined || raw === null || raw.length === 0) return { kind: 'empty' };
  if (isKeepalivePing(raw)) return { kind: 'keepalive' };
  let value: unknown;
  try {
    value = JSON.parse(raw);            // codec.ts:63: no cap
```

The frame reaches it after `decodeSocketPayload` has decoded an arbitrary payload
(`headless/src/transport/runtime.ts:244-257`), and the unparsed path *retains the whole frame in a typed
event*: `common/client.ts:501-502` slices to 200 characters for the debug **log** only, then emits the
unsliced value:

```ts
this.logger.debug('unparsed frame', { raw: raw.slice(0, 200) });
this.emit('unparsed', { raw });          // common/client.ts:502
```

A repository-wide grep for `maxFrame|MAX_FRAME|frameSize|maxMessage` returns nothing (audit 23 `:177-178`),
and `headless` never sets a `ws` `maxPayload` (audit 05 §6). One frame from the far end (or from a MITM
on a `tls: false` deployment) is buffered by the runtime, copied by the decoder, retained by the event and
re-parsed by every listener, with no cap and no disconnect.

**Change.**

1. `codec.ts`: add the named bound and a byte counter, and a result kind that carries **no payload**:

   ```ts
   /**
    * The largest inbound frame this client will look at, in bytes.
    *
    * 8 MiB is ~3x the largest full-state `Welcome` observed live and matches the catalogue layer's
    * response cap, so it cannot reject a legitimate frame on either transport. It is a *byte* count, not
    * a string length: `raw.length` is UTF-16 code units and under-counts non-ASCII frames by up to 2x.
    */
   export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

   /**
    * Count the UTF-8 bytes in `value`, stopping as soon as the count exceeds `limit`.
    *
    * Hand-rolled rather than `new TextEncoder().encode(value).length`: on the reject path
    * that would allocate a second copy of the very frame we are refusing to look at. Iterating code
    * points makes the count exact for surrogate pairs.
    */
   export function utf8ByteLength(value: string, limit = Number.POSITIVE_INFINITY): number {
     let bytes = 0;
     for (const char of value) {
       const code = char.codePointAt(0) ?? 0;
       bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
       if (bytes > limit) return bytes;
     }
     return bytes;
   }
   ```

> **Correction (2.1, Phase 2 close).** Two claims in the `MAX_FRAME_BYTES` comment quoted above are **false
> against the tree**, so the shipped comment was rewritten to say so. No frame size was ever recorded
> anywhere in this repository, so "8 MiB is ~3x the largest full-state `Welcome` observed live" has no
> measurement behind it; the shipped comment (`packages/common/src/protocol/codec.ts:66-74`) states 8 MiB is
> a **chosen** bound whose only provenance is the catalogue layer's own 8 MiB response cap
> (`packages/common/src/catalog/http.ts`, `DEFAULT_MAX_RESPONSE_BYTES` / `FetchJsonOptions.maxBytes`), and it
> calls that provenance "not an observation". "It cannot reject a legitimate frame on either transport" is likewise unsupported and
> is not claimed by the shipped comment; the honest statement is that 8 MiB is the same order as the
> catalogue cap and is expected to be far above real traffic (a live `verify:socket` should print no
> over-the-cap warning). Separately, the `utf8ByteLength` doc quoted above was also corrected: on the
> early-return path the value is a **lower bound** on the frame's true byte length (`limit + 1 .. limit + 4`
> when a multi-byte code point straddles the cap), not its size.

Add to `ParseResult` (`codec.ts:24-34`): `| { kind: 'oversized'; bytes: number; limit: number }`. There is
   no `text`/`raw` member, so an oversized frame **cannot be retained** by a caller.

   `parseFrame` gains an options bag and checks the cap first, before `isKeepalivePing` and before
   `JSON.parse`:

   ```ts
   export function parseFrame(raw: string, options: { maxBytes?: number } = {}): ParseResult {
     if (raw === undefined || raw === null || raw.length === 0) return { kind: 'empty' };
     const limit = options.maxBytes ?? MAX_FRAME_BYTES;
     const bytes = utf8ByteLength(raw, limit);
     if (bytes > limit) return { kind: 'oversized', bytes, limit };
     if (isKeepalivePing(raw)) return { kind: 'keepalive' };
     // …unchanged from here
   ```

2. `common/client.ts`: add `oversizedFrame: [{ bytes: number; limit: number }]` to the `ClientEvents` map
   (`client.ts:58`), and handle the new kind in `handleRawFrame`'s switch (`:494-506`) with **no retention**:

   ```ts
   case 'oversized':
     this.logger.warn('inbound frame over the cap; dropped unparsed', {
       bytes: parsed.bytes,
       limit: parsed.limit,
     });
     this.emit('oversizedFrame', { bytes: parsed.bytes, limit: parsed.limit });
     return;
   ```

   Because the switch is not exhaustive-checked by the compiler, grep for other `parsed.kind` / `ParseResult`
   consumers and update them: `packages/common/src/client.ts` is currently the only one.

3. `headless/transport/client.ts`: enforce it at the socket too, so the frame is never even decoded for the
   `ws` runtime. Add `maxFrameBytes?: number | undefined` to `StandaloneTransportOptions` (`:67-100`), store
   it with a default of `MAX_FRAME_BYTES` in the constructor (`:156-162`), pass `maxPayload: this.maxFrameBytes`
   in `constructorOptions` next to the headers (`:232-235`: `ws` enforces this at the protocol layer;
   browsers/undici ignore the unknown option, so the manual check is necessary), and in
   `handleMessage` (`:457-476`) check before `emitMessage`:

   ```ts
   const bytes = utf8ByteLength(raw, this.maxFrameBytes);
   if (bytes > this.maxFrameBytes) {
     this.lastErrorValue = new Error(
       `Inbound frame of ${bytes} bytes exceeds the ${this.maxFrameBytes}-byte cap.`,
     );
     this.manualClose = false;
     try {
       this.socket?.close(1009, 'message too big');
     } catch {
       // The socket is already unusable; the close event will settle the state.
     }
     return;
   }
   ```

**Test first.**

- Create `packages/common/tests/protocol/codec.test.ts`:
  - `it('parses a frame exactly at the byte limit')`: build `const raw = JSON.stringify({ type: 'Pong' })`,
    pad it with spaces so its UTF-8 length is exactly `limit`, `parseFrame(raw, { maxBytes: limit })` →
    `kind === 'message'`.
  - `it('refuses a frame one byte over the limit without parsing it')`: same frame plus one byte →
    `kind === 'oversized'`, `bytes === limit + 1`, `limit === limit`, and
    `assert.equal('text' in result, false)` / `'raw' in result === false`.
  - `it('counts bytes, not UTF-16 code units')`: a frame made of `'é'` (2 UTF-8 bytes, 1 UTF-16 unit) whose
    byte count is `limit + 1` while `raw.length < limit`: assert `kind === 'oversized'`. **This is the
    assertion that cannot pass today.**
  - `it('still accepts a hostile-looking but small frame')`: `'__proto__'`-laden JSON under the cap parses
    as before (proves the cap is a bound, not a filter).
  - **Observed failure before the fix:** `tsx` ignores the second argument, so `parseFrame` returns
    `{ kind: 'message' }` and the `kind === 'oversized'` assertions fail with
    `expected 'message' to be 'oversized'`; `npm run typecheck` also reports `TS2554: Expected 1
    arguments, but got 2`. (Both are correct observations; record both.)
- Add to `packages/common/tests/client.test.ts` (reuse its existing fake-transport harness; read the file
  before writing): `it('drops an oversized frame and records the outcome')`: feed a `raw` string of
  `MAX_FRAME_BYTES + 1` bytes through the core's message path; assert one `oversizedFrame` event with
  `{ bytes: MAX_FRAME_BYTES + 1, limit: MAX_FRAME_BYTES }`, **zero** `unparsed` events, and that the emitted
  payload has no `raw`. Today: one `unparsed` event carrying the whole frame → FAIL.
- Create `packages/headless/tests/transport-frame-cap.test.ts`, modelled on
  `packages/headless/tests/transport-keepalive.test.ts` (read it first for the fake-socket harness):
  `it('closes the socket instead of forwarding an oversized frame')`: construct the transport with
  `maxFrameBytes: 32`, emit a 64-byte message from the fake socket, assert the message handler was never
  called, `socket.close` was called with `1009`, and `transport.lastError` is an `Error` mentioning the cap.
  Today: the message handler receives the frame → FAIL.

- [x] **Step 1:** write the three failing tests; run
      `npm test -w @mg.js/common` and `npm test -w @mg.js/headless`; record the failures verbatim.
- [x] **Step 2:** add `MAX_FRAME_BYTES`, `utf8ByteLength`, the `oversized` variant and the `parseFrame`
      option to `codec.ts`.
- [x] **Step 3:** add the `oversized` case and the `oversizedFrame` event to `common/client.ts`.
- [x] **Step 4:** add `maxFrameBytes`/`maxPayload` and the `handleMessage` guard to
      `headless/transport/client.ts`.
- [x] **Step 5:** `npm run verify` green.
- [x] **Step 6:** `git commit -m "fix(common,headless): bound an inbound frame before it is parsed"`: body
      names the new `ParseResult` member (an additive but public union change) and the new
      `oversizedFrame` event.

**Acceptance.** The ±1 boundary test, the multibyte test and the no-retention assertion pass; the transport
test proves `1009` + no forward; `npm run verify` exit 0. Live: `npm run verify:socket` must print no
`inbound frame over the cap` warning, which is the evidence that 8 MiB does not clip real traffic.

**Risk / revert.** An oversized frame now closes the socket with `1009`, which `analyzeClose` classifies as
reconnect-worthy. A hostile peer can therefore drive a *bounded* reconnect cycle (backoff + `maxAttempts`)
rather than an unbounded allocation. The `bootstrapped` path cannot close the game's socket, so there the
core's `oversized` case is the whole defence and it drops without closing. That asymmetry is by design and
should be stated in the `oversizedFrame` doc comment. Revert is a single commit: the constant, the variant
and the two call sites; no API is removed.

> **Correction (2.1, Phase 2 close).** The claim that on `bootstrapped` "the core's `oversized` case is the
> whole defence" is **false**, and Task 2.1 fixed it. The bootstrapped raw-socket scrape
> (`packages/bootstrapped/src/attach/raw-socket.ts`, `scrapeFrame`) sees each frame before the core and
> `JSON.parse`d any marker-bearing string over 24 bytes, so an over-cap frame was parsed on that path no
> matter what the core did with it. The same fix now bounds the scrape too, with the same
> `utf8ByteLength(data, MAX_FRAME_BYTES)` check and no second cap constant, and the `oversizedFrame` doc says
> what is actually true: the core bounds only what the core parses, so each earlier parser must bound as well.

---

## Task 2.2: A real byte cap in the catalogue fetch

**Status: complete.** Landed · follow-up (made `DEFAULT_MAX_RESPONSE_BYTES` reachable
from the catalog barrel and ignored `.logs/`).

**Files:** modify `packages/common/src/catalog/http.ts`; create
`packages/common/tests/catalog/http.test.ts`; possibly adjust fakes in `packages/common/tests/catalog.test.ts`.

**Problem.** The cap is a post-hoc assertion, not a bound (`http.ts:77-84`):

```ts
const text = await response.text();                                    // http.ts:77: whole body buffered
const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;                  // http.ts:78
if (text.length > maxBytes) {                                          // http.ts:79: UTF-16 units
  throw new HttpError(`Response from ${url} exceeded ${maxBytes} bytes (${text.length}).`, {
```

`options.maxBytes` is documented at `:21-22` as "Cap on the response size in bytes, to bound a hostile or
broken endpoint. Default 8 MiB", and the file header at `:5-6` claims the timeout and cap are what the
existing server lacks. Audit 04 §3 (`:66-77`) measured the three consequences: the whole body is buffered
first; `.length` is UTF-16 code units, so a multibyte response is rejected early while ~2x the cap of ASCII
gets through; and the non-2xx path calls `safeText(response)` (`:69`, `:109-115`) with **no cap at all**, so
an error body of any size is buffered and then truncated to 300 characters for the preview. No test
exercises `maxBytes` today (grep of `packages/common/tests` finds no `maxBytes`).

**Change:** one new streaming reader used by both the success and error paths:

```ts
/** The default response cap, in bytes. Named so a caller and a test cannot disagree about it. */
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Read a response body, refusing to assemble more than `maxBytes`.
 *
 * Counts real bytes as they arrive and cancels the stream the moment the cap is passed, so `reader.cancel()`
 * tears the source down, so this is an abort rather than a truncation, and the bytes that were read are
 * discarded rather than decoded into a string. `content-length` is checked first when the server declares
 * one, which rejects a hostile body before a single byte is read.
 */
async function readCapped(response: Response, maxBytes: number, url: string): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > maxBytes) {
      throw new HttpError(`Response from ${url} declared ${size} bytes, over the ${maxBytes} cap.`, {
        status: response.status,
        url,
      });
    }
  }

  const body = response.body;
  if (body === null) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new HttpError(`Response from ${url} exceeded ${maxBytes} bytes (aborted at ${total}).`, {
          status: response.status,
          url,
        });
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    // Cancels the underlying source on the overflow path and is a no-op once the stream is done.
    await reader.cancel().catch(() => undefined);
  }
}
```

Then: move `const maxBytes = options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;` above the `fetch` call
(`:63`), replace `:77` with `const text = await readCapped(response, maxBytes, url);`, pass
`onExceeded: () => controller.abort()` into `readCapped` (so the *request* is torn down, not just the
stream) and call it in the overflow branch, and rewrite `safeText` (`:109-115`) as
`async function safeText(response: Response, maxBytes: number, url: string): Promise<string | undefined>`
that returns `undefined` when `readCapped` throws (the error path's whole purpose is a 300-character
preview, so a capped read is the right read).

**Test first.** Create `packages/common/tests/catalog/http.test.ts` (mirrors `src/catalog/http.ts`):

- `it('aborts instead of buffering a body over the cap')`: stub `globalThis.fetch` (save and restore it in
  `afterEach`) with a function returning a real `Response` whose body is a `ReadableStream` that enqueues
  4 chunks of 64 bytes and records whether `cancel()` was called:

  ```ts
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 64;
      controller.enqueue(new Uint8Array(64).fill(0x41));
      if (pulled >= 256) controller.close();
    },
    cancel() { cancelled = true; },
  });
  ```

  Await `assert.rejects(fetchJson('https://example.test/x', { maxBytes: 100 }), HttpError)`. Assert
  `cancelled === true` (the abort), `pulled < 256` (the reader stopped early; this is the "abort, not
  truncation" assertion), and the message contains `exceeded 100 bytes`. **Today:** `response.text()`
  drains all 256 bytes, `text.length` (256) > 100 → the same `HttpError` type is thrown but `cancelled` is
  `false` and `pulled === 256` → FAIL on both counts.
- `it('counts bytes, not UTF-16 code units')`: a body of 60 `'é'` characters (120 bytes UTF-8,
  `length === 60`) with `maxBytes: 100`: assert it **rejects**. Today `60 > 100` is false, so it resolves →
  FAIL.
- `it('refuses a declared content-length over the cap without reading the body')`: a `Response` with
  `content-length: '4096'` and a stream whose `pull` records calls; assert rejects and `pulled === 0`.
  Today: the body is read → FAIL.
- `it('caps the error-path preview')`: a non-2xx `Response` with a 4096-byte body and `maxBytes: 64`;
  assert `HttpError.bodyPreview` is defined, its length is ≤ 300, and the reader was cancelled. Today:
  `safeText` buffers all 4096 → FAIL.
- `it('still parses a normal small response')`: the regression guard.

If `packages/common/tests/catalog.test.ts` stubs `fetch` with plain objects that only implement
`text()`/`json()` (read it first), update those fakes to real `new Response(body, { status, headers })`
objects in this commit, because the streaming reader requires `body`, and a plain-object stub would silently
reintroduce the unbounded path.

- [x] **Step 1:** write the five tests; run `npm test -w @mg.js/common`; record the failures.
- [x] **Step 2:** add `DEFAULT_MAX_RESPONSE_BYTES`, `readCapped`, and route both paths through it.
- [x] **Step 3:** `npm run verify` green (watch `tsc -b`: `ReadableStream`/`TextDecoder` come from the
      inherited DOM lib; do not add `@types/node` usage to `common`).
- [x] **Step 4:** `git commit -m "fix(common): the catalogue byte cap aborts the stream instead of checking a string length"`

**Acceptance.** The five tests pass; `npm run verify` exit 0. Live: `npm run verify:catalog` still passes
end to end (it is the only check that the real endpoints fit under 8 MiB).

**Risk / revert.** A `Response`-shaped stub without `body` now returns `''` rather than the body. That is
why the existing fakes are updated in the same commit; grep `packages/*/tests` for `text:`/`json:` fetch
stubs before finishing. Revert is one file.

---

## Task 2.3: Redirect and URL policy

**Status: complete.** Landed · review closed.

**Files:** modify `packages/common/src/catalog/http.ts`, `packages/common/src/protocol/connect-url.ts`,
`packages/common/src/catalog/remote-json-source.ts`; extend `packages/common/tests/connect-url.test.ts`;
create `packages/common/tests/catalog/remote-json-source.test.ts`.

**Problem, three parts.**

**(a) No redirect policy.** `http.ts:63-66` passes no `redirect`, so the platform default (`follow`, up to
~20 hops) applies:

```ts
const response = await fetch(url, {
  headers: { ...DEFAULT_HEADERS, ...options.headers },
  signal: controller.signal,
});
```

A correctly pinned origin is therefore bypassable by `302 Location: http://127.0.0.1:9200/` (audit 23 §5
`:138-146`).

**(b) The URL itself is unvalidated concatenation.** `remote-json-source.ts:69-70` and `:86` build every
request as `` `${this.baseUrl}${path}` `` from two inputs with no scheme check, host pin or path
normalisation. Audit 23 measured: `baseUrl: ''` + `paths: { plants: 'http://169.254.169.254/latest/meta-data/' }`
fetches link-local metadata; `baseUrl: 'https:'` + `paths: { plants: '//evil.test/x' }` retargets the
origin. `RemoteJsonSource` is an exported, documented surface ("a local instance, a self-hosted mirror, or a
different implementation").

**(c) The connect URL interpolates untrusted path segments.** `connect-url.ts:56`:

```ts
const url = new URL(`wss://${host}/version/${options.version}/api/rooms/${room}/connect`);
```

`encodeQueryValue` covers only the *query* copies of these values; the path is raw. Measured against the
real `URL` implementation in this repo's Node build:

| `room` | resulting URL |
|---|---|
| `abc` | `wss://magicgarden.gg/version/1.0/api/rooms/abc/connect` |
| `../../evil` | `wss://magicgarden.gg/version/1.0/evil/connect`: **the rooms path is gone** |
| `//evil` | `.../api/rooms///evil/connect`: an empty segment |
| `a?x=1` | `.../api/rooms/a?x=1/connect`: **query injection**; `/connect` is no longer the path |
| `a#frag` | `.../api/rooms/a#frag/connect`: everything after `#` is a fragment, so `/connect` is never sent |

Same for `version`: `'../../x'` yields `wss://magicgarden.gg/x/api/rooms/r/connect`. `buildConnectUrlDetailed`
is the one URL builder both clients use (`headless/client.ts` and `room-socket.ts:337`), so this is the
single place to fix.

**Change.**

1. `http.ts`: add `redirectPolicy?: 'error' | 'follow' | 'manual'` to `FetchJsonOptions` (`:16-23`),
   documented as "default `'error'`: a redirect from a pinned origin is a rejection, not a hop. `'manual'`
   is for a caller that re-asserts the origin itself; see the Findings section for the allow-list
   follow-up." Pass `redirect: options.redirectPolicy ?? 'error'` into the `fetch` options.
2. `remote-json-source.ts`: validate both inputs in the constructor:
   ```ts
   const base = new URL(options.baseUrl);
   if (base.protocol !== 'https:') {
     throw new Error(`RemoteJsonSource: baseUrl must be an https origin, got ${base.protocol}`);
   }
   for (const [kind, path] of Object.entries(this.paths)) {
     if (new URL(path, base).origin !== base.origin) {
       throw new Error(
         `RemoteJsonSource: the "${kind}" path ${JSON.stringify(path)} leaves the base origin ` +
           `${base.origin}. Paths must be relative.`,
       );
     }
   }
   ```
   Do not silently normalise or strip a leading `//`; refusal is required.
3. `connect-url.ts:56`: percent-encode both path segments:
   ```ts
   // `URL`'s own path handling is tolerant of `..`, `?`, `#` and empty segments, which lets a caller's
   // room name rewrite the request shape (measured: `../../evil` removes the `/api/rooms/` prefix and
   // `a?x=1` injects a query parameter). Encoding each segment is the whole fix; for the `[A-Za-z0-9_-]`
   // slugs the live host issues it is byte-identical to the previous behaviour.
   const url = new URL(
     `wss://${host}/version/${encodeURIComponent(options.version)}/api/rooms/${encodeURIComponent(room)}/connect`,
   );
   ```
   Leave `host` alone in this task: it comes from caller configuration, and a regex validator would reject
   legitimate IPv6 literals. See the Findings section.

**Test first.**

- Extend `packages/common/tests/connect-url.test.ts` with `describe('hostile room and version values')`:
  - `it('keeps a hostile room name inside its path segment')`: for each of `'../../evil'`, `'//evil'`,
    `'a?x=1'`, `'a#frag'`, `'a b'`: `const parsed = new URL(buildConnectUrlDetailed({ version: '1.0', room }).url)`
    and assert `parsed.pathname === '/version/1.0/api/rooms/' + encodeURIComponent(room) + '/connect'`,
    `parsed.hash === ''`, and `parsed.searchParams.get('x') === null`.
    **Today:** `../../evil` gives `pathname === '/version/1.0/evil/connect'` → FAIL;
    `a?x=1` gives `searchParams.get('x') === '1/connect'` → FAIL; `a#frag` gives `hash === '#frag'` → FAIL.
  - `it('encodes a hostile version in the path')`: `version: '../../x'` →
    `parsed.pathname === '/version/..%2F..%2Fx/api/rooms/r/connect'`.
  - `it('leaves an ordinary room and version byte-identical')`: `{ version: '1157', room: 'abcde12345' }`
    → `url === 'wss://magicgarden.gg/version/1157/api/rooms/abcde12345/connect?...'` with the existing
    query assertions unchanged. **This is the live-host regression guard; do not skip it.**
- Add to `packages/common/tests/catalog/http.test.ts` (from 2.2):
  - `it('tells fetch to refuse a redirect')`: stub `fetch` capturing `init`; `await fetchJson(url)`; assert
    `(init as RequestInit).redirect === 'error'` and that a real `new Response(null, { status: 302 })` makes
    the call reject with `HttpError('HTTP 302 ...')`. **Today:** `init.redirect === undefined` → FAIL.
  - `it('honours an explicit follow policy')`: `{ redirectPolicy: 'follow' }` → `init.redirect === 'follow'`.
- Create `packages/common/tests/catalog/remote-json-source.test.ts`:
  - `it('refuses a protocol-relative path')`: `new RemoteJsonSource({ baseUrl: 'https://a.test', paths: { plants: '//evil.test/x' } })`
    → `assert.throws(..., /leaves the base origin/)`.
  - `it('refuses a non-https baseUrl')`: `baseUrl: 'http://a.test'` → throws.
  - `it('accepts the default construction')`: the no-argument constructor still works (read
    `remote-json-source.ts` for the real default `baseUrl`; the in-repo callers pass a hardcoded https
    origin).

- [x] **Step 1:** write the tests; run `npm test -w @mg.js/common`; record the failures.
- [x] **Step 2:** enforce `redirect: 'error'` in `http.ts`.
- [x] **Step 3:** validate `baseUrl`/`paths` in `remote-json-source.ts`.
- [x] **Step 4:** encode both path segments in `connect-url.ts`.
- [x] **Step 5:** `npm run verify` green.
- [x] **Step 6:** `git commit -m "fix(common): refuse redirects and encode the connect URL's path segments"`: body
      names the breaking default change for a caller that relied on redirect-following, and records
      the `npm run verify:catalog` measurement.

**Acceptance.** Both hostile-URL tests plus the byte-identical ordinary-URL test; the redirect test; the
constructor tests; `npm run verify` exit 0. Live: `npm run verify:catalog`, the check that proves the
real host does not redirect. **If it fails on a 3xx, do not weaken the test:** change the default to
`'manual'` and re-assert the origin on each hop inside `fetchJson` (the audit's own alternative), and record
the measured `Location` in the commit body. `npm run probe:guest` is the encoding oracle for the URL change:
it reports the exact connect URL a working third-party client builds and the server's verdict on it.

**Risk / revert.** `redirect: 'error'` changes the behaviour of an exported option; the in-repo callers are
the hardcoded `PlatformApiSource` origin and `verify:catalog` proves it. Room/version encoding is a no-op for
alphanumeric slugs, pinned by the ordinary-URL test. Revert is one commit; `connect-url.ts` is a pure
function with an existing dedicated test file, so the facade question does not arise.

> **Correction (2.3, Phase 2 close).** `npm run probe:guest` is **not** the encoding oracle for this URL
> change. Its subject is the `anonymousUserStyle` **JSON-quoting** difference
> (`scripts/probe-guest-encoding.ts:1-38`, `:90`, `:328`): it holds the version and room at ordinary
> alphanumeric slugs and classifies whether each quoting variant is accepted, so it never exercises a
> hostile `version`/`room` path segment. The path-segment fix is pinned instead by the hostile-value cases in
> `packages/common/tests/connect-url.test.ts` (added) and by `assertSinglePathSegment` in
> `packages/common/src/protocol/connect-url.ts`.

---

## Task 2.4: Bounded texture cache

**Status: complete.** Landed · review closed.

**Files:** modify `packages/bootstrapped/src/render/sprite.ts`; create
`packages/bootstrapped/tests/render/sprite.test.ts`.

**Problem.** The texture cache is an unbounded `Map` that orphans the value it replaces. `sprite.ts:75-97`:

```ts
export function createTextureCache(): TextureCache {
  const store = new Map<string, CachedTexture>();
  return {
    get: (key) => store.get(key),
    set: (key, entry) => {
      store.set(key, entry);            // sprite.ts:80: unbounded, no eviction, no destroy
    },
```

and `textureFrom` writes through it twice: the reuse path re-`set`s the same key with a bumped `useCount`
(`:150`) and the fresh-decode path `set`s a brand-new texture over whatever was there (`:170`). Nothing
removes an entry except the explicit `release(key, destroy = false)` (`:82-94`, `destroy` opt-in), so:

- a `refresh: true` loop (`:111-112`) leaks **one GPU texture per call**: the replaced `CachedTexture` is
  dropped with no `destroy()`;
- distinct keys are unbounded, and the documented idiom passes the **base64 payload itself as the key**
  (`:24-26`), so every entry also retains an image-sized string;
- the module doc states the design out loud (`:58-59`): "unbounded rather than LRU because the realistic key
  count is 'the handful of icons this mod draws'".

DESIGN I5 names this defect verbatim. I verified the rest of the tree (inventory in the Findings section):
every other map/set is either already capped (`renumber.ts:147` at `MAX_REMEMBERED_IDS = 256`,
`log.ts:63` at 500), keyed by a closed enum, a `WeakMap`, or holds no disposable value. This is the only
cache that must change in this task.

**Change.**

- Extend the interface (`:63-72`): add `readonly maxEntries: number;` and `size(): number;`.
- `createTextureCache(options: { maxEntries?: number } = {})`:
  ```ts
  /**
   * How many textures one cache holds before the oldest is evicted.
   *
   * 256 matches the renumberer's `MAX_REMEMBERED_IDS`, and is two orders of magnitude above the "handful
   * of icons" the cache was designed for, so a legitimate mod never reaches it.
   */
  export const DEFAULT_TEXTURE_CACHE_ENTRIES = 256;
  ```
  and use it as the default, so it is not an inert export:
  ```ts
  export function createTextureCache(options: { maxEntries?: number } = {}): TextureCache {
    const maxEntries = options.maxEntries ?? DEFAULT_TEXTURE_CACHE_ENTRIES;
    const store = new Map<string, CachedTexture>();
    return { maxEntries, /* …, plus `size: () => store.size,` */ };
  }
  ```
- Extract the guarded destroy currently inlined in `release` (`:86-92`) into
  `function destroyTexture(entry: CachedTexture): void` and use it in both places.
- `set(key, entry)`:
  ```ts
  set: (key, entry) => {
    const previous = store.get(key);
    // Replacing a *different* texture orphans it. `textureFrom`'s reuse path re-sets the same texture
    // object with a bumped `useCount`, and destroying there would kill a texture still on screen.
    if (previous !== undefined && previous.texture !== entry.texture) destroyTexture(previous);
    store.set(key, entry);
    while (store.size > maxEntries) {
      const oldest = store.keys().next().value;   // Map preserves insertion order
      if (oldest === undefined) break;            // narrowed for noUncheckedIndexedAccess
      const evicted = store.get(oldest);
      store.delete(oldest);
      if (evicted !== undefined) destroyTexture(evicted);
    }
  },
  ```
- Update the module doc `:56-62`: the cache is bounded, eviction is oldest-first and destroys, and, in the
  same doc block, fix the dangling `{@link releaseTexture}` reference at `:60` to `{@link release}` (that
  symbol does not exist anywhere in the package; `rg releaseTexture` matches only that comment).

**Test first.** Create `packages/bootstrapped/tests/render/sprite.test.ts`. The ctor seam is
`PixiStage.tryGetCtors()`; **read `packages/bootstrapped/tests/world.test.ts:108-150` first**, because it
already contains a fake texture factory (with a `destroy` spy) and an image stub written for that purpose. Cases:

1. `it('destroys the texture it evicts')`: `const cache = createTextureCache({ maxEntries: 2 })`; insert
   keys `'a'`, `'b'`, `'c'`; assert `cache.size() === 2`, `cache.get('a') === undefined`, and the fake
   texture created for `'a'` recorded `destroy(true)`.
   **Today:** `cache.size` does not exist (`TS2339`), and at runtime `cache.get('a')` is still defined and
   nothing was destroyed → the assertion fails.
2. `it('destroys the texture it replaces')`: `textureFrom(src, { cache, key: 'a', refresh: true })` twice;
   assert the first texture was destroyed exactly once and the second is live. **Today:** zero destroys → FAIL.
3. `it('does not destroy a texture it merely re-hands out')`: two non-refresh calls on one key; assert the
   texture was destroyed zero times and the returned entry's `useCount === 2` (this is the guard against the
   over-eager version of fix (1); write it **before** the implementation).
4. `it('evicts in insertion order')`: `maxEntries: 2`, insert `a`,`b`, re-read `a` (bumping its use count),
   insert `c`; assert `b` was evicted, not `a`.

- [x] **Step 1:** write the four tests against the current `TextureCache`; run
      `npm test -w @mg.js/bootstrapped`; record the failures.
- [x] **Step 2:** implement `maxEntries`, `size()`, destroy-on-replace and destroy-on-evict.
- [x] **Step 3:** update the module doc and the `releaseTexture` link.
- [x] **Step 4:** `npm run verify` green, including `npm run size`, which prints the bundle delta for the
      userscript. Bump the budget constant in `scripts/assert-bundle-size.ts` **only** with the measured
      number quoted in the commit body.
- [x] **Step 5:** `git commit -m "fix(bootstrapped): the texture cache declares a bound and destroys what it drops"`

**Acceptance.** The four tests; `npm test -w @mg.js/bootstrapped`; `npm run verify` exit 0 with the size gate
passing. No live check exists for this path (it is in-page rendering); the size gate is the artifact check.

**Risk / revert.** **This is the one judgement call in the phase**: destroying on eviction can destroy a
texture that a live sprite still references, and this cache cannot know (Pixi sprites hold the texture
directly; `useCount` counts cache hits, not live references). Mitigations, all in the change: the bound is
generous (256 against "a handful of icons"), eviction is oldest-inserted-first, the destroy is wrapped in the
same try/catch as `release`, and the hazard is documented on `createTextureCache`. A caller who needs a
different bound passes `maxEntries`; `sharedTextures` keeps its type and identity. Revert = revert one file,
and the previous unbounded semantics return.

---

## Task 2.5: Cancellable waits

**Status: complete.** Landed · review closed. Two instructions in this task were not
followed because they were wrong; see the correction notes below.

**Files:** modify `packages/headless/src/reconnect.ts`, `packages/headless/src/client.ts`,
`packages/common/src/client.ts`; create `packages/headless/tests/reconnect-abort.test.ts`,
`packages/headless/tests/disconnect-race.test.ts`.

**Problem, four parts, all I5.**

**(a) `disconnect()` blocks for a whole backoff.** `disconnect()` awaits `this.awaitReconnect()` at
`headless/client.ts:613` before it closes anything:

```ts
async disconnect(): Promise<void> {
  this.localShutdown = true;
  this.stoppedReason = 'Disconnected by this client.';
  this.pendingSupersession = null;
  await this.awaitReconnect();                 // client.ts:613
```

`awaitReconnect` (`:1012-1021`) awaits `this.reconnectTask`, whose first statement is
`await ReconnectPolicy.sleep(plan)` (`:997`). `sleep` is a bare timer with no signal (`reconnect.ts:337-343`):

```ts
static async sleep(plan: BackoffPlan): Promise<void> {
  const delayMs = plan.delayMs;
  if (delayMs <= 0) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);              // reconnect.ts:341: no handle kept, no signal
  });
}
```

With `DEFAULT_RECONNECT_POLICY` (`reconnect.ts:45-53`) the delay reaches `maxDelayMs` = 60 000 ms. Audit 06
§3 measured `disconnect()` at **5256 ms** with `{ baseDelayMs: 5000, maxDelayMs: 5000 }`. `destroy()` inherits
it (`headless/client.ts:638-643`). There is no `AbortController` anywhere in `client.ts` or `reconnect.ts`.

**(b) The superseded delay breaks its own declared cap.** The superseded branch applies jitter *without*
re-clamping to `maxDelayMs` (`reconnect.ts:138`):

```ts
delayMs: Math.max(0, Math.round(bounded * jitterFactor(config.jitter, random))),
```

while the ordinary branch does clamp (`:174-177`) and the comment at `:170-173` states clamp-after-jitter is
the required invariant. Measured with `random: 1`: attempt 2 → 37 500 ms (base 30 000) and attempts 3+ →
**75 000 ms** with `maxDelayMs: 60_000`, while `plan.capped` is already `true`, so the plan contradicts
itself. Audit 06 §4.

**(c) The readiness timer is neither retained nor released.** `common/client.ts:270-283` arms a timer whose
handle is local to the promise and is never cleared by `dispose()` (`:201-214`):

```ts
timer = setTimeout(() => {
  off();
  reject(new MgNotReadyError(`Client was not ready within ${timeoutMs}ms, no Welcome received.`));
}, timeoutMs);
```

It is not `unref`'d either, so a dead client holds the Node event loop for up to `welcomeMs` (15 000 ms,
`common/src/transport/types.ts`) after `disconnect()`.

**(d) `disconnect()` does not stop an in-flight `connect()`.** `openConnection` never re-checks
`this.localShutdown` after its awaits, so a `disconnect()` racing a `connect()` can still assign
`this.activeTransport` (`:763`) and `this.core` (`:774`) and emit `open`/`ready` *after* `disconnect()`
returned and nulled both, leaving a live socket on a "disconnected" client (audit 05 §2, 06 other-observations).

**Change.**

1. `reconnect.ts:337` → `static async sleep(plan: BackoffPlan, signal?: AbortSignal): Promise<void>`: return
   immediately when `signal?.aborted`; otherwise hold the timer handle and resolve on either expiry or
   `abort`, removing the listener on **both** paths so retries do not accumulate listeners on a long-lived
   signal. **Resolve, do not reject, on abort**: every caller already re-checks `localShutdown` on the next
   line (`headless/client.ts:998`), so early resolution is the smallest correct change and needs no new catch
   arms. Keep the non-aborted timer un-`unref`'d; the rationale at `:332-335` still holds.
2. `headless/client.ts`: add `private reconnectAbort = new AbortController();` beside `reconnectTask`
   (`:309`), **not** `readonly`, because `connect()` must install a fresh one (an aborted signal is
   permanent). `disconnect()` calls `this.reconnectAbort.abort()` immediately after
   `this.localShutdown = true` (`:608`), i.e. *before* `await this.awaitReconnect()`. `scheduleReconnect`
   passes it: `await ReconnectPolicy.sleep(plan, this.reconnectAbort.signal)`. `connect()` (`:579-593`)
   creates a new controller next to `this.localShutdown = false` (`:581`).
3. `reconnect.ts:138` → `Math.min(config.maxDelayMs, Math.max(0, Math.round(bounded * jitterFactor(config.jitter, random))))`.
4. `common/client.ts`: retain the readiness timer and the rejection so teardown can settle it. Add
   `private readyWait: { timer: ReturnType<typeof setTimeout>; reject: (error: Error) => void } | null = null;`
   set inside `waitUntilReady`, cleared in the `once('ready')` handler, and in `dispose()` (`:201-214`)
   `clearTimeout` + `reject(new MgNotReadyError('Client was disposed before it became ready.'))`. Call
   `timer.unref?.()` so a bounded wait never by itself holds the process open.
5. `headless/client.ts`: add `private abandonIfShuttingDown(transport: StandaloneTransport | null): boolean`
   which, when `this.localShutdown` is true, disposes the transport, nulls `this.activeTransport`, nulls
   `this.core` and returns `true`. Call it immediately after `await this.transport.connect(...)` (`:820`)
   and before the core is installed (`:765-774`); return early when it fires. Do **not** make `disconnect()`
   await `connectTask`, because that would trade a bounded 300 ms close race for an unbounded open timeout; the
   self-teardown above is what makes the leak impossible without changing `disconnect()`'s timing.

**Test first.**

- Create `packages/headless/tests/reconnect-abort.test.ts`:
  - `it('resolves an aborted sleep immediately')`: **write it so it fails fast rather than hangs:**
    ```ts
    const plan: BackoffPlan = {
      delayMs: 60_000,
      attempt: 1,
      coldStartFast: false,
      superseded: false,
      capped: true,
      rawDelayMs: 60_000,
      reason: 'test',
    };
    const controller = new AbortController();
    const sleep = ReconnectPolicy.sleep(plan, controller.signal);
    controller.abort();
    const outcome = await Promise.race([sleep.then(() => 'resolved'), delay(200).then(() => 'timeout')]);
    assert.equal(outcome, 'resolved');
    ```
    Today `sleep` takes one argument; `tsx` ignores the extra one, so the race resolves `'timeout'` → FAIL
    (and `npm run typecheck` reports `TS2554`).
  - `it('does not resolve an unaborted sleep early')`: `delay(50)` then assert still pending; this is the
    guard against a sleep that ignores its delay.
  - `it('clamps a superseded delay to maxDelayMs')`:
    `computeBackoff({ ...FLAT, maxDelayMs: 60_000, supersededBaseDelayMs: 30_000 }, { attempt: 4, close: analyzeClose(4250, 'newer user session', false), coldStart: false, random: 1 })`;
    assert `plan.delayMs === 60_000` and `plan.capped === true`. Today: 75 000 → FAIL.
  - Add to `packages/headless/tests/backoff.test.ts`: nothing; its superseded cases all use `random: 0.5`
    (jitter factor exactly 1.0), so they stay green; verify that, do not assume it.
- Create `packages/headless/tests/disconnect-race.test.ts` using `packages/headless/tests/mock-server/server.ts`:
  - `it('disconnect() during a backoff resolves in under 50 ms')`: client with
    `reconnect: { baseDelayMs: 5000, maxDelayMs: 5000 }`; force-close `4400` from the mock server; await the
    `reconnect` event; then `const t0 = Date.now(); await client.disconnect(); assert.ok(Date.now() - t0 < 50)`.
    Today: ~5000 ms → FAIL.
  - `it('disconnect() does not leave a socket installed after it returns')`: point the client at the mock
    server configured to delay the upgrade, start `connect()` **without awaiting**, `await client.disconnect()`,
    then `await delay(50)` and assert no `open` event fired after disconnect, `client.transport === null`, and
    `client.isConnecting === false`. Today the socket is installed and `open` fires → FAIL.
- Add to `packages/common/tests/client.test.ts`: `it('settles a pending readiness wait on dispose')`:
  `const pending = core.waitUntilReady(60_000); core.dispose(); await assert.rejects(pending, MgNotReadyError);`
  and assert the test process exits promptly (the `node --test` run completing is the assertion).
  Today: the promise rejects only after 60 s → the suite times out → FAIL.

- [x] **Step 1:** write the failing tests; run `npm test -w @mg.js/headless` and `-w @mg.js/common`; record
      each failure and its measured duration.
- [x] **Step 2:** make `sleep` abortable and clamp the superseded branch (`reconnect.ts`).
- [x] **Step 3:** thread `reconnectAbort` through `disconnect()`/`connect()`/`scheduleReconnect`.
- [x] **Step 4:** retain and settle the readiness timer in `common/client.ts`.
- [x] **Step 5:** add `abandonIfShuttingDown` to `openConnection`.
- [x] **Step 6:** `npm run verify` green.
- [x] **Step 7:** `git commit -m "fix(headless,common): a shutdown cancels the backoff instead of waiting it out"`: body
      names the `ReconnectPolicy.sleep` signature change (additive optional parameter) and the
      superseded-delay clamp (a behaviour change for a superseded reconnect: 37.5s/75s → 30s/60s).

**Acceptance.** The `< 50 ms` assertions; the "not installed after disconnect" assertion; the dispose test;
`npm run verify` exit 0. Live: `npm run verify:socket`, because this task changes the disconnect path the script
relies on for its teardown, and Phase 0's own deviation note records that a teardown once hung on this
backoff ("`verify-live-socket.ts` could exit 0 **without printing any verdict**").

> **Correction (2.5, Phase 2 close).** Two instructions in this task were wrong and were not followed.
>
> - **`disconnect()` during a backoff resolves in ~300 ms, not <50 ms.** The `< 50 ms` acceptance above is
>   unattainable even with the backoff cancelled: `disconnect()` also awaits a deliberate bounded close
>   fallback for the already-closed socket (`packages/headless/src/client.ts:693-701`,
>   `setTimeout(resolve, 300)`), so the floor is ~300 ms. The landed test
>   (`packages/headless/tests/disconnect-race.test.ts:77-101`) is named "resolves in well under the backoff"
>   and asserts `elapsed < 1000` against the 5000 ms backoff, with a comment recording this exact
>   correction. The `< 50 ms` bound is still correct for what it was really measuring:
>   `ReconnectPolicy.sleep` aborting (`packages/headless/tests/reconnect-abort.test.ts:41-66`).
> - **`timer.unref?.()` was dropped, because it cancelled 44 tests.** An `unref`'d timer lets the event loop
>   drain with the wait still pending, so the readiness wait was not observable. The landed code is
>   **not** `unref`'d by design (`packages/common/src/client.ts:322-325`) and pins that with a test; the
>   loop is released instead by `dispose()` clearing every registered wait's timer. The step also landed as a
>   `readyWaits` set (`common/client.ts:178`, `:229-244`) rather than the single `readyWait` field sketched
>   above, so more than one pending wait is settled.

**Risk / revert.** `ReconnectPolicy.sleep` gains an optional parameter, so existing callers are unaffected.
The clamp shortens two superseded delays on purpose. Residual, not fixed here: a
`connect()` issued while a reconnect task is parked swaps the controller, and the already-running `sleep`
holds the old signal. `connect()` is not documented as re-entrant with a scheduled reconnect, and the
`connectTask` guard at `:580` does not cover `reconnectTask`. Record it in the Findings section rather than
widening this task.

---

## Task 2.6: Honest reconnect accounting

**Status: complete.** Landed · review closed (test gaps + in-flight supersession).

**Files:** modify `packages/headless/src/client.ts`; create `packages/headless/tests/reconnect-chain.test.ts`.

**Problem.** A reconnect that fails *before the socket opens* kills the chain forever while `close` reports
`willReconnect: true`. Every line of the chain is current and verified:

```ts
private scheduleReconnect(plan: BackoffPlan, analysis: CloseAnalysis): void {
  if (this.reconnectTask !== null) return;         // client.ts:982: the silent drop
  if (this.localShutdown) return;
  …
  const task = (async (): Promise<void> => {
    await ReconnectPolicy.sleep(plan);
    if (this.localShutdown) return;
    try {
      await this.openConnection(plan.delayMs);     // client.ts:1000
    } catch (error) {
      this.logger.debug('reconnect attempt failed', { error });   // :1001-1003: swallowed
    }
  })().finally(() => {
    this.reconnectTask = null;                     // :1005: only here
  });
  this.reconnectTask = task;                       // :1008: assigned synchronously
}
```

> **Correction (2.6, Phase 2 close).** Every `client.ts:` anchor in the block above predates the landed
> code, and has drifted; the plan's landing-order text is older than the abort plumbing the parking
> branch now depends on. Current anchors at Phase 2 close: the silent-drop guard is `:1137` (not `:982`);
> the task's `await this.openConnection(...)` is `:1182` (not `:1000`); the swallowing catch is `:1183-1186`;
> the `.finally` is `:1187-1196` (not `:1004-1008`); `scheduleReconnect` is `:1133`; `handleClose` is `:980`;
> the synthetic close is emitted at `:958`; the `stopped` emit is `:1072`; the field declaration is `:316`;
> `get stopped()` is `:488`; `get stats()` is `:558`; `get isConnecting()` is `:506`. Read anchors as symbol
> names rather than trusting these numbers, which will drift again.

The failure path is re-entrant: `openConnection`'s catch (`:822-835`) calls `handleSyntheticClose(error)`
(`:832`) → `handleClose` (`:972-979` synthesises code `1006`) → `classifyClose` → `policy.planRetry`
(`:870`) → `this.emit('close', { ..., willReconnect: plan !== null })` (`:872`, **`true`**) → `afterClose` →
`this.scheduleReconnect(plan, analysis)` (`:929`) → the guard at `:982` **drops the plan**, because the call
is running inside the task that has not yet reached its `.finally`. The rethrow at `:834` is swallowed by
`:1001-1003`, `.finally` nulls the task, and the client is dead. `stopped` is never emitted (`:915-922` is
only reachable when `plan === null`) and `get stopped()` (`:451-453`) stays `null`, so a host has no signal
at all: the documented default (`maxAttempts: Infinity`) is a lie. Audit 06 §1 measured this:
`events: ['close code=4400 willReconnect=true', 'reconnect plan.attempt=1 delay=20', 'close code=1006
willReconnect=true']`, then no fourth event and no further upgrade.

**Change.** Park the dropped plan and drain it when the running task unwinds; the chain then continues and
the *existing* stop reporting (`plan === null` → `stopped` at `:920`) becomes reachable.

1. Add `private parkedReconnect: { plan: BackoffPlan; analysis: CloseAnalysis } | null = null;` beside
   `reconnectTask` (`:309`).
2. In `scheduleReconnect`, replace `:982` with:
   ```ts
   if (this.localShutdown) return;                  // moved above parking: a shutdown invalidates the plan
   if (this.reconnectTask !== null) {
     // Re-entrant call from inside the running task (`openConnection` failed pre-open and routed the
     // failure through `handleClose`). Dropping it here made `willReconnect: true` a lie; park it
     // and let the running task's `finally` start the next attempt.
     this.parkedReconnect = { plan, analysis };
     return;
   }
   ```
3. In the `.finally` (`:1004-1006`), after `this.reconnectTask = null;`:
   ```ts
   const parked = this.parkedReconnect;
   this.parkedReconnect = null;
   if (parked !== null && !this.localShutdown) this.scheduleReconnect(parked.plan, parked.analysis);
   ```
   This cannot recurse unboundedly: the drain runs after the task reference is cleared, so the next call
   takes the normal path.
4. Expose the honest state so a host can see a scheduled retry: add
   `get willReconnect(): boolean { return this.reconnectTask !== null || this.parkedReconnect !== null; }`
   and include it in `stats` (`:483-497`, next to `reconnectAttempt`). Task 2.7's facade consumes it.

**Test first.** Create `packages/headless/tests/reconnect-chain.test.ts`, using
`packages/headless/tests/mock-server/server.ts` and a counter-driven `versionOptions.fetcher` (the same seam
audit 06's probe used: make the *second* call throw, so the first connect succeeds and the retry dies
pre-open):

> **Correction (2.6, Phase 2 close).** The `versionOptions.fetcher` seam described here is **unusable for
> this test**, and the landed test does not use it. `VersionResolver.resolve()` returns the cached success
> when the source yields nothing usable (`packages/headless/src/version.ts:245-269`; the stale fallback is
> deliberate for `resolve`), so a fetcher that throws on the second call does not fail the retry. The retry
> reuses the cached version and is `ready` again. The counter-driven seam actually used is
> `AuthProvider.prepare()`, which runs at step 2 of `openConnection` before any socket is allocated; the
> landed test's header records the substitution (`packages/headless/tests/reconnect-chain.test.ts:15-24`,
> `FlakyAuthProvider`).

- `it('continues the chain when a pre-open attempt fails')`: fetcher returns `'1157'` on call 1 and throws
  on every later call; mock server force-closes `4400` on the first connection. Collect every `reconnect`
  and `stopped` event for 500 ms, then assert **two or more** `reconnect` events (i.e. the chain ran again),
  `client.stopped === null`, and `client.willReconnect === true` while parked.
  **Today:** exactly one `reconnect` event, `client.stopped === null`, `client.isConnecting === false` →
  FAIL on the event count.
- `it('emits stopped once with a reason when the budget is spent')`: `reconnect: { maxAttempts: 3 }` plus an
  always-throwing fetcher; assert exactly one `stopped` whose `reason` is non-empty, `client.stopped` equals
  it, and no `reconnect` event arrives after it. Today: zero `stopped` events → FAIL.
- `it('does not park a plan after a deliberate disconnect')`: close `4400` to schedule a retry, then
  `await client.disconnect()`, then assert no further `reconnect`. This is the guard that parking does not
  resurrect a reconnect after a shutdown.

- [x] **Step 1:** write the three tests; run `npm test -w @mg.js/headless`; record the event traces.
- [x] **Step 2:** add `parkedReconnect`, the parking branch and the drain.
- [x] **Step 3:** add `willReconnect` and put it in `stats`.
- [x] **Step 4:** `npm run verify` green; confirm `packages/headless/tests/integration.test.ts` and
      `tests/backoff.test.ts` are unchanged.
- [x] **Step 5:** `git commit -m "fix(headless): a failed reconnect attempt continues the chain instead of dying silently"`: body
      states plainly that, with the documented `maxAttempts: Infinity`, a transiently broken dependency
      now retries indefinitely **and** reports `stopped` with a reason when the policy refuses, whereas the
      previous behaviour broke the contract silently after exactly one attempt.

**Acceptance.** The three tests; `npm run verify` exit 0. Live: `npm run verify:socket` (it asserts on
close-code classification and must still print its verdict).

**Risk / revert.** The behaviour change is deliberate and is the fix. The one new hazard, an indefinite
chain, is bounded by the backoff and is now *observable* through `stopped`/`willReconnect`. Revert = delete
the field and the two branches.

---

## Task 2.7: `RoomSocket` gains reconnect; the version must not silently fall back

**Status: complete.** Landed · review closed.

**Files:** modify `packages/headless/src/room-socket.ts`, `packages/headless/src/version.ts`,
`packages/headless/src/client.ts`; extend `packages/headless/tests/room-socket.test.ts`; create
`packages/headless/tests/version.test.ts`, `packages/headless/tests/version-loop.test.ts`.

### Part A: the facade cannot see a reconnect

**Problem.** `RoomSocket` is the documented standalone entry point (`room-socket.ts:1-33`), but its generic
escape hatch is typed over the **core** event map only (`:312-328`):

```ts
on<TKey extends keyof ClientEvents>(
  event: TKey,
  handler: (...args: ClientEvents[TKey]) => void,
): Unsubscribe {
  if (this.client !== null) return this.client.onCore(event, handler);
```

`'reconnect'`, `'stopped'`, `'confirmationRequired'` and `'headersUnsupported'` live in
`HeadlessClientEvents` (`headless/client.ts:139`), so `socket.on('reconnect', ...)` is a compile error and
`onCore` would not deliver it anyway. There is no `onReconnect`/`onStopped` and no attempt accessor, so a
host using the documented class cannot observe the reconnect behaviour it inherits. Two further defects in
the same file, both I5/unbounded:

- `connect()` assigns `this.client = client` and *then* awaits (`:113-118` region, with the
  "already been called" guard); a first connect that fails leaves `this.client` non-null, so every later
  `connect()` throws "already been called" although no connection was ever made (audit 05 §5).
- `private readonly pendingSubscriptions: ((client: HeadlessClient) => void)[] = [];` (`:97`) is pushed to on
  every pre-connect `on()` (`:320`) and drained only inside `connect()` (`:140`). `disconnect()` and
  `destroy()` return early when `this.client === null` (`:154`, `:179`), so a subscribe-then-never-connect
  lifecycle (or subscribe/unsubscribe churn, where the returned detacher only sets a `cancelled` flag, `:324-327`)
  retains one handler closure per call with **no reclamation path at all**.

**Change.**

1. Add, next to the existing `on*` methods (`:255-278`):
   `onReconnect(handler: (event: HeadlessClientEvents['reconnect'][0]) => void)`,
   `onStopped(handler: (event: HeadlessClientEvents['stopped'][0]) => void)`,
   `onConfirmationRequired(handler: (event: HeadlessClientEvents['confirmationRequired'][0]) => void)`,
   `get reconnectAttempt(): number` and `get willReconnect(): boolean` (the getter added in 2.6). All must
   work before `connect()`; route them through the existing `pendingSubscriptions` queue, exactly as
   `on()` does.
2. Widen the generic escape hatch to
   `on<TKey extends keyof (ClientEvents & HeadlessClientEvents)>(event, handler)` and dispatch to
   `client.onCore` vs `client.on` accordingly; keep the pre-connect queue for both.
3. `connect()`: build the client into a local, `await client.connect()` inside a `try`, and in the `catch`
   set `this.client = null`, `await client.destroy()` and rethrow. A retry then works, and the
   "already been called" guard keeps its real meaning ("already connected").
4. `disconnect()`/`destroy()`: `this.pendingSubscriptions.length = 0` **before** the `client === null` early
   return, so a never-connected socket releases its queued handlers.

### Part B: a `4710` loop that can never resolve

**Problem.** `VersionResolver.load()` (`version.ts:221-248`) returns the cached value when the source yields
nothing usable (`:237-248`): "A stale version is strictly better than no version". That is right for
`resolve()`. It is wrong for `refresh()`, whose only caller is the `4710`/`4700` remedy in `afterClose`
(`headless/client.ts:882-898`):

```ts
void this.resolver.refresh().then(
  (resolved) => {
    this.logger.info('version re-resolved after 4710', {
      previous: this.currentVersion,
      version: resolved.version,       // headless/client.ts:890: logs the SAME value
```

`4710`/`4700` are `isBounded: false` with `maxAttempts: Infinity` by default (`close-codes.ts:307-315`,
`reconnect.ts:45-53`), and `planRetry` refuses only on disposition or budget (`reconnect.ts:310-327`). So
when the version endpoint is down or returns a malformed payload (`{"version":{"n":1}}` → `extractVersion`
returns `null`, `version.ts:121-129`), `refresh()` resolves with the very version the server just rejected,
`openConnection` awaits `resolveDetailed()` (`:667`) → the same stale version → connect → `4710` → refresh → ...
forever, with no `stopped` and nothing a host can act on. That is precisely the endless `4710` loop
`version.ts:1-38` says this file exists to cure. The honest outcome, "the version could not be
re-resolved", is never reported.

**Change.**

1. `version.ts`: make the stale fallback opt-in by caller rather than unconditional. `load` gains
   `{ allowStale: boolean }`; `resolve()` → `allowStale: true` (unchanged behaviour, and its doc keeps the
   rationale); `refresh()` → `allowStale: false`, so it throws the existing typed `VersionUnavailableError`
   (`:243-248`) instead of returning a value the server has already rejected.
2. `headless/client.ts`: record the failure and stop honestly. Add
   `private versionRefreshFailure: string | null = null;`, cleared in `connect()` (`:582`, beside
   `stoppedReason`) and at the top of `openConnection`. In the refresh rejection handler (`:894-897`) set it
   to `` `Could not re-resolve the game version after close ${info.code}: ${message}` `` (never echoing the
   payload). In `scheduleReconnect`'s task, immediately after the sleep and the `localShutdown` check
   (`:998`), add:
   ```ts
   if (analysis.requiresVersionRefetch && this.versionRefreshFailure !== null) {
     this.stoppedReason = this.versionRefreshFailure;
     this.emit('stopped', { reason: this.stoppedReason });
     return;                                    // no attempt with a version we know is rejected
   }
   ```

**Test first.**

- Extend `packages/headless/tests/room-socket.test.ts` (its mock-server harness already passes
  `reconnect: { enabled: false }` at `:55`):
  - `it('delivers reconnect and stopped before connect')`: register `onReconnect`/`onStopped` first, connect,
    force a close, and assert `onReconnect` fired with a plan and (with a tiny `maxAttempts`) `onStopped` fired
    with a reason. Today: `socket.onReconnect is not a function` → FAIL.
  - `it('allows a second connect() after a failed first connect')`: point the socket at a closed port, assert
    the first `connect()` rejects, then assert the second rejects with a *different* message (not
    `/already been called/`). Today: the second throws "already been called" → FAIL.
  - `it('releases queued subscriptions when a socket is destroyed before connecting')`: subscribe three times
    on a never-connected socket, `await socket.destroy()`, assert `socket.queuedSubscriptionCount === 0`
    (add `get queuedSubscriptionCount(): number` returning `this.pendingSubscriptions.length`, named distinctly
    from the private field so the facade's public surface stays unambiguous). Today: three retained closures
    → FAIL.
- Create `packages/headless/tests/version.test.ts`:
  - `it('refresh() rejects instead of returning a stale version for a malformed payload')`: a fetcher
    returning `'1157'`, `await resolver.resolve()`, then flip the fetcher to `() => Promise.resolve({ version: { nested: 1 } })`,
    `await assert.rejects(resolver.refresh(), VersionUnavailableError)`, and assert `resolver.current === '1157'`
    (the cache is not corrupted). Today: `refresh()` resolves `{ version: '1157', fresh: false }` → FAIL.
  - `it('resolve() still falls back to the stale version')`: same setup, `await resolver.resolve()` returns
    `'1157'` with `fresh: false`. This pins the behaviour that must **not** change.
  - `it('resolveDetailed() rejects when the payload is malformed and nothing is cached')`: today's behaviour,
    pinned so the change stays narrow.
- Create `packages/headless/tests/version-loop.test.ts`:
  - `it('stops with a version reason instead of looping on 4710')`: mock server closes `4710`; fetcher
    returns `'1157'` once then a malformed payload. Assert: exactly one `stopped` whose `reason` mentions the
    version, `client.stopped !== null`, `client.willReconnect === false`, and
    `server.connectionCount <= 2` after a 300 ms settle. **Today:** connections keep growing and no `stopped`
    fires → FAIL (the assertion fails rather than hanging).

- [x] **Step 1:** write all the tests; run `npm test -w @mg.js/headless`; record the failures.
- [x] **Step 2:** widen the facade's events, add the `on*` methods and getters, and thread `willReconnect`.
- [x] **Step 3:** fix `connect()`'s poisoning and release `pendingSubscriptions` on teardown.
- [x] **Step 4:** make `refresh()` strict and add the `versionRefreshFailure` stop.
- [x] **Step 5:** `npm run verify` green.
- [x] **Step 6:** `git commit -m "fix(headless): RoomSocket exposes reconnect, and a 4710 stops when the version cannot be re-resolved"`: body
      names the `refresh()` behaviour change (it can now throw where it previously returned a stale value).

**Acceptance.** All eight tests; `npm run verify` exit 0. Live: `npm run verify:catalog` (the version
endpoint still parses), then `npm run verify:socket` (the strict `refresh()` path is the one the `4710` cure
uses; exit 0 = the documented `4840` rejection reproduced with every check passing, exit 1 = a regression
(see the exit-code table in the Verification plan).

**Risk / revert.** `refresh()` becoming strict is a small breaking change for the package's own surface,
mitigated by keeping `resolve()`'s fallback and pinning it with a test. The RoomSocket additions are
additive. Revert = one commit; the `on()` signature widening is source-compatible.

---

## Task 2.8: Canonical frontier and the readiness gate

**Status: complete.** Landed.

**Files:** modify `packages/common/src/client.ts`, `packages/common/src/protocol/sequencer.ts`; extend
`packages/common/tests/client.test.ts`, `packages/common/tests/sequencer.test.ts`.

**Problem.** `handleWelcome` seeds on a `typeof` check and then opens the gate unconditionally
(`common/client.ts:539-551`):

```ts
if (typeof message.executedCommandSequence === 'number') {
  this.sequencer.seed(message.executedCommandSequence);      // client.ts:540
}
…
this.readyState = true;                                      // client.ts:551
```

although `isReady`'s own doc says "True once `Welcome` has arrived **and the sequencer is seeded**"
(`:222-226`). Two failures follow from the same line:

- **A non-canonical frontier becomes the command index.** `CommandSequencer.seed(2.5)` →
  `MonotonicStrategy.reseed` (`sequencer.ts:235-239`) sets `nextValue = 3.5`, so `take()` stamps `3.5` and
  `serializeFrame` writes `"sequence":3.5`. The server rejects it as `invalid_sequence`, and the module
  header's own words are "a *gap* produces `invalid_sequence`, and then **every later command fails too**
  until resynced" (`sequencer.ts:7-9`). This is I4 verbatim: an unchecked inbound number used as an index.
  `bootstrapped`'s `readWelcomeFrontier` already applies the canonical test
  (`typeof value === 'number' && Number.isInteger(value) && value >= 0`, `bootstrapped/client.ts:927-932`),
  so the two counters the code says are seeded "from the same fact" (`bootstrapped/client.ts:249-253`)
  disagree: the renumberer is never seeded, the core's counter is seeded with `2.5`. Audit 20 §1 and 03 F5.
- **A `Welcome` with no usable frontier opens the gate anyway**: no seed at all, so the counter starts at 1
  (`MonotonicStrategy(0)`, `sequencer.ts:287`), `readyState = true` bypasses the readiness guard in `send()`,
  and every command is `invalid_sequence` until a state frame supplies a frontier.

**Change.**

1. `sequencer.ts`: add the canonical gate as a named, exported predicate, which is the validator Phase 3.5
   converges the five copies onto, so name it for that:
   ```ts
   /** True when `value` can be a command sequence: a non-negative integer, nothing else. */
   export function isCanonicalSequence(value: unknown): value is number {
     return typeof value === 'number' && Number.isInteger(value) && value >= 0;
   }
   ```
   and make `CommandSequencer.seed` refuse a non-canonical value at the boundary (a caller bug, not a wire
   path): `if (!isCanonicalSequence(value)) throw new RangeError('CommandSequencer.seed expects a non-negative integer sequence.');`
2. `common/client.ts:539-551`:
   ```ts
   const frontier = message.executedCommandSequence;
   const seeded = isCanonicalSequence(frontier);
   if (seeded) {
     this.sequencer.seed(frontier);
   } else {
     this.logger.warn('Welcome carried no canonical executedCommandSequence', {
       received: frontier === undefined ? 'undefined' : typeof frontier,
     });
   }
   …
   this.readyState = seeded;
   ```
   Do **not** emit `ready` when `!seeded`.
3. Keep the live path working: a state frame may legitimately supply the frontier first. In
   `handleStateFrame` (`:562-575`), after `this.sequencer.observeFrontier(frontier)` (`:566`), add
   ```ts
   if (!this.readyState && this.sequencer.frontier !== null) {
     this.readyState = true;
     this.emit('ready');
   }
   ```
   so a `Welcome` that omitted the field still reaches ready on the first `RoomFrame`, with the counter
   correctly seeded. That is the capability audit 03 F5 says is missing.

**Test first.** Add to `packages/common/tests/client.test.ts` (reuse its fake-transport harness):

- `it('does not seed from a fractional frontier')`: feed a `Welcome` with `executedCommandSequence: 2.5`;
  assert `core.isReady === false`, `core.sequencer.peek() === 1`, and that `core.send('ping', {})` throws the
  not-ready error instead of stamping a sequence. **Today:** `isReady === true` and `peek() === 3.5` → FAIL.
- `it('ignores every non-canonical frontier shape')`: the hostile-input test I4 asks for: `2.5`, `-1`,
  `Number.NaN`, `'7'`, `null`, `undefined`: none of them seeds the counter and none opens the gate.
- `it('opens the gate when a state frame supplies the frontier')`: same core, then a `RoomFrame` carrying
  `executedCommandSequence: 7`; assert `isReady === true` and `peek() === 8`.
- `it('still seeds and readies from a canonical Welcome')`: `1157` → `isReady === true`, `peek() === 1158`.
- Add to `packages/common/tests/sequencer.test.ts`: `it('seed() refuses a non-canonical value')` →
  `assert.throws(() => sequencer.seed(2.5), RangeError)`.

- [x] **Step 1:** write the five tests; run `npm test -w @mg.js/common`; record the failures.
- [x] **Step 2:** add `isCanonicalSequence`, the `seed` guard, the call-site guard, the readiness change and
      the state-frame ready path.
- [x] **Step 3:** `npm run verify` green.
- [x] **Step 4:** `git commit -m "fix(common): the command counter is seeded only from a canonical frontier"`: body
      states the tightened `isReady` semantics (a `Welcome` without a frontier no longer means ready;
      the first state frame is the fallback).

**Acceptance.** The five tests; `npm run verify` exit 0. Live: `npm run verify:socket` must still reach
`ready`. If the live `Welcome` turns out to carry no integer frontier, the script is the evidence for it and
the state-frame path above is what keeps the client usable (record the observed payload shape in the commit
body).

**Risk / revert.** Tightening `isReady` is a visible behaviour change; the state-frame fallback is what makes
it safe. Revert = one commit.

---

## Task 2.9: Reconcile a settled command with the sequencer ledger

**Status: complete.** Landed · review closed.

**Files:** modify `packages/common/src/client.ts`, `packages/common/src/protocol/sequencer.ts`; extend
`packages/common/tests/client.test.ts`, `packages/common/tests/sequencer.test.ts`.

**Problem.** The handle and the ledger are settled independently, so a timed-out command is reported twice
with contradictory causes and its ledger entry is never reclaimed. `expirePending` (`client.ts:444-455`) and
`rejectAllPending` (`:457-479`) call `settlePending` only; neither calls `sequencer.settle`, and neither does
`dispose` or the close handler. `CommandSequencer.settle` (`sequencer.ts:380-402`) is the only method that
deletes by `requestId`; `sweepStale` (`:410-421`), documented as "the backstop" for this case, has
**no production caller** (only `tests/sequencer.test.ts`). So the entry `take()` created (`:315-327`) survives,
the later frontier passes it, `observeFrontier` reports it as dropped (`:357-372`), and the core emits
`droppedStale` (`:574`) for a handle that already failed as an unconfirmed timeout, while `stats.pending`
(handle map, `:260`) reads 0 and `sequencer.pending` still lists the command. `reportedStale`
(`sequencer.ts:284`) grows for the connection's life. Audit 03 F3.

**Change.**

1. `client.ts`: make `settlePending` (`:411-441`) the single funnel that also settles the ledger, so one call
   site then covers the ack path, `expirePending`, `rejectAllPending` and `dropped_stale`:
   ```ts
   // Keep the two ledgers consistent: the handle is the caller's promise, the sequencer's is the
   // dropped-stale inference. Settling only one is what produced a timeout and a dropped-stale report for
   // the same command, and left the sequencer's entry alive forever.
   this.sequencer.settle(requestId, { ok: result.ok, ...(result.code !== undefined ? { code: result.code } : {}) },
     this.sequencer.frontier ?? undefined);
   ```
   Note `sequencer.settle` also heals the counter for `invalid_sequence`, and a synthesized rejection needs
   that too.
2. `sequencer.ts`: bound `reportedStale`. Change `private readonly reportedStale = new Set<number>();` (`:284`)
   to `private readonly reportedStale = new Map<number, true>();` (insertion-ordered, so the oldest is
   `keys().next().value`), add `const MAX_REPORTED_STALE = 1024;` and evict the oldest after each insert, and
   expose `get reportedStaleCount(): number` for diagnostics and the test. Update the three call sites
   (`:365-366`, `:417`, `:458`) from `has`/`add`/`delete` to `Map` operations.

**Test first.** Add to `packages/common/tests/client.test.ts` (drive `expirePending` with the existing
`timeouts.commandAckMs` seam, or a fake clock; read the existing tests first):

- `it('does not report a timed-out command twice')`: send a command, let its ack deadline expire, then feed a
  state frame whose frontier is past its sequence; assert exactly one `commandResult` for that request, **zero**
  `droppedStale` events, `core.stats.pending === 0`, and `core.sequencer.pending.length === 0`.
  **Today:** a `droppedStale` fires after the timeout and `sequencer.pending.length` is 1 → FAIL.
- `it('keeps the two pending counters equal across settle paths')`: assert equality after a normal ack, after a
  transport close, and after `dispose()`. Today: the timeout/close paths diverge → FAIL.
- Add to `packages/common/tests/sequencer.test.ts`: `it('bounds the reported-stale ledger')`: report more than
  `MAX_REPORTED_STALE` dropped sequences (drive `take`+`observeFrontier` in a loop) and assert
  `sequencer.reportedStaleCount === MAX_REPORTED_STALE`. Today the getter does not exist and the set grows
  without bound → FAIL.

- [x] **Step 1:** write the three tests; run `npm test -w @mg.js/common`; record the failures.
- [x] **Step 2:** call `sequencer.settle` from `settlePending`.
- [x] **Step 3:** bound `reportedStale` and expose the count.
- [x] **Step 4:** `npm run verify` green.
- [x] **Step 5:** `git commit -m "fix(common): a settled command also leaves the sequencer ledger"`

**Acceptance.** The three tests; `npm run verify` exit 0. No live check applies (this is in-process
bookkeeping); the existing live scripts assert on `droppedStale`-free normal operation, which this change can
only improve.

**Risk / revert.** `sequencer.settle` healing the counter on a synthesized `invalid_sequence` rejection is a
small behaviour improvement, not a regression; a synthesized transport failure carries no code, so no healing
happens there. Revert = one commit.

---

## Findings beyond the table

Each candidate found while reading the files in this phase, with the evidence and a disposition. Line numbers
verified against the working tree.

**F1: `CommandSequencer.seed` clearing the ledger is *not* a defect.**
`seed()` (`sequencer.ts:302-306`) does `strategy.reseed(executed); outstanding.clear(); reportedStale.clear();`.
It looks like state loss, and DESIGN I6 once implicated it ("`client.ts:547 → sequencer.ts:302-305` re-seeds
the counter and clears the outstanding command ledger"). It is not a defect today, and the code proves it:
(a) nothing awaits a ledger entry: the caller-facing promises live in a **separate** map,
`ClientCore.pending` (`common/client.ts:143`), and are settled by `rejectAllPending` on close (`:194`) and on
`dispose()` (`:209`), which also `clearTimeout`s each entry's timer; (b) `seed()` has exactly one production
caller, `handleWelcome` (`:540`), and in `headless` every connect attempt builds a **fresh** `ClientCore` with
a **fresh** `CommandSequencer` (`headless/client.ts:767`) after disposing the old one, so at the first seed
the ledger is empty and the clear is a no-op; (c) on a genuine reconnect boundary the server's numbering
restarts, so carrying entries across would manufacture phantom `DroppedStale` reports, the behaviour the
comment defends; (d) the repeated-seed caller DESIGN named was the stand-in `Welcome`, and Phase 1.6 latched
it (`standInWelcomeEmitted`, `bootstrapped/src/attach/room-connection.ts:379,508-512`). The one residual:
a second `Welcome` on an *unclosed* connection would silently discard in-flight bookkeeping, with no test
pinning the distinction. **Disposition: not a defect, no task.** If the reviewer wants belt-and-braces,
the cheap hardening is to have `seed()` **return** the discarded entries (`OutstandingCommand[]`) so the loss
is observable; that is additive and can be folded into 2.9 if desired, but it is not needed to satisfy I4/I5.

**F2: Superseded backoff breaks its declared cap (75 s vs 60 s).** `reconnect.ts:138` jitters without
re-clamping while `:174-177` clamps and the comment at `:170-173` states clamping as the invariant; measured
75 000 ms with `maxDelayMs: 60_000` and `plan.capped === true`. **Disposition: task, folded into 2.5, step 3.**

**F3: `disconnect()` can install a socket after it returns.** `openConnection` never re-checks
`localShutdown` after its awaits (`headless/client.ts:667, 678, 716, 820`), so `activeTransport`/`core` can be
assigned and `open`/`ready` emitted post-disconnect. **Disposition: task, folded into 2.5, step 5.**

**F4: `waitUntilReady`'s timer is neither retained nor released.** `common/client.ts:270-283` keeps the
handle in a closure; `dispose()` (`:201-214`) cannot clear it and it is not `unref`'d, so a dead client holds
the event loop for up to `welcomeMs` = 15 000 ms. **Disposition: task, folded into 2.5, step 4.**

**F5: The `4710` loop cannot terminate when the version cannot be re-resolved.** See 2.7 Part B; root cause
is the unconditional stale fallback in `version.ts:237-248` feeding the unbounded `refetch-version`
disposition (`close-codes.ts:307-315`, `isBounded: false`, `maxAttempts: Infinity`).
**Disposition: task; it *is* 2.7 Part B.**

**F6: A non-canonical `executedCommandSequence` becomes the command index.** `common/client.ts:539-540`
accepts `2.5`, `-1`, `1e3`; `reseed` (`sequencer.ts:235-239`) makes `nextValue` non-integral. The canonical
gate already exists next door (`bootstrapped/client.ts:930`). **Disposition: task; it *is* 2.8.**

**F7: A timed-out command is never reconciled with the ledger.** Audit 03 F3, evidence in 2.9.
**Disposition: task; it *is* 2.9.**

**F8: `RemoteJsonSource` lets `baseUrl`/`paths` retarget the origin.** `remote-json-source.ts:69-70, :86`
concatenate unvalidated inputs; `paths: { plants: '//evil.test/x' }` retargets, `baseUrl: ''` reaches
link-local. **Disposition: task, folded into 2.3, step 2** (it is the URL-policy half of a task already
titled "Redirect and URL policy"; this extends the master plan's file list by one file, and audit 23 §5
proposes this fix).

**F9: No inbound read-idle watchdog.** The transport's only timer is the open timeout
(`headless/transport/client.ts:314-326`); nothing notices an absent frame, so a half-open socket leaves
`isReady === true` and commands vanish into the kernel buffer (audit 06, other observations).
**Disposition: defer** to Phase 7 (Missing capabilities) as `7.6 inbound idle watchdog`: closed on
`2 × keepalive` of silence by emitting `close` through the normal path so the reconnect policy decides,
not a new bound inside Phase 2, because it is a missing capability rather than an unbounded buffer, and every
command already has a 10 s ack deadline (`common/src/transport/types.ts`, `commandAckMs`).

**F10: Three pre-socket awaits have no deadline.** `resolver.resolveDetailed()` (`client.ts:667`),
`authProvider.prepare()` (`:678`, which awaits a caller-supplied `getCookie()`), and
`acquireWebSocketRuntime()` / `await import('ws')` (`:716`). **Disposition: defer, with a note that the
in-repo paths are already bounded**: the shipped version source goes through `PlatformApiSource` →
`fetchJson`'s 10 s timeout, the `ws` specifier resolves locally, and only a caller-supplied `getCookie()` that
never settles can hang `connect()` forever. If that matters, the fix is a `prepareTimeoutMs` option, which is
a new public option and therefore owes an observable-behaviour test (DESIGN I8), not Phase 2.

**F11: The attempt counter is off by one against the connect URL.** `plan.attempt` is 1 for the *first*
retry while `clientConnectionAttempt = 2` is written into that URL (`headless/client.ts`), so
`computeBackoff`'s `step = max(0, attempt - 2)` (`reconnect.ts:164`) yields `1500, 1500, 3000` where the
docstring promises `1500, 3000, 6000`, and `stats.reconnectAttempt` disagrees with
`stats.connectionAttempt` for the client's whole life (`backoff.test.ts:216-220` bakes the wrong convention
in). **Disposition: defer** to Phase 3.6 (retry tickers): it is an accounting convention shared with the
duplication cleanup, and it is a "correct but surprising" number rather than an unbounded wait. Recommend
Phase 3.6's task text name it explicitly.

**F12: `coldStartFastRetries` is two policies in one value.** It is both the fast-retry window
(`reconnect.ts:150`) and the bounded-close retry cap (`:322`), despite the comment claiming they "stay
independent". **Disposition: defer** to Phase 4.5 (options convergence), which already deletes duplicated
option pairs.

**F13: The parent-facing readiness timer's sibling: `common/state/store.ts`'s subscription wait can leak.**
`store.ts:240-262`: `finish()` is what calls `clearTimeout` and unsubscribes, and a throwing user `predicate`
(`:241`, `:257`) skips it, so the entry and its timer survive; with no `timeoutMs` the promise is also
permanent. **Disposition: defer**: it is a caller-supplied predicate throwing, one entry at a time, and it
belongs with Phase 4's "one client contract" error/ownership work rather than a wire bound. Recommend a
`try/finally` around the predicate in whichever task owns `store.ts`.

**F14: `sweepStale` has no production caller.** `sequencer.ts:410-421` is documented as the backstop for "a
socket that dies without a close event"; nothing calls it. **Disposition: partially resolved by 2.9** (every
settle path now clears the ledger, so the backstop is no longer required for the settled case), then
**defer the dead method itself to Phase 6** (inert surface: implement or delete), where it should either be
wired to the close handler or deleted; deleting is the honest default once 2.9 lands.

**F15: Already fixed; the audit text and DESIGN are stale.** Do not plan work for these:
`patch.ts` index padding and prototype pollution (Phase 1.1: `MAX_ARRAY_PADDING = 10_000` at
`patch.ts:135`, enforced at `:222-227` and `:209`, `:292`; `FORBIDDEN_TOKENS`/`isForbiddenToken`
`patch.ts:118,138,167`), so audit 23 §3 and DESIGN I4's `patch.ts:163-165` citations are obsolete;
`probeSession`'s raw-token `Cookie` header and the credential-in-`reason` leak (fixed: `session.ts:157-171`
`buildProbeCookie` + `validateCookieHeaderValue` throwing `MgConfigError` and not echoing the
value by design), so audit 23 §4, audit 05 §3 and DESIGN I3's `session.ts` citations are obsolete. Recommend
annotating those two audit reports rather than re-auditing them.

**F16: State-tree growth from patch *appends* is not bounded by `MAX_ARRAY_PADDING`.** `patch.ts:142-144`
appends for the `-` key without consulting the padding guard at `:150`/`:209`/`:292`, and repeated patch
frames can extend any array indefinitely. **Disposition: not a Phase 2 defect; defer with a rationale.** The
state tree's *size* is server-authoritative by construction (a single frame may legally replace the whole
tree with up to `MAX_FRAME_BYTES`), so bounding append growth alone would not bound memory; the amplification
case, one small path token allocating tens of thousands of slots, is what `MAX_ARRAY_PADDING` already
closed. A real bound is a state-size policy question for Phase 4, and it should be raised there rather than
bolted onto the wire layer.

**F17: `reportedStale` grows monotonically.** `sequencer.ts:284` is cleared only by `seed`/`reset`/`rollback`.
**Disposition: task, folded into 2.9, step 2.**

**F18: `RoomSocket.pendingSubscriptions` is never reclaimed.** `room-socket.ts:97` is drained only inside
`connect()` (`:140`) while `destroy()` bails when `client === null` (`:179`), so a subscribe-then-never-connect
lifecycle retains every handler closure. **Disposition: task, folded into 2.7 Part A, step 4.**

**F19: Two missing `clear()`s, both deferred.** `bootstrapped/src/attach/transport.ts:122-124` never clears
its three handler sets (its `close()` at `:261` drains only `detachers`), and `headless/client.ts:514-516`
deletes only the listener, so every event name ever subscribed leaves an empty `Set`, which
`common/emitter.ts:42` already gets right. Both are bounded by closed key spaces and cost bytes, not
unbounded memory; the emitter one is **covered by Phase 3.2** (emitter convergence) and the attach one belongs
with Phase 3.7/Phase 6. **Disposition: defer.**

**F20: Everything else I inventoried is bounded, so 2.4 must not be widened.** Verified bounded:
`renumber.ts:147` (`MAX_REMEMBERED_IDS = 256`, oldest-out, the pattern to copy), `log.ts:63` (ring buffer at
500), `emitter.ts:15` (prunes empty keys), `ctors.ts:272` and `renumber.ts:508` and `world.ts:943` and
`rive.ts:464` (WeakMaps: `world.ts:943`'s `imageTextures` is GC-bounded, correcting an older audit claim),
`rive.ts:463` (`forget`/`clearAll`), `client.ts:145 fifoByAction` (drained per action at `:423`),
`bundle.ts:230` (keys are library literals, `void key;` at `:294`), `remote-json-source.ts:63,65` (enum-keyed),
`forms.ts:480` (`getActionSpec`-validated), `patch.ts`/`close-codes.ts`/`codec.ts` (fixed literals).
No `Map`/`Set` in `src/` is keyed by wire-supplied data: `pending`/`fifoByAction` keys are locally minted or
outbound, `sequencer.outstanding` is inserted only for our own commands (`isOwn`, `:317`), and the patch
applier's wire segments reach property assignment guarded by `isForbiddenToken`, not a map key. **Disposition:
not a defect; do not add work.** Also deferred: `world.ts:171 cinematicClaims` (unbalanced
caller refcounts), `storage.ts:331 corruptWarned` (never reclaimed, storage-key-bounded), `jotai` atom
registries (bounded by the game's module count).

---

## Verification plan

**Per task, before committing (the definition of green):**

```bash
npm run lint          # biome: 0 diagnostics; docs/ is excluded
npm run typecheck     # tsc -b --force AND tsc -p tsconfig.tests.json, both exit 0
npm test -w @mg.js/common        # or the package the task touches
npm test -w @mg.js/headless
npm test -w @mg.js/bootstrapped
npm run verify        # lint → typecheck → build → test → size, exit 0
```

Green means: `biome check` reports 0 diagnostics; both TypeScript projects exit 0 (a test-only type error is
only visible to `tsconfig.tests.json`, so `npm test` alone is not enough); the `node --test`
summary reports the expected test count with **0 fail and 0 skipped** (the Phase 1 baseline was 500 tests);
`npm run build` exits 0 and the userscript remains one self-contained file; `npm run size` reports the
measured byte delta under the budget.

**Per task:** the *new* test must be run on its own first and the failure recorded, e.g.
`node --import tsx --test packages/common/tests/protocol/codec.test.ts`. A test that has never been seen
failing is not evidence (DESIGN I8).

**Phase-level gate, after all nine commits:**

```bash
git log --oneline -9                 # nine fix(...) commits, one per task
npm run verify                       # the whole gate, exit 0
rg -n "MAX_FRAME_BYTES|oversizedFrame" packages/   # 2.1's constant and event are wired, not dead
rg -n "redirectPolicy|maxBytes" packages/common/src # 2.2/2.3's options are used, not inert
rg -n "maxEntries" packages/bootstrapped/src/render/sprite.ts  # 2.4 is real
rg -n "AbortController" packages/headless/src       # 2.5: the reconnect abort exists
```

> **Correction, Phase 2 close.** Two claims in this section are false against the tree.
>
> - "the Phase 1 baseline was 500 tests" (above): the Phase 2 branch point reported **566**
>   tests; Phase 2 closes at **736**. See the header correction and "Phase 2 close".
> - "`git log --oneline -9` shows nine `fix(...)` commits, one per task": the phase landed **18 `fix(...)`
>   commits** (nine task commits plus nine review closes), and its window also contains unrelated commits
> The two late review commits landed after that snapshot. The
>   per-task SHA groups are listed in "Phase 2 close".
>
> `npm run probe:guest` is also mislabelled here as "the connect-URL encoding oracle"; see the 2.3
> correction above: it probes `anonymousUserStyle` quoting, not path segments.

**Live checks (opt-in, need the network; run them once at the end of the phase, from a built tree):**

```bash
npm run build && npm run verify:socket   # the real wss:// handshake, version resolution, close classification
npm run verify:catalog                   # the real catalogue endpoints under the new streaming cap + redirect policy
npm run probe:guest                      # the connect-URL encoding oracle, after 2.3
```

Expected verdicts, so "green" is unambiguous. `verify:catalog` prints `PASS` for every reported check and
exits 0. `verify:socket`'s codes are `EXIT_DOCUMENTED = 0`, `EXIT_UNEXPECTED = 1`, `EXIT_NO_CONNECT = 2`
(`scripts/verify-socket.ts:78-80`), and its verdict is failed-up when the documented outcome was reproduced
but any reported check failed (`:372`): so exit **0** = the documented `4840 SessionExpired` rejection
reproduced *and* every check passed, exit **1** = a check regressed, exit **2** = it could not connect at all.
It must print a verdict line; Phase 0 records a bug where this script could exit 0 *without* one.
`probe:guest` uses the same three codes (`scripts/probe-guest-encoding.ts:59-61`): 0 only for the documented
encoding outcome, 1 for an unexpected finding, 2 for no connect.

**Phase exit criteria:** I4 and I5 have no remaining DESIGN §6 violations in `common`, `headless` or
`bootstrapped` source; every task's new test fails on the pre-fix tree and passes after; `npm run verify` is
green at each of the nine commits; and `docs/DESIGN.md` §6's I4/I5 violation lists are updated to point at
what now enforces the bounds (or emptied) in a final `docs:` commit, not counted as a Phase 2 task, but it
is what makes the phase's claim checkable.

---

## Phase 2 close (2026-09-13)

Phase 2 is complete: all nine tasks landed, every step above is ticked, and the I4/I5 wire-boundary gaps
DESIGN §6 recorded are closed.

**The nine SHA groups** (task commit first, then its review closes):

| Task | Commit(s) |
|---|---|
| 2.1 frame ceiling |, |
| 2.2 real byte cap |, |
| 2.3 redirect + URL policy |, |
| 2.4 bounded texture cache |, |
| 2.5 cancellable waits |, |
| 2.6 honest reconnect accounting |, |
| 2.7 `RoomSocket` reconnect + strict version |, |
| 2.8 canonical frontier + readiness gate | |
| 2.9 ledger reconciliation |, |

**Final baseline.** `npm run verify` is green at the close: **736 tests (bootstrapped 181, common 386,
headless 169)**, 0 fail, 0 skipped; bundle `298233 B` (291.2 KiB), within the size budget; both `tsc`
projects and Biome clean. (At the phase's branch point the suite was 566 tests, and the plan's "500" was
already stale when it was written.)

**Review closures.** (2.1: the raw-socket scrape is bounded too, and the `MAX_FRAME_BYTES` comment
is made honest), (2.2: `DEFAULT_MAX_RESPONSE_BYTES` made reachable from the catalog barrel, `.logs/`
ignored), (2.3: catalogue-fetch findings; origin/segment guards made to mean what
they say), (2.4: the cache bound is validated and both destroy hazards documented),
(2.5: every readiness wait settles and a superseded reconnect is cancelled), (2.6: test gaps
closed and a superseded in-flight attempt abandoned), (2.7: stable close/open/ready, and a
superseded refresh cannot stop a session), (2.9: a non-canonical frontier cannot fail a live
command).

**Invariants.** I4 and I5 have **no remaining *audit* violations**: all eleven are closed. The record, which
names the enforcing constant, function or test for each and also records the residuals the Phase 2 re-audit
turned up (rather than counting them as fixed), is `docs/DESIGN.md` §6, updated in
("docs(design): I3, I4 and I5 now name what actually enforces them"). Note that update was written
against the older tree, so it predates the two late review commits; §6's claim about Phase 2's
last commit is stale for that reason.

**Also in the phase window, not part of this plan's task table:** one landed commit closes the
attachment half of DESIGN I2 (task 1.5's "a released thing must not be handed out" invariant, for
the attachment rather than page hooks), and is a docs commit for the Phase 3 planner. The window
therefore contains more commits than "nine, one per task".
