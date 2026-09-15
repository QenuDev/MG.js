# Developer announcements this library encodes

## Developer announcements this library encodes

The game's `modding-announcements` channel is the closest thing to an official mod API contract, and several entries changed decisions in this codebase. Recorded here so the reasoning is not re-litigated from scratch, and so the *policy* constraints stay visible next to the technical ones.

### Supersession must not be auto-reconnected (v473+)

> "auto-reconnecting users when the connection ends due to being 'superseded' is unsafe, and can result in data loss, especially if the player has the game open in two rooms, as each room will play tug-of-war over the user, and the result is nothing gets saved. So, please don't do that."
>
> "once version 473+ is rolled out, servers are now more strict about allowing reconnection in the case of supersession, please do not automate this; it is only safe to do so with explicit confirmation from the player."

This is the one announcement that made an earlier version of this library **wrong**. Close codes 4250/4300 used to classify as `reconnect-slow`, meaning the headless client would reclaim a superseded session by itself, with `reclaimSupersededSession=true`. That is the behaviour being warned about, and it can destroy the *other* client's session.

Now a real supersession classifies as **`reconnect-confirm`** with `shouldReconnect: false` and a new `requiresConfirmation: true`. Nothing reconnects; the client emits `confirmationRequired` and waits. The only route to a reclaim is an explicit `client.confirmSupersededReconnect()`, which is a one-shot consent that is consumed rather than becoming a standing policy.

A 4300 whose reason mentions `heartbeat` is *not* covered by the warning. Nothing is fighting over the identity, and it is our own reconnect racing itself, so it still reconnects on its own. `MG-AriesMod` makes the same distinction, and ships its supersession auto-reconnect disabled outright "at the request of the game developers".

### `PartialState` → `RoomFrame` (v756)

> "gone: PartialState"; "new: RoomFrame has: message.state?.patches. the data is the same, just a different name"

Handled: `extractPatches` accepts patches at the top level *or* under `state.patches`, and the bootstrapped attachment normalises both. Two comments here previously had the history **backwards**, calling `RoomFrame` the older of the two. That is the kind of error that leads someone to treat the current format as legacy, and it has been corrected.

### Anonymous room connections removed; official APIs instead (v1158 era)

> "anonymous websocket connections to rooms will no longer be supported. As a result, bots that determine current shop stock or weather data ... by connecting to the websocket are no longer permitted."

This is the authoritative explanation for the `4840` every guest probe returns: it is policy, not a wiring bug, and it is not going to be fixed by trying another encoding. The sanctioned replacement is `https://magicgarden.gg/platform/v1/{version,shops,weather}`, which needs no session and is already what `PlatformApiSource` uses. Note the framing: the announcement outlaws anonymous connections *for catalogue data*, so reaching for `GuestAuthProvider` to collect shop or weather data is the specific thing being prohibited. Details in [Sessions](sessions.md#sessions-how-a-headless-client-actually-authenticates).

### Other entries, and their impact

| Announcement | Impact here |
| --- | --- |
| `shopsAtom` removed; "in general, we consider atoms deprecated ... better to subscribe directly to the state tree" | **None**: the jotai bridge resolves atoms by *label suffix* (`.../activeModalStateAtom`) rather than by importing a named atom, so a removed atom simply stops matching. This is the design the announcement argues for. |
| `userSlots[*].position` no longer sent; movement moved outside the state tree to dedicated websocket messages | **None**: nothing reads a position from the state tree. `USER_SLOTS` is only a path constant, and it still resolves; it just no longer carries positions. |
| Spritesheets shipped as `.ktx2` rather than WebP (v114) | **None**: no spritesheet or atlas parsing happens here. Only mods that decode those files are affected. |
| "scale is no longer a thing" (v9.8) | **None**: `scale` appears only as Pixi's own `Container.scale`, which is a rendering primitive and unrelated. |
| React controls being ported to the engine (buttons, activity log, currency counters, profile drawer): "will certainly break mods that modify it" | **By design, none**: the bootstrapped client prefers protocol and state over DOM, so it does not target those React nodes. Mods that do will need to move. |
| `/platform/v1/shops` now includes items with `stock: 0` for open shops | **Already correct**: stock is carried through verbatim and never filtered, so a zero-stock offer is reported as a zero-stock offer rather than vanishing. |
| Weather moved onto `/platform/v1/shops` as a `weather` block with `current`/`upcoming`, where an upcoming slot may have `weatherId: null` | **Modelled.** `catalog.weather` is a `WeatherForecast` with a nullable `current` block plus an `upcoming` array. The shops block is read first because it is the only source with a forecast; the legacy `/platform/v1/weather` endpoint is the fallback, so a shops outage cannot cost you the current weather. An upcoming slot keeps its `null` `weatherId`/`name` and still reports its `groupId`, and `weatherAt()` resolves any instant to its slot with half-open windows so back-to-back slots cannot both match. See `weather.ts`. |

