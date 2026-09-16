/**
 * Session acquisition and validation.
 *
 * ## The finding this file exists to encode
 *
 * The protocol field guide documents `Cookie: mc_jwt=<token>` as one of two ways to connect, alongside an
 * `anonymousUserStyle` guest parameter. It does not say how you *get* an `mc_jwt`, and it turns out that
 * is the whole problem.
 *
 * Analysis of two working clients by the same author, `Ariedam64/mg-afk-android` (Kotlin) and
 * `Ariedam64/MG-AFK` (Electron), established that:
 *
 *   1. **Neither establishes a session headlessly.** There is no `/session`, `/auth`, `/join`, `/login`,
 *      `/token` or `/guest` endpoint in either repo. Both run a real browser engine (Android `WebView`,
 *      Electron `BrowserWindow`) through Discord OAuth, then lift the `mc_jwt` cookie out of that
 *      browser's cookie jar and replay it as a plain `Cookie:` header on the WebSocket upgrade.
 *   2. **The cookie is the session.** Both hard-require it for the primary connection
 *      (`RoomClient.kt:225-227`, `index.js:117-119`).
 *   3. **The guest path, as documented, does not currently connect.** Every permutation of
 *      `anonymousUserStyle`, raw and JSON-quoted, one field and all six, and the parameter omitted
 *      entirely, is closed with `4840 SessionExpired` on game version 1158. See the caveat in
 *      `auth/guest.ts`.
 *
 * So a caller needs an `mc_jwt` from somewhere, and the honest thing this module can do is (a) document
 * exactly how the working clients obtain one, and (b) give you a way to check a token *without* opening
 * a socket, so a bad token is diagnosed in one request instead of an unexplained close.
 *
 * ## Two required cookies, not one
 *
 * Both reference clients pre-set **two** cookies before navigating to the Discord authorise URL, and they
 * are identical in both implementations:
 *
 *   - `mc_oauth_room_id` names the room the OAuth flow should return the user to. The reference
 *     clients use their own app name (`MgAFK`); the value appears to be a label rather than a real room
 *     slug.
 *   - `mc_oauth_redirect_uri` is `https://magicgarden.gg/oauth2/redirect`.
 *
 * They are set on `.magicgarden.gg` at path `/`. Omitting them makes the flow fail in a way that is not
 * reported back to the caller.
 *
 * ## What happens after the redirect
 *
 * The game finishes the Discord code exchange with an **asynchronous XHR** fired by the room page's own
 * JavaScript, which lands with no further navigation event. That is why both reference clients **poll**
 * the cookie jar rather than waiting for a page load. See `OAuthActivity.kt:41-52`, whose comment names
 * the request as `POST .../authenticate-web`. NOTE: that path is elided in the comment and is never
 * constructed by client code, so it is a *comment claim* about the game's own JS, not verified client
 * behaviour. Replicating the exchange outside a browser would require reversing the live bundle.
 *
 * ## This is why this module does NOT do OAuth for you
 *
 * There is no honest way to automate the exchange from Node without either driving a real browser or
 * guessing at `authenticate-web`. Guessing would produce something that appears to work until it does
 * not. What is provided instead is the validation half, which is fully verifiable, plus
 * {@link buildDiscordOAuthUrl} and {@link OAUTH_BOOTSTRAP_COOKIES} so that a caller driving a browser
 * (Playwright, Puppeteer, Electron, a WebView) has the exact constants and does not have to rediscover
 * them.
 */

import { redactCredentialString } from '@mg.js/common';
import { MC_JWT_COOKIE, toCookieHeader, validateCookieHeaderValue } from './auth/cookie.js';
import { MgConfigError } from './errors.js';

export type { CookieHeaderValidationError } from './auth/cookie.js';
/**
 * Re-exported because it was public from this module before the rule moved to `auth/cookie.js`, where the
 * header is actually built and where the provider can reach it without importing its own caller back. The
 * implementation has one home; this keeps the documented surface (`index.ts` lists it under session
 * validation) from moving for no reason a caller would care about.
 */
export { validateCookieHeaderValue };

/** The public Discord application id the game's OAuth flow uses. */
export const DISCORD_CLIENT_ID = '1227719606223765687';

/** Where Discord returns the user after authorisation. */
export const OAUTH_REDIRECT_URI = 'https://magicgarden.gg/oauth2/redirect';

/** The scopes the game requests. `identify` alone is not enough; the client asks for all three. */
export const OAUTH_SCOPES = ['identify', 'guilds.members.read', 'guilds'] as const;

/**
 * The two cookies that must exist before the OAuth navigation.
 *
 * Values are the reference clients' own; `roomId` is an app label rather than a real room slug.
 */
export const OAUTH_BOOTSTRAP_COOKIES = {
  roomId: 'mc_oauth_room_id',
  redirectUri: 'mc_oauth_redirect_uri',
} as const;

/**
 * Build the stock Discord authorise URL.
 *
 * @param options.roomId Label placed in the `mc_oauth_room_id` bootstrap cookie.
 */
export function buildDiscordOAuthUrl(options: { roomId?: string } = {}): string {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    response_type: 'code',
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPES.join(' '),
  });
  void options;
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

/**
 * The cookies to set on the browser context before navigating to the OAuth URL.
 *
 * Returned as plain objects so a caller can hand them to Playwright (`context.addCookies`), Electron
 * (`session.cookies.set`), or an Android `CookieManager` without translating anything.
 */
