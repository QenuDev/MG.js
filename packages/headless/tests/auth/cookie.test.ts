/**
 * `CookieAuthProvider` must refuse a value that cannot legally be a cookie, before it becomes a header.
 *
 * The provider is the one place in this package where a caller-supplied string is interpolated into an
 * HTTP header, and it did no validation at all: `mc_jwt=x\r\nX-Evil: 1` became two headers on any socket
 * that does not strip them. `probeSession` had this same rule and applied it (`validateCookieHeaderValue`,
 * reached through `buildProbeCookie`), so the same token was refused on the probe path and accepted on the
 * connect path, and that gap is the real defect. A rule enforced at one of two entry points is not a rule.
 *
 * The charset matters as much as CR/LF for diagnosis, but only CR/LF matters for safety: a rejection here
 * is meant to replace an unexplained server-side `4800`/`4840` with a message naming the option to fix.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CookieAuthProvider, MC_JWT_COOKIE } from '../../src/auth/cookie.js';
import { MgConfigError } from '../../src/errors.js';

/** A well-formed `mc_jwt` value: three dot-separated base64url segments. */
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJwXzEiLCJpYXQiOjE3MDAwMDAwMDB9.c2lnbmF0dXJl';

/** Assert a rejection that is an `MgConfigError` naming `field`, without echoing the value. */
async function assertRefused(provider: CookieAuthProvider, field: string, leaked: string): Promise<void> {
  await assert.rejects(provider.prepare(), (error: unknown) => {
    assert.ok(
      error instanceof MgConfigError,
      `expected MgConfigError, got ${error instanceof Error ? error.name : String(error)}`,
    );
    assert.equal(error.name, 'MgConfigError');
    assert.equal(error.code, 'config_invalid_token');
    assert.match(error.message, new RegExp(field));
    // Error text is what gets pasted into an issue, so the rejected value must not be in it.
    assert.ok(!error.message.includes(leaked), error.message);
    return true;
  });
}

describe('CookieAuthProvider validation', () => {
  it('refuses a token that would inject a second header', async () => {
    await assertRefused(new CookieAuthProvider({ token: 'x\r\nX-Evil: 1' }), 'token', 'X-Evil');
  });

  it('refuses any control character, not only CR and LF', async () => {
    await assertRefused(new CookieAuthProvider({ token: `x\u0000y` }), 'token', 'x\u0000y');
  });

  it('refuses a value outside the cookie charset, the shape of a pasted header', async () => {
    await assertRefused(new CookieAuthProvider({ token: 'has space' }), 'token', 'has space');
  });

  it('refuses injected extra cookies too, and names that option', async () => {
    await assertRefused(
      new CookieAuthProvider({ token: JWT, extraCookies: 'a=b\r\nX-Evil: 1' }),
      'extraCookies',
      'X-Evil',
    );
  });

  it('validates a token read lazily, not just the one passed to the constructor', async () => {
    await assertRefused(new CookieAuthProvider({ getCookie: () => 'x\r\nX-Evil: 1' }), 'token', 'X-Evil');
  });

  it('accepts a raw token', async () => {
    const contribution = await new CookieAuthProvider({ token: JWT }).prepare();
    assert.deepEqual(contribution.headers, { Cookie: `${MC_JWT_COOKIE}=${JWT}` });
    // `note` is the log line; it is optional in the contract, so narrow before reading it.
    const note = contribution.note ?? '';
    assert.match(note, /mc_jwt present \(\d+ chars\)/, 'the note describes the cookie without quoting it');
    assert.ok(!note.includes(JWT), 'the note is for logs and must not carry the token');
  });

  it('accepts a complete Cookie header, the shape devtools hands you', async () => {
    const contribution = await new CookieAuthProvider({
      token: `${MC_JWT_COOKIE}=${JWT}; other=1`,
    }).prepare();
    assert.deepEqual(contribution.headers, { Cookie: `${MC_JWT_COOKIE}=${JWT}; other=1` });
  });

  it('accepts a token carrying a trailing newline from a file, which is not injection', async () => {
    // The boundary of the rule: whitespace is trimmed before it becomes a header, so `getCookie` reading a
    // file with `readFileSync` does not fail for a reason the caller cannot see. Only what survives the
    // trim can inject anything.
    const contribution = await new CookieAuthProvider({ getCookie: () => `${JWT}\n` }).prepare();
    assert.deepEqual(contribution.headers, { Cookie: `${MC_JWT_COOKIE}=${JWT}` });
  });

  it('still appends extra cookies after a valid token', async () => {
    const contribution = await new CookieAuthProvider({
      token: JWT,
      extraCookies: 'a=b; c=d',
    }).prepare();
    assert.deepEqual(contribution.headers, { Cookie: `${MC_JWT_COOKIE}=${JWT}; a=b; c=d` });
  });
});
