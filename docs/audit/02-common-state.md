# Audit 02: `common/state` + `log.ts` + `emitter.ts`

Scope: `packages/common/src/state/{patch,pointer,store,paths,index}.ts`, `packages/common/src/log.ts`,
`packages/common/src/emitter.ts`. Every finding below was reproduced by executing the shipped source
through `node --import tsx` against the real modules (scratch harness deleted afterwards), not inferred.
**Error strategy (several, not one).** `packages/common/src/errors.ts:4-7` states the dominant pattern:
"Every failure this package can produce is a named class, so callers can branch on type rather than on
message text" (`MgError` with a `code`, `cause` wired through `errors.ts:17-26`). `state/` does not use
it: `parsePointer` throws a bare `Error` (`pointer.ts:21`), the applier throws bare `Error`s that it
then catches and flattens to strings (`patch.ts:126`, `:133`, `:142`, `:275`), and every failure is
returned as `PatchOutcome.error: string` (`patch.ts:56`). So a caller of `applyPatch` cannot branch on
type at all, and the one place `state/` does throw escapes as an untyped `Error` (Finding 2). This is
inconsistent with `errors.ts`'s own documented contract; the fix is folded into F2 rather than scored
separately, since both are the same defect site.

---

## F1: Prototype pollution via the create-missing walk (critical, security)

`ensureContainer` reads `record[token]` **without an own-property check** (`patch.ts:175-183`) and then
writes back `record[token] = slot` (`patch.ts:180`). The sibling helper `resolvePointer` does guard the
same read (`pointer.ts:85`), so the create-missing path is the odd one out. `ensurePath` (`patch.ts:198-211`)
is reached from `add` (`:231`) and `replace` (`:291`), both with `createMissing` defaulting to `true`
(`:404`).

Reproduced: `applyPatch({data:{}}, [{op:'add',path:'/__proto__/pwned/inner',value:'X'}])` walks
`document['__proto__']`, which is inherited and so *is* `Object.prototype`, creates `{}` on it at `:180`, then
fails the re-resolve at `:234-235`. Result: `applied=0` (reported failure) **and**
`Object.prototype.pwned === {}` afterwards. The pollution is permanent and realm-wide, and it happens on
patches the library reports as failed. Second vector, same class: `deepClone` assigns
`out[key] = deepClone(entry)` for every `Object.entries` key (`patch.ts:365-366`); for a document
containing an own `"__proto__"` key (reachable via `JSON.parse`) the key is dropped from the clone's own
keys and becomes its prototype. Reproduced: `Object.keys(clone) === ['ok']`, `clone.polluted === true`.

Why it matters: `@mg.js/bootstrapped` runs in the host game page, so polluting `Object.prototype` adds
enumerable properties to every object in the game's realm, and it breaks `for...in`, `JSON.stringify` and
React/jotai iteration for code the userscript does not own, which is the "breaks the host page" bar.
`@mg.js/headless` is a long-lived Node process; the same write corrupts every module's objects.

Fix: in `patch.ts`, add `function isUnsafeKey(token: string): boolean` (reject `__proto__`,
`constructor`, `prototype`) and use it in `ensureContainer(current: unknown, token: string, nextToken: string, context: OpContext): unknown | null`,
resolving `token` only when `Object.prototype.hasOwnProperty.call(record, token)` is true; in
`deepClone<T>(value: T): T` define keys with `Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true })`
instead of plain assignment. Breaking: **no**.

## F2: `applyPatch` throws on a malformed path instead of reporting a failed op (high, correctness)

`applyOperation` calls `parsePointer(patch.path)` first thing (`patch.ts:219`); `parsePointer` throws for
anything that is not `''` or `/`-prefixed (`pointer.ts:20-22`). Nothing catches it: `applyOne`
(`:443-501`) calls `attempt()` → `applyOperation` directly, and `applyPatch` (`:398-421`) has no
`try`. Reproduced: `applyPatch({data:{}}, [{op:'add', path:'data/x', value:1}])` throws
`Invalid JSON Pointer "data/x": ...`.

Why it matters: the caller contract says the frame handler "Never throws" (`client.ts:495`), yet
`handleStateFrame` calls `store.applyPatches(patches)` unguarded (`client.ts:600`), which is reached from
`transport.onMessage((raw) => this.handleRawFrame(raw))` (`client.ts:191`). One malformed `path` from
the server therefore unwinds into the socket's `message` listener (an uncaught exception in the page or
in the Node process), aborts the rest of the batch, and, because `applyPatch` returns nothing, leaves
the earlier ops of that batch mutated in place while `applyPatches` never reaches its
`patchCount`/`currentVersion`/`notifyAffected` lines (`store.ts:160-178`). Subscribers are never told
the tree moved: silent drift, which this module exists to prevent.

