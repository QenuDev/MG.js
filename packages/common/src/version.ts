/**
 * The one version number.
 *
 * The value a `ClientReport` reports and the value `BUNDLE_VERSION` stamps into the page's `__mgjs`
 * namespace for skew detection were two literals in two packages, which is exactly how a bundle and the
 * report it prints drift apart. Phase 8.4 is where the number moves (package metadata, the userscript
 * header); until then this is its single home.
 *
 * A value, not a type: `BUNDLE_VERSION` must stay assignable to `RealmNamespace.version`, and a report
 * must be able to print it.
 */
export const MG_VERSION = '0.1.0';
