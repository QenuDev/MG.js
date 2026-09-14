# Audit 07: `packages/bootstrapped/src/attach/`

Scope: `detect.ts`, `raw-socket.ts`, `room-connection.ts`, `transport.ts`. Everything below was read in
full; callers checked with grep before anything was called unused or dead.

## 1. `current` is recorded for every socket, so an unrelated socket becomes the send target: high

`raw-socket.ts:221-232`

```ts
221  const attach = (socket: SocketLike, args: unknown[]): void => {
...
228    current = socket;
230    // The room socket is the one worth remembering. Every socket the page opens passes through here, so
231    // noting them all would let an unrelated one take the place of the game connection.
232    if (!socketUrl(socket, args).includes(urlFilter)) return;
```

`current` is assigned **before** the room-URL test on line 232, and the `close` listener that clears it
(`raw-socket.ts:269-271`) is only installed *inside* the filtered branch, i.e. after the `return`.
`canSend()` (`raw-socket.ts:384-395`) and `sendRaw()` (`raw-socket.ts:397-406`) read `current` with no
further check, and `AttachedTransport.state`/`send` are built entirely on those two
(`transport.ts:212-221`, `230-244`).

Effect: the first non-room socket the page opens after the room socket becomes `current`. That socket is
the assets/telemetry socket the module header itself names at `raw-socket.ts:18-20`. `canSend()` then
reports `true` for a socket that is not the game connection, and every command is handed to it via
`socket.send(raw)` and lost. Worse, because only room sockets get a `close` listener, once that stray
socket closes `current` keeps pointing at it: `canSend()` is permanently `false` and `sendRaw`
throws-and-returns-`false` (`raw-socket.ts:403-405`) for the rest of the session even though the real room
socket is still open.

This is precisely the failure the file's own header records as fixed ("noting them all let a later one -
anything at all - take the place of the game connection and quietly carry our commands nowhere",
`raw-socket.ts:18-20`); line 228 reintroduces it under a comment claiming the opposite.

Fix: assign `current` only for the socket we adopt. Move `current = socket;` below line 232 into the
room branch, next to the listener installation, so `current` and the `close` listener always agree.

## 2. The stand-in `Welcome` is not a one-shot: it re-fires on every patch frame, high

`room-connection.ts:474-491`

```ts
479        if (!sawWelcome) {
480          const standIn = buildStandInWelcome(fullState);
481          if (standIn !== null) { ... welcomeHandler(standIn) ... }
```

`sawWelcome` is only ever set to `true` at `room-connection.ts:513`, inside the *real* welcome
subscription; the stand-in path never sets it. `buildStandInWelcome` (`room-connection.ts:366-377`)
returns a non-null event for any object state. So on the build the stand-in exists for, the one
documented at `room-connection.ts:342-350`, where the game fired `Welcome` before this binding existed and
never re-fires, `sawWelcome` stays `false` for the whole session and **every** `subscribeToPatches`
callback emits another full-state `Welcome`.

Those events reach the core: the transport's welcome handler re-frames them (`transport.ts:152-168` →
`welcomeToFrame`, `transport.ts:75-89`) into the same message channel as room frames, and
`ClientCore.handleRawFrame` routes them to `handleWelcome` (`common/src/client.ts:191`, `523-526`), which
does `this.store.replaceRoot(root)` and emits `welcome`, `state` and `ready`
(`common/src/client.ts:556`, `564-566`). `replaceRoot` bumps the version, sets `changedPaths: ['']` and
`wasSnapshot: true`, and wakes *every* subscriber (`common/src/state/store.ts:135-147`). A "fallback" thus
becomes a per-frame full-snapshot wake-up plus a repeated `ready` event at patch rate, 433 of them in the
session quoted at `room-connection.ts:347-349`.

Fix: latch the stand-in. Add `let standInDelivered = false;` beside `sawWelcome` (`room-connection.ts:351`)
and set it when a stand-in is dispatched, so at most one stand-in is emitted per binding (re-emitting only
if `selfPlayerId` improves from `null` to a string).

## 3. `release()` leaves both socket listeners installed: high

`raw-socket.ts:234-263` registers a `message` listener and `raw-socket.ts:269-271` a `close` listener on
the host's room socket. `SocketLike.removeEventListener` is declared (`raw-socket.ts:75`) but
`removeEventListener` is never *called* anywhere in the package (grep over `packages/bootstrapped/src`:
one hit, the declaration). `release()` (`raw-socket.ts:443-464`) restores `window.WebSocket`, restores the
instance `send` hooks and clears both handler sets, but never touches the listeners, while the interface
it implements promises "Restore `window.WebSocket` (identity-guarded) and drop every listener"
(`raw-socket.ts:119`).

After `client.uninstall()` (`client.ts:662-670` releases the attachment *and* the raw send seam kept alive
by the raw→room upgrade at `client.ts:593-596`) the host socket still holds a closure over the released
binding. Every inbound frame still runs `scrapeFrame` (`raw-socket.ts:138-170`): the two `String.includes`
scans and, for a frame carrying either marker, a full `JSON.parse`. That is the per-frame cost the
scraper's gating exists to avoid (`raw-socket.ts:40-43`), and it lasts for the life of the page.

