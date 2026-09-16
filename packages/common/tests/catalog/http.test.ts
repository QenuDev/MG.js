/**
 * The catalogue fetch wrapper's byte cap.
 *
 * `maxBytes` is documented as a bound on a hostile or broken endpoint, so it has to be a bound: the
 * reader must stop pulling once the cap is passed and tear the source down, rather than buffering the
 * whole body and then comparing a string length (which both reads everything first and measures UTF-16
 * code units rather than bytes).
 *
 * `fetch` defaults to the global one and `FetchJsonOptions.fetch` injects another, so these tests cover
 * both: the cap and redirect suites stub `globalThis.fetch`, and the `fetchJson injected fetch` suite below
 * proves that the same call — headers, timeout, byte cap, redirect policy — reaches an injected stub
 * instead. Either way the stub hands back real `Response` objects: a plain `{ text() }`-shaped stub has no
 * `body` and would quietly exercise a different path from production.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import { DEFAULT_HEADERS, fetchJson, HttpError } from '../../src/catalog/http.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Serve one canned response to every request the code under test makes. */
function stubFetch(response: Response): void {
  globalThis.fetch = (async () => response) as typeof fetch;
}

/** Run a promise and hand back whatever it rejected with, so the error itself can be inspected. */
async function catchThrown(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
}

/** A byte source that enqueues `chunkBytes` at a time up to `totalBytes`, recording what was pulled. */
function byteStream(
  totalBytes: number,
  chunkBytes: number,
  counters: { pulled: number; cancelled: boolean },
) {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (counters.pulled >= totalBytes) {
        controller.close();
        return;
      }
      counters.pulled += chunkBytes;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x41));
    },
    cancel() {
      counters.cancelled = true;
    },
  });
}

