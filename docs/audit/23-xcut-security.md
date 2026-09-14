# Audit 23: cross-cutting security pass

Scope: the whole repository (`packages/*/src`, `packages/*/scripts`, `scripts/`, every `package.json`,
`tsconfig*.json`). This pass asks what a *frame*, a *host slot* and a *cookie* do as they cross package
boundaries; findings whose blast radius sits inside one package are left to that package's report.
Ranked by real exploitability in the two deployments: a Node client holding a stolen `mc_jwt`, and a
userscript injected into a page the game also controls. Every finding was reproduced by executing the
shipped source (`node --import tsx`); every citation is a line I opened.

---

## 1. `WorldScene`'s tile suppression is neither identity-guarded nor multi-scene safe, and it permanently kills the game's tile redraw

**Severity:** critical · **Category:** correctness · **Breaking:** no

**Evidence.** `world.ts:845-851` records the *current* slot value and writes a bare no-op over it
(`const wasAbsent = !hasOwnProperty(target,key); const original = target[key];`
`restores.push({target,key,value:original,wasAbsent}); target[key] = function suppressed(){}`), and
`world.ts:290-295` replays those records unconditionally
(`if (restore.wasAbsent) delete restore.target[restore.key]; else restore.target[restore.key] = restore.value;`).
`world.ts:513-517` (`suppressTiles`) walks the **game's own** world container, so the tile objects are
shared with the host page, and `client.ts:858-864` (`worldScene()`) returns a fresh `WorldScene` per
call, so two live scenes are a supported configuration.

Reproduced: two scenes entering the same prototype-backed tile, A then B, with A exiting first.
`B[0].wasAbsent === false`, so B captured *our* no-op as "the original", and after both `exit()` calls
`hasOwnProperty(tile,'draw') === true` with `tile.draw()` returning `undefined`: the prototype `draw`
is shadowed forever. That is precisely the outcome `world.ts:837-838` promises to avoid, and it is
order-dependent, so it will present as intermittent.

**Why it matters.** The userscript's contract is coexistence: leave the host page as found. Here the
farm tiles cannot redraw for the life of the page, which crosses the "breaks the host game page" bar. The
same unguarded write destroys any *foreign* mod that patched `draw` after us, which is the very thing
`coexistence/brand.ts` exists to prevent: `world.ts` never uses `installHook`/`restoreSlot`, unlike
`bundle.ts:308` and `pixi.ts:241-248`.

**Fix.** Guard both directions. `recordAndWrapNoop(restores: Restore[], target: Record<string, unknown>, key: string): boolean`
must return `false` when `target[key]` is already one of our suppressed functions, suppression must be
reference-counted per `(target, key)` in a module-scope `Map`, and `exit()` must skip a restore whose
slot no longer holds what we wrote.

---

## 2. The userscript entry point overwrites `window.__mgjs` (the realm namespace) with the client, so `uninstall()` throws and a second load cannot install

**Severity:** high · **Category:** correctness · **Breaking:** no

**Evidence.** `userscript.ts:189` installs the client, which claims the namespace: `client.ts:366` →
`claimInstall` → `getNamespace` → `realm.ts:239` `page[NAMESPACE_KEY] = created`, with
`NAMESPACE_KEY = '__mgjs'` (`realm.ts:52`). Then `userscript.ts:205-210` assigns
`page['__mgjs'] = client` and `globalThis['__mgjs'] = client`. `getNamespace` refuses anything that is
not a namespace (`realm.ts:221-228`, guard at `realm.ts:205-208`) and `BootstrappedClient` has no
`marker`, so every later call throws. Reproduced against the module: `second getNamespace THROWS: mg.js:
the page global "__mgjs" already exists and was not created by mg.js.` (and the same for `onTeardown`).

On the shipped artifact, `client.ts:681` `releaseInstall(...)` throws **outside** `attemptTeardown`, so
`uninstall()` aborts before the namespace teardowns, before `deleteNamespace` (`client.ts:687-692`) and
before `emitNamespaceEvent('uninstalled')`, while `window.__mgjs` keeps pointing at a released client.
A second load (or a mod calling `new BootstrappedClient().install()`) throws inside `claimInstall`,
caught at `userscript.ts:190` and downgraded to a console error. `peekNamespace` returns `null` for the
clobbered slot, so `deleteNamespace` can never clean it up.

**Why it matters.** `packages/bootstrapped` MUST uninstall cleanly, restoring every global. This is the
one global it owns, and it is left installed with a live-looking value after a throwing uninstall. It
also makes the documented two-load coexistence path unreachable through the only shipping entry point.

**Fix.** Publish the client *inside* the namespace: `defineGlobal('client', client)` (`realm.ts:259`)
plus `globalThis['__mgjsClient'] = client`, and update the badge text at `userscript.ts:261`.
Independently wrap `client.ts:681` in `attemptTeardown('claim release', () => releaseInstall(...))`.

