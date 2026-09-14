/**
 * The connect URL: quoting, numeric/boolean asymmetry, and auth contributions.
 *
 * Protocol recon §1.3 states the rule this file exists to police, verbatim:
 *
 *   > "Every value in the query string is JSON-encoded, including plain strings, which arrive quoted
 *   > (`"web"`, not `web`). This mirrors what the real client sends, string quoting included."
 *
 * and §1.4 supplies the one asymmetry that a naive "JSON-encode everything" implementation gets wrong:
 * `clientConnectionAttempt=1` and `reclaimSupersededSession=true` are written unquoted.
 *
 * The values are asserted **literally** against the raw URL text, not through `URL.searchParams`, because
 * `searchParams.get()` hands back the percent-decoded value and would happily accept `web` where the wire
 * needs `"web"`, which is precisely the bug these tests exist to catch. Each value is therefore checked
 * as its percent-encoded form: `"web"` arrives as `%22web%22`, and `"Quinoa"` as `%22Quinoa%22`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildConnectUrlDetailed, encodeQueryValue } from '@mg.js/common';
import { CookieAuthProvider, toCookieHeader } from '../src/auth/cookie.js';
import { ANONYMOUS_USER_STYLE_PARAM, GuestAuthProvider } from '../src/auth/guest.js';
import { appendAuthQuery, buildAttemptUrl, joinHost } from '../src/connect-url.js';
import { buildConnectHeaders, DEFAULT_ORIGIN, DESKTOP_CHROME_UA } from '../src/transport/headers.js';

/** The encoded form every string-valued parameter must appear in. */
function jsonEncoded(value: string): string {
  return encodeURIComponent(JSON.stringify(value));
}

/** The raw query string of a built URL, for literal assertions. */
function rawQuery(url: string): string {
  const index = url.indexOf('?');
  assert.notEqual(index, -1, `expected a query string in ${url}`);
  return url.slice(index + 1);
}

/** The literal (still percent-encoded) value of one query parameter. */
function rawParam(url: string, name: string): string | null {
  for (const pair of rawQuery(url).split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq) === name) return pair.slice(eq + 1);
  }
  return null;
}

describe('encodeQueryValue', () => {
  it('JSON-encodes strings and stringifies numbers and booleans', () => {
    // The primitive the whole §1.3 rule is built from.
    assert.equal(encodeQueryValue('web'), '"web"');
    assert.equal(encodeQueryValue('1157'), '"1157"');
    assert.equal(encodeQueryValue(1), '1');
    assert.equal(encodeQueryValue(true), 'true');
  });
});

