/**
 * `GuestAuthProvider`, the anonymous path.
 *
 * Protocol recon §3.2, verbatim and complete:
 *
 *   > "Skip the cookie and instead pass an `anonymousUserStyle` query param: a JSON object with
 *   > `name`, `color`, and the three avatar layer ids (`avatarBottom` / `avatarMid` / `avatarTop`) plus
 *   > `avatarExpression`. The server assigns a temporary identity from that."
 *
 * The recon report flags the field names as verbatim but the **encoding as undocumented**. Its own
 * GAPS section (§10) says: "The exact JSON shape / wire form of `anonymousUserStyle`
 * (JSON-string-quoted object, key casing, allowed values of `color`/`avatarExpression`) is **not**
 * given."
 *
 * WHAT THIS IMPLEMENTATION DOES ABOUT THAT, AND WHY
 * ------------------------------------------------
 * 1. **Field names are taken verbatim from §3.2 and nothing else is added.** No invented field is ever
 *    sent, because an extra key is a shape change the server may reject and there is no way to test
 *    that from here.
 * 2. **The object is sent as RAW JSON text by default (`encode: 'raw'`), because that is the only form
 *    a working client has been observed to send.** The docs leave the encoding undocumented (§10), so
 *    the tie-breaker is implementation evidence rather than the doc's blanket rule.
 *
 *    `Ariedam64/mg-afk-android` builds its guest URL in `data/websocket/UrlBuilder.kt:79-105` and
 *    passes the bare `styleJson`. Every OTHER string parameter in that same file is explicitly quoted
 *    at the call site: `SURFACE = "\"web\""`, `"\"$version\""`, and
 *    `CAPABILITIES = "\"fbo_mipmap_unsupported\""`. The quotes around `anonymousUserStyle` are therefore
 *    missing on purpose, and that is a stronger signal than §1.3's general statement, which is about the
 *    standard parameters and was written by reverse-engineering rather than by reading the client.
 *
 *    `encode: 'json'` reproduces the older reading (the JSON text wrapped in a further JSON string,
 *    i.e. an extra layer of quotes). Both forms are wired and tested; the choice is explicit rather
 *    than hidden.
 *
 *    NOTE: on the live build, neither form connects; see the file-level caveat below.
 * 3. **`color` and `avatarExpression` are `unknown`, not narrowed to an enum.** §10 says their "value
 *    range/format" is not documented, and §3.2 calls the avatar layers "ids" without saying whether
 *    they are free-form or enumerated. Narrowing them here would be inventing a contract. They are
 *    typed as `string | number` (what can survive JSON round-tripping in a query string) and passed
 *    through untouched.
 * LIVE RESULT (verified 2026-09-13, game version 1158): **the guest path does not connect.**
 * Every permutation of `anonymousUserStyle` (raw vs JSON-quoted, one field vs all six Android sends, and
 * no `anonymousUserStyle` at all) produced an identical close with code `4840 SessionExpired`, with the
 * full client-context parameter set present in every case. `scripts/probe-guest-encoding.ts` reproduces
 * the experiment.
 *
 * The working clients corroborate this: both `mg-afk-android` and `MG-AFK` hard-require an `mc_jwt`
 * cookie for their primary connection, and neither contains a working unauthenticated path.
 *
 * WHY IT FAILS, AND WHY THAT IS NOT A BUG TO FIX (authoritative, from the developers)
 * ---------------------------------------------------------------------------------
 * Anonymous websocket connections to rooms were **removed on purpose**. From the game's own
 * `modding-announcements` channel:
 *
 *   > "In the very near future (possibly tonight or tomorrow), anonymous websocket connections to rooms
 *   > will no longer be supported. As a result, bots that determine current shop stock or weather data or
 *   > weather [sic] by connecting to the websocket are no longer permitted. This was never a particularly
 *   > great way to get this data, and certainly more complicated than necessary."
 *
 * The same announcement supplies the sanctioned replacement, and the `4840` is simply what a client with
 * no identity now receives. So this provider is not a wiring mistake and there is nothing here to repair:
 * the endpoint it targets is closed by design. Two consequences worth stating plainly:
 *
 *   1. **This is a policy matter, not only a technical one.** The announcement frames anonymous room
 *      connections as something bots are "no longer permitted" to do for catalogue data. Anyone reaching
 *      for this provider to collect shop/weather data is doing the thing that was outlawed, and should use
 *      `@mg.js/common`'s catalogue layer instead: `PlatformApiSource` already reads the official
 *      `https://magicgarden.gg/platform/v1/{version,shops,weather}` endpoints, needs no session, and is
 *      the path the developers asked for.
 *   2. **It is kept, tested and honest rather than deleted.** The provider still builds the
 *      documented query parameter, because the parameter's shape is documented fact and a caller may have
 *      a build or a private server where it still works. What it must not do is pretend it will succeed
 *      here: {@link GuestAuthProvider.authenticated} is `false`, and a caller can read the outcome for
 *      themselves.
 *
 * A real session cookie is required for a connection that receives a `Welcome`.
 *
 * 4. **`name` has no documented validation.** §10 asks whether it does and gets no answer, so this
 *    provider forwards what the caller gives it and only refuses the two shapes that are certainly
 *    wrong: a non-string, or an empty string (which would be indistinguishable from naming yourself
 *    nothing).
 *
 * The provider contributes **only** a query parameter. Per §3.2 the guest path does not
 * carry a cookie, so sending one alongside this would be asking the server to pick a winner between
 * two identities.
 */

