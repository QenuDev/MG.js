/**
 * The `wss://` URL for one connect attempt, and the pure steps that build it.
 *
 * Split out of `client.ts` (Phase 5 Task 5.5b). All three functions are pure: they read their arguments
 * and return a value, so moving them cannot change behaviour, and the URL is the one part of a connect
 * attempt a caller can reproduce without opening a socket.
 */

import { buildConnectUrlDetailed } from '@mg.js/common';

/**
 * Fold an explicit port into the host string, unless the host already carries one.
 * @internal
 */
export function joinHost(host: string | undefined, port: number | undefined): string | undefined {
  if (host === undefined) return undefined;
  if (port === undefined) return host;
  if (host.includes(':')) return host;
  return `${host}:${port}`;
}

/**
 * Append an auth provider's query parameters to an already-built connect URL.
 *
 * `URLSearchParams.set` is used rather than string concatenation so the values are percent-encoded the
 * same way `buildConnectUrlDetailed` encodes its own. A provider is never allowed to *replace* a
 * documented parameter: colliding with one of the §1.3/§1.4 names would silently change the connection's
 * identity, so a duplicate key is skipped.
 */
export function appendAuthQuery(url: string, query: Record<string, string> | undefined): string {
  if (query === undefined) return url;
  const entries = Object.entries(query).filter(([, value]) => typeof value === 'string');
  if (entries.length === 0) return url;

  const parsed = new URL(url);
  for (const [key, value] of entries) {
    if (parsed.searchParams.has(key)) continue;
    parsed.searchParams.set(key, value);
  }
  return parsed.toString();
}

/**
 * What one attempt contributes to its URL.
 * @internal
 */
export interface AttemptUrlInput {
  /** Already folded through {@link joinHost} by the caller. */
  host: string | undefined;
  version: string;
  room: string | undefined;
  /** Empty string means "this session has no id yet"; the builder mints one. */
  documentId: string;
  connectionAttempt: number;
  isReload: boolean;
  /** Omitted from the query entirely unless a superseded close actually happened. */
  reclaimSuperseded: boolean;
  /** The providers query parameters, appended last and never allowed to replace a documented key. */
  authQuery: Record<string, string> | undefined;
}

/**
 * The three values the attempt needs back: two are server-assigned and must be carried forward.
 * @internal
 */
export interface AttemptUrl {
  url: string;
  documentId: string;
  room: string;
}

/**
 * Build one attempt's URL.
 *
 * `buildConnectUrlDetailed` is the common package's single implementation of the §1.3 encoding rule
 * ("every value in the query string is JSON-encoded"), including the asymmetry that leaves
 * `clientConnectionAttempt=1` and `reclaimSupersededSession=true` unquoted. The returned `documentId`
 * and `room` are assigned by the server on the first attempt and must be carried into the next one, which
 * is why this returns them rather than making the caller dig them back out of the URL.
 * @internal
 */
export function buildAttemptUrl(input: AttemptUrlInput): AttemptUrl {
  const built = buildConnectUrlDetailed({
    ...(input.host !== undefined ? { host: input.host } : {}),
    version: input.version,
    ...(input.room !== undefined ? { room: input.room } : {}),
    ...(input.documentId !== '' ? { documentId: input.documentId } : {}),
    connectionAttempt: input.connectionAttempt,
    isReload: input.isReload,
    ...(input.reclaimSuperseded ? { reclaimSuperseded: true } : {}),
  });
  return {
    url: appendAuthQuery(built.url, input.authQuery),
    documentId: built.documentId,
    room: built.room,
  };
}
