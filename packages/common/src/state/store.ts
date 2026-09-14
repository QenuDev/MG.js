/**
 * The observable state store.
 *
 * Holds the authoritative tree the server has described and tells subscribers what changed. Two
 * design choices worth stating:
 *
 * 1. **Patches are applied in place, and subscribers are told which pointers moved.** Deep-cloning a
 *    garden-sized tree on every patch batch would be wasteful, and the reference mod this workspace
 *    already contains resorts to 250 ms polling and string-signature diffing because it had
 *    no change information. Patch operations *are* the change information; we use them.
 *
 * 2. **A subscriber fires when its path and a changed path are related in either direction.** A
 *    subscriber on `/data/inventory` wakes for a change at `/data/inventory/3` (descendant) and for a
 *    change at `/data` (ancestor, which may have replaced its value wholesale). Nothing else wakes it.
 */

import { MgConfigError, MgTransportError } from '../errors.js';
import type { Patch } from '../protocol/wire.js';
import type { Unsubscribe } from '../unsubscribe.js';
import type { ApplyPatchOptions, ApplyPatchResult } from './patch.js';
import { applyPatch, deepClone, deepEqual } from './patch.js';
import { getPointer, pointerContains } from './pointer.js';

/** Why a subscriber was woken. */
export interface StateChange {
  /** The store's version after the change. */
  version: number;
  /** Every pointer that was touched, in application order. */
  changedPaths: readonly string[];
  /** The path this subscriber is watching. */
  watchedPath: string;
  /** The value at the watched path now. */
  value: unknown;
  /** The patch batch that caused this, when the change came from patches rather than a snapshot. */
  patches?: readonly Patch[];
  /** True when the whole tree was replaced (a fresh `Welcome`). */
  wasSnapshot: boolean;
}

export type StateSubscriber = (change: StateChange) => void;

interface Subscription {
  id: number;
  path: string;
  handler: StateSubscriber;
}

/** Options for {@link ObservableStore}. */
export interface ObservableStoreOptions {
  /** The initial document. Defaults to an empty `{ data, child: { data } }` shell. */
  initial?: unknown;
  /** Applied to paths before they are used for subscriber matching. */
  normalizePath?: (path: string) => string;
}

/** The empty tree shape: room state at `.data`, game state at `.child.data`. */
export function emptyStateTree(): {
  data: Record<string, unknown>;
  child: { data: Record<string, unknown> };
} {
  return { data: {}, child: { data: {} } };
}

/**
 * The state tree, with change notification.
 *
 * Not a general-purpose reactive library: it is narrow, so it can run inside a userscript
 * sharing a page with React without pulling a scheduler along with it.
 */
export class ObservableStore {
  private tree: unknown;
  private currentVersion = 0;
  private readonly subscriptions = new Map<number, Subscription>();
  private nextSubscriptionId = 1;
  private readonly normalizePath: (path: string) => string;
  /** Total patch operations applied over this store's lifetime, for diagnostics. */
  private patchCount = 0;
  /** Operations that failed to apply, for diagnostics. */
  private patchFailures = 0;

  constructor(options: ObservableStoreOptions = {}) {
    this.tree = options.initial ?? emptyStateTree();
    this.normalizePath = options.normalizePath ?? ((path) => path);
  }

  /** The whole tree. Treat as read-only. */
  get root(): unknown {
    return this.tree;
  }

  /** Room state, at `fullState.data`: players, chat, host. */
  get room(): unknown {
    return getPointer(this.tree, '/data');
  }

  /** Game state, at `fullState.child.data`: garden, inventory, shops, weather. */
  get game(): unknown {
    return getPointer(this.tree, '/child/data');
  }

  /** Monotonic version, incremented once per applied batch. */
  get version(): number {
    return this.currentVersion;
  }

  /** Diagnostics. */
  get stats(): { version: number; patchCount: number; patchFailures: number; subscribers: number } {
    return {
      version: this.currentVersion,
      patchCount: this.patchCount,
      patchFailures: this.patchFailures,
      subscribers: this.subscriptions.size,
    };
  }

  /** Read a pointer. Returns `undefined` when it does not resolve. */
  get(path: string): unknown {
    return getPointer(this.tree, path);
  }

  /** True when a pointer resolves. */
  has(path: string): boolean {
    return getPointer(this.tree, path) !== undefined;
  }

  /** A deep copy of the whole tree, safe to hand to a caller. */
  snapshot(): unknown {
    return deepClone(this.tree);
  }

  /**
   * Replace the tree outright, for the `Welcome` path.
   *
   * Every subscriber is woken, because after a snapshot nothing can be assumed unchanged.
   */
  replaceRoot(next: unknown): StateChange {
    this.tree = next ?? emptyStateTree();
    this.currentVersion += 1;
    const change: StateChange = {
      version: this.currentVersion,
      changedPaths: [''],
      watchedPath: '',
      value: this.tree,
      wasSnapshot: true,
    };
    this.notifyAll(change);
    return change;
  }

