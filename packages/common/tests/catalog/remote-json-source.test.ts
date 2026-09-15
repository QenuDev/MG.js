/**
 * `RemoteJsonSource`'s constructor is the only thing standing between two caller-supplied strings and
 * the request's origin: it resolves every `paths[kind]` against `baseUrl` once, at construction, and the
 * loader fetches only those resolved URLs, so a path that is itself an absolute URL (or
 * protocol-relative) cannot retarget the request away from the pinned origin. Audit 23 measured both
 * shapes against the original `${baseUrl}${path}` load:
 * `baseUrl: ''` + `paths: { plants: 'http://169.254.169.254/latest/meta-data/' }` reaches link-local
 * metadata, and `baseUrl: 'https:'` + `'//evil.test/x'` retargets the host.
 *
 * The source refuses rather than silently stripping a leading `//` and pretending the caller asked
 * for something else.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_REMOTE_PATHS, RemoteJsonSource } from '../../src/catalog/remote-json-source.ts';

/** Run `work` with `fetch` stubbed to a 200 JSON body, and return the URLs it was called with. */
async function captureRequests(work: () => Promise<unknown>): Promise<string[]> {
  const requested: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  try {
    await work();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return requested;
}

describe('RemoteJsonSource origin pinning', () => {
  it('refuses a protocol-relative path', () => {
    assert.throws(
      () => new RemoteJsonSource({ baseUrl: 'https://a.test', paths: { plants: '//evil.test/x' } }),
      /leaves the base origin/,
    );
  });

  it('refuses an absolute path on a different origin', () => {
    assert.throws(
      () =>
        new RemoteJsonSource({
          baseUrl: 'https://a.test',
          paths: { plants: 'http://169.254.169.254/latest/meta-data/' },
        }),
      /leaves the base origin/,
    );
  });

  it('keeps a path with dot segments on the origin (they cannot climb out of one)', async () => {
    // Note the asymmetry that makes this test worth stating: no number of `..` segments can leave a URL's
    // own origin, so this case is *not* a security failure. It is recorded so a reader does not mistake
    // the origin check for something it is not. `../../evil/x` has no leading `/`, so it is a relative
    // path resolved against the base path `/data/`: the two `..` segments climb from `/data/` to the
    // root, yielding `https://a.test/evil/x`. That URL is on the same host, so the origin check passes.
    // The fetch must go to that resolved URL, so the validated string and the requested URL are one thing.
    const source = new RemoteJsonSource({
      baseUrl: 'https://a.test/data/',
      paths: { plants: '../../evil/x' },
    });

    assert.equal(source.id, 'remote-json:https://a.test/data');
    const requested = await captureRequests(() => source.load('plants'));
    assert.deepEqual(requested, ['https://a.test/evil/x']);
  });

  it('fetches the resolved URL, not a naive concatenation that a leading "@" retargets', async () => {
    // `new URL('@evil.test/x', 'https://a.test')` is on-origin, but `'https://a.test' + '@evil.test/x'`
    // is the URL `https://a.test@evil.test/x`, whose host is `evil.test` (the `a.test` becomes userinfo).
    // Validating one string and fetching another is the bypass; the fetch must use the resolved URL.
    const source = new RemoteJsonSource({ baseUrl: 'https://a.test', paths: { plants: '@evil.test/x' } });

    const requested = await captureRequests(() => source.load('plants'));

    assert.deepEqual(requested, ['https://a.test/@evil.test/x']);
    assert.equal(new URL(requested[0] ?? '').origin, 'https://a.test');
  });

  it('fetches the resolved URL when the path starts with whitespace the URL parser strips', async () => {
    // A leading tab is stripped by URL parsing, so `'https://a.test' + '\t@evil.test/x'` parses as
    // `https://a.test@evil.test/x`, the same retarget hidden behind control whitespace.
    const source = new RemoteJsonSource({
      baseUrl: 'https://a.test',
      paths: { plants: '\t@evil.test/x' },
    });

    const requested = await captureRequests(() => source.load('plants'));

    assert.deepEqual(requested, ['https://a.test/@evil.test/x']);
    assert.equal(new URL(requested[0] ?? '').origin, 'https://a.test');
  });

  it('fetches the resolved path when the base URL carries a fragment', async () => {
    // A fragment in `baseUrl` passes the origin check, but `'https://a.test#frag' + '/data/version'`
    // puts the whole path inside the fragment, so the request would never send it.
    const source = new RemoteJsonSource({ baseUrl: 'https://a.test#frag' });

    const requested = await captureRequests(() => source.load('version'));

    assert.deepEqual(requested, ['https://a.test/data/version']);
  });

  it('refuses a non-https baseUrl', () => {
    assert.throws(() => new RemoteJsonSource({ baseUrl: 'http://a.test' }), /must be an https origin/);
  });

  it('refuses a baseUrl that is not an absolute URL', () => {
    // `new URL('')` throws a bare TypeError, which tells the caller nothing about which option was wrong.
    assert.throws(() => new RemoteJsonSource({ baseUrl: '' }), /must be an absolute URL/);
  });

  it('derives one id per origin when only the trailing slash differs', async () => {
    const withSlash = new RemoteJsonSource({ baseUrl: 'https://a.test/' });
    const without = new RemoteJsonSource({ baseUrl: 'https://a.test' });

    assert.equal(withSlash.id, without.id, 'one origin must not produce two source ids');
    assert.equal(without.id, 'remote-json:https://a.test');

    // `baseUrl` is private, so the normalisation is observed where it is used: the request URL.
    const requested: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response(JSON.stringify({ version: 1 }), { status: 200 });
    }) as typeof fetch;
    try {
      await withSlash.load('version');
      await without.load('version');
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(requested, ['https://a.test/data/version', 'https://a.test/data/version']);
  });

  it('refuses an empty path override instead of silently fetching the base URL', () => {
    // `new URL('', base)` resolves to the base, so an empty override would pass the origin check and make
    // the category fetch the base URL itself. Refusing names the option that is wrong.
    assert.throws(
      () => new RemoteJsonSource({ baseUrl: 'https://a.test', paths: { plants: '' } }),
      /"paths\.plants"/,
    );
  });

  it('accepts the default construction and keeps every default path on the base origin', () => {
    const source = new RemoteJsonSource({ baseUrl: 'https://a.test' });

    assert.equal(source.id, 'remote-json:https://a.test');
    assert.deepEqual([...source.capabilities].sort(), Object.keys(DEFAULT_REMOTE_PATHS).sort());
  });

  it('accepts an origin with a path prefix and a path override that stays on it', () => {
    const source = new RemoteJsonSource({
      baseUrl: 'https://a.test/api-root/',
      paths: { plants: '/custom/plants' },
      kinds: ['plants'],
    });

    assert.deepEqual([...source.capabilities], ['plants']);
  });
});