Fix: in `patch.ts`, wrap the parse in `applyOperation(document: unknown, patch: Patch, context: OpContext): string | null`
with `try { tokens = parsePointer(patch.path); } catch (error) { return error instanceof Error ? error.message : String(error); }`
so the failure lands in `PatchOutcome.error` like every other failure; and make `parsePointer` throw
`MgProtocolError` from `./errors.js` so the one remaining throw is branchable by type, as
`errors.ts:4-7` promises. Breaking: **no** (`applyPatch` gains a failure path it already documents;
`MgProtocolError` is a subclass of `MgError extends Error`, so existing `catch (Error)` sites are
unaffected, though `parsePointer`'s thrown type is part of its de-facto surface).

## F3: A failed `move` deletes the source: data loss with a misleading error (high, correctness)

`case 'move'` resolves the source, deletes it (`patch.ts:328`), and only then delegates to `add`
(`:332`). If the add fails, the deletion is not undone. Reproduced:
`applyPatch({data:{a:{hp:7},keep:1}}, [{op:'move',from:'/data/a',path:'/missing/target'}])` →
`applied=0, failed=1`, tree is now `{"data":{"keep":1}}`: `a` is gone but the operation is reported as
failed. Worse, the error surfaced is `Source path "/data/a" does not exist.`: the fallback passes
(`:461-493`) re-run the same op *after* the deletion, so the reported cause is an artefact of the
mutation rather than the real one (a missing destination parent). The same happens in strict mode
(`{createMissing:false}`): `{"data":{}}`.

Why it matters: the store's whole premise is that patch operations are trustworthy change information;
a `move` that half-applies loses game state (a garden tile, a slot record) while telling the caller
nothing happened, and the local tree silently diverges from the server's.

Fix: make the mutation atomic. In `applyOperation`, for `op:'move'` build the destination first:
`const destTokens = parsePointer(patch.path)` and resolve its parent (creating it when
`context.createMissing`) **before** `deleteAt(source.parent, source.key)`; if the destination cannot be
prepared, return the error with the tree untouched. Breaking: **no**.

## F4: `waitFor` swallows predicate errors: silent hang plus permanent subscription leak (medium, correctness)

The subscriber installed by `waitFor` calls the caller's predicate inside the handler
(`store.ts:254-256`), and every handler runs through `deliver`, which swallows all exceptions
(`store.ts:308-314`). The only code path that calls `unsubscribe()` is `finish()` (`:245-250`).
Reproduced with `timeoutMs: 300` and a predicate that throws on its second call: the promise settled
only as `Timed out waiting for "/data/n"`. The real error was never surfaced. With no `timeoutMs`
(the documented default; the option is optional at `:236`) neither `resolve` nor `reject` is ever
called and `this.subscriptions` keeps the entry for the process's lifetime, so every retry leaks a
listener, which is the unbounded set growth this audit asks about. A second, smaller inconsistency: the eager
check `if (predicate(existing)) return Promise.resolve(...)` at `:238-239` evaluates the predicate
*synchronously*, so a throwing predicate throws out of `waitFor` instead of rejecting the promise the
signature promises (`waitFor<T = unknown>(path: string, predicate: (value: unknown) => boolean, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T>`).

Why it matters: a caller's typo in a predicate becomes an infinite hang with no error anywhere, and a
reconnect loop that calls `waitFor` per attempt grows the listener set without bound.

Fix: in `store.ts`, evaluate the predicate inside `try/catch` inside the subscription (and inside the
executor) and route a throw to `finish(() => reject(error))`, e.g.
`const safe = () => { try { return predicate(change.value); } catch (error) { finish(() => reject(error)); return false; } }`.
Breaking: **no**.

## F5: `Logger.child().setLevel()` reports one level and filters by another (medium, consistency)

`child()` builds a real child logger through `createLogger({ level, ... })` (`log.ts:151`) whose `emit`
closure reads the child's **own** captured `level` (`:132-133`), then `Object.assign` overrides the
child's `level`/`setLevel` to read and write the *parent's* variable (`:153-157`). Reproduced with a
capturing sink: `const c = createLogger({level:'warn', sink}).child('x'); c.setLevel('debug')` →
`c.level() === 'debug'` and the root's `level()` is also `'debug'`, yet `c.debug('m')` writes **nothing**
(the frozen `warn` threshold filters it); after `log.setLevel('debug')` the child still writes nothing.

Why it matters: `Logger.setLevel` is documented as "Change the level at runtime" (`log.ts:106-107`), and
this is the API a userscript settings toggle would drive. A child reports a level it does not honour, and
`child.setLevel` silently mutates the whole tree's level as a side effect, which is the opposite of the
per-namespace control the `child()` doc comment implies, and the code's own comment ("Keep the child's
level in step with the parent after this point") describes behaviour it does not have.

Fix: give the tree one shared level holder:
`function createLogger(options: LoggerOptions & { levelRef?: { level: LogLevel } } = {}): Logger`, have `emit`
read `levelRef.level`, and implement
`child(namespace: string): Logger` as `createLogger({ namespace: `${namespace}:${childNamespace}`, levelRef, sink })`
so parent and children observe the same variable and no `Object.assign` override is needed.
Breaking: **no** (`Logger` keeps its shape; `LoggerOptions` only gains an optional field).

---

## Lower-priority observations (verified, not in the top 5)

- **`pointer.ts:76` coerces array indices with `Number()`**, so `''`, `' '`, `'0x01'` and `'1e2'` are
  valid indices: `resolvePointer({a:[9,8,7]}, '/a/ 2')` resolves to index 2, and
  `applyPatch({players:[{id:'a'},{id:'b'}]}, [{op:'remove',path:'/players/'}])` removes player **0**
  (`applied=1`). `patch.ts:109` already has the strict rule (`/^(0|[1-9][0-9]*)$/`) for `add`; the two
  halves of the same module disagree. Fix: export `isArrayIndex` from `patch.ts` (or move it into
  `pointer.ts`) and use it at `pointer.ts:76`, returning `{ found: false }` otherwise. Medium.
- **`emitter.ts:32-41`: `once()` cannot be cancelled with `off()`.** `once` registers a wrapper, so
  `em.off('e', originalListener)` after `em.once('e', originalListener)` is a no-op: reproduced, the
  listener still fired after `off`. `off` is documented as "Unsubscribe" (`:43-44`) with a listener
  parameter that is not the registered one. Also `on()` uses a `Set`, so registering the same function
  twice adds one entry and the first detach (`:28`) removes both registrations (reproduced:
  `listenerCount === 0` after the first `off`). Fix: keep a `Map<Listener, Set<Listener>>` of wrappers,
  or return the wrapper from `on` and have `off` accept it. Low/medium.
- **`log.ts` has no redaction hook.** `record.fields` and `record.error` reach `ConsoleLogSink` verbatim
  (`log.ts:41-42`) and are retained by `MemoryLogSink` (`:61-64`, whose `snapshot()` is a bug-report
  dump). Call sites are currently careful: `AuthProvider.note` is explicitly forbidden from carrying
  the token (`packages/headless/src/auth/types.ts:52-56`) and `describeCookie` reports a length, not a
  value (`packages/headless/src/auth/cookie.ts:88-93`), but nothing prevents a field from carrying a
  credential, and the connect URL (which includes `AuthProvider.query`, appended at
  `packages/headless/src/client.ts:654`) is logged verbatim at `packages/headless/src/client.ts:710`.
  `query` carries no "never secret" contract the way `note` does. Fix: add
  `function redactRecord(record: LogRecord, redact: readonly (string | RegExp)[]): LogRecord` and a
  `redact?: readonly (string | RegExp)[]` field on `LoggerOptions`, applied in `emit` before
  `sink.write(record)`. Low.

## What works well here

- `resolvePointer` is hostile-input aware: it guards inherited properties with
  `Object.prototype.hasOwnProperty.call` (`pointer.ts:85`), bounds-checks array indices, and returns
  `{ found: false }` for malformed pointers instead of throwing (`pointer.ts:53-62`), so the pollution in
  F1 is confined to the one helper that skipped this discipline.
- The four-pass priority scheme is not just documented but reasoned (`patch.ts:423-441`), including why
  creation must not be combined with a `/child` guess (`:476-489`), and every fallback is recorded as
  `resolution` on a same-length `outcomes` array (`:38-53`, `:65-66`), so drift is diagnosable rather
  than silent.
- `JsonPatch` is a thin facade over the one applier (`patch.ts:556-593`) rather than a second
  implementation that can disagree, and the "not instantiable" rule is enforced at runtime (`:563-565`).
- `Emitter.emit` snapshots the listener set with `[...set]` (`emitter.ts:61`) and isolates throws, so
  delete-during-emit and one bad handler cannot break delivery or unwind into the socket handler.
- Diagnostics are cheap and real: `store.stats` (`store.ts:106-113`) exposes version/patch/failure/
  subscriber counts, `MemoryLogSink` is bounded (`log.ts:61-64`), and `MultiLogSink` isolates a broken
  sink (`:84-92`).
