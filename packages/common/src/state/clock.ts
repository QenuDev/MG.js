/**
 * The game's server clock, as the game itself tracks it.
 *
 * ## Why this is not `Date.now()`
 *
 * Almost every interesting question about a garden is a comparison against a timestamp the *server*
 * produced: is this crop ready, how long until it matures, has this shop restocked. Those timestamps are
 * server milliseconds, and a player's machine clock can be minutes off. Comparing a crop's finish time
 * against the machine clock then reports it as unripe long after the player can see it is ready, which is
 * a bug nobody can reproduce on the machine of whoever wrote it. The comparison is deliberately not
 * written out here as code: `poll.test.ts` scans for that shape and a comment is not exempt.
 *
 * The game does not make that mistake. It keeps a clock that is anchored to a server timestamp and only
 * ever moves it forward:
 *
 *     reset(e)   // on Welcome: anchor = { clientTimeMs: now(), serverTimeMs: e.publishedAtServerMs }
 *     observe(e) // on every RoomFrame: re-anchor if the observed server time is ahead of ours
 *     now()      // serverTimeAt(now())
 *
 * This module is that algorithm: `reset` from `Welcome`, `observe` from every `RoomFrame`, and `now()` for
 * everyone else. The anchors are the same two fields the game reads, so a crop the game draws as ready is
 * a crop this reports as ready.
 *
 * ## Before the first anchor
 *
 * `now()` answers client time, and `anchored` is false. Every accessor that depends on it can therefore be
 * used before the first `Welcome`, and a caller who cares about the distinction can read `anchored` or
 * `skewMs` rather than being handed a plausible-looking wrong number.
 */

/** The clock's current state, for a diagnostic snapshot. */
export interface ServerClockState {
  /** True once a server timestamp has been seen. Before that, `now()` is client time. */
  readonly anchored: boolean;
  /** How far the server is ahead of the client, in milliseconds. `null` before the first anchor. */
  readonly skewMs: number | null;
}

export class ServerClock {
  private clientTimeMs: () => number;
  private anchorClientMs: number | null = null;
  private anchorServerMs = 0;

  /**
   * @param clientTimeMs The local clock, injectable so a test can move time without waiting.
   */
  constructor(clientTimeMs: () => number = () => Date.now()) {
    this.clientTimeMs = clientTimeMs;
  }

  /** Anchor from a `Welcome`, which is the one message guaranteed to carry a server timestamp. */
  reset(publishedAtServerMs: unknown): boolean {
    const serverMs = asFiniteMs(publishedAtServerMs);
    if (serverMs === null) return false;
    this.anchorClientMs = this.clientTimeMs();
    this.anchorServerMs = serverMs;
    return true;
  }

  /**
   * Anchor from a `RoomFrame`.
   *
   * Only moves forward. Frames arrive out of order after a reconnect, and re-anchoring on an older
   * timestamp would walk the clock backwards, which shows a ripe crop as unripe.
   */
  observe(publishedAtServerMs: unknown): boolean {
    const serverMs = asFiniteMs(publishedAtServerMs);
    if (serverMs === null) return false;
    const clientMs = this.clientTimeMs();
    if (this.anchorClientMs !== null && serverMs <= this.serverTimeAt(clientMs)) return false;
    this.anchorClientMs = clientMs;
    this.anchorServerMs = serverMs;
    return true;
  }

  /** The server's time now, in server milliseconds. Client time until the first anchor. */
  now(): number {
    return this.serverTimeAt(this.clientTimeMs());
  }

  /** What the server's time was at a given client time. */
  private serverTimeAt(clientMs: number): number {
    if (this.anchorClientMs === null) return clientMs;
    return this.anchorServerMs + (clientMs - this.anchorClientMs);
  }

  /** The current state, for a report. */
  get state(): ServerClockState {
    if (this.anchorClientMs === null) return { anchored: false, skewMs: null };
    return { anchored: true, skewMs: this.anchorServerMs - this.anchorClientMs };
  }

  /** True once a server timestamp has been seen. */
  get anchored(): boolean {
    return this.anchorClientMs !== null;
  }

  /** How far the server is ahead of this machine, in milliseconds. `null` before the first anchor. */
  get skewMs(): number | null {
    return this.state.skewMs;
  }

  /** Replace the local clock source. Used by the tests to advance time deterministically. */
  setClientClock(clientTimeMs: () => number): void {
    this.clientTimeMs = clientTimeMs;
  }
}

/** A usable millisecond timestamp, or `null`. Accepts a number or a numeric string, which some builds send. */
export function asFiniteMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}
