# 03: `@mg.js/common`: ClientCore, actions, transport

Scope: `packages/common/src/client.ts`, `packages/common/src/actions/{actions,handle,index,types}.ts`,
`packages/common/src/transport/{types,index}.ts`, `packages/common/src/index.ts`.
Read in full, plus the files needed to check the claims: `protocol/{sequencer,codec,envelope,forms,types}.ts`,
`state/store.ts`, `tests/{client,forms,sequencer}.test.ts`, and the two client packages' construction sites.
Every finding was checked by opening the cited line; caller/dead-code claims by repo-wide grep (excluding
`dist/`). Facts established while checking, which several findings rest on:

- The 72-method action surface was mechanically cross-checked against `ACTION_SPECS`
  (`protocol/forms.ts:52-403`, 71 entries = 47 wrapped / 15 flat / 9 room): **0** wire strings sent that are not
  specs, **0** specs never sent, **0** form claims contradicted, **0** typed params silently unforwarded. The
  only duplicate wire string is `PlaceCrystal` (`actions.ts:253`, `:268`), kept consistent by
  `FuseCrystalParams extends PlaceCrystalParams` (`types.ts:162-164`).
- The 13 sites that pass an optional field unguarded (e.g. `actions.ts:141`, `:324`, `:529-565`) are harmless:
  `undefined` object fields are pruned at `protocol/envelope.ts:50` and again by `JSON.stringify`
  (`protocol/codec.ts:84`). The `wish` doc claim (`actions.ts:137-138`) is verified true.
- `CommandSequencer.sweepStale` (`protocol/sequencer.ts:410`) and `reset` (`:433`) have **no** production
  caller (only `tests/sequencer.test.ts:220-221`); `parseFrame` preserves the `Pong` payload verbatim
  (`protocol/codec.ts:79`) and `PongMessage.id` exists (`protocol/types.ts:192`).

## F1: `dispose()` wipes the subscribers of a caller-supplied store, defeating the option that exists to preserve them

**Severity:** high · **Category:** correctness · **Breaking:** no

**Evidence.** `dispose()` is the only way to release a core's transport listeners. The option doc says so
explicitly: "the only way to attach a different transport is to construct a new core; `attachTransport()` is
private and only `dispose()` releases the old listeners" and "Passing the previous core's store across a
reconnect keeps that reference live and keeps every subscription attached" (`client.ts:86-99`). The same
method then throws those subscriptions away: `client.ts:205-217`, last body line `this.store.clearSubscribers();`
at `client.ts:214`, which is `this.subscriptions.clear()` (`state/store.ts:271-274`). So the documented
reconnect recipe (dispose the old core, hand the old store to the next one) destroys the subscriptions
`ClientCoreOptions.store` was added to protect. The regression test pinning that contract,
`tests/client.test.ts:540-560`, never disposes the first core (it abandons it), so the real sequence is
untested. No in-repo caller ever passes `store` (`headless/src/client.ts:698-706`,
`bootstrapped/src/client.ts:235-244`), and headless documents the opposite of the truth:
"`@mg.js/common` does not let a caller supply the store" (`headless/src/client.ts:352-353`). So the
capability is both unused and, as shown, self-defeating.

**Why it matters.** A caller who caches `const store = client.store` (or subscribes to a path) follows the
documented recipe, gets no error, and simply stops receiving patches after the first reconnect. That is the
silent-failure bug `ClientCoreOptions.store` was written to fix.

**Fix.** In `ClientCore`, record `private readonly ownsStore = options.store === undefined` in the constructor
and make `dispose()` conditional: `if (this.ownsStore) this.store.clearSubscribers();`. Keep the store's own
`clearSubscribers()` for the bootstrapped page-teardown path, where the store really is the core's own. Then
pass the previous store at `headless/src/client.ts:698` and correct that getter's comment.

## F2: `ping()` can never succeed: its only reply is discarded, so `await` always rejects after 10s

**Severity:** high · **Category:** correctness · **Breaking:** no

**Evidence.** `ping()` sends flat `Ping` with `{ id: params.id ?? Date.now() }` (`actions.ts:95-97`), documented
as "answered with a matching `Pong`" and echoed "back unchanged" (`types.ts:29-32`). `parseFrame` keeps the
payload (`protocol/codec.ts:79`) and `PongMessage` carries `id?: number` (`protocol/types.ts:190-194`), so the
correlation token is on the wire. `ClientCore` throws it away: `case 'Pong': return;` (`client.ts:535-536`).
Because `Ping` is `form: 'flat'` (`protocol/forms.ts:54-56`) it still gets a pending entry and a 10 s timer
(`client.ts:373-401`, `timeouts.commandAckMs` `transport/types.ts:96-103`), which `expirePending`
(`client.ts:451-462`) settles as a failure that rejects `MgCommandUnconfirmedError` (`client.ts:446`): the ping
succeeds on the wire and the handle still fails. The core's `requestId` UUID (`client.ts:324`) is never put on
the wire by `Ping`, so `id` is the only usable key. `GameActions.ping` has no caller and no test in the repo.

