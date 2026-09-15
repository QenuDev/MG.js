/**
 * The jotai bridge: reaching the game's React state, and *writing* it the way its own buttons do.
 *
 * ## Why this is worth doing at all
 *
 * §11's table names the two ways to reach the game: the wire, which gives "read access, and the ability
 * to drive the game by sending commands", and the page, which also gives "write access to trigger
 * the exact same code path the game's own UI buttons use". For client-only state (which modal is open,
 * whether cinematic mode is claimed, which slot is selected) there is no wire message at all. The only
 * way to open the seed shop is to set the atom the shop button sets, and the only way to do *that*
 * correctly is through jotai's own `set`, because a derived atom's write function is not a plain
 * assignment.
 *
 * The docs are explicit about the failure mode: "Do not write to `activeModalStateAtom` directly
 * (`atom.write = ...` assignment isn't the same as calling it)." jotai atoms created with a derived
 * `write` function throw `"write is not a function"`. This module therefore never assigns to an atom's
 * value. It captures jotai's store `set` closure and calls it, the same as a React event handler inside
 * the game does.
 *
 * ## Labels, not identity
 *
 * §12: "Recognize specific atoms by matching a substring of their internal debug label (e.g. anything
 * ending in `/activeModalStateAtom`)". Labels are far more stable across builds than the object identity
 * or the minified variable name that held the atom.
 *
 * That is the whole reason this works. An atom is a plain object the game creates at module init; we
 * cannot hold a reference to it across builds, and the variable it was assigned to is minified to one or
 * two characters. The debug label is a *string literal* the bundler cannot rename, and it survives.
 *
 * ## The `set`-capture trick, and why it restores immediately
 *
 * There is no supported way to ask jotai "give me a store". The store is created inside React's tree. But
 * every atom's `write` function is passed `(get, set, ...args)` by jotai when a write happens, and that
 * `set` is the store's own. So we wrap each atom's `write` once, and the first time any wrapped atom is
 * written *by anything* (the game's own UI, another mod, or us) we capture that `set` and immediately
 * restore every wrapped atom to its original writer.
 *
 * Immediate restore is the documented behaviour ("this hook only needs to fire once, globally") and it is
 * also the right engineering call: leaving wrappers on every atom would add a stack frame to every write
 * in the game for no benefit, and would keep us in the game's write path forever. Once we hold `set`, the
 * wrappers have no purpose.
 *
 * ## The realm-correct object vs. the sandbox's
 *
 * `Object.prototype.hasOwnProperty` (and every other built-in reached through `Object`) must be the
 * *page's* `Object`. In a Tampermonkey sandbox the two are different constructors, and calling the
 * sandbox's `hasOwnProperty` on a page-realm atom is a cross-realm call that some engines reject. The
 * companion mod established this discipline (`page.Object as ObjectConstructor`), and {@link install}
 * follows it.
 */

import { watchUntil } from '@mg.js/common';
import type { PageRealm } from '../page/realm.js';
import { getPage } from '../page/realm.js';

/**
 * The page global the atom cache lives under.
 *
 * §12: "jotai keeps a private WeakMap-like cache mapping atom-config objects to their live atom
 * instances, but the game exposes an atom-cache-like object on the page anyway (used for hot-reload
 * bookkeeping)".
 *
 * It may be absent at document-start (the game creates it during its own bootstrap), so
 * {@link install} synthesises one when missing. Synthesising is not a guess about the game's internals:
 * §12 says the game reads `window.jotaiAtomCache`, so if we put a conforming object there first, the game
 * populates *ours*, and we then see every atom as it registers.
 */
export const ATOM_CACHE_KEY = 'jotaiAtomCache';

