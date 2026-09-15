/**
 * The folder barrels, and the rule that no module imports one.
 *
 * ## Why this is the guard for Task 5.6
 *
 * `bootstrapped` had no folder barrel at all: the 368-line root `index.ts` reached into 19 member files
 * by full path. Adding barrels is a mechanical rewrite of that file, and the failure it invites is a barrel
 * that re-exports one name too few, which no type error catches, because nothing inside the package
 * imports the barrel it just built.
 *
 * Every set below is a **measurement** of the pre-move tree, not a wish:
 *
 *   - the folder barrels are pinned to the names the root barrel took from that folder, so a barrel may
 *     export neither less (a lost public name) nor more (a widened surface nobody asked for);
 *   - `page` and `storage` are pinned to what the bare `realm.ts` and `storage.ts` exported;
 *   - the root surface is pinned to the package's whole runtime export set.
 *
 * ## Why there are two halves
 *
 * Values are checked by importing the barrel; types are erased at runtime and so are checked against the
 * barrel's own `export type { ... } from` blocks. A runtime-only snapshot cannot see a dropped type (it is
 * absent from `Object.keys` by construction), and a source-only snapshot cannot see a value that is
 * re-exported yet elided by the bundler.
 *
 * A stale set is the only benign failure, and it is still a finding: a later task that changes the surface
 * must update the set **in that same commit**.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '../src');

/** What each folder barrel must export, split by kind. Measured before the move. */
const FOLDER_BARRELS: Record<string, { values: readonly string[]; types: readonly string[] }> = {
  attach: {
    values: [
      'AttachedTransport',
      'DEFAULT_ROOM_URL_FILTER',
      'ROOM_CONNECTION_KEY',
      'WEBSOCKET_KEY',
      'bindRawSocket',
      'bindRoomConnection',
      'createEmptySink',
      'createRoomConnectionSink',
      'describeRoomConnection',
      'detectAttachment',
      'hasRoomConnection',
      'installOutboundRewriter',
      'isRoomConnectionUsable',
      'normaliseRoomFrame',
      'readRoomConnection',
      'resolveOpenConstant',
      'scrapeFrame',
      'serialiseFrame',
      'waitForAttachment',
      'watchForRoomConnection',
    ],
    types: [
      'AttachKind',
      'AttachedSink',
      'AttachedTransportOptions',
      'Attachment',
      'AttachmentKind',
      'AttachmentReport',
      'BindRawSocketOptions',
      'BindRoomConnectionOptions',
      'DetectAttachmentOptions',
      'RawSocketBinding',
      'RoomConnectionBinding',
      'RoomConnectionLike',
      'RoomFrameEvent',
      'ScrapeResult',
      'SendAttempt',
      'SocketLike',
      'WatchForRoomConnectionOptions',
      'WebSocketLike',
      'WelcomeEvent',
    ],
  },
  coexistence: {
    values: [
      'MARKER_KEY',
      'MARKER_LABEL_KEY',
      'MAX_REMEMBERED_IDS',
      'Renumberer',
      'applyRenumbering',
      'asCommandEnvelope',
      'attemptTeardown',
      'brandLabelOf',
      'brandWrapper',
      'classifySlot',
      'installHook',
      'installRenumberHook',
      'isBranded',
      'restoreSlot',
    ],
    types: [
      'Branded',
      'CommandEnvelope',
      'InstallHookOptions',
      'InstallOutcome',
      'InstallRenumberHookOptions',
      'InstalledHook',
      'ObserveResult',
      'PreviousFn',
      'RenumberHookHandle',
      'RenumberHookReason',
      'RenumberStats',
      'RenumbererOptions',
      'RewriteResult',
      'SendSlot',
      'SlotClass',
    ],
  },
  jotai: {
    values: [
      'ATOM_CACHE_KEY',
      'JotaiBridge',
      'createLookup',
      'getCapturedSet',
      'hasCapturedSet',
      'installJotaiBridge',
      'labelMatches',
      'resetJotaiCapture',
      'restoreWrappedWrites',
      'writeAtom',
    ],
    types: [
      'AtomCacheLike',
      'AtomVisitor',
      'JotaiAtom',
      'JotaiBridgeHandle',
      'JotaiBridgeOptions',
      'JotaiLookup',
      'JotaiSet',
      'WriteFailureReason',
      'WriteResult',
    ],
  },
  'live-catalog': {
    values: [
      'BUNDLE_SOURCE_ID',
      'BUNDLE_SUPPORTED_KINDS',
      'DEFAULT_CAPTURE_WINDOW_MS',
      'asEntryList',
      'captureCatalogBundle',
      'createBundleSource',
      'resolvePageObject',
      'scoreTableForKind',
      'snapshotTables',
    ],
    types: ['BundleCapture', 'BundleCaptureHandle', 'BundleCaptureOptions'],
  },
  render: {
    values: [
      'Badge',
      'DEFAULT_FIND_LIMIT',
      'DEFAULT_TEXTURE_CACHE_ENTRIES',
      'DEFAULT_TEXT_STYLE',
      'PixiCtorsTimeoutError',
      'PixiStage',
      'RiveArtboard',
      'RiveRegistry',
      'UNRECOVERED_CONSTRUCTORS',
      'WorldScene',
      'activeCinematicClaims',
      'asFiniteNumber',
      'asGraphics',
      'capture',
      'collectTileViews',
      'createBadge',
      'createBadgeSync',
      'createSprite',
      'createSpriteSync',
      'createText',
      'createTextOver',
      'createTextSync',
      'createTextureCache',
      'deriveCtors',
      'destroyText',
      'detach',
      'findAllNodes',
      'findByLabel',
      'findNode',
      'findRenderLayerCtor',
      'getApplication',
      'getCtors',
      'getGraphicsCtor',
      'getRenderer',
      'getStageRoot',
      'hasCoreCtorSet',
      'hasFullCtorSet',
      'isArtboardLike',
      'isContainerLike',
      'isGraphicsLike',
      'isRiveLike',
      'isSpriteLike',
      'isTextLike',
      'isUnrecoveredStub',
      'loadImageSource',
      'readGeometry',
      'recordAndSet',
      'recordAndWrapNoop',
      'requireRenderPage',
      'resetCinematicClaims',
      'resetCtorCache',
      'resetRiveWarnings',
      'resetWarnOnce',
      'resetWorldWarnings',
      'setApplication',
      'setRenderer',
      'setStageRoot',
      'sharedArtboards',
      'sharedTextures',
      'textureFrom',
      'tryGetCtors',
      'updateText',
      'wrapArtboard',
    ],
    types: [
      'BadgeColour',
      'BadgeStyle',
      'CachedTexture',
      'CinematicClaimHooks',
      'CreateBadgeOptions',
      'CreateTextOptions',
      'GetCtorsOptions',
      'PixiApplicationLike',
      'PixiCaptureEvent',
      'PixiCaptureHandle',
      'PixiCaptureListener',
      'PixiCaptureOptions',
      'PixiCtorSet',
      'PixiDisplayObject',
      'PixiGraphics',
      'PixiRectangle',
      'PixiRendererLike',
      'PixiText',
      'PixiTextStyle',
      'PixiTexture',
      'RecoveredCtors',
      'RiveArtboardLike',
      'RiveArtboardOptions',
      'RiveFailure',
      'SpriteOptions',
      'TextureCache',
      'TextureFromOptions',
      'TextureSource',
      'WorldGeometry',
      'WorldSceneConfig',
      'WorldSceneOptions',
    ],
  },
};

