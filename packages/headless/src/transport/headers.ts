/**
 * Connect-time HTTP headers: `Origin` and a desktop-Chrome `User-Agent`.
 *
 * WHY THESE TWO, AND WHY THIS FILE IS MOSTLY A CAVEAT
 * --------------------------------------------------
 * Protocol recon §3.3 ("Handshake headers"):
 *
 *   > "Also set a normal-looking `Origin` header (`https://<host>`) and a real desktop-Chrome
 *   > `User-Agent`, consistent with `platform="desktop"` in the query string, in case anything
 *   > server-side cross-checks the two."
 *
 * The origin is the **page** origin, `https://magicgarden.gg`, not the `wss://` socket URL. A
 * browser would send the page origin automatically; a Node client must be able to claim it, which is
 * the thing the WHATWG API does not allow.
 *
 * THE ONE THING THIS FILE MUST NOT DO IS PRETEND. `globalThis.WebSocket` in Node accepts a third
 * constructor argument and silently discards it. Verified on this box against a local `ws` server:
 * with `{ headers: { Origin: 'https://magicgarden.gg', 'User-Agent': 'probe/1.0' } }` the server
 * received `user-agent: node`, no `origin`, no `cookie`. So {@link buildConnectHeaders} always
 * *computes* the intended headers, and the transport only *applies* them when the resolved runtime
 * says it forwards an `options.headers` bag ({@link WebSocketRuntime.supportsHeaders}). When it does
 * not, the outcome is reported as a log record naming the degradation. The guest path still works,
 * because everything it needs lives in the query string; the cookie path does not, and the caller
 * needs to hear that rather than watch a 4800 close with no explanation.
 *
 * There is no agreed way to pass headers to an injected factory other than `options.headers`, so that
 * is the one key used; it is what the `ws` package reads, which is the adapter this package documents.
 */

/** The page origin the real client presents. */
export const DEFAULT_ORIGIN = 'https://magicgarden.gg';

/**
 * A real desktop-Chrome user agent.
 *
 * Pinned rather than synthesised from `process.version`: the header exists to make the connection look
 * like the game's own browser client, and a UA containing "Node.js/22" does the opposite. The version numbers
 * are a real, shipped desktop Chrome on Windows, matching what the reference mods send.
 */
export const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';

/** The header set the real client presents at connect time. */
export interface ConnectHeaders {
  Origin: string;
  'User-Agent': string;
  /** Only present for the authenticated (cookie) path. */
  Cookie?: string;
}

/** Options for {@link buildConnectHeaders}. */
export interface BuildConnectHeadersOptions {
  /**
   * Page origin. Default `https://magicgarden.gg`.
   *
   * Overridable because a test harness, or a reverse-engineered deployment, may present a different
   * page origin, and hard-coding one would make that impossible without patching this file.
   */
  origin?: string;
  /** Overrides the pinned desktop-Chrome UA. */
  userAgent?: string;
  /**
   * Additional headers contributed by an {@link AuthProvider}.
   *
   * Merged after the defaults, so a provider can override `Origin` if a build ever needs it, but the
   * bare defaults are always present.
   */
  extra?: Record<string, string> | undefined;
}

/**
 * Build the connect header set.
 *
 * Pure and total: never throws, always returns at least `Origin` and `User-Agent`.
 */
export function buildConnectHeaders(options: BuildConnectHeadersOptions = {}): ConnectHeaders {
  const headers: ConnectHeaders = {
    Origin: options.origin ?? DEFAULT_ORIGIN,
    'User-Agent': options.userAgent ?? DESKTOP_CHROME_UA,
  };

  if (options.extra) {
    for (const [key, value] of Object.entries(options.extra)) {
      if (typeof value === 'string' && value.length > 0) {
        // Header names are case-insensitive on the wire; keep the caller's spelling but let a
        // provider's `Cookie` land on the canonical key so `hasCookie` and logging stay truthful.
        if (key.toLowerCase() === 'cookie') headers.Cookie = value;
        else (headers as unknown as Record<string, string>)[key] = value;
      }
    }
  }

  return headers;
}

/**
 * The query-string equivalent of the `Origin` header, when the URL host differs from the page origin.
 *
 * NOTHING DOCUMENTED REQUIRES THIS. It exists only to make an overridden `origin` observable, and is
 * `null` in the normal case (socket host `magicgarden.gg`, page origin `https://magicgarden.gg`), so
 * it adds no query parameters to a normal connect. It is never sent to the server by default, because
 * inventing an undocumented query parameter for a real connect is worse than dropping a header.
 */
export function originQueryHint(socketHost: string, origin: string): string | null {
  try {
    const originHost = new URL(origin).host;
    return originHost === socketHost ? null : originHost;
  } catch {
    return null;
  }
}