/** The minimal jotai atom shape this bridge touches. */
export interface JotaiAtom {
  /**
   * jotai calls this when something writes the atom.
   *
   * Absent on primitive atoms (`atom(0)`), whose write goes straight to the store. A
   * "capture `set` from the first write" strategy therefore has to wrap whatever atoms it *can* and not
   * assume every atom has a writer.
   */
  write?: (get: unknown, set: unknown, ...args: unknown[]) => unknown;
  /** jotai's optional human label, set by the game's authors via `atom(..., { debugLabel })`. */
  debugLabel?: string;
  /** Some builds hang the label off `label` instead. Both are read; neither is trusted alone. */
  label?: unknown;
  /** Present on derived atoms. Used to decide whether a write is even conceivable. */
  read?: unknown;
  [key: string]: unknown;
}

/** The store `set` closure, as captured from a real write. */
export type JotaiSet = (atom: unknown, value: unknown) => unknown;

/** The page's atom-cache shapes. Both are observed in the wild. */
export type AtomCacheLike =
  /** A bare `Map` keyed by the atom-config object. */
  | Map<unknown, JotaiAtom>
  /** The object shape: a `.cache` map plus a `.get(key, initial)` accessor. */
  | {
      cache?: Map<unknown, JotaiAtom> | undefined;
      get?: ((key: unknown, initial: JotaiAtom) => JotaiAtom) | undefined;
      /** Our idempotency flag, per the companion's `__gardenCompanionWrapped` idiom. */
      __mgjsWrapped?: boolean;
      [key: string]: unknown;
    };

/**
 * The holder {@link install} synthesises when the page has no cache yet.
 *
 * The shape is the game's own, `{ cache: new Map, get(key, initial) }`, so the
 * game's `globalThis.jotaiAtomCache = globalThis.jotaiAtomCache || {...}` adopts it wholesale.
 */
interface SyntheticAtomCache {
  cache: Map<unknown, JotaiAtom>;
  get(this: SyntheticAtomCache, key: unknown, initial: JotaiAtom): JotaiAtom;
}

/**
 * A `get` with no mg.js in it, matching what the game would have written for itself.
 *
 * `release()` puts this back when the game adopted our synthetic holder: the page keeps a working atom
 * registry, and no reference to this bridge survives in the game's atom path.
 */
function neutralAtomCacheGet(this: SyntheticAtomCache, key: unknown, initial: JotaiAtom): JotaiAtom {
  if (this.cache.has(key)) return this.cache.get(key) ?? initial;
  this.cache.set(key, initial);
  return initial;
}

/** Called for every atom as it registers. Returning `false` skips the atom entirely. */
export type AtomVisitor = (key: unknown, atom: JotaiAtom) => void;

/** Options for {@link install}. */
export interface JotaiBridgeOptions {
  /** Page realm. Defaults to `realm.getPage()`. Exported for tests. */
  page?: PageRealm | null;
  /** How long to keep waiting for the real cache. `0` disables the retry entirely. Default 90 000 ms. */
  retryForMs?: number;
  /** Retry interval. Default 500 ms, matching the companion's proven cadence. */
  retryIntervalMs?: number;
  /** Timer/late source injected for tests, so no real clock is needed. */
  schedule?: (callback: () => void, delayMs: number) => unknown;
  /** Notified once `set` has been captured. */
  onSetCaptured?: (set: JotaiSet) => void;
  /** Notified on every atom registration, for diagnostics. */
  onAtom?: AtomVisitor;
}

/** The install handle. */
export interface JotaiBridgeHandle {
  /**
   * Release the hook. Restores a pre-existing cache's own `get`, puts a plain one back on a holder we
   * synthesised, and restores every atom's original writer.
   */
  release(): void;
  /** Whether the bridge still holds a hook. */
  readonly active: boolean;
  /** How many atoms have been inspected. */
  readonly atomCount: number;
  /** The captured store `set`, or `null` before the first write anywhere. */
  readonly set: JotaiSet | null;
}

/** Keys we have already inspected, so a re-registration does not re-wrap. */
const wrappedWrites = new Map<JotaiAtom, { original: JotaiAtom['write']; capture: JotaiAtom['write'] }>();

