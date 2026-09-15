/**
 * The logger's claim: a record written to a sink is safe to log.
 *
 * `MemoryLogSink.snapshot()` exists "for a bug-report dump", so anything a sink holds is something a
 * caller may paste into an issue. DESIGN I3 and the Logging section both say the redaction happens at
 * this boundary: the sink is the last point every record passes through, so it is the right
 * place to enforce it rather than trusting each call site to remember.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';

import { createLogger, MemoryLogSink } from '../src/log.js';

/** A JWT-shaped value: three base64url segments whose header segment decodes to `{"`. */
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJwXzEiLCJpYXQiOjE3MDAwMDAwMDB9.c2lnbmF0dXJl';

describe('logger credential boundary', () => {
  it('never writes a credential in a field, however it is spelled', () => {
    const sink = new MemoryLogSink();
    const logger = createLogger({ namespace: 'mg:test', level: 'debug', sink });

    logger.warn('headers were dropped', {
      headers: { Cookie: `mc_jwt=${JWT}`, Origin: 'https://magicgarden.gg' },
      authorization: `Bearer ${JWT}`,
      mc_jwt: JWT,
      url: `wss://magicgarden.gg/x?token=${JWT}`,
    });

    const serialized = JSON.stringify(sink.snapshot());
    assert.ok(!serialized.includes(JWT), serialized);
    assert.ok(!serialized.includes('mc_jwt='), serialized);
    // The diagnostics that make the record useful are still there.
    assert.ok(serialized.includes('https://magicgarden.gg'), serialized);
  });

  it('redacts an error object that carries the cookie in its message', () => {
    const sink = new MemoryLogSink();
    const logger = createLogger({ namespace: 'mg:test', level: 'debug', sink });

    logger.error('connect failed', new Error(`rejected header Cookie: mc_jwt=${JWT}`));

    const serialized = JSON.stringify(sink.snapshot());
    assert.ok(!serialized.includes(JWT), serialized);
    assert.ok(!serialized.includes('mc_jwt='), serialized);
  });

  it('redacts what a console actually prints for an error, not just its message', () => {
    const sink = new MemoryLogSink();
    const logger = createLogger({ namespace: 'mg:test', level: 'debug', sink });

    const refused = new Error(`socket refused header Cookie: mc_jwt=${JWT}`);
    logger.error('connect failed', new Error('connect failed', { cause: refused }));

    // `JSON.stringify` is NOT the right probe here, and asserting on it is how the test above passes on
    // unfixed code: an `Error` serialises to `{}` because `message` and `stack` are non-enumerable, so the
    // only copy of the message that survives serialisation is the one inside `stack`. `inspect` is what
    // `console.error` prints and therefore what a pasted bug report contains, cause chain included.
    const printed = inspect(sink.snapshot()[0]?.error);
    // The cause is reached and printed, and that is what makes its redaction worth asserting: unchecked, the
    // raw token came back one level down with a scrubbed message sitting right beside it.
    assert.ok(printed.includes('socket refused header'), printed);
    assert.ok(!printed.includes(JWT), printed);
    // The cookie *name* survives on purpose, and the value is what goes, so this can only assert the exact
    // redacted shape, never the absence of `mc_jwt=`.
    assert.match(printed, /mc_jwt=\[redacted\]/);
  });

  it('keeps the fields a sink branches on when it rewrites an error', () => {
    const sink = new MemoryLogSink();
    const logger = createLogger({ namespace: 'mg:test', level: 'debug', sink });

    const failure = Object.assign(new Error(`refused: mc_jwt=${JWT}`), {
      code: 'config_headers_unsupported',
    });
    logger.error('connect failed', failure);

    const scrubbed = sink.snapshot()[0]?.error as { code?: unknown; name?: unknown; message?: unknown };
    assert.equal(scrubbed.code, 'config_headers_unsupported', 'the machine-readable half must survive');
    assert.equal(scrubbed.name, 'Error');
    assert.ok(!String(scrubbed.message).includes(JWT));
  });

  it('leaves ordinary records alone', () => {
    const sink = new MemoryLogSink();
    const logger = createLogger({ namespace: 'mg:test', level: 'debug', sink });

    logger.warn('not reconnecting', { reason: 'auth', attempt: 3 });

    assert.deepEqual(sink.snapshot()[0]?.fields, { reason: 'auth', attempt: 3 });
  });
});
