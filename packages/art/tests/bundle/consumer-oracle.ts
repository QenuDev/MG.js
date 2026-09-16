/**
 * The consumer's hand-written copies, kept here as the oracle the extractor is measured against.
 *
 * These are not game values and they are not inputs to anything: they are what `garden-viewer/server.mjs` holds
 * today (`ICON_ANCHORS` at `:848-871`, `TALL_PLANTS` at `:880-898`, `MUTATION_SCALE_CAP` and
 * `TALL_DECAL_SCALE` at `:899-902`, `mutationAnchor` at `:940-953`), copied verbatim so a test can assert that
 * the tables read out of the bundle say the same thing. When Phase F deletes the consumer's copies, this file
 * is what remains of them, and it still fails if a game version moves a mutation.
 */

export const ICON_ANCHORS: Readonly<Record<string, unknown>> = {
  Banana: { x: 0.6, y: 0.68 },
  Beet: { y: 0.65 },
  Carrot: { x: { crop: 0.5 }, y: { plant: 0.6, crop: 0.42 } },
  Sunflower: { y: 0.5 },
  Ube: { y: 0.5 },
  Starweaver: { y: 0.5 },
  Clover: { y: 0.3 },
  FourLeafClover: { y: 0.3 },
  FavaBean: { y: 0.25 },
  BurrosTail: { y: 0.2 },
  Rose: { y: 0.16 },
  Saffron: { x: 0.52, y: 0.22 },
  Cardoon: { y: 0.8 },
  Daisy: { y: 0.21 },
  PurpleDaisy: { y: 0.21 },
  Pepper: { x: 0.6 },
  Eggplant: { x: 0.57 },
  Milkcap: { y: 0.3 },
  Snowdrop: { x: 0.3, y: 0.23, scale: 0.5 },
  SnowdropDouble: { x: 0.27, y: 0.21, scale: 0.5 },
  Dawnbreaker: { y: { plant: 0.25, crop: 0.13 } },
  Leek: { y: { plant: 0.55 }, scale: { plant: 0.7 } },
};

export const TALL_PLANTS: ReadonlySet<string> = new Set([
  'Bamboo',
  'Cactus',
  'DawnCelestialPlant',
  'DawnCelestialPlantActive',
  'DawnCelestialPlatform',
  'DawnCelestialPlatformTopmostLayer',
  'MoonCelestialPlant',
  'MoonCelestialPlantActive',
  'MoonCelestialPlatform',
  'PricklyPearPlant',
  'StarweaverPlant',
  'StarweaverPlatform',
  'ThunderCelestialPlant',
  'ThunderCelestialPlantActive',
  'ThunderCelestialPlatform',
]);

export const MUTATION_SCALE_CAP = 0.75;
export const TALL_DECAL_SCALE = 2;

/** The logical size of an atlas frame, which is what the consumer's port reads. */
export interface PortedArt {
  readonly width: number;
  readonly height: number;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly pixelRatio: number;
}

/** `mutationAnchor` from `garden-viewer/server.mjs:940-953`, verbatim in its arithmetic. */
export function portedMutationAnchor(
  species: string,
  art: PortedArt,
  harvestType: string,
): { x: number; y: number; scale: number } {
  const stated = (ICON_ANCHORS[species] ?? {}) as Record<string, unknown>;
  const pick = (value: unknown): number | undefined => {
    if (typeof value === 'number') return value;
    if (value !== null && typeof value === 'object') return (value as { plant?: number }).plant;
    return undefined;
  };
  const anchorX = pick(stated['x']) ?? art.anchorX;
  const tallArt = art.height > art.width * 1.5;
  const short = harvestType === 'Single' && tallArt ? art.anchorY : 0.4;
  const anchorY = pick(stated['y']) ?? short;
  const statedScale = pick(stated['scale']) ?? 1;
  const smaller = Math.min(art.width, art.height);
  const scale = Math.min(MUTATION_SCALE_CAP, smaller / 256) * statedScale;
  return { x: anchorX, y: anchorY, scale };
}

/** The raw frame the game's own function is called with. */
export interface RawFrame {
  readonly width: number;
  readonly height: number;
  readonly defaultAnchor: { readonly x: number; readonly y: number };
  readonly sourcePixelRatio: number;
}
