18 subsystem and cross-cutting agents audited `mg.js`; 89 findings were reported.
29 of them were adversarially verified: 23 confirmed, 5 partial, 1 refuted.
The remaining 60 findings were reported but never independently verified, so they may be wrong.
Confirmed and partial findings are listed below by severity; the refuted finding appears in its own section.

## Verified findings

### Critical

- **[critical] Prototype pollution through the create-missing container walk** - common/state+log+emitter - security - breaking: no
  evidence: patch.ts:175-183 unguarded record[token] read/write; measured add /__proto__/pwned/inner -> applied 0, failed 1, yet Object.prototype.pwned={}; pointer.ts:85 guards.
  fix: In ensureContainer skip __proto__/constructor/prototype tokens (or use hasOwnProperty + Object.defineProperty for the write at line 180) and fail with a recorded outcome. deepClone at 366 is a lost-key bug, not pollution; fix separately.
- **[critical] Every WorldScene layer container is created permanently invisible, so no scene can ever display a sprite** - bootstrapped/render-core - correctness - breaking: no
  evidence: world.ts:480 sets container.visible=false with no restore record; world.ts:399 adds every sprite into that container; grep over src, tests and dist finds no visible=true and no setLayerVisible.
  fix: world.ts:480 -> container.visible = true (the container is scene-owned and destroyed on exit). Optionally add setLayerVisible(name, visible) using recordAndSet(this.restores, ...) and a unit test that enter() leaves the layer visible.
- **[critical] installRenumberHook hands back a detached Renumberer when the slot is already ours** - bootstrapped/jotai+coexistence - correctness - breaking: yes
  evidence: renumber.ts:502 builds the machine before installHook; brand.ts:231-233 returns 'reused' without calling wrap; renumber.ts:532-534 reports active=true for both handles; reproduced a detached handle while active=true.
  fix: Make installHook return the live wrapper's machine (e.g. expose it on the brand) and return it from installRenumberHook, plus a readonly outcome: InstallOutcome on RenumberHookHandle.
- **[critical] npm run verify tests before building, so all 16 standalone-userscript assertions silently skip** - scripts+configs+readme - tests - breaking: no
  evidence: package.json:17 'verify': typecheck && npm test && npm run build; build-output.test.ts:51 computes built=existsSync and all 16 tests carry skip:!built, including the banner-at-byte-0 and 0-import assertions.
  fix: package.json:17 -> typecheck && build && test. In build-output.test.ts:51 gate the skip on process.env.MG_ALLOW_UNBUILT_TESTS so a missing artifact is a failure by default.
- **[critical] `|| true` makes RoomSocket's send() pass-through test unable to fail** - xcut/tests+verification - tests - breaking: no
  evidence: room-socket.test.ts:214-217 asserts server.commands.length > 0 || true, i.e. assert.ok(true) always; the only '|| true' in packages (grep); the test sends UsurpHost (210) and 'pong' (212) and asserts nothing about either.
  fix: Add a raw sent-frames helper to packages/headless/tests/mock-server/server.ts, then assert deepEqual(sentRoomFrames(server), ['UsurpHost','pong']) and server.commands.length === 0 in the test at line 204.
- **[critical] No hostile-input test; `/__proto__` patch paths pollute Object.prototype** - xcut/tests+verification - security - breaking: no
  evidence: packages/common/src/state/patch.ts:177-180 (`record[token] = slot` unguarded); repro applyPatch({},[{op:'add',path:'/__proto__/pwned/inner',value:1}]) -> applied 0 but Object.prototype.pwned own+enumerable.
  fix: Reject `__proto__`/`constructor`/`prototype` tokens in parsePointer (pointer.ts:24-27) so resolvePointer and applyOperation are both covered; add the hostile-input test to packages/common/tests/patch.test.ts.
- **[critical] WorldScene.enter() hides the host world while its own layers are created permanently invisible** - xcut/architecture - correctness - breaking: no
  evidence: packages/bootstrapped/src/render/world.ts:480 (visible=false; grep finds no `visible = true` in the package) and :527-535 hides every non-own child though :528-529 claims a tile-only filter.
  fix: Set container.visible = true at :480; in hideUnderlying skip children with no tile views (`collectTileViews(child,32).length === 0`) before the recorded hide at :535; add tests/world.test.ts.

### High

- **[high] WorldScene tile suppression is neither identity-guarded nor multi-scene safe: it permanently shadows the game's prototype draw** - xcut/security - correctness - breaking: no
  evidence: world.ts:840-853 records a second scene's captured value as our own no-op (own property, wasAbsent false); world.ts:289-300 restores unconditionally (293-295) with no identity check; client.ts:858-864 mints a fresh scene per call.
  fix: Brand the no-op and have recordAndWrapNoop return false when the slot already holds it; refcount (target,key) suppressions in a module Map and make exit() skip or identity-check any restore whose slot changed since capture.
  note: Same-tile shadowing is real but needs no exploit and is bounded to tiles two scenes entered, so high not critical; restore loop is 290-299.