/** The package's public runtime surface, which no structure change may alter. */
const ROOT_SURFACE: readonly string[] = [
  'ATOM_CACHE_KEY',
  'AttachedTransport',
  'BUNDLE_SOURCE_ID',
  'BUNDLE_SUPPORTED_KINDS',
  'BUNDLE_VERSION',
  'Badge',
  'BootstrappedClient',
  'DEFAULT_CAPTURE_WINDOW_MS',
  'DEFAULT_FIND_LIMIT',
  'DEFAULT_KEY_PREFIX',
  'DEFAULT_ROOM_URL_FILTER',
  'DEFAULT_TEXTURE_CACHE_ENTRIES',
  'DEFAULT_TEXT_STYLE',
  'JotaiBridge',
  'MARKER_KEY',
  'MARKER_LABEL_KEY',
  'MAX_REMEMBERED_IDS',
  'NAMESPACE_KEY',
  'PixiCtorsTimeoutError',
  'PixiStage',
  'ROOM_CONNECTION_KEY',
  'Renumberer',
  'RiveArtboard',
  'RiveRegistry',
  'UNRECOVERED_CONSTRUCTORS',
  'WEBSOCKET_KEY',
  'WorldScene',
  'activeCinematicClaims',
  'applyRenumbering',
  'applyRenumberingToString',
  'asCommandEnvelope',
  'asEntryList',
  'asEnvelope',
  'asFiniteNumber',
  'asGraphics',
  'attemptTeardown',
  'bindRawSocket',
  'bindRoomConnection',
  'brandLabelOf',
  'brandWrapper',
  'capture',
  'captureCatalogBundle',
  'claimInstall',
  'classifySlot',
  'collectTileViews',
  'createBadge',
  'createBadgeSync',
  'createBundleSource',
  'createEmptySink',
  'createLookup',
  'createRoomConnectionSink',
  'createSprite',
  'createSpriteSync',
  'createStorage',
  'createText',
  'createTextOver',
  'createTextSync',
  'createTextureCache',
  'defineGlobal',
  'deleteNamespace',
  'deriveCtors',
  'describeRoomConnection',
  'destroyText',
  'detach',
  'detectAttachment',
  'emitNamespaceEvent',
  'findAllNodes',
  'findByLabel',
  'findNode',
  'findRenderLayerCtor',
  'getApplication',
  'getCapturedSet',
  'getCtors',
  'getGraphicsCtor',
  'getNamespace',
  'getPage',
  'getRenderer',
  'getStageRoot',
  'hasCapturedSet',
  'hasCoreCtorSet',
  'hasFullCtorSet',
  'hasPage',
  'hasRoomConnection',
  'installHook',
  'installJotaiBridge',
  'installOutboundRewriter',
  'installRealmOverride',
  'installRenumberHook',
  'isArtboardLike',
  'isBranded',
  'isContainerLike',
  'isGraphicsLike',
  'isRiveLike',
  'isRoomConnectionUsable',
  'isSpriteLike',
  'isTextLike',
  'isUnrecoveredStub',
  'labelMatches',
  'loadImageSource',
  'normaliseRoomFrame',
  'onNamespaceEvent',
  'onTeardown',
  'parseEnvelope',
  'peekNamespace',
  'probeStorage',
  'readGeometry',
  'readGlobal',
  'readRoomConnection',
  'readWelcomeFrontier',
  'recordAndSet',
  'recordAndWrapNoop',
  'releaseInstall',
  'requirePage',
  'requireRenderPage',
  'resetCinematicClaims',
  'resetCtorCache',
  'resetJotaiCapture',
  'resetRiveWarnings',
  'resetWarnOnce',
  'resetWorldWarnings',
  'resolveGreasemonkeyApi',
  'resolveOpenConstant',
  'resolvePageObject',
  'restoreSlot',
  'restoreWrappedWrites',
  'scoreTableForKind',
  'scrapeFrame',
  'selectBackend',
  'serialiseFrame',
  'setApplication',
  'setRenderer',
  'setStageRoot',
  'sharedArtboards',
  'sharedTextures',
  'snapshotTables',
  'textureFrom',
  'tryGetCtors',
  'undefineGlobal',
  'updateText',
  'waitForAttachment',
  'watchForRoomConnection',
  'wrapArtboard',
  'writeAtom',
];

