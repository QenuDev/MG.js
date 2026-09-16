/**
 * Where every table came from: the predicate that found it, the shape it looked for, the invariant that
 * confirmed it, and what in the model reads it.
 *
 * The point of the record is that a table cannot enter the model without somebody saying how it is read. That is
 * why the predicate's own `looksFor` and `invariant` are *joined* from `PREDICATES` rather than copied here --
 * a copied sentence drifts from the code that does the work, and this record exists to be trustworthy -- and why
 * {@link provenanceFor} throws when a table or a predicate has no entry rather than rendering a gap.
 *
 * `docs/art-provenance.md` is generated from this record plus one extraction's evidence, so the document a
 * reviewer reads is the same data the tests check.
 */

import { PREDICATES } from './predicates.js';
import { type Evidence, MODEL_TABLES, type TableId } from './tables.js';

/** One table's account of itself. */
export interface TableProvenance {
  /** The predicate id, which `PREDICATES` also carries: the join is what keeps the prose honest. */
  readonly predicate: string;
  /** The validation check that confirms the table beyond its shape, or `null` when none can. */
  readonly validator: string | null;
  /** The tests that confirm it when no runtime validation can, named so a reader can go and look. */
  readonly confirmedBy: readonly string[];
  /** What in the model reads it. A table nothing reads is a table that should not be published. */
  readonly consumers: readonly string[];
}

/**
 * Every table the model consumes, and how it is known to be the right table.
 *
 * The validators named here are the checks in `validate.ts`; the consumers are the names in the plan's model
 * table (`§4`), so a reader can go from a value in the package back to the game's own bytes and forward to the
 * function that draws with it.
 */
export const PROVENANCE: Readonly<Record<TableId, TableProvenance>> = {
  spriteNames: {
    predicate: 'sprite-name-table',
    validator: 'sprite-name-table: every path is a frame the atlas has',
    confirmedBy: [],
    consumers: ['spriteName(record, part)', 'resolveSprite(frames, path)'],
  },
  mutationRecords: {
    predicate: 'mutation-record-table',
    validator: 'mutation-art-table: every key is a mutation the records state',
    confirmedBy: [],
    consumers: ['mutationArt(mutation)', 'mutationStack(mutation)'],
  },
  mutationArt: {
    predicate: 'mutation-art-table',
    validator:
      'mutation-art-table: every sprite it names is in the name table, and every mutation is a wash or a material',
    confirmedBy: [],
    consumers: ['mutationArt(mutation)', 'mutationStack(mutation)', 'mutationOverlayArt(mutation)'],
  },
  displayFlags: {
    predicate: 'display-flag-table',
    validator:
      'display-flag-table: every key is a sprite path the name table states, and the tall set is not empty',
    confirmedBy: [],
    consumers: ['mutationAnchor(species, artName, art, harvestType)', 'plantPicture(...)'],
  },
  anchors: {
    predicate: 'anchor-table',
    validator: 'anchor-table: every key is a species in the plant table',
    confirmedBy: [],
    consumers: ['mutationAnchor(species, artName, art, harvestType)'],
  },
  plants: {
    predicate: 'plant-table',
    validator: 'plant-table: every sprite it names is in the name table',
    confirmedBy: [],
    consumers: ['spriteName(record, part)', 'mutationAnchor(species, artName, art, harvestType)'],
  },
  harvestTypes: {
    predicate: 'harvest-type-enum',
    validator: 'harvest-type-enum: every harvest type a plant states is a member',
    confirmedBy: [],
    consumers: ['mutationAnchor(species, artName, art, harvestType)'],
  },
  iconFills: {
    predicate: 'icon-fill-table',
    validator: "icon-fill-table: every item type is a literal the game's item-type enum assigns exactly once",
    confirmedBy: [],
    consumers: ['iconArt(entry)', 'ICON_FILL'],
  },
  itemTypes: {
    predicate: 'item-type-enum',
    validator: "icon-fill-table: every item type is a literal the game's item-type enum assigns exactly once",
    confirmedBy: [],
    consumers: ['iconArt(entry)', 'ICON_FILL'],
  },
  scale: {
    predicate: 'scale-cap',
    validator: 'scale-cap: the cap is a fraction and the divisor is a tile size',
    confirmedBy: [],
    consumers: ['mutationAnchor(species, artName, art, harvestType)', 'iconArt(entry)'],
  },
  overMutations: {
    predicate: 'mutation-over-set',
    validator: 'mutation-over-set: every member is a mutation the art table states',
    confirmedBy: [],
    consumers: ['mutationStack(mutation)', 'plantPicture(...)'],
  },
  placement: {
    predicate: 'placement-function',
    // Nothing validates a formula against a shape, so this one is confirmed by running it: the extracted
    // function and the ported reference are both called on real atlas frames and must agree.
    validator: null,
    confirmedBy: ['tests/bundle/placement.test.ts'],
    consumers: [
      'mutationAnchor(species, artName, art, harvestType)',
      'mutationPlacement(mutation, icon, art)',
    ],
  },
};

