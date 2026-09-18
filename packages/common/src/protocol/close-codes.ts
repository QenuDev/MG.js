/**
 * Close codes and what to do about them.
 *
 * ## Where this table comes from, and why it supersedes the documentation
 *
 * The protocol field guide catalogues ten codes and states that five of them (4100/4200/4310/4500/4700)
 * are "not otherwise documented by any of the three projects", treating them as "reconnect-worthy by
 * default". **That is wrong**, and this file does not repeat it.
 *
 * The game's own client bundle contains the authoritative enum. In
 * `magicgarden.gg/version/<v>/assets/store-*.js`:
 *
 *     e[e.ReconnectInitiated=4100]=`ReconnectInitiated`,
 *     e[e.PlayerLeftVoluntarily=4200]=`PlayerLeftVoluntarily`,
 *     e[e.UserSessionSuperseded=4250]=`UserSessionSuperseded`,
 *     e[e.ConnectionSuperseded=4300]=`ConnectionSuperseded`,
 *     e[e.ServerDisposed=4310]=`ServerDisposed`,
 *     e[e.RoomTransitioning=4320]=`RoomTransitioning`,
 *     e[e.HeartbeatExpired=4400]=`HeartbeatExpired`,
 *     e[e.PlayerKicked=4500]=`PlayerKicked`,
 *     e[e.VersionMismatch=4700]=`VersionMismatch`,
 *     e[e.VersionExpired=4710]=`VersionExpired`,
 *     e[e.UserDataSchemaAhead=4720]=`UserDataSchemaAhead`,
 *     e[e.UnreadableUserData=4721]=`UnreadableUserData`,
 *     e[e.AuthenticationFailure=4800]=`AuthenticationFailure`,
 *     e[e.UnexpectedHandshakeError=4801]=`UnexpectedHandshakeError`,
 *     e[e.UserNotFound=4810]=`UserNotFound`,
 *     e[e.AuthenticatingExternalAccountRemoved=4830]=`AuthenticatingExternalAccountRemoved`,
 *     e[e.SessionExpired=4840]=`SessionExpired`,
 *     e[e.Banned=4900]=`Banned`
 *
 * Twenty codes in the build served today (1206; the 1192 capture this file was first read from had
 * eighteen, and the two it has gained are `AdmissionTimedOut = 4410` and `ConnectionAttemptObsolete =
 * 4420`). Several names change what a client should do. Three consequences matter:
 *
 *   - **4200 `PlayerLeftVoluntarily`, 4500 `PlayerKicked` and 4900 `Banned` are terminal.** Reconnecting
 *     on a kick or a ban is actively harmful, because the server will repeat the action. The "reconnect by
 *     default" advice was a guess and it guessed wrong.
 *   - **4720 `UserDataSchemaAhead` and 4721 `UnreadableUserData` mean the client is behind or the data
 *     is corrupt.** A reconnect cannot fix either.
 *   - **4700 `VersionMismatch` is a second version code**, alongside 4710. Both need a version refetch.
 *
 * Two documented names are kept as aliases so existing callers do not break, with the game's own name
 * as the primary: `Unspecified4100` → `ReconnectInitiated`, `IdleTimeout` → `HeartbeatExpired`, and so
 * on for every code the guide named but the bundle names differently.
 */

/** Application-defined close codes, named as the game's own client names them. */
export enum CloseCode {
  /** Normal closure. */
  Normal = 1000,
  /** Going away (page navigation, server shutdown). */
  GoingAway = 1001,

