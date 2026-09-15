# @mg.js/common

The shared protocol core of [magicgarden.js](https://github.com/QenuDev/MG.js): the wire contract for all 71
Magic Garden "Quinoa" wire actions, exposed as a 72-method typed surface. The 72nd is `fuseCrystal`, which
shares `PlaceCrystal`'s wire string rather than owning one. The package also holds the state engine, the
command sequencer and the domain catalogues.

It has zero runtime dependencies and is runtime-agnostic: it opens no socket and touches no DOM. It is the layer
[`@mg.js/headless`](https://www.npmjs.com/package/@mg.js/headless) and
[`@mg.js/bootstrapped`](https://www.npmjs.com/package/@mg.js/bootstrapped) are both built on, and it is useful
on its own for encoding commands or replaying state without connecting anything.

## Install

```bash
npm install @mg.js/common
```

## Entry points

| Subpath | Contains |
|---|---|
| `@mg.js/common` | everything below, re-exported |
| `@mg.js/common/protocol` | envelopes, codec, connect URL, close codes, id generation |
| `@mg.js/common/actions` | the action registry, param types, command handles, sequencer, result codes |
| `@mg.js/common/state` | JSON Pointer, RFC 6902 applier, observable store, typed paths |
| `@mg.js/common/catalog` | catalogue sources (static, platform, remote JSON) and the live-fetching client |
| `@mg.js/common/transport` | the transport seam both clients implement |

## Example

```ts
import { CatalogClient, PlatformApiSource, RemoteJsonSource } from '@mg.js/common';

const catalog = new CatalogClient({
  sources: [
    new PlatformApiSource(),                                      // live version + shops + weather
    new RemoteJsonSource({ baseUrl: 'http://localhost:8080' }),    // entities from any /data mirror
  ],
});

const { version, shops, plants, missing } = await catalog.load();
```

## Documentation

The protocol and the decisions behind it are documented in the
[repository](https://github.com/QenuDev/MG.js/tree/main/docs): `protocol.md`, `attachment.md`, `sessions.md`,
`close-codes.md`, `announcements.md` and `DESIGN.md`, which is the standard the codebase is written to.

Nothing here is official, and a game update can change any of it.

## License

MIT