  /**
   * Apply a patch batch and wake the subscribers it affected.
   *
   * Returns both the raw patch result (so callers can see tolerance fallbacks and failures) and the
   * change record that was dispatched.
   */
  applyPatches(
    patches: readonly Patch[],
    options?: ApplyPatchOptions,
  ): { result: ApplyPatchResult; change: StateChange } {
    const result = applyPatch(this.tree, patches, options);
    this.patchCount += patches.length;
    this.patchFailures += result.failed;

    this.currentVersion += 1;

    const changedPaths = result.outcomes
      .filter((outcome) => outcome.ok)
      .map((outcome) => outcome.appliedPath);

    const change: StateChange = {
      version: this.currentVersion,
      changedPaths,
      watchedPath: '',
      value: this.tree,
      patches,
      wasSnapshot: false,
    };

    this.notifyAffected(change, changedPaths);
    return { result, change };
  }

  /**
   * Subscribe to a path.
   *
   * @param path The JSON Pointer to watch. `''` watches the whole tree.
   * @param handler Called whenever that path, an ancestor, or a descendant changes.
   * @param options `fireImmediately` delivers the current value on subscribe, which is usually what a
   *   caller wants, since the state may already be populated by the time they subscribe.
   */
  subscribe(
    path: string,
    handler: StateSubscriber,
    options: { fireImmediately?: boolean } = {},
  ): Unsubscribe {
    const normalized = this.normalizePath(path);
    const id = this.nextSubscriptionId;
    this.nextSubscriptionId += 1;
    this.subscriptions.set(id, { id, path: normalized, handler });

    if (options.fireImmediately) {
      const value = this.get(normalized);
      if (value !== undefined) {
        try {
          handler({
            version: this.currentVersion,
            changedPaths: [],
            watchedPath: normalized,
            value,
            wasSnapshot: true,
          });
        } catch {
          // A throwing subscriber must not break the store.
        }
      }
    }

    return () => {
      this.subscriptions.delete(id);
    };
  }

  /** Subscribe to every change. */
  subscribeAll(handler: StateSubscriber): Unsubscribe {
    return this.subscribe('', handler);
  }

  /**
   * Wait for a path to satisfy a predicate.
   *
   * Resolves immediately when the predicate already holds. This is the primitive both clients build
   * `waitForWelcome`-style helpers on.
   */
  waitFor<T = unknown>(
    path: string,
    predicate: (value: unknown) => boolean,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const existing = this.get(path);
    let satisfied: boolean;
    try {
      satisfied = predicate(existing);
    } catch (error) {
      // A predicate that throws is the caller's bug, but it must still be answered with a rejection:
      // returning a promise that never settles is indistinguishable from "the state never arrived".
      return Promise.reject(error);
    }
    if (satisfied) return Promise.resolve(existing as T);

    return new Promise<T>((resolve, reject) => {
      let unsubscribe: Unsubscribe = () => {};
      let timer: ReturnType<typeof setTimeout> | null = null;

      const finish = (fn: () => void): void => {
        unsubscribe();
        if (timer !== null) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        fn();
      };

      // An aborted wait is the caller's own decision, not a transport fault: it is a `MgConfigError`, so a
      // caller that classifies rejections does not treat it as a socket problem.
      const onAbort = (): void =>
        finish(() => reject(new MgConfigError('Aborted while waiting for state.', 'wait_aborted')));

      unsubscribe = this.subscribe(path, (change) => {
        // The predicate runs inside the store's delivery path, which swallows a throwing subscriber so
        // one bad subscriber cannot break the others. A predicate that throws must therefore release
        // this wait's subscription and deadline itself before the rejection leaves the handler.
        let satisfied: boolean;
        try {
          satisfied = predicate(change.value);
        } catch (error) {
          finish(() => reject(error));
          return;
        }
        if (satisfied) finish(() => resolve(change.value as T));
      });

      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          // A deadline is a failure of the *wait*, not of a wire peer, so the kind is `state` and the code
          // names the deadline; the class still says "retryable" so a retry loop can branch once.
          finish(() =>
            reject(
              new MgTransportError(`Timed out waiting for "${path}".`, 'state', { code: 'wait_timeout' }),
            ),
          );
        }, options.timeoutMs);
      }

      if (options.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  // ------------------------------------------------------------------------------------
  // Notification
  // ------------------------------------------------------------------------------------

  private notifyAll(change: StateChange): void {
    for (const subscription of [...this.subscriptions.values()]) {
      this.deliver(subscription, {
        ...change,
        watchedPath: subscription.path,
        value: this.get(subscription.path),
      });
    }
  }

  private notifyAffected(change: StateChange, changedPaths: readonly string[]): void {
    if (changedPaths.length === 0) return;

    for (const subscription of [...this.subscriptions.values()]) {
      const affected = changedPaths.some(
        (changed) =>
          pointerContains(subscription.path, changed) || pointerContains(changed, subscription.path),
      );
      if (!affected) continue;

      this.deliver(subscription, {
        ...change,
        watchedPath: subscription.path,
        value: this.get(subscription.path),
      });
    }
  }

  private deliver(subscription: Subscription, change: StateChange): void {
    try {
      subscription.handler(change);
    } catch {
      // A throwing subscriber must not break the store or the other subscribers.
    }
  }
}

/** Re-exported so callers can compare snapshots without importing the patch module. */
export { deepClone, deepEqual };