/** The captured store `set`. Module-scoped because there is one store per page, not one per bridge. */
let capturedSet: JotaiSet | null = null;
/**
 * The store's own `get`, captured alongside {@link capturedSet} from the first atom write.
 *
 * The store hands both to `atom.write`; keeping only `set` made every atom unreadable.
 */
let capturedGet: ((target: unknown) => unknown) | null = null;

/** Total atoms inspected across all bridges on this page. Diagnostic. */
let inspectedCount = 0;

/** True once `set` has been captured. */
export function hasCapturedSet(): boolean {
  return capturedSet !== null;
}

/** The captured store `set`, or `null`. */
export function getCapturedSet(): JotaiSet | null {
  return capturedSet;
}

/**
 * Read an atom through the store's own `get`.
 *
 * @returns the atom's current value, or `null` when either the store `get` has not been captured yet (no
 *   atom write has happened) or the read throws. `null` is indistinguishable from "the value
 *   is null" here, because every caller so far is asking a question whose answer is a string or absent.
 */
export function readAtom(atom: JotaiAtom | null): unknown {
  if (atom === null || capturedGet === null) return null;
  try {
    return capturedGet(atom);
  } catch {
    // An atom whose read depends on a torn-down store. Nothing to report and nothing to do.
    return null;
  }
}

/**
 * Reset the module-scoped capture state.
 *
 * Exported for tests and for a full `uninstall`: the captured `set` belongs to a *store*, and a store can
 * be replaced (a React remount after an error boundary, say). Holding a stale `set` would write into a
 * dead store and silently do nothing.
 */
export function resetJotaiCapture(): void {
  capturedSet = null;
  capturedGet = null;
  inspectedCount = 0;
  restoreWrappedWrites();
}

/**
 * Put every original writer back.
 *
 * The identity guard is the same rule §19 states for socket slots, applied to atom writers: only restore
 * when `atom.write` is still *our* capture. If a third party wrapped us in the meantime, replacing the
 * slot with the pre-us original would erase their hook.
 */
export function restoreWrappedWrites(): number {
  let restored = 0;
  for (const [atom, entry] of wrappedWrites) {
    if (atom.write === entry.capture) {
      atom.write = entry.original;
      restored += 1;
    }
  }
  wrappedWrites.clear();
  return restored;
}

/**
 * The page-realm `Object` constructor.
 *
 * §12's realm note, and the companion's `page.Object as ObjectConstructor` idiom. In a sandbox the
 * sandbox's `Object.prototype.hasOwnProperty` is a different function from the page's, and mixing them
 * across realms is the classic Tampermonkey failure. Falling back to the ambient `Object` when no page is
 * available (tests, Node) is correct because there is then only one realm.
 */
function pageObjectCtor(page: PageRealm | null): ObjectConstructor {
  const candidate = page?.['Object'];
  return typeof candidate === 'function' ? (candidate as ObjectConstructor) : Object;
}

/**
 * `String()` via the page realm, so a cross-realm value is stringified by its own realm's rules.
 *
 * Resolved through {@link pageObjectCtor}'s sibling, for the same reason: in a sandbox, coercing a
 * page-realm object with the sandbox's `String` can invoke a cross-realm `toString` in a realm that does
 * not have the object's prototype chain.
 */
function pageString(page: PageRealm | null, value: unknown): string {
  const candidate = page?.['String'];
  if (typeof candidate === 'function') {
    try {
      return (candidate as StringConstructor)(value);
    } catch {
      // A value whose toString throws; fall through to the ambient String.
    }
  }
  return String(value);
}

/**
 * An own-property test performed by the *page's* `Object.prototype`.
 *
 * This is §12's realm discipline applied to the one place a built-in actually matters here: deciding
 * whether a foreign object already carries our install flag. Using the sandbox's `hasOwnProperty` on a
 * page-realm object is a cross-realm call, and the companion mod's `page.Object as ObjectConstructor`
 * idiom exists because that call is unreliable.
 */
