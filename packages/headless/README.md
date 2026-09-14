# @mg.js/headless

The standalone Magic Garden client from [magicgarden.js](https://github.com/QenuDev/MG.js). It owns its own
WebSocket: it authenticates, handshakes, stays alive, reconnects, and exposes the full
[`@mg.js/common`](https://www.npmjs.com/package/@mg.js/common) action and state surface.

Use this when you want a client that owns its connection. To ride the live game's own connection from inside the
page instead, use [`@mg.js/bootstrapped`](https://www.npmjs.com/package/@mg.js/bootstrapped).

## Install

```bash
npm install @mg.js/headless
```

`ws` is declared as both an optional dependency and an optional peer dependency. It exists because Node's
global `WebSocket` cannot do one thing the game needs: send request headers. The game's own documented
`Cookie: mc_jwt` and `Origin` paths need them. `new WebSocket(url, [], { headers })` is accepted and
silently ignored, so the package exposes an injectable `webSocketFactory` and an opt-in `ws` adapter, emits
a `headers-dropped` event (names only, never values), and logs which runtime it got.

## Entry points

| Subpath | Contains |
|---|---|
| `@mg.js/headless` | the clients, the auth providers and the session probe |
| `@mg.js/headless/transport` | the socket transport and its attempt-URL builder |
| `@mg.js/headless/auth` | `CookieAuthProvider` and the credential handling around it |

## Example

Two entry points, both delegating to the same client: `RoomSocket` is the class the API reference specifies for
a standalone client, and `HeadlessClient` is the richer one the repository docs use.

```ts
import { RoomSocket, CookieAuthProvider } from '@mg.js/headless';

// The documented API-reference shape: start(options) -> the URL that was opened.
const socket = new RoomSocket({ auth: new CookieAuthProvider(process.env.MC_JWT!) });
socket.onWelcome((msg) => console.log('playerId:', msg.selfPlayerId));
await socket.start({ room: 'abcde12345' });
await socket.waitUntilReady();
await socket.actions.harvestCrop({ slot: 3 });
```

```ts
import { HeadlessClient, CookieAuthProvider } from '@mg.js/headless';

const client = new HeadlessClient({
  auth: new CookieAuthProvider(process.env.MC_JWT!),
  // version is discovered from /platform/v1/version, so the 4710/4700 loop cannot start
});

client.on('ready', () => {
  void client.actions.checkWeatherStatus();
});

await client.start();
await client.waitUntilReady();

console.log(client.selfPlayerId, client.store.get('/data/players/0/coins'));
```

## Known limitations

- **A headless connection needs an `mc_jwt` cookie, and there is no headless way to obtain one.** See
  [`docs/sessions.md`](https://github.com/QenuDev/MG.js/blob/main/docs/sessions.md) for how the cookie is
  obtained and why guests get `4840`.
- **Node's global `WebSocket` cannot send request headers**, as described above.
- **No inbound event exists for chat, emotes, or player join/leave**: the protocol documents five inbound
  message types and a wrapper cannot surface events it cannot observe.
- **Nothing here is official**, and a client update can change any of it.

## License

MIT
