/**
 * `@mg.js/bootstrapped`: the in-page / userscript Magic Garden client.
 *
 * ## What it is
 *
 * The counterpart to a headless client, and the library a Tampermonkey userscript is built from. The headless
 * client opens its own socket; this one **attaches** to the one the game already has and observes it without
 * consuming it. Atop that it adds the three things a page-only client can have and a headless one cannot:
 *
 *   - a **render layer** (`PixiStage`, `RiveArtboard`, `WorldScene`) that draws into the game's own canvas;
 *   - a **jotai bridge** that writes the game's React state exactly as its own UI buttons do;
 *   - **coexistence** machinery: branded, identity-guarded hooks and renumber-on-send, so several mods can
 *     share one socket without the sequence desync that otherwise presents to the player as a frozen game.
 *
 * ## What is not here
 *
 * No application. `import { BootstrappedClient } from '@mg.js/bootstrapped'` resolves to `dist/index.js` with
 * declarations from `tsc`, and that is the whole package: it defines and exports, and calls nothing. Starting
 * a client, publishing the page namespace and rendering a status badge are an *application* of this library,
 * and they live in the example userscript's own repository, which consumes this one through that entry point.
 * The bundle, its Tampermonkey banner and its size budget went with them, because a library that ships a
 * bundler ends up with its own tests, CI and size gate measuring the application instead of the library.
 *
 * Everything under `src/` is written so it can be imported in Node without a DOM: there is no top-level
 * `window`, `document` or `unsafeWindow` access anywhere. Every read of the page goes through
 * {@link getPage}, which also re-exports here.
 *
 * ## Where to start
 *
 * {@link BootstrappedClient} wires the whole thing up:
 *
 * ```ts
 * const client = new BootstrappedClient();
 * await client.start();
 * await client.waitForAttachment();
 * const ctors = await client.render.stage.getCtors();
 * ```
 *
 * ## Exports are grouped by audience
 *
 * The protocol types themselves (actions, store, wire contract, catalogues) belong to `@mg.js/common` and are
 * *not* re-exported wholesale here. What is re-exported is this package's own surface: the
 * attachment internals for an advanced mod, and the render/coexistence primitives for a mod that wants to use
 * them without taking the whole client.
 */

// --------------------------------------------------------------------------------------
// The client
// --------------------------------------------------------------------------------------

export type {
  BootstrappedClientOptions,
  BootstrappedFeatures,
  BootstrappedReport,
  BootstrapReport,
  RenderFacade,
} from './client.js';
export {
  applyRenumberingToString,
  asEnvelope,
  BootstrappedClient,
  parseEnvelope,
  readWelcomeFrontier,
} from './client.js';

// --------------------------------------------------------------------------------------
// Realm bridge
// --------------------------------------------------------------------------------------

export * from './page/index.js';

// --------------------------------------------------------------------------------------
// Attachment
// --------------------------------------------------------------------------------------

export * from './attach/index.js';

// --------------------------------------------------------------------------------------
// Coexistence
// --------------------------------------------------------------------------------------

export * from './coexistence/index.js';

// --------------------------------------------------------------------------------------
// Render
// --------------------------------------------------------------------------------------

export * from './render/index.js';

// --------------------------------------------------------------------------------------
// jotai
// --------------------------------------------------------------------------------------

export * from './jotai/index.js';

// --------------------------------------------------------------------------------------
// Catalogue and storage
// --------------------------------------------------------------------------------------

export * from './live-catalog/index.js';
export * from './storage/index.js';