- **[high] applyPatch throws on a malformed patch path instead of reporting a failed op** - common/state+log+emitter - correctness - breaking: no
  evidence: packages/common/src/state/patch.ts:219 parsePointer unguarded; applyPatch({data:{}},[{op:'add',path:'data/x',value:1}]) throws, while client.ts:495 promises the frame handler never throws; codec.ts:104-118 casts wire patches with no path validation.
  fix: Catch in applyOperation (or applyOne's attempt) and return the message as a failed PatchOutcome with resolution 'failed'; make parsePointer throw MgProtocolError; assert ok:false in patch.test.ts.
- **[high] dispose() clears the subscribers of a caller-supplied store, defeating ClientCoreOptions.store** - common/client+actions - correctness - breaking: no
  evidence: packages/common/src/client.ts:214 (inside dispose at :205-217) clears state/store.ts:272-273 unconditionally, contradicting the option doc at client.ts:86-101.
  fix: Record `private readonly ownsStore = options.store === undefined` and clear subscribers only when true; then pass the previous store at headless/src/client.ts:698 and fix the stale getter comment at :352-353.
- **[high] ping() can never succeed: the Pong reply that carries its id is discarded** - common/client+actions - correctness - breaking: no
  evidence: client.ts:535-536 `case 'Pong': return;`; probe fed `{"type":"Pong","id":12345}` after Welcome and the handle rejected MgCommandUnconfirmedError (sequence -1).
  fix: Map Ping's numeric params.id to its requestId and settle it in `case 'Pong'` with matchMethod:'requestId'; or make ping() fire-and-forget so it stops handing back a handle that always rejects.
- **[high] Unvalidated entity payloads become fake entities and hide `missing`** - common/catalog - correctness - breaking: no
  evidence: source.ts:250-252,264-273 plus 172; probe with a source returning {error:'rate limited'} gave plants=[{"id":"error","value":"rate limited"}] and no 'plants' in missing; PlatformApiSource validates, RemoteJsonSource does not.
  fix: Validate the input shape in assignKind: an array of objects with string ids, or a record whose every value is a non-null object; throw otherwise. Validating after normalizeEntityMap still accepts an error-valued entry.
- **[high] mc_jwt token emitted verbatim in the headersUnsupported event payload** - headless/auth+session - security - breaking: yes
  evidence: client.ts:158 and 692-694 re-emit the raw ConnectHeaders bag; probe with a header-less runtime logged Cookie: mc_jwt=SECRET.JWT.VALUE; cookie.ts:88-94 redacts the same value.
  fix: Emit dropped header names (or redacted values) instead of the raw bag: headersUnsupported: [{ headerNames: string[]; redacted: string[]; runtime: string }]. This changes an exported event type.
- **[high] StandaloneTransport.dispose() orphans a live socket; a second connect() leaks it** - headless/auth+session - correctness - breaking: no
  evidence: transport/client.ts:387-394 never calls socket.close(), and client.ts:606 disposes first; probe: 2nd connect() -> server openSockets 1->2, same clientDocumentId, 1 socket still open after destroy().
  fix: In dispose(), set manualClose and call this.close(1000,'transport disposed') before detachSocket(); the queued close event stays suppressed because the listeners are removed synchronously.
- **[high] A reconnect that fails before the socket opens kills the chain forever, while `close` reported willReconnect:true** - headless/client+transport - correctness - breaking: no
  evidence: client.ts:915 guard and client.ts:805 emit; probe after a 4400 close with the server stopped: close:willReconnect=true twice, accepted=1, connectionAttempt=2, stopped=null at t+45s.
  fix: Return BackoffPlan|null from afterClose and run retries in an owned runRetryLoop, or minimally re-plan inside the retry task's catch instead of relying on re-entry through scheduleReconnect.
- **[high] An injected webSocketFactory is assumed header-capable, so the auth cookie is silently dropped** - headless/client+transport - security - breaking: no
  evidence: runtime.ts:172 hard-codes supportsHeaders:true so client.ts:669-676 never throws; probe with webSocketFactory:globalThis.WebSocket + cookie auth: isReady=true, cookie=null, no event.
  fix: Add supportsHeaders? to AcquireWebSocketOptions and webSocketSupportsHeaders? to HeadlessClientOptions, and treat factory === globalThis.WebSocket as header-less by default.
- **[high] `current` is assigned for every socket before the room-URL filter, so an unrelated socket becomes the send target** - bootstrapped/attach - correctness - breaking: no
  evidence: raw-socket.ts:228 `current = socket` precedes the filter at :232; the clear-on-close listener :269-270 sits inside the filtered branch, while canSend :384 / sendRaw :397 read `current` unfiltered.
  fix: Move `current = socket` below the URL filter in `attach` (raw-socket.ts:221) so only the adopted room socket is recorded, leaving the existing close listener to clear it.
- **[high] The stand-in Welcome is not latched, so it re-fires on every patch frame** - bootstrapped/attach - correctness - breaking: no
  evidence: room-connection.ts:479 gates on `sawWelcome`, set only at :513; transport.ts:152-168 re-frames every stand-in; client.ts:547 -> sequencer.ts:302-305 re-seeds the counter and clears the outstanding ledger.
  fix: Add `standInDelivered` beside `sawWelcome` and set it when a stand-in is dispatched (room-connection.ts:479) so at most one Welcome reaches the core; keep recording `lastFullState` for later rebasing.
- **[high] `release()` never removes the socket listeners it installed** - bootstrapped/attach - correctness - breaking: no
  evidence: raw-socket.ts:235 and :269 add message/close listeners; `release()` :443-464 removes neither, and `removeEventListener` appears only as a type declaration :75, never called.
  fix: Collect `() => socket.removeEventListener?.('message', handler)` (and the `close` one) in `bindRawSocket` and run them, reversed, in `release(): void` (raw-socket.ts:443).
- **[high] penPets hides exactly one pet because findNode returns the first match only** - bootstrapped/render-core - correctness - breaking: no
  evidence: world.ts:605 records a single `findNode` match for pets (:607); ctors.ts:467-468 and :497 show findNode returns the first accepted node and returns early.
  fix: Implement `penPets` over `findAllNodes(world, isRiveHostLike, 64)` (ctors.ts:532), skipping matches that are ancestors of another match, and `recordAndSet` per pet so `exit()`'s unwind restores each.
- **[high] release() deletes the page's live jotaiAtomCache and never unwraps the synthetic get** - bootstrapped/jotai+coexistence - correctness - breaking: no
  evidence: bridge.ts:500-502 deletes page[ATOM_CACHE_KEY] on identity alone; the comment at :498-499 claims an emptiness test; probe: game-populated holder (cache.size=1) -> release() printed DELETED, holder.get stayed callable.
  fix: Gate the delete on the condition the comment states (synthetic.cache.size === 0) or keep a populated holder and neutralise it; brand the holder; add `if (!active) return atom;` first in inspectAtom (bridge.ts:327).
- **[high] atomLabel prefers a jotai config key over debugLabel; 'atomN' passes the [object Object] sentinel** - bootstrapped/jotai+coexistence - correctness - breaking: no
  evidence: bridge.ts:271-278 returns the key unless '[object Object]'; jotai 2.6.0 vanilla.mjs:1-6 gives every config toString()='atom'+n; probe with a Map keyed by a config carrying debugLabel: labels() ['atom7'], find() MISS.
  fix: In atomLabel (bridge.ts:271) prefer debugLabel, then label, then the key; treat '', '[object Object]' and /^atom\d+$/ as non-informative so they fall through. The key stays a fallback for string-keyed caches.
- **[high] install() after uninstall() leaks a permanent page hook** - bootstrapped/client+userscript - correctness - breaking: no
  evidence: client.ts:362 guards only `installed`; :636-638 makes uninstall terminal; probe: 2 install -> isInstalled=false refCount=1 keysBranded=true keysReplaced=true; 2 uninst -> ns=present refCount=1 keysBranded=true.
  fix: Make install() refuse a terminal client (`if (this.uninstalled) throw`, client.ts:361) or re-arm the lifecycle there, and set installed=true only after every fallible step has succeeded.
- **[high] verify-live-socket.ts reports PASS and exit 0 for any connection failure, not just the documented 4840** - scripts+configs+readme - correctness - breaking: no
  evidence: the guard is at verify-live-socket.ts:158 (`sawSessionExpired || !client.isReady`), not :126; :161/:164/:169 pass literal true to report, :178 zeroes failures, :195 exits 0.
  fix: Change :158 to `if (sawSessionExpired)`; gate :161's transport report on evidence (client.stats.stopped !== undefined); keep the hard-coded trues only inside the verified-4840 case and let other failures reach :180.

### Medium

- **[medium] room/version unencoded in the connect-URL path** - common/protocol - security - breaking: no
  evidence: packages/common/src/protocol/connect-url.ts:57 interpolates version/room unencoded; repro room 'abc&x=1#frag' yields pathname /version/1157/api/rooms/abc&x=1 with hash #frag/connect (/connect swallowed).
  fix: Add safePathSegment(name, value) to connect-url.ts rejecting / ? # % and whitespace (else encodeURIComponent) and use it for version and room at :57, with tests; keep the returned room value in sync.
  note: Both values sit after the authority, so host/scheme cannot change and no credential leaks; corruption needs a non-slug room or odd version, so this stays medium rather than high.
- **[medium] TypedStorage.clear() is a silent no-op on the gm backend** - bootstrapped/render-assets+storage - correctness - breaking: no
  evidence: storage.ts:392-396 `clear()` removes `backend.keys()` and returns 0; `createGmBackend`'s `keys()` returns [] (:193-198); build.ts:85-87 grants only GM_getValue/GM_setValue.
  fix: Back the gm backend with a prefix+'__index__' key maintained by setRaw/removeRaw so keys()/clear() are honest, grant GM_deleteValue at build.ts:85-87, and delete the false claim at storage.ts:182-184.
  note: The gm limitation of keys() is documented (storage.ts:311) and clear() has no caller under packages/*/src, so the harm is a latent public-API defect.
- **[medium] Failed install() leaves isInstalled true and uninstall() throwing** - bootstrapped/client+userscript - correctness - breaking: no
  evidence: client.ts:363-366 set flags before claimInstall(requirePage()); :681 repeats requirePage; probe (Node, no page): install threw, isInstalled=true, uninstall threw. But that happened at the :366 argument, so no claim or hook was taken.
  fix: Resolve the page once in install() and reuse it in uninstall(); wrap the post-claim body in try/catch, and on throw release catalog/capture handles, call releaseInstall, reset installed/ownsClaim, then rethrow.
  note: The reproduced path installs nothing; the claim/hook leak needs a throw after claimInstall, so high overstates.
- **[medium] packages/headless/tsconfig.test.json is referenced by nothing; no test file in any package is type-checked** - scripts+configs+readme - correctness - breaking: no
  evidence: three package tsconfigs include only src/**/*.ts (headless/tsconfig.json:8) and root tsconfig.json:3-5 references just them; running the orphan config exits 2 with two TS2339 at headless/tests/integration.test.ts:502-503.
  fix: Add common/bootstrapped tsconfig.test.json mirroring the headless one and reference all three from root tsconfig.json so `tsc -b --force` covers tests (plus a scripts project), then fix the errors it surfaces.
  note: Facts hold and the orphan config surfaces real errors, but the harm is an unchecked net, not shipped code: medium.

### Low

Nothing verified at this severity.

## Reported, not independently verified

### correctness

- **Sequence-number validator written 5x and two copies disagree** (high, xcut/duplication) - codec.ts:130 Number.isFinite vs room-connection.ts:247 Number.isInteger && >=0; client.ts:546 seeds on any number while readWelcomeFrontier (client.ts:927) returns null for 2.5 - fix: export asSequence (Number.isInteger && >=0) in codec.ts and use it in extractFrontier and the four bootstrapped copies.
- **userscript.ts overwrites window.__mgjs (the realm namespace) with the client** (high, xcut/security) - userscript.ts:205-210 sets page['__mgjs']=client after realm.ts:239 created the namespace; next getNamespace throws 'already exists and was not created by mg.js' - fix: publish defineGlobal('client', client) inside the namespace and wrap client.ts:681 in attemptTeardown.
- **BuildFrameOptions.form bypasses the form registry and emits the wrong scope** (medium, common/protocol) - envelope.ts:109 accepts any form while :56-97 hard-code scope; buildFrame({action:'Chat',form:'flat'}) yields scopePath ["Room","Quinoa"] - fix: throw MgProtocolError in buildFrame when options.form !== getActionSpec(action).form, or delete the option.
- **CommandSequencer discards a caller-supplied MonotonicStrategy** (medium, common/protocol) - sequencer.ts:288 replaces any strategy when getFrontier is set; MonotonicStrategy(41) + getFrontier:()=>null takes 1, +()=>5 takes 6 - fix: guard on options.strategy === undefined && options.getFrontier !== undefined in the constructor.
- **waitFor swallows predicate errors: silent hang plus leaked subscription** (medium, common/state+log+emitter) - store.ts:254-256 runs the predicate inside the handler, deliver catches throws (store.ts:308-314), only finish() unsubscribes (store.ts:245-250); a throwing predicate settled only via timeoutMs - fix: evaluate the predicate in try/catch and finish(() => reject(error)) in ObservableStore.waitFor.
- **A timed-out or abandoned command is never reconciled with the sequencer ledger** (medium, common/client+actions) - client.ts:451-462 and :464-486 never call sequencer.settle; sweepStale (sequencer.ts:410) has no caller, so observeFrontier (sequencer.ts:361-370) re-reports the entry - fix: call sequencer.settle(requestId,{ok:false,code:'timeout'}) in expirePending and 'abandoned' in rejectAllPending.
- **The readiness gate opens while the sequencer is unseeded** (medium, common/client+actions) - client.ts:546-548 seeds only when executedCommandSequence is a number, yet :558 sets readyState=true unconditionally while isReady promises a seeded sequencer (client.ts:223) - fix: set readyState = typeof message.executedCommandSequence === 'number' || this.getFrontierOption !== undefined in handleWelcome.
- **RoomSocket is permanently poisoned by a failed first connect** (medium, headless/auth+session) - room-socket.ts:126-129 sets this.client before await client.connect(); :113-118 then rejects every later connect() as 'already been called' - fix: assign this.client only after await client.connect() resolves in RoomSocket.connect().
- **disconnect() blocks for the entire pending backoff** (medium, headless/client+transport) - client.ts:562 awaits reconnectTask, whose first step is the uncancellable ReconnectPolicy.sleep (reconnect.ts:344); probe with baseDelayMs=5000: disconnect() took 5256ms - fix: make sleep(plan, signal?) interruptible and abort a retryAbort controller at the top of disconnect().
- **WorldScene never reacts to renderer recreation** (medium, bootstrapped/render-core) - client.ts:407-414 only logs; world.ts:331-336 re-resolves only when !entered && worldContainer===null, and :262 keeps entered=true - fix: add WorldScene.rebuild(stage?) calling exit() then re-resolving; call resetCtorCache() in client.ts:407.
- **RiveRegistry.clear() forgets tags but leaves the host map populated** (medium, bootstrapped/render-assets+storage) - rive.ts:509-511 clears only byTag; unregister (rive.ts:494-506) deletes byHost too, so findByHost returns wrappers after a clear - fix: in rive.ts make clear() run byTag.clear() and byHost = new WeakMap&lt;object, RiveArtboard&gt;().
- **Overlay/label Text nodes leak when addChild throws** (medium, bootstrapped/render-assets+storage) - rive.ts:277-282 and text.ts:241-245 create a Text then return null without destroyText(node) when addChild throws - fix: call destroyText(node) inside the addChild catch before returning null.
- **Texture cache is unbounded and a re-decode orphans the replaced texture** (medium, bootstrapped/render-assets+storage) - sprite.ts:75-97 is a Map with no max; sprite.ts:170 a refresh overwrites the entry, orphaning the previous PixiTexture with no handle left - fix: add maxEntries eviction that destroys victims, destroy replaced textures on overwrite, default release(key, destroy = true).
- **Captured store set/get survive uninstall; a later bridge writes into the dead store** (medium, bootstrapped/jotai+coexistence) - bridge.ts:139-145 globals are cleared only by resetJotaiCapture (bridge.ts:189-194), which no src code calls; client.ts:659-660 calls release() only - fix: call resetJotaiCapture() from BootstrappedClient.uninstall() and test liveness instead of capturedSet === null.
- **userscript never tears down its badge or two 500 ms pollers** (medium, bootstrapped/client+userscript) - userscript.ts:232,:268 create two setInterval pollers; :288 returns only the client, so destroy() (:134-137) is unreachable - fix: keep the timer ids and register onTeardown(() => { clearInterval(timer); clearInterval(reportTimer); badge?.destroy(); }, page).
- **probe-guest-encoding.ts always exits 0, so a failed probe looks successful** (medium, scripts+configs+readme) - probe-guest-encoding.ts:147-155 computes anyWelcome only to pick a printed string, then process.exit(0) unconditionally; the only scripts/*.ts that never sets process.exitCode - fix: set process.exitCode = results.some(r => r.opened) ? 0 : 1.
- **FormFallback option and setFormFallback are inert** (medium, xcut/unused+api-surface) - forms.ts:528-530 isFallbackEnabled returns false; its only caller forms.ts:496 gates the only read of this.fallback, so setFormFallback (forms.ts:515) changes nothing - fix: add private fallbackEnabled set by setFormFallback and return it from isFallbackEnabled.

### duplication

- **Emitter reimplemented 3x; copies disagree on listener isolation** (high, xcut/duplication) - common/src/emitter.ts:14-79 vs headless/src/client.ts:472-498,982-995 vs headless/src/transport/client.ts:481-509 vs bootstrapped/src/attach/transport.ts:142-148,452-474 - fix: declare HeadlessClient extends Emitter&lt;HeadlessClientEvents&gt; and give each transport a private Emitter.
- **Deadline-poll written 5x with three different timeout outcomes** (high, xcut/duplication) - detect.ts:286-303, detect.ts:384-412, ctors.ts:833-865, bridge.ts:452-476 and attach/transport.ts:173-183 disagree, and the transport copy never times out - fix: add pollUntil&lt;T&gt;(options) and unrefTimer(timer) in packages/bootstrapped/src/util/poll.ts.
- **asEnvelope implemented twice with identical logic, both published** (medium, xcut/unused+api-surface) - client.ts:942-946 and coexistence/renumber.ts:437-442 are the same predicate; index.ts:48 exports the first as asEnvelope, index.ts:162 the second as asCommandEnvelope - fix: keep asEnvelope in coexistence/renumber.ts:437, delete client.ts:942, drop the asCommandEnvelope alias.
- **Barrel strategy is export * in common and hand-enumerated elsewhere** (medium, xcut/conventions) - common/src/index.ts:15-19 export *; state/index.ts:19-21 must exclude Unsubscribe, also declared at transport/types.ts:15 and headless/src/room-socket.ts:54 - fix: hand-enumerate common/src/index.ts, delete actions/index.ts:6, keep one Unsubscribe in transport/types.ts.

### tests

- **No test file or script is in any TypeScript project, so tsc -b --force exits 0 while test code has type errors** (high, xcut/conventions) - packages/common/tsconfig.json:8 includes only src; headless/tsconfig.test.json is referenced nowhere; npx tsc -p it gives TS2339 at integration.test.ts(502,28) and TS2783 at attach.test.ts(267,34) - fix: add tsconfig.test.json for common and bootstrapped and reference all from root tsconfig.json.
- **Neither release gate can fail: 16 artifact tests skip unbuilt, and the live check hardcodes PASS** (high, xcut/tests+verification) - build-output.test.ts:63 skips all 16 tests on !existsSync; verify-live-socket.ts:161-171 reports true and :178 resets failures=0 - fix: build in before() from build-output.test.ts and report the measured sawSessionExpired in verify-live-socket.ts.
- **tsc -b typechecks no test file; packages/headless/tsconfig.test.json is orphaned and fails when run** (high, xcut/architecture) - `tsc -b --force --listFilesOnly | grep -c tests/` returns 0; npx tsc -p packages/headless/tsconfig.test.json fails TS2339 x2 at integration.test.ts:502-503 - fix: add packages/*/tsconfig.test.json (src+tests, noEmit), reference them from tsconfig.json, point typecheck at them.

### missing-capability

- **The userscript entry point has no uninstall and no test** (high, xcut/tests+verification) - userscript.ts:168 returns only the client; the setInterval at :232 is never cleared, destroy() (:134) has no caller, globalThis.__mgjs (:210) is never deleted; no test imports userscript.ts - fix: export startUserscript(): UserscriptHandle | null and add packages/bootstrapped/tests/userscript.test.ts.
- **FormFallback and setFormFallback can never take effect** (medium, common/protocol) - forms.ts:496 requires isFallbackEnabled, but forms.ts:528-530 returns false unconditionally; new FormRegistry({formFallback:'wrap'}).formOf('Ping') === 'flat' - fix: implement isFallbackEnabled behind an opt-in set by setFormFallback, or delete FormFallback entirely.
- **ETag / If-None-Match support is unreachable: nothing can supply an ETag** (medium, common/catalog) - remote-json-source.ts:81-83 reads this.etags, written only by setETag (line 104), which has no callers; http.ts:90 discards response headers - fix: add fetchJsonWithMeta&lt;T&gt; in http.ts and call setETag from it, or delete setETag.
- **The raw-socket sink has no welcome replay, unlike the room path** (medium, bootstrapped/attach) - raw-socket.ts:408-420 onWelcome only registers a handler; the scraped welcome is delivered once at :239-254, unlike room-connection.ts:642-649 - fix: replay in onWelcome (raw-socket.ts:415) when selfPlayerId !== null.

### security

- **A non-canonical array index in a patch parent segment bypasses isArrayIndex and pads the array without bound** (high, xcut/security) - patch.ts:163-165 uses bare Number(token) then pads with current.push(null), while the leaf gate isArrayIndex (patch.ts:109-111, :243) rejects them; add /data/arr/20000000/x -> arr.length 20000001, 238 ms - fix: export isArrayIndex(token) from pointer.ts, use it in ensureContainer, and add ApplyPatchOptions.maxPad.
- **probeSession interpolates the token into a header, then copies the runtime error into reason, a field documented 'safe to log'** (high, xcut/security) - session.ts:173-175 builds Cookie from an unvalidated token; session.ts:224 returns error.message; session.ts:150-151 declares reason 'safe to log'; token 'abc\r\nX-Injected: 1' echoed verbatim - fix: add assertCookieHeaderSafe in auth/cookie.ts, call it at session.ts:174, and report only error.name.
- **Credential policy untested; the JWT-bearing Cookie header is emitted and logged** (high, xcut/tests+verification) - transport/client.ts:215 passes full headers to client.ts:692 emit('headersUnsupported',{headers}); mock-server/server.ts:295 records {...req.headers}, printed at integration.test.ts:299 - fix: add an mc_jwt log test using MemoryLogSink and redact the value in the headersUnsupported emit.
- **No size bound on inbound WebSocket frames** (medium, common/protocol) - codec.ts:63 JSON.parses with no cap and no transport sets maxPayload, while catalog/http.ts:81-88 rejects responses over options.maxBytes ?? 8*1024*1024 - fix: add options.maxBytes to parseFrame in codec.ts and thread it through ClientCore.handleFrame.
- **maxBytes does not bound memory, and is not bytes** (medium, common/catalog) - http.ts:80 awaits response.text() before http.ts:82 compares text.length > maxBytes; http.ts:71-72 buffers non-2xx bodies with no cap at all - fix: add readCapped(response, maxBytes) in http.ts checking content-length and streaming response.body through a byte counter.
- **Brand marker is a bare true: unversioned, forgeable, and reused as an enumerable cache-holder flag** (medium, bootstrapped/jotai+coexistence) - brand.ts:126-129 accepts any function whose MARKER_KEY === true; classifySlot (brand.ts:154-160) and installHook (brand.ts:231-233) treat it as 'mine'; bridge.ts:430 sets that key enumerably - fix: make MARKER_KEY a token {owner, version}, widen classifySlot, and define the holder flag non-enumerably.
- **Catalogue fetches follow redirects with no policy, from a URL the caller's baseUrl/paths can reshape freely** (medium, xcut/security) - catalog/http.ts:66-69 passes no redirect option; remote-json-source.ts:69-70 and :86 concatenate unvalidated baseUrl + paths; baseUrl '' + link-local paths fetches metadata - fix: require an https baseUrl, reject absolute paths, add redirectPolicy to FetchJsonOptions defaulting to 'manual'.

### architecture

- **common's platform-free HARD RULE is unenforced by tsconfig and already violated by fetch/AbortController** (high, xcut/architecture) - tsconfig.base.json:5 lib ["ES2022","DOM","DOM.Iterable"] applies to common; common/src/catalog/http.ts:66 calls the global fetch and :55 new AbortController() - fix: set lib ["ES2022"], types [] in packages/common/tsconfig.json and inject FetchJson into CatalogSource.
- **package-lock.json links only 1 of 3 workspaces; root scripts bypass the exports map into packages/*/src** (high, xcut/architecture) - package-lock.json lists only packages/common; scripts/verify-live-socket.ts:47-49 imports '../packages/headless/src/client.js' and '../packages/common/src/log.js' - fix: regenerate package-lock.json and import @mg.js/headless and @mg.js/common via the exports map.
- **Source failures are invisible in the only production wiring** (medium, common/catalog) - source.ts:173-175 swallows errors into the optional onSourceError and load() always resolves (source.ts:95-115); bootstrapped/src/client.ts:400 passes no callback - fix: default onSourceError to a console.warn logger and expose readonly errors in CatalogClient.

### api-design

- **Four client classes share no interface: divergent start/ready/stop, events, identity and diagnostics** (high, xcut/architecture) - common/src/client.ts:133 ClientCore extends Emitter&lt;ClientEvents&gt;; bootstrapped/src/client.ts:361 install(): this, :440 ready(): Promise&lt;Attachment&gt;; room-socket.ts:198 playerId: string - fix: export MgClient&lt;TEvents&gt; from common/src/client.ts and implement it in all four clients.
- **hasWeather collapses the two states it exists to separate** (medium, common/catalog) - weather.ts:143-145 returns false for both forecast === null and {current:null,upcoming:[]}; tests/weather.test.ts:141-143 asserts the two identical falses - fix: export weatherKnown(forecast) in weather.ts so missing data and inactive weather are separately expressible.
- **Default GuestAuthProvider is a documented dead end with a generic failure** (medium, headless/auth+session) - client.ts:307 defaults to new GuestAuthProvider(); guest.ts:41-45 records every guest connect closes 4840; close-codes.ts:390-402 makes it isBounded with no re-auth signal - fix: warn once when authProvider.authenticated === false and name the mc_jwt remedy in disposition 'renew-session'.
- **GetCtorsOptions.page is declared and documented but never read, and the polling chain cannot be cancelled** (medium, bootstrapped/render-core) - ctors.ts:238-239 declares page?; the only page read is ambient getPage() at ctors.ts:797 in defaultSchedule (:792-804); ctors.ts:861 reschedules with no retainable handle - fix: return a canceller from defaultSchedule(callback, page?) and thread options.page through or delete it.
- **TypedStorage.set() cannot report a swallowed write failure** (medium, bootstrapped/render-assets+storage) - storage.ts:372-385 set() returns the value after setRaw swallows refusal/quota (storage.ts:171-179, 215-221); probeStorage (storage.ts:443-453) runs once at install - fix: change set&lt;T&gt;(key, value): boolean by writing, reading back and comparing JSON.stringify; add setOrThrow&lt;T&gt;.
- **Barrel exports two asEnvelope functions under inverted names** (medium, bootstrapped/client+userscript) - index.ts:48 exports client.ts's helper as asEnvelope; index.ts:162 aliases renumber.ts to asCommandEnvelope, while client.ts:937-940 calls renumber.ts's asEnvelope 'the authority' - fix: export asEnvelope from coexistence/renumber.js in index.ts and drop it from the ./client.js re-export.
- **Options polarity is inconsistent: disableX: true, enabled: true and autoReconnect: false all mean 'off'** (medium, xcut/conventions) - bootstrapped/src/client.ts:119-132 five disableX flags vs its report type's enabled at :168-171; headless/src/client.ts:202-204 ships reconnect.enabled and autoReconnect, resolved at :308 - fix: replace the five flags with features?: {renumbering?, jotai?, catalog?, platformCatalog?, render?} and delete autoReconnect.

### consistency

- **Logger.child().setLevel() reports one level and filters by another** (medium, common/state+log+emitter) - log.ts:151-157 the child's emit closure keeps its own level (log.ts:132-133) while Object.assign points level()/setLevel at the parent; child.setLevel('debug') then child.debug() writes nothing - fix: add levelRef to LoggerOptions, read levelRef.level in emit, and build child() with the same levelRef.
- **confirmed/matchMethod are inconsistent for synthesized results; strict mode reports 'fifo'** (medium, common/client+actions) - handle.ts:144-152 hardcodes confirmed:true/matchMethod:'requestId'; client.ts:352-360 uses 'none', :586-594 'frontier', :454-461 labels a strict-mode timeout 'fifo' - fix: add 'timeout' to AckMatchMethod and set confirmed: matchMethod === 'requestId' in failureResult.
- **probeSession() double-prefixes a full Cookie header, mis-diagnosing a valid token** (medium, headless/auth+session) - session.ts:174 sets headers.Cookie = `${SESSION_COOKIE_NAME}=${options.token}` raw, while auth/cookie.ts:81-86 normalises the identical input through toCookieHeader() - fix: add buildProbeCookie(token) in session.ts returning toCookieHeader(token) and assign it at session.ts:174.
- **The superseded backoff branch omits the post-jitter maxDelayMs clamp** (medium, headless/client+transport) - reconnect.ts:138 jitters without a post-clamp while reconnect.ts:174-177 clamps; measured with random=1: superseded delay 75000ms against maxDelayMs 60000 - fix: wrap reconnect.ts:138 in Math.min(config.maxDelayMs, Math.max(0, Math.round(bounded * jitterFactor(config.jitter, random)))).
- **ReconnectPolicy counts retries; computeBackoff expects 1-based connection numbers** (medium, headless/client+transport) - nextAttempt runs only from planRetry (reconnect.ts:267,330), so the counter holds retries; measured attempts 1,2,3 -> 1500,1500,3000 - fix: pass connectionAttempt into planRetry and nextAttempt, called as policy.planRetry(analysis, this.connectionAttemptValue) at client.ts:803.
- **`release()` clears `lastFrontier` but retains the whole state tree** (medium, bootstrapped/attach) - room-connection.ts:749 nulls lastFrontier, but release() (:742-750) leaves lastFullState (:341, set at :478/:514), lastSelfPlayerId and sawWelcome intact - fix: null lastFullState, lastSelfPlayerId and sawWelcome in RoomConnectionBinding.release() (room-connection.ts:723).
- **report() returns the stale renumberingInstalled the getter exists to correct** (medium, bootstrapped/client+userscript) - client.ts:828 reads this.attachment?.report.renumberingInstalled, while :332-343 attachmentReport re-resolves it against sendSeam; :799 uses the raw snapshot too - fix: derive report() from this.attachmentReport, using a?.renumberingInstalled ?? false.
- **ws is declared three ways at two version ranges, contradicting the package's zero-runtime-dependency comment** (medium, scripts+configs+readme) - packages/headless/package.json:31-41 has ws in both optionalDependencies and peerDependencies (^8.19.0); root package.json:25 pins ^8.18.0; runtime.ts:9-11 claims zero runtime dependencies - fix: drop optionalDependencies, keep the optional peer ws ^8.19.0, add devDependencies ws and @types/ws.
- **Renumbering gate 3x; only the raw-socket path is unguarded** (medium, xcut/duplication) - renumber.ts:546-573 vs client.ts:730-735 vs client.ts:973-984; raw-socket.ts:304 calls the rewriter unguarded and client.ts:978 leaves rewrite() unguarded - fix: add asEnvelope and parseQuinoaEnvelope in coexistence/envelope.ts and wrap the raw-socket rewriter like room-connection.ts:389.
- **CLOSE_CODE_LABELS hand-copied from the enum under a no-drift claim** (medium, xcut/duplication) - close-codes.ts:176 claims the table is 'Built from the enum'; close-codes.ts:178-197 is literal and omits Normal=1000/GoingAway=1001 (close-codes.ts:47-52), so analyzeClose(1000) reports known:null - fix: derive closeCodeLabel(code) from the CloseCode enum and add a parity test over its keys.
- **21 test imports use a .ts extension, violating the standing NodeNext .js rule, and fail tsc with TS5097** (medium, xcut/conventions) - packages/bootstrapped/tests/coexistence.test.ts:27 imports '../src/coexistence/brand.ts'; 21 .ts imports (19 bootstrapped/tests, 2 common/tests/weather.test.ts) vs 46 .js, and 19 raise TS5097 - fix: rewrite all 21 to .js (e.g. from '../src/realm.js').
- **Unsubscribe declared twice inside @mg.js/common** (low, xcut/unused+api-surface) - state/store.ts:24 and transport/types.ts:15 both declare export type Unsubscribe = () => void; state/index.ts:19-20 documents the collision as the reason it will not re-export the name - fix: in store.ts:24 re-export Unsubscribe from '../transport/types.js' instead of redeclaring it.

### convention

- **Test structure is split by package: describe/it in common+headless, flat void test() in bootstrapped** (medium, xcut/conventions) - common/tests/sequencer.test.ts:18-19 describe/it; bootstrapped/tests/coexistence.test.ts:40 flat void test(); 63 describe + 367 it across 14 files vs 123 void test( across 7 - fix: standardise on describe/it, converting the 7 flat files and deleting the banner grouping at coexistence.test.ts:36-38.

### unused-code

- **state/paths.ts exports 14 symbols with zero consumers and no test** (medium, xcut/unused+api-surface) - state/paths.ts:15-78: 14 of 18 exports (ROOM_ROOT, playerCoins, slotGarden, signatureOf, ...) have 0 hits outside the file; no paths.test.ts; README.md:119 hand-writes '/data/players/0/coins' - fix: delete the unused exports, in particular signatureOf (paths.ts:78), or adopt and test them.
- **hasCapturedGet and emptyCatalogSource have no caller** (low, xcut/unused+api-surface) - jotai/bridge.ts:161 hasCapturedGet() is never called and absent from index.ts; client.ts:988 emptyCatalogSource() is never called and omitted from the index.ts:48 re-export list - fix: delete hasCapturedGet (jotai/bridge.ts:161) and emptyCatalogSource (client.ts:988), or publish and cover them.

## Refuted

- **imageTextures cache returns a texture the scene already destroyed, and never releases one** (low, bootstrapped/render-core) - world.ts:421 and :631 destroy sprites with `{ children: true }` only; ctors.ts:70 types `texture?: boolean` separately and no call site supplies it, so no texture is ever destroyed. The cache therefore always returns a live texture and add/remove/add redraws correctly, and the suggested `texture: true` would destroy a texture Pixi's `Texture.from` cache may share with the game.

## Where the weight is

- untrusted wire, patch or URL data reaching assignment keys, structural writes or unguarded buffering (6 findings)
- teardown and uninstall paths that leak listeners, sockets, timers, hooks, captured stores or full state (8 findings)
- test gates that cannot fail, plus test code no TypeScript project ever checks (6 findings)
- one helper or contract reimplemented per package, with copies that have already diverged (7 findings)
- reconnect/retry lifecycle and counters that diverge from the reported close, attempt or shutdown state (5 findings)
- WorldScene and renderer lifecycle: invisible layers, unguarded suppression, one-pet penning, no renderer-recreation recovery (5 findings)
- public options, setters and API endpoints that are inert, unread or silently discarded (8 findings)
- credentials and auth headers reaching events, logs and failure messages, or silently dropped (4 findings)
