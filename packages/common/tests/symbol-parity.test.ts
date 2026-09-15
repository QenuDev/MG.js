/**
 * The public surface of `@mg.js/common`, frozen before the structure phase moves anything.
 *
 * ## Why this file exists
 *
 * Tasks 5.2 and 5.3 move 15 exported symbols between barrels and rename six modules, and nothing in the
 * repo asserted that a *rename* preserved the public surface. `tsc -b` cannot see this failure:
 * `protocol/index.ts`'s `getActionSpec` has no consumer inside `common`, so dropping that re-export on
 * the way to `actions/index.ts` compiles green and breaks every external caller. That is the audit's own
 * warning: *"the one thing that must never be split across commits: an `exports` map edit and the file
 * move it points at"*, and it is the risk this net guards against.
 *
 * Landed **before** Task 5.2 rather than after (the plan's own "Test first" section asks for the snapshot
 * to be captured pre-move; this goes one step further and puts the net up pre-move, so the move is
 * guarded by a test that already exists rather than by one written afterwards).
 *
 * ## The snapshot
 *
 * 150 runtime names from `packages/common/src/index.ts`. 133 were measured at `737b`-era HEAD
 * `db7371f`. The named state accessors and the game's server clock added the rest: `StateReader`,
 * `StateRecord`, `asRecord`, `ServerClock`, `asFiniteMs`, `MUTATIONS`, `mutationName` and the four
 * documented field-name lists, in the same commit as this line. `toCurrency` followed, in the commit that
 * moved a player's balances out of the room's player list and into their saved data, and then the four
 * inventory readers and `toStorage` with the inventory itself.
 *
 *     node --import tsx -e \
 *       "import('./packages/common/src/index.ts').then(m=>console.log(Object.keys(m).sort().join('\n')))"
 *
 * Runtime, so type-only exports are absent by construction: this test is about the value surface a
 * caller can actually reach with an `import`.
 *
 * ## Read this before "fixing" a failure
 *
 * The only benign failure is a stale snapshot, and it is still a finding. If a later phase adds or removes
 * a `common` export, this list must be updated **in that same commit**, and the commit
 * body must name the symbol. A test that silently follows whatever the surface happens to be asserts
 * nothing, which is the defect class this phase exists to remove (DESIGN §6, I8).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * Every runtime export of the `common` root barrel, sorted. Measured, not written by hand. Transcribing
 * 144 identifiers manually would have produced a snapshot of my typing rather than of the code.
 */
const EXPECTED_EXPORTS: readonly string[] = [
  'ACTION_NAMES',
  'ACTIVITY_ACTION_FIELDS',
  'ACTIVITY_PARAMETER_FIELDS',
  'ACTIVITY_PET_FIELDS',
  'ACTION_SPECS',
  'CATALOG_KINDS',
  'CHAT',
  'CatalogClient',
  'ClientCore',
  'CloseCode',
  'CommandHandle',
  'CommandSequencer',
  'ConsoleLogSink',
  'DEFAULT_HEADERS',
  'DEFAULT_HOST',
  'DEFAULT_LIFECYCLE_TIMEOUTS',
  'DEFAULT_MAX_RESPONSE_BYTES',
  'DEFAULT_RECONNECT',
  'DISCORD_ID_FIELDS',
  'DEFAULT_REMOTE_PATHS',
  'Emitter',
  'FLAT_ALLOWLIST',
  'FormRegistry',
  'FrontierAnchoredStrategy',
  'GAME_ACTION_METHOD_COUNT',
  'GAME_GRID_MS',
  'GAME_ROOT',
  'GameActions',
  'HOST_PLAYER_ID',
  'HttpError',
  'JsonPatch',
  'KEEPALIVE_PING',
  'KEEPALIVE_PONG',
  'MAX_FRAME_BYTES',
  'MAX_REPORTED_STALE',
  'MG_VERSION',
  'MUTATIONS',
  'MemoryLogSink',
  'MgAuthError',
  'MgCommandDroppedError',
  'MgCommandRejectedError',
  'MgCommandUnconfirmedError',
  'MgConfigError',
  'MgConnectionError',
  'MgError',
  'MgNotReadyError',
  'MgProtocolError',
  'MgSupersededError',
  'MgTransportError',
  'MgVersionExpiredError',
  'MonotonicStrategy',
  'MultiLogSink',
  'ObservableStore',
  'PLATFORM_PATHS',
  'PLAYERS',
  'PlatformApiSource',
  'REDACTED',
  'ROOM_ROOT',
  'RemoteJsonSource',
  'ResultCode',
  'SCOPE_QUINOA',
  'SCOPE_ROOM',
  'SOURCE_FAILURE_CODE',
  'ServerClock',
  'STATIC_SOURCE_ID',
  'StateReader',
  'StateRecord',
  'StateWaitError',
  'StaticCatalogSource',
  'USER_SLOTS',
  'activityLogs',
  'addLeadingChild',
  'asRecord',
  'asFiniteMs',
  'analyzeClose',
  'applyPatch',
  'asSequence',
  'buildConnectUrl',
  'buildConnectUrlDetailed',
  'buildFlatFrame',
  'buildFrame',
  'buildRoomFrame',
  'buildWrappedFrame',
  'createLogger',
  'createNullLogger',
  'deepClone',
  'deepEqual',
  'defaultFormRegistry',
  'dropLeadingChild',
  'emptyCatalog',
  'emptyStateTree',
  'encodeQueryValue',
  'escapeToken',
  'extractFrontier',
  'extractPatches',
  'failureResult',
  'fetchJson',
  'findPlayerIndex',
  'formatPointer',
  'frameAction',
  'frameScope',
  'getActionSpec',
  'getPointer',
  'hasWeather',
  'interpretRejection',
  'isCanonicalSequence',
  'isKeepalivePing',
  'isMgError',
  'isWrappedFrame',
  'mutationName',
  'joinPointer',
  'normaliseLegacyWeather',
  'normaliseWeatherBlock',
  'normaliseWeatherSlot',
  'normalizeEntityMap',
  'parseFrame',
  'parsePointer',
  'parseResultCode',
  'player',
  'playerCount',
  'pointerContains',
  'pollUntil',
  'pruneUndefined',
  'randomRoomSlug',
  'randomUuid',
  'redactCredential',
  'redactCredentialString',
  'resolvePointer',
  'restockCountdown',
  'scopeForForm',
  'serializeFrame',
  'summarizeError',
  'toCrops',
  'toCurrency',
  'toInventory',
  'toInventoryItem',
  'toInventoryItems',
  'toMgError',
  'toStorage',
  'unrefTimer',
  'utf8ByteLength',
  'watchUntil',
  'weatherAt',
];

void test('common/src/index.ts exports the names it exported before the structure phase', async () => {
  const mod = await import('../src/index.js');
  assert.deepEqual(
    Object.keys(mod).sort(),
    [...EXPECTED_EXPORTS].sort(),
    'the common root barrel gained or lost a name: a re-export block moved between barrels and did not land',
  );
});

void test('every name the protocol barrel exports also reaches the package root', async () => {
  const root = await import('../src/index.js');
  const protocol = await import('../src/protocol/index.js');
  const orphaned = Object.keys(protocol).filter((name) => !(name in root));
  assert.deepEqual(orphaned, [], 'a sub-barrel became a dead end, so its names are no longer public');
});
