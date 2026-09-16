/**
 * A small fetch wrapper with a timeout, a byte cap and a browser-shaped default User-Agent.
 *
 * The existing server sends four different UAs across its fetches, one of which is headerless. This
 * keeps one, and adds the timeout the existing server lacks entirely. That server has "no retry/size-cap",
 * which is how a single slow upstream turns into a hung request.
 *
 * The size cap is a real one: bytes are counted **while streaming** and the body is cancelled as soon
 * as {@link DEFAULT_MAX_RESPONSE_BYTES} (or `maxBytes`) is crossed, so a hostile or broken endpoint
 * cannot make this buffer an unbounded response first. The cap therefore bounds what is *read*, not
 * merely what is accepted. See {@link readCapped}.
 */

/** Default headers, matching a desktop Chrome client like the game's own. */
export const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

export interface FetchJsonOptions {
  /** Abort after this many ms. Default 10000. */
  timeoutMs?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * The `fetch` to call, instead of the global one.
   *
   * Defaults to `globalThis.fetch`. Supplying one is how a caller reaches this helper with a `fetch` the
   * library cannot know about — a page's own wrapper, a runtime with a proxy dispatcher — and how a test
   * stubs a request without patching a global. The seam is the whole of the injection: everything else
   * about the call is still this function's, and still applies to whatever it is handed. The default
   * headers, the timeout, the byte cap and the redirect policy below are arguments passed *to* this
   * `fetch`, so an injected stub is exercised through the same path production uses rather than beside it.
   */
  fetch?: typeof fetch;
  /**
   * Cap on the response size in bytes, to bound a hostile or broken endpoint.
   * Default `DEFAULT_MAX_RESPONSE_BYTES` (8 MiB).
   */
  maxBytes?: number;
  /**
   * What to do with a 3xx. Default `'error'`: a redirect from a pinned origin is a rejection, not a hop.
   * Following one lets a compromised or hostile endpoint retarget the request (`302 Location:
   * http://127.0.0.1:9200/`) past the origin the caller pinned. Plain `'follow'` hands that decision to
   * the platform and should only be used against an origin that is trusted to redirect.
   *
   * There is no `'manual'`. Re-asserting the origin yourself needs the `Location` header, and
   * `fetchJson` never exposes the `Response`: {@link HttpError} carries only `status`, `url` and
   * `bodyPreview`, so a caller cannot inspect the hop through this API. An option whose documented use is
   * impossible is a defect, so it was removed rather than kept as inert surface.
   */
  redirectPolicy?: 'error' | 'follow';
}

/** An HTTP request that did not produce usable JSON. */
export class HttpError extends Error {
  readonly status: number | null;
  readonly url: string;
  readonly bodyPreview: string | undefined;

  constructor(
    message: string,
    options: { status?: number | null; url: string; bodyPreview?: string; cause?: unknown },
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = options.status ?? null;
    this.url = options.url;
    this.bodyPreview = options.bodyPreview;
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/** The default response cap, in bytes. Named so a caller and a test cannot disagree about it. */
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Knobs for {@link readCapped}, whose two callers want opposite things from an overflow. */
interface ReadCappedOptions {
  /** Called when the cap is passed, so the caller can tear the *request* down, not just the stream. */
  onExceeded?: () => void;
  /**
   * Return the bytes read before the cap was passed instead of throwing. Only the error path wants
   * this: its whole purpose is a bounded 300-character preview, so a truncated read beats no read,
   * but the stream is still cancelled rather than drained.
   */
  keepPartial?: boolean;
}

/**
 * Read a response body, refusing to assemble more than `maxBytes`.
 *
 * Counts real bytes as they arrive and cancels the stream the moment the cap is passed. `reader.cancel()`
 * tears the source down, so this is an abort rather than a truncation, and the bytes that were read are
 * discarded rather than decoded into a string. `content-length` is checked first when the server declares
 * one, which rejects a hostile body before a single byte is read and cancels the body it never reads. The
 * one caller that wants the bytes read so far can ask for them with `keepPartial`; the stream is still
 * cancelled.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
  url: string,
  options: ReadCappedOptions = {},
): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const size = Number(declared);
    if (Number.isFinite(size) && size > maxBytes) {
      options.onExceeded?.();
      // `onExceeded` is optional and, at this layer, only aborts the *request*: it never touches the body.
      // A caller that omits it (or a platform that has already delivered the headers) would otherwise
      // leave the stream open on the branch this cap exists for. Cancel the body here too, and
      // never let a cancel failure mask the real error.
      await response.body?.cancel().catch(() => undefined);
      if (options.keepPartial === true) return '';
      throw new HttpError(`Response from ${url} declared ${size} bytes, over the ${maxBytes} cap.`, {
        status: response.status,
        url,
      });
    }
  }

  const body = response.body;
  if (body === null) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        options.onExceeded?.();
        if (options.keepPartial === true) return text;
        throw new HttpError(`Response from ${url} exceeded ${maxBytes} bytes (aborted at ${total}).`, {
          status: response.status,
          url,
        });
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    // Cancels the underlying source on the overflow path and is a no-op once the stream is done.
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Fetch and parse JSON.
 *
 * @throws {HttpError} on a non-2xx status, a timeout, a network failure, or unparseable JSON, always
 *   with enough context to log, never a bare `TypeError: Failed to fetch`.
 */
export async function fetchJson<T = unknown>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Honour a caller-supplied signal alongside our timeout.
  const externalAbort = (): void => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', externalAbort, { once: true });
  }

  // Read once, so the injected fetch is the one the timeout and the byte cap below are wired to.
  const request = options.fetch ?? fetch;

  try {
    const response = await request(url, {
      headers: { ...DEFAULT_HEADERS, ...options.headers },
      signal: controller.signal,
      redirect: options.redirectPolicy ?? 'error',
    });

    if (!response.ok) {
      const body = await safeText(response, maxBytes, url, () => controller.abort());
      throw new HttpError(`HTTP ${response.status} for ${url}`, {
        status: response.status,
        url,
        ...(body !== undefined ? { bodyPreview: body.slice(0, 300) } : {}),
      });
    }

    const text = await readCapped(response, maxBytes, url, { onExceeded: () => controller.abort() });

    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new HttpError(`Response from ${url} was not valid JSON.`, {
        status: response.status,
        url,
        bodyPreview: text.slice(0, 300),
        cause: error,
      });
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const isAbort = error instanceof Error && error.name === 'AbortError';
    throw new HttpError(
      isAbort ? `Request to ${url} timed out after ${timeoutMs}ms.` : `Request to ${url} failed.`,
      { url, cause: error },
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', externalAbort);
  }
}

async function safeText(
  response: Response,
  maxBytes: number,
  url: string,
  onExceeded: () => void,
): Promise<string | undefined> {
  try {
    return await readCapped(response, maxBytes, url, { keepPartial: true, onExceeded });
  } catch {
    return undefined;
  }
}
