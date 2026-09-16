/**
 * The game version as a route states it, in one place.
 *
 * The version category is a string everywhere it is modelled: `DomainCatalog.version` is
 * `string | null`, and `PlatformApiSource` returns the bare build id. But no route *returns* a bare
 * string. Two documented bodies reach this helper, and they spell the same fact two ways:
 *
 *   - the community host's `/data/version` returns
 *     `{"gameVersion":"1189","artVersion":"1189","contract":1,"generatedAt":"…"}`
 *     (`docs/mgjs-community-api-plan.md` §2.3, which is the shape the fork's route is written to);
 *   - the game's own `/platform/v1/version` returns `{"version":"1189"}` (`platform-source.ts` header,
 *     measured live), and the upstream server's on-disk `data/version.json` is `{version, lastUpdated}`
 *     (`docs/community-api-audit.md` §3).
 *
 * A bare string is accepted too, because a host that already models the route as this library models the
 * category should not have to wrap it in an object to be understood.
 *
 * Anything else is `null`, meaning "this route did not state a version". That matters: the category used
 * to be read with `String(value)`, so an object became the string `"[object Object]"` and the catalogue
 * reported a version that no host ever sent. A route this library cannot read is a missing version, not a
 * creative one.
 */

/** The keys a `/data/version` or `/platform/v1/version` body may spell the build id under. */
const VERSION_KEYS = ['gameVersion', 'version'] as const;

/**
 * The game version a payload states, or `null` when it states none.
 *
 * @see the module header for the two bodies this is built from.
 */
export function gameVersionOf(payload: unknown): string | null {
  if (typeof payload === 'string') return payload.length > 0 ? payload : null;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const record = payload as Record<string, unknown>;
  for (const key of VERSION_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}
