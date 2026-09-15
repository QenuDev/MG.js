/**
 * Domain catalogue types.
 *
 * ## Why the entity types are loose
 *
 * The recon into the existing `Magic-garden-API` server found that "entity field sets are declared
 * nowhere": no schema, no OpenAPI that matches the code, no `.d.ts`. The game's own bundle is the only
 * authority, and it is minified and changes between builds.
 *
 * So these types name the fields that are *actually observed* (verified against the live platform API
 * and against the existing extractors) and carry an index signature for the rest. That is the honest
 * shape of the data: a wrapper that pretended to know every field of a `PlantDef` would be inventing
 * them, and would break on the next client build.
 */

import type { MgErrorSummary } from '../client-contract.js';
import type { WeatherForecast } from './weather.js';

export type { WeatherForecast, WeatherSlot } from './weather.js';

/** Categories a catalogue source can provide. */
export type CatalogKind =
  | 'version'
  | 'plants'
  | 'pets'
  | 'eggs'
  | 'decors'
  | 'mutations'
  | 'items'
  | 'abilities'
  | 'enums'
  | 'shops'
  | 'weather';

/** Every kind, in load order. */
export const CATALOG_KINDS: readonly CatalogKind[] = [
  'version',
  'plants',
  'pets',
  'eggs',
  'decors',
  'mutations',
  'items',
  'abilities',
  'enums',
  'shops',
  'weather',
];

/**
 * A game entity.
 *
 * `id` is the stable identity across every category we have observed; every other field is
 * build-dependent.
 */
export interface GameEntity {
  id: string;
  name?: string;
  [field: string]: unknown;
}

/** A plant species definition. */
export interface PlantDef extends GameEntity {
  /** Rarity tier, as the game names it (e.g. `common`, `legendary`). */
  rarity?: string;
  /** Base crop value in coins, before mutations. */
  value?: number;
  /** Growth duration in the game's own unit; see {@link GAME_GRID_MS}. */
  growTime?: number;
}

/** A pet definition. */
export interface PetDef extends GameEntity {
  /** The egg this pet hatches from. */
  eggId?: string;
  rarity?: string;
  /** Ability ids this species can roll. */
  abilities?: string[];
}

/** An egg definition. */
export interface EggDef extends GameEntity {
  rarity?: string;
  /** Pet species that can hatch. */
  pets?: string[];
}

/** A decor definition. */
export interface DecorDef extends GameEntity {
  rarity?: string;
}

/** A mutation definition. */
export interface MutationDef extends GameEntity {
  rarity?: string;
  /** Multiplier applied to the crop's value. */
  valueMultiplier?: number;
}

/** An inventory item definition. */
export interface ItemDef extends GameEntity {
  itemType?: string;
  coinPrice?: number;
}

/** A pet ability definition. */
export interface AbilityDef extends GameEntity {
  description?: string;
  rarity?: string;
}

/** One purchasable line in a shop. Shape verified against the live platform API. */
export interface ShopItem {
  itemId: string;
  itemType: string;
  name: string;
  coinPrice: number;
  stock: number;
  [field: string]: unknown;
}

/** One shop's state. Shape verified against the live platform API. */
export interface ShopState {
  open: boolean;
  /**
   * ISO-8601 timestamp of the next restock, or `null`.
   *
   * VERIFIED LIVE, and not documented anywhere: the six seasonal/event shops (`rain`, `dawn`, `amber`,
   * `snow`, `thunder`, `apology`) are reported with `open: false`, an empty `items` array and
   * `nextRestockAt: null`. Only the permanent shops (`seed`, `egg`, `tool`, `decor`) carry a string
   * timestamp. A naive `string` type here would be wrong for 6 of the 10 shops the server actually
   * sends.
   */
  nextRestockAt: string | null;
  items: ShopItem[];
  /**
   * A second item list present in the live payload under the key `catalog`.
   *
   * VERIFIED LIVE and undocumented: observed on every shop, empty (`[]`) on the closed seasonal ones.
   * Typed loosely on purpose: nothing in either document explains what distinguishes it from `items`,
   * so this records that it exists rather than guessing at its meaning.
   */
  catalog?: unknown[];
}

