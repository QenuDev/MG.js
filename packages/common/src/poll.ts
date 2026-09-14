/**
 * The one deadline poll, and the one cancellable watch built on it.
 *
 * ## Why this is in `common` rather than in `bootstrapped`
 *
 * The same loop was written five times: twice in `bootstrapped/attach/detect.ts`, once in
 * `render/ctors.ts`, once in `jotai/bridge.ts` and once in `attach/transport.ts`, and a sixth and
 * seventh time as test helpers in `headless/tests` and `bootstrapped/tests`. The copies agreed on the
 * mechanics and disagreed about the only question that matters: what the end of the window *means*
 * (resolve a fallback / reject / call back / fall silent / never). A caller could not predict one
 * from another. DESIGN §3.1 rule 2: a helper used from two packages is a missing `common` module.
 *
 * ## Why the scheduler is injected and not defaulted
 *
 * `common` compiles with no DOM and no `node:*` (I9). A `setTimeout` default here would be a new I9
 * violation and would break the moment `common`'s `lib` is narrowed to `ES2022`. So `schedule` is
 * required and each package supplies its own: `setTimeout` in `bootstrapped`, and a fake in tests.
 * That is what makes these loops testable without real time.
 *
 * ## Why there are two functions and not one
 *
 * `pollUntil` answers "wait for it" and `watchUntil` answers "tell me if it ever appears and give me a
 * way to stop looking". A watch cannot be expressed as an awaitable promise without giving the caller a
 * promise it can never cancel, which is the leak (`watchForRoomConnection` is started at
 * `document-start` and outlives the caller that would have awaited it).
 */

/** How to schedule, cancel and read time. Injected so `common` needs no timer global. */
export interface PollClock {
  /** Run `callback` after `delayMs`. Returns whatever {@link PollClock.cancelSchedule} understands. */
  schedule: (callback: () => void, delayMs: number) => unknown;
  /** Cancel a handle returned by {@link PollClock.schedule}. Omitted when the caller never cancels. */
  cancelSchedule?: (handle: unknown) => void;
  /** Now, in ms. Default `Date.now`. */
  now?: () => number;
}

/** The options both poll forms share. */
export interface PollOptions<T> extends PollClock {
  /** One attempt. Return the value when it is ready, `null` while it is not. */
  attempt: (attempt: number) => T | null;
  /**
   * Give up after this long. `Number.POSITIVE_INFINITY` means "no deadline" and is legal only for a
   * watch whose handle is always retained and always released, never for a `pollUntil`.
   */
  timeoutMs: number;
  /** How long to wait between attempts. */
  intervalMs: number;
  /**
   * Whether the first attempt runs now or after one interval. Default `'now'`.
   *
   * Both are correct answers to different questions: a caller that has *already* tried and failed
   * (`waitForAttachment` probes once before starting the poll) must not retry into the same frame, while
   * a caller that has not (`getCtors`) must not wait a whole interval to report a value that is already
   * there. Making this explicit is what stops the merge from silently changing either.
   */
  firstAttempt?: 'now' | 'afterInterval';
}

/** Options for {@link watchUntil}. */
export interface WatchUntilOptions<T> extends PollOptions<T> {
  /**
   * Called once, with the first non-null attempt. Never called after the stop has run.
   *
   * Omit it for a *level observer*, a watch with no "found" state, such as `AttachedTransport`'s
   * readiness poll, which ticks until its retained stop runs. Such a watch must pass
   * `timeoutMs: Number.POSITIVE_INFINITY`; a finite deadline would then close silently.
   */
  onFound?: (value: T) => void;
  /** Called once, with the number of attempts made, when the window closes with nothing found. */
  onTimeout?: (attempts: number) => void;
}

/** Options for {@link pollUntil}. */
export interface PollUntilOptions<T> extends PollOptions<T> {
  /** What the window closing means. Default: give up and answer `null`. */
  onTimeout?: (attempts: number) => T | null;
}

/**
 * Start a deadline poll. Returns the stop function.
 *
 * The stop is total: it cancels a pending tick *and* suppresses a delivery that is already in flight, so
 * a caller which stops from inside `attempt` is never handed a value afterwards.
 */
export function watchUntil<T>(options: WatchUntilOptions<T>): () => void {
  const now = options.now ?? Date.now;
  const startedAt = now();
  let stopped = false;
  let handle: unknown = null;
  let attempts = 0;

  const stop = (): void => {
    stopped = true;
    if (handle !== null) {
      options.cancelSchedule?.(handle);
      handle = null;
    }
  };

  const tick = (): void => {
    handle = null;
    if (stopped) return;
    attempts += 1;
    const value = options.attempt(attempts);
    if (stopped) return;
    if (value !== null) {
      stopped = true;
      options.onFound?.(value);
      return;
    }
    if (now() - startedAt >= options.timeoutMs) {
      stopped = true;
      options.onTimeout?.(attempts);
      return;
    }
    handle = options.schedule(tick, options.intervalMs);
  };

  if (options.firstAttempt === 'afterInterval') handle = options.schedule(tick, options.intervalMs);
  else tick();
  return stop;
}

/**
 * Poll until `attempt` answers non-null, or the window closes.
 *
 * The first overload is the one that matters for callers whose closed window is an *answer* rather than a
 * give-up: when `onTimeout` is total (it returns a `T`), so is the promise, and the caller does not have
 * to re-state the fallback to satisfy the type checker. `waitForAttachment` relies on this.
 */
export function pollUntil<T>(
  options: PollUntilOptions<T> & { onTimeout: (attempts: number) => T },
): Promise<T>;
export function pollUntil<T>(options: PollUntilOptions<T>): Promise<T | null>;
export function pollUntil<T>(options: PollUntilOptions<T>): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    watchUntil<T>({
      ...options,
      onFound: (value) => {
        resolve(value);
      },
      onTimeout: (attempts) => {
        resolve(options.onTimeout?.(attempts) ?? null);
      },
    });
  });
}

/**
 * Ask a Node timer not to hold the process open. A browser's numeric handle is left alone.
 *
 * Written structurally, as `'unref' in timer`, rather than by importing `node:timers`, because `common` is
 * platform-free (I9) and the browser's timer functions return a number. The copies this replaces were
 * three different spellings of the same two checks, and two of them omitted the `try`/`catch`, so a
 * timer-like object whose `unref` throws took down the caller's teardown path.
 *
 * It is a *teardown* helper, not a poll: it neither schedules nor cancels, so a caller that also wants the
 * pending timer gone must cancel it first (the poll's stop does exactly that).
 */
export function unrefTimer(timer: unknown): void {
  if (timer === null || typeof timer !== 'object') return;
  if (!('unref' in timer)) return;
  const { unref } = timer as { unref?: unknown };
  if (typeof unref !== 'function') return;
  try {
    unref.call(timer);
  } catch {
    // Not a Node timer after all.
  }
}
