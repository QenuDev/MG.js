/**
 * The storage seam's types.
 *
 * Types only, and this one is a `types.ts` in the sense DESIGN §4.1 means, unlike the two
 * misnamed files Phase 5 renamed in `common`: it declares interfaces and a union, and no runtime value.
 *
 * Split out of `storage.ts` (Phase 5 Task 5.6c).
 */

import type { PageRealm } from '../page/realm.js';

/** Which backend is actually in use. */
export type StorageBackendKind =
  /** `GM_getValue`/`GM_setValue`, origin-independent and durable. */
  | 'gm'
  /** Namespaced `localStorage`. */
  | 'localStorage'
  /** The page's `localStorage` is absent or blocked (private mode, sandboxed iframe, SSR). */
  | 'memory';

/** A storage backend, kept tiny: get, set, remove, keys. */
export interface StorageBackend {
  readonly kind: StorageBackendKind;
  /** Read a raw string, or `null` when absent. */
  getRaw(key: string): string | null;
  /** Write a raw string. */
  setRaw(key: string, value: string): void;
  /** Remove a key. */
  removeRaw(key: string): void;
  /** Every key this backend holds, unprefixed. */
  keys(): string[];
  /** True when writes persist beyond the page's lifetime. */
  readonly durable: boolean;
}

/** Options for {@link createStorage}. */
export interface StorageOptions {
  /** Key prefix. Default {@link DEFAULT_KEY_PREFIX}. */
  prefix?: string;
  /** Page realm. Defaults to `realm.getPage()`. Exported for tests. */
  page?: PageRealm | null;
  /**
   * Force a backend. Used by tests, and by a caller that knows its environment better than the
   * feature detection does.
   */
  forceBackend?: StorageBackendKind;
  /**
   * The `localStorage`-shaped object to use when the page's own is missing. Injected rather than read from
   * the global so a test can supply a fake without a DOM.
   */
  localStorageLike?: WebStorageLike;
}

/** The subset of the `Storage` interface this module uses. */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

/**
 * The `GM_*` functions this module uses, as a structural type.
 *
 * Structural rather than relying on the ambient `@types/tampermonkey` declarations *at this call site*,
 * because those declarations are global and this module must compile in contexts where they are absent (a
 * consumer that installs the library without the types package). `@types/tampermonkey` is still the
 * dependency that gives the ambient declarations to consumers who do have it; the metadata block in
 * `scripts/build.ts` is what makes `GM_getValue` exist at runtime.
 */
export interface GreasemonkeyApi {
  getValue: (key: string) => unknown;
  setValue: (key: string, value: unknown) => void;
  /** Some managers expose a delete; Tampermonkey does not, so it is optional. */
  deleteValue?: (key: string) => void;
}