---

## 3. A non-canonical array index in a patch *parent* segment bypasses `isArrayIndex` and pads the array without bound

**Severity:** high · **Category:** security · **Breaking:** no

**Evidence.** The leaf index uses the strict gate (`patch.ts:109-111` `/^(0|[1-9][0-9]*)$/`, applied at
`patch.ts:243`), but `ensureContainer` uses a bare `Number()`. It is reached for every *parent* segment of
`add`/`replace` when `createMissing` is true (`patch.ts:404` defaults it to `true`):
`const index = Number(token);` (`patch.ts:163`) then `while (current.length <= index) current.push(null);`
(`patch.ts:165`). So `1e9`, `0x100000` and `' 12'` pass as parent segments while being rejected as
leaves. Reproduced through the shipped `applyPatch`:

```
add /data/arr/20000000/x  ->  applied: true, arr.length: 20000001, 238 ms
```

`1e9` scales that to ~8 GB and ~12 s of blocking work. The frame arrives through `codec.ts`'s
`extractPatches` (`return direct as Patch[]`, no element validation) into `common/src/client.ts:600`
`store.applyPatches(patches)`, in **both** deployments; in the userscript that call is on the game
socket's `message` path. `patch.ts:245-251` has the same uncapped loop
(`while (parent.value.length < index) parent.value.push(null)`).

**Why it matters.** One server frame, or one frame injected into a stolen-cookie Node session,
exhausts memory or hangs the tab. The disagreement about what an index *is* is also a correctness bug:
`resolvePointer` (`pointer.ts:76-77`) accepts `01` and `0x10`, so `/list/01` and `/list/1` address the
same element while `pointerContains` (`pointer.ts:105-109`) string-compares them, and subscribers
silently miss the change.

**Fix.** Export one gate from `pointer.ts`, `isArrayIndex(token: string): boolean`, and use it in
`ensureContainer` and `resolvePointer`. Add `ApplyPatchOptions.maxPad?: number` (default e.g. `1024`)
and return `null` when `index > current.length + context.maxPad`, so a patch can extend an array by a
bounded amount only.

---

## 4. `probeSession` interpolates the token into a header, then copies the resulting error into `reason`, a field documented "safe to log"

**Severity:** high · **Category:** security · **Breaking:** no

**Evidence.** `session.ts:150-151` states the contract:
`/** A human-readable explanation, safe to log. */ reason: string;`.
`session.ts:173-175` builds the header with no validation:
``headers.Cookie = `${SESSION_COOKIE_NAME}=${options.token}`;``
and `session.ts:224` returns the runtime's message verbatim:
``: `The session probe could not complete: ${error instanceof Error ? error.message : String(error)}`,``.
Reproduced with `token = 'abc\r\nX-Injected: 1'`: undici rejects the header and `reason` becomes
`The session probe could not complete: Headers.append: "mc_jwt=abc\nX-Injected: 1" is an invalid header value.`
That is the credential, verbatim, in the one field callers are told is safe to persist. The same holds for a
`\0` or a lone `\r`. A well-formed JWT does not leak here; the trigger is any token the fetch layer
refuses, which includes the whole-cookie-string form `cookie.ts:24-28` explicitly accepts.

**Why it matters.** `MemoryLogSink` exists "for a bug-report dump" (`common/src/log.ts:52-64`), so a
caller writing `reason` to a log, which the type doc invites, puts a live `mc_jwt` into a shareable
artefact. Same class as the leak at `client.ts:692-694`, arriving by a different route and behind a
type-level promise that it cannot happen.

**Fix.** Validate before use and never echo the header back. Add to `headless/src/auth/cookie.ts`
`export function assertCookieHeaderSafe(value: string): void`, throwing on `/[\r\n\u0000]/`, called
from `toCookieHeader` and from `session.ts:174`; and make the catch at `session.ts:218-225` report only
`error.name` plus a fixed string, e.g. `` `The session probe could not complete (${error.name}).` ``.

---

## 5. Catalogue fetches follow redirects with no policy, from a URL the caller's `baseUrl`/`paths` can reshape freely

**Severity:** medium · **Category:** security · **Breaking:** no

**Evidence.** `catalog/http.ts:66-69` passes no `redirect` option, so the fetch default (`follow`, up to
~20 hops) applies: `const response = await fetch(url, { headers: {...DEFAULT_HEADERS, ...options.headers},
signal: controller.signal });`. The URL is plain concatenation of two unvalidated inputs,
`remote-json-source.ts:69-70` / `:86`: `this.baseUrl = options.baseUrl.replace(/\/+$/, '');` ...
`this.paths = {...DEFAULT_REMOTE_PATHS, ...options.paths};` ... ``await fetchJson<unknown>(`${this.baseUrl}${path}`, {...})``.
No scheme check, no host pin, no path normalisation: `baseUrl: ''` with
`paths: { plants: 'http://169.254.169.254/latest/meta-data/' }` fetches link-local metadata, and
`baseUrl: 'https:'` with `paths: { plants: '//evil.test/x' }` retargets the origin. Even a correctly
pinned origin is bypassable, because a `302 Location: http://127.0.0.1:9200/` is followed silently.

