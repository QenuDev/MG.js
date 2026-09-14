# magicgarden.js

An all-purpose API wrapper for **Magic Garden**'s "Quinoa" layer, in two shapes over one shared core:

| Package | What it is | Owns a socket? | Has a renderer? |
|---|---|---|---|
| **`@mg.js/common`** | The shared core. Wire contract for all 71 wire actions, exposed as a 72-method typed surface. The 72nd method is `fuseCrystal`, which shares `PlaceCrystal`'s wire string rather than owning one. The package also carries the state engine, sequencer and catalogues. Zero dependencies, runtime-agnostic. | no | no |
| **`@mg.js/bootstrapped`** | The in-page client, as a library. Attaches to the game's own live connection and adds Pixi, Rive, world overlays and coexistence handling. The example userscript is built on it, in its own repository. | no, it rides the host's | yes |
| **`@mg.js/headless`** | The standalone client. Opens its own WebSocket, authenticates, handshakes, stays alive, reconnects. | yes | no |

The split is deliberate: the bootstrapped client rides a connection it does not own and must cooperate with other mods, while the headless client owns its connection and has nothing to cooperate with. Everything they share lives in `common`, so no protocol logic is written twice.

---

## Install

```bash
npm install @mg.js/common          # the shared core, zero runtime dependencies
npm install @mg.js/headless        # the standalone client
npm install @mg.js/bootstrapped    # the in-page client, as a library
```

---

## Documentation

The README is the front door. The depth lives in `docs/`:

- **[`docs/protocol.md`](docs/protocol.md)**: the three outbound forms, sequence integrity, ack correlation, and the design decisions around them.
- **[`docs/attachment.md`](docs/attachment.md)**: the socket now, the room object when it appears, and the renumbering seam.
- **[`docs/sessions.md`](docs/sessions.md)**: how a headless client authenticates (`mc_jwt`, Discord OAuth, why guests get `4840`).
- **[`docs/close-codes.md`](docs/close-codes.md)**: the 18-code table and where it beats the documentation.
- **[`docs/announcements.md`](docs/announcements.md)**: the developer announcements this library encodes.
- **[`docs/verification.md`](docs/verification.md)**: the dated evidence ledger: what `npm run verify` checks, and the recorded results behind each green run.
- **[`docs/provenance.md`](docs/provenance.md)**: where the protocol came from, and the SHA-256 of the two vendored source documents.
- **[`docs/DESIGN.md`](docs/DESIGN.md)**: the standard this repository is written to; [`docs/plans/`](docs/plans/) and [`docs/audit/`](docs/audit/) are the plans and the evidence behind it.

---

## Quick start

### Headless

Two entry points, both delegating to the same client: `RoomSocket` is the class the API reference
specifies for a standalone client, and `HeadlessClient` is the richer one the rest of these docs use.

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
  // version is discovered from /platform/v1/version, which cures the 4710/4700 loop
});

client.on('ready', () => {
  void client.actions.checkWeatherStatus();
});

await client.start();
await client.waitUntilReady();

console.log(client.selfPlayerId, client.store.get('/data/players/0/coins'));
```

### Bootstrapped (library)

`@mg.js/bootstrapped` is the in-page client and nothing else. It defines and exports and calls nothing, so
`import { BootstrappedClient } from '@mg.js/bootstrapped'` has no side effects.

**The userscript is a separate repository.** Starting a client, publishing the page namespace and rendering a
status badge are an *application* of this library, and they live in `bootstrapped-example`, which consumes this
package through that entry point and builds `magicgarden.user.js` itself. That repository owns the Tampermonkey
banner, the bundle and its size budget. The split is what keeps this package a library: a package that ships its
own bundler ends up with its tests, CI and size gate measuring the application.

The example's bundle installs itself on load. It attaches to the game's connection, logs a startup line, and
renders a small shadow-isolated status badge showing the attachment path, readiness, player id and patch counts.

**There is no automatic update path yet, by design.** *This* repository does not build or
distribute a userscript: it publishes three packages, and that is all it ships. The bundle, the Tampermonkey
banner and the release asset all belong to `bootstrapped-example`, so the banner's `@downloadURL` and
`@updateURL` name *that* repository's release asset and resolve to nothing until it has a release.

The banner's `@namespace` is `https://github.com/QenuDev/MG.js`, and that one names the
magicgarden.js project rather than the repository that happens to build this script. Tampermonkey treats the
namespace as the script's update identity, so it is the single value that must not change after the first
install, because a change there detaches every existing install from its updates.

