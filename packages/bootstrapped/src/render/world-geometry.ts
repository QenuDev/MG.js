/**
 * Reading the world's geometry off the game's own objects.
 *
 * Split out of `world.ts` (Phase 5 Task 5.7c). Pure functions over an unknown page object: no Pixi, no
 * hooks, so the awkward part, what a field might be called and when a number is really a number, can be
 * reasoned about alone.
 */

import type { PixiDisplayObject } from './ctors.js';

/** §3.1 `WorldGeometry`: "Returned by WorldScene#sync()". */
export interface WorldGeometry {
  /** The game's world-container node. */
  system: PixiDisplayObject;
  /** Grid origin along x, in the game's tile units. */
  left: number;
  /** Grid origin along y. */
  top: number;
  /** Tile columns. */
  cols: number;
  /** Tile rows. */
  rows: number;
}

/**
 * Read the tile geometry off the game's world container.
 *
 * Returns `null` when the numbers cannot be established, rather than guessing. G40 states outright that
 * the typedef "has no description of units", so a fabricated tile size would be indistinguishable from a
 * real one until sprites visibly landed in the wrong place, the worst possible failure shape.
 *
 * Exported and pure (no `this`, no page access) so it can be unit-tested against a fake world node.
 */
export function readGeometry(world: unknown): WorldGeometry | null {
  if (world === null || typeof world !== 'object') return null;
  const record = world as Record<string, unknown>;
  const system = world as PixiDisplayObject;

  // Route 1: the node states its own grid directly. Tried first because it is unambiguous.
  const direct = readGridFields(record);
  if (direct !== null) return { system, ...direct };

  // Route 2: a nested bounds/grid/area object.
  for (const key of ['bounds', 'grid', 'area', 'rect']) {
    const nested = record[key];
    if (nested === null || typeof nested !== 'object') continue;
    const inner = readGridFields(nested as Record<string, unknown>);
    if (inner !== null) return { system, ...inner };
  }

  // Route 3: origin from the container's own transform, extent from `width`/`height` or child count.
  // This is the weakest route and the numbers are the least trustworthy, so it is last.
  const left = asFiniteNumber(record['x']);
  const top = asFiniteNumber(record['y']);
  const width = asFiniteNumber(record['width']);
  const height = asFiniteNumber(record['height']);
  if (left !== null && top !== null && width !== null && height !== null) {
    return { system, left, top, cols: Math.round(width), rows: Math.round(height) };
  }

  const children = record['children'];
  if (left !== null && top !== null && Array.isArray(children) && children.length > 0) {
    // A square grid is the only defensible assumption, and it is stated as an assumption rather than
    // presented as fact: the docs give no aspect information at all.
    const side = Math.round(Math.sqrt(children.length));
    if (side > 0) return { system, left, top, cols: side, rows: side };
  }

  return null;
}

/** Read `left`/`top` plus `cols`/`rows` (or `columns`/`width`/`height`) from a record. */
function readGridFields(record: Record<string, unknown>): Omit<WorldGeometry, 'system'> | null {
  const left = asFiniteNumber(record['left']) ?? asFiniteNumber(record['x']);
  const top = asFiniteNumber(record['top']) ?? asFiniteNumber(record['y']);
  const cols =
    asFiniteNumber(record['cols']) ?? asFiniteNumber(record['columns']) ?? asFiniteNumber(record['width']);
  const rows = asFiniteNumber(record['rows']) ?? asFiniteNumber(record['height']);

  if (left === null || top === null || cols === null || rows === null) return null;
  if (cols <= 0 || rows <= 0) return null;
  return { left, top, cols: Math.round(cols), rows: Math.round(rows) };
}

/** A finite number, or `null`. Rejects `NaN` and `Infinity` by design. */
export function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
