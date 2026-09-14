/**
 * The headless package's configuration error, the *shared* one, re-exported rather than redeclared.
 *
 * `MgConfigError` is a *configuration* error: something the caller must change before a request is worth
 * dispatching. Three unrelated call sites raise it for the same class of reason: the probe (`session.ts`,
 * for a token that cannot become a header), the client (`client.ts`, for a runtime that cannot carry the
 * headers its provider needs) and the cookie provider (`auth/cookie.ts`, for the same token rule the
 * probe applies).
 *
 * ## Why this is an explicit re-export, not a local class
 *
 * It used to be `class MgConfigError extends Error` here, with this header explaining that the common
 * taxonomy "has no `MgConfigError` yet". The consequence was a second hierarchy root: `isMgError`, the
 * documented way for a caller to branch on type rather than message text, answered `false` for it, so a
 * classifying caller misclassified every headless config error. `@mg.js/common` owns the class now; this
 * file exists so `./errors.js` remains the import path the rest of the package (and
 * `packages/headless/src/index.ts`) already uses, and so the public name does not move.
 *
 * Re-exporting a fresh class, or patching the prototype without sharing the constructor, would satisfy a
 * source-level check while leaving `isMgError` and `instanceof` wrong; only the identity above is
 * asserted in `packages/headless/tests/errors.test.ts`.
 *
 * One consequence of sharing the constructor: the default `code` is now the common
 * `'config_invalid'`. The auth paths that mean the narrower, stable `'config_invalid_token'` pass it
 * explicitly (`session.ts`, `auth/cookie.ts`), so that string is unchanged for callers who branch on it.
 */
export { MgConfigError } from '@mg.js/common';