**Why it matters.** Every action returns a thenable `CommandHandle`, so `await client.actions.ping()` is the
natural call, and it always throws after 10 s.

**Fix.** Correlate the reply. In `ClientCore.send(action: string, params = {})`, when `action === 'Ping'` and
`typeof params.id === 'number'`, record `this.pingsByWireId.set(params.id, requestId)`; in `handleRawFrame`'s
`case 'Pong'`, read `message.id` and `settlePending` it as `{ ok: true, confirmed: true, matchMethod:
'requestId', raw: message }`. Alternatively make it honest: `ping(params?: PingParams): void` (breaking).

## F3: A timed-out or abandoned command is never reconciled with the sequencer's ledger

**Severity:** medium · **Category:** correctness · **Breaking:** no

**Evidence.** `expirePending` (`client.ts:451-462`) and `rejectAllPending` (`client.ts:464-486`) only call
`settlePending`; neither calls `sequencer.settle(requestId, ...)`, and neither does `dispose`/the close handler
(`client.ts:194-217`). The ledger entry added by `take` (`protocol/sequencer.ts:315-327`) is therefore still
there, and the documented backstop for this case, `sweepStale` (`protocol/sequencer.ts:404-421`), has no
production caller (only `tests/sequencer.test.ts:220-221`). When the frontier later passes that sequence,
`observeFrontier` (`protocol/sequencer.ts:361-370`) reports it, so `client.ts:576-595` emits a `droppedStale`
event and calls `settlePending` for a requestId whose handle already settled as an unconfirmed timeout.
Meanwhile `stats.pending` (`client.ts:264`) reads 0 while `sequencer.pending` still lists the command, and
`reportedStale` (`protocol/sequencer.ts:282`) is cleared only by `seed`/`reset`/`rollback`.

**Why it matters.** One command is reported twice with contradictory causes (timeout, then dropped-stale), the
two pending counters disagree, and `reportedStale` grows for the life of a long-lived connection.

**Fix.** Settle the ledger when the handle settles: add `this.sequencer.settle(requestId, { ok: false,
code: 'timeout' })` in `expirePending` and `{ code: 'abandoned' }` in `rejectAllPending`, and drive `sweepStale`
from the same timer (or delete `sweepStale`/`reset` and their docs).

## F4: `confirmed`/`matchMethod` mean different things at each synthesized-result site, and strict mode reports `'fifo'`

**Severity:** medium · **Category:** consistency · **Breaking:** yes

