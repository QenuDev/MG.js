# @mg.js/bootstrapped

The in-page Magic Garden client from [magicgarden.js](https://github.com/QenuDev/MG.js), as a library. It
attaches to the game's own live Quinoa connection, which it never opens, and adds Pixi, Rive, world overlays
and coexistence handling so several mods can share the page.

Use this to build a userscript mod. For a client that owns its connection, use
[`@mg.js/headless`](https://www.npmjs.com/package/@mg.js/headless).

## Install

```bash
npm install @mg.js/bootstrapped
```

## What this package is not

It is the client and nothing else. It defines, exports and calls nothing on import, so
`import { BootstrappedClient } from '@mg.js/bootstrapped'` has no side effects.

**The example userscript is a separate repository**
([`MG.js-bootstrapped-example`](https://github.com/QenuDev/MG.js-bootstrapped-example)). Starting a client,
publishing the page namespace and rendering a status badge are an *application* of this library, and they live
there, along with the Tampermonkey banner, the bundle and its size budget. The split is what keeps this package a
library: a package that ships its own bundler ends up with its tests, CI and size gate measuring the application.

## Example

```ts
import { BootstrappedClient } from '@mg.js/bootstrapped';

// If another mod already started one, grab the live client; otherwise start your own.
const client = new BootstrappedClient();
await client.start();   // idempotent, cross-realm safe
await client.waitForAttachment();

client.store.subscribe('/child/data/userSlots/0/data/activityLogs', (change) => {
  // the ability/event log: diff the array and read parameters.pet for who triggered it
});

// Pixi constructors, recovered from the live stage
const { Container, Graphics, Text, Sprite, Texture, Rectangle } = await client.render.getCtors();
```

From the devtools console, `window.__mgjs` is the namespace shared by every load of this package, and the live
client is published inside it as `window.__mgjs.globals.client`. The key belongs to the namespace, so a
second copy of the bundle reuses it rather than replacing it, and writing anything else there makes the next
load refuse to attach at all.

## Known limitations

- **No documented way to obtain a live `RiveArtboard`.** The operations are exposed; acquiring a live instance
  depends on the current game build and is feature-detected.
- **The `flat`/`wrapped` split is mid-migration.** `FormRegistry.setActionForm` is the escape hatch.
- **Nothing here is official**, and a game update can change any of it.

## Documentation

The attachment model is documented in the
[repository](https://github.com/QenuDev/MG.js/blob/main/docs/attachment.md): the socket now, the room object
when it appears, and the renumbering seam.

## License

MIT