/** A table's provenance with the predicate's own words joined in: what the doc and the tests read. */
export interface StampedProvenance extends TableProvenance {
  readonly id: TableId;
  readonly looksFor: string;
  readonly invariant: string;
}

/**
 * Join the record with the predicates, and refuse a gap in either direction.
 *
 * A table the model consumes with no entry is a value nobody can account for; a predicate with no entry is a
 * shape the extractor reads that the model does not (which is allowed only if it says so, by being listed here
 * with no consumers -- at which point the honest answer is usually to delete the predicate).
 */
export function provenanceFor(
  record: Readonly<Record<TableId, TableProvenance>> = PROVENANCE,
  predicates: readonly {
    readonly id: TableId;
    readonly predicate: string;
    readonly looksFor: string;
    readonly invariant: string;
  }[] = PREDICATES,
): readonly StampedProvenance[] {
  const missing = MODEL_TABLES.filter((table) => record[table] === undefined);
  if (missing.length > 0) {
    throw new Error(`the model consumes ${missing.join(', ')} with no provenance entry`);
  }
  return MODEL_TABLES.map((id) => {
    const entry = record[id];
    const predicate = predicates.find((candidate) => candidate.id === id);
    if (predicate === undefined)
      throw new Error(`the provenance record names a table no predicate produces: ${id}`);
    if (predicate.predicate !== entry.predicate) {
      throw new Error(
        `${id} is credited to ${entry.predicate}, but its predicate calls itself ${predicate.predicate}`,
      );
    }
    return {
      ...entry,
      id,
      looksFor: predicate.looksFor,
      invariant: predicate.invariant,
    };
  });
}

/** The version and the evidence a document is stamped with. */
export interface ProvenanceStamp {
  readonly gameVersion: string;
  readonly artVersion: string;
  readonly evidence: Readonly<Record<TableId, Evidence>>;
}

/**
 * `docs/art-provenance.md`, generated from the record and one extraction's evidence.
 *
 * Deterministic: the same record and the same evidence produce the same bytes, which is what lets a test assert
 * the committed document instead of trusting that somebody regenerated it.
 */
export function renderProvenanceDoc(
  entries: readonly StampedProvenance[] = provenanceFor(),
  stamp: ProvenanceStamp | null = null,
): string {
  const lines: string[] = [];
  lines.push('# Where the art tables come from');
  lines.push('');
  lines.push(
    'Generated by `renderProvenanceDoc` in `packages/art/src/bundle/provenance.ts` from the `PROVENANCE` record',
  );
  lines.push(
    'and the evidence of one extraction. `npm run art:sync` writes it; `tests/bundle/provenance.test.ts` fails',
  );
  lines.push('when the committed document drifts from the record, so this page cannot describe a table the');
  lines.push('package no longer reads.');
  lines.push('');
  if (stamp === null) {
    lines.push('No extraction is stamped into this copy.');
  } else {
    lines.push(
      `Read from the game's own chunks for game version **${stamp.gameVersion}** (art version **${stamp.artVersion}**).`,
    );
  }
  lines.push('');
  lines.push('| Table | Predicate | Read from | Consumers |');
  lines.push('|---|---|---|---|');
  for (const entry of entries) {
    const evidence = stamp?.evidence[entry.id];
    const where =
      evidence === undefined
        ? '—'
        : `\`${evidence.chunk}\`${evidence.declaration === null ? '' : ` #${evidence.declaration}`} [${evidence.start},${evidence.end})`;
    lines.push(`| \`${entry.id}\` | \`${entry.predicate}\` | ${where} | ${entry.consumers.join(', ')} |`);
  }
  lines.push('');
  for (const entry of entries) {
    lines.push(`## \`${entry.id}\``);
    lines.push('');
    lines.push(`- **Looks for**: ${entry.looksFor}`);
    lines.push(`- **Invariant**: ${entry.invariant}`);
    lines.push(
      `- **Confirmed by**: ${entry.validator ?? 'no validation can confirm it'}${
        entry.confirmedBy.length === 0
          ? ''
          : `, and by ${entry.confirmedBy.map((test) => `\`${test}\``).join(', ')}`
      }`,
    );
    lines.push(`- **Consumers**: ${entry.consumers.join(', ')}`);
    const evidence = stamp?.evidence[entry.id];
    if (evidence !== undefined) {
      lines.push(
        `- **Read from**: \`${evidence.chunk}\`${
          evidence.declaration === null ? '' : ` declaration \`${evidence.declaration}\``
        }, bytes [${evidence.start},${evidence.end})`,
      );
      if (evidence.support.length > 0) {
        lines.push(`- **Read with**: ${evidence.support.map((name) => `\`${name}\``).join(', ')}`);
      }
      lines.push(
        `- **Measured**: ${Object.entries(evidence.coverage.counts)
          .map(([key, value]) => `${key} ${value}`)
          .join(', ')}`,
      );
      for (const note of evidence.coverage.notes ?? []) lines.push(`  - ${note}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