  /** The server is asking the client to reconnect. */
  ReconnectInitiated = 4100,
  /** The player left of their own accord. Terminal. */
  PlayerLeftVoluntarily = 4200,
  /** Session superseded via heartbeat-based supersession. */
  UserSessionSuperseded = 4250,
  /** Superseded by a newer connection for the same identity. */
  ConnectionSuperseded = 4300,
  /** The server is being disposed of and is telling clients to go elsewhere. */
  ServerDisposed = 4310,
  /** The room is transitioning; reconnect into the new one. */
  RoomTransitioning = 4320,
  /** The application-level keepalive went unanswered (~30s of silence). */
  HeartbeatExpired = 4400,
  /**
   * The socket opened but was never admitted.
   *
   * New in the 1206 build, and the reason is on the client: admission is the bare
   * `{"type":"SocketOpened"}` frame, and a client that opens a socket and stays silent is closed with
   * this once the server's admission window runs out (`@mg.js/headless` writes it on open).
   */
  AdmissionTimedOut = 4410,
  /**
   * This connection attempt was superseded by a newer attempt of the *same* client.
   *
   * New in the 1206 build, and one half of a pair with {@link AdmissionTimedOut}: the connect URL carries
   * a `clientConnectionAttempt` that the game's own client increments per attempt, so the server can tell
   * a stale attempt from the live one. A closed attempt is not this session's; the newer one is.
   */
  ConnectionAttemptObsolete = 4420,
  /** The player was kicked. Host-enforced, and terminal: reconnecting achieves nothing. */
  PlayerKicked = 4500,
  /** The client build does not match what the server expects. Refetch the version. */
  VersionMismatch = 4700,
  /** The client build is stale. Refetch the version. */
  VersionExpired = 4710,
  /** The server's user-data schema is ahead of this client. A reconnect cannot help. */
  UserDataSchemaAhead = 4720,
  /** The stored user data could not be read. A reconnect cannot help. */
  UnreadableUserData = 4721,
  /** Authentication failed: bad or expired `mc_jwt`, or no usable identity. */
  AuthenticationFailure = 4800,
  /** The handshake was not what the server expected. */
  UnexpectedHandshakeError = 4801,
  /** No player record for this identity. */
  UserNotFound = 4810,
  /** The external account this identity authenticated against was removed. Terminal. */
  AuthenticatingExternalAccountRemoved = 4830,
  /** The session expired and a new one must be established. */
  SessionExpired = 4840,
  /** The player is banned. Terminal. */
  Banned = 4900,

  // ---- Aliases for the names the protocol field guide used, so existing callers keep compiling. ----
  // These duplicate values by construction: an alias names the same numeric code the guide named
  // differently, so `noDuplicateEnumValues` is switched off for this one file in biome.json. The rule
  // still catches a genuine copy-paste mistake everywhere else.

  /** @deprecated The guide's name for {@link ReconnectInitiated}. */
  Unspecified4100 = 4100,
  /** @deprecated The guide's name for {@link PlayerLeftVoluntarily}. */
  Unspecified4200 = 4200,
  /** @deprecated The guide's name for {@link ServerDisposed}. */
  Unspecified4310 = 4310,
  /** @deprecated The guide's name for {@link HeartbeatExpired}. */
  IdleTimeout = 4400,
  /** @deprecated The guide's name for {@link PlayerKicked}. */
  Unspecified4500 = 4500,
  /** @deprecated The guide's name for {@link VersionMismatch}. */
  Unspecified4700 = 4700,
  /** @deprecated The guide's name for {@link AuthenticationFailure}. */
  AuthFailed = 4800,
  /** @deprecated The guide's name for {@link UserSessionSuperseded}. */
  Superseded = 4250,
  /** @deprecated The guide's name for {@link ConnectionSuperseded}. */
  SupersededByNewerSession = 4300,
}

/**
 * What a client should do after a given close.
 *
 * - `stop`: do not reconnect; the failure is terminal.
 * - `reconnect`: reconnect with the normal backoff.
 * - `reconnect-confirm`: a real supersession. **Do not reconnect on your own.** The game's developers
 *   asked for this explicitly: reconnecting a superseded session automatically "is unsafe, and can result
 *   in data loss, especially if the player has the game open in two rooms, as each room will play
 *   tug-of-war over the user, and the result is nothing gets saved", and as of version 473+ "servers are
 *   now more strict about allowing reconnection in the case of supersession, please do not automate this;
 *   it is only safe to do so with explicit confirmation from the player." Surface the state and wait for a
 *   human; re-run `analyzeClose` with `{ supersedeConfirmed: true }` once you have one.
 * - `reconnect-slow`: reconnect with a longer base delay. Only ever produced for a supersession that has
 *   *already* been confirmed, because "retrying instantly just gets superseded".
 * - `refetch-version`: re-resolve the game version *before* reconnecting, "or you'll just get
 *   closed again".
 * - `reconnect-bounded`: reconnect, but cap the attempts: "don't hammer a bad cookie forever".
 * - `renew-session`: a new session must be established, not merely a new socket.
 * - `refresh`: the page itself is stale; a reconnect cannot fix it. Bootstrapped clients surface this
 *   to the user instead of retrying.
 */
