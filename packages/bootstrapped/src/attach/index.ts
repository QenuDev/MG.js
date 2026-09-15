/**
 * Attaching to the socket the game already has: detection, the raw-socket rewriter, the room
 * connection, and the transport built on top of it.
 *
 * `src/index.ts` re-exports this barrel wholesale (Phase 5 Task 5.6a).
 */

export type { AttachedTransportOptions, SendAttempt } from './attached-transport.js';
export { AttachedTransport } from './attached-transport.js';
export type {
  Attachment,
  AttachmentKind,
  AttachmentReport,
  DetectAttachmentOptions,
  WatchForRoomConnectionOptions,
} from './detect.js';
export {
  createEmptySink,
  detectAttachment,
  hasRoomConnection,
  waitForAttachment,
  watchForRoomConnection,
} from './detect.js';
export type {
  BindRawSocketOptions,
  RawSocketBinding,
  ScrapeResult,
  SocketLike,
  WebSocketLike,
} from './raw-socket.js';
export {
  bindRawSocket,
  DEFAULT_ROOM_URL_FILTER,
  installOutboundRewriter,
  resolveOpenConstant,
  scrapeFrame,
  WEBSOCKET_KEY,
} from './raw-socket.js';
export type {
  AttachedSink,
  AttachKind,
  BindRoomConnectionOptions,
  RoomConnectionBinding,
  RoomConnectionLike,
  RoomFrameEvent,
  WelcomeEvent,
} from './room-connection.js';
export {
  bindRoomConnection,
  createRoomConnectionSink,
  describeRoomConnection,
  isRoomConnectionUsable,
  normaliseRoomFrame,
  ROOM_CONNECTION_KEY,
  readRoomConnection,
  serialiseFrame,
} from './room-connection.js';
