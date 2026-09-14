/**
 * Weather, and the forecast that arrived with it.
 *
 * ## Where this comes from
 *
 * The game's `modding-announcements` channel:
 *
 *   > "API update: a weather block on /platform/v1/shops."
 *   >
 *   >     "weather": {
 *   >       "current": { "weatherId": "Frost", "name": "Snow", "groupId": "Hydro",
 *   >                    "startsAt": "2026-09-11T14:20:00.000Z", "endsAt": "2026-09-11T14:30:00.000Z" },
 *   >       "upcoming": [
 *   >         { "weatherId": null, "name": null, "groupId": "Lunar",
 *   >           "startsAt": "2026-09-11T16:00:00.000Z", "endsAt": "2026-09-11T16:10:00.000Z" },
 *   >         { "weatherId": "Thunderstorm", "name": "Thunderstorm", "groupId": "Hydro",
 *   >           "startsAt": "2026-09-11T17:05:00.000Z", "endsAt": "2026-09-11T17:15:00.000Z" }
 *   >       ]
 *   >     }
 *
 * Verified against the live endpoint (2026-09-13): `GET /platform/v1/shops` returned
 * `weather.current === null` with two `upcoming` entries, one of which had `weatherId: null` and
 * `name: null` but a populated `groupId`. So three things are required and each is a mistake the
 * obvious implementation would make:
 *
 *   1. **`current` is nullable while `upcoming` is populated.** "No weather right now" and "no weather
 *      data" are different answers, and a forecast exists either way. A caller asking "what is coming"
 *      must not read a null `current` as "nothing to see".
 *   2. **A slot's `weatherId` and `name` are independently nullable.** An upcoming slot can name a
 *      `groupId` (here `Lunar`) while its specific weather is still undecided. That is a *scheduled but
 *      unnamed* slot, not a malformed one, so `null` is preserved rather than coerced to `''` or dropped,
 *      because a caller rendering "Lunar at 20:00" needs the group and a caller looking up an icon needs
 *      to know the id is absent.
 *   3. **Timestamps are ISO-8601 strings.** Kept as strings rather than parsed to `Date`, matching
 *      `ShopState.nextRestockAt`: the catalogue is a faithful view of what the server said, and parsing is
 *      the caller's decision (an unparseable value should not silently become `NaN` here).
 *
 * ## Why the legacy endpoint is still read
 *
 * `GET /platform/v1/weather` predates the shops block and returns the *current* weather object directly,
 * or literal `null`. The shops block is now the complete source, so it is preferred and normally costs one
 * request; the legacy endpoint remains the fallback for a server that has not shipped the block, and for
 * the case where the shops request itself fails. Losing the forecast must never cost a caller the current
 * weather, and vice versa.
 */

/** One weather slot: the active weather, or one scheduled to start later. */
export interface WeatherSlot {
  /**
   * The weather's identifier, e.g. `Frost`.
   *
   * `null` for a slot whose specific weather is not yet decided: the live data has such entries, where
   * only `groupId` is known.
   */
  weatherId: string | null;
  /** The display name, e.g. `Snow`. Independently nullable, for the same reason as {@link weatherId}. */
  name: string | null;
  /** The weather group, e.g. `Hydro` or `Lunar`. This is what a slot commits to first. */
  groupId: string | null;
  /** ISO-8601 start timestamp, or `null` when the server did not send a usable one. */
  startsAt: string | null;
  /** ISO-8601 end timestamp, or `null` when the server did not send a usable one. */
  endsAt: string | null;
}

/** The weather now, plus what is scheduled next. */
export interface WeatherForecast {
  /** The weather currently running, or `null` when none is active. */
  current: WeatherSlot | null;
  /**
   * Slots scheduled to start after {@link current}, in the order the server sent them.
   *
   * Order is preserved rather than sorted: the endpoint already sends them soonest-first, and re-sorting
   * would change what a caller sees if the server ever used a different convention. `[]` (not `null`)
   * when the server sent no forecast, so "no upcoming weather" and "no forecast information" are both
   * representable: `[]` is the first, and a `null` {@link WeatherForecast} is the second.
   */
  upcoming: WeatherSlot[];
}

/** A weather response, before it is known whether it is a slot, a block, or nothing. */
export type WeatherPayload = Record<string, unknown> | null;

/**
 * Read a nullable string field.
 *
 * Absent and explicit-`null` are treated the same on purpose: the endpoint sends explicit `null`s, and
 * distinguishing "field missing" from "field null" would invent a third state that no caller has a use for.
 */
function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Normalise one slot. Returns `null` only when the input is not an object at all. */
export function normaliseWeatherSlot(value: unknown): WeatherSlot | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    weatherId: readString(record['weatherId']),
    name: readString(record['name']),
    groupId: readString(record['groupId']),
    startsAt: readString(record['startsAt']),
    endsAt: readString(record['endsAt']),
  };
}

/**
 * Normalise the `weather` block from `/platform/v1/shops`.
 *
 * @returns `null` when the payload carries no usable block, so the caller can fall back to the legacy
 *   endpoint rather than reporting an empty forecast as fact.
 */
export function normaliseWeatherBlock(value: unknown): WeatherForecast | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  // A block is identified by having at least one of the two keys. An empty object is not a forecast, it is
  // a payload that did not carry one, and saying otherwise would turn "unknown" into "nothing is coming".
  if (!('current' in record) && !('upcoming' in record)) return null;

  const current = normaliseWeatherSlot(record['current']);
  const rawUpcoming = record['upcoming'];
  const upcoming: WeatherSlot[] = [];
  if (Array.isArray(rawUpcoming)) {
    for (const entry of rawUpcoming) {
      const slot = normaliseWeatherSlot(entry);
      if (slot !== null) upcoming.push(slot);
    }
  }
  return { current, upcoming };
}

/**
 * Normalise the legacy `/platform/v1/weather` response.
 *
 * That endpoint returns the current weather *directly* (`{ weatherId, name, ... }`) or literal `null`
 * when nothing is active, so it can never supply a forecast.
 */
export function normaliseLegacyWeather(value: unknown): WeatherForecast {
  return { current: normaliseWeatherSlot(value), upcoming: [] };
}

/** Whether a forecast carries anything at all. */
export function hasWeather(forecast: WeatherForecast | null): boolean {
  return forecast !== null && (forecast.current !== null || forecast.upcoming.length > 0);
}

/**
 * The forecast slot covering an instant, if any.
 *
 * Windows are half-open (`startsAt <= at < endsAt`), so back-to-back slots (which is how the grid works:
 * one weather's `endsAt` is the next one's `startsAt`) cannot both claim the same moment.
 *
 * @param at The instant to test. Defaults to now.
 * @returns the matching slot and whether it is the current one, or `null` when no slot covers `at`.
 *   An unparseable timestamp is skipped rather than treated as matching.
 */
export function weatherAt(
  forecast: WeatherForecast | null,
  at: number = Date.now(),
): { slot: WeatherSlot; isCurrent: boolean } | null {
  if (forecast === null) return null;
  const candidates: Array<{ slot: WeatherSlot; isCurrent: boolean }> = [];
  if (forecast.current !== null) candidates.push({ slot: forecast.current, isCurrent: true });
  for (const slot of forecast.upcoming) candidates.push({ slot, isCurrent: false });

  for (const candidate of candidates) {
    const start = candidate.slot.startsAt === null ? Number.NaN : Date.parse(candidate.slot.startsAt);
    const end = candidate.slot.endsAt === null ? Number.NaN : Date.parse(candidate.slot.endsAt);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    if (at >= start && at < end) return candidate;
  }
  return null;
}