export type CloseDisposition =
  | 'stop'
  | 'reconnect'
  | 'reconnect-confirm'
  | 'reconnect-slow'
  | 'refetch-version'
  | 'reconnect-bounded'
  | 'renew-session'
  | 'refresh';

export interface CloseAnalysis {
  /** The raw code received. */
  code: number;
  /** Known code, or `null` for anything not in the game's enum. */
  known: CloseCode | null;
  /** The game's own name for the code, when known. */
  label: string | null;
  /** What to do. */
  disposition: CloseDisposition;
  /** True when the connection should be re-established at all. */
  shouldReconnect: boolean;
  /** True when the client must re-fetch the game version before reconnecting. */
  requiresVersionRefetch: boolean;
  /** True when reconnecting should use the longer superseded base delay. */
  isSuperseded: boolean;
  /**
   * True when a human has to confirm before anything may reconnect.
   *
   * Distinct from `shouldReconnect === false`: the latter can mean "never", while this means "not until a
   * person says so". A caller that keeps a UI is expected to ask; one that does not must stop.
   */
  requiresConfirmation: boolean;
  /** True when reconnect attempts should be capped. */
  isBounded: boolean;
  /** True when the close is terminal and no reconnect should ever be attempted. */
  isTerminal: boolean;
  /** Human-readable explanation. */
  reason: string;
}

/**
 * The verified code → name map, exported so callers can log or display the real name.
 *
 * Built from the enum rather than hand-written twice, so the two can never drift.
 */
export const CLOSE_CODE_LABELS: Readonly<Record<number, string>> = {
  4100: 'ReconnectInitiated',
  4200: 'PlayerLeftVoluntarily',
  4250: 'UserSessionSuperseded',
  4300: 'ConnectionSuperseded',
  4310: 'ServerDisposed',
  4320: 'RoomTransitioning',
  4400: 'HeartbeatExpired',
  4410: 'AdmissionTimedOut',
  4420: 'ConnectionAttemptObsolete',
  4500: 'PlayerKicked',
  4700: 'VersionMismatch',
  4710: 'VersionExpired',
  4720: 'UserDataSchemaAhead',
  4721: 'UnreadableUserData',
  4800: 'AuthenticationFailure',
  4801: 'UnexpectedHandshakeError',
  4810: 'UserNotFound',
  4830: 'AuthenticatingExternalAccountRemoved',
  4840: 'SessionExpired',
  4900: 'Banned',
};

/** Codes where a longer base delay is required, because an instant retry is superseded again. */
const SUPERSEDED_CODES = new Set<number>([CloseCode.UserSessionSuperseded, CloseCode.ConnectionSuperseded]);

/**
 * Codes that mean *this attempt* is not the session any more, so it must not come back on its own.
 *
 * `ConnectionAttemptObsolete` is the server answering the `clientConnectionAttempt` in the connect URL:
 * a newer attempt by this same client is the live one, and reconnecting the old one would fight it. That
 * is `stop` rather than the superseded family's `reconnect-confirm`, because there is nothing for a person
 * to confirm — the caller's own newer attempt is already the session.
 */
const OBSOLETE_ATTEMPT_CODES = new Set<number>([CloseCode.ConnectionAttemptObsolete]);

/**
 * Codes for which retrying is pointless or harmful.
 *
 * Every one of these was treated as "reconnect-worthy by default" under the documented table. That
 * default was wrong: a kick, a ban, a deliberate departure, a schema mismatch and unreadable data are
 * all states a new socket cannot change.
 */
const TERMINAL_CODES = new Set<number>([
  CloseCode.PlayerLeftVoluntarily,
  CloseCode.PlayerKicked,
  CloseCode.UserDataSchemaAhead,
  CloseCode.UnreadableUserData,
  CloseCode.AuthenticatingExternalAccountRemoved,
  CloseCode.Banned,
]);

