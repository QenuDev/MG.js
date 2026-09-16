/** Live-fetching domain catalogues. */

export type {
  CommunityApiContract,
  CommunityApiContractErrorReason,
  CommunityApiSourceOptions,
  VerifyContractOptions,
} from './community-api-source.js';
export {
  CommunityApiContractError,
  CommunityApiSource,
  DEFAULT_COMMUNITY_API_URL,
  SUPPORTED_API_CONTRACT,
  verifyContract,
} from './community-api-source.js';
export type {
  AbilityDef,
  CatalogKind,
  DecorDef,
  DomainCatalog,
  EggDef,
  GameEntity,
  ItemDef,
  MutationDef,
  PetDef,
  PlantDef,
  ShopItem,
  ShopState,
  ShopsSnapshot,
  WeatherForecast,
  WeatherSlot,
} from './defs.js';
export { CATALOG_KINDS, emptyCatalog, GAME_GRID_MS, restockCountdown } from './defs.js';
export type { FetchJsonOptions } from './http.js';
export { DEFAULT_HEADERS, DEFAULT_MAX_RESPONSE_BYTES, fetchJson, HttpError } from './http.js';
export type { PlatformApiSourceOptions } from './platform-source.js';
export { PLATFORM_PATHS, PlatformApiSource } from './platform-source.js';
export type { RemoteJsonSourceOptions } from './remote-json-source.js';
export { DEFAULT_REMOTE_PATHS, RemoteJsonSource } from './remote-json-source.js';
export type { CatalogClientOptions, CatalogSource } from './source.js';
export { CatalogClient, normalizeEntityMap, SOURCE_FAILURE_CODE, STATIC_SOURCE_ID } from './source.js';
export type { StaticCatalogSourceOptions } from './static-source.js';
export { StaticCatalogSource } from './static-source.js';
export type { WeatherPayload } from './weather.js';
export {
  hasWeather,
  normaliseLegacyWeather,
  normaliseWeatherBlock,
  normaliseWeatherSlot,
  weatherAt,
} from './weather.js';