function pageHasOwn(page: PageRealm | null, target: object, key: string): boolean {
  const ctor = pageObjectCtor(page);
  return ctor.prototype.hasOwnProperty.call(target, key);
}

/**
 * Read an atom's debug label.
 *
 * Three sources, tried in order, because §12 gives one name and the wild has more:
 *   - `debugLabel`: what jotai sets from the game's `atom(..., { debugLabel })`;
 *   - `label`: observed on some builds;
 *   - the cache key's string form, the source the docs' own example actually matches on
 *     (`label.endsWith('/activeModalStateAtom')`, a *key*, not a member).
 *
 * The key wins when present because the docs' example uses it and a key is never minified.
 */
function atomLabel(key: unknown, atom: JotaiAtom, page: PageRealm | null): string {
  if (key !== null && key !== undefined) {
    const keyText = pageString(page, key);
    if (keyText !== '' && keyText !== '[object Object]') return keyText;
  }
  if (typeof atom.debugLabel === 'string' && atom.debugLabel !== '') return atom.debugLabel;
  if (typeof atom.label === 'string' && atom.label !== '') return atom.label;
  return '';
}

/**
 * Match a label against a requested name.
 *
 * §12's example is `endsWith('/activeModalStateAtom')` and the companion's proven implementation
 * (`labelMatches`) allows `label === match || label.endsWith('/' + match)`. The segment form is
 * required rather than cosmetic: a bare `endsWith('actionAtom')` matches
 * `lastCurrencyTransactionAtom` as well as `actionAtom`, and the winner is then decided by Map iteration
 * order, which is the bug the companion hit and fixed.
 *
 * This function therefore exposes both shapes on purpose:
 *   - {@link find} uses segment matching, for a short name;
 *   - {@link findContaining} uses substring matching, for a caller that wants a loose match.
 */
export function labelMatches(label: string, match: string): boolean {
  if (match === '') return false;
  if (label === match) return true;
  return label.endsWith(`/${match}`);
}

/**
 * Install the atom-cache hook.
 *
 * Idempotent, and safe on a page with no cache yet (it synthesises one and retries, per the companion's
 * proven 180 × 500 ms budget). Safe to call twice: the second call reuses the first hook.
 */
