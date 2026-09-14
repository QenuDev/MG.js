/**
 * The realm bridge.
 *
 * ## The problem
 *
 * A Tampermonkey userscript with `@grant unsafeWindow` runs in a sandbox whose `window` is *not* the
 * page's `window`. The game's globals (`MagicCircle_RoomConnection`, `__PIXI_APP_INIT__`,
 * `WebSocket`) live on the page's realm. Patching the sandbox's `WebSocket` would patch nothing the
 * game uses, and reading `sandbox.MagicCircle_RoomConnection` would always be `undefined`. Every
 * single access to the host environment in this package therefore goes through {@link getPage}, which
 * resolves `unsafeWindow ?? window`, the idiom the companion mod uses (recon
 * `recon-companion-patterns.md`, the `@grant unsafeWindow` + `@run-at document-start` section).
 *
 * `unsafeWindow` is preferred over `window` and not the other way round: when the grant is present,
 * `window` is the sandbox and `unsafeWindow` is the page. When the grant is absent (a plain `<script>`
 * tag, a test, a different userscript manager that ignores the metadata), `unsafeWindow` is not
 * merely undefined; bare references to it *throw* in strict mode contexts, so it is read through a
 * `typeof` guard rather than being named directly.
 *
 * ## Why one `__mgjs` namespace and not ~40 loose globals
 *
 * The companion mod's approach is noted in the recon as a wart: it publishes each of its cooperating
 * values as its own page global, so the page's global object accumulates a flat, unversioned,
 * collision-prone set of names that no single consumer can enumerate and no uninstall can clean up.
 * This package instead puts one property on the page (`__mgjs`) and keeps everything else
 * inside it. That survives two copies of the script coexisting, makes teardown a single delete at the
 * end, and means a future version can migrate the namespace in one place.
 *
 * ## Why the registry is cross-realm rather than module-scoped
 *
 * Two things can load this bundle into the same page: the userscript itself on both
 * `https://magicgarden.gg/*` and an iframe, and a mod that `import`s the library while the userscript
 * is also installed. Each load gets its own module instance, so a module-scoped `let installed = false`
 * would be false in both and both would install their hooks: double-wrapping `WebSocket`, double
 * renumbering `QuinoaCommand` envelopes, double-rendering overlays. The registry therefore lives on
 * the *page*, keyed by {@link NAMESPACE_KEY}, which is the only storage two independent loads actually
 * share.
 *
 * ## Nothing here runs at module load
 *
 * This file must be importable in Node (tests do it) with no `window` in scope. Every access to the
 * page happens inside a function body; there is no top-level `window` or `unsafeWindow` reference.
 */

import { installedOverride } from './override.js';

/**
 * The page realm, or `null` when there is no page at all (Node, a worker, a test).
 *
 * Returned as `unknown`-ish rather than `Window` on purpose: the page's globals are untyped game
 * internals, and every consumer in this package has to feature-detect them anyway. Declaring a rich
 * type here would create the illusion that `MagicCircle_RoomConnection` exists, which is the
 * assumption the recon says breaks between builds.
 */
export type PageRealm = Record<string, unknown>;

/**
 * Read a bare `unsafeWindow` reference without throwing.
 *
 * `unsafeWindow` is not declared in the DOM lib and not declared by `@types/tampermonkey` as a
 * global either (it is granted, not ambient), so it is reached through the global object rather than
 * named. `typeof unsafeWindow` would itself be a bare reference in some bundler outputs; reading the
 * property is always safe.
 */
function readUnsafeWindow(): PageRealm | null {
  const globalObject = globalThis as Record<string, unknown>;
  const candidate = globalObject['unsafeWindow'];
  if (candidate !== null && (typeof candidate === 'object' || typeof candidate === 'function')) {
    return candidate as PageRealm;
  }
  return null;
}

/**
 * The page realm.
 *
 * Resolution order, and why:
 *  1. an explicit test override, if one was installed;
 *  2. `unsafeWindow`, the real page when the grant is present;
 *  3. `globalThis` when it looks like a DOM window (`document` present): the plain `<script>` case
 *     and jsdom;
 *  4. otherwise `null`.
 *
 * Returning `null` rather than throwing is deliberate: everything in this package must be *importable*
 * anywhere, and several accessors (`realm.hasPage()`, `storage`'s fallback selection) are meaningful
 * answers even when there is no page. Callers that need a page use {@link requirePage}.
 *
 * NOTE: `globalThis` is returned rather than `window` because in the sandbox-without-grant case
 * `globalThis === window === the sandbox`, and returning `globalThis` keeps this function identical
 * under Node and under a browser.
 */
export function getPage(): PageRealm | null {
  const override = installedOverride();
  if (override !== null) return override.page;
  const unsafe = readUnsafeWindow();
  if (unsafe !== null) return unsafe;
  const globalObject = globalThis as Record<string, unknown>;
  const documentValue = globalObject['document'];
  if (documentValue !== null && typeof documentValue === 'object') return globalObject;
  return null;
}

/** True when a page realm is available. Never throws. */
export function hasPage(): boolean {
  return getPage() !== null;
}

/**
 * The page realm, or a throw.
 *
 * For call sites where proceeding without a page is a programming error rather than a runtime
 * condition, such as installing hooks.
 */
export function requirePage(): PageRealm {
  const page = getPage();
  if (page === null) {
    throw new Error(
      'mg.js: no page realm is available (no unsafeWindow, no window, no document). ' +
        'This client only runs inside the game page.',
    );
  }
  return page;
}
