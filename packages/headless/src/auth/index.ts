/**
 * `@mg.js/headless/auth`: proving who we are.
 *
 * This barrel is the target of the package's `"./auth"` export, and it is why that subpath exists: the
 * two auth provider implementations are useless apart from each other and from the types they satisfy,
 * so a caller that wants to authenticate should not have to know which file each piece lives in.
 *
 * It is also a bug fix. The subpath used to point at `types.js`, a file named for types that happens to
 * export one class (`StaticAuthProvider`) and neither real provider. So
 * `import { GuestAuthProvider } from '@mg.js/headless/auth'` resolved to `undefined` while
 * `tsc -b` stayed green, because `exports` is not type-checked. `tests/exports-map.test.ts` now asserts
 * this surface after a build.
 */

export type {
  CookieAuthProviderOptions,
  CookieHeaderValidationError,
  CookieHeaderValidationField,
} from './cookie.js';
export {
  CookieAuthProvider,
  MC_JWT_COOKIE,
  toCookieHeader,
  validateCookieHeaderValue,
} from './cookie.js';
export type {
  AnonymousUserStyle,
  AnonymousUserStyleEncoding,
  GuestAuthProviderOptions,
} from './guest.js';
export {
  ANONYMOUS_USER_STYLE_PARAM,
  buildAnonymousUserStyle,
  GuestAuthProvider,
} from './guest.js';
export type { AuthContribution, AuthProvider } from './types.js';
export { StaticAuthProvider } from './types.js';
