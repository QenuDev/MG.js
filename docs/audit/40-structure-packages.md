# SOURCE/FOLDER ORGANIZATION AUDIT: mg.js `packages/*/src` + `packages/*/tests`

66 source files, 21,291 lines, 22 test files. Every claim below was read out of the real files. **Nothing was modified.**

---

## 1. What already works

- **`common/src/` is the only package with a complete, consistent barrel discipline.** All five subsystem folders have an `index.ts` (`protocol/index.ts` 82 lines, `actions/index.ts` 9, `state/index.ts` 24, `catalog/index.ts` 44, `transport/index.ts` 12) and `common/package.json`'s `exports` map (6 entries) mirrors them 1:1. Copy this to the other two packages; do not invent a fourth convention.
- **The `transport/` seam is the one interface both clients implement, and it is correctly minimal.** `common/src/transport/types.ts:43-88` declares `Transport`/`ObservableTransport` and nothing else; `headless/src/transport/client.ts:121` and `bootstrapped/src/attach/transport.ts:117` implement it and never touch each other. The header (`common/src/transport/types.ts:1-11`) explains why parsing and keepalive are not there by design. This is the architecture, and it is honest.
- **Zero barrel-induced import cycles.** `grep -rn "from './index.js'"` over all of `packages/*/src` returns **NONE**: no module imports a barrel. Every barrel is a leaf. Preserve that when adding barrels.
- **The `export *` barrels are tree-shaken correctly, so this is NOT a bundle problem.** Verified against the artifact: `packages/bootstrapped/dist/magicgarden.user.js` (282,800 bytes) contains **zero** occurrences of `RemoteJsonSource`, `DEFAULT_REMOTE_PATHS`, `MemoryLogSink`, or `STATIC_SOURCE_ID`, all of which are reachable from `common/src/index.ts:15-19`. `PlatformApiSource`/`fetchJson`/`HttpError` are present because `bootstrapped/src/client.ts:398` really constructs one. The userscript does not pull a subsystem in via the barrel.
- **The 71-vs-72 action duality is already policed by a test.** `common/src/protocol/forms.ts` (71 `wire:` entries) and `GAME_ACTION_METHOD_COUNT = 72` (`common/src/actions/actions.ts:605`) are asserted equal at `common/tests/forms.test.ts:133`. The two halves can move into one folder without losing the safety net.
- **`client.ts` is the composition root and legitimately stays a bare file** in all three packages. One concept each (`ClientCore`, `HeadlessClient`, `BootstrappedClient`), and the name is right.

---

## 2. Ranked structural problems

### P1. `@mg.js/headless/auth` resolves to a file that cannot reach either auth provider

**Evidence.** `headless/package.json` `exports["./auth"]` → `"./dist/auth/types.d.ts"` / `"./dist/auth/types.js"`. That file is `packages/headless/dist/auth/types.js`, whose only export is `StaticAuthProvider` (line 35) and which contains **0** occurrences of `GuestAuthProvider` or `CookieAuthProvider`. Both real providers live in `auth/cookie.ts` and `auth/guest.ts`, reachable only from the root barrel (`headless/src/index.ts:76-87`). Same class of bug at `exports["./transport"]` → `dist/transport/client.d.ts`, a hand-picked member file rather than a barrel.

**Why it costs a contributor.** The natural import `import { GuestAuthProvider } from '@mg.js/headless/auth'` is `undefined` at runtime and a TS error at typecheck, while the root import works. Nothing catches it: `exports` is not type-checked, so it will stay broken. It is the direct product of the missing-barrel convention below.

**Change.** Add `headless/src/auth/index.ts` and `headless/src/transport/index.ts`; point the two subpaths at `dist/auth/index.js` and `dist/transport/index.js`.

### P2. The barrel rule exists in `common` and nowhere else: three packages, three conventions

**Evidence.**
- `common`: **5/5** subsystem folders have `index.ts`.
- `headless`: **0/2** (`auth/`, `transport/` have none).
- `bootstrapped`: **0/5** (`attach/`, `catalog/`, `coexistence/`, `jotai/`, `render/` have none).

Bootstrapped's root barrel therefore hand-lists ~36 export statements across 14 section comments (`bootstrapped/src/index.ts:44-362`), reaching into member files like `./render/world.js`. That 362-line file is the only place the folder structure is discoverable.

**Why it costs a contributor.** "Where do I add an export" has no answer. In `common` you add one line to a folder barrel; in `headless` you edit `package.json` **and** the root barrel; in `bootstrapped` you edit a 362-line root barrel. P1 is what the missing `auth/index.ts` produced.