/** The full shops snapshot: `{ shops: { seed: {...}, tool: {...}, ... } }`. */
export interface ShopsSnapshot {
  shops: Record<string, ShopState>;
  /**
   * The `weather` block the developers added to this same payload.
   *
   * Typed loosely and read through `normaliseWeatherBlock` rather than duplicated here: it is not part of
   * the shops *snapshot*, it merely travels alongside it, and `PlatformApiSource` prefers it over the
   * legacy `/platform/v1/weather` endpoint because it is the only source that carries a forecast.
   */
  weather?: unknown;
  [key: string]: unknown;
}

/**
 * A weather snapshot.
 *
 * Now a modelled forecast (`current` + `upcoming`) rather than raw passthrough. See `weather.ts` for the
 * announcement and the live shapes this is built from. The `null` case on {@link DomainCatalog.weather}
 * means no source supplied weather at all; "no weather is active" is `{ current: null, upcoming: [...] }`,
 * which is a different and much more useful answer.
 */

/**
 * The merged catalogue.
 *
 * A `null` field means no configured source could provide that category. It is never an empty
 * placeholder pretending to be data. `missing` lists them explicitly.
 */
export interface DomainCatalog {
  version: string | null;
  plants: PlantDef[] | null;
  pets: PetDef[] | null;
  eggs: EggDef[] | null;
  decors: DecorDef[] | null;
  mutations: MutationDef[] | null;
  items: ItemDef[] | null;
  abilities: AbilityDef[] | null;
  enums: Record<string, unknown> | null;
  shops: ShopsSnapshot | null;
  weather: WeatherForecast | null;
  /** Categories no source could supply. */
  missing: CatalogKind[];
  /**
   * Every source failure observed while assembling this catalogue, keyed by the kind it was loading.
   *
   * This is the observable that survives a lost `onSourceError` callback: the production wiring passed
   * none, so with every endpoint down the catalogue said only "missing" and nothing anywhere recorded
   * *why*. A kind a later source supplied still carries the earlier failure, so one source covering for
   * another cannot hide a degradation; `provenance` names who actually supplied the value. The summary is
   * JSON-safe and already redacted, so it can be attached to a bug report as-is.
   */
  errors: Partial<Record<CatalogKind, MgErrorSummary>>;
  /** Which source supplied each category, for debugging and trust decisions. */
  provenance: Partial<Record<CatalogKind, string>>;
  /** When this catalogue was assembled. */
  loadedAt: number;
}

/** An empty catalogue, used as the initial value. */
export function emptyCatalog(): DomainCatalog {
  return {
    version: null,
    plants: null,
    pets: null,
    eggs: null,
    decors: null,
    mutations: null,
    items: null,
    abilities: null,
    enums: null,
    shops: null,
    weather: null,
    missing: [...CATALOG_KINDS],
    errors: {},
    provenance: {},
    loadedAt: 0,
  };
}

/**
 * The game's grid quantum: 5 minutes.
 *
 * Carried over from the existing server's `GRID_MS = 300000`. Shop restock times and weather slots are
 * aligned to it, so a client that needs to reason about "when does this restock" needs it too.
 */
export const GAME_GRID_MS = 300_000;

/**
 * A shop's restock countdown, computed at read time.
 *
 * The existing server computes restock purely at read time rather than storing a schedule, which means
 * this needs no background timer.
 *
 * @returns `null` when there is no scheduled restock. That is a real state, not an error: the seasonal
 *   shops are live-reported with `nextRestockAt: null` while closed. It also covers an unparseable
 *   timestamp, so a caller that needs to distinguish the two should inspect `nextRestockAt` itself.
 */
export function restockCountdown(
  shop: ShopState,
  now = Date.now(),
): { ms: number; gridSlots: number } | null {
  if (shop.nextRestockAt === null) return null;
  const target = Date.parse(shop.nextRestockAt);
  if (Number.isNaN(target)) return null;
  const ms = Math.max(0, target - now);
  return { ms, gridSlots: Math.ceil(ms / GAME_GRID_MS) };
}
