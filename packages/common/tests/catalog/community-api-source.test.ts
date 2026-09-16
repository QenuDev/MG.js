/**
 * The contract check, offline against a fixture host.
 *
 * The community API is somebody else's process: it can be a different implementation, an older contract,
 * or a proxy serving an HTML error page. `docs/mgjs-community-api-plan.md` §5 names the four answers a
 * client must be able to refuse plus the one it must accept, and those five tests are below:
 *
 *   - a good contract loads;
 *   - a contract with a wrong `api` version is refused;
 *   - a contract missing a requested capability is refused;
 *   - a host that answers HTML or 404 at `/schema.json` is refused;
 *   - the game version the contract declares is what `load()` reports.
 *
 * Every request here goes to an injected `fetch` (`FetchJsonOptions.fetch`), so the suite opens no socket,
 * resolves no name, and asserts on the exact URL sequence a real caller would produce. The fixture bodies
 * are the shapes the fork builds (`Magic-garden-API/src/docs/contract.js`) and the plan states
 * (`/data/version` → `{gameVersion, artVersion, contract, generatedAt}`), not invented ones.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type CommunityApiContract,
  CommunityApiContractError,
  CommunityApiSource,
  DEFAULT_COMMUNITY_API_URL,
  SUPPORTED_API_CONTRACT,
  verifyContract,
} from '../../src/catalog/community-api-source.ts';
import { DEFAULT_REMOTE_PATHS } from '../../src/catalog/remote-json-source.ts';

const here = dirname(fileURLToPath(import.meta.url));
const packagesRoot = resolve(here, '../../..');
const BASE = 'https://community.test';

/** Run a promise and hand back whatever it rejected with, so the error itself can be inspected. */
async function catchThrown(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
}

/** The `/schema.json` document, as the fork's `buildRuntimeContract` builds it. */
function contractDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract: SUPPORTED_API_CONTRACT,
    api: SUPPORTED_API_CONTRACT,
    capabilities: ['data', 'live.shops', 'live.weather', 'compose'],
    paths: ['/schema.json', '/data/version', '/data/plants', '/live/shops'],
    data: [
      'plants',
      'pets',
      'items',
      'decors',
      'eggs',
      'abilities',
      'mutations',
      'weathers',
      'weather-groups',
      'enums',
      'version',
    ],
    unavailable: {},
    gameVersion: '1189',
    artVersion: '1189',
    generatedAt: '2026-09-16T05:00:00Z',
    ...overrides,
  };
}

/** The `/data/version` body, as `docs/mgjs-community-api-plan.md` §2.3 states it. */
function versionBody(gameVersion = '1189'): Record<string, unknown> {
  return {
    gameVersion,
    artVersion: gameVersion,
    contract: SUPPORTED_API_CONTRACT,
    generatedAt: '2026-09-16T05:00:00Z',
  };
}

