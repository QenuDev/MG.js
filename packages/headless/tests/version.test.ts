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
import {
  RoomVersionSource,
  roomPageVersion,
  VersionResolver,
  VersionUnavailableError,
} from '../src/version.js';

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

/**
 * A room's own page is where a room's build comes from, and the platform endpoint is the fallback.
 *
 * The bug this guards, measured against the live game while it rolled 1176 → 1177: room `GOOBERS` refused
 * `version/1177` with `4710 VersionExpired` and accepted `version/1176`, room `8T7R` was the other way round,
 * and `/platform/v1/version` said `1177` for both. Resolving from the platform therefore hands back the one
 * build the named room is guaranteed to refuse — and, because `refresh()` re-reads the same endpoint, hands it
 * back forever.
 *
 * `ROOM_PAGE` below is what `GET https://magicgarden.gg/r/GOOBERS` actually answered with, trimmed to its
 * head, so the parse is pinned to the real shape rather than to one invented for the test.
 */
const ROOM_PAGE =
  '<!doctype html>\n<html lang="en" translate="no">\n\n<head>\n' +
  '  <script type="module" crossorigin src="/version/1176/assets/polyfills-CR1llgL3.js"></script>\n' +
  '  <meta property="og:image" content="https://magicgarden.gg/version/1176/thumbnail_share_2x1.webp" />\n' +
  '  <script type="module" crossorigin src="/version/1176/assets/index-Cxu-pBRw.js"></script>\n' +
  '</head>\n';

/** A `fetch` that answers one page, and counts how many times it was asked. */
function pageFetch(body: string, status = 200): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls: () => calls };
}

describe('RoomVersionSource: the room page decides, the platform endpoint backs it up', () => {
  it('reads the build the room page is served at', async () => {
    assert.equal(roomPageVersion(ROOM_PAGE), '1176', 'the first versioned URL in the page is the build');

    const source = new RoomVersionSource({ room: 'GOOBERS', fetch: pageFetch(ROOM_PAGE).fetch });
    assert.equal(await source.fetchVersion(), '1176');
    assert.equal(source.id, 'room-page:GOOBERS', 'the record names the room it read');
    assert.equal(await source.load('shops'), null, 'a source asked for anything but a version has none');
  });

  it('falls back to the platform endpoint when the page is unreadable or states no build', async () => {
    const missing = new RoomVersionSource({
      room: 'GOOBERS',
      fetch: pageFetch('not found', 404).fetch,
      fallback: new ScriptedVersionSource(['1177']),
    });
    assert.equal(await missing.fetchVersion(), '1177', 'a page that 404s leaves the platform to answer');

    const unstated = new RoomVersionSource({
      room: 'GOOBERS',
      fetch: pageFetch('<html><head></head></html>').fetch,
      fallback: new ScriptedVersionSource(['1177']),
    });
    assert.equal(await unstated.fetchVersion(), '1177', 'and so does a page that links no build');
  });

  it('rejects when neither the page nor the fallback has a build, rather than returning nothing', async () => {
    const source = new RoomVersionSource({
      room: 'GOOBERS',
      fetch: pageFetch('<html></html>').fetch,
      fallback: new ScriptedVersionSource([MALFORMED]),
    });
    await assert.rejects(source.fetchVersion(), VersionUnavailableError);
  });

  it('is the source a resolver with a room uses', async () => {
    const page = pageFetch(ROOM_PAGE);
    const resolver = new VersionResolver({ room: 'GOOBERS', roomFetch: page.fetch });

    const resolved = await resolver.resolveDetailed();
    assert.equal(resolved.version, '1176', 'a named room resolves to the build that room is served at');
    assert.equal(resolved.source, 'room-page:GOOBERS', 'and says where it came from');
    assert.equal(page.calls(), 1);
    // The TTL is the resolver's, so a second resolve inside the window costs no request at all.
    assert.equal(await resolver.resolve(), '1176');
    assert.equal(page.calls(), 1, 'the page is read once per cache window, not once per attempt');
  });

  it('prefers a 4710 refresh over the TTL, so a room that rolls is picked up at once', async () => {
    let calls = 0;
    const rolled = (async () => {
      calls += 1;
      return new Response(calls === 1 ? ROOM_PAGE : ROOM_PAGE.replaceAll('1176', '1177'));
    }) as unknown as typeof fetch;
    const resolver = new VersionResolver({ room: 'GOOBERS', roomFetch: rolled });

    assert.equal(await resolver.resolve(), '1176', 'the room as it is before it rolls');
    const after = await resolver.refresh();
    assert.equal(after.version, '1177', 'and as it is after: refresh must not be cached out');
    assert.equal(after.source, 'room-page:GOOBERS', 'the room page is still what answered');
  });

  it('leaves a roomless resolver on the platform endpoint', async () => {
    // No room, no room page: a resolver given nothing but a source uses it, which is what the default of the
    // platform endpoint is there for. Proven by the source id rather than by reaching the network.
    const resolver = new VersionResolver({ source: new ScriptedVersionSource(['1157']) });
    const resolved = await resolver.resolveDetailed();
    assert.equal(resolved.source, 'scripted');
    assert.equal(resolved.version, '1157');
  });
});
