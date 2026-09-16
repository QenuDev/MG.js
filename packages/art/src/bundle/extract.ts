/**
 * Running the predicates: one stage per table, each stage able to read the ones before it.
 *
 * The stages are ordered by what they read, not by what matters: the sprite-name table comes first because
 * every other table's sprite references resolve through it, the plant table before the anchors because the
 * anchors are validated against the species it states, and the scale cap before the placement function because
 * the formula is what identifies the function.
 *
 * No extraction picks between two candidates that both hold. Two tables that match the same shape is
 * exactly the situation in which a guess looks like a result, so it is an error carrying both, and the message
 * says which predicate, what it looked for, and what it saw.
 */

import {
  PREDICATES,
  type PredicateContext,
  spriteIndexOf,
  type TableCandidate,
  type TablePredicate,
} from './predicates.js';
import type { ArtData, ArtTables, Evidence, TableId } from './tables.js';

/**
 * The accumulation type: `ArtTables` is readonly because a consumer must not edit what the game said, and an
 * extractor has to fill it in one stage at a time, so the mutability is dropped for the length of the run.
 */
type MutableTables = { -readonly [K in keyof ArtTables]: ArtTables[K] };

/** The result of a successful extraction: the tables, and the evidence for each one. */
export interface Extraction {
  readonly tables: ArtTables;
  readonly evidence: Readonly<Record<TableId, Evidence>>;
}

/**
 * A predicate could not be satisfied. The message names the predicate, the shape it looked for, and what it
 * saw, because the whole point of reading tables by shape is that a shape change is a loud failure.
 */
export class ExtractionError extends Error {
  readonly predicate: string;
  readonly looksFor: string;
  readonly invariant: string;
  readonly saw: readonly string[];

  constructor(input: {
    predicate: string;
    looksFor: string;
    invariant: string;
    saw: readonly string[];
    message: string;
  }) {
    super(input.message);
    this.name = 'ExtractionError';
    this.predicate = input.predicate;
    this.looksFor = input.looksFor;
    this.invariant = input.invariant;
    this.saw = input.saw;
  }
}

/** Pull the tables out of a set of parsed chunks, or refuse and say why. */
export function extractArtTables(chunks: readonly ParsedChunkLike[]): Extraction {
  const context: {
    chunks: readonly ParsedChunkLike[];
    tables: Partial<MutableTables>;
    declarations: Partial<Record<TableId, string>>;
    spriteIndex: ReadonlyMap<string, string> | null;
  } = { chunks, tables: {}, declarations: {}, spriteIndex: null };

  const accepted = new Map<TableId, TableCandidate<unknown>>();
  for (const predicate of PREDICATES) {
    const typed = predicate as unknown as TablePredicate<unknown>;
    const candidates = typed.candidates(context as PredicateContext);
    const withViolations = candidates.map((candidate) => ({
      candidate,
      violations: typed.violations(candidate, context as PredicateContext),
    }));
    const holding = withViolations.filter((entry) => entry.violations.length === 0);
    if (holding.length === 0) {
      throw new ExtractionError({
        predicate: typed.predicate,
        looksFor: typed.looksFor,
        invariant: typed.invariant,
        saw: withViolations.length === 0 ? [] : withViolations.map(describe),
        message:
          `predicate ${typed.predicate} accepted no candidate: looked for ${typed.looksFor}; ` +
          (withViolations.length === 0
            ? 'nothing in the chunks matched the shape'
            : `saw ${withViolations.length} candidate(s): ${withViolations.map(describe).join(' | ')}; ` +
              `the invariant that failed: ${typed.invariant}`),
      });
    }
    if (holding.length > 1) {
      throw new ExtractionError({
        predicate: typed.predicate,
        looksFor: typed.looksFor,
        invariant: typed.invariant,
        saw: holding.map((entry) => describe(entry)),
        message:
          `predicate ${typed.predicate} matched ${holding.length} tables that all satisfy its invariant, so ` +
          `which one the game means is undecidable here: ${holding.map((entry) => describe(entry)).join(' | ')}`,
      });
    }
    const winner = holding[0]?.candidate;
    if (winner === undefined) continue;
    accepted.set(winner.id, winner);
    context.tables[winner.id] = winner.value as never;
    context.declarations[winner.id] = winner.declaration ?? undefined;
    if (winner.id === 'spriteNames') {
      context.spriteIndex = spriteIndexOf(winner.value as ArtTables['spriteNames']);
    }
  }

  const tables: ArtTables = {
    spriteNames: take(accepted, 'spriteNames'),
    mutationRecords: take(accepted, 'mutationRecords'),
    mutationArt: take(accepted, 'mutationArt'),
    displayFlags: take(accepted, 'displayFlags'),
    anchors: take(accepted, 'anchors'),
    plants: take(accepted, 'plants'),
    harvestTypes: take(accepted, 'harvestTypes'),
    iconFills: take(accepted, 'iconFills'),
    itemTypes: take(accepted, 'itemTypes'),
    scale: take(accepted, 'scale'),
    overMutations: take(accepted, 'overMutations'),
    placement: take(accepted, 'placement'),
  };

  const evidence = Object.fromEntries(
    [...accepted.entries()].map(([id, candidate]) => [id, evidenceOf(candidate)]),
  ) as Record<TableId, Evidence>;

  return { tables, evidence };
}

/** One line of "what it saw", used in the failure message and in the review of a data file. */
function describe(entry: { candidate: TableCandidate<unknown>; violations?: readonly string[] }): string {
  const { candidate } = entry;
  const counts = Object.entries(candidate.coverage.counts)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
  const violations = entry.violations ?? [];
  return (
    `${candidate.chunk}${candidate.declaration === null ? '' : `#${candidate.declaration}`}` +
    `[${candidate.start},${candidate.end}) {${counts}}` +
    (violations.length === 0 ? '' : ` -- ${violations.join('; ')}`)
  );
}

function take(accepted: ReadonlyMap<TableId, TableCandidate<unknown>>, id: TableId): never {
  const candidate = accepted.get(id);
  if (candidate === undefined) throw new Error(`the extractor accepted no ${id} table`);
  return candidate.value as never;
}

/** The evidence of a table: the candidate without the value, which the data file carries instead. */
export function evidenceOf(candidate: TableCandidate<unknown>): Evidence {
  return {
    predicate: candidate.predicate,
    looksFor: candidate.looksFor,
    invariant: candidate.invariant,
    chunk: candidate.chunk,
    declaration: candidate.declaration,
    start: candidate.start,
    end: candidate.end,
    support: candidate.support,
    coverage: candidate.coverage,
  };
}

/** Stamp an extraction with the versions it was read from. */
export function artDataFor(
  extraction: Extraction,
  versions: { gameVersion: string; artVersion: string },
): ArtData {
  return {
    gameVersion: versions.gameVersion,
    artVersion: versions.artVersion,
    tables: extraction.tables,
    evidence: extraction.evidence,
  };
}

/**
 * The chunk shape this module accepts. It is `ParsedChunk` from `shape.js`; the alias exists so this module's
 * signature reads as "a projected chunk" rather than repeating the import.
 */
export type ParsedChunkLike = import('./shape.js').ParsedChunk;