/** What `page/index.ts` must export: the runtime surface of the `realm.ts` it replaces (5.6b). */
const PAGE_BARREL: readonly string[] = [
  'BUNDLE_VERSION',
  'NAMESPACE_KEY',
  'claimInstall',
  'defineGlobal',
  'deleteNamespace',
  'emitNamespaceEvent',
  'getNamespace',
  'getPage',
  'hasPage',
  'installRealmOverride',
  'onNamespaceEvent',
  'onTeardown',
  'peekNamespace',
  'readGlobal',
  'releaseInstall',
  'requirePage',
  'undefineGlobal',
];

/**
 * What `client.ts` must export to its consumers.
 *
 * `client.ts` is not a barrel, but it is the *other* thing a split can quietly break: Task 5.7e moves its
 * diagnostic and facade code into `diagnostics.ts` and `render/facade.ts`, and the four re-exports at the
 * bottom of the file have importers in `src/index.ts` and four test files. Nothing else in this suite would
 * notice a dropped name here. The root-surface case below reads `src/index.ts`, which *re-exports* these
 * names, so a name missing from both places at once takes two failures to spot, and the type re-exports
 * have no runtime evidence at all. Hence a case pinned directly against the module.
 */
const CLIENT_SURFACE: readonly string[] = [
  'BootstrappedClient',
  'applyRenumberingToString',
  'asEnvelope',
  'parseEnvelope',
  'readWelcomeFrontier',
];