/** A fixture host: `/schema.json` plus every path in `DEFAULT_REMOTE_PATHS`, and a 404 for anything else. */
function fixtureHost(
  schema: unknown,
  options: { version?: unknown; status?: number } = {},
): { fetch: typeof fetch; requested: string[] } {
  const requested: string[] = [];
  const fetchStub = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    const path = new URL(url).pathname;
    const status = options.status ?? 200;

    if (path === '/schema.json') {
      const body = typeof schema === 'string' ? schema : JSON.stringify(schema);
      return new Response(body, { status });
    }
    if (path === '/data/version') {
      const body = options.version ?? versionBody();
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
    }
    if (path === '/data/plants') {
      return new Response(JSON.stringify({ plants: [{ id: 'Carrot' }] }), { status: 200 });
    }
    if (path === '/live/shops') {
      return new Response(JSON.stringify({ seed: { open: true, nextRestockAt: null, items: [] } }), {
        status: 200,
      });
    }
    if (path.startsWith('/data/')) {
      const category = path.slice('/data/'.length);
      return new Response(JSON.stringify({ [category]: [] }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchStub, requested };
}

describe('verifyContract', () => {
  it('loads a host whose contract this build supports', async () => {
    const host = fixtureHost(contractDocument());
    const source = new CommunityApiSource({ baseUrl: BASE, fetch: host.fetch });

    assert.deepEqual(await source.load('plants'), [{ id: 'Carrot' }]);
    // The contract is checked once, before the category is read, and the category is read from the
    // default path for its kind — not from the contract's own path list.
    assert.deepEqual(host.requested, [`${BASE}/schema.json`, `${BASE}/data/plants`]);
    assert.equal(source.id, `community-api:${BASE}`);
    assert.equal(source.contract?.api, SUPPORTED_API_CONTRACT);
    assert.equal(source.contract?.gameVersion, '1189');
  });

  it('refuses a contract whose api version this build does not support', async () => {
    const host = fixtureHost(contractDocument({ api: SUPPORTED_API_CONTRACT + 1 }));
    const source = new CommunityApiSource({ baseUrl: BASE, fetch: host.fetch });

    const error = await catchThrown(source.load('plants'));

    assert.ok(error instanceof CommunityApiContractError, `expected a named refusal, got ${String(error)}`);
    assert.equal(error.reason, 'unsupported-api-version');
    assert.equal(error.found, SUPPORTED_API_CONTRACT + 1);
    assert.equal(error.required, SUPPORTED_API_CONTRACT);
    assert.equal(error.baseUrl, BASE);
    assert.deepEqual(host.requested, [`${BASE}/schema.json`], 'nothing under /data may be read');
  });

  it('refuses a contract that does not declare a requested capability', async () => {
    const host = fixtureHost(contractDocument({ capabilities: ['data', 'live.shops'] }));
    const source = new CommunityApiSource({ baseUrl: BASE, fetch: host.fetch, require: ['compose'] });

    const error = await catchThrown(source.load('plants'));

    assert.ok(error instanceof CommunityApiContractError);
    assert.equal(error.reason, 'missing-capability');
    assert.deepEqual(error.found, ['data', 'live.shops']);
    assert.deepEqual(error.required, ['compose']);
    assert.deepEqual(host.requested, [`${BASE}/schema.json`], 'nothing under /data may be read');
  });

  it('refuses a host that answers HTML or 404 at /schema.json', async () => {
    const answers: Array<{ label: string; schema: unknown; status: number }> = [
      { label: 'an HTML error page', schema: '<!doctype html><h1>Not found</h1>', status: 200 },
      { label: 'a 404', schema: 'not found', status: 404 },
    ];

    for (const { label, schema, status } of answers) {
      const host = fixtureHost(schema, { status });
      const source = new CommunityApiSource({ baseUrl: BASE, fetch: host.fetch });

      const error = await catchThrown(source.load('plants'));

      assert.ok(error instanceof CommunityApiContractError, `${label}: expected a named refusal`);
      assert.equal(error.reason, 'schema-unreachable', label);
      assert.deepEqual(host.requested, [`${BASE}/schema.json`], `${label}: nothing under /data may be read`);
    }
  });

  it('reports the game version the contract declares', async () => {
    const host = fixtureHost(contractDocument({ gameVersion: '1191' }), {
      version: versionBody('1191'),
    });
    const source = new CommunityApiSource({ baseUrl: BASE, fetch: host.fetch });

    const version = await source.load('version');

    assert.equal(version, '1191');
    // The route and the document must state one version: the route is read, and what it says is what the
    // contract promised (`buildRuntimeContract` serves both from the same stored version).
    assert.equal(version, source.contract?.gameVersion);
    assert.deepEqual(host.requested, [`${BASE}/schema.json`, `${BASE}/data/version`]);
  });

  it('refuses a contract whose game version does not parse', async () => {
    for (const gameVersion of ['nonsense', '', null, 1189]) {
      const host = fixtureHost(contractDocument({ gameVersion }));

      const error = await catchThrown(verifyContract(BASE, { fetch: host.fetch }));

      assert.ok(
        error instanceof CommunityApiContractError,
        `expected a refusal for ${JSON.stringify(gameVersion)}`,
      );
      assert.equal(error.reason, 'unparseable-game-version', JSON.stringify(gameVersion));
      assert.equal(error.found, gameVersion);
      assert.equal(error.required, 'a numeric game build id, e.g. "1189"');
    }
  });

  it('refuses a document that is JSON but not a contract', async () => {
    for (const document of ['[]', 'null', '"schema"', '17']) {
      const host = fixtureHost(document);

      const error = await catchThrown(verifyContract(BASE, { fetch: host.fetch }));

      assert.ok(error instanceof CommunityApiContractError);
      assert.equal(error.reason, 'unexpected-schema', document);
    }
  });

  it('checks the three facts in order and refuses on the first', async () => {
    // Every check would refuse this document. The reported one must be the first, or the error names a
    // fact that only matters once the earlier one holds.
    const host = fixtureHost(contractDocument({ api: 99, capabilities: [], gameVersion: 'nonsense' }));

    const error = await catchThrown(verifyContract(BASE, { fetch: host.fetch }));

    assert.ok(error instanceof CommunityApiContractError);
    assert.equal(error.reason, 'unsupported-api-version');
  });

  it('returns the parsed contract to the caller', async () => {
    const host = fixtureHost(contractDocument());

    const contract = await verifyContract(BASE, { fetch: host.fetch, require: ['data'] });

    assert.equal(contract.api, SUPPORTED_API_CONTRACT);
    assert.equal(contract.gameVersion, '1189');
    assert.equal(contract.generatedAt, '2026-09-16T05:00:00Z');
    assert.deepEqual(contract.capabilities, ['data', 'live.shops', 'live.weather', 'compose']);
  });
});

describe('CommunityApiSource', () => {
  it('checks the host once, however many categories are read', async () => {
    const host = fixtureHost(contractDocument());
    const source = new CommunityApiSource({ baseUrl: BASE, fetch: host.fetch });

    await Promise.all([source.load('plants'), source.load('shops')]);
    await source.load('version');

    const schemaRequests = host.requested.filter((url) => url.endsWith('/schema.json'));
    assert.deepEqual(schemaRequests, [`${BASE}/schema.json`], 'the contract must be checked once');
    assert.deepEqual(
      host.requested.sort(),
      [`${BASE}/data/plants`, `${BASE}/data/version`, `${BASE}/live/shops`, `${BASE}/schema.json`].sort(),
    );
  });

  it('accepts a contract the caller already verified', async () => {
    const host = fixtureHost(contractDocument());
    const source = new CommunityApiSource({
      baseUrl: BASE,
      fetch: host.fetch,
      contract: contractDocument() as unknown as CommunityApiContract,
    });

    await source.load('plants');

    assert.deepEqual(host.requested, [`${BASE}/data/plants`], 'no /schema.json when a contract was passed');
    assert.equal(source.contract?.api, SUPPORTED_API_CONTRACT);
  });

  it('has no community host by default, and refuses rather than calling a placeholder', async () => {
    assert.equal(
      DEFAULT_COMMUNITY_API_URL,
      '',
      'the default is unset until our own instance is hosted; when this value changes, the ' +
        '"one place" test below starts enforcing the new literal as the only one in packages/',
    );

    const requested: string[] = [];
    const fetchStub = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const error = await catchThrown(
      Promise.resolve().then(() => new CommunityApiSource({ fetch: fetchStub })),
    );
    assert.ok(error instanceof CommunityApiContractError, 'an unset host must be a named refusal');
    assert.equal(error.reason, 'no-base-url');
    assert.equal(error.required, 'a community API base URL');
    assert.deepEqual(requested, [], 'no request may be made when there is no host to make it to');

    // The same refusal for an explicitly empty override, and from `verifyContract` on its own.
    const empty = await catchThrown(Promise.resolve().then(() => new CommunityApiSource({ baseUrl: '' })));
    assert.ok(empty instanceof CommunityApiContractError);
    assert.equal(empty.reason, 'no-base-url');

    const verified = await catchThrown(verifyContract(''));
    assert.ok(verified instanceof CommunityApiContractError);
    assert.equal(verified.reason, 'no-base-url');
  });

  it('keeps a community host literal in exactly one place in packages/', async () => {
    // The plan's rule (docs/mgjs-community-api-plan.md §5): DEFAULT_COMMUNITY_API_URL is the only host
    // string in the library and nothing else names a community deployment. The value is empty today, so
    // what this asserts is the property that still holds when it is not: no module under packages/*/src
    // names a community host except the one that owns the constant, and that constant has one owner.
    //
    // Only `src` is scanned. A test may name a fixture host — `https://community.test` is not reachable —
    // and the point here is the shipped library, not the suite.
    const owner = resolve(packagesRoot, 'common/src/catalog/community-api-source.ts');
    const knownHosts = ['ariedam', 'mgjs-data-api'];

    const files: string[] = [];
    for (const packageName of readdirSync(packagesRoot)) {
      const srcRoot = resolve(packagesRoot, packageName, 'src');
      collectTypeScript(srcRoot, files);
    }
    assert.ok(files.length > 0, 'the scan found no source files, so it proves nothing');

    const naming = files.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return knownHosts.some((host) => text.includes(host));
    });
    const offenders = naming.filter((file) => file !== owner).map((file) => relative(packagesRoot, file));
    assert.deepEqual(offenders, [], 'only the module that owns DEFAULT_COMMUNITY_API_URL may name a host');

    const declarers = files
      .filter((file) => /export\s+const\s+DEFAULT_COMMUNITY_API_URL\b/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(packagesRoot, file));
    assert.deepEqual(declarers, ['common/src/catalog/community-api-source.ts']);
  });

  it('advertises every kind with a default path', () => {
    const source = new CommunityApiSource({ baseUrl: BASE, fetch: fixtureHost(contractDocument()).fetch });

    assert.deepEqual([...source.capabilities].sort(), Object.keys(DEFAULT_REMOTE_PATHS).sort());
  });
});

/** Every `.ts` file under `dir`, recursively. Missing directories are not an error. */
function collectTypeScript(dir: string, into: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) collectTypeScript(path, into);
    else if (entry.name.endsWith('.ts')) into.push(path);
  }
}
