/**
 * The room connection, as one entry point.
 *
 * Phase 5 Task 5.7d split this file's contents into `room-types.ts`, `room-binding.ts`,
 * `room-frames.ts` and `room-sink.ts`. Every name it exported before is still exported here, so the five
 * import sites, including `client.ts`'s `satisfies import('./attach/room-connection.js').AttachedSink`,
 * which sits in type position and which a grep for `from '` cannot see, keep compiling unchanged. The
 * facade is what makes the split revertable in one commit.
 */

export { bindRoomConnection, readRoomConnection } from './room-binding.js';
export { normaliseRoomFrame, serialiseFrame } from './room-frames.js';
export { createRoomConnectionSink, describeRoomConnection, isRoomConnectionUsable } from './room-sink.js';
export type {
  AttachedSink,
  AttachKind,
  BindRoomConnectionOptions,
  RoomConnectionBinding,
  RoomConnectionLike,
  RoomFrameEvent,
  SinkWiring,
  WelcomeEvent,
} from './room-types.js';
export { ROOM_CONNECTION_KEY } from './room-types.js';