import type { AuthContribution, AuthProvider } from './types.js';

/**
 * The six documented fields of `anonymousUserStyle`, spelled exactly as §3.2 spells them.
 *
 * All six are optional at the type level so a caller can supply only what they care about; a key is
 * only serialised when it was actually provided, which keeps the payload to documented fields and
 * avoids `"color":null`-style noise that no section of the reference describes.
 */
export interface AnonymousUserStyle {
  /** Display name. §10 notes validation rules are undocumented; empty strings are rejected here. */
  name?: string | undefined;
  /** Avatar colour. Format undocumented; passed through unchanged. */
  color?: string | number | undefined;
  /** Bottom avatar layer id. */
  avatarBottom?: string | number | undefined;
  /** Mid avatar layer id. */
  avatarMid?: string | number | undefined;
  /** Top avatar layer id. */
  avatarTop?: string | number | undefined;
  /** Avatar expression. Values undocumented; passed through unchanged. */
  avatarExpression?: string | number | undefined;
}

/** How the object is written into the query string. See the file header for the reasoning. */
export type AnonymousUserStyleEncoding = 'json' | 'raw';

/** Options for {@link GuestAuthProvider}. */
export interface GuestAuthProviderOptions extends AnonymousUserStyle {
  /**
   * `raw` (**default**) writes the JSON text as the parameter value, which the connect-URL builder then
   * JSON-quotes like every other string value (§1.3): the wire form is therefore a quoted JSON document.
   * `json` stringifies one extra time, producing a quoted *string containing* JSON.
   *
   * The default is `raw` because that is the only form a working client has been observed to send: the
   * Android client passes the bare style JSON while explicitly quoting every other string parameter. This
   * is a fidelity default, not a working-configuration claim: see the file header for the live result.
   */
  encode?: AnonymousUserStyleEncoding | undefined;
}

/** The query-parameter name, verbatim from §3.2. */
export const ANONYMOUS_USER_STYLE_PARAM = 'anonymousUserStyle';

/**
 * Build the `anonymousUserStyle` JSON payload.
 *
 * Exported for testing. Only keys that were explicitly provided are included, and the order is the
 * documented order (`name`, `color`, then the three layers, then the expression) so the emitted string
 * is stable and diffable even though no section of the reference claims key order matters.
 */
export function buildAnonymousUserStyle(options: AnonymousUserStyle): string {
  const payload: Record<string, string | number> = {};

  if (options.name !== undefined) {
    if (typeof options.name !== 'string' || options.name.length === 0) {
      throw new TypeError('GuestAuthProvider: `name` must be a non-empty string when provided.');
    }
    payload.name = options.name;
  }
  if (options.color !== undefined) payload.color = options.color;
  if (options.avatarBottom !== undefined) payload.avatarBottom = options.avatarBottom;
  if (options.avatarMid !== undefined) payload.avatarMid = options.avatarMid;
  if (options.avatarTop !== undefined) payload.avatarTop = options.avatarTop;
  if (options.avatarExpression !== undefined) payload.avatarExpression = options.avatarExpression;

  return JSON.stringify(payload);
}

/** The anonymous (guest) path. */
export class GuestAuthProvider implements AuthProvider {
  readonly id = 'guest';
  readonly authenticated = false;

  private readonly style: AnonymousUserStyle;
  private readonly encode: AnonymousUserStyleEncoding;

  constructor(options: GuestAuthProviderOptions = {}) {
    const { encode, ...style } = options;
    // 'raw' is the default because it is the only form a WORKING client has been observed to send.
    // See the file header: the Android reference client passes the bare JSON text, and quotes every
    // other string parameter explicitly, so the absence of quoting is deliberate.
    this.encode = encode ?? 'raw';
    this.style = style;
  }

  async prepare(): Promise<AuthContribution> {
    const json = buildAnonymousUserStyle(this.style);
    const value = this.encode === 'json' ? JSON.stringify(json) : json;
    return {
      query: { [ANONYMOUS_USER_STYLE_PARAM]: value },
      note: `anonymousUserStyle (${this.encode})`,
    };
  }
}