/** What `storage/index.ts` must export: the runtime surface of the `storage.ts` it replaces (5.6c). */
const STORAGE_BARREL: readonly string[] = [
  'DEFAULT_KEY_PREFIX',
  'createStorage',
  'probeStorage',
  'resolveGreasemonkeyApi',
  'selectBackend',
];

const RUNTIME_BARRELS: readonly {
  readonly name: string;
  readonly expected: readonly string[];
  readonly load: () => Promise<object>;
}[] = [
  {
    name: 'attach',
    expected: FOLDER_BARRELS.attach?.values ?? [],
    load: () => import('../src/attach/index.js'),
  },
  {
    name: 'coexistence',
    expected: FOLDER_BARRELS.coexistence?.values ?? [],
    load: () => import('../src/coexistence/index.js'),
  },
  {
    name: 'jotai',
    expected: FOLDER_BARRELS.jotai?.values ?? [],
    load: () => import('../src/jotai/index.js'),
  },
  {
    name: 'render',
    expected: FOLDER_BARRELS.render?.values ?? [],
    load: () => import('../src/render/index.js'),
  },
  {
    name: 'live-catalog',
    expected: FOLDER_BARRELS['live-catalog']?.values ?? [],
    load: () => import('../src/live-catalog/index.js'),
  },
  { name: 'page', expected: PAGE_BARREL, load: () => import('../src/page/index.js') },
  { name: 'storage', expected: STORAGE_BARREL, load: () => import('../src/storage/index.js') },
  { name: 'client', expected: CLIENT_SURFACE, load: () => import('../src/client.js') },
  { name: 'root', expected: ROOT_SURFACE, load: () => import('../src/index.js') },
];

for (const barrel of RUNTIME_BARRELS) {
  void test(`the ${barrel.name} barrel exports the exact same values it did before the move`, async () => {
    const mod = await barrel.load();
    assert.deepEqual(
      Object.keys(mod).sort(),
      [...barrel.expected].sort(),
      `the ${barrel.name} barrel's exported value set changed`,
    );
  });
}

/** The names a file re-exports from its `export type { ... } from` blocks. */
function declaredTypeReexports(source: string): string[] {
  const names: string[] = [];
  for (const found of source.matchAll(/export type\s*\{([^}]*)\}/g)) {
    for (const raw of (found[1] ?? '').split(',')) {
      const parts = raw.trim().split(/\s+as\s+/);
      const name = (parts[parts.length - 1] ?? '').trim();
      if (name !== '') names.push(name);
    }
  }
  return names.sort();
}

for (const [folder, expected] of Object.entries(FOLDER_BARRELS)) {
  if (expected.types.length === 0) continue;
  void test(`the ${folder} barrel re-exports the types the root barrel took from it`, () => {
    const source = readFileSync(resolve(srcRoot, folder, 'index.ts'), 'utf8');
    assert.deepEqual(declaredTypeReexports(source), [...expected.types].sort());
  });
}

void test('no leaf module imports a barrel (DESIGN §4.1)', () => {
  const files = readdirSync(srcRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && entry.name !== 'index.ts')
    .map((entry) => resolve(entry.parentPath, entry.name));

  // A glob that matched nothing would make the assertion below vacuously true.
  assert.equal(files.length > 0, true, `no .ts files found under ${srcRoot}: this guard is scanning nothing`);

  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    // A barrel may compose other barrels; a leaf module may not reach for one.
    if (/from\s+['"]\.\.?\/(?:[a-z-]+\/)*index\.js['"]/.test(source)) {
      offenders.push(file.slice(srcRoot.length + 1));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'a leaf module imports a barrel: that makes the barrel a central hub and hides a circular import until runtime',
  );
});