describe('fetchJson byte cap', () => {
  it('aborts instead of buffering a body over the cap', async () => {
    const counters = { pulled: 0, cancelled: false };
    stubFetch(new Response(byteStream(256, 64, counters)));

    const error = await catchThrown(fetchJson('https://example.test/x', { maxBytes: 100 }));

    assert.ok(error instanceof HttpError, 'an over-cap body must be refused');
    assert.match(error.message, /exceeded 100 bytes/);
    assert.equal(counters.cancelled, true, 'the reader must cancel the source, not drain it');
    // 100 bytes in 64-byte chunks is two reads: the reader must stop within one prefetch of the cap,
    // and must never reach the body's 256 bytes.
    assert.ok(counters.pulled <= 192, `the reader stopped after ${counters.pulled} bytes`);
    assert.ok(counters.pulled < 256, `the reader pulled the whole ${counters.pulled}-byte body`);
  });

  it('counts bytes, not UTF-16 code units', async () => {
    // Valid JSON, so the only thing under test is which unit the cap is measured in: 62 code units but
    // 122 UTF-8 bytes (60 two-byte `é` plus two one-byte quotes).
    const payload = 'é'.repeat(60);
    const body = JSON.stringify(payload);
    assert.equal(body.length, 62, 'the guard needs a code-unit length under the cap');
    assert.equal(new TextEncoder().encode(body).byteLength, 122, 'the byte length the cap must measure');
    stubFetch(new Response(body));

    const error = await catchThrown(fetchJson('https://example.test/x', { maxBytes: 100 }));

    assert.ok(error instanceof HttpError, 'a 122-byte body resolved under a 100-byte cap');
    assert.match(error.message, /100 bytes/);
  });

  it('refuses a declared content-length over the cap without reading the body', async () => {
    // Finite, so that an implementation which ignores the declaration terminates and fails the pull
    // bound instead of draining an endless body and hanging the whole test file.
    const counters = { pulled: 0, cancelled: false };
    stubFetch(new Response(byteStream(4096, 64, counters), { headers: { 'content-length': '4096' } }));

    const error = await catchThrown(fetchJson('https://example.test/x', { maxBytes: 100 }));

    assert.ok(error instanceof HttpError, 'a declared oversized body must be refused');
    // The declared-size message can only come from the branch that runs before `body.getReader()`.
    assert.match(error.message, /declared 4096 bytes/);
    // `new Response(stream)` itself buffers one 64-byte chunk asynchronously, so one chunk is the floor;
    // anything more means our reader opened the body and the declaration did not short-circuit it.
    assert.ok(
      counters.pulled <= 64,
      `the declared size must short-circuit the read (pulled ${counters.pulled})`,
    );
    assert.ok(counters.pulled < 4096, `the declared oversized body was drained (${counters.pulled} bytes)`);
  });

  it('cancels the body when the declared content-length is over the cap', async () => {
    // `onExceeded` is optional at `readCapped`'s boundary and, when `fetchJson` does pass it, its only
    // effect is `controller.abort()` on the *request*. A platform that has already delivered the headers
    // is not obliged to tear the body down for that, so a caller that omits `onExceeded` depends on
    // `readCapped` cancelling the body itself. This stub ignores the request signal, which is the same
    // situation: the stream is only cancelled if the branch cancels it.
    const counters = { pulled: 0, cancelled: false };
    let aborted = false;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      return new Response(byteStream(4096, 64, counters), { headers: { 'content-length': '4096' } });
    }) as typeof fetch;

    const error = await catchThrown(fetchJson('https://example.test/x', { maxBytes: 100 }));

    assert.ok(error instanceof HttpError, 'a declared oversized body must be refused');
    assert.match(error.message, /declared 4096 bytes/);
    assert.equal(aborted, true, 'the declared branch must still abort the request');
    assert.equal(counters.cancelled, true, 'the declared branch must cancel the body, not just the request');
  });

  it('caps the error-path preview', async () => {
    // The cap is passed in 512-byte chunks, so the reader holds 1024 decoded characters when it stops:
    // well past the documented 300-character preview bound, so the assertion below is able
    // to fail. (Under `maxBytes: 64` the preview can never approach 300 and the bound is vacuous.)
    const counters = { pulled: 0, cancelled: false };
    stubFetch(new Response(byteStream(4096, 512, counters), { status: 500 }));

    const error = await catchThrown(fetchJson('https://example.test/x', { maxBytes: 1024 }));

    assert.ok(error instanceof HttpError, 'a 500 must be an HttpError');
    assert.equal(error.status, 500);
    assert.notEqual(error.bodyPreview, undefined, 'the preview is essential to the error path');
    const preview = error.bodyPreview ?? '';
    assert.ok(preview.length > 0, 'the preview must not be dropped');
    assert.equal(preview.length, 300, 'the preview must be truncated to the documented bound');
    assert.equal(counters.cancelled, true, 'the preview read must cancel the source');
    assert.ok(counters.pulled < 4096, `the preview read drained ${counters.pulled} bytes`);
  });

  it('still parses a normal small response', async () => {
    stubFetch(new Response(JSON.stringify({ hello: 'world' }), { status: 200 }));

    const value = await fetchJson<{ hello: string }>('https://example.test/x');

    assert.deepEqual(value, { hello: 'world' });
  });
});

