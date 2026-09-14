# Sessions

## Sessions: how a headless client actually authenticates

A cold, session-less connection is closed with **`4840 SessionExpired`** before a single frame arrives.
The upgrade is accepted; the application layer rejects it. This section records why, because neither
source document explains it and it determines whether a headless client is viable at all.

**The session is a `Cookie: mc_jwt=<jwt>` header, and the only way the working clients obtain that cookie
is by driving a real browser through Discord OAuth.** Analysis of two working clients by the same author,
[`Ariedam64/mg-afk-android`](https://github.com/Ariedam64/mg-afk-android) (Kotlin/WebView) and
[`Ariedam64/MG-AFK`](https://github.com/Ariedam64/MG-AFK) (Electron), found this:

- **No headless endpoint exists.** No `/session`, `/auth`, `/join`, `/login`, `/token` or `/guest` in
  either repo. Both run a browser (Android `WebView`, Electron `BrowserWindow`), pre-set two cookies,
  navigate to the Discord authorise URL, and then **poll the cookie jar** for `mc_jwt` once the game's own
  JS finishes the code exchange with an async XHR.
- **Both hard-require the cookie** for the primary connection (`RoomClient.kt:225-227`,
  `index.js:117-119`).
- **The documented guest path is closed by policy, not by accident.** `scripts/probe-guest-encoding.ts`
  tests every permutation (raw JSON vs JSON-quoted, one field vs all six that Android sends, and the
  parameter omitted entirely, each with the full client-context parameter set), and all five are closed
  with `4840`. The game's own `modding-announcements` channel explains why:

  > "In the very near future ... anonymous websocket connections to rooms will no longer be supported. As a
  > result, bots that determine current shop stock or weather data ... by connecting to the websocket are no
  > longer permitted."

  The same announcement supplies the replacement: `https://magicgarden.gg/platform/v1/weather` and
  `/shops`. `@mg.js/common`'s catalogue layer already uses those endpoints (`PlatformApiSource`),
  with no session at all. There is nothing to repair here, and one thing to be deliberate about: the
  guest provider stays in `@mg.js/headless` because the parameter's shape is documented fact, but it is
  **not a sanctioned way to read game data**, and `GuestAuthProvider.authenticated` is `false` so a caller
  can see that for themselves. Use the catalogue layer for catalogue data.

So: **`probeSession()`** lets you check a token in one request, without a socket, so a bad token is
distinguishable from a protocol mistake:

```ts
import { probeSession } from '@mg.js/headless';

const result = await probeSession({ version: '1158', room: 'myroom', token: process.env.MC_JWT! });
// { valid: false, status: 401, outcome: 'unauthorized', reason: '…' }
```

It hits `GET /version/<v>/api/rooms/<room>/me`, which answers **401** for a dead session (verified live).
`buildDiscordOAuthUrl()` and `oauthBootstrapCookies()` supply the exact constants both reference clients
use, so a caller driving Playwright/Electron/WebView has them without rediscovering them. The
`authenticate-web` request that actually mints the cookie runs inside the game's own JS, and its path is
elided in the reference clients' comments; replicating it outside a browser would require reversing the
live bundle, so this package does not pretend to.

Two consequences worth stating plainly:

1. **`Cookie` is a request header on the WebSocket upgrade, and Node's built-in `WebSocket` cannot send
   request headers.** So the zero-dependency default cannot authenticate at all. `@mg.js/headless`
   therefore auto-selects a header-capable runtime for an authenticated provider, and
   `requireHeadersForAuth` now **defaults to `true`** so a silent credential downgrade fails loudly at
   connect time instead of surfacing as an unexplained `4840`.
2. **The bootstrapped client does not have this problem.** It rides the session the game page already
   established, which is a genuine argument for preferring it.
