/**
 * Choosing and building a storage backend: greasemonkey, web storage, or memory.
 *
 * Split out of `storage.ts` (Phase 5 Task 5.6c). Every backend is total: there is always `memory`, so a page
 * with nowhere to persist degrades to a store that works for the session rather than to a throw.
 */

import type { PageRealm } from '../page/realm.js';
import { getPage } from '../page/realm.js';
import type { TypedStorage } from './typed.js';
import type { GreasemonkeyApi, StorageBackend, StorageOptions, WebStorageLike } from './types.js';

/**
 * Resolve the `GM_*` API, if this environment has one.
 *
 * Capability-detected by *calling* nothing and reading properties: the functions are read off the page
 * realm rather than named as bare identifiers, so a script running without the grant gets `null` instead of
 * a `ReferenceError`. This is the same discipline as `page/realm.ts`'s `unsafeWindow` read, and for the same
 * reason: a bare reference to an undeclared global is a `ReferenceError`, not `undefined`.
 */
export function resolveGreasemonkeyApi(page: PageRealm | null = getPage()): GreasemonkeyApi | null {
  if (page === null) return null;
  const getValue = page['GM_getValue'];
  const setValue = page['GM_setValue'];
  if (typeof getValue !== 'function' || typeof setValue !== 'function') return null;

  const deleteValue = page['GM_deleteValue'];
  const api: GreasemonkeyApi = {
    getValue: (key) => (getValue as (k: string) => unknown).call(page, key),
    setValue: (key, value) => (setValue as (k: string, v: unknown) => void).call(page, key, value),
  };
  if (typeof deleteValue === 'function') {
    api.deleteValue = (key) => (deleteValue as (k: string) => void).call(page, key);
  }
  return api;
}

/** A backend over `GM_getValue`/`GM_setValue`. */
function createGmBackend(api: GreasemonkeyApi, prefix: string): StorageBackend {
  return {
    kind: 'gm',
    durable: true,
    getRaw(key: string): string | null {
      try {
        const value = api.getValue(prefix + key);
        // Values are stored as JSON strings (see the module header), so anything that is not a string is
        // either absent or written by a different tool. Returning the JSON of it would be a lie; treating
        // it as absent is the recoverable choice.
        return typeof value === 'string' ? value : null;
      } catch {
        return null;
      }
    },
    setRaw(key: string, value: string): void {
      try {
        api.setValue(prefix + key, value);
      } catch {
        // A quota error or a manager refusing the write. Swallowed: a settings write that fails must not
        // take the page down, and the caller's typed `set` reports success by returning the stored value,
        // not by asserting the backend cooperated.
      }
    },
    removeRaw(key: string): void {
      try {
        if (api.deleteValue !== undefined) {
          api.deleteValue(prefix + key);
          return;
        }
        // Tampermonkey has no `GM_deleteValue`. Writing a sentinel that `getRaw` maps to absent is the
        // honest equivalent: the value is unreadable, and that is what "removed" means to a caller.
        api.setValue(prefix + key, null);
      } catch {
        // Nothing useful to do.
      }
    },
    keys(): string[] {
      // There is no `GM_keys`. Enumerating GM storage is impossible from a userscript, so this
      // reports nothing rather than inventing a key list: a caller that needs enumeration should keep an
      // index key of its own, and this method's docstring is the place that says so.
      return [];
    },
  };
}

/** A backend over a `Storage`-shaped object. */
function createWebStorageBackend(storage: WebStorageLike, prefix: string): StorageBackend {
  return {
    kind: 'localStorage',
    durable: true,
    getRaw(key: string): string | null {
      try {
        return storage.getItem(prefix + key);
      } catch {
        // Safari in private mode throws on read in some versions.
        return null;
      }
    },
    setRaw(key: string, value: string): void {
      try {
        storage.setItem(prefix + key, value);
      } catch {
        // Quota exceeded, or storage disabled mid-session.
      }
    },
    removeRaw(key: string): void {
      try {
        storage.removeItem(prefix + key);
      } catch {
        // As above.
      }
    },
    keys(): string[] {
      const out: string[] = [];
      try {
        const length = storage.length;
        for (let index = 0; index < length; index += 1) {
          const key = storage.key(index);
          if (typeof key === 'string' && key.startsWith(prefix)) out.push(key.slice(prefix.length));
        }
      } catch {
        return out;
      }
      return out;
    },
  };
}

/** An in-memory backend, for when there is nowhere to persist. */
function createMemoryBackend(): StorageBackend {
  const store = new Map<string, string>();
  return {
    kind: 'memory',
    // The one place this module is explicit about a limitation: `durable: false` is a fact a caller can
    // check, rather than a surprise at the next page load.
    durable: false,
    getRaw: (key) => store.get(key) ?? null,
    setRaw: (key, value) => {
      store.set(key, value);
    },
    removeRaw: (key) => {
      store.delete(key);
    },
    keys: () => [...store.keys()],
  };
}

/** Read a `Storage`-shaped object off a realm, feature-detected. */
function resolveLocalStorage(page: PageRealm | null): WebStorageLike | null {
  if (page === null) return null;
  // Reading the property can itself throw when storage is blocked, so the read is inside the try.
  try {
    const candidate = page['localStorage'];
    if (candidate === null || typeof candidate !== 'object') return null;
    const record = candidate as Partial<WebStorageLike>;
    if (typeof record.getItem !== 'function' || typeof record.setItem !== 'function') return null;
    if (typeof record.removeItem !== 'function' || typeof record.key !== 'function') return null;
    if (typeof record.length !== 'number') return null;
    return candidate as WebStorageLike;
  } catch {
    return null;
  }
}

/**
 * Pick a backend.
 *
 * Order: explicit override → `GM_*` → `localStorage` → memory. `GM_*` beats `localStorage` by design, and
 * the reason is in the module header: origin independence. A user who plays both in Discord and on the site
 * gets one configuration.
 */
export function selectBackend(
  options: StorageOptions,
  page: PageRealm | null,
  prefix: string,
): StorageBackend {
  if (options.forceBackend === 'memory') return createMemoryBackend();

  if (options.forceBackend === 'gm') {
    const api = resolveGreasemonkeyApi(page);
    return api === null ? createMemoryBackend() : createGmBackend(api, prefix);
  }

  if (options.forceBackend === 'localStorage') {
    const storage = options.localStorageLike ?? resolveLocalStorage(page);
    return storage === null ? createMemoryBackend() : createWebStorageBackend(storage, prefix);
  }

  const api = resolveGreasemonkeyApi(page);
  if (api !== null) return createGmBackend(api, prefix);

  const storage = options.localStorageLike ?? resolveLocalStorage(page);
  if (storage !== null) return createWebStorageBackend(storage, prefix);

  return createMemoryBackend();
}

/**
 * True when a value round-trips through the active backend.
 *
 * A one-shot self-test, because the failure modes are silent: Safari's private mode throws on `setItem`, a
 * permissions policy can block `localStorage` in a cross-origin iframe (which is *exactly* what a Discord
 * Activity is), and `GM_setValue` can be refused. Running this once at install lets the client log which
 * backend it actually got rather than assuming.
 *
 * The probe key is namespaced like every other, and removed afterwards.
 */
export function probeStorage(storage: TypedStorage): boolean {
  const probeKey = '__probe__';
  const marker = `probe-${Date.now()}`;
  try {
    storage.set(probeKey, marker);
    const readBack = storage.getOrNull<string>(probeKey);
    storage.remove(probeKey);
    return readBack === marker;
  } catch {
    return false;
  }
}
