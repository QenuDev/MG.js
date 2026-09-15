/**
 * Weather and the `upcoming` forecast.
 *
 * The shapes here are not invented: `current`/`upcoming` and the independently-nullable `weatherId`/`name`
 * come from the game's `modding-announcements` post announcing the `weather` block on
 * `/platform/v1/shops`, and the fixtures reproduce what the live endpoint returned on 2026-09-13:
 * `current: null` with two `upcoming` entries, one of which had `weatherId: null, name: null, groupId:
 * "Lunar"`.
 *
 * Those two facts are the whole reason this module exists rather than passing the payload through:
 *   - a null `current` does **not** mean there is no forecast, and
 *   - a slot can be scheduled with its weather still unnamed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WeatherForecast } from '../src/catalog/weather.ts';
import {
  hasWeather,
  normaliseLegacyWeather,
  normaliseWeatherBlock,
  normaliseWeatherSlot,
  weatherAt,
} from '../src/catalog/weather.ts';

/** The live 2026-09-13 payload, verbatim. */
const LIVE_BLOCK = {
  current: null,
  upcoming: [
    {
      weatherId: 'Frost',
      name: 'Snow',
      groupId: 'Hydro',
      startsAt: '2026-09-13T16:55:00.000Z',
      endsAt: '2026-09-13T17:05:00.000Z',
    },
    {
      weatherId: null,
      name: null,
      groupId: 'Lunar',
      startsAt: '2026-09-13T20:00:00.000Z',
      endsAt: '2026-09-13T20:10:00.000Z',
    },
  ],
};

void test('normaliseWeatherBlock keeps a null current alongside a populated forecast', () => {
  const forecast = normaliseWeatherBlock(LIVE_BLOCK);
  assert.notEqual(forecast, null);
  // The mistake this guards against: reading `current === null` as "no weather data" and dropping the
  // forecast, which is the only part a caller planning ahead actually wants.
  assert.equal(forecast?.current, null);
  assert.equal(forecast?.upcoming.length, 2);
  assert.equal(forecast?.upcoming[0]?.weatherId, 'Frost');
  assert.equal(forecast?.upcoming[0]?.name, 'Snow');
});

void test('a scheduled slot may have a null weatherId and name but a real groupId', () => {
  const forecast = normaliseWeatherBlock(LIVE_BLOCK);
  const lunar = forecast?.upcoming[1];
  assert.notEqual(lunar, undefined);
  // Documented in the announcement's own sample. Preserved rather than coerced to '', because "Lunar at
  // 20:00" is useful and "which icon" is legitimately unknown.
  assert.equal(lunar?.weatherId, null);
  assert.equal(lunar?.name, null);
  assert.equal(lunar?.groupId, 'Lunar');
  assert.equal(lunar?.startsAt, '2026-09-13T20:00:00.000Z');
});

void test('normaliseWeatherBlock reports "no block" rather than an empty forecast', () => {
  // A literal `null` is what sends the platform source to the legacy endpoint. Returning
  // `{ current: null, upcoming: [] }` instead would assert "nothing is coming", which is a claim the
  // payload did not make.
  assert.equal(normaliseWeatherBlock(null), null);
  assert.equal(normaliseWeatherBlock(undefined), null);
  assert.equal(normaliseWeatherBlock({}), null);
  assert.equal(normaliseWeatherBlock([]), null);
  assert.equal(normaliseWeatherBlock('weather'), null);
});

void test('a block with only one of the two keys is still a block', () => {
  // `upcoming` alone is a real forecast, and `current` alone is a real present, so neither should be
  // discarded for lacking its sibling.
  const onlyUpcoming = normaliseWeatherBlock({ upcoming: [LIVE_BLOCK.upcoming[0]] });
  assert.equal(onlyUpcoming?.current, null);
  assert.equal(onlyUpcoming?.upcoming.length, 1);

  const onlyCurrent = normaliseWeatherBlock({ current: LIVE_BLOCK.upcoming[0] });
  assert.equal(onlyCurrent?.current?.weatherId, 'Frost');
  assert.deepEqual(onlyCurrent?.upcoming, []);
});

void test('malformed entries are skipped, not fatal', () => {
  const forecast = normaliseWeatherBlock({
    current: 'not an object',
    upcoming: [null, 42, 'nope', { weatherId: 'Rain' }, []],
  });
  assert.equal(forecast?.current, null);
  assert.equal(forecast?.upcoming.length, 1);
  assert.equal(forecast?.upcoming[0]?.weatherId, 'Rain');
  // A slot with no timestamps at all is still a slot, because every field is optional on the wire.
  assert.equal(forecast?.upcoming[0]?.startsAt, null);
});

