# Attachment

## Attachment: the socket now, the room object when it appears

The bootstrap layer prefers `MagicCircle_RoomConnection`, and §4 of the protocol docs documents four things it does for you (JSON parsing, a tracked sequence frontier, transparent reconnects, and a synchronous state read). But it cannot be used at start-up, and the reason belongs in writing because it produced a real bug.

**The object is created lazily, by the game, seconds after `document-start`.** The current bundle reads:

```js
static getInstance(){ return window.MagicCircle_RoomConnection ||
  (window.MagicCircle_RoomConnection = new e), window.MagicCircle_RoomConnection }
```

The first `getInstance()` call does not come from the socket code. It comes from the room subsystems the game constructs *after* it joins. The avatar manager, the chat layer and the shop announcers each name it in a class-field initializer or a default parameter. Until one of those is constructed, the property does not exist. Both reference mods already behave as if this is true: `garden-companion` polls it 180 times at 500 ms intervals, and `MG-AriesMod` waits 5 s before reaching for it.

The first version of this package checked once. `waitForAttachment` returned the first candidate that was not `'none'`, and the raw-socket path binds at `document-start` because it only needs `page.WebSocket`, so the very first attempt won with the fallback and the preferred path was never probed again. The visible symptom was a status badge reading

```
attach kind : raw-socket
room path rejected: the page does not expose MagicCircle_RoomConnection
```

on a page that had been playing for minutes with thousands of patch sets applied.

**The fix is a promotion, not a longer wait.** Waiting would leave the mod dead for the seconds the game takes to build the object, and `transport.state` reading `'idle'` in the meantime. Instead the client attaches to the raw socket immediately, which works from the first frame, and then `watchForRoomConnection()` polls for the object and upgrades the live attachment when it appears. `roomUpgradeTimeoutMs` (default 90 s, matching the companion's window) bounds the watch; `0` disables it; an explicit `forceAttachment` is never second-guessed.

Three details make the upgrade safe rather than merely convenient:

- **A single outbound rewriter.** Both paths rewrite outbound frames and both number into the same `commandSequence` space, so having the old socket-level rewriter installed alongside the new object-level one would consume two numbers for a single command, which leaves the gap the server answers with `invalid_sequence` and poisons every later command. The old rewriter is cleared before the new one is installed, and the whole switch is synchronous so no frame can be sent in between.
- **The frontier is carried across.** The new path's frontier (`lastDistributedRoomPublication.executedCommandSequence`) is fed to the renumberer with `observeFrontier`, which only ever moves forward, so the switch cannot make it re-issue a number the server has already executed.
- **The object is never created by us.** The game's own constructor throws if the global already exists ("RoomConnection is a singleton"), so we only ever read it.

There is one honest trade-off. The object-level hook sees everything on the current build, since the game's wrapped RPCs go through `trySendMessageNow` and its flat messages through `sendMessage`, and the binding wraps both, but a future build that wrote straight to the socket would bypass it. That risk is accepted because the alternative (keeping both hooks) fails *silently* on every command, whereas this one is visible in the attachment report the moment sends stop being renumbered.

### The renumbering seam is the socket, whichever path attached

The observation seam and the renumbering seam are **not the same seam**, and the upgrade moves only the first.

Every outbound frame the game produces ends up in `currentWebSocket.send()`, including the ones that go through the room object, because `trySendMessageNow` → `sendOpenMessage` → `devSendDelayLine` → `writeToSocket` → `socket.send()`. So the socket hook is the one layer that cannot be bypassed, while the room object's two methods only see traffic that chooses to route through them. Both reference mods patch the socket for this reason: `garden-companion` notes that "sendMessage does not pass the socket send we wrap, so a command sent that way left with no sequence at all", and `MG-AriesMod` wraps `WebSocket.prototype.send` because the game's own counter is module-local and therefore invisible.

So when the socket path attached first, **it keeps the seam** through an upgrade: observation moves to the room object, and the socket hook stays installed to number everything. Only one rewriter is ever live, because each one consumes a number and a command rewritten twice leaves the same gap as one never rewritten.

That decision is now asserted rather than argued: a test drives a command through the room object *and* a second one written straight to the socket, and requires each to consume exactly one sequence number.

`client.attachmentReport` refreshes `socketsSeen` from the live binding on every read; the stored value is a sample taken before the game has opened its socket, and a diagnostic that reports `0` while the counted event is demonstrably happening is worse than no diagnostic.

