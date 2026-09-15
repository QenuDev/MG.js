/**
 * The authentication seam.
 *
 * Protocol recon §3 ("Authentication / identity / session") opens with the single most important
 * fact about this protocol's auth:
 *
 *   > "Two ways to authenticate, both set at connect time: there's no separate login message."
 *
 * That sentence is the reason this interface exists in the shape it does. There is no `Login` action
 * and no token-refresh message to model (the doc says so explicitly: "no documented token refresh, no
 * documented login/logout message"). Auth is therefore *not* a stateful participant in the session.
 * It is a pure contributor to (a) the connect URL and (b) the connect headers. Both of those are
 * decided once per connection attempt, so `prepare()` is async and called per attempt: a
 * provider that reads an expiring token from disk or refreshes one out-of-band must be free to do so
 * before every reconnect, not just the first.
 *
 * The three contributions are named exactly as the wire uses them, because the two paths
 * differ, and this is not cosmetic:
 *
 *   - **Authenticated (Discord account, §3.1)**: `Cookie: mc_jwt=<token>` **header**. Nothing goes in
 *     the URL: "No player id goes in the URL; the server assigns it and reports it back in
 *     `Welcome.selfPlayerId`."
 *   - **Guest (anonymous, §3.2)**: `anonymousUserStyle=<json>` **query parameter**, and no cookie at
 *     all.
 *
 * A provider may contribute both maps; a provider that contributes neither is the degenerate
 * "whatever the server does by default" case, which is legal but should be an explicit choice.
 */

/** What one auth provider contributes to a single connect attempt. */
export interface AuthContribution {
  /**
   * Extra query parameters, appended to the connect URL.
   *
   * Values are inserted with `URLSearchParams`, so the provider supplies the *final wire string*,
   * including JSON quoting where the protocol requires it. See `guest.ts` for why that matters: the
   * connect URL's rule is that "every value in the query string is JSON-encoded", and
   * `anonymousUserStyle` is a JSON *object* serialised into that quoted form.
   */
  query?: Record<string, string> | undefined;
  /**
   * Extra HTTP headers.
   *
   * Honoured only when the resolved WebSocket runtime can carry headers; see
   * `transport/headers.ts`. The global WHATWG `WebSocket` silently drops them, so the authenticated
   * path requires an injected/adapted constructor; `HeadlessClient` logs the degradation rather than
   * pretending the cookie was sent.
   */
  headers?: Record<string, string> | undefined;
  /**
   * Optional human-readable note, surfaced in logs at connect time.
   *
   * Must **not** carry the token itself: this value is written to a log sink, and a
   * provider that wants to report which account it is using should report a stable non-secret
   * identifier. `cookie.ts` reports the token length, not the token.
   */
  note?: string | undefined;
}

/**
 * Something that can prepare the credentials for one connect attempt.
 *
 * `id` is a stable, non-secret label used in logs and in the client's `auth` accessor.
 */
export interface AuthProvider {
  /** Stable label, e.g. `'cookie'` or `'guest'`. Never contains credentials. */
  readonly id: string;
  /** True when this provider supplies a real identity rather than a server-assigned guest one. */
  readonly authenticated: boolean;
  /**
   * Produce this attempt's contribution.
   *
   * Called once per connect attempt, before the URL is built. Implementations should be total
   * (never throw for ordinary conditions) but *may* throw when they are unusable: a cookie provider
   * with no token is a configuration error, and failing at the first connect beats connecting as a
   * guest and receiving a `4800` close with no explanation.
   */
  prepare(): Promise<AuthContribution>;
}

/**
 * An {@link AuthProvider} backed by a constant contribution.
 *
 * Useful for tests and for hosts that resolve credentials elsewhere. Exported because writing this
 * three-line adapter in every consumer is noise.
 */
export class StaticAuthProvider implements AuthProvider {
  readonly id: string;
  readonly authenticated: boolean;
  private readonly contribution: AuthContribution;

  constructor(id: string, contribution: AuthContribution, options: { authenticated?: boolean } = {}) {
    this.id = id;
    this.contribution = contribution;
    this.authenticated = options.authenticated ?? false;
  }

  async prepare(): Promise<AuthContribution> {
    return this.contribution;
  }
}
