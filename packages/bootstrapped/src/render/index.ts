/**
 * The render layer: the Pixi stage, Rive artboards, sprites, text, the graphics helpers and the world
 * scene, plus the ctor discovery and cache-reset plumbing they need.
 *
 * `src/index.ts` re-exports this barrel wholesale (Phase 5 Task 5.6a).
 */

export type {
  GetCtorsOptions,
  PixiApplicationLike,
  PixiCtors as PixiCtorSet,
  PixiDisplayObject,
  PixiGraphics,
  PixiRectangle,
  PixiRendererLike,
  PixiText,
  PixiTextStyle,
  PixiTexture,
  RecoveredCtors,
} from './ctors.js';
export {
  DEFAULT_FIND_LIMIT,
  deriveCtors,
  findAllNodes,
  findByLabel,
  findNode,
  getApplication,
  getCtors,
  getGraphicsCtor,
  getRenderer,
  getStageRoot,
  hasCoreCtorSet,
  hasFullCtorSet,
  isContainerLike,
  isGraphicsLike,
  isRiveLike,
  isSpriteLike,
  isTextLike,
  isUnrecoveredStub,
  PixiCtorsTimeoutError,
  resetCtorCache,
  setApplication,
  setRenderer,
  setStageRoot,
  tryGetCtors,
  UNRECOVERED_CONSTRUCTORS,
} from './ctors.js';
export type { BadgeColour, BadgeStyle, CreateBadgeOptions } from './graphics.js';
export {
  Badge,
  createBadge,
  createBadgeSync,
  resetWarnOnce,
} from './graphics.js';
export type {
  PixiCaptureEvent,
  PixiCaptureHandle,
  PixiCaptureListener,
  PixiCaptureOptions,
} from './pixi.js';
export { capture, PixiStage, requireRenderPage } from './pixi.js';
export type {
  RiveArtboardLike,
  RiveArtboardOptions,
  RiveFailure,
} from './rive.js';
export {
  isArtboardLike,
  RiveArtboard,
  RiveRegistry,
  resetRiveWarnings,
  sharedArtboards,
  wrapArtboard,
} from './rive.js';
export type {
  CachedTexture,
  TextureCache,
  TextureFromOptions,
  TextureSource,
} from './sprite.js';
export {
  createSprite,
  createSpriteSync,
  createTextureCache,
  DEFAULT_TEXTURE_CACHE_ENTRIES,
  loadImageSource,
  sharedTextures,
  textureFrom,
} from './sprite.js';
export type { CreateTextOptions } from './text.js';
export {
  createText,
  createTextOver,
  createTextSync,
  DEFAULT_TEXT_STYLE,
  destroyText,
  detach,
  updateText,
} from './text.js';
export type {
  CinematicClaimHooks,
  SpriteOptions,
  WorldGeometry,
  WorldSceneConfig,
  WorldSceneOptions,
} from './world.js';
export {
  activeCinematicClaims,
  asFiniteNumber,
  asGraphics,
  collectTileViews,
  findRenderLayerCtor,
  readGeometry,
  recordAndSet,
  recordAndWrapNoop,
  resetCinematicClaims,
  resetWorldWarnings,
  WorldScene,
} from './world.js';