Fix: record the pairs as they are installed and remove them in `release()`, e.g. keep
`const listenerRemovals: Array<() => void> = []`, push
`() => socket.removeEventListener?.('message', onMessage)`, and in `release()` splice them in reverse
inside the existing try/catch.

## 4. The raw-socket sink has no welcome replay, so a `Welcome` that beats the subscriber is lost, medium

`raw-socket.ts:408-420`: `onWelcome` only adds to `welcomeHandlers`. The scraped welcome is delivered once,
at `raw-socket.ts:239-254`, to whoever is registered at that instant. Nothing re-derives it afterwards,
even though the binding already holds the two facts it needs (at `raw-socket.ts:434`, `116` it holds
`selfPlayerId`, and at `raw-socket.ts:422` it holds `frontier`), and the room path already closes this
same gap with the stand-in in `subscribeToWelcome` (`room-connection.ts:635-649`).

Consequence on the fallback path: if the `Welcome` frame is scraped before `AttachedTransport` subscribes
(`transport.ts:152-168`, driven from `client.ts:456`), the core is never told the session started, so
`readyState` stays `false` and `welcomeValue`/`selfPlayerId` stay unset for the whole session. That is the
symptom the room-path stand-in was written for (`room-connection.ts:342-350`).

Fix: replay on subscribe. In `sink.onWelcome` (`raw-socket.ts:415`), after `welcomeHandlers.add(handler)`,
if `selfPlayerId !== null` call `handler({ state: null, executedCommandSequence: frontier,
publishedAtServerMs: null, selfPlayerId })` inside try/catch, which is the same shape
`buildStandInWelcome` produces.

## 5. `release()` clears the frontier but keeps the whole state tree: medium

`room-connection.ts:742-750` clears the five handler sets, `lastFrontier` and `activeRewriter`, and
documents why the frontier is cleared ("a fresh binding after a reconnect must not inherit a frontier
belonging to a session that has ended"). It does not clear `lastFullState` (`room-connection.ts:341`,
assigned at `478` and `514`), `lastSelfPlayerId` (`339`) or `sawWelcome` (`351`). `lastFullState` is a
`cloneForDistribution` of the entire game state, and the released binding stays referenced by the client
(`client.ts:662-664` calls `release()` without dropping `this.attachment`), so the snapshot survives
uninstall. Same class of per-binding state, same decision, inconsistently applied.

Fix: set `lastFullState = null; lastSelfPlayerId = null; sawWelcome = false;` alongside `lastFrontier = null`
in `RoomConnectionBinding.release()` (`room-connection.ts:723`).

## Also noted (below the top five)

- `raw-socket.ts:348-362`: `Reflect.construct(Original as unknown as Function, args)` omits `new.target`,
  so an in-page `class X extends WebSocket` produces an object whose prototype is `Original.prototype`
  (`raw-socket.ts:369`) and `new X() instanceof X` is `false`; `Replacement.length` is `0` and its `name`
  is `'MgjsWebSocket'`. Use `Reflect.construct(Original, args, new.target as Function)`.
- `transport.ts:478-489`: `stopPolling()` sets `this.timer = null` but never calls `clearTimeout`, and
  `AttachedTransportOptions` (`transport.ts:99-108`) has no cancel hook, so an injected `schedule` cannot
  be cancelled at all, whereas `WatchForRoomConnectionOptions.cancelSchedule` exists (`detect.ts:330`).
  `transport.ts:403-411` also invokes the captured `handler` from the `onOpen` microtask without
  re-checking `openHandlers`, so a handler unsubscribed before the microtask still fires.
- `raw-socket.ts:185-186` and `103-105` claim a second bind "reuses the registrar it carries" and that two
  loads "share one captured instance"; `raw-socket.ts:338-344` only sets `releaseCtor = null` and reports a
  foreign hook, so the second binding observes no socket at all. Implement the sharing (park the registrar
  on the branded constructor) or correct the docs.

## What works well here

- The `brandWrapper`/`classifySlot`/`restoreSlot` protocol (`coexistence/brand.ts`) is applied uniformly:
  every wrapper is chained onto a foreign hook rather than replacing it, and restored identity-guarded in
  reverse order (`raw-socket.ts:298-312`, `room-connection.ts:405-426`, `723-741`).
- Every hook and observer callback is individually try/caught, so a consumer's throw can never reach the
  game's own dispatch (`raw-socket.ts:247-262`, `room-connection.ts:447-453`, `transport.ts:142-148`).
- The transport never closes the host socket and reports detachment as `wasManual: true`
  (`transport.ts:261-298`), the one behaviour that would disconnect the player if it were wrong.
- `watchForRoomConnection` handles its own cancellation correctly (`detect.ts:376-382`, `411-412`) and
  releases a rejected candidate before continuing to poll (`detect.ts:398-401`).
- The scrape is gated cheaply (length, then substring, then parse) with explicit reasoning for why the
  order matters (`raw-socket.ts:138-170`).
