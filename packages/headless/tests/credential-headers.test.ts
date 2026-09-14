/**
 * `probeSession` must not build a header out of an unvalidated token, and must not copy raw failure
 * text into a field documented as safe to log.
 *
 * A CR or LF in a cookie value is header injection: `${name}=${token}` in a `fetch` header value is a
 * request-splitting primitive on any runtime that does not reject it, and on the ones that do it turns
 * a diagnosable "your token is wrong" into an opaque network error. The rejection therefore happens
 * before the probe is dispatched, names the *field*, and never echoes the value. An error message is
 * the kind of thing that ends up pasted into an issue.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { probeSession } from '../src/session.js';

/** A JWT-shaped sentinel, so a leak is unambiguous. */
const SENTINEL_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJwXzEiLCJpYXQiOjE3MDAwMDAwMDB9.c2lnbmF0dXJlLXNlbnRpbmVs';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(status: number): { calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(input), headers: init?.headers ?? {} });
    return new Response('{}', { status });
  }) as unknown as typeof fetch;
  return { calls };
}

describe('probeSession: token validation', () => {
  it('rejects a CRLF token without echoing the rejected value', async () => {
    const { calls } = stubFetch(200);
    await assert.rejects(
      () => probeSession({ version: '1', room: 'r', token: 'x\r\nCookie: mc_jwt=evil' }),
      (error: Error) => {
        assert.equal(error.name, 'MgConfigError');
        assert.match(error.message, /token/i, error.message);
        assert.ok(!error.message.includes('evil'), error.message);
        assert.ok(!error.message.includes('\r\n'), error.message);
        return true;
      },
    );
    assert.equal(calls.length, 0, 'the probe must not be dispatched with an unsafe header');
  });

  it('rejects a bare LF token', async () => {
    const { calls } = stubFetch(200);
    await assert.rejects(
      () => probeSession({ version: '1', room: 'r', token: `a\nb` }),
      (error: Error) => {
        assert.equal(error.name, 'MgConfigError');
        assert.ok(!error.message.includes('a\nb'));
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  it('rejects a token outside the cookie-value charset, naming the field only', async () => {
    const { calls } = stubFetch(200);
    await assert.rejects(
      () => probeSession({ version: '1', room: 'r', token: 'has space' }),
      (error: Error) => {
        assert.equal(error.name, 'MgConfigError');
        assert.match(error.message, /token/i);
        assert.ok(!error.message.includes('has space'), error.message);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  it('rejects a header-forging cookie string', async () => {
    const { calls } = stubFetch(200);
    // A complete cookie string is accepted, but a header name in it is not.
    await assert.rejects(
      () => probeSession({ version: '1', room: 'r', token: 'mc_jwt=abc\r\nX-Injected: 1' }),
      /token/i,
    );
    assert.equal(calls.length, 0);
  });

  it('still accepts a bare JWT and a normal cookie string', async () => {
    const { calls } = stubFetch(200);
    const result = await probeSession({ version: '1', room: 'r', token: SENTINEL_JWT });
    assert.equal(result.valid, true);
    assert.equal(calls[0]?.headers.Cookie, `mc_jwt=${SENTINEL_JWT}`);

    const second = stubFetch(200);
    await probeSession({ version: '1', room: 'r', token: `${SENTINEL_JWT}; other=1` });
    // A full cookie string is normalised through the provider's own `toCookieHeader`, so the probe
    // diagnoses the same input the same way a connect would.
    assert.equal(second.calls[0]?.headers.Cookie, `mc_jwt=${SENTINEL_JWT}; other=1`);
  });
});

describe('probeSession: the reason field is safe to log', () => {
  it('classifies a transport failure instead of copying runtime text', async () => {
    globalThis.fetch = (async () => {
      throw new Error(`connect failed while sending Cookie: mc_jwt=${SENTINEL_JWT}`);
    }) as unknown as typeof fetch;

    const result = await probeSession({ version: '1', room: 'r', token: 'x' });
    assert.equal(result.outcome, 'network-error');
    assert.equal(result.code, 'network-error');
    assert.equal(result.valid, false);
    // The cookie *name* is not a secret; the value it carried is.
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(SENTINEL_JWT), serialized);
    assert.ok(!serialized.includes(`mc_jwt=${SENTINEL_JWT}`), serialized);
  });

  it('classifies an abort as a timeout', async () => {
    globalThis.fetch = ((_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as unknown as typeof fetch;

    const result = await probeSession({ version: '1', room: 'r', token: 'x', timeoutMs: 20 });
    assert.equal(result.outcome, 'timeout');
    assert.match(result.reason, /timed out/);
  });

  it('redacts a credential-shaped value that appears in an error message', async () => {
    globalThis.fetch = (async () => {
      throw new Error(`upstream rejected ${SENTINEL_JWT}`);
    }) as unknown as typeof fetch;

    const result = await probeSession({ version: '1', room: 'r', token: 'x' });
    assert.ok(!JSON.stringify(result).includes(SENTINEL_JWT), JSON.stringify(result));
  });
});