Building a mod on top of it:

```ts
import { BootstrappedClient } from '@mg.js/bootstrapped';

// If the example userscript already started one, grab the live client; otherwise start your own.
const client = new BootstrappedClient();
await client.start();   // idempotent, cross-realm safe
await client.waitForAttachment();

client.store.subscribe('/child/data/userSlots/0/data/activityLogs', (change) => {
  // the ability/event log: diff the array and read parameters.pet for who triggered it
});

// Pixi constructors, recovered from the live stage
const { Container, Graphics, Text, Sprite, Texture, Rectangle } = await client.render.getCtors();
```

From the devtools console, `window.__mgjs` is the namespace shared by every load of this package, and the
live client is published inside it: `window.__mgjs.globals.client`. The key belongs to the namespace: a
second copy of the bundle reuses it rather than replacing it, and writing anything else there makes the next
load refuse to attach at all.

### Catalogue

```ts
import { CatalogClient, PlatformApiSource, RemoteJsonSource } from '@mg.js/common';

const catalog = new CatalogClient({
  sources: [
    new PlatformApiSource(),                            // live version + shops + weather
    new RemoteJsonSource({ baseUrl: 'http://localhost:8080' }),  // entities from any /data mirror
  ],
});

const { version, shops, plants, missing } = await catalog.load();
```

---

## Known limitations

These are real and documented rather than papered over:

- **A headless connection needs an `mc_jwt` cookie, and there is no headless way to obtain one.** This is the single biggest practical limitation, so it gets the detail it deserves. See [Sessions](docs/sessions.md).
- **No inbound event exists for chat, emotes, or player join/leave.** The field guide documents exactly five inbound message types. A wrapper cannot surface those events because the protocol does not describe them; chat state is only observable through the room state patches.
- **No `requestId` on the documented result payload**, so exact ack correlation is not always possible. This is why `confirmed` exists and why the default mode reports `false`.
- **Node's global `WebSocket` cannot send request headers.** `new WebSocket(url, [], {headers})` is accepted but silently ignored, so a server sees no `Origin`, no custom `User-Agent`, no `Cookie`. The documented `Cookie: mc_jwt` and `Origin` paths are therefore unreachable through the zero-dependency default. `@mg.js/headless` mitigates this with an injectable `webSocketFactory`, an opt-in `ws` adapter, a `headers-dropped` event (names only, never values) and a `requireHeadersForAuth` hard-fail, and logs which runtime it got.
- **`anonymousUserStyle`'s exact wire encoding is undocumented.** The choice made here is a JSON object run through the connect URL's JSON-quoting, which keeps §1.3's "every value is JSON-encoded" rule exceptionless; `encode: 'raw'` is available if a build ever wants the unquoted form.
- **No documented way to obtain a live `RiveArtboard`.** `@mg.js/bootstrapped` exposes the operations; acquiring a live instance depends on the current build and is feature-detected.
- **The `flat`/`wrapped` split is mid-migration.** `FormRegistry.setActionForm` is the escape hatch.
- **Rate limits and cooldowns are unspecified.** The docs name `rate_limited` and `no_slot` codes but give no numbers, so the wrapper reports them and does not invent a governor.
- **Nothing here is official** and a client update can change any of it.

---

## Layout

```
mg.js/
  packages/common/        @mg.js/common
    src/protocol/         the wire: envelopes, codec, connect URL, close codes, ids
    src/actions/          the commands we send: the action registry (71 wire actions → 72 methods),
                          param types, command handles, sequencer, result codes
    src/state/            JSON Pointer, RFC 6902 applier, observable store, typed paths
    src/catalog/          the catalogue sources (static, platform, remote JSON) + live-fetching client
    src/transport/        the seam both clients implement
  packages/bootstrapped/  @mg.js/bootstrapped
  packages/headless/      @mg.js/headless
  scripts/                verify-catalog.ts, verify-socket.ts, probe-guest-encoding.ts
  docs/                   DESIGN.md (the standard), protocol.md, attachment.md, sessions.md,
                          close-codes.md, announcements.md, verification.md, provenance.md,
                          sources/ (the vendored protocol documents), plans/, audit/ (the evidence)
```