describe('connect URL quoting', () => {
  const built = buildConnectUrlDetailed({
    host: 'magicgarden.gg',
    version: '1157',
    room: 'greenhouse',
    documentId: '11111111-2222-4333-8444-555555555555',
    connectionAttempt: 1,
  });

  it('quotes every string-valued query parameter', () => {
    // §1.3: the reference builder writes exactly these five as JSON-quoted strings.
    assert.equal(rawParam(built.url, 'surface'), jsonEncoded('web'));
    assert.equal(rawParam(built.url, 'platform'), jsonEncoded('desktop'));
    assert.equal(rawParam(built.url, 'capabilities'), jsonEncoded('fbo_mipmap_unsupported'));
    assert.equal(rawParam(built.url, 'locale'), jsonEncoded('en'));
    assert.equal(rawParam(built.url, 'clientVisibilityState'), jsonEncoded('visible'));
    assert.equal(rawParam(built.url, 'version'), jsonEncoded('1157'));
    assert.equal(rawParam(built.url, 'clientDocumentId'), jsonEncoded(built.documentId));
    assert.equal(rawParam(built.url, 'clientNavigationType'), jsonEncoded('navigate'));
  });

  it('does NOT quote the numeric and boolean parameters', () => {
    // §1.4: `clientConnectionAttempt=1`, never `"1"`.
    assert.equal(rawParam(built.url, 'clientConnectionAttempt'), '1');
  });

  it('builds the documented path shape', () => {
    // §1.3: wss://<host>/version/<gameVersion>/api/rooms/<roomId>/connect
    assert.ok(
      built.url.startsWith('wss://magicgarden.gg/version/1157/api/rooms/greenhouse/connect?'),
      built.url,
    );
  });

  it('never sends reclaimSupersededSession as false', () => {
    // §1.4: "Omit entirely otherwise. Don't send `false`."
    assert.equal(rawParam(built.url, 'reclaimSupersededSession'), null);
    assert.equal(built.url.includes('reclaimSupersededSession'), false);
  });

  it('sends reclaimSupersededSession=true, unquoted, only when asked', () => {
    const reclaiming = buildConnectUrlDetailed({
      version: '1157',
      room: 'greenhouse',
      documentId: '11111111-2222-4333-8444-555555555555',
      connectionAttempt: 2,
      isReload: true,
      reclaimSuperseded: true,
    });
    assert.equal(rawParam(reclaiming.url, 'reclaimSupersededSession'), 'true');
    assert.equal(rawParam(reclaiming.url, 'clientConnectionAttempt'), '2');
    assert.equal(rawParam(reclaiming.url, 'clientNavigationType'), jsonEncoded('reload'));
  });

  it('keeps documentId and room stable across a retry', () => {
    const documentId = '11111111-2222-4333-8444-555555555555';
    const first = buildConnectUrlDetailed({ version: '1157', room: 'abc', documentId });
    const second = buildConnectUrlDetailed({
      version: '1158',
      room: 'abc',
      documentId,
      connectionAttempt: 2,
      isReload: true,
    });
    assert.equal(first.documentId, second.documentId);
    assert.equal(first.room, second.room);
    assert.equal(rawParam(second.url, 'version'), jsonEncoded('1158'));
  });
});

describe('appendAuthQuery', () => {
  const base = buildConnectUrlDetailed({
    version: '1157',
    room: 'greenhouse',
    documentId: '11111111-2222-4333-8444-555555555555',
  }).url;

  it('is a no-op without a contribution', () => {
    assert.equal(appendAuthQuery(base, undefined), base);
    assert.equal(appendAuthQuery(base, {}), base);
  });

  it('appends the guest style as a doubly-encoded JSON object', () => {
    // §3.2 calls `anonymousUserStyle` "a JSON object"; §1.3 says every string value is JSON-encoded. The
    // value is therefore `JSON.stringify(JSON.stringify(style))`, percent-encoded.
    const style = JSON.stringify(
      JSON.stringify({
        name: 'Bot',
        color: 'red',
        avatarBottom: 'b',
        avatarMid: 'm',
        avatarTop: 't',
        avatarExpression: 'happy',
      }),
    );
    const url = appendAuthQuery(base, { [ANONYMOUS_USER_STYLE_PARAM]: style });
    assert.equal(rawParam(url, ANONYMOUS_USER_STYLE_PARAM), encodeURIComponent(style));
    // The decoded form is the JSON-quoted JSON object, which is the wire shape.
    const decoded = decodeURIComponent(rawParam(url, ANONYMOUS_USER_STYLE_PARAM) ?? '');
    assert.equal(decoded, style);
    assert.deepEqual(JSON.parse(JSON.parse(decoded)), {
      name: 'Bot',
      color: 'red',
      avatarBottom: 'b',
      avatarMid: 'm',
      avatarTop: 't',
      avatarExpression: 'happy',
    });
  });

  it('does not let a provider replace a documented parameter', () => {
    // A collision would silently change the connection's identity, so the documented value wins.
    const url = appendAuthQuery(base, { version: '"9999"', surface: '"native"' });
    assert.equal(rawParam(url, 'version'), jsonEncoded('1157'));
    assert.equal(rawParam(url, 'surface'), jsonEncoded('web'));
  });
});