describe('fetchJson redirect policy', () => {
  /**
   * Serve one canned response and record the request init, so a test can prove what `fetch` was *told*
   * before it is ever called. A stub that hands back a 302 does not by itself show the redirect was
   * refused: a real `fetch` performs the hop, so the only assertion here that discriminates the policy
   * is the `redirect` init.
   */
  function stubFetchCapturingInit(response: Response, calls: RequestInit[]): void {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return response;
    }) as typeof fetch;
  }

  const REDIRECT_LOCATION = 'http://127.0.0.1:9200/';

  it('tells fetch to refuse a redirect', async () => {
    const calls: RequestInit[] = [];
    stubFetchCapturingInit(
      new Response(null, { status: 302, headers: { Location: REDIRECT_LOCATION } }),
      calls,
    );

    const error = await catchThrown(fetchJson('https://a.test/data/plants'));

    // The stub returns the 302 rather than following it, so this count cannot show the redirect was
    // refused. What it does cover is that `fetchJson` issues exactly one request and does not retry the
    // 3xx itself; the `redirect` init below is the assertion that discriminates the policy.
    assert.equal(calls.length, 1, `fetchJson must not retry a 3xx (${calls.length} requests)`);
    assert.equal(calls[0]?.redirect, 'error', 'fetch must be told to refuse a redirect, not follow it');
    assert.ok(error instanceof HttpError, 'a 3xx must surface as an HttpError');
    // This status is the stubbed `Response`'s, not evidence that production names the refused hop: a real
    // `redirect: 'error'` rejection never yields a `Response` (see the null-status test below).
    assert.equal(error.status, 302, 'the stub response status is what this path reports');
    assert.match(error.message, /HTTP 302/);
  });

  it('reports a platform-refused redirect as a null-status HttpError', async () => {
    // The production shape for `redirect: 'error'`: the platform rejects the request itself on a 3xx, so
    // no `Response` reaches `fetchJson` and the error cannot name the hop it refused. The 302-returning
    // stubs above pin only the other shape.
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;

    const error = await catchThrown(fetchJson('https://a.test/data/plants'));

    assert.ok(error instanceof HttpError, 'a rejected fetch must still surface as an HttpError');
    assert.equal(error.status, null, 'a rejected fetch has no response to take a status from');
    assert.match(error.message, /Request to https:\/\/a\.test\/data\/plants failed/);
  });

  it('refuses a 3xx chain rather than reaching the target', async () => {
    // Two hops, each one pointing further away, but only the `redirect` init discriminates the policy: the
    // stub hands back each response without following a redirect, so the second and third responses are
    // never served whatever the policy is, and the call count only shows `fetchJson` made one request.
    const calls: RequestInit[] = [];
    const responses = [
      new Response(null, { status: 301, headers: { Location: 'http://evil.test/step-2' } }),
      new Response(null, { status: 302, headers: { Location: REDIRECT_LOCATION } }),
      new Response(JSON.stringify({ secret: 'metadata' }), { status: 200 }),
    ];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      const next = responses.shift() ?? new Response(null, { status: 500 });
      return next;
    }) as typeof fetch;

    const error = await catchThrown(fetchJson('https://a.test/data/plants'));

    assert.equal(calls.length, 1, `fetchJson must not walk the chain itself (${calls.length} requests)`);
    assert.equal(calls[0]?.redirect, 'error');
    assert.ok(error instanceof HttpError, 'the first hop must be refused outright');
    // The stub response's own status, as above. This is not a claim that production names the refused hop.
    assert.equal(error.status, 301, 'the stub response status is what this path reports');
  });

  it('honours an explicit follow policy', async () => {
    const calls: RequestInit[] = [];
    stubFetchCapturingInit(new Response(JSON.stringify({ ok: true }), { status: 200 }), calls);

    const value = await fetchJson<{ ok: boolean }>('https://a.test/data/plants', {
      redirectPolicy: 'follow',
    });

    assert.equal(calls[0]?.redirect, 'follow');
    assert.deepEqual(value, { ok: true });
  });
});

/**
 * The injected-`fetch` seam, exercised through the same call the global one goes through.
 *
 * The point of these tests is not "an argument is forwarded": it is that injecting a `fetch` changes
 * *only* which function is called. The headers, the timeout, the byte cap and the redirect policy are all
 * still supplied by `fetchJson`, so a caller that stubs the seam is testing the production path rather
 * than a parallel one — which is what makes an offline fixture a fair substitute for a host.
 */
