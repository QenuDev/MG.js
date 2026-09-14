# Audit 04: `@mg.js/common` catalogue layer

Scope: `packages/common/src/catalog/` (http.ts, index.ts, platform-source.ts, remote-json-source.ts,
source.ts, static-source.ts, types.ts, weather.ts). Callers checked with grep across
`packages/{common,headless,bootstrapped}/src` and `packages/common/tests`.

Baseline accepted as working: `tsc -b --force` clean, catalogue tests present for merging, provenance,
degradation, TTL, dedupe and the live shop/weather shapes. Findings below are things those tests do not
cover, plus two exported helpers that do not do what their own doc comments claim.

---

## 1. Unvalidated entity payloads become fake entities and hide `missing` (high, correctness)

`assignKind` accepts *any* value for the seven entity kinds and only checks `Array.isArray`:

- `source.ts:250-252`:
  `catalog[kind] = Array.isArray(value) ? (value as never) : (normalizeEntityMap(value) as never)`
- `source.ts:264-273`: `normalizeEntityMap` maps **every** own key of any object to an entity:
  `Object.entries(value).map(([id, entry]) => ... { id, ...record } ... { id, value: entry })`.

Chain that makes this fire on a normal path: `RemoteJsonSource.defaultUnwrap`
(`remote-json-source.ts:110-119`) only unwraps a single-key object when the key equals the kind or
`${kind}s`; anything else is returned untouched. So an HTTP-200 error/coverage body from a mirror or the
reference deployment is stored as real catalogue data. Here are three examples:

- `{"error":"rate limited"}` → `plants = [{ id: 'error', value: 'rate limited' }]`
- `{"success":true,"data":[...]}` → `plants = [{ id: 'success', value: true }, { id: 'data', value: [...] }]`
- a bare string / number → `normalizeEntityMap` returns `[]` (`source.ts:266`)

In all three cases the body is stored as real catalogue data, `provenance.plants` names the source, and
`remaining.delete(kind)` (`source.ts:172`) removes the kind from `catalog.missing`. A caller therefore sees a *populated* category
where the honest answer is "the source did not deliver a plant list". The same file's own doctrine says
that "a `null` field means no configured source could provide that category" and that it "is never an empty
placeholder pretending to be data" (`types.ts:158-161`), and the empty-array branch violates it.

Related, same function: `source.ts:231-232` does `catalog.version = typeof value === 'string' ? value : String(value)`,
so a JSON object becomes the literal string `"[object Object]"`, while `PlatformApiSource.fetchVersion`
treats an unreadable version as fatal (`platform-source.ts:120-125`) and `headless/src/version.ts` uses
that throw to drive the `4710` reconnect cure. The client's coercion defeats the source's guard for every
non-platform source.

Fix: make the entity branch validate instead of coerce. That means a function with this signature,
`function toEntities(kind: CatalogKind, value: unknown): GameEntity[]`, which throws unless
`Array.isArray(value)` and every entry is a non-null object with a string `id`. Let
the existing `catch` at `source.ts:173-175` leave the kind unclaimed so it lands in `missing`. Drop the
`String(value)` fallback for `version` and let a non-string version count as a source failure.

## 2. Source failures are invisible in the only production wiring (medium, architecture)

`loadAll` swallows every source error into an optional callback (`source.ts:173-175`), and
`load()` always resolves (`source.ts:95-115`). The single real consumer constructs the client with no
callback: at `bootstrapped/src/client.ts:400` it runs `this.catalogClient = new CatalogClient({ sources });`.

Consequence: with every endpoint down, `catalog.missing` is all 11 kinds and nothing anywhere records
why. `missing` cannot distinguish "the source threw" from "the source had nothing" (the same ambiguity the
`nullOffers`/`provenance` machinery was built to remove for the `null` case), there is no retry signal, and
the failure is cached for the full TTL (`ttlMs` default 300 000, `source.ts:63`). Because `onSourceError`
is optional and undocumented as required, the natural wire-up is the one that silently loses diagnostics.

Fix: default `onSourceError` to a `console.warn`-level logger in `CatalogClient`'s constructor and add
`readonly errors: Partial<Record<CatalogKind, unknown>>` to `DomainCatalog` (populated in `loadAll`'s
`catch`), so a caller can tell a broken source from an empty one; pass an `onSourceError` through at
`client.ts:400`.

## 3. `maxBytes` does not bound memory, and is not bytes (medium, security)

`http.ts:80-87` is documented as "Cap on the response size in bytes, to bound a hostile or broken
endpoint. Default 8 MiB" (`http.ts:21-22`):

- `http.ts:80`: `const text = await response.text();` buffers the **entire** body first.
- `http.ts:82`: `if (text.length > maxBytes)`. `.length` is UTF-16 code units, so a 8 MiB cap rejects
  valid multibyte responses early and lets ~16 MiB of ASCII through.
- `http.ts:71-72`: the non-2xx path calls `safeText(response)` with **no** cap, so an error body of any
  size is buffered and then truncated to `bodyPreview.slice(0, 300)`.

So the cap is a post-hoc assertion, not a bound: a hostile endpoint can still force an unbounded
allocation, which is the DoS the class docstring claims to fix. No test exercises `maxBytes`
(grep of `packages/common/tests` finds no `fetchJson`/`maxBytes` reference).