**Change.** One rule: **a folder with ≥2 modules gets an `index.ts`; the root barrel re-exports folder barrels, never member files.** Add 2 barrels to `headless`, 5 to `bootstrapped`.

### P3. The "72 typed game actions" story is split across two folders, so no folder owns it

**Evidence.** The surface lives in four files in **two** folders: `common/src/protocol/forms.ts` (539 lines: `ACTION_SPECS` with `wire`/`form`/`category`/`params`), `common/src/actions/types.ts` (348: 52 param interfaces), `common/src/actions/actions.ts` (605: 72 `GameActions` methods), plus the send/ack half in `actions/handle.ts` (158), `protocol/sequencer.ts` (473), `protocol/result-codes.ts` (128). Dependencies cross the boundary both ways: `actions/types.ts:25` → `protocol/types.js`; `actions/actions.ts:19` → `protocol/id.js`; `protocol/forms.ts:16-17` → `protocol/types.js`.

**Why it costs a contributor.** Adding one action means editing three files in two folders, and nothing says whether the next action-related type goes in `protocol/` or `actions/`. `protocol/` currently means both "the wire" and "our commands", which are different things.

**Change.** **`protocol/` = the wire (bytes ↔ messages); `actions/` = the commands we send.** Move `protocol/forms.ts`→`actions/registry.ts`, `protocol/sequencer.ts`→`actions/sequencer.ts`, `protocol/result-codes.ts`→`actions/result-codes.ts`. `protocol/` keeps 6 modules, still a real folder.

### P4. Four different treatments for "one concept, 400-700 lines", with no inferable rule

**Evidence.**

| Module | Lines | Treatment |
|---|---|---|
| `common/src/transport/types.ts` | 104 | folder `transport/` + barrel |
| `bootstrapped/src/jotai/bridge.ts` | 727 | folder with **one** file, **no** barrel |
| `bootstrapped/src/catalog/bundle.ts` | 432 | folder with **one** file, **no** barrel |
| `common/src/client.ts` | 712 | **bare** file |
| `bootstrapped/src/storage.ts` | 454 | **bare** file |
| `bootstrapped/src/realm.ts` | 386 | **bare** file |
| `headless/src/client.ts` | 1025 | **bare** file |

The only inferable rule is "folders appeared in `common` when a concept outgrew one file, and in `bootstrapped` when someone felt like it": bootstrapped gave folders to five subsystems but not to `realm.ts` (imported by **11** files) or `storage.ts` (454 lines). Meanwhile `common` has a folder holding one substantive file while `client.ts` at 712 lines is bare.

**Change.** State the rule as **"a folder means ≥2 modules or a published subpath; otherwise a bare file"**, then apply it.

### P5. `types.ts` is a lie in 5 of 5 folders, and one primitive is declared three times

**Evidence: every `types.ts` holds runtime values.**
- `protocol/types.ts`: `DEFAULT_RECONNECT`, `KEEPALIVE_PING/PONG`, `SCOPE_QUINOA/ROOM`, and the **function** `isKeepalivePing` (`protocol/index.ts:26-33`).
- `catalog/types.ts`: `CATALOG_KINDS`, `GAME_GRID_MS`, `emptyCatalog()`, `restockCountdown()` (`catalog/index.ts:20`).
- `transport/types.ts`: `DEFAULT_LIFECYCLE_TIMEOUTS` (`transport/index.ts:12`).
- `headless/src/auth/types.ts`: the **class** `StaticAuthProvider` (`headless/src/index.ts:74`).

**Duplicate declarations** (scan of every `export type|interface` across all 66 files; only these three collide):
- `Unsubscribe` **three times**: `common/src/state/store.ts:24`, `common/src/transport/types.ts:15`, `headless/src/room-socket.ts:54`. Already causing damage: `common/src/state/index.ts:19-20` carries a comment explaining that it is not re-exported by design "because `./transport/index.js` exports the same shape, and the package barrel re-exports both, so exporting it twice would be ambiguous." A workaround for a self-inflicted duplicate.
- `SocketLike` **twice across packages**: `headless/src/transport/runtime.ts:47` and `bootstrapped/src/attach/raw-socket.ts:71`, same name, different shapes, in two packages forbidden from importing each other.
- `AttachKind` (`bootstrapped/src/attach/room-connection.ts:105-106`) is a literal-union duplicate of `AttachmentKind` (`bootstrapped/src/attach/detect.ts:46`).

**Change.** Declare `Unsubscribe` once in a new `common/src/unsubscribe.ts`; delete the `state/index.ts:19-20` workaround. Rename the `types.ts` files that hold behaviour: `protocol/wire.ts`, `catalog/defs.ts`, `transport/seam.ts`, `actions/params.ts`, `auth/providers.ts`.