export function oauthBootstrapCookies(
  options: { roomId?: string } = {},
): { name: string; value: string; domain: string; path: string }[] {
  return [
    {
      name: OAUTH_BOOTSTRAP_COOKIES.roomId,
      value: options.roomId ?? 'mgjs',
      domain: '.magicgarden.gg',
      path: '/',
    },
    {
      name: OAUTH_BOOTSTRAP_COOKIES.redirectUri,
      value: OAUTH_REDIRECT_URI,
      domain: '.magicgarden.gg',
      path: '/',
    },
  ];
}

/** The cookie name that carries the session token. Re-exported for convenience. */
export const SESSION_COOKIE_NAME = MC_JWT_COOKIE;

/** Where the session can be checked without opening a socket. */
export function sessionProbePath(version: string, room: string): string {
  return `/version/${version}/api/rooms/${room}/me`;
}

export interface SessionProbeOptions {
  /** The `mc_jwt` value. Omit to check whether the room accepts an unauthenticated caller. */
  token?: string | undefined;
  /** A known-good game version. */
  version: string;
  /** The room slug the session should be valid for. */
  room: string;
  /** Origin, without a trailing slash. Default `https://magicgarden.gg`. */
  baseUrl?: string | undefined;
  /** Abort after this many ms. Default 10000. */
  timeoutMs?: number | undefined;
}

/**
 * Build the probe's `Cookie` header, or throw an {@link MgConfigError} naming the field.
 *
 * Exported so the validation is testable without a `fetch` stub. The safety property is about what is
 * *not* in the header and the message.
 */
export function buildProbeCookie(token: string): string {
  const problem = validateCookieHeaderValue(token);
  if (problem !== null) {
    throw new MgConfigError(
      `probeSession: \`${problem.field}\` ${problem.detail} The rejected value is not echoed here.`,
      // Explicit, not defaulted: the probe applies the same token rule as the cookie provider, and
      // `'config_invalid_token'` is the stable code both have always reported.
      'config_invalid_token',
    );
  }
  return toCookieHeader(token);
}

export interface SessionProbeResult {
  /** True when the server accepted the session. */
  valid: boolean;
  /** The HTTP status, or `null` when the request never completed. */
  status: number | null;
  /** Machine-readable outcome. */
  outcome: 'valid' | 'unauthorized' | 'not-found' | 'timeout' | 'network-error' | 'error';
  /** A classified reason code, safe to branch on. */
  code: 'accepted' | 'rejected' | 'room-not-found' | 'unexpected-status' | 'timeout' | 'network-error';
  /**
   * A human-readable explanation, safe to log.
   *
   * The transport's own text is never copied in verbatim: a `fetch` failure message can quote the
   * request it was building, so it is redacted and the classification above is what callers should use.
   */
  reason: string;
}

/**
 * Check whether a session token is accepted, without opening a WebSocket.
 *
 * VERIFIED BEHAVIOUR: `GET /version/<v>/api/rooms/<room>/me` answers **401** when the session is absent
 * or dead. Removing the socket from the equation matters: a bad token and a protocol mistake both
 * surface as an unexplained close code otherwise, and this tells them apart in a single request.
 *
 * Never throws, and that is on purpose: a probe that throws is a probe a caller stops using. There is one
 * exception:
 * a token that cannot legally become a header value is a *programming* error, not a session outcome, and
 * is rejected with an {@link MgConfigError} before a request is dispatched. Reporting that as
 * `{ valid: false }` would tell the caller "your session is bad" when the truth is "your input is bad",
 * and there is no request to make.
 *
 * The `reason` field is documented as safe to log, so the transport's own message is redacted before it
 * gets there. `code` is the stable classification.
 */
export async function probeSession(options: SessionProbeOptions): Promise<SessionProbeResult> {
  const base = (options.baseUrl ?? 'https://magicgarden.gg').replace(/\/+$/, '');
  const url = `${base}${sessionProbePath(options.version, options.room)}`;

  // Validation happens before the abort timer is even created, so an unsafe token cannot hold a timer
  // or reach the network.
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Origin: base,
  };
  if (options.token !== undefined && options.token.length > 0) {
    headers.Cookie = buildProbeCookie(options.token);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);

  try {
    const response = await fetch(url, { headers, signal: controller.signal });

    if (response.status === 401 || response.status === 403) {
      return {
        valid: false,
        status: response.status,
        outcome: 'unauthorized',
        code: 'rejected',
        reason:
          `The session was rejected (HTTP ${response.status}). The ${SESSION_COOKIE_NAME} token is ` +
          'missing, expired or invalid. Tokens come from the Discord OAuth flow in a real browser. See ' +
          'this module header.',
      };
    }

    if (response.status === 404) {
      return {
        valid: false,
        status: 404,
        outcome: 'not-found',
        code: 'room-not-found',
        reason: 'The room does not exist, so the session could not be checked against it.',
      };
    }

    if (!response.ok) {
      return {
        valid: false,
        status: response.status,
        outcome: 'error',
        code: 'unexpected-status',
        reason: `Unexpected HTTP ${response.status} from the session probe.`,
      };
    }

    return {
      valid: true,
      status: response.status,
      outcome: 'valid',
      code: 'accepted',
      reason: `The session was accepted (HTTP ${response.status}).`,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    if (aborted) {
      return {
        valid: false,
        status: null,
        outcome: 'timeout',
        code: 'timeout',
        reason: `The session probe timed out after ${options.timeoutMs ?? 10_000}ms.`,
      };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return {
      valid: false,
      status: null,
      outcome: 'network-error',
      code: 'network-error',
      // `redactCredentialString` and not `redactCredential`: this is free text, not a keyed bag, and a
      // blanket key rule has nothing to match here. The point is that a transport error which quotes the
      // request, including its `Cookie` header, cannot carry the token into a log line.
      reason: `The session probe could not complete: ${redactCredentialString(detail)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