void test('normaliseWeatherSlot treats absent and explicit null identically', () => {
  assert.deepEqual(normaliseWeatherSlot({}), {
    weatherId: null,
    name: null,
    groupId: null,
    startsAt: null,
    endsAt: null,
  });
  assert.deepEqual(
    normaliseWeatherSlot({ weatherId: null, name: null, groupId: null, startsAt: null, endsAt: null }),
    { weatherId: null, name: null, groupId: null, startsAt: null, endsAt: null },
  );
  // An empty string is not a name; it would render as a blank label rather than "unnamed".
  assert.equal(normaliseWeatherSlot({ name: '' })?.name, null);
});

void test('the legacy endpoint becomes a current-only forecast', () => {
  // `/platform/v1/weather` returns the weather object directly, or literal null. It can never carry a
  // forecast, and saying so with `upcoming: []` is accurate rather than a guess.
  const fromLegacy = normaliseLegacyWeather({
    weatherId: 'Frost',
    name: 'Snow',
    groupId: 'Hydro',
    startsAt: '2026-09-13T14:20:00.000Z',
    endsAt: '2026-09-13T14:30:00.000Z',
  });
  assert.equal(fromLegacy.current?.weatherId, 'Frost');
  assert.deepEqual(fromLegacy.upcoming, []);

  // The live endpoint's literal `null`, meaning "nothing active", is not an error and not an empty object.
  const inactive = normaliseLegacyWeather(null);
  assert.equal(inactive.current, null);
  assert.deepEqual(inactive.upcoming, []);
});

void test('hasWeather distinguishes "nothing active" from "no weather data"', () => {
  assert.equal(hasWeather(null), false, 'no source supplied weather');
  assert.equal(hasWeather({ current: null, upcoming: [] }), false, 'a source said nothing is happening');
  const firstUpcoming = LIVE_BLOCK.upcoming[0];
  assert.ok(firstUpcoming !== undefined, 'the fixture must carry an upcoming slot');
  assert.equal(hasWeather({ current: null, upcoming: [firstUpcoming] }), true, 'a forecast alone counts');
  assert.equal(hasWeather({ current: normaliseWeatherSlot({ weatherId: 'Frost' }), upcoming: [] }), true);
});

void test('weatherAt finds the slot covering an instant, half-open', () => {
  const forecast: WeatherForecast = {
    current: null,
    upcoming: [
      {
        weatherId: 'Frost',
        name: 'Snow',
        groupId: 'Hydro',
        startsAt: '2026-09-13T16:55:00.000Z',
        endsAt: '2026-09-13T17:05:00.000Z',
      },
      {
        weatherId: null,
        name: null,
        groupId: 'Lunar',
        startsAt: '2026-09-13T17:05:00.000Z',
        endsAt: '2026-09-13T17:15:00.000Z',
      },
    ],
  };

  // Back-to-back slots are how the grid works, so the boundary must belong to one of them and one only:
  // `endsAt` is exclusive. Otherwise both would match and the answer would depend on iteration order.
  const atStart = weatherAt(forecast, Date.parse('2026-09-13T16:55:00.000Z'));
  assert.equal(atStart?.slot.weatherId, 'Frost');
  assert.equal(atStart?.isCurrent, false);

  const atBoundary = weatherAt(forecast, Date.parse('2026-09-13T17:05:00.000Z'));
  assert.equal(atBoundary?.slot.groupId, 'Lunar', 'the boundary belongs to the later slot only');

  const beforeAll = weatherAt(forecast, Date.parse('2026-09-13T16:00:00.000Z'));
  assert.equal(beforeAll, null);

  const afterAll = weatherAt(forecast, Date.parse('2026-09-13T18:00:00.000Z'));
  assert.equal(afterAll, null);
});

void test('weatherAt prefers current, and skips slots with unusable timestamps', () => {
  const forecast: WeatherForecast = {
    current: {
      weatherId: 'Thunderstorm',
      name: 'Thunderstorm',
      groupId: 'Hydro',
      startsAt: '2026-09-13T12:00:00.000Z',
      endsAt: '2026-09-13T12:10:00.000Z',
    },
    // No timestamps: it cannot be placed in time, so it must be skipped rather than matching everything.
    upcoming: [{ weatherId: 'Frost', name: null, groupId: null, startsAt: null, endsAt: null }],
  };
  const hit = weatherAt(forecast, Date.parse('2026-09-13T12:05:00.000Z'));
  assert.equal(hit?.slot.weatherId, 'Thunderstorm');
  assert.equal(hit?.isCurrent, true);

  assert.equal(weatherAt(null, Date.now()), null);
  assert.equal(weatherAt(forecast, Date.parse('2026-09-14T00:00:00.000Z')), null);
});
