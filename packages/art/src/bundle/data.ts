/**
 * `packages/art/data/<version>.json`: the tables, serialised so a version change is reviewable as a diff.
 *
 * Three properties are load-bearing rather than cosmetic. Keys are sorted, so two extractions of the same
 * bundle produce the same bytes and `art:sync --check` can compare them. There is no timestamp and no host name
 * anywhere in the file, so the diff shows the game's change and not the run's. And the version the tables were
 * read from is stamped inside, so a consumer can always say which game it is looking at.
 *
 * `--from <url>` is the fast path in §9 of the plan: instead of walking the game's chunks, one contract-checked
 * `GET` against a host that publishes the same record. That host is somebody else's, so the document is checked
 * for the contract before it is written: the same table names, the same stamps, one evidence entry per table.
 * What it cannot check is whether the numbers are right -- that is what the atlas validation is for, and it runs
 * over a fetched document exactly as it runs over an extracted one.
 */

import { type ArtData, type ArtTables, type Evidence, MODEL_TABLES, type TableId } from './tables.js';

/** The document a host must serve for `--from` to accept it: a stamped table set with evidence. */
export const ART_DATA_CONTRACT = 'art-data/1';

/** Raised when a document is not an art data file, or not one this build can read. */
export class ArtDataError extends Error {
  readonly saw: string;

  constructor(message: string, saw: string) {
    super(message);
    this.name = 'ArtDataError';
    this.saw = saw;
  }
}

/** Sort every object's keys, leave array order alone: a table's key order is data, a record's is not. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonical(item));
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = canonical(source[key]);
    return sorted;
  }
  return value;
}

/** Biome's `lineWidth`, which is the width this file has to be formatted to for `npm run lint` to pass. */
const LINE_WIDTH = 110;

/** Every array rendered on one line, or `null` when it cannot be: an object element always breaks the line. */
function inlineArray(value: readonly unknown[]): string | null {
  if (value.length === 0) return '[]';
  const parts: string[] = [];
  for (const item of value) {
    if (item !== null && typeof item === 'object') return null;
    parts.push(JSON.stringify(item));
  }
  return `[${parts.join(', ')}]`;
}

/**
 * Render a value the way Biome's JSON formatter would.
 *
 * The formatter is part of the contract, not a nicety: `npm run lint` is part of `npm run verify`, and a data
 * file Biome would reflow is a data file whose committed bytes are not the bytes anybody else's tool produces.
 * Objects always expand, one key per line in sorted order; an array of scalars stays on one line while it fits,
 * and otherwise expands. `column` is how much of the line is already used, so an array nested inside one is
 * measured where it actually starts.
 */
function renderJson(value: unknown, indent: string, column: number): string {
  if (Array.isArray(value)) {
    const inline = inlineArray(value);
    if (inline !== null && column + inline.length <= LINE_WIDTH) return inline;
    if (value.length === 0) return '[]';
    const inner = `${indent}  `;
    return `[\n${value.map((item) => `${inner}${renderJson(item, inner, inner.length)}`).join(',\n')}\n${indent}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    const inner = `${indent}  `;
    const lines = entries.map(([key, item]) => {
      const label = `${JSON.stringify(key)}: `;
      return `${inner}${label}${renderJson(item, inner, inner.length + label.length)}`;
    });
    return `{\n${lines.join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The exact bytes of `data/<version>.json`.
 *
 * Two runs over the same inputs produce the same string, which is what `art:sync --check` compares and what the
 * determinism test asserts. Sorted keys, two-space indent, LF: the file is reviewed as a diff, and a diff full of
 * reordering is not reviewable.
 */
export function serializeArtData(data: ArtData): string {
  return `${renderJson(canonical(data), '', 0)}\n`;
}

/** Parse a committed data file back into the record its consumer reads. */
export function parseArtData(text: string): ArtData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ArtDataError(
      'the art data file is not JSON',
      error instanceof Error ? error.message : String(error),
    );
  }
  return artDataOf(parsed);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Check a value against the contract, returning it as `ArtData` or refusing with what it saw.
 *
 * This is a *contract* check, not a semantic one: it says the document has the tables, under the names the
 * package reads them by, with a stamp and evidence for each. Whether every sprite path is an atlas frame is
 * `validateTables`' question and is asked separately, because a host can be well-formed and wrong.
 */
export function artDataOf(value: unknown): ArtData {
  if (!isRecord(value)) throw new ArtDataError(`an art data document must be an object`, typeof value);
  const gameVersion = value['gameVersion'];
  const artVersion = value['artVersion'];
  if (typeof gameVersion !== 'string' || gameVersion === '') {
    throw new ArtDataError(
      'an art data document must state the game version it was read from',
      JSON.stringify(gameVersion),
    );
  }
  if (typeof artVersion !== 'string' || artVersion === '') {
    throw new ArtDataError(
      'an art data document must state the art version it was read from',
      JSON.stringify(artVersion),
    );
  }
  const tables = value['tables'];
  if (!isRecord(tables))
    throw new ArtDataError('an art data document must carry a tables object', typeof tables);
  const missing = MODEL_TABLES.filter((table) => !(table in tables));
  if (missing.length > 0) {
    throw new ArtDataError(
      `an art data document must carry every table the model consumes; missing ${missing.join(', ')}`,
      JSON.stringify(Object.keys(tables)),
    );
  }
  const evidence = value['evidence'];
  if (!isRecord(evidence))
    throw new ArtDataError('an art data document must carry evidence', typeof evidence);
  const unstamped = MODEL_TABLES.filter((table) => !isRecord(evidence[table]));
  if (unstamped.length > 0) {
    throw new ArtDataError(
      `every table must carry the evidence it was found by; missing ${unstamped.join(', ')}`,
      JSON.stringify(Object.keys(evidence)),
    );
  }
  return {
    gameVersion,
    artVersion,
    tables: tables as unknown as ArtTables,
    evidence: evidence as unknown as Record<TableId, Evidence>,
  };
}