export function install(options: JotaiBridgeOptions = {}): JotaiBridgeHandle {
  const page = options.page ?? getPage();

  let active = true;
  let synthetic: SyntheticAtomCache | null = null;
  /** The `get` installed on {@link synthetic}, so `release()` can tell ours from a replacement. */
  let syntheticGet: SyntheticAtomCache['get'] | null = null;
  let releaseCacheGet: (() => void) | null = null;
  let stopRetry: (() => void) | null = null;

  /**
   * Inspect one atom as it registers.
   *
   * Called from four places (the `get` wrapper, a bare `Map` walk, a `.cache` walk, and the retry tick).
   * It must be cheap and idempotent. Two guards, neither optional:
   *
   *   - `if (!atom) return atom`. The companion's own source records the bug this fixes: reading a label
   *     off a non-atom "threw, and the throw came straight out of the getter we wrapped, taking down
   *     whichever of the game's modules was mid-initialise." Our wrapper is in the game's own hot path, so
   *     an exception here corrupts the game's startup.
   *   - the `wrappedWrites` map. Re-wrapping an atom's writer would stack captures, and the second
   *     capture would consume a `set` from *our own* wrapped writer rather than from jotai.
   */
  const inspectAtom = (key: unknown, atom: JotaiAtom | undefined | null): JotaiAtom | undefined | null => {
    if (atom === undefined || atom === null) return atom;
    if (typeof atom !== 'object') return atom;

    // The label is computed for its side effect of normalising the key, and for the visitor below;
    // a caller who wants the registry should hold a `JotaiBridge`, which owns one.
    atomLabel(key, atom, page);
    inspectedCount += 1;

    if (options.onAtom !== undefined) {
      try {
        options.onAtom(key, atom);
      } catch {
        // A visitor's failure is its own.
      }
    }

    // One capture per page, and only from an atom that actually has a writer: a primitive atom has no
    // `write`, so waiting for one of those would never capture anything.
    if (capturedSet === null && typeof atom.write === 'function' && !wrappedWrites.has(atom)) {
      const original = atom.write;
      const capture = function capturedWrite(
        this: JotaiAtom,
        get: unknown,
        set: unknown,
        ...args: unknown[]
      ): unknown {
        // The capture itself: `set` is the store's own closure. Wrapped in a fresh arrow rather than
        // stored raw, so a caller can never invoke it with the wrong `this` and the `unknown` parameter
        // jotai hands us is narrowed once.
        const storeSet = set as JotaiSet;
        capturedSet = (target: unknown, value: unknown) => storeSet(target, value);
        // `get` arrives in the very same call and used to be discarded, which left this bridge write-only: a
        // mod could set an atom but never read one. Every value the game keeps only in an atom, and does not
        // publish on the state tree, is reachable only through this.
        const storeGet = get as (target: unknown) => unknown;
        capturedGet = (target: unknown) => storeGet(target);
        // Immediately stop intercepting. Leaving wrappers in place would put us in the game's write path
        // forever for no benefit (see the module header).
        restoreWrappedWrites();
        if (options.onSetCaptured !== undefined) {
          try {
            options.onSetCaptured(capturedSet);
          } catch {
            // A listener's failure is its own.
          }
        }
        return typeof original === 'function' ? original.call(this, get, set, ...args) : undefined;
      };
      try {
        atom.write = capture;
        wrappedWrites.set(atom, { original, capture });
      } catch {
        // A frozen atom. Nothing to wrap; another atom with a writer will do.
      }
    }

    return atom;
  };

  const existing: unknown = page === null ? undefined : page[ATOM_CACHE_KEY];

  if (existing === undefined || existing === null) {
    // Synthesise a conforming object so the game populates ours. §12 documents the game reading this
    // global, so this is the documented shape, not an invention.
    const cache = new Map<unknown, JotaiAtom>();
    const holder: SyntheticAtomCache = {
      cache,
      get(key: unknown, initial: JotaiAtom): JotaiAtom {
        const atom = cache.get(key) ?? initial;
        if (!cache.has(key)) cache.set(key, atom);
        return inspectAtom(key, atom) as JotaiAtom;
      },
    };
    synthetic = holder;
    syntheticGet = holder.get;
    if (page !== null) page[ATOM_CACHE_KEY] = holder;
  } else if (existing instanceof Map) {
    // Bare `Map`: every existing entry is inspected now, and we iterate it later on a timer because a
    // Map cannot be made to call us on `set`.
    for (const [key, atom] of existing) inspectAtom(key, atom);
  } else if (typeof existing === 'object') {
    const holder = existing as Exclude<AtomCacheLike, Map<unknown, JotaiAtom>>;
    const cache = holder.cache;
    if (cache instanceof Map) {
      for (const [key, atom] of cache) inspectAtom(key, atom);
    }
    // Wrap `get` when the holder exposes one and is not already wrapped. Identity-guarded on release.
    //
    // The flag check is `!== true` plus an own-property test rather than a bare truthiness read: a
    // previous release deletes the flag, and a holder carrying an inherited `__mgjsWrapped` would
    // otherwise be treated as wrapped by us when it is not. Both tests use the *page's* `Object`, per
    // §12's realm discipline.
    const alreadyWrapped = pageHasOwn(page, holder, '__mgjsWrapped') && holder.__mgjsWrapped === true;
    if (typeof holder.get === 'function' && !alreadyWrapped) {
      const originalGet = holder.get;
      const wrappedGet = function wrappedAtomGet(this: unknown, key: unknown, initial: JotaiAtom): JotaiAtom {
        return inspectAtom(key, originalGet.call(this, key, initial)) as JotaiAtom;
      };
      holder.get = wrappedGet;
      holder.__mgjsWrapped = true;
      releaseCacheGet = () => {
        // Identity-guarded: another mod may have wrapped our `get` after us.
        if (holder.get === wrappedGet) {
          holder.get = originalGet;
          delete holder.__mgjsWrapped;
        }
      };
    }
  }

  /**
   * Retry: the cache may not exist yet at document-start, and a bare `Map` gains atoms over time with no
   * way to be notified. The companion uses 180 × 500 ms, which is 90 s, long enough to cover a slow
   * login and cheap enough (one `Map` iteration per half-second) to be invisible.
   */
  const retryForMs = options.retryForMs ?? 90_000;
  const retryIntervalMs = options.retryIntervalMs ?? 500;
  const schedule =
    options.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));

  if (retryForMs > 0) {
    let lastSize = -1;
    // The window closing is silent here: the bridge is an opportunistic capture, and a caller that never
    // saw an atom simply keeps the state it has. `capturedSet` non-null is the "found" answer, which stops
    // the watch.
    stopRetry = watchUntil<unknown>({
      attempt: () => {
        if (!active) return capturedSet;
        const current: unknown = page === null ? undefined : page[ATOM_CACHE_KEY];
        if (current instanceof Map) {
          // Cheap gate: only walk the Map when it has grown since last time. A 500 ms walk of a Map that
          // holds every atom in the game is not free, and it is pure waste when nothing changed.
          if (current.size !== lastSize) {
            lastSize = current.size;
            for (const [key, atom] of current) inspectAtom(key, atom);
          }
        } else if (current !== null && typeof current === 'object') {
          const cache = (current as { cache?: unknown }).cache;
          if (cache instanceof Map && cache.size !== lastSize) {
            lastSize = cache.size;
            for (const [key, atom] of cache) inspectAtom(key, atom);
          }
        }
        // A non-null set is the answer; `null` keeps the window open until the deadline closes it.
        return capturedSet;
      },
      // The cache may not exist yet at `document-start`; one interval first matches the 180 × 500 ms
      // budget this replaces.
      firstAttempt: 'afterInterval',
      timeoutMs: retryForMs,
      intervalMs: retryIntervalMs,
      schedule,
    });
  }

  /**
   * Give the page its cache back, without taking away the one the game is using.
   *
   * An identity check alone is not enough, because this object has two jobs: it is the property *we*
   * created, and it is also the atom registry the game adopted. The bundle does
   * `globalThis.jotaiAtomCache = globalThis.jotaiAtomCache || { cache: new Map, get(...) }` and then
   * `.get(key, atom)` once per atom module, so a populated `cache` is proof the game is home in ours;
   * deleting it would throw away the live atom instances the game's later modules look up by key.
   *
   * So a holder nobody ever took is removed, restoring the page exactly as we found it, while an adopted
   * one stays and only *our* `get` comes out of it, since the game may hold this object long after release.
   * Identity-guarded like {@link releaseCacheGet}, so a `get` that someone else replaced is left alone.
   */
  const releaseSyntheticCache = (): void => {
    if (synthetic === null || synthetic.get !== syntheticGet) return;
    if (synthetic.cache.size === 0 && page !== null && page[ATOM_CACHE_KEY] === synthetic) {
      delete page[ATOM_CACHE_KEY];
      return;
    }
    synthetic.get = neutralAtomCacheGet;
  };

  const handle: JotaiBridgeHandle = {
    get active(): boolean {
      return active;
    },
    get atomCount(): number {
      return inspectedCount;
    },
    get set(): JotaiSet | null {
      return capturedSet;
    },
    release(): void {
      if (!active) return;
      active = false;
      // Cancels the pending retry outright, approximating what the `unref` this replaces did.
      stopRetry?.();
      stopRetry = null;
      releaseCacheGet?.();
      releaseCacheGet = null;
      releaseSyntheticCache();
      restoreWrappedWrites();
    },
  };

  return handle;
}

