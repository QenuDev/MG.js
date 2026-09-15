/**
 * `CookieAuthProvider`: the authenticated (Discord account) path.
 *
 * Protocol recon §3.1, verbatim:
 *
 *   > "Send a `Cookie` header carrying `mc_jwt=<token>`. The token comes from the Discord OAuth2 flow
 *   > the game itself uses; nothing here mints one for you. No player id goes in the URL, because the server
 *   > assigns it and reports it back in `Welcome.selfPlayerId`."
 *
 * So this provider contributes exactly one thing, a `Cookie` header, and nothing to the query
 * string. Two consequences are worth naming:
 *
 *   - **The failure mode of the header channel is auth failure.** `globalThis.WebSocket` cannot send
 *     headers (see `transport/headers.ts`), so on the default runtime a cookie connect silently
 *     becomes an anonymous one and the server closes with `4800` ("bad/expired `mc_jwt` cookie, or a
 *     player record was found with none of the expected identity fields", §3.4/§1.8). `HeadlessClient`
 *     logs that degradation explicitly, and `HeadlessClientOptions.requireHeadersForAuth` turns it
 *     into a hard error for callers who would rather fail fast than be silently anonymous.
 *   - **Nothing here mints or refreshes a token.** §3.4 is explicit that no token refresh and no
 *     login message are documented, so `token`/`getToken` are the caller's problem. The getter form
 *     exists so a long-lived bot can re-read a rotated cookie from disk on every reconnect attempt
 *     without constructing a new client.
 *
 * The class accepts either a raw token (`mc_jwt`'s value) or a full cookie string
 * (`mc_jwt=...; other=...`), because both are what a browser's devtools hands you and guessing wrong is a
 * silent `4800`. A full cookie string is detected by the presence of `=`; that rule is conservative
 * by design, because a bare JWT is base64url and never contains `=` (JWTs are three dot-separated
 * base64url segments), so the two cases cannot collide.
 */

import { MgConfigError } from '../errors.js';
import type { AuthContribution, AuthProvider } from './types.js';

/** The cookie name the server looks for, per §3.1. */
export const MC_JWT_COOKIE = 'mc_jwt';

/** Options for {@link CookieAuthProvider}. */
export interface CookieAuthProviderOptions {
  /**
   * A raw `mc_jwt` token, or a complete `Cookie:` header value.
   *
   * Mutually exclusive with {@link getCookie}: supply exactly one. Passing neither throws on the first
   * `prepare()`, because a cookie provider with no cookie is a configuration error, not a guest.
   */
  token?: string | undefined;
  /**
   * Read the cookie lazily, once per connect attempt.
   *
   * This is the form to use when the token is refreshed out-of-band: a reconnect that happens hours
   * after construction will pick up the new value.
   */
  getCookie?: (() => string | undefined | Promise<string | undefined>) | undefined;
  /**
   * Extra cookies to append after `mc_jwt`, as a pre-formatted `a=b; c=d` string. It is optional and
   * rare, included so a caller with a captured browser cookie jar does not have to string-splice it.
   */
  extraCookies?: string | undefined;
}

/**
 * True when the string already looks like a whole `Cookie` header rather than a bare token.
 *
 * Discriminated on the cookie *name*, not on the presence of `=`. The earlier version tested
 * `value.includes('=')`, on the reasoning that "a bare JWT is base64url and never contains `=`", but
 * base64url padding *is* `=`, so a caller pasting a padded token was silently treated as a whole `Cookie`
 * header, sent with no `mc_jwt=` prefix, and rejected as an auth failure with nothing pointing at the
 * cause.
 *
 * `mg-afk-android` uses this same discriminator (`IdGenerator.kt`: `if (trimmed.contains("mc_jwt"))
 * trimmed else "mc_jwt=$trimmed"`).
 */
function looksLikeCookieString(value: string): boolean {
  return value.includes('mc_jwt');
}

