/**
 * Connect-URL construction, a pure function split out so it can be unit-tested and reused by any
 * client that wants to open the socket itself.
 *
 * The template is:
 *   wss://<host>/version/<gameVersion>/api/rooms/<roomId>/connect?...
 *
 * THE CRITICAL RULE: every string query value is JSON-encoded, "including plain strings, which
 * arrive quoted (`"web"`, not `web`)". The doc adds that this mirrors what the real client sends,
 * string quoting included. Numeric and boolean parameters are *not* quoted; the doc's own reference
 * builder writes `clientConnectionAttempt=1` and `reclaimSupersededSession=true`.
 */

import { randomRoomSlug, randomUuid } from './id.js';
import type { ConnectOptions } from './wire.js';

/** Default host for the official game. */
export const DEFAULT_HOST = 'magicgarden.gg';

/**
 * Encode a query value the way the real client does.
 *
 * Strings are JSON-encoded (so they arrive quoted); everything else is stringified plainly.
 */
export function encodeQueryValue(value: string | number | boolean): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/** Everything the builder resolved, for logging and for reuse across reconnect attempts. */
export interface BuiltConnectUrl {
  /** The full `wss://` URL. */
  url: string;
  /** The host that was used. */
  host: string;
  /** The room slug that was used, generated when the caller omitted one. */
  room: string;
  /** The document id that was used, generated when the caller omitted one. */
  documentId: string;
  /** The attempt number that was written into the URL. */
  connectionAttempt: number;
}

/**
 * Refuse a `version` or `room` that percent-encoding cannot make safe.
 *
 * `encodeURIComponent` protects the characters that have meaning *inside* a segment (`?`, `#`, space,
 * `%`), but it leaves `.` alone and the server decodes the path before routing: a literal `.`/`..`, or a
 * `%2F`/`%5C`/`%00` that decodes back to a separator or NUL, still rewrites the request path. Refusing
 * such a value, naming the parameter and the value, is the honest fix; encoding it is not.
 */
function assertSinglePathSegment(name: 'version' | 'room', value: string): void {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    /[/\\]/.test(value) ||
    value.includes('\u0000')
  ) {
    throw new Error(
      `buildConnectUrl: ${name} must be a single path segment, got ${JSON.stringify(value)}. A value ` +
        `that is empty, "." or "..", or that contains a path separator or NUL, does not stay one segment.`,
    );
  }
}

/**
 * Build the connect URL and report every value the builder chose.
 *
 * Prefer this over {@link buildConnectUrl} when the caller needs to know the generated `room` or
 * `documentId`: those must stay stable across reconnect attempts, and a bare string return value
 * hides them.
 */
export function buildConnectUrlDetailed(options: ConnectOptions): BuiltConnectUrl {
  const host = options.host ?? DEFAULT_HOST;
  const room = options.room && options.room.length > 0 ? options.room : randomRoomSlug();
  const documentId = options.documentId && options.documentId.length > 0 ? options.documentId : randomUuid();
  const connectionAttempt = options.connectionAttempt ?? 1;

  // `URL`'s own path handling is tolerant of `..`, `?`, `#` and empty segments, which lets a caller's
  // room name or version rewrite the request shape (measured: `../../evil` removes the `/api/rooms/`
  // prefix, `a?x=1` injects a query parameter, and `a#frag` moves `/connect` into the fragment, where it
  // is never sent). Encoding each path segment protects the characters that have meaning *inside* a
  // segment (`?`, `#`, space, `%`), and is byte-identical to the previous behaviour for the
  // `[A-Za-z0-9_-]` slugs the live host issues. It cannot protect a value that changes the segment
  // structure after the server decodes the path (`.`, `..`, an empty value, or a separator/NUL), so
  // those are refused rather than encoded.
  assertSinglePathSegment('version', options.version);
  assertSinglePathSegment('room', room);
  const url = new URL(
    `wss://${host}/version/${encodeURIComponent(options.version)}/api/rooms/${encodeURIComponent(room)}/connect`,
  );
  const params = url.searchParams;

  params.set('surface', encodeQueryValue(options.surface ?? 'web'));
  params.set('platform', encodeQueryValue(options.platform ?? 'desktop'));
  params.set('version', encodeQueryValue(options.version));
  params.set('capabilities', encodeQueryValue(options.capabilities ?? 'fbo_mipmap_unsupported'));
  params.set('locale', encodeQueryValue(options.locale ?? 'en'));

  // Only ever sent as literal `true`, and only for a superseded reconnect. Never send `false`.
  if (options.reclaimSuperseded) params.set('reclaimSupersededSession', 'true');

  params.set('clientDocumentId', encodeQueryValue(documentId));
  params.set('clientConnectionAttempt', String(connectionAttempt));
  params.set('clientNavigationType', encodeQueryValue(options.isReload ? 'reload' : 'navigate'));
  params.set('clientVisibilityState', encodeQueryValue(options.clientVisibilityState ?? 'visible'));

  return { url: url.toString(), host, room, documentId, connectionAttempt };
}

/**
 * Build the `wss://` URL that was opened, for logging/debugging.
 *
 * This mirrors the API reference's `RoomSocket#buildConnectUrl` return contract exactly.
 */
export function buildConnectUrl(options: ConnectOptions): string {
  return buildConnectUrlDetailed(options).url;
}