describe('auth providers', () => {
  it('guest contributes only the anonymousUserStyle query parameter', async () => {
    const provider = new GuestAuthProvider({ name: 'Tester', color: 'blue' });
    const contribution = await provider.prepare();
    assert.equal(provider.id, 'guest');
    assert.equal(provider.authenticated, false);
    assert.equal(contribution.headers, undefined);
    assert.deepEqual(Object.keys(contribution.query ?? {}), [ANONYMOUS_USER_STYLE_PARAM]);
    // ONE level of JSON, not two. The reference client (`mg-afk-android`, UrlBuilder.kt:79-105) passes
    // the bare JSON text as the parameter value while explicitly quoting every other string parameter,
    // so the absence of outer quoting is deliberate. See guest.ts for the full reasoning.
    const raw = contribution.query?.[ANONYMOUS_USER_STYLE_PARAM] ?? '';
    assert.deepEqual(JSON.parse(raw), { name: 'Tester', color: 'blue' });
    assert.equal(raw.startsWith('"'), false, 'the raw form must not be wrapped in a JSON string');
  });

  it('guest can still emit the older doubly-encoded form on request', async () => {
    // Kept because this was the documented reading and an older build may want it. Both forms are
    // wired; only the default changed.
    const provider = new GuestAuthProvider({ name: 'Tester', encode: 'json' });
    const contribution = await provider.prepare();
    const value = contribution.query?.[ANONYMOUS_USER_STYLE_PARAM] ?? '';
    assert.equal(value.startsWith('"'), true, 'the json form wraps the JSON text in a JSON string');
    assert.deepEqual(JSON.parse(JSON.parse(value)), { name: 'Tester' });
  });

  it('guest omits fields it was not given rather than inventing wire names', async () => {
    const contribution = await new GuestAuthProvider().prepare();
    const inner = JSON.parse(contribution.query?.[ANONYMOUS_USER_STYLE_PARAM] ?? '');
    assert.deepEqual(inner, {});
  });

  it('guest emits the six documented fields when all are supplied', async () => {
    // Android sends all six; ours must be able to as well, or the server sees a differently-shaped guest.
    const contribution = await new GuestAuthProvider({
      name: 'Tester',
      color: '#4CAF50',
      avatarBottom: 'default',
      avatarMid: 'default',
      avatarTop: 'default',
      avatarExpression: 'happy',
    }).prepare();
    const inner = JSON.parse(contribution.query?.[ANONYMOUS_USER_STYLE_PARAM] ?? '');
    assert.deepEqual(Object.keys(inner).sort(), [
      'avatarBottom',
      'avatarExpression',
      'avatarMid',
      'avatarTop',
      'color',
      'name',
    ]);
  });

  it('guest rejects an empty name, the one certainly-wrong shape', async () => {
    // `prepare()` is async, so the TypeError surfaces as a rejection rather than a synchronous throw.
    await assert.rejects(() => new GuestAuthProvider({ name: '' }).prepare(), TypeError);
  });

  it('cookie builds an mc_jwt header from a raw token', async () => {
    const provider = new CookieAuthProvider({ token: 'abc.def.ghi' });
    const contribution = await provider.prepare();
    assert.equal(provider.authenticated, true);
    assert.deepEqual(contribution.headers, { Cookie: 'mc_jwt=abc.def.ghi' });
    assert.equal(contribution.query, undefined);
    // The note must not leak the token itself.
    assert.equal(contribution.note?.includes('abc.def.ghi'), false);
  });

  it('cookie accepts a full cookie string instead of a bare token', async () => {
    assert.equal(toCookieHeader('mc_jwt=xyz; theme=dark'), 'mc_jwt=xyz; theme=dark');
    assert.equal(toCookieHeader('xyz', 'theme=dark'), 'mc_jwt=xyz; theme=dark');
  });

  it('cookie re-reads the token per attempt, so a rotated cookie is picked up', async () => {
    let token = 'first';
    const provider = new CookieAuthProvider({ getCookie: () => token });
    assert.deepEqual((await provider.prepare()).headers, { Cookie: 'mc_jwt=first' });
    token = 'second';
    assert.deepEqual((await provider.prepare()).headers, { Cookie: 'mc_jwt=second' });
  });

  it('cookie refuses to construct or prepare without a cookie', async () => {
    assert.throws(() => new CookieAuthProvider({}), TypeError);
    const provider = new CookieAuthProvider({ getCookie: () => undefined });
    await assert.rejects(() => provider.prepare(), TypeError);
  });
});