/** Which caller-supplied option a validation failure is about. */
export type CookieHeaderValidationField = 'token' | 'extraCookies';

/**
 * A validation failure that is the caller's fault.
 *
 * `field` is the only identifying detail: a message that quoted the rejected value would itself become
 * the leak this whole rule exists to close, and error text is what gets pasted into an issue.
 */
export interface CookieHeaderValidationError {
  /** The option name the caller must fix. */
  field: CookieHeaderValidationField;
  /** Why it was rejected, without the value. */
  detail: string;
}

/**
 * True when the value contains a C0 control character or DEL.
 *
 * A code-point walk rather than a character class: Biome's `noControlCharactersInRegex` (correctly)
 * refuses a literal control-character range in a regex, and the property escape `\p{Cc}` pulls in the
 * `u` flag and Unicode mode for what is a five-line predicate. CR and LF are the ones that matter:
 * `Cookie: mc_jwt=x\r\nX-Evil: 1` is two headers on a socket that does not strip them. They are
 * not special here, though, because every control character is illegal in a cookie value, so all of
 * them are refused.
 */
function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validate a token (or a complete `Cookie` header value) before it becomes a request header.
 *
 * This lives beside the cookie syntax rather than in `session.ts` because *both* entry points into a
 * header need it: the provider interpolates a token here, and the probe builds the same header next door.
 * It previously lived in `session.ts` and only the probe called it, so the identical token was refused on
 * the probe path and accepted on the connect path. A rule enforced at one of two entry points is not a
 * rule; the function moved down to where the header is actually made.
 *
 * WHAT IS REJECTED, AND WHY IT IS NOT JUST CR/LF
 * ----------------------------------------------
 * CR and LF are refused for *safety*: `Cookie: mc_jwt=x\r\nX-Evil: 1` is two headers once it reaches a
 * socket that does not strip them, so the reference browser-based clients can get away with a
 * raw interpolation and a standalone client cannot. The rest of the charset is refused for *diagnosis*:
 * the field guide says the failure mode of a bad token is an unexplained `4800`/`4840`, so a token
 * containing a space or another character outside the cookie charset is worth diagnosing as what it is.
 *
 * The charset is the conservative ASCII subset RFC 6265 allows in a cookie *value*
 * (`[A-Za-z0-9!#$%&'*+\-.^_`|~]`, plus `=` for base64url padding), applied per cookie pair. A complete
 * `Cookie` header string is accepted, because callers paste one from devtools, but its name and value
 * are checked separately, and an empty name or value is refused. Being conservative means a captured jar
 * containing an exotic-but-legal cookie (a quoted value, a comma, a colon) is refused loudly at
 * `prepare()` with the option named, rather than silently becoming an auth failure at the server.
 *
 * Callers pass the value they are about to put in the header, so whitespace should already be trimmed:
 * a trailing newline from a token read out of a file is not injection, and refusing it would be a
 * usability bug rather than a safety one.
 *
 * Returns `null` when the value is usable. Never includes the value in `detail`.
 */
export function validateCookieHeaderValue(
  value: string,
  field: CookieHeaderValidationField = 'token',
): CookieHeaderValidationError | null {
  if (containsControlCharacter(value)) {
    return {
      field,
      detail:
        'contains a control character (CR/LF or similar), which would inject a header. Pass the raw ' +
        'token only, with no line breaks.',
    };
  }

  const pairs = value.split(';');
  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) {
      // A bare token: the caller passed the `mc_jwt` value itself, so the whole pair is the value.
      if (!/^[A-Za-z0-9._~+/=-]+$/.test(trimmed)) {
        return {
          field,
          detail: 'is not a cookie value (expected the mc_jwt token charset, or a complete Cookie header).',
        };
      }
      continue;
    }
    const name = trimmed.slice(0, separator);
    const pairValue = trimmed.slice(separator + 1);
    if (!/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(name)) {
      return { field, detail: 'has an invalid cookie name (outside the cookie-name charset).' };
    }
    if (pairValue.length === 0) {
      return { field, detail: 'has an empty cookie value.' };
    }
    if (!/^[A-Za-z0-9!#$%&'*+\-.^_`|~=/]+$/.test(pairValue)) {
      return {
        field,
        detail:
          'has a character outside the cookie-value charset (spaces and semicolons included). Pass the ' +
          'raw token, not a partial header.',
      };
    }
  }
  return null;
}

