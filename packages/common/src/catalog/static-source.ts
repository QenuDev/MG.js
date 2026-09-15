/**
 * A catalogue source carrying a fixed object.
 *
 * Two real uses: tests need a catalogue without touching the network, and the bootstrapped client needs
 * a source whose data comes from the live game bundle it is already running inside rather than from an
 * HTTP endpoint. Both are "a source with the data already in hand", so they share one implementation.
 */

import type { CatalogKind } from './defs.js';
import type { CatalogSource } from './source.js';

export interface StaticCatalogSourceOptions {
  /** Source id recorded in provenance. Default `static`. */
  id?: string;
  /** Category to value. Categories absent here are not advertised as capabilities. */
  data: Partial<Record<CatalogKind, unknown>>;
  /**
   * When a category's value is a function, it is called at load time instead of returned directly.
   * This is how a live-bundle source stays current without being re-constructed.
   */
  lazy?: boolean;
}

/** A catalogue source whose data is provided rather than fetched. */
export class StaticCatalogSource implements CatalogSource {
  readonly id: string;
  readonly capabilities: ReadonlySet<CatalogKind>;

  private readonly data: Partial<Record<CatalogKind, unknown>>;
  private readonly lazy: boolean;

  constructor(options: StaticCatalogSourceOptions) {
    this.id = options.id ?? 'static';
    this.data = options.data;
    this.lazy = options.lazy ?? true;
    this.capabilities = new Set<CatalogKind>(
      (Object.keys(options.data) as CatalogKind[]).filter((kind) => options.data[kind] !== undefined),
    );
  }

  async load(kind: CatalogKind): Promise<unknown> {
    const value = this.data[kind];
    if (value === undefined) return null;
    if (this.lazy && typeof value === 'function') {
      return (value as () => unknown)();
    }
    return value;
  }

  /** Replace a category's value at runtime, e.g. once a bundle extraction completes. */
  set(kind: CatalogKind, value: unknown): void {
    this.data[kind] = value;
    (this.capabilities as Set<CatalogKind>).add(kind);
  }
}