/**
 * Find a registered atom by its label.
 *
 * Segment matching (see {@link labelMatches}), because that is the form that does not swallow siblings.
 * This is a *live lookup against the registry the bridge built*, so a bridge handle must be held
 * for this to work.
 */
export interface JotaiLookup {
  /** Exact-or-final-segment match on the atom's debug label. */
  find(labelSuffix: string): JotaiAtom | null;
  /** Substring match, for a caller that wants a looser search. */
  findContaining(fragment: string): JotaiAtom | null;
  /** Every label seen so far. Diagnostics: this is what to log when a `find` misses. */
  labels(): string[];
}

/** Create a lookup over a bridge's registry. */
export function createLookup(registry: Map<string, JotaiAtom>): JotaiLookup {
  return {
    find(labelSuffix: string): JotaiAtom | null {
      // Exact first, then the segment form, so an exact label beats a coincidental suffix.
      const exact = registry.get(labelSuffix);
      if (exact !== undefined) return exact;
      for (const [label, atom] of registry) {
        if (labelMatches(label, labelSuffix)) return atom;
      }
      return null;
    },
    findContaining(fragment: string): JotaiAtom | null {
      if (fragment === '') return null;
      for (const [label, atom] of registry) {
        if (label.includes(fragment)) return atom;
      }
      return null;
    },
    labels(): string[] {
      return [...registry.keys()];
    },
  };
}