**Evidence.** Four sites disagree with the stated contract ("`confirmed` is `true` only when the server
actually echoed our `requestId`", `handle.ts:44-50`): `failureResult` hardcodes
`confirmed: true, matchMethod: 'requestId'` (`handle.ts:144-152`) although nothing was echoed, and it is
public (`actions/index.ts:4`, `ClientCore.rejectionResult` `client.ts:704-711`); the transport-failure path in
`send()` uses `confirmed: true, matchMethod: 'none'` (`client.ts:352-360`); the `dropped_stale` path uses
`confirmed: true, matchMethod: 'frontier'` (`client.ts:586-594`); and `expirePending` labels a timeout
`matchMethod: 'fifo'` even when `ackMode: 'strict'` disabled FIFO matching entirely (`client.ts:454-461`),
while `AckMatchMethod` defines `'none'` as "No correlation attempted" (`handle.ts:29-30`).

**Why it matters.** A consumer that gates on `result.confirmed` treats locally fabricated failures as
server-confirmed facts, and a strict-mode consumer is told a correlation method it opted out of was used.

**Fix.** Add `| 'timeout'` to `AckMatchMethod` (`handle.ts:24-32`) and make confirmation a function of the
method: `failureResult(action: string, requestId: string, sequence: number, rejection: CommandRejection,
matchMethod: AckMatchMethod = 'none', raw?: unknown): CommandResult` setting
`confirmed: matchMethod === 'requestId'`. Use `'timeout'` in `expirePending`, `'frontier'` only where a frontier
advance actually settled it.

## F5: The readiness gate opens while the sequencer is unseeded

**Severity:** medium · **Category:** correctness · **Breaking:** no

**Evidence.** `handleWelcome` seeds only inside `if (typeof message.executedCommandSequence === 'number')`
(`client.ts:546-548`) but sets `this.readyState = true` unconditionally (`client.ts:558`), while `isReady`'s own
doc says "True once `Welcome` has arrived **and the sequencer is seeded**" (`client.ts:223-226`). A
`MonotonicStrategy` does not wait. It starts at `executed + 1` with `executed = 0`
(`protocol/sequencer.ts:89-92`, `:287`), so the first command is stamped `1` no matter what the server has
already executed, and the guard in `send()` (`client.ts:300-310`) is bypassed.

**Why it matters.** A `Welcome` without `executedCommandSequence` (the code anticipates it, hence the `typeof`
check) yields `isReady === true` and a command stream the server rejects as `invalid_sequence` until a state
frame supplies a frontier. That is the documented silent failure mode, reached through the front door.

**Fix.** In `handleWelcome`, derive and enforce readiness from seeding:
`const seeded = typeof message.executedCommandSequence === 'number'; ... this.readyState = seeded || this.getFrontierOption !== undefined;`
and log/emit an explicit `MgProtocolError` warning when not seeded, so `send()` still throws its
`MgNotReadyError` instead of stamping a wrong sequence.

## F6: One failure travels four channels, and a caller's mistake is a bare `Error`

**Severity:** medium · **Category:** consistency · **Breaking:** no

**Evidence.** `send()` reports a transport failure as (a) a synchronous rethrow (`client.ts:361`), (b) an
already-settled failed handle (`client.ts:352-360`), and (c) `lastErrorValue` (`client.ts:350`); the close path
adds (d) an emitted `close` event. The typings advertise only `@throws {MgNotReadyError}` (`client.ts:300`,
`handle.ts:130-133`). An unknown action throws a plain `Error` (`client.ts:315` → `protocol/forms.ts:441`), as
does `buildFrame` (`protocol/envelope.ts:118`), while `index.ts:36-48` exports `MgAuthError`,
`MgCommandDroppedError`, `MgConnectionError`, `MgProtocolError`, `MgSupersededError` and
`MgVersionExpiredError`. Grep shows each of those six has exactly one reference repo-wide (that re-export),
i.e. the taxonomy is never thrown even though two of its members describe these cases exactly.

**Why it matters.** `isMgError` cannot be used to separate "you called it wrong" from "the socket died", and
six exported error types imply handling paths that never occur.

**Fix.** Throw `MgProtocolError` from `getActionSpec`/`buildFrame` for an unknown action or missing sequence,
and wrap the transport throw in `send()` as `throw new MgConnectionError('transport send failed', { action, requestId, cause: error })`.
Either use or unexport the remaining unused error classes.

## F7: `welcome` survives a close while `selfPlayerId` is cleared, so the two accessors disagree

**Severity:** low · **Category:** correctness · **Breaking:** no

**Evidence.** The close handler clears `selfPlayerIdValue` (`client.ts:195-198`) but never `welcomeValue`
(declared `client.ts:149`, read at `client.ts:233-236`); `welcomeValue` is assigned only in `handleWelcome`
(`client.ts:543`) and cleared nowhere, not even by `dispose()` (`client.ts:205-217`).

**Why it matters.** After a connection loss `selfPlayerId` is `null` and `isReady` false, yet `client.welcome`
still hands back the previous session's `Welcome` (including the id inside it) as if it were live.

**Fix.** Reset `this.welcomeValue = null` next to `this.selfPlayerIdValue = null` in the close handler and in
`dispose()`.

## F8: `sendRaw` bypasses both the readiness gate and the error bookkeeping; `actions/index.ts` double-exports two types

**Severity:** low · **Category:** api-design · **Breaking:** no

**Evidence.** `sendRaw(frame)` writes straight to the transport (`client.ts:369-371`): it never checks
`readyState` (contrast `client.ts:305-310`), never validates the frame, never records `lastErrorValue`
(contrast `client.ts:350`), and no in-repo caller uses it (the identically named `sink.sendRaw` in
bootstrapped is a different symbol). Separately, `actions/index.ts:6` re-exports `ShopKey` and `CrystalIntent`
by name and line 7 then `export *`s the same module, so both names leave the same file twice. That is legal,
but it adds noise to the public surface.

**Why it matters.** A public method that can push an unvalidated frame into a not-ready connection is a
footgun sitting next to a `send()` whose design is to refuse that.

**Fix.** Make it symmetric: `sendRaw(frame: Record<string, unknown>): void` should throw `MgNotReadyError` when
`!this.readyState`, set `lastErrorValue` on failure, and be documented as "no sequencing, no correlation".
Delete `actions/index.ts:6` (line 7 already exports both types).

---

## What works well here

- The ack model is unusually honest: `confirmed`/`matchMethod` are a real distinction, `dropped_stale` is
  labelled as synthesized (`handle.ts:8-17`), and the three modes are documented at the class (`client.ts:8-19`).
- The transport seam is minimal and platform-free: six members, strings only, no `node:*`/DOM types,
  and the keepalive-ownership asymmetry is stated where it belongs (`transport/types.ts:43-75`).
- `send()` validates the action and rolls the sequence number back when the frame never reaches the wire
  (`client.ts:312-341`), which closes the gap-poisoning failure mode rather than documenting it away.
- Fire-and-forget handles cannot produce `unhandledRejection` while `await`, `.catch()` and `.settled` still
  observe the true outcome (`handle.ts:62-106`).
- The action layer is verified coherent at scale: 72 methods, 71 wire strings, forms and param forwarding all
  agree with `ACTION_SPECS`, and no method lies about what the server receives.