Fix: check `response.headers.get('content-length')` before reading, then stream `response.body` through a
counter and abort past the cap, in a helper with this signature:
`async function readCapped(response: Response, maxBytes: number): Promise<string>`. Then
route the error path through the same helper.

## 4. The ETag / `If-None-Match` machinery is unreachable (medium, missing-capability)

`remote-json-source.ts:9-10` documents "sends `If-None-Match` when it has an ETag and treats 304 as 'no
change'", and `load` implements the send half at `remote-json-source.ts:81-83`. But `this.etags` is only
ever written by `setETag` (`remote-json-source.ts:104-106`), and `setETag` has **no callers anywhere** in
`packages/*/src` or `packages/*/tests` (grep: only the declaration, its `dist` `.d.ts`, and doc comments).
It cannot acquire one, because `fetchJson` returns only the parsed body (`http.ts:90`) and discards
`response.headers` entirely.

The 304 test masks this: `tests/catalog.test.ts:458-478` returns a `304` *unconditionally* on the second
call and asserts only the payload and call count. It even puts `ETag: 'abc'` on the response, which
nothing reads. Net effect: every refresh re-fetches every full category payload, which is the cost the
feature was written to avoid, against a server the header text says "caches aggressively".

Fix: add `fetchJsonWithMeta<T>(url: string, options?: FetchJsonOptions): Promise<{ data: T; etag: string | null }>`
in `http.ts` and have `RemoteJsonSource.load` call `this.setETag(kind, etag)` from it. Alternatively,
delete `setETag` and the `If-None-Match` branch if conditional requests are out of scope.

## 5. `hasWeather` collapses the two states it exists to separate (medium, api-design)

`weather.ts:143-145`:

```ts
export function hasWeather(forecast: WeatherForecast | null): boolean {
  return forecast !== null && (forecast.current !== null || forecast.upcoming.length > 0);
}
```

`hasWeather(null)` (no source supplied weather) and `hasWeather({ current: null, upcoming: [] })` (the
server said nothing is active) are **both `false`**. The test that is supposed to pin the distinction
asserts exactly that identical result under the title "hasWeather distinguishes 'nothing active' from 'no
weather data'" (`tests/weather.test.ts:141-143`), so the assertion cannot fail either way.

This matters because `types.ts:166-176` sells the two states as "a different and much more useful answer",
and `weather.ts` line 26-28 argues "a caller asking 'what is coming' must not read a null `current` as
'nothing to see'". A caller gating a UI or a scheduling decision on `hasWeather` cannot tell "the forecast
never arrived / the request failed" from "confirmed calm". It renders "no weather" in the first case.

Fix: keep `hasWeather` as "has something to show" (fix its doc comment) and export a second predicate in
`weather.ts`: `export function weatherKnown(forecast: WeatherForecast | null): boolean { return forecast !== null; }`,
so absence of data and absence of weather are separately expressible.

## Lower-severity notes (not counted as findings)

- `source.ts:160-177` loads sources × kinds strictly sequentially. A `RemoteJsonSource` refresh is 11
  serial request/response round-trips (`CATALOG_KINDS` has 11 entries, `types.ts:35-47`) at up to
  `timeoutMs: 10_000` each (`http.ts:54`), against endpoints the class comment calls rate-limited. A
  bounded `Promise.all` per source would collapse this without changing semantics.
- `static-source.ts:44-49` returns the caller's value by reference (and `load` of a cached catalogue hands
  the same graph to every `load()` caller and `subscribe` listener via `source.ts:68-70`), so a consumer
  mutating `catalog.plants` corrupts the source's stored data permanently; `bootstrapped`'s
  `createBundleSource` explicitly defends against this same mutation with `[...entries]`
  (`packages/bootstrapped/src/catalog/bundle.ts:389-391`).
- `normaliseWeatherSlot({})` legitimately yields an all-null slot (`weather.ts:95-105`), but
  `normaliseWeatherBlock` pushes such entries (`weather.ts:124-127`) and `hasWeather` then reports `true`
  for a forecast made entirely of empty slots.
- `http.ts:59-63` + `http.ts:101-105`: an abort from the caller's own `signal` is reported as
  "timed out after 10000ms", so cancellation and a timeout are indistinguishable by message or status.
  No current caller passes `signal` (`PlatformApiSource`/`RemoteJsonSource` `fetchOptions` are unset
  everywhere), so this is a note rather than a finding.
- `http.ts:10-14` exports `DEFAULT_HEADERS` as a mutable module singleton spread into every request.

## What works well here

- The `null`-offer resolution (`source.ts:144-184`) is a careful fix: a resolved `null` is
  recorded as a value with provenance instead of being conflated with "no source had it", and a later real
  value still wins, pinned by tests at `tests/catalog.test.ts:202-243`.
- Failure policy is per-category: one dead source never takes the catalogue down, and provenance plus
  `missing` make *which* source supplied *which* category answerable from the data alone.
- The `PlatformApiSource` shops/weather dedupe (`platform-source.ts:56-106`) removes a duplicated
  request and, as a side effect, makes the shops and the forecast describe one instant.
- Weather modelling records the live quirks accurately: nullable `current`, independently nullable
  `weatherId`/`name` with a populated `groupId`, and half-open `startsAt <= at < endsAt` windows
  (`weather.ts:150-172`).
- The wire shapes carry their evidence. `ShopState.nextRestockAt: string | null` and the undocumented
  `catalog` field both cite what the live endpoint actually returns (`types.ts:112-152`) instead of
  guessing a tidier type.