### P6. `realm.ts` and `headless/session.ts` are misnamed conduits; `catalog/bundle.ts` re-exports another subsystem

- **`bootstrapped/src/realm.ts`** (386 lines) is two subsystems plus a constant: page resolution (`getPage:172`, `hasPage:183`, `requirePage:193`), the **`__mgjs` page-namespace registry** (`NAMESPACE_KEY:52`, `RealmNamespace:63`, `getNamespace:220`, `claimInstall:342`, `releaseInstall:357`, `deleteNamespace:381`, ...), realm override (`installRealmOverride:129`), **and** `BUNDLE_VERSION:55`, which has nothing to do with realms. Imported by 11 files.
- **`headless/src/session.ts`** (229 lines) is auth, not session: `DISCORD_CLIENT_ID:63`, `OAUTH_SCOPES:69`, `buildDiscordOAuthUrl:86`, `SESSION_COOKIE_NAME = MC_JWT_COOKIE:123` (imported from `./auth/cookie.js:60`), `probeSession:163`. `headless/tests/session.test.ts` already imports `../src/auth/cookie.js` alongside it.
- **`bootstrapped/src/catalog/bundle.ts:432`** ends with `export { classifySlot, restoreSlot };`, re-exporting **coexistence** vocabulary from a **catalog** module, commented "so a caller can assert slot hygiene without reaching into `brand.ts`." `coexistence/renumber.ts:581` does the same. One declaration, three export sites.
- Also misleading: `catalog/bundle.ts` says "bundle" but does one thing, intercepting the **page's `Object.keys`** (header lines 18-21) to extract minified tables structurally. And `protocol/forms.ts` reads as HTML/behavioural forms; it is a 71-entry action registry.

### P7. Two files each carry a whole second subsystem

- **`bootstrapped/src/userscript.ts`** (302 lines) is half entry point, half DOM widget: `HOST_ID:40`, `REFRESH_MS:43`, `createBadge(doc):61-139`, `whenBody:147-159`, then `startUserscript():168-302`. The badge is a self-contained DOM component with no test.
- **`bootstrapped/src/render/world.ts`** (968 lines) is ~500 lines of world-specific logic plus ~360 lines of accreted duplicates. Exact-line mirrors, both sides cited: `isRiveHostLike` `world.ts:869-874` vs `isRiveLike` `ctors.ts:374-378` (and `world.ts:869` admits it in a comment); `asGraphics` `world.ts:964-968` vs `isGraphicsLike` `ctors.ts:435-438`; `detachNode` `world.ts:876-895` vs `detach` `text.ts:199-217`; `collectTileViews` `world.ts:799-830` vs `findAllNodes` `ctors.ts:532-560`; `textureFromImage`/`imageTextures` `world.ts:897-938` vs `constructTexture` `sprite.ts:180-202` and `createTextureCache` `sprite.ts:75-100`, while `sprite.ts:17-18` asserts its cache is "the *only* texture creation path in this package"; warn-once `world.ts:940-955` is the **third** copy (`graphics.ts:274-288`, `rive.ts:432-450`), needing three resets (`world.ts:953`, `graphics.ts:286`, `rive.ts:448`).
- **`asEnvelope` twice in one package**: `bootstrapped/src/client.ts:942` vs `coexistence/renumber.ts:437` (`client.ts:938` calls it deliberate). `getGraphicsCtor` likewise: `render/ctors.ts:771` vs `render/sprite.ts:310`.

### P8. Tests are named after subsystems, so 27 of 66 source files are invisibly untested

