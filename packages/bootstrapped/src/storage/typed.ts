/**
 * The typed store a caller actually uses.
 *
 * Split out of `storage.ts` (Phase 5 Task 5.6c). {@link createStorage} is the package's public entry point
 * for persistence, and it is the only place a key prefix is applied.
 */

import { getPage } from '../page/realm.js';

import { selectBackend } from './backends.js';
import type { StorageBackendKind, StorageOptions } from './types.js';

/**
 * The default key namespace.
 *
 * `mgjs:` rather than `__mgjs:` to match the page-global namespace in `page/namespace.ts` while staying a
 * legal `localStorage` key. Bumping the prefix is the escape hatch for a future format change that cannot be
 * migrated, so the old keys simply stop being read, rather than being misparsed.
 */
export const DEFAULT_KEY_PREFIX = 'mgjs:';

/**
 * The typed store.
 *
 * `get`/`set` are generic in the value type, which is a deliberate ergonomic lie in one direction only:
 * `get<T>` will happily return a `T` that the stored JSON does not actually satisfy. Runtime schema
 * validation per key is a whole library, and a mod's settings are its own. What the types do
 * guarantee is that `get` is never `undefined` vs `T | null` by accident: an absent key yields the default,
 * and an *unparseable* key yields the default too and is reported through `onCorrupt`.
 */
export interface TypedStorage {
  readonly backend: StorageBackendKind;
  readonly durable: boolean;
  /** The effective prefix. */
  readonly prefix: string;
  /** Read a value, or `defaultValue` when absent or unparseable. */
  get<T>(key: string, defaultValue: T): T;
  /** Read a value, distinguishing absent from present. */
  getOrNull<T>(key: string): T | null;
  /**
   * Write a value.
   *
   * @returns the value that was written. Not a boolean: the useful thing for a caller to log or chain is
   *   the value, and a write that silently failed is not distinguishable from one that succeeded without
   *   a later read, so this does not claim success it cannot verify.
   */
  set<T>(key: string, value: T): T;
  /** Remove a key. */
  remove(key: string): void;
  /** Every key this store holds, unprefixed. Empty for the `gm` backend; see the note there. */
  keys(): string[];
  /**
   * Remove every key this store holds.
   *
   * Prefix-scoped, never `localStorage.clear()`. This is the method whose naive implementation is the one
   * that deletes a user's unrelated data.
   */
  clear(): number;
}

/** Create a typed store. */
export function createStorage(options: StorageOptions = {}): TypedStorage {
  const prefix = options.prefix ?? DEFAULT_KEY_PREFIX;
  const page = options.page ?? getPage();

  const backend = selectBackend(options, page, prefix);

  /**
   * Warn-once per key. A corrupt value is read on every access, possibly every frame, and a warn per read
   * would bury the first occurrence, which is the only informative one.
   */
  const corruptWarned = new Set<string>();
  const warnCorrupt = (key: string, raw: string, error: unknown): void => {
    if (corruptWarned.has(key)) return;
    corruptWarned.add(key);
    try {
      console.warn(`[mg.js] stored value for "${key}" is not valid JSON; using the default.`, {
        raw: raw.slice(0, 120),
        error,
      });
    } catch {
      // No console.
    }
  };

  return {
    backend: backend.kind,
    durable: backend.durable,
    prefix,
    get<T>(key: string, defaultValue: T): T {
      const raw = backend.getRaw(key);
      if (raw === null) return defaultValue;
      try {
        const parsed: unknown = JSON.parse(raw);
        // `null` is JSON-representable and a caller may legitimately store it; only an unparseable or
        // explicitly-absent value falls back.
        return parsed as T;
      } catch (error) {
        warnCorrupt(key, raw, error);
        return defaultValue;
      }
    },
    getOrNull<T>(key: string): T | null {
      const raw = backend.getRaw(key);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch (error) {
        warnCorrupt(key, raw, error);
        return null;
      }
    },
    set<T>(key: string, value: T): T {
      try {
        backend.setRaw(key, JSON.stringify(value));
      } catch (error) {
        // A value that will not serialise (a cycle, a BigInt). Reported, not thrown: a settings write is
        // never worth an exception in a page shared with a game.
        try {
          console.warn(`[mg.js] value for "${key}" is not JSON-serialisable; nothing was written.`, error);
        } catch {
          // No console.
        }
      }
      return value;
    },
    remove(key: string): void {
      backend.removeRaw(key);
    },
    keys(): string[] {
      return backend.keys();
    },
    clear(): number {
      const keys = backend.keys();
      for (const key of keys) backend.removeRaw(key);
      return keys.length;
    },
  };
}
