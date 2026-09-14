/**
 * The world scene, as one entry point.
 *
 * Phase 5 Task 5.7c split this file's contents into `world-scene.ts` (the class), `world-geometry.ts`,
 * `tile-view.ts`, `cinematic-claims.ts` and `world-warnings.ts`. Every name it exported before is still
 * exported here, so `render/index.ts`, `client.ts` and the tests keep compiling unchanged: the facade is
 * what makes the split revertable in one commit.
 */

export type { CinematicClaimHooks } from './cinematic-claims.js';
export { activeCinematicClaims, resetCinematicClaims } from './cinematic-claims.js';
export { asGraphics, collectTileViews, findRenderLayerCtor } from './tile-view.js';
export type { WorldGeometry } from './world-geometry.js';
export { asFiniteNumber, readGeometry } from './world-geometry.js';
export type { SpriteOptions, WorldSceneConfig, WorldSceneOptions } from './world-scene.js';
export { WorldScene } from './world-scene.js';
export { recordAndSet, recordAndWrapNoop, resetWorldWarnings } from './world-warnings.js';