**Evidence.** 22 test files, flat, named after a *subsystem or scenario*, never a source file. Only 5 basenames match a source file, and one collides: `common/tests/connect-url.test.ts` (tests `protocol/connect-url.ts`) and `headless/tests/connect-url.test.ts` (tests `client.ts`'s `appendAuthQuery` + `transport/headers.ts`) share a name and test different things.

Untested by name. **common 23/34** (all `actions/*`, `catalog/{http,platform-source,remote-json-source,source,static-source,types}.ts`, `protocol/{close-codes,codec,connect-url,envelope,forms,id,result-codes,sequencer,types}.ts`, `state/{paths,patch,pointer}.ts`, `client.ts`, `emitter.ts`, `errors.ts`, `log.ts`); **headless 11/12**, including `client.ts` at **1025 lines**, plus `version.ts`, `auth/cookie.ts`, `transport/{headers,runtime}.ts`; **bootstrapped 12/20**, including `render/world.ts` (968) and `jotai/bridge.ts` (727), the two largest files in the package, plus `storage.ts`, `userscript.ts`, `render/{pixi,rive,sprite,text,graphics}.ts`, `attach/raw-socket.ts`.

Several are *indirectly* exercised (`forms.test.ts` imports `protocol/forms.ts`), but the file names do not say so. That is the cost.

**Convention.** `packages/<pkg>/tests/<mirrored-source-path>.test.ts`, with scenario tests in `tests/integration/` and the single fixture moved to `tests/fixtures/mock-server.ts`.

### P9. The four biggest files each mix a subsystem policy with its entry point

**`headless/src/client.ts` (1025)**: `:598-769` is a 172-line `openConnection` mutating 12 fields and calling 5 sibling privates; `emit` is called from **8 sites** (`:693, :726, :743, :805, :841, :853, :887, :927`); `closedByTransport` is written in 4 places (`:610, :754, :764, :788`) and read once (`:761`). Split: `client-events.ts` ← `:129-159, 271, 472-498, 982-995`; `client-options.ts` ← `:161-247`; `client-session.ts` ← `:273-282, 290-291, 294-297` (`SessionState`, the seam that removes the `connect-attempt ↔ client` edge); `connect-attempt.ts` ← `:598-769` (ports `{ session, events, onClose, onSyntheticClose, trackDetacher }` for `:720/:747`); `handshake.ts` ← `:118-127, 771-784`; `connect-url.ts` ← `:998-1004` (`joinHost`, now exported) + `:1006-1025`; `reconnect-scheduler.ts` ← `:914-954` + field `:292`; `supersession.ts` ← `:833-847, 865-899` + resets `:535, :561`. Residue ≈ 450 lines. **Do not** also split `handleClose`/`afterClose` (`:786-863`): two entry points (`:806`, `:892`) would need ports back into `supersession.ts` and `reconnect-scheduler.ts`, forming a cycle for the worst effort/benefit ratio in the repo.

**`bootstrapped/src/client.ts` (994)**: `coexistence/outbound.ts` ← `asEnvelope:934-946`, `parseEnvelope:948-963`, `applyRenumberingToString:965-985` (already duplicating `coexistence/renumber.ts:546`), `readWelcomeFrontier:926-932`, and private `rewriteOutboundObject:730-736` becoming `rewriteOutboundObject(payload, renumberer)`; this collapses the branch at `:458-469`. `attach/upgrade.ts` ← `:504-513, 515-547, 549-623` + fields `:200/:203/:210` (`detect.ts` must not import it). `render/facade.ts` ← `:139-161, 846-866, 868-897`, replacing the private reach-in `client['captureHandle']` at `:852` with `createRenderFacade({ capture: () => this.captureHandle })`. `diagnostics.ts` ← `:163-173, 794-834`. Deletions that fall out: `EMPTY_STARTUP_SINK:899-924` is a field-for-field duplicate of `attach/detect.ts:112-128` `createEmptySink()`; `emptyCatalogSource:987-994` is **dead** (no reference in `src/`, absent from `index.ts:48-49`); `:427-429` registers an `onTeardown` whose body is only a comment. Residue ≈ 340-390 lines.

**`bootstrapped/src/render/world.ts` (968)** → ~560-610: `render/world-geometry.ts` ← `:62-74, 129-136, 699-766`; `render/tile-view.ts` ← `:153-160, 799-867` (`collectTileViews` becomes a one-liner over `ctors.ts:532`; `pixi.ts:283-339` needs a `findAllNodes` passthrough); `render/cinematic-claims.ts` ← `:95-108, 162-173, 547-594`; `render/warn-once.ts` ← `:940-955` generalized, absorbing `graphics.ts:274-288` and `rive.ts:432-450`; `textureFromImage`/`imageTextures` (`:905, 906-938`) into `sprite.ts`; delete `detachNode`/`asGraphics`/`isRiveHostLike` against the exact siblings above. Also: `sceneCounter:175-176` has **no reset exported**, making it the one piece of world state tests cannot make deterministic.

**`bootstrapped/src/attach/room-connection.ts` (920)**: 11 pure helpers (`:47-48, 195-292, 757-920`) that the closure only *calls*, plus a 426-line `bindRoomConnection` closure (`:301-755`). `attach/sink.ts` ← `AttachKind:105-106`, `WelcomeEvent:86-96`, `RoomFrameEvent:98-103`, `AttachedSink:108-134`, `SinkWiring:832-842`. The **strongest mis-homing signal is that `AttachedSink` has four implementors** (`room-connection.ts:852-880`, `raw-socket.ts:381-427`, `detect.ts:112-128`, `client.ts:924`) and is declared inside one. `attach/room-frame.ts` ← `asSequence:244-248`, `normaliseRoomFrame:757-782`, `serialiseFrame:784-830` (must move together; `:818` calls it); these reimplement `common/src/protocol/codec.ts:104-131` and `:57-89`, admitted at `:760-761`; `asSequence:245-248` is a *stricter* `extractFrontier` (integer ≥ 0 vs finite), an existing behavioural inconsistency. `attach/room-identity.ts` ← `:250-292` (`:267-272` concedes the shipped build never puts the id in state; `raw-socket.ts:137-170` `scrapeFrame`, field read `:157-158`, is the path actually used at `client.ts:487-513`). `attach/room-connection-probe.ts` ← `:47-48, 50-84, 195-210, 882-920` (page-global probing is `realm.ts`'s job, `realm.ts:9-12`, with `raw-socket.ts:52` as precedent). `attach/room-subscriptions.ts` ← `toUnsubscribe:212-243` + the 5 fanout loops (`:447-453, 456-462, 482-488, 492-498, 528-534`). Five invariants the split must not break: one shared frontier high-water mark (written `:446/:526/:587`, read `:373/:582-593`; duplicating it reintroduces the double-stamp hazard warned about at `:588-592`); wrapSend `:428-429` before attaches `:549-551`; unsubscribes `:726-732` before hooks in reverse `:735-741`; the single `released` guard `:327/:724`; the rewriter stays a **single slot**, not a set (`:328-335`). Also `AttachedSink` uses different verbs from `Transport` for the same operations: `sendRaw:125`/`onFrame:127` vs `send:57`/`onMessage:68` (`detach`/`close` is different by design, per `attach/transport.ts:15-19`), and `WelcomeEvent.state:89` overlaps `WelcomeMessage.fullState` (`common/src/protocol/types.ts:132`), with `attach/transport.ts:75-89` existing only to bridge them.

---

## 3. Proposed tree

Marks: **`move`** = pure relocation/rename, no code change. **`split`** = content redistributed. **`new`** = barrel or new module.

```
packages/common/src/                                  (34 -> 35 files)
  index.ts                    # explicit re-exports only; drop the 5 `export *`
  unsubscribe.ts              # new:  the ONE `Unsubscribe` declaration (kills 3 copies)
  client.ts                   # unchanged: ClientCore, composition root, stays bare at 712 lines
  emitter.ts / errors.ts / log.ts                        # unchanged
  protocol/                   # "the wire". loses the command story
    index.ts
    wire.ts                   # rename <- protocol/types.ts   (SCOPE_*/KEEPALIVE_* + isKeepalivePing)
    envelope.ts / codec.ts / connect-url.ts / close-codes.ts / id.ts   # unchanged
  actions/                    # "the commands we send": owns the whole 72-action surface
    index.ts                  # drop the redundant export-then-star at :6-7
    registry.ts               # move   <- protocol/forms.ts     (ACTION_SPECS: wire/form/category/params)
    params.ts                 # rename <- actions/types.ts      (52 param interfaces)
    game-actions.ts           # rename <- actions/actions.ts    (72 methods + GAME_ACTION_METHOD_COUNT)
    handle.ts                 # unchanged (absorbs `AckMode` from client.ts:49)
    sequencer.ts              # move   <- protocol/sequencer.ts
    result-codes.ts           # move   <- protocol/result-codes.ts
  state/                      # unchanged: index.ts, pointer.ts, patch.ts, store.ts, paths.ts
  catalog/
    index.ts
    defs.ts                   # rename <- catalog/types.ts      (holds CATALOG_KINDS + 2 functions)
    source.ts / http.ts / platform-source.ts / remote-json-source.ts / static-source.ts / weather.ts
  transport/
    index.ts
    seam.ts                   # rename <- transport/types.ts    (the seam + DEFAULT_LIFECYCLE_TIMEOUTS)

packages/headless/src/                                (12 -> 22 files)
  index.ts                    # re-points at folder barrels
  client.ts                   # split -> ctor/accessors/connect/disconnect + facade re-exports (~450)
  client-options.ts           # split <- client.ts:161-247
  client-events.ts            # split <- client.ts:129-159, 271, 472-498, 982-995
  client-session.ts           # split <- client.ts:273-282, 290-291, 294-297   (SessionState record)
  connect-attempt.ts          # split <- client.ts:598-769   (openConnection + ports)
  connect-url.ts              # split <- client.ts:998-1004 (joinHost, now exported) + :1006-1025
  handshake.ts                # split <- client.ts:118-127 + :771-784
  reconnect-scheduler.ts      # split <- client.ts:914-954 + field :292
  supersession.ts             # split <- client.ts:833-847, 865-899 + resets :535, :561
  reconnect.ts / room-socket.ts / version.ts   # room-socket drops its local `Unsubscribe` (:54)
  transport/                  # "owning a socket" (published subpath, now barrelled)
    index.ts                  # new: FIXES exports["./transport"] pointing at a member file
    standalone.ts             # rename <- transport/client.ts (class is StandaloneTransport)
    runtime.ts                # unchanged; `SocketLike` -> `NodeSocketLike` (dedupe vs bootstrapped)
    headers.ts                # unchanged
  auth/                       # "proving who we are" (published subpath, now barrelled)
    index.ts                  # new: FIXES the broken exports["./auth"] (StaticAuthProvider only today)
    providers.ts              # rename <- auth/types.ts  (holds the StaticAuthProvider CLASS)
    cookie.ts / guest.ts      # unchanged
    session.ts                # move <- src/session.ts   (Discord OAuth + mc_jwt probe = auth)

packages/bootstrapped/src/                            (20 -> 48 files)
  index.ts                    # re-points at folder barrels; 362 lines -> ~90
  client.ts                   # split -> composition root only (~340-390 lines)
  diagnostics.ts              # split <- client.ts:163-173, 794-834  (buildBootstrapReport)
  build-info.ts               # split <- realm.ts:55  (BUNDLE_VERSION is not a realm concern)
  page/                       # new folder (split of the 386-line realm.ts)
    index.ts                  # new
    realm.ts                  # split <- realm.ts: getPage/hasPage/requirePage/PageRealm
    namespace.ts              # split <- realm.ts: NAMESPACE_KEY/RealmNamespace/get+peek+delete namespace/
                              #   defineGlobal/readGlobal/undefineGlobal/on+emitNamespaceEvent/
                              #   claimInstall/releaseInstall/onTeardown
    override.ts               # split <- realm.ts: RealmOverrideOptions + installRealmOverride
  storage/                    # new folder: the only host surface without one today (454 lines)
    index.ts                  # new
    types.ts                  # split <- storage.ts: StorageBackendKind/StorageBackend/StorageOptions/
                              #   WebStorageLike/GreasemonkeyApi/TypedStorage
    backends.ts               # split <- storage.ts: resolveGreasemonkeyApi/createGmBackend/
                              #   createWebStorageBackend/resolveLocalStorage/createMemoryBackend
    typed.ts                  # split <- storage.ts: DEFAULT_KEY_PREFIX/createStorage/selectBackend/probeStorage
  attach/                     # "borrowing a socket"
    index.ts                  # new
    detect.ts                 # unchanged (the attachment primitive; must not import upgrade.ts)
    attached-transport.ts     # rename <- attach/transport.ts (class is AttachedTransport)
    raw-socket.ts             # unchanged; `SocketLike` -> `PageWebSocketLike`
    room-connection.ts        # split -> bindRoomConnection + the binding literal only (~300 lines)
    sink.ts                   # split <- room-connection.ts: AttachKind/WelcomeEvent/RoomFrameEvent/
                              #   AttachedSink/SinkWiring   (4 implementors, 1 declaration site)
    room-frame.ts             # split <- room-connection.ts: asSequence/normaliseRoomFrame/serialiseFrame
    room-identity.ts          # split <- room-connection.ts: readSelfPlayerId/resolveSelfPlayerId
    room-connection-probe.ts  # split <- room-connection.ts: ROOM_CONNECTION_KEY/RoomConnectionLike/
                              #   readRoomConnection/isRoomConnectionUsable/describeRoomConnection
    upgrade.ts                # split <- client.ts:504-513, 515-547, 549-623 + fields 200/203/210
  coexistence/
    index.ts                  # new
    brand.ts                  # unchanged; becomes the SINGLE source for classifySlot/restoreSlot
    renumber.ts               # unchanged; drop its re-export at :581
    outbound.ts               # split <- client.ts:926-985 + rewriteOutboundObject:730-736
  jotai/                      # folder currently holds ONE 727-line file and no barrel
    index.ts                  # new
    detect.ts                 # split <- bridge.ts: ATOM_CACHE_KEY/has+getCapturedSet/hasCapturedGet/
                              #   install:306-516/restoreWrappedWrites/resetJotaiCapture
    write.ts                  # split <- bridge.ts: writeAtom/WriteResult/WriteFailureReason/
                              #   createLookup/labelMatches
    registry.ts               # split <- bridge.ts: JotaiBridge class:627+/readAtom/JotaiAtom/AtomVisitor
  render/
    index.ts                  # new
    ctors.ts                  # unchanged; absorbs findRenderLayerCtor + the deduped duck-typing helpers
    pixi.ts                   # unchanged; gains a `findAllNodes` passthrough (:283-339)
    sprite.ts                 # unchanged; absorbs textureFromImageElement + the object-keyed cache
    text.ts / graphics.ts / rive.ts   # graphics+rive migrate onto warn-once.ts
    world-scene.ts            # rename <- render/world.ts   (968 -> ~560-610 lines)
    world-geometry.ts         # split <- world.ts:62-74, 129-136, 699-766
    tile-view.ts              # split <- world.ts:153-160, 799-867 (+ reuse findAllNodes)
    cinematic-claims.ts       # split <- world.ts:95-108, 162-173, 547-594
    warn-once.ts              # split <- world.ts:940-955, generalized; replaces 2 more copies
    facade.ts                 # split <- client.ts:139-161, 846-897
  live-catalog/               # rename of catalog/: the name must say it hooks Object.keys
    index.ts                  # new
    object-keys-source.ts     # split <- catalog/bundle.ts: BUNDLE_SOURCE_ID/DEFAULT_CAPTURE_WINDOW_MS/
                              #   BundleCapture/Handle/Options/captureCatalogBundle/createBundleSource/
                              #   resolvePageObject/snapshotTables/inertHandle
    scoring.ts                # split <- catalog/bundle.ts: FIELD_HINTS/KIND_ROOTS/scoreTableForKind/
                              #   asEntryList/profileEntries/MAX_SCAN_DEPTH
  entry/                      # new folder: the userscript delivery target, not the library
    userscript.ts             # split <- userscript.ts: startUserscript
    badge.ts                  # split <- userscript.ts: HOST_ID/REFRESH_MS/createBadge/whenBody
```

Tests convention (all three packages):

```
packages/<pkg>/tests/
  <mirrored/source/path>.test.ts   # render/world-scene.test.ts, attach/sink.test.ts,
                                   # protocol/codec.test.ts, actions/registry.test.ts
  integration/                     # scenario tests, named for the scenario
    build-output.test.ts  live-socket.test.ts  attach.test.ts  room-upgrade.test.ts
  fixtures/
    mock-server.ts                 # move <- headless/tests/mock-server/server.ts
```

A reader can then answer "where is the test for `render/world-scene.ts`" by path, and the 27 currently-invisible gaps become empty slots.

**Note on `export *`.** Replace the 5 in `common/src/index.ts:15-19` (plus `actions/index.ts:7`, `state/index.ts:24`) with explicit lists: `state/index.ts:19-20` documents a real collision it caused, and `actions/index.ts:6-7` exports the same two names twice. Do **not** justify this by bundle size: I verified the built userscript does not contain the unused catalog/HTTP/log-sink modules, so esbuild already tree-shakes them.

---

## 4. Migration cost

**File movement.** 66 src files → ~105. **12 pure `move`/`rename`**: common `forms.ts`→`registry.ts`, `sequencer.ts`, `result-codes.ts`, `types.ts`→`params.ts`, `actions.ts`→`game-actions.ts`, `transport/types.ts`→`seam.ts`; headless `session.ts`→`auth/session.ts`, `auth/types.ts`→`providers.ts`, `transport/client.ts`→`standalone.ts`; bootstrapped `attach/transport.ts`→`attached-transport.ts`, `render/world.ts`→`world-scene.ts`, `catalog/`→`live-catalog/`. **9 splits into 41 files (net +32)**: `realm.ts`→4, `storage.ts`→4, `jotai/bridge.ts`→4, `catalog/bundle.ts`→3, `userscript.ts`→3, `render/world.ts`→5, `bootstrapped/client.ts`→5, `attach/room-connection.ts`→6, `headless/client.ts`→8. Plus **11 new barrels** and `common/src/unsubscribe.ts`.

**Import-site churn.** `realm.ts` → **11** importers; `attach/room-connection.ts` → 5; `storage.ts`, `render/world.ts`, `catalog/bundle.ts` → 2 each. The world/room-connection splits are invisible outside their folder once barrels exist, because `bootstrapped/src/index.ts:278-297` and the tests import by name.

**Public export paths that break.**
- `@mg.js/headless/auth`: **content changes** (adds `CookieAuthProvider`, `GuestAuthProvider`, `MC_JWT_COOKIE`, `toCookieHeader`, `ANONYMOUS_USER_STYLE_PARAM`, `buildAnonymousUserStyle`, plus the session symbols) and its declaration file moves from `dist/auth/types.d.ts` to `dist/auth/index.d.ts`. Additive in names, but consumers pinned to the exact `.d.ts` path break. **This is the fix, not the regression** (P1).
- `@mg.js/headless/transport`: target moves from `dist/transport/client.js` to `dist/transport/index.js`; names additive.
- `@mg.js/common/*`: **six subpaths unchanged** (`.`, `./protocol`, `./actions`, `./state`, `./catalog`, `./transport`), but `./protocol` loses `forms`/`sequencer`/`result-codes` while `./actions` gains them. Deep-import consumers break; root-barrel consumers do not.
- `@mg.js/bootstrapped`: root subpath stable, but these names are **removed** (allowed pre-1.0): `emptyCatalogSource` (dead) and the dedupe targets `asGraphics` (`world.ts:964`), `isRiveHostLike`, `detachNode`, `client.ts:942`'s `asEnvelope`, `sprite.ts:310`'s `getGraphicsCtor`. `EMPTY_STARTUP_SINK` survives as `createEmptySink()`.
- `@mg.js/bootstrapped/{attach,render,coexistence,page,jotai,storage,live-catalog}`: **new** subpaths; nothing published there today.

**What the `exports` maps must become.** All three get the same shape: one entry per folder that has an `index.ts`, in the existing `"types"`/`"default"` object form.
- `common`: still 6 entries; `./protocol` and `./actions` now point at newly-populated barrels. No new subpath.
- `headless`: `"."` → `dist/index.js` (unchanged); `"./transport"` → `dist/transport/index.js` (**was** `dist/transport/client.js`); `"./auth"` → `dist/auth/index.js` (**was** `dist/auth/types.js`).
- `bootstrapped`: `"."` (unchanged) + `"./attach"`, `"./render"`, `"./coexistence"`, `"./page"`, `"./jotai"`, `"./storage"`, `"./live-catalog"` (7 new). The userscript output `dist/magicgarden.user.js` and `scripts/build.ts` are untouched.

**Safe order of operations**: each numbered step is one commit:

1. **Dedupe only, no moves.** Add `common/src/unsubscribe.ts` and re-point `state/store.ts:24`, `transport/types.ts:15`, `headless/src/room-socket.ts:54`; delete the `state/index.ts:19-20` workaround. Dedupe `asEnvelope`, `getGraphicsCtor`, `EMPTY_STARTUP_SINK` (→ `createEmptySink()`), `isRiveHostLike`/`asGraphics`/`detachNode`, `AttachKind`/`AttachmentKind`, and the `classifySlot`/`restoreSlot` re-exports at `bundle.ts:432` and `renumber.ts:581`. Delete dead `emptyCatalogSource`. Zero path changes ⇒ trivially green, and it shrinks every later diff.
2. **Common layout, alone.** The 6 move/renames; update `common/src/{index,actions/index,state/index,transport/index,protocol/index}.ts` and the 9 files in `packages/common/tests/`. `exports` keys unchanged. headless/bootstrapped untouched, since they use only stable root-barrel names.
3. **headless: barrels + `exports` in ONE commit.** Add `auth/index.ts` + `transport/index.ts`, move `session.ts`→`auth/session.ts`, rename `auth/types.ts`→`providers.ts`, rename `transport/client.ts`→`standalone.ts`, and update **both** `exports` entries. Then verify with `tsc -b --force` **and** a runtime `node -e "import('@mg.js/headless/auth').then(m=>console.log(Object.keys(m)))"`, because `tsc -b` does not read `exports` and stays green while the subpath resolves to the wrong module.
4. **bootstrapped: barrels + the `realm`/`storage` splits in ONE commit.** They must land with `attach/index.ts`, `render/index.ts`, `coexistence/index.ts` and the root-barrel rewrite, because `realm.ts` alone has 11 importers and a half-moved `realm.ts` breaks most of the package.
5. **Big-file splits, one file per commit, ascending risk:** `catalog/bundle.ts`→`live-catalog/`; `userscript.ts`→`entry/`; `render/world.ts`→5 modules; `attach/room-connection.ts`→4 modules; `bootstrapped/client.ts`→4 modules; `headless/client.ts`→8 modules. Each keeps `client.ts` / `world-scene.ts` / `room-connection.ts` as a re-export facade so `src/index.ts` and every existing test keeps compiling, and that facade is what makes each split independently revertable.
6. **Tests last:** move to `tests/<mirrored-path>.test.ts` (updating the relative `../src/...` specifiers) and add `tests/integration/` + `tests/fixtures/`.

**The one thing that must never be split across commits: an `exports` map edit and the file move it points at.** `tsc -b` does not read `exports`, which is how `@mg.js/headless/auth` came to resolve to a file with no `GuestAuthProvider` while the build stayed green.

---

Report delivered to the parent agent (`session-1c2af8d3-5100-4cb5-9090-4b65067fca63`). No files were modified.
