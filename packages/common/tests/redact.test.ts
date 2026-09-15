/**
 * `redactCredential`: the boundary filter I3 depends on.
 *
 * DESIGN I3 says `mc_jwt` appears in exactly one place: the `Cookie` header at connect time. Every
 * object that crosses into a log line or an event payload is supposed to pass through this function
 * first, so the tests below pin both halves of that contract: it must remove the credential, and it
 * must leave everything else (field names, other headers, unrelated strings) exactly as it was,
 * because a filter that mangles diagnostics is a filter nobody keeps.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactCredential } from '../src/redact.js';

/** A JWT-shaped value: three base64url segments whose header segment decodes to `{"`. */
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJwXzEiLCJpYXQiOjE3MDAwMDAwMDB9.c2lnbmF0dXJl';

describe('redactCredential', () => {
  it('replaces a value under any credential-shaped key, case-insensitively', () => {
    const input = {
      Cookie: `mc_jwt=${JWT}`,
      authorization: `Bearer ${JWT}`,
      'Set-Cookie': `mc_jwt=${JWT}; Path=/`,
      mc_jwt: JWT,
      cookie: 'a=b',
    };
    const output = redactCredential(input);
    for (const value of Object.values(output)) {
      assert.equal(value, '[redacted]');
    }
  });

  it('removes a cookie pair value and a JWT-shaped token from unstructured text', () => {
    const output = redactCredential({
      note: `dropped Cookie: mc_jwt=${JWT}; other=1`,
      raw: JWT,
    });
    // The cookie *name* survives. It is not a credential, and knowing which cookie was dropped is the
    // diagnostic. The value does not survive.
    assert.equal(output.note, 'dropped Cookie: mc_jwt=[redacted]; other=1');
    assert.equal(output.raw, '[redacted]');
  });

  it('leaves the key names, other headers and non-credential strings untouched', () => {
    const output = redactCredential({
      Origin: 'https://magicgarden.gg',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0',
      url: 'wss://magicgarden.gg/version/1158/api/rooms/r/connect',
      reason: 'ECONNREFUSED',
      version: '1158',
    });
    assert.deepEqual(output, {
      Origin: 'https://magicgarden.gg',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0',
      url: 'wss://magicgarden.gg/version/1158/api/rooms/r/connect',
      reason: 'ECONNREFUSED',
      version: '1158',
    });
  });

  it('deep-copies: the input object is not mutated, and arrays are walked', () => {
    const input = { dropped: [{ Cookie: `mc_jwt=${JWT}` }] };
    const output = redactCredential(input);
    assert.equal(input.dropped[0]?.Cookie, `mc_jwt=${JWT}`);
    assert.equal(output.dropped[0]?.Cookie, '[redacted]');
    assert.notEqual(output, input);
    assert.notEqual(output.dropped[0], input.dropped[0]);
  });

  it('is platform-free: primitives, null and undefined survive', () => {
    assert.equal(redactCredential('plain'), 'plain');
    assert.equal(redactCredential(42), 42);
    assert.equal(redactCredential(null), null);
    assert.equal(redactCredential(undefined), undefined);
  });
});
