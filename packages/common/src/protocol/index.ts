/** The wire contract: types, forms, envelopes, sequencing, close and result codes. */

export type { CloseAnalysis, CloseDisposition } from './close-codes.js';
export { analyzeClose, CloseCode } from './close-codes.js';
export type { ParseResult, UnknownMessage } from './codec.js';
export {
  asSequence,
  extractFrontier,
  extractPatches,
  isCanonicalSequence,
  MAX_FRAME_BYTES,
  parseFrame,
  serializeFrame,
  utf8ByteLength,
} from './codec.js';
export type { BuiltConnectUrl } from './connect-url.js';
export { buildConnectUrl, buildConnectUrlDetailed, DEFAULT_HOST, encodeQueryValue } from './connect-url.js';
export type { ActionParams, BuildFrameOptions } from './envelope.js';
export {
  buildFlatFrame,
  buildFrame,
  buildRoomFrame,
  buildWrappedFrame,
  frameAction,
  frameScope,
  isWrappedFrame,
  pruneUndefined,
} from './envelope.js';
export { randomRoomSlug, randomUuid } from './id.js';
export type {
  ActionForm,
  CommandBody,
  ConnectOptions,
  CrystalShard,
  FlatFrame,
  FullState,
  InboundMessage,
  OutboundFrame,
  PartialStateMessage,
  Patch,
  PetTeamEmblem,
  PongMessage,
  Position,
  QuinoaCommandResultMessage,
  ReconnectConfig,
  RoomFrame,
  RoomFrameMessage,
  ScopePath,
  WelcomeMessage,
  WrappedFrame,
} from './wire.js';
export {
  DEFAULT_RECONNECT,
  isKeepalivePing,
  KEEPALIVE_PING,
  KEEPALIVE_PONG,
  SCOPE_QUINOA,
  SCOPE_ROOM,
} from './wire.js';
