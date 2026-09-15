/**
 * The inbound frame ceiling: a byte count, not a string length.
 *
 * Parsing is forgiving inbound: an unrecognised frame is reported, never fatal, so the bound has to sit
 * *above* the parser. Without it, one frame from the far end (or from a
 * MITM on a `tls: false` deployment) is buffered by the runtime, copied by the decoder, retained by an
 * event and re-parsed by every listener, with no cap and no disconnect.
 *
 * These tests pin the ±1 boundary, the UTF-16-versus-UTF-8 trap, and the fact that the ceiling is a
 * bound rather than a content filter.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { asSequence, extractFrontier, parseFrame } from '../../src/protocol/codec.js';

/**
 * The exact UTF-8 byte length, computed the obvious way.
 *
 * This is *not* the implementation's hand-rolled counter: a test that shares the implementation's
 * arithmetic cannot catch a wrong one. The allocating version is fine here, because this is a test.
 */
function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

describe('parseFrame: the frame ceiling', () => {
  it('parses a frame exactly at the byte limit', () => {
    const limit = 64;
    const raw = JSON.stringify({ type: 'Pong' });
    const padded = raw + ' '.repeat(limit - utf8Length(raw));
    assert.equal(utf8Length(padded), limit);

    const result = parseFrame(padded, { maxBytes: limit });
    assert.equal(result.kind, 'message');
  });

  it('refuses a frame one byte over the limit without parsing it', () => {
    const limit = 64;
    const raw = JSON.stringify({ type: 'Pong' });
    const oversized = raw + ' '.repeat(limit - utf8Length(raw) + 1);
    assert.equal(utf8Length(oversized), limit + 1);

    const result = parseFrame(oversized, { maxBytes: limit });
    assert.equal(result.kind, 'oversized');
    if (result.kind !== 'oversized') assert.fail('expected the frame to be refused as oversized');
    assert.equal(result.bytes, limit + 1);
    assert.equal(result.limit, limit);
    // No `text`/`raw` member: an oversized frame cannot be retained by a caller, which is the whole
    // reason the variant carries no payload.
    assert.equal('text' in result, false);
    assert.equal('raw' in result, false);
  });

  it('counts bytes, not UTF-16 code units', () => {
    // Every 'é' is two UTF-8 bytes but one UTF-16 code unit, so a length check passes a frame the byte
    // check must refuse. This is the assertion that cannot pass while `raw.length` is the only measure.
    const raw = `{"type":"Pong","pad":"${'é'.repeat(9)}"}`;
    const limit = utf8Length(raw) - 1;
    assert.ok(raw.length < limit, 'the UTF-16 length must under-count, or this test proves nothing');

    assert.equal(parseFrame(raw, { maxBytes: limit }).kind, 'oversized');
  });

  it('bounds a frame by default when no options are passed', () => {
    // The production call site (`ClientCore.handleRawFrame`) passes no options, so the default has to be
    // the real ceiling; a frame of 'x' is the cheapest way to cross it without depending on the constant.
    const raw = 'x'.repeat(8 * 1024 * 1024 + 1);
    assert.equal(parseFrame(raw).kind, 'oversized');
  });

  it('still accepts a hostile-looking but small frame', () => {
    // The cap is a bound, not a filter: a small frame that mentions `__proto__` still parses exactly as
    // it did before, so the ceiling cannot quietly become a content policy.
    const raw = '{"type":"SomethingNew","__proto__":{"polluted":true}}';
    assert.ok(utf8Length(raw) < 1024);

    const result = parseFrame(raw, { maxBytes: 1024 });
    assert.equal(result.kind, 'message');
    if (result.kind === 'message' && !result.isKnown) {
      assert.equal(result.message.type, 'SomethingNew');
      assert.equal(Object.hasOwn(result.message.raw, '__proto__'), true);
    } else {
      assert.fail('expected the small hostile-looking frame to parse as an unknown message');
    }
  });
});

/**
 * The sequence rule's one home. The wire numbers commands with **non-negative integers**, so a fractional
 * counter is malformed input rather than a lower bound. Because the next value stamped is `frontier + 1`,
 * reporting `2.5` as a frontier puts `3.5` on the wire, which the server answers with `invalid_sequence`.
 * DESIGN I4 forbids turning untrusted data into a bound or an index without a canonical check, and this
 * value is both.
 */
describe('asSequence: the one sequence rule, integer ≥ 0', () => {
  it('accepts every non-negative integer, returning it unchanged', () => {
    for (const value of [0, 1, 7, 1157, Number.MAX_SAFE_INTEGER]) {
      assert.equal(asSequence(value), value);
    }
  });

  it('refuses a finite fraction, which the old `Number.isFinite` rule accepted', () => {
    assert.equal(asSequence(2.5), null, 'a fractional counter is malformed, not a lower bound');
    assert.equal(asSequence(-1), null);
    assert.equal(asSequence(-0.5), null);
    assert.equal(asSequence(Number.NaN), null);
    assert.equal(asSequence(Number.POSITIVE_INFINITY), null);
    assert.equal(asSequence(Number.NEGATIVE_INFINITY), null);
    assert.equal(asSequence('3'), null);
    assert.equal(asSequence(null), null);
    assert.equal(asSequence(undefined), null);
    assert.equal(asSequence({}), null);
  });

  it('extractFrontier refuses a fractional frontier instead of reporting it', () => {
    assert.equal(extractFrontier({ executedCommandSequence: 4 }), 4);
    // `0` is a real frontier ("the server has executed through sequence zero") and must not collapse into
    // the `null` that means "no evidence".
    assert.equal(extractFrontier({ executedCommandSequence: 0 }), 0);
    assert.equal(extractFrontier({ executedCommandSequence: 2.5 }), null);
    assert.equal(extractFrontier({ executedCommandSequence: -1 }), null);
    assert.equal(extractFrontier({ executedCommandSequence: '4' }), null);
    assert.equal(extractFrontier(null), null);
    assert.equal(extractFrontier(undefined), null);
    assert.equal(extractFrontier({}), null);
  });
});
