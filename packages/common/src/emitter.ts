/**
 * A minimal typed event emitter.
 *
 * Written rather than imported because the bootstrapped client must bundle to a standalone userscript
 * with no imports, and Node's `EventEmitter` is not available in a browser page. Kept tiny by design:
 * `on`/`once`/`off`/`emit`, listener errors isolated so one bad handler cannot break a state sync.
 */

export type Listener<TArgs extends unknown[]> = (...args: TArgs) => void;

/** An event map: event name to argument tuple. */
export type EventMap = Record<string, unknown[]>;

export class Emitter<TEvents extends EventMap> {
  private readonly listeners = new Map<keyof TEvents, Set<Listener<never>>>();

  /** Subscribe. Returns a function that detaches. */
  on<TKey extends keyof TEvents>(event: TKey, listener: Listener<TEvents[TKey]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  /** Subscribe for a single delivery. */
  once<TKey extends keyof TEvents>(event: TKey, listener: Listener<TEvents[TKey]>): () => void {
    const off = this.on(event, ((...args: TEvents[TKey]) => {
      off();
      listener(...args);
    }) as Listener<TEvents[TKey]>);
    return off;
  }

  /** Unsubscribe. */
  off<TKey extends keyof TEvents>(event: TKey, listener: Listener<TEvents[TKey]>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(listener as Listener<never>);
    if (set.size === 0) this.listeners.delete(event);
  }

  /**
   * Called when a listener throws.
   *
   * The default is to swallow, because this emitter carries state-sync events and one throwing subscriber
   * must not prevent the others from seeing the update or unwind into the socket's message handler. A host
   * that needs to *observe* the failure (to log it, or to record it) overrides this rather than
   * reimplementing {@link emit}.
   */
  protected onListenerError(_event: keyof TEvents, _error: unknown): void {
    // Intentionally isolated.
  }

  /**
   * Emit to every listener.
   *
   * Listener exceptions are isolated: every other subscriber still sees the event, and the throw is
   * handed to {@link onListenerError} instead of unwinding into the socket's message handler.
   */
  emit<TKey extends keyof TEvents>(event: TKey, ...args: TEvents[TKey]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as unknown as Listener<TEvents[TKey]>)(...args);
      } catch (error) {
        this.onListenerError(event, error);
      }
    }
  }

  /** How many listeners an event currently has, used by tests and diagnostics. */
  listenerCount(event: keyof TEvents): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  /** Drop every listener. */
  clear(): void {
    this.listeners.clear();
  }

  /** @deprecated Use {@link clear}. Kept so the existing callers keep working. */
  removeAllListeners(): void {
    this.clear();
  }
}