describe('connect headers', () => {
  it('presents the page origin and a desktop-Chrome UA', () => {
    const headers = buildConnectHeaders();
    assert.equal(headers.Origin, DEFAULT_ORIGIN);
    assert.equal(headers.Origin, 'https://magicgarden.gg');
    assert.equal(headers['User-Agent'], DESKTOP_CHROME_UA);
    assert.match(headers['User-Agent'], /Chrome\//);
  });

  it('merges a provider Cookie onto the canonical key', () => {
    const headers = buildConnectHeaders({ extra: { cookie: 'mc_jwt=t' } });
    assert.equal(headers.Cookie, 'mc_jwt=t');
  });

  it('lets the origin and UA be overridden', () => {
    const headers = buildConnectHeaders({
      origin: 'https://example.test',
      userAgent: 'custom-agent/1',
    });
    assert.equal(headers.Origin, 'https://example.test');
    assert.equal(headers['User-Agent'], 'custom-agent/1');
  });
});

describe('buildAttemptUrl', () => {
  /** A minimal first attempt, so each case can vary exactly one thing. */
  function attempt(overrides: Partial<Parameters<typeof buildAttemptUrl>[0]> = {}) {
    return buildAttemptUrl({
      host: 'example.test',
      version: 'v1.2',
      room: undefined,
      documentId: '',
      connectionAttempt: 1,
      isReload: false,
      reclaimSuperseded: false,
      authQuery: undefined,
      ...overrides,
    });
  }

  // Moved out of `client.ts` in Phase 5 Task 5.5b: the assembly used to be inline in `openConnection`
  // between a version refresh and a socket allocation, so these four properties were only observable by
  // running a whole client against a server.
  it('a first attempt mints both server-assigned values', () => {
    const { url, documentId, room } = attempt();
    assert.notEqual(documentId, '', 'the client must mint a documentId on the first attempt');
    assert.notEqual(room, '', 'the room is minted when the caller did not pin one');
    assert.equal(url.includes(`api/rooms/${room}/connect`), true, `expected the minted room in ${url}`);
  });

  it('a retry carries both server-assigned values forward and is marked a reload', () => {
    const first = attempt();
    const retry = attempt({
      documentId: first.documentId,
      room: first.room,
      connectionAttempt: 2,
      isReload: true,
    });
    assert.equal(retry.documentId, first.documentId, 'a fresh documentId would orphan the session state');
    assert.equal(retry.room, first.room, 'a fresh room would reconnect somewhere else');
    assert.equal(rawParam(retry.url, 'clientNavigationType'), jsonEncoded('reload'));
    // §1.4's asymmetry, still applied by the wrapper: the attempt number is not quoted.
    assert.equal(rawParam(retry.url, 'clientConnectionAttempt'), '2');
  });

  it('omits reclaimSuperseded entirely unless a superseded close happened', () => {
    assert.equal(rawParam(attempt().url, 'reclaimSupersededSession'), null);
    assert.equal(rawParam(attempt({ reclaimSuperseded: true }).url, 'reclaimSupersededSession'), 'true');
  });

  it('appends a provider query on top, without letting it replace a documented parameter', () => {
    const url = attempt({ authQuery: { clientDocumentId: 'replaced', anon: 'yes' } }).url;
    assert.equal(url.includes('replaced'), false, 'a collision must not overwrite the documented value');
    assert.equal(rawParam(url, 'anon'), 'yes');
  });
});

describe('joinHost', () => {
  it('folds an explicit port in unless the host already carries one', () => {
    assert.equal(joinHost(undefined, 8080), undefined, 'no host stays no host, whatever the port');
    assert.equal(joinHost('example.test', undefined), 'example.test');
    assert.equal(joinHost('example.test', 8080), 'example.test:8080');
    assert.equal(joinHost('example.test:9000', 8080), 'example.test:9000', 'an explicit port wins');
  });
});