/** Why a {@link writeAtom} call failed. */
export type WriteFailureReason =
  /** No store `set` has been captured yet, so nothing has ever been written through an atom. */
  | 'no-set'
  /** The atom has no `write` function, so jotai would treat a value write as read-only. */
  | 'read-only'
  /** The store's `set` threw. */
  | 'threw';

/** The outcome of {@link writeAtom}. */
export interface WriteResult {
  ok: boolean;
  reason?: WriteFailureReason;
  error?: unknown;
}

/**
 * Write an atom through jotai's own store `set`.
 *
 * This is the method that makes the bridge worth having: it "call[s] the captured jotai `set` closure
 * exactly like the game's own UI button would". The read-only guard is required. jotai's behaviour for
 * writing to an atom that has no `write` is to throw `"write is not a function"` from inside the store,
 * asynchronously, far from this call,
 * which in a game's UI means an unhandled rejection and a half-updated tree. Checking `typeof atom.write
 * === 'function'` first converts that into an immediate, attributable `false`.
 *
 * What the guard can and cannot know: a *derived* atom (one created as
 * `atom(get => ...)`) has a `read` and no `write`, so it is rejected by the same check. An atom with both
 * a `read` and a `write` is writable, and jotai routes the write through the derived writer, which is
 * what the game's own button does, so it is allowed.
 */
export function writeAtom(set: JotaiSet | null, atom: JotaiAtom | null, value: unknown): WriteResult {
  if (set === null) {
    return {
      ok: false,
      reason: 'no-set',
      error: new Error(
        "mg.js: jotai's store `set` has not been captured yet. It is captured from the first atom write " +
          "anywhere on the page. The game's own UI usually supplies one, so this resolves once the " +
          'player interacts with the game, or immediately after our own first successful write.',
      ),
    };
  }
  if (atom === null || atom === undefined) {
    return {
      ok: false,
      reason: 'read-only',
      error: new Error('mg.js: no atom was supplied. Use JotaiBridge.find(labelSuffix) to look one up.'),
    };
  }
  if (typeof atom.write !== 'function') {
    return {
      ok: false,
      reason: 'read-only',
      error: new Error(
        'mg.js: refusing to write an atom with no `write`: jotai would throw "write is not a function". ' +
          'A derived read-only atom cannot be set; find the primitive it derives from instead.',
      ),
    };
  }
  try {
    set(atom, value);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: 'threw', error };
  }
}

