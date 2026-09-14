/**
 * `VersionResolver`: the stale fallback is a caller's choice, not a universal rule.
 *
 * "A stale version is strictly better than no version" is right for {@link VersionResolver.resolve}:
 * the caller has nothing else to build a URL from, and a stale version earns a `4710` that the client
 * turns into a refresh. It is wrong for {@link VersionResolver.refresh}, whose only caller is that very
 * `4710` remedy: the server has just rejected the cached value, so handing it back re-arms the endless
 * `4710` loop this class exists to cure.
 *
 * These tests pin both halves: the strict one and the fallback that must not change.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CatalogKind } from '@mg.js/common';

import type { VersionSource } from '../src/version.js';
import { VersionResolver, VersionUnavailableError } from '../src/version.js';

/** A source that hands back a scripted payload per call, repeating the last one forever. */
class ScriptedVersionSource implements VersionSource {
  readonly id = 'scripted';
  calls = 0;

  constructor(private readonly payloads: readonly unknown[]) {}

  async load(_kind: CatalogKind): Promise<unknown> {
    const payload = this.payloads[Math.min(this.calls, this.payloads.length - 1)];
    this.calls += 1;
    return payload;
  }
}

/** `{"version":{"n":1}}`: the envelope is tolerated, the value is not, so `extractVersion` is `null`. */
const MALFORMED: unknown = { version: { nested: 1 } };

describe('VersionResolver: refresh() is strict, resolve() keeps the stale fallback', () => {
  it('refresh() rejects instead of returning a stale version for a malformed payload', async () => {
    const resolver = new VersionResolver({ source: new ScriptedVersionSource(['1157', MALFORMED]) });

    assert.equal(await resolver.resolve(), '1157');

    await assert.rejects(
      resolver.refresh(),
      VersionUnavailableError,
      'the 4710 remedy must fail loudly rather than hand back the version the server just rejected',
    );
    assert.equal(resolver.current, '1157', 'a failed refresh must not corrupt the cache');
  });

  it('resolve() still falls back to the stale version', async () => {
    // `ttlMs: 0` forces the second call through the source, so the fallback path is the one exercised.
    const resolver = new VersionResolver({
      source: new ScriptedVersionSource(['1157', MALFORMED]),
      ttlMs: 0,
    });

    assert.equal(await resolver.resolve(), '1157');
    const second = await resolver.resolveDetailed();
    assert.equal(second.version, '1157');
    assert.equal(second.fresh, false, 'a stale fallback must be reported as not fresh');
  });

  it('resolveDetailed() rejects when the payload is malformed and nothing is cached', async () => {
    // Pinned so the change stays narrow: an unusable first payload has always been fatal.
    const resolver = new VersionResolver({ source: new ScriptedVersionSource([MALFORMED]) });
    await assert.rejects(resolver.resolveDetailed(), VersionUnavailableError);
  });
});