/** Codes where a bounded number of retries is worth trying, but not forever. */
const BOUNDED_CODES = new Set<number>([
  CloseCode.AuthenticationFailure,
  CloseCode.UnexpectedHandshakeError,
  CloseCode.UserNotFound,
]);

/** Codes that mean this build is wrong and the version must be re-resolved first. */
const VERSION_CODES = new Set<number>([CloseCode.VersionMismatch, CloseCode.VersionExpired]);

/**
 * Classify a close event.
 *
 * @param code The close code received.
 * @param reason The close reason string, when the server sent one. Used to disambiguate 4300: the guide
 *   says to "check the reason string doesn't say heartbeat before treating it as a real supersede", and
 *   the bundle's `HeartbeatExpired` name for 4400 corroborates that the two paths exist.
 * @param wasManual Whether the client closed the socket itself (suppresses reconnect).
 * @param options `supersedeConfirmed: true` means a *person* has agreed to reclaim a superseded session,
 *   which is the only condition under which that reconnect is allowed. See {@link CloseDisposition}.
 */
export function analyzeClose(
  code: number,
  reason = '',
  wasManual = false,
  options: { supersedeConfirmed?: boolean } = {},
): CloseAnalysis {
  const label = CLOSE_CODE_LABELS[code] ?? null;
  const known = label === null ? null : (code as CloseCode);
  // `requiresConfirmation: false` lives on the shared base so every branch below answers it explicitly by
  // inheritance rather than by omission: only the superseded branch ever sets it true.
  const base = { code, known, label, requiresConfirmation: false };

  if (wasManual) {
    return {
      ...base,
      disposition: 'stop',
      shouldReconnect: false,
      requiresVersionRefetch: false,
      isSuperseded: false,
      isBounded: false,
      isTerminal: true,
      reason: 'Closed by this client.',
    };
  }

  if (code === CloseCode.Normal) {
    return {
      ...base,
      disposition: 'stop',
      shouldReconnect: false,
      requiresVersionRefetch: false,
      isSuperseded: false,
      isBounded: false,
      isTerminal: true,
      reason: 'Normal closure.',
    };
  }

  if (TERMINAL_CODES.has(code)) {
    const explanation =
      code === CloseCode.PlayerKicked
        ? 'The player was kicked. Reconnecting would only be kicked again.'
        : code === CloseCode.Banned
          ? 'The player is banned.'
          : code === CloseCode.PlayerLeftVoluntarily
            ? 'The player left deliberately.'
            : code === CloseCode.UserDataSchemaAhead
              ? "The server's user-data schema is ahead of this client; a reconnect cannot help."
              : code === CloseCode.UnreadableUserData
                ? 'The stored user data could not be read; a reconnect cannot help.'
                : 'The external account this identity authenticated against was removed.';
    return {
      ...base,
      disposition: 'stop',
      shouldReconnect: false,
      requiresVersionRefetch: false,
      isSuperseded: false,
      isBounded: false,
      isTerminal: true,
      reason: explanation,
    };
  }

  if (VERSION_CODES.has(code)) {
    return {
      ...base,
      disposition: 'refetch-version',
      shouldReconnect: true,
      requiresVersionRefetch: true,
      isSuperseded: false,
      isBounded: false,
      isTerminal: false,
      reason:
        'The client build does not match. Re-fetch the current game version before reconnecting, or ' +
        'you will just get closed again.',
    };
  }

  if (OBSOLETE_ATTEMPT_CODES.has(code)) {
    return {
      ...base,
      disposition: 'stop',
      shouldReconnect: false,
      requiresVersionRefetch: false,
      isSuperseded: false,
      isBounded: false,
      isTerminal: true,
      reason:
        'This connection attempt is obsolete: a newer attempt by this client is the live session, so ' +
        'reconnecting this one would only fight it.',
    };
  }

  if (code === CloseCode.AdmissionTimedOut) {
    return {
      ...base,
      disposition: 'reconnect',
      shouldReconnect: true,
      requiresVersionRefetch: false,
      isSuperseded: false,
      isBounded: true,
      isTerminal: false,
      reason:
        'The socket opened but the server never admitted it. A client admits itself with the bare ' +
        '`{"type":"SocketOpened"}` frame on open; if that frame was sent and the server still timed out, ' +
        'the room was slow or full. Bounded retries.',
    };
  }

  if (SUPERSEDED_CODES.has(code)) {
    // 4300 can also mean "our own heartbeat superseded us", which is an ordinary reconnect rather than
    // a real supersede by another client. That case is *not* covered by the developers' warning, because
    // nothing is fighting over the identity, so it keeps reconnecting on its own.
    const isHeartbeat = /heartbeat/i.test(reason);

    if (isHeartbeat) {
      return {
        ...base,
        disposition: 'reconnect',
        shouldReconnect: true,
        requiresVersionRefetch: false,
        isSuperseded: false,
        requiresConfirmation: false,
        isBounded: false,
        isTerminal: false,
        reason: 'Superseded by our own heartbeat. Reconnect normally.',
      };
    }

    // A real supersession. The default is *refusal*, not a slow retry: the developers asked for this
    // specifically, because two clients reclaiming the same identity in turn make each other lose the
    // session and nothing gets saved. `supersedeConfirmed` is the caller telling us a person said yes.
    if (options.supersedeConfirmed !== true) {
      return {
        ...base,
        disposition: 'reconnect-confirm',
        shouldReconnect: false,
        requiresVersionRefetch: false,
        isSuperseded: true,
        requiresConfirmation: true,
        isBounded: false,
        isTerminal: false,
        reason:
          'Session superseded by another connection. Reconnecting automatically can lose data (the game ' +
          'developers warn that two clients reclaiming the same identity leaves nothing saved), so this ' +
          'needs explicit confirmation. Re-run analyzeClose() with { supersedeConfirmed: true } once a ' +
          'person has agreed.',
      };
    }

    return {
      ...base,
      disposition: 'reconnect-slow',
      shouldReconnect: true,
      requiresVersionRefetch: false,
      isSuperseded: true,
      requiresConfirmation: false,
      isBounded: false,
      isTerminal: false,
      reason:
        'Session superseded, and the player has confirmed the reclaim. Reconnect with ' +
        'reclaimSupersededSession=true and a longer base delay.',
    };
  }

  if (BOUNDED_CODES.has(code)) {
    return {
      ...base,
      disposition: 'reconnect-bounded',
      shouldReconnect: true,
      requiresVersionRefetch: false,
      isSuperseded: false,
      isBounded: true,
      isTerminal: false,
      reason: 'Authentication or handshake problem. Bounded retries only, so do not hammer it forever.',
    };
  }

  if (code === CloseCode.SessionExpired) {
    return {
      ...base,
      disposition: 'renew-session',
      shouldReconnect: true,
      requiresVersionRefetch: false,
      isSuperseded: false,
      isBounded: true,
      isTerminal: false,
      reason:
        'The session expired. A new socket alone is not enough, because a fresh session has to be ' +
        'established through the same path the page uses before connecting. On a cold, session-less ' +
        'connect this is the code a raw client receives.',
    };
  }

  // ReconnectInitiated, ServerDisposed, RoomTransitioning, HeartbeatExpired: all four want a new
  // socket, and all four are named by the game's own enum.
  if (
    code === CloseCode.ReconnectInitiated ||
    code === CloseCode.ServerDisposed ||
    code === CloseCode.RoomTransitioning ||
    code === CloseCode.HeartbeatExpired ||
    code === CloseCode.GoingAway
  ) {
    return {
      ...base,
      disposition: 'reconnect',
      shouldReconnect: true,
      requiresVersionRefetch: false,
      isSuperseded: false,
      isBounded: false,
      isTerminal: false,
      reason: reason.length > 0 ? reason : `${label ?? 'Server close'}: reconnect.`,
    };
  }

  return {
    ...base,
    disposition: 'reconnect',
    shouldReconnect: true,
    requiresVersionRefetch: false,
    isSuperseded: false,
    isBounded: false,
    isTerminal: false,
    reason:
      code > 4000
        ? `Application close code ${code}, not present in the game's own close-code enum. Reconnecting by default.`
        : `Unrecognised standard close code ${code}. Reconnecting by default.`,
  };
}
