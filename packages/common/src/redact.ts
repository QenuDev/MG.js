/**
 * Credential redaction: the one function DESIGN I3's boundary rule is built on.
 *
 * WHY A FUNCTION RATHER THAN DISCIPLINE
 * -------------------------------------
 * The audit's first credential finding is not a mistake in a call site; it is what happens when every
 * call site is trusted to remember. `mc_jwt` is the whole session, `MemoryLogSink.snapshot()` exists so
 * a caller can attach a dump to a bug report, and the obvious reaction to a degradation warning
 * (`socket.on('headers-dropped', (e) => logger.warn(e))`) is the thing that would put a live
 * token into a shareable artefact. So redaction happens where the value crosses a boundary, in the log
 * sink and the event emit, and every other file is free to be careless about it.
 *
 * WHY IT IS PLATFORM-FREE
 * -----------------------
 * This lives in `@mg.js/common`, which is imported by a userscript sharing a page with the game. No
 * `node:*`, no DOM, no dependency. Two structural checks (`Array.isArray` and `instanceof Map`) plus
 * `Object.entries` are the whole surface.
 *
 * WHAT IT DOES NOT DO
 * --------------------------------
 * - It does not redact by *value* alone. Any string containing `mc_jwt=<value>` is rewritten, and any
 *   JWT-shaped token (three base64url segments whose header decodes to a JSON object, so it starts
 *   with the two characters `{"` encoded as `eyJ`) is replaced wherever it appears, but an opaque
 *   `Xk7-abc` in a `token` field is not findable, and the key rule exists for that case. `token`,
 *   `secret` and `jwt` are *not* key names this redacts, because they are ordinary diagnostic field
 *   names and this package does not own every log record that uses them.
 * - It does not touch non-plain objects. A `Date`, a socket or an `Error` comes back by reference: a
 *   credential does not live in one, and cloning an `Error` would destroy the stack a caller needs.
 * - It is not a substitute for validation. A value that cannot be a cookie value should be rejected
 *   before it ever reaches this function; redaction is the second line, not the first.
 */

/** What a redacted value is replaced with. */
export const REDACTED = '[redacted]';

/** Keys whose *entire* value is replaced, whatever its type. */
const CREDENTIAL_KEY = /^(cookie|authorization|set-cookie|mc_jwt)$/i;

/**
 * A JWT: three base64url segments whose first decodes to something JSON-shaped. The two-character
 * sequence `{"` at the start of that JSON encodes as `eyJ`.
 *
 * Narrow. `1158.test-version-1` has the same gross shape, and redacting version strings
 * would make every connect log useless, so the header segment must actually look like a base64url
 * encoding of a JSON object, and every segment must be long enough to be key material.
 */
const JWT_LIKE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;

/** A cookie *pair*, so the value goes and the surrounding text, including the cookie name, survives. */
const COOKIE_PAIR = /\b(mc_jwt=)[^;\s"']+/gi;

/** `Authorization: Bearer <token>` in an unstructured string. */
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi;

/** Options for {@link redactCredential}. */
export interface RedactOptions {
  /**
   * Also replace the value of any credential-shaped *key*.
   *
   * On by default, because that is the rule that makes an unclassifiable `Cookie` bag safe. Turn it off
   * for a value whose keys are known-safe diagnostics and whose only risk is an embedded token.
   */
  keys?: boolean | undefined;
}

/** Replace every credential-shaped substring in `value`. */
export function redactCredentialString(value: string): string {
  return value
    .replace(COOKIE_PAIR, `$1${REDACTED}`)
    .replace(JWT_LIKE, REDACTED)
    .replace(BEARER, `$1${REDACTED}`);
}

/**
 * Deep-copy `value`, replacing credential-bearing keys and credential-shaped strings with
 * {@link REDACTED}.
 *
 * Generic in and generic out on purpose: a caller redacts the value it already has, so it does not have
 * to surrender the type it was working with. Plain objects and arrays are copied; every other object is
 * passed through by reference (see the file header). Cycles are handled by remembering what has already
 * been visited, so a self-referential bag redacts rather than recursing forever.
 */
export function redactCredential<T>(value: T, options: RedactOptions = {}): T {
  const redactKeys = options.keys ?? true;
  const seen = new WeakMap<object, unknown>();

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return redactCredentialString(node);
    if (node === null || typeof node !== 'object') return node;

    if (seen.has(node)) return seen.get(node);

    if (Array.isArray(node)) {
      const copy: unknown[] = [];
      seen.set(node, copy);
      for (const item of node) copy.push(walk(item));
      return copy;
    }

    if (node instanceof Map) {
      const copy = new Map<unknown, unknown>();
      seen.set(node, copy);
      for (const [key, entry] of node) copy.set(key, walk(entry));
      return copy;
    }

    if (node instanceof Set) {
      const copy = new Set<unknown>();
      seen.set(node, copy);
      for (const entry of node) copy.add(walk(entry));
      return copy;
    }

    const prototype = Object.getPrototypeOf(node);
    if (prototype !== Object.prototype && prototype !== null) {
      // A `Date`, an `Error`, a socket: not a credential carrier, and copying it would lose behaviour.
      return node;
    }

    const copy: Record<string, unknown> = {};
    seen.set(node, copy);
    for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
      if (redactKeys && CREDENTIAL_KEY.test(key)) {
        copy[key] = REDACTED;
        continue;
      }
      copy[key] = walk(entry);
    }
    return copy;
  };

  return walk(value) as T;
}