/**
 * The `JotaiBridge` facade the API reference names.
 *
 * §1 calls `JotaiBridge` one of "three documented bridges into" the game engine, alongside `PixiStage` and
 * `RiveArtboard`. This class is the object-shaped form of the functions above, so a caller gets one thing
 * to hold instead of four.
 */
export class JotaiBridge {
  private readonly handle: JotaiBridgeHandle;
  private readonly registry = new Map<string, JotaiAtom>();
  private readonly lookup: JotaiLookup;

  constructor(options: JotaiBridgeOptions = {}) {
    // The registry is populated by an `onAtom` visitor that we own, so `labels()` stays accurate even
    // when the caller also supplies their own visitor.
    const callerVisitor = options.onAtom;
    this.handle = install({
      ...options,
      onAtom: (key, atom) => {
        // Recompute the label exactly as `install` does, so the two agree.
        const label = atomLabel(key, atom, options.page ?? getPage());
        if (label !== '') this.registry.set(label, atom);
        callerVisitor?.(key, atom);
      },
    });
    this.lookup = createLookup(this.registry);
  }

  /** The captured store `set`, or `null`. */
  get set(): JotaiSet | null {
    return this.handle.set;
  }

  /** True once `set` has been captured, i.e. writes are possible. */
  get ready(): boolean {
    return this.handle.active && this.handle.set !== null;
  }

  /** How many atoms have been inspected. */
  get atomCount(): number {
    return this.handle.atomCount;
  }

  /** Exact-or-final-segment label match. */
  find(labelSuffix: string): JotaiAtom | null {
    return this.lookup.find(labelSuffix);
  }

  /** Substring label match. */
  findContaining(fragment: string): JotaiAtom | null {
    return this.lookup.findContaining(fragment);
  }

  /** Every label seen. Log this when a `find` misses. */
  labels(): string[] {
    return this.lookup.labels();
  }

  /** Write an atom through the store. See {@link writeAtom}. */
  write(atom: JotaiAtom | null, value: unknown): WriteResult {
    return writeAtom(this.handle.set, atom, value);
  }

  /**
   * Read an atom's current value.
   *
   * The counterpart to {@link write}, and the reason the store's `get` is captured at all. Returns `null`
   * when the store `get` is not available yet, since it arrives with the game's first atom write, so a caller
   * must be able to treat `null` as "not known yet" rather than as a value.
   */
  read(atom: JotaiAtom | null): unknown {
    return readAtom(atom);
  }

  /**
   * Look up by label and read in one step.
   *
   * This is what makes a value the game keeps only in an atom reachable, and `store.ts/playerIdAtom` is the
   * clearest example, since the game writes our own id there and never puts it on the state tree. Nothing in
   * this library uses it for that now (identity comes from the socket seam's scrape of the wire); it is here
   * because a write-only bridge is half a bridge.
   */
  readByLabel(labelSuffix: string): unknown {
    return readAtom(this.find(labelSuffix));
  }

  /** Look up by label and write in one step. */
  writeByLabel(labelSuffix: string, value: unknown): WriteResult {
    const atom = this.find(labelSuffix);
    if (atom === null) {
      return {
        ok: false,
        reason: 'read-only',
        error: new Error(
          `mg.js: no atom whose debug label ends with "${labelSuffix}" has registered. ` +
            `Labels seen: ${this.labels().slice(0, 20).join(', ') || '(none yet)'}`,
        ),
      };
    }
    return this.write(atom, value);
  }

  /** Release the hook and restore every atom writer. */
  release(): void {
    this.handle.release();
    this.registry.clear();
  }
}