/** Turn a validation failure into the config error the connect path reports. */
function cookieConfigError(problem: CookieHeaderValidationError): MgConfigError {
  return new MgConfigError(
    `CookieAuthProvider: \`${problem.field}\` ${problem.detail} The rejected value is not ` + 'echoed here.',
    // Explicit, not defaulted: the shared `MgConfigError` defaults to `'config_invalid'`, and this
    // narrower code is a stable string a caller may already branch on.
    'config_invalid_token',
  );
}

/**
 * Build a `Cookie` header value from whatever the caller supplied.
 *
 * Exported for testing: the raw-token vs cookie-string discrimination is the kind of thing
 * that is wrong in a way nobody notices until production auth breaks.
 */
export function toCookieHeader(value: string, extraCookies?: string): string {
  const trimmed = value.trim();
  const base = looksLikeCookieString(trimmed) ? trimmed : `${MC_JWT_COOKIE}=${trimmed}`;
  if (extraCookies === undefined || extraCookies.trim().length === 0) return base;
  return `${base}; ${extraCookies.trim()}`;
}

/** Extracts the `mc_jwt` value from a cookie string, for non-secret logging. */
function describeCookie(header: string): string {
  const match = /(?:^|;\s*)mc_jwt=([^;]*)/.exec(header);
  const value = match?.[1];
  if (value === undefined) return 'cookie carries no mc_jwt field';
  return `mc_jwt present (${value.length} chars)`;
}

/** The authenticated path: `Cookie: mc_jwt=<token>`. */
export class CookieAuthProvider implements AuthProvider {
  readonly id = 'cookie';
  readonly authenticated = true;

  private readonly options: CookieAuthProviderOptions;

  constructor(options: CookieAuthProviderOptions) {
    if (options.token === undefined && options.getCookie === undefined) {
      throw new TypeError(
        'CookieAuthProvider requires either `token` (raw mc_jwt value or a full Cookie header) or ' +
          '`getCookie` (read lazily on every connect attempt).',
      );
    }
    this.options = options;
  }

  /** Convenience: a provider from a complete `Cookie:` header value captured from a browser. */
  static fromCookieHeader(header: string): CookieAuthProvider {
    return new CookieAuthProvider({ token: header });
  }

  async prepare(): Promise<AuthContribution> {
    let raw: string | undefined;
    if (this.options.getCookie) {
      const read = await this.options.getCookie();
      raw = read ?? this.options.token;
    } else {
      raw = this.options.token;
    }

    if (raw === undefined || raw.trim().length === 0) {
      throw new TypeError(
        'CookieAuthProvider has no cookie: `token`/`getCookie` resolved to an empty value. ' +
          'Connecting without one would authenticate as a guest. Use GuestAuthProvider if that is ' +
          'what you want.',
      );
    }

    // Validate before anything becomes a header, on the trimmed values that are about to be interpolated.
    // `toCookieHeader` trims for the same reason, so a token read out of a file with a trailing newline is
    // fine while an embedded CR/LF is not.
    const value = raw.trim();
    const tokenProblem = validateCookieHeaderValue(value);
    if (tokenProblem !== null) throw cookieConfigError(tokenProblem);

    const extra = this.options.extraCookies?.trim();
    if (extra !== undefined) {
      const extraProblem = validateCookieHeaderValue(extra, 'extraCookies');
      if (extraProblem !== null) throw cookieConfigError(extraProblem);
    }

    const header = toCookieHeader(value, extra);
    return {
      headers: { Cookie: header },
      note: describeCookie(header),
    };
  }
}
