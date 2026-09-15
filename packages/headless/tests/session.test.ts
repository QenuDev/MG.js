/**
 * Session acquisition constants and the validation probe.
 *
 * The probe's value is that it separates "the token is bad" from "the protocol is wrong" in a single
 * request, so the tests below pin the mapping from HTTP status to outcome. They use a stubbed `fetch`
 * rather than the network, because a unit test that needs the internet is a flaky test. The live
 * behaviour is exercised by `scripts/verify-socket.ts` instead.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { MC_JWT_COOKIE } from '../src/auth/cookie.js';
import {
  buildDiscordOAuthUrl,
  DISCORD_CLIENT_ID,
  OAUTH_BOOTSTRAP_COOKIES,
  OAUTH_REDIRECT_URI,
  oauthBootstrapCookies,
  probeSession,
  SESSION_COOKIE_NAME,
  sessionProbePath,
} from '../src/session.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(
  status: number,
  body = '{}',
): { calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(input), headers: init?.headers ?? {} });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { calls };
}

describe('session probe path', () => {
  it('builds the documented versioned room path', () => {
    assert.equal(sessionProbePath('1158', 'abcde12345'), '/version/1158/api/rooms/abcde12345/me');
  });
});

describe('probeSession', () => {
  it('reports a 401 as an unauthorized session rather than as an error', () => {
    // What matters here: a dead token must be distinguishable from a protocol mistake.
    stubFetch(401);
    return probeSession({ version: '1158', room: 'r', token: 'dead' }).then((result) => {
      assert.equal(result.valid, false);
      assert.equal(result.status, 401);
      assert.equal(result.outcome, 'unauthorized');
      assert.match(result.reason, /SessionExpired|rejected/);
    });
  });

  it('treats 403 as unauthorized too', async () => {
    stubFetch(403);
    const result = await probeSession({ version: '1', room: 'r', token: 'x' });
    assert.equal(result.outcome, 'unauthorized');
  });

  it('reports a 404 as a missing room, not as a bad session', async () => {
    stubFetch(404);
    const result = await probeSession({ version: '1', room: 'nope', token: 'x' });
    assert.equal(result.outcome, 'not-found');
    assert.equal(result.valid, false);
  });

  it('reports 200 as valid', async () => {
    stubFetch(200, '{"id":"p_1"}');
    const result = await probeSession({ version: '1', room: 'r', token: 'good' });
    assert.equal(result.valid, true);
    assert.equal(result.outcome, 'valid');
  });

  it('sends the token as the documented cookie', async () => {
    const { calls } = stubFetch(200);
    await probeSession({ version: '1', room: 'r', token: 'my.jwt.value' });
    assert.equal(calls[0]?.headers.Cookie, `${SESSION_COOKIE_NAME}=my.jwt.value`);
    assert.ok(calls[0]?.url.endsWith('/version/1/api/rooms/r/me'));
  });

  it('omits the Cookie header entirely when no token is given', async () => {
    // Absence must be a real absence: the reference clients omit the header for guests, and an empty
    // `Cookie: mc_jwt=` is a different (and possibly rejected) request.
    const { calls } = stubFetch(401);
    await probeSession({ version: '1', room: 'r' });
    assert.equal('Cookie' in (calls[0]?.headers ?? {}), false);
  });

  it('never throws, even when the network fails', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await probeSession({ version: '1', room: 'r', token: 'x' });
    // UPDATED for the I3 fix: a transport failure is now classified as `network-error` rather than the
    // catch-all `error`, and the reason text is still there (redacted, but ECONNREFUSED is not a
    // credential). The old contract is documented in `SessionProbeResult`.
    assert.equal(result.valid, false);
    assert.equal(result.outcome, 'network-error');
    assert.equal(result.code, 'network-error');
    assert.equal(result.status, null);
    assert.match(result.reason, /ECONNREFUSED/);
  });

  it('never throws on a timeout', async () => {
    globalThis.fetch = ((_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as unknown as typeof fetch;
    const result = await probeSession({ version: '1', room: 'r', token: 'x', timeoutMs: 20 });
    // UPDATED for the I3 fix: an abort is its own outcome (`timeout`), not a flavour of `error`.
    assert.equal(result.outcome, 'timeout');
    assert.match(result.reason, /timed out/);
  });

  it('reports an unexpected status as an error', async () => {
    stubFetch(500);
    const result = await probeSession({ version: '1', room: 'r', token: 'x' });
    assert.equal(result.outcome, 'error');
    assert.equal(result.status, 500);
  });

  it('honours a custom base URL', async () => {
    const { calls } = stubFetch(200);
    await probeSession({ version: '1', room: 'r', baseUrl: 'https://example.test/' });
    assert.ok(calls[0]?.url.startsWith('https://example.test/version/1/'), calls[0]?.url);
  });
});

describe('OAuth acquisition constants', () => {
  it('matches the values both reference clients use', () => {
    // Verified against mg-afk-android Constants.kt:27-31 and MG-AFK src/main/ipc.js.
    assert.equal(DISCORD_CLIENT_ID, '1227719606223765687');
    assert.equal(OAUTH_REDIRECT_URI, 'https://magicgarden.gg/oauth2/redirect');
    assert.equal(OAUTH_BOOTSTRAP_COOKIES.roomId, 'mc_oauth_room_id');
    assert.equal(OAUTH_BOOTSTRAP_COOKIES.redirectUri, 'mc_oauth_redirect_uri');
  });

  it('agrees with the cookie provider on the session cookie name', () => {
    assert.equal(SESSION_COOKIE_NAME, MC_JWT_COOKIE);
    assert.equal(SESSION_COOKIE_NAME, 'mc_jwt');
  });

  it('builds the Discord authorise URL with all three scopes', () => {
    const url = new URL(buildDiscordOAuthUrl());
    assert.equal(url.origin + url.pathname, 'https://discord.com/oauth2/authorize');
    assert.equal(url.searchParams.get('client_id'), DISCORD_CLIENT_ID);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('redirect_uri'), OAUTH_REDIRECT_URI);
    assert.equal(url.searchParams.get('scope'), 'identify guilds.members.read guilds');
  });

  it('returns both bootstrap cookies ready for a browser context', () => {
    const cookies = oauthBootstrapCookies({ roomId: 'myApp' });
    assert.equal(cookies.length, 2);
    assert.deepEqual(cookies.map((c) => c.name).sort(), ['mc_oauth_redirect_uri', 'mc_oauth_room_id']);
    for (const cookie of cookies) {
      assert.equal(cookie.domain, '.magicgarden.gg');
      assert.equal(cookie.path, '/');
    }
    assert.equal(cookies[0]?.value, 'myApp');
    assert.equal(cookies[1]?.value, OAUTH_REDIRECT_URI);
  });
});