**Why it matters.** `RemoteJsonSource` is exported (`catalog/index.ts:41`) and documented for "a local
instance, a self-hosted mirror, or a different implementation" (`remote-json-source.ts:11-13`), the case
where the base URL arrives from config, a CLI flag or a remote config file. In-repo callers use
the hardcoded `PlatformApiSource` (`bootstrapped/src/client.ts:398`), so this is a latent
SSRF/allowlist-bypass in an exported surface, not a live exploit, hence medium. Undici strips
`Cookie`/`Authorization` across an origin change, so no credentials travel.

**Fix.** Validate at construction, then follow redirects yourself. In
`constructor(options: RemoteJsonSourceOptions)` parse `options.baseUrl` with `new URL`, require
`protocol === 'https:'`, and reject any `paths` value that is absolute or starts with `//`. Add
`redirectPolicy?: 'manual' | 'error' | 'follow'` to `FetchJsonOptions` in `catalog/http.ts`, defaulting
to `'manual'`, and re-assert the origin on each `Location` before the next hop.

---

## Smaller cross-cutting items

- **`@mg.js/common` compiles with the DOM lib, so the "no DOM globals" hard rule is unenforced.**
  `tsconfig.base.json:5` sets `"lib": ["ES2022","DOM","DOM.Iterable"]` and `packages/common/tsconfig.json`
  does not override it, so `fetch`/`AbortController`/`AbortSignal`/`Response`
  (`catalog/http.ts:20,55,66,112`) and `URL` (`protocol/connect-url.ts:57`) all type-check there. The
  package is import-free (zero `dependencies`; no `node:*`, no `ws`), but the boundary is
  convention rather than a compiler rule. Fix: `"lib": ["ES2022"]` for `packages/common` plus a
  `FetchLike`/URL-parser seam injected from headless and bootstrapped. No ESLint config exists anywhere
  in the repo; the planned Biome/ESLint adoption should add `no-restricted-globals` for
  `document`/`window`/`localStorage` under `packages/common/src`.
- **Patch values are inserted by reference and the caller's array is republished.** `patch.ts:240,250,253,260,297`
  assign `patch.value` directly and `store.ts:174` puts the caller's `patches` into every `StateChange`, so
  `ps[0].value` is a live handle into authoritative state with no version bump and no notification.
  Relatedly, **no transport bounds an inbound frame**: a grep of `packages/` for
  `maxPayload|maxFrame|frameSize|maxMessage` returns nothing, the only byte cap in the tree (`catalog/http.ts:81`) fires after the whole body is buffered, `headless` never sets a `ws` `maxPayload`, and `runtime.ts:244-257` decodes any payload.

## What works well here

- `coexistence/brand.ts` is the right shape where it is used: `classifySlot` (own-property check),
  `installHook` (chain a foreign wrapper, never replace it), `restoreSlot` (`brand.ts:276-283`,
  `if (record[key] !== installedRef) return false`). The only host slots bypassing it are finding 1's.
- `catalog/http.ts`'s `AbortController`/timer lifecycle is leak-free (`http.ts:55-63` honours an
  already-aborted caller signal; `http.ts:106-109` clears the timer and removes the listener), and every
  transport failure surfaces as a typed `HttpError` rather than a bare `TypeError: Failed to fetch`.
- `auth/cookie.ts:88-94` `describeCookie` logs only `mc_jwt present (N chars)`, so the credential rule is
  written down and honoured at the provider; findings 2 and 4 are the two places that route around it.
- The caches reachable from untrusted input are capped: `renumber.ts:213-222` bounds `ownRequestIds` at
  `MAX_REMEMBERED_IDS = 256` with oldest-out eviction, and `common/src/log.ts:53-64` bounds
  `MemoryLogSink` at 500 records.
- Supply chain is small and honest: 65 lockfile entries, all first-party workspaces, TypeScript,
  `tsx`/`esbuild` (build-time only) or `ws`; all three packages are `"private": true` with
  `files: ["dist"]`; the userscript build (`build.ts:114-134`) is `bundle: true, format: 'iife',
  platform: 'browser', sourcemap: false` with no `define`/`external`/`inject`, confirmed against the
  committed 283 KB artifact (no `import`/`require`, no `sourceMappingURL`, no absolute paths). Nit:
  `ws` sits in **both** `optionalDependencies` and `peerDependencies` of `@mg.js/headless`, so the
  "optional peer" design does not keep it out of a consumer's tree.