describe('fetchJson injected fetch', () => {
  it('calls the injected fetch and never the global one', async () => {
    let globalCalled = false;
    globalThis.fetch = (async () => {
      globalCalled = true;
      throw new Error('the global fetch must not be reached when one is injected');
    }) as typeof fetch;

    const requested: string[] = [];
    const injected = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const value = await fetchJson<{ ok: boolean }>('https://injected.test/data/version', {
      fetch: injected,
    });

    assert.deepEqual(value, { ok: true });
    assert.deepEqual(requested, ['https://injected.test/data/version']);
    assert.equal(globalCalled, false, 'the global was called as well as the injected fetch');
  });

  it('supplies the default headers, a caller override and a live signal to the injected fetch', async () => {
    const calls: RequestInit[] = [];
    const injected = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await fetchJson('https://injected.test/data/plants', {
      fetch: injected,
      headers: { Accept: 'application/vnd.mg+json', 'X-Test': '1' },
    });

    const init = calls[0] ?? {};
    const headers = (init.headers ?? {}) as Record<string, string>;
    assert.equal(headers['User-Agent'], DEFAULT_HEADERS['User-Agent']);
    assert.equal(headers.Accept, 'application/vnd.mg+json', 'the caller override must win');
    assert.equal(headers['X-Test'], '1');
    assert.ok(init.signal instanceof AbortSignal, 'the injected fetch must be given the timeout signal');
    assert.equal(init.signal.aborted, false);
  });

  it('refuses a redirect at the injected fetch, and follows one when the caller asks', async () => {
    const calls: RequestInit[] = [];
    const injected = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await fetchJson('https://injected.test/a', { fetch: injected });
    await fetchJson('https://injected.test/b', { fetch: injected, redirectPolicy: 'follow' });

    assert.equal(calls[0]?.redirect, 'error');
    assert.equal(calls[1]?.redirect, 'follow');
  });

  it('applies the byte cap to a body the injected fetch returned', async () => {
    const counters = { pulled: 0, cancelled: false };
    const injected = (async () => new Response(byteStream(256, 64, counters))) as typeof fetch;

    const error = await catchThrown(fetchJson('https://injected.test/x', { fetch: injected, maxBytes: 100 }));

    assert.ok(error instanceof HttpError, 'the cap must still refuse an injected response');
    assert.match(error.message, /exceeded 100 bytes/);
    assert.equal(counters.cancelled, true, 'the reader must cancel the injected body, not drain it');
  });

  it('aborts the injected fetch when the timeout expires', async () => {
    let signalAborted = false;
    const injected = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal, 'the injected fetch must be given a signal, or nothing can time it out');
        signal.addEventListener('abort', () => {
          signalAborted = true;
          const abortError = new Error('aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        });
      })) as typeof fetch;

    const error = await catchThrown(
      fetchJson('https://injected.test/slow', { fetch: injected, timeoutMs: 5 }),
    );

    assert.ok(error instanceof HttpError, 'a timed-out injected fetch must surface as an HttpError');
    assert.match(error.message, /timed out after 5ms/);
    assert.equal(signalAborted, true, 'the timeout must reach the injected fetch as an abort');
  });

  it('carries a real request to a fixture host on an ephemeral port', async () => {
    // The other half of the seam: the injected fetch is a real one here, wrapped, and the request is
    // answered by a socket on 127.0.0.1 that this test opened. No DNS, no outside network, and the URL
    // the wrapper saw is the URL the fixture host answered.
    const received: string[] = [];
    const server = createServer((request, response) => {
      received.push(request.url ?? '');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ path: request.url }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const injectedUrls: string[] = [];
    const realFetch = globalThis.fetch;
    const wrapper = (async (input: RequestInfo | URL, init?: RequestInit) => {
      injectedUrls.push(String(input));
      return realFetch(input, init);
    }) as typeof fetch;

    const url = `http://127.0.0.1:${port}/data/version`;
    try {
      const value = await fetchJson<{ path: string }>(url, { fetch: wrapper });

      assert.deepEqual(value, { path: '/data/version' });
      assert.deepEqual(injectedUrls, [url], 'the injected wrapper is what made the request');
      assert.deepEqual(received, ['/data/version'], 'the fixture host must have answered it');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
