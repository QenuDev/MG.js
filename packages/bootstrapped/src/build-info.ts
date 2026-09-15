/**
 * Build identity: which version of this bundle is running.
 *
 * ## Why this is not part of the page namespace
 *
 * `BUNDLE_VERSION` used to be defined in `page/namespace.ts`, next to `NAMESPACE_KEY`. Both are strings this
 * package stamps onto the page, so the placement looked reasonable, but they are answers to
 * different questions. The namespace key is a *communication* decision: one global, version-free by design,
 * so that two loads of different versions agree to share it, with version skew resolved
 * *inside* by `RealmNamespace.version` and `claimInstall`. The version is *identity*, and the namespace is
 * only the first of several places that wants it: the diagnostic report publishes it
 * (`diagnostics.ts` → `BootstrapReport.version`), and `common`'s `ClientReport.version` reports the
 * server's catalogue version beside it.
 *
 * Keeping identity inside a page concern also made the dependency direction wrong: a module whose subject is
 * "which global do I claim on the page" should not be the thing that has to know the release number.
 *
 * ## The value itself
 *
 * It is `@mg.js/common`'s `MG_VERSION` under this package's published name, the same arrangement
 * `readWelcomeFrontier` has with `extractFrontier` (see `client.ts`). There is one version number in the
 * repository and one place per package that publishes it; a second literal here would be a second thing to
 * bump, and the README's "align the four `0.1.0`s" debt (Phase 8.4) exists because that has already
 * happened elsewhere.
 */

import { MG_VERSION } from '@mg.js/common';

/** Semantic version of this bundle, stamped into the page namespace for skew detection. */
export const BUNDLE_VERSION = MG_VERSION;
