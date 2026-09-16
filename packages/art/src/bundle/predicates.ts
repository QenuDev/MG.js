/**
 * The shapes the game's art tables are recognised by, and the invariant each one carries.
 *
 * A predicate here answers one question -- "what in these chunks looks like the sprite-name table?" -- and it
 * answers it with *every* candidate it matched, each with a coverage record of what it measured. It never
 * answers with a boolean, because "found it" is exactly the answer that rots silently: a table that lost half
 * its keys, or whose leaves changed from backtick literals to something this reader does not project, still
 * matches a boolean test and still yields a table. It does not yield a *count* of 583, and the count is what
 * says whether the shape still means what it used to.
 *
 * Acceptance is a second question, and it is not "did the shape match" either. A candidate is accepted when its
 * invariant holds -- the sprite-name table is at least two categories wide, every anchor key is a species in the
 * plant table, the tall set is non-empty and lives in the name table -- and when more than one candidate still
 * holds, the extraction refuses rather than picking one.
 *
 * Nothing here names a minified symbol. That is not a convention, it is a test: `tests/bundle/no-minified-names`
 * reads the symbol names the extractor found in the captured bundle and greps this package's source for them.
 */

import {
  asObject,
  asString,
  contains,
  declarationNamed,
  leafEntries,
  leafStrings,
  memberValue,
  type ParsedChunk,
  type ShapeObjectLiteral,
  type ShapeValue,
} from './shape.js';
import type {
  AnchorValue,
  ArtTables,
  Coverage,
  PlacementExternal,
  PlantPart,
  PlantRecord,
  TableId,
} from './tables.js';

/** What every predicate needs: the chunks, what has been found so far, and the names it was found under. */
export interface PredicateContext {
  readonly chunks: readonly ParsedChunk[];
  readonly tables: Partial<ArtTables>;
  /** The declaration each found table sits in, so one predicate can scope a search to another's chunk. */
  readonly declarations: Partial<Record<TableId, string>>;
  /** `Category.Name` -> sprite path, built from the sprite-name table; `null` until that is found. */
  readonly spriteIndex: ReadonlyMap<string, string> | null;
}

/** A candidate a predicate matched, with everything needed to review the match later. */
export interface TableCandidate<T> {
  readonly id: TableId;
  readonly predicate: string;
  readonly looksFor: string;
  readonly invariant: string;
  readonly chunk: string;
  readonly declaration: string | null;
  readonly start: number;
  readonly end: number;
  /** Other declarations in the chunk this predicate had to read to accept the table. */
  readonly support: readonly string[];
  readonly coverage: Coverage;
  readonly value: T;
}

/**
 * One predicate: the shape it looks for in one sentence, the invariant that must hold of what it found, and
 * the candidates it matched. `violations` is the invariant made checkable; an empty list means it holds.
 */
export interface TablePredicate<T> {
  readonly id: TableId;
  readonly predicate: string;
  readonly looksFor: string;
  readonly invariant: string;
  readonly candidates: (context: PredicateContext) => readonly TableCandidate<T>[];
  readonly violations: (candidate: TableCandidate<T>, context: PredicateContext) => readonly string[];
}

/** A sprite identity in the atlas's own key form, which is also the name table's own leaf form. */
const SPRITE_PATH = /^sprite\/[a-z0-9-]+\/[A-Za-z0-9_-]+$/;

/** A colour any of the game's filters could state. The filters are the only place a crop wash is written. */
const COLOUR = /^(?:#|rgba?\(|hsla?\()/i;

/** A boolean display flag: `isTallPlant`, `isNarrowDisplay`, and whatever a later build adds. */
const DISPLAY_FLAG = /^is[A-Z]/;

/** Member names an anchor entry may use. A table of fractions is not this table. */
const ANCHOR_KEYS = new Set(['x', 'y', 'scale', 'plant', 'crop']);

/** Member names of the mutation art table this extractor reads. */
const ART_FIELDS = /sprite|icon|overlay|filters|ground/i;

/**
 * The globals a chunk may read without declaring. These are ECMAScript's, not the game's: naming them is not
 * naming a minified symbol, and the placement function's closure is short enough that anything else in it is a
 * table the extractor failed to resolve -- which is a failure, not a wildcard.
 */
const HOST_GLOBALS = new Set([
  'Array',
  'Boolean',
  'Date',
  'JSON',
  'Map',
  'Math',
  'Number',
  'Object',
  'Promise',
  'Reflect',
  'RegExp',
  'Set',
  'String',
  'Symbol',
  'console',
  'globalThis',
  'undefined',
]);

/** The smallest sprite-name table worth calling one. The captured build has 583. */
const MIN_SPRITE_PATHS = 100;

/** The smallest keyed table worth calling one, for the tables whose shape alone is not specific. */
const MIN_KEYS = 8;

/** A note in the shape of a count, so a coverage record reads the same whether it is a number or a sentence. */
const integerNote = (label: string, count: number): string => `${label}: ${count}`;

/** `Category.Name` for every leaf of the sprite-name table, so a reference can be resolved by its tail. */
export function spriteIndexOf(names: ArtTables['spriteNames']): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const [category, members] of Object.entries(names)) {
    for (const [name, path] of Object.entries(members)) index.set(`${category}.${name}`, path);
  }
  return index;
}

/** The member names a chunk-wide string enum assigns, from `e.Single = 'Single'`-shaped assignments. */
function enumAssignments(chunk: ParsedChunk, member: string): readonly ShapeValue[] {
  return chunk.assignments
    .filter((assignment) => assignment.path.at(-1) === member)
    .map((assignment) => assignment.value)
    .filter((value) => asString(value) !== null);
}

/** The sprite paths a reference chain states: a name table entry and a mutation record's sprite are both it. */
function referenceTail(path: readonly string[]): string {
  return path.slice(1).join('.');
}

/** Resolve a chain against the sprite-name table by its tail, or `null` when nothing matches. */
function resolveSprite(path: readonly string[], index: ReadonlyMap<string, string> | null): string | null {
  if (index === null) return null;
  const direct = path.join('.');
  if (SPRITE_PATH.test(direct)) return direct;
  const tail = referenceTail(path);
  return index.get(tail) ?? null;
}

/** A reference's chain, or a computed key's own text split into one. */
function chainOf(value: ShapeValue): readonly string[] | null {
  return value.kind === 'reference' ? value.path : null;
}

/**
 * The first colour literal and the first `alpha` in a filter construction.
 *
 * The instructions are the game's: the wash lives inside the filter's own arguments (`new Filter({color, alpha})`)
 * and nowhere else, so this reads the literals rather than any table of colours -- the UI colour a mutation is
 * drawn with is a different value from the wash its crop is filtered through, and the API's published colours
 * are the former.
 */
function filterFacts(value: ShapeValue): { color: string | null; alpha: number | null } {
  const queue: ShapeValue[] = [value];
  let color: string | null = null;
  let alpha: number | null = null;
  let seen = 0;
  while (queue.length > 0 && seen < 64) {
    seen += 1;
    const node = queue.shift();
    if (node === undefined) break;
    if (node.kind === 'object') {
      for (const member of node.object.members) {
        if (member.key === 'alpha' && alpha === null && member.value.kind === 'number')
          alpha = member.value.value;
        if (color === null) {
          const string = asString(member.value);
          if (string !== null && COLOUR.test(string.text)) color = string.text;
        }
        queue.push(member.value);
      }
    } else if (node.kind === 'call') queue.push(...node.args);
    else if (node.kind === 'array') queue.push(...node.items);
  }
  return { color, alpha };
}

/** True when every member of a shape value is a number, or an object of numbers. */
function numericAnchor(value: ShapeValue): boolean {
  if (value.kind === 'number') return true;
  const object = asObject(value);
  if (object === null) return false;
  for (const member of object.members) {
    if (!ANCHOR_KEYS.has(member.key)) return false;
    const nested = asObject(member.value);
    if (nested !== null) {
      for (const inner of nested.members) {
        if (!ANCHOR_KEYS.has(inner.key)) return false;
        if (inner.value.kind !== 'number') return false;
      }
    } else if (member.value.kind !== 'number') return false;
  }
  return true;
}

/** The anchor value as data: a number, or the per-part record the game states. */
function anchorValue(value: ShapeValue): AnchorValue {
  if (value.kind === 'number') return value.value;
  const object = asObject(value);
  const record: Record<string, number | AnchorValue> = {};
  for (const member of object?.members ?? []) {
    const nested = asObject(member.value);
    if (nested !== null) record[member.key] = anchorValue(member.value);
    else if (member.value.kind === 'number') record[member.key] = member.value.value;
  }
  return record;
}

/** A plant block: the sprite the game states, resolved, and the harvest member it names. */
function plantPart(
  value: ShapeValue,
  index: ReadonlyMap<string, string> | null,
): {
  part: PlantPart;
  resolved: boolean;
  harvest: string | null;
} {
  const object = asObject(value);
  const sprite = memberValue(object ?? EMPTY_OBJECT, 'sprite');
  const harvest = memberValue(object ?? EMPTY_OBJECT, 'harvestType');
  const chain = sprite === null ? null : chainOf(sprite);
  const path = chain === null ? (asString(sprite)?.text ?? null) : resolveSprite(chain, index);
  const harvestMember =
    harvest === null
      ? null
      : harvest.kind === 'reference'
        ? (harvest.path.at(-1) ?? null)
        : (asString(harvest)?.text ?? null);
  return {
    part: { sprite: path, harvestType: harvestMember },
    resolved: path !== null,
    harvest: harvestMember,
  };
}

const EMPTY_OBJECT: ShapeObjectLiteral = {
  kind: 'object',
  name: null,
  members: [],
  start: 0,
  end: 0,
  text: '',
} as unknown as ShapeObjectLiteral;

/** A function's own text, declared again exactly as the chunk wrote it. */
function declarationText(chunk: ParsedChunk, name: string): string | null {
  const declaration = declarationNamed(chunk, name);
  if (declaration === null) return null;
  return declaration.text;
}

// -----------------------------------------------------------------------------------------------------------
// The predicates
// -----------------------------------------------------------------------------------------------------------

const spriteNameTable: TablePredicate<ArtTables['spriteNames']> = {
  id: 'spriteNames',
  predicate: 'sprite-name-table',
  looksFor:
    'an object literal with at least a hundred leaf strings of the form sprite/<category>/<Name>, taking the outermost match so a nested category is not mistaken for the table',
  invariant:
    'every leaf is a sprite path, the table is at least two categories wide, and the leaves are counted by the syntax they were written in, because a reader that projects only quoted strings reports an empty table rather than a wrong one',
  candidates(context) {
    const found: TableCandidate<ArtTables['spriteNames']>[] = [];
    for (const chunk of context.chunks) {
      const matching = chunk.objects.filter(
        (object) =>
          leafStrings(object).filter((leaf) => SPRITE_PATH.test(leaf.text)).length >= MIN_SPRITE_PATHS,
      );
      const outermost = matching.filter(
        (candidate) => !matching.some((other) => other !== candidate && contains(other, candidate)),
      );
      for (const object of outermost) {
        const entries = leafEntries(object);
        const names: Record<string, Record<string, string>> = {};
        let template = 0;
        let quoted = 0;
        let offShape = 0;
        for (const [path, leaf] of entries) {
          if (leaf.quote === 'template') template += 1;
          else quoted += 1;
          if (!SPRITE_PATH.test(leaf.text) || path.length !== 2) {
            offShape += 1;
            continue;
          }
          const [category, name] = path;
          if (category === undefined || name === undefined) continue;
          let members = names[category];
          if (members === undefined) {
            members = {};
            names[category] = members;
          }
          members[name] = leaf.text;
        }
        const paths = Object.values(names).reduce((total, members) => total + Object.keys(members).length, 0);
        found.push({
          id: 'spriteNames',
          support: [],
          predicate: spriteNameTable.predicate,
          looksFor: spriteNameTable.looksFor,
          invariant: spriteNameTable.invariant,
          chunk: chunk.file,
          declaration: object.name,
          start: object.start,
          end: object.end,
          coverage: {
            counts: {
              leaves: entries.length,
              spritePaths: paths,
              categories: Object.keys(names).length,
              templateLiterals: template,
              quotedStrings: quoted,
              leavesThatAreNotSpritePaths: offShape,
            },
            notes: [
              'backtick literals, not quoted strings: a reader that only projected quoted strings reads this as an empty table',
              integerNote('sibling matches inside this literal', matching.length - outermost.length),
            ],
          },
          value: names,
        });
      }
    }
    return found;
  },
  violations(candidate) {
    const problems: string[] = [];
    const counts = candidate.coverage.counts;
    if ((counts['spritePaths'] ?? 0) < MIN_SPRITE_PATHS) {
      problems.push(`only ${counts['spritePaths'] ?? 0} sprite paths`);
    }
    if ((counts['categories'] ?? 0) < 2) problems.push(`only ${counts['categories'] ?? 0} categories`);
    if ((counts['leavesThatAreNotSpritePaths'] ?? 0) > 0) {
      problems.push(`${counts['leavesThatAreNotSpritePaths'] ?? 0} leaves are not sprite paths`);
    }
    if ((counts['templateLiterals'] ?? 0) === 0 && (counts['quotedStrings'] ?? 0) > 0) {
      problems.push("no leaf is a backtick literal, so this is probably not the game's sprite table");
    }
    return problems;
  },
};

const mutationRecordTable: TablePredicate<ArtTables['mutationRecords']> = {
  id: 'mutationRecords',
  predicate: 'mutation-record-table',
  looksFor:
    'an object literal with at least eight keys whose values each state a name, a group and (for everything that can be drawn on a crop) a sprite reference',
  invariant:
    'every value states its group, every sprite reference resolves through the sprite-name table, and at least three keys are drawable, because a table of mutations that can all be drawn nowhere is a different table',
  candidates(context) {
    const found: TableCandidate<ArtTables['mutationRecords']>[] = [];
    for (const chunk of context.chunks) {
      for (const object of chunk.objects) {
        if (object.members.length < MIN_KEYS) continue;
        const values = object.members.map((member) => asObject(member.value));
        if (values.some((value) => value === null)) continue;
        const records: Record<string, { name: string; group: string; sprite: string | null }> = {};
        let named = 0;
        let grouped = 0;
        let withSprite = 0;
        let resolved = 0;
        let unresolved = 0;
        for (const [at, member] of object.members.entries()) {
          const value = values[at];
          if (value === null || value === undefined) continue;
          const name = asString(memberValue(value, 'name'));
          const group = asString(memberValue(value, 'group'));
          if (name !== null) named += 1;
          if (group !== null) grouped += 1;
          const sprite = memberValue(value, 'sprite');
          let path: string | null = null;
          if (sprite !== null) {
            withSprite += 1;
            const chain = chainOf(sprite);
            path =
              chain === null ? (asString(sprite)?.text ?? null) : resolveSprite(chain, context.spriteIndex);
            if (path !== null) resolved += 1;
            else unresolved += 1;
          }
          records[member.key] = { name: name?.text ?? member.key, group: group?.text ?? '', sprite: path };
        }
        const groups = new Set(Object.values(records).map((record) => record.group));
        found.push({
          id: 'mutationRecords',
          support: [],
          predicate: mutationRecordTable.predicate,
          looksFor: mutationRecordTable.looksFor,
          invariant: mutationRecordTable.invariant,
          chunk: chunk.file,
          declaration: object.name,
          start: object.start,
          end: object.end,
          coverage: {
            counts: {
              keys: object.members.length,
              valuesStatingAName: named,
              valuesStatingAGroup: grouped,
              valuesWithASprite: withSprite,
              spriteReferencesResolved: resolved,
              spriteReferencesUnresolved: unresolved,
              distinctGroups: groups.size,
            },
          },
          value: records,
        });
      }
    }
    return found;
  },
  violations(candidate) {
    const problems: string[] = [];
    const counts = candidate.coverage.counts;
    if ((counts['keys'] ?? 0) < MIN_KEYS) problems.push(`only ${counts['keys'] ?? 0} keys`);
    if ((counts['valuesStatingAGroup'] ?? 0) !== (counts['keys'] ?? -1)) {
      problems.push(`${counts['valuesStatingAGroup'] ?? 0} of ${counts['keys'] ?? 0} values state a group`);
    }
    if ((counts['valuesWithASprite'] ?? 0) < 3) problems.push('fewer than three values state a sprite');
    if ((counts['spriteReferencesUnresolved'] ?? 0) > 0) {
      problems.push(`${counts['spriteReferencesUnresolved'] ?? 0} sprite references do not resolve`);
    }
    return problems;
  },
};

const mutationArtTable: TablePredicate<ArtTables['mutationArt']> = {
  id: 'mutationArt',
  predicate: 'mutation-art-table',
  looksFor:
    'an object literal with at least eight keys whose values carry art fields (sprite, icon, overlay, filters, ground), at least one of them a filter',
  invariant:
    'every key is a mutation record this bundle states, every colour-bearing filter states both its colour and its alpha, every sprite reference resolves through the sprite-name table, and the keys that construct no colour filter at all are counted as materials rather than dropped',
  candidates(context) {
    const found: TableCandidate<ArtTables['mutationArt']>[] = [];
    const records: Readonly<Record<string, { sprite: string | null }>> = context.tables.mutationRecords ?? {};
    for (const chunk of context.chunks) {
      for (const object of chunk.objects) {
        if (object.members.length < MIN_KEYS) continue;
        const fieldNames = new Set<string>();
        let filters = 0;
        for (const member of object.members) {
          for (const inner of asObject(member.value)?.members ?? []) {
            fieldNames.add(inner.key);
            if (inner.key === 'filters') filters += 1;
          }
        }
        const artFields = [...fieldNames].filter((field) => ART_FIELDS.test(field));
        if (filters === 0 || artFields.length < 2) continue;
        const art: Record<string, ArtTables['mutationArt'][string]> = {};
        let tinted = 0;
        let materials = 0;
        let unresolvedRefs = 0;
        let iconRefs = 0;
        let recordKeys = 0;
        for (const [order, member] of object.members.entries()) {
          const value = asObject(member.value);
          const facts = memberValue(value ?? EMPTY_OBJECT, 'filters');
          const wash = facts === null ? { color: null, alpha: null } : filterFacts(facts);
          const material = wash.color === null;
          if (material) materials += 1;
          else tinted += 1;
          if (records[member.key] !== undefined) recordKeys += 1;
          const resolveRef = (field: string): string | null => {
            const reference = memberValue(value ?? EMPTY_OBJECT, field);
            if (reference === null) return null;
            const chain = chainOf(reference);
            if (chain === null) {
              const literal = asString(reference);
              if (literal !== null && SPRITE_PATH.test(literal.text)) return literal.text;
              unresolvedRefs += 1;
              return null;
            }
            // `R.Wet.sprite` is a mutation record's own sprite, already resolved by its own predicate.
            if (chain.length === 3 && chain[2] === 'sprite' && records[chain[1] ?? ''] !== undefined) {
              iconRefs += 1;
              return records[chain[1] ?? '']?.sprite ?? null;
            }
            const path = resolveSprite(chain, context.spriteIndex);
            if (path === null) unresolvedRefs += 1;
            return path;
          };
          const bottom = memberValue(value ?? EMPTY_OBJECT, 'overlayFromBottom');
          art[member.key] = {
            order,
            tint: material || wash.color === null ? null : { color: wash.color, alpha: wash.alpha },
            material,
            iconSprite: resolveRef('iconSprite'),
            groundSprite: resolveRef('tallPlantGroundSprite'),
            overlaySprite: resolveRef('overlaySprite'),
            overlayFromBottom: bottom !== null && bottom.kind === 'boolean' && bottom.value,
          };
        }
        found.push({
          id: 'mutationArt',
          support: [],
          predicate: mutationArtTable.predicate,
          looksFor: mutationArtTable.looksFor,
          invariant: mutationArtTable.invariant,
          chunk: chunk.file,
          declaration: object.name,
          start: object.start,
          end: object.end,
          coverage: {
            counts: {
              keys: object.members.length,
              valuesCarryingAFilter: filters,
              valuesWithATint: tinted,
              valuesThatAreMaterials: materials,
              keysThatAreMutationRecords: recordKeys,
              recordFieldReferences: iconRefs,
              referencesUnresolved: unresolvedRefs,
            },
            notes: [`art fields seen: ${artFields.sort().join(', ')}`],
          },
          value: art,
        });
      }
    }
    return found;
  },
  violations(candidate) {
    const problems: string[] = [];
    const counts = candidate.coverage.counts;
    if ((counts['keys'] ?? 0) < MIN_KEYS) problems.push(`only ${counts['keys'] ?? 0} keys`);
    if ((counts['valuesWithATint'] ?? 0) === 0) problems.push('no value states a colour filter');
    if ((counts['keysThatAreMutationRecords'] ?? 0) !== (counts['keys'] ?? -1)) {
      problems.push(
        `${counts['keysThatAreMutationRecords'] ?? 0} of ${counts['keys'] ?? 0} keys are mutation records, so this is not the mutation art table`,
      );
    }
    for (const [name, art] of Object.entries(candidate.value)) {
      if (art.tint !== null && art.tint.alpha === null)
        problems.push(`${name} states a colour with no alpha`);
    }
    const unresolved = candidate.coverage.counts['referencesUnresolved'] ?? 0;
    if (unresolved > 0)
      problems.push(`${unresolved} sprite references do not resolve through the name table`);
    return problems;
  },
};

const displayFlagTable: TablePredicate<ArtTables['displayFlags']> = {
  id: 'displayFlags',
  predicate: 'display-flag-table',
  looksFor:
    'an object literal with at least eight keys whose values are boolean display flags (`is*` names), directly or through a chunk-local declaration that holds the all-false default',
  invariant:
    'every key resolves through the sprite-name table to a sprite path, at least one key states a true flag, and the default record is identified by how many keys point at it rather than by a name',
  candidates(context) {
    const found: TableCandidate<ArtTables['displayFlags']>[] = [];
    for (const chunk of context.chunks) {
      for (const object of chunk.objects) {
        if (object.members.length < MIN_KEYS) continue;
        const flagObjects = new Map<string, ShapeObjectLiteral>();
        const refCounts = new Map<string, number>();
        let flagsNamed = 0;
        let inline = 0;
        let shaped = true;
        for (const member of object.members) {
          const direct = asObject(member.value);
          const candidate =
            direct ??
            asObject(
              declarationNamed(chunk, member.value.kind === 'reference' ? (member.value.path[0] ?? '') : '')
                ?.value ?? null,
            );
          if (candidate === null) {
            shaped = false;
            break;
          }
          const flags = candidate.members.filter((inner) => DISPLAY_FLAG.test(inner.key));
          if (flags.length === 0) {
            shaped = false;
            break;
          }
          for (const flag of flags) {
            if (flag.value.kind !== 'boolean') shaped = false;
          }
          if (!shaped) break;
          flagsNamed += flags.length;
          if (direct !== null) inline += 1;
          else {
            const name = member.value.kind === 'reference' ? (member.value.path[0] ?? '') : '';
            refCounts.set(name, (refCounts.get(name) ?? 0) + 1);
            flagObjects.set(name, candidate);
          }
        }
        if (!shaped || flagsNamed === 0) continue;
        // The record the most keys point at is the default: one object, many keys, all flags false.
        const byReferences = [...refCounts.entries()].sort((left, right) => right[1] - left[1]);
        const defaultName = byReferences[0]?.[0] ?? null;
        const defaultRecord = defaultName === null ? null : (flagObjects.get(defaultName) ?? null);
        const flags: Record<string, { isTallPlant: boolean; isNarrowDisplay: boolean }> = {};
        let resolved = 0;
        let unresolved = 0;
        let tall = 0;
        let narrow = 0;
        for (const member of object.members) {
          const value = asObject(member.value);
          // An entry that points at the default declaration gets the default's own values; an inline entry
          // gets its own, and a flag it does not state falls back to the default's.
          const record = value ?? (member.value.kind === 'reference' ? defaultRecord : null);
          const read = (flag: string): boolean => {
            const own = record === null ? null : memberValue(record, flag);
            if (own !== null && own.kind === 'boolean') return own.value;
            const fallback = defaultRecord === null ? null : memberValue(defaultRecord, flag);
            return fallback !== null && fallback.kind === 'boolean' ? fallback.value : false;
          };
          const chain =
            member.value.kind === 'reference' && !member.computed
              ? member.value.path
              : member.computed
                ? member.key.split('.')
                : null;
          const path =
            chain === null
              ? SPRITE_PATH.test(member.key)
                ? member.key
                : resolveSprite([member.key], context.spriteIndex)
              : resolveSprite(chain, context.spriteIndex);
          if (path === null) unresolved += 1;
          else {
            resolved += 1;
            if (read('isTallPlant')) tall += 1;
            if (read('isNarrowDisplay')) narrow += 1;
            flags[path] = { isTallPlant: read('isTallPlant'), isNarrowDisplay: read('isNarrowDisplay') };
          }
        }
        found.push({
          id: 'displayFlags',
          support: defaultName === null ? [] : [defaultName],
          predicate: displayFlagTable.predicate,
          looksFor: displayFlagTable.looksFor,
          invariant: displayFlagTable.invariant,
          chunk: chunk.file,
          declaration: object.name,
          start: object.start,
          end: object.end,
          coverage: {
            counts: {
              keys: object.members.length,
              keysWithInlineFlags: inline,
              keysPointingAtTheDefault: object.members.length - inline,
              flagsStated: flagsNamed,
              keysResolvedThroughTheNameTable: resolved,
              keysUnresolved: unresolved,
              isTallPlantTrue: tall,
              isNarrowDisplayTrue: narrow,
              defaultReferences: byReferences[0]?.[1] ?? 0,
            },
            notes: [
              defaultName === null
                ? 'no shared default record: every key states its own flags'
                : `the default record is the declaration ${byReferences[0]?.[1] ?? 0} keys point at`,
            ],
          },
          value: flags,
        });
      }
    }
    return found;
  },
  violations(candidate) {
    const problems: string[] = [];
    const counts = candidate.coverage.counts;
    if ((counts['keys'] ?? 0) < MIN_KEYS) problems.push(`only ${counts['keys'] ?? 0} keys`);
    if ((counts['keysUnresolved'] ?? 0) > 0) {
      problems.push(`${counts['keysUnresolved'] ?? 0} keys do not resolve to a sprite path`);
    }
    if ((counts['isTallPlantTrue'] ?? 0) === 0) problems.push('no key states isTallPlant');
    if ((counts['keysResolvedThroughTheNameTable'] ?? 0) < MIN_KEYS) {
      problems.push(`only ${counts['keysResolvedThroughTheNameTable'] ?? 0} keys resolve`);
    }
    return problems;
  },
};

const anchorTable: TablePredicate<ArtTables['anchors']> = {
  id: 'anchors',
  predicate: 'anchor-table',
  looksFor:
    'an object literal with at least eight keys whose values are numbers, or objects of numbers under the names x, y, scale, plant and crop',
  invariant:
    'every key is a species the plant table states -- a table of fractions keyed by centreXFraction matches this shape and is refused -- and every value is a number shape, not an expression',
  candidates(context) {
    const found: TableCandidate<ArtTables['anchors']>[] = [];
    for (const chunk of context.chunks) {
      for (const object of chunk.objects) {
        if (object.members.length < MIN_KEYS) continue;
        if (!object.members.every((member) => numericAnchor(member.value))) continue;
        const anchors: Record<string, AnchorValue> = {};
        let numeric = 0;
        let records = 0;
        let nested = 0;
        for (const member of object.members) {
          anchors[member.key] = anchorValue(member.value);
          if (member.value.kind === 'number') numeric += 1;
          else {
            records += 1;
            if (asObject(member.value)?.members.some((inner) => asObject(inner.value) !== null)) nested += 1;
          }
        }
        const species = new Set(Object.keys(context.tables.plants ?? {}));
        const missing = Object.keys(anchors).filter((key) => !species.has(key));
        found.push({
          id: 'anchors',
          support: [],
          predicate: anchorTable.predicate,
          looksFor: anchorTable.looksFor,
          invariant: anchorTable.invariant,
          chunk: chunk.file,
          declaration: object.name,
          start: object.start,
          end: object.end,
          coverage: {
            counts: {
              keys: object.members.length,
              numericValues: numeric,
              recordValues: records,
              valuesWithPerPartNumbers: nested,
              keysThatAreSpecies: Object.keys(anchors).length - missing.length,
              keysThatAreNotSpecies: missing.length,
            },
            notes:
              missing.length === 0
                ? []
                : [`keys the plant table does not state: ${missing.slice(0, 6).join(', ')}`],
          },
          value: anchors,
        });
      }
    }
    return found;
  },
  violations(candidate, context) {
    const problems: string[] = [];
    const counts = candidate.coverage.counts;
    if ((counts['keys'] ?? 0) < MIN_KEYS) problems.push(`only ${counts['keys'] ?? 0} keys`);
    if (Object.keys(context.tables.plants ?? {}).length > 0 && (counts['keysThatAreNotSpecies'] ?? 0) > 0) {
      problems.push(
        `${counts['keysThatAreNotSpecies'] ?? 0} keys are not species in the plant table (${candidate.coverage.notes?.join('; ') ?? ''})`,
      );
    }
    return problems;
  },
};

const plantTable: TablePredicate<ArtTables['plants']> = {
  id: 'plants',
  predicate: 'plant-table',
  looksFor:
    'an object literal with at least five keys whose values state a plant block carrying a harvest type and a sprite reference',
  invariant:
    'every species states a plant block, every sprite reference in every part resolves through the sprite-name table, and the harvest types the table names are counted so a build that renames the enum is visible',
  candidates(context) {
    const found: TableCandidate<ArtTables['plants']>[] = [];
    for (const chunk of context.chunks) {
      for (const object of chunk.objects) {
        if (object.members.length < 5) continue;
        const harvests = new Set<string>();
        let planted = 0;
        let parts = 0;
        let resolved = 0;
        let unresolved = 0;
        const plants: Record<string, PlantRecord> = {};
        let shaped = true;
        for (const member of object.members) {
          const value = asObject(member.value);
          const plant = value === null ? null : asObject(memberValue(value, 'plant'));
          if (value === null || plant === null || memberValue(plant, 'harvestType') === null) {
            shaped = false;
            break;
          }
          planted += 1;
          const record: Record<string, PlantPart | null> = { seed: null, plant: null, crop: null };
          for (const part of ['seed', 'plant', 'crop'] as const) {
            const block = memberValue(value, part);
            if (block === null) continue;
            const read = plantPart(block, context.spriteIndex);
            record[part] = read.part;
            parts += 1;
            if (read.resolved) resolved += 1;
            else unresolved += 1;
            if (read.harvest !== null) harvests.add(read.harvest);
          }
          plants[member.key] = record as unknown as PlantRecord;
        }
        if (!shaped || planted < 5) continue;
        found.push({
          id: 'plants',
          support: [],
          predicate: plantTable.predicate,
          looksFor: plantTable.looksFor,
          invariant: plantTable.invariant,
          chunk: chunk.file,
          declaration: object.name,
          start: object.start,
          end: object.end,
          coverage: {
            counts: {
              species: planted,
              parts,
              spriteReferencesResolved: resolved,
              spriteReferencesUnresolved: unresolved,
              distinctHarvestTypes: harvests.size,
            },
            notes: [`harvest types named: ${[...harvests].sort().join(', ')}`],
          },
          value: plants,
        });
      }
    }
    return found;
  },
  violations(candidate) {
    const problems: string[] = [];
    const counts = candidate.coverage.counts;
    if ((counts['species'] ?? 0) < 5) problems.push(`only ${counts['species'] ?? 0} species`);
    if ((counts['spriteReferencesUnresolved'] ?? 0) > 0) {
      problems.push(`${counts['spriteReferencesUnresolved'] ?? 0} sprite references do not resolve`);
    }
    if ((counts['distinctHarvestTypes'] ?? 0) === 0) problems.push('no species states a harvest type');
    return problems;
  },
};

const harvestTypeEnum: TablePredicate<ArtTables['harvestTypes']> = {
  id: 'harvestTypes',
  predicate: 'harvest-type-enum',
  looksFor:
    "the string-enum idiom the plant table names: `e.Single = 'Single'`-shaped assignments, read chunk-wide because the enum is built by a function that returns the object it fills",
  invariant:
    "every member the plant table names is assigned exactly one string literal, so the placement function can be run with the game's own enum rather than with strings this package guessed",
  candidates(context) {
    const requested = new Set<string>();
    for (const record of Object.values(context.tables.plants ?? {})) {
      for (const part of [record.plant, record.seed, record.crop]) {
        if (part?.harvestType != null) requested.add(part.harvestType);
      }
    }
    const found: TableCandidate<ArtTables['harvestTypes']>[] = [];
    for (const chunk of context.chunks) {
      const members: Record<string, string> = {};
      let assigned = 0;
      let conflicting = 0;
      const spans: { start: number; end: number }[] = [];
      for (const member of [...requested].sort()) {
        const values = enumAssignments(chunk, member);
        if (values.length === 0) continue;
        assigned += 1;
        const literals = new Set(values.map((value) => asString(value)?.text ?? ''));
        if (literals.size > 1) conflicting += 1;
        members[member] = [...literals][0] ?? '';
      }
      for (const assignment of chunk.assignments) {
        if (requested.has(assignment.path.at(-1) ?? ''))
          spans.push({ start: assignment.start, end: assignment.end });
      }
      if (assigned === 0 && requested.size > 0) continue;
      // The declarations the assignments were written inside: a fixture cut from the bundle has to keep them.
      const support = [
        ...new Set(
          chunk.declarations
            .filter((declaration) =>
              spans.some((span) => declaration.start <= span.start && declaration.end >= span.end),
            )
            .map((declaration) => declaration.name),
        ),
      ].sort();
      found.push({
        id: 'harvestTypes',
        support,
        predicate: harvestTypeEnum.predicate,
        looksFor: harvestTypeEnum.looksFor,
        invariant: harvestTypeEnum.invariant,
        chunk: chunk.file,
        declaration: null,
        start: spans.length === 0 ? 0 : Math.min(...spans.map((span) => span.start)),
        end: spans.length === 0 ? 0 : Math.max(...spans.map((span) => span.end)),
        coverage: {
          counts: {
            membersRequestedByThePlantTable: requested.size,
            membersAssignedInThisChunk: assigned,
            membersWithConflictingLiterals: conflicting,
          },
          notes:
            requested.size === 0
              ? ['the plant table states harvest types as literals, so there is no enum to read']
              : [],
        },
        value: members,
      });
    }
    return found;
  },
  violations(candidate) {
    const problems: string[] = [];
    const counts = candidate.coverage.counts;
    if ((counts['membersAssignedInThisChunk'] ?? 0) < (counts['membersRequestedByThePlantTable'] ?? 0)) {
      problems.push(
        `${counts['membersAssignedInThisChunk'] ?? 0} of ${counts['membersRequestedByThePlantTable'] ?? 0} harvest members are assigned a literal`,
      );
    }
    if ((counts['membersWithConflictingLiterals'] ?? 0) > 0) {
      problems.push(`${counts['membersWithConflictingLiterals'] ?? 0} members have two different literals`);
    }
    return problems;
  },
};

const scaleCap: TablePredicate<ArtTables['scale']> = {
  id: 'scale',
  predicate: 'scale-cap',
  looksFor:
    'the formula Math.min(<a declared constant>, <something> / <tile>), with the constant a fractional literal, and the tall-decal multiplier as the consequent of a `? <constant> : 1` inside the code that reads the mutation art table',
  invariant:
    'the formula occurs exactly once in the chunk that declares the constant, the constant is a fraction, the divisor is the reference tile, and the tall-decal multiplier is found exactly once and is greater than one',
  candidates(context) {
    const found: TableCandidate<ArtTables['scale']>[] = [];
    const motionChunk = context.declarations.mutationArt ?? null;
    for (const chunk of context.chunks) {
      const occurrences = [
        ...chunk.text.matchAll(/Math\.min\(\s*([A-Za-z_$][\w$]*)\s*,\s*[^()]*?\/\s*(\d+)(?:\.\d+)?\s*\)/g),
      ];
      if (occurrences.length === 0) continue;
      for (const occurrence of occurrences) {
        const capName = occurrence[1] ?? '';
        const tile = occurrence[2] ?? '';
        const declaration = declarationNamed(chunk, capName);
        const cap = declaration?.value?.kind === 'number' ? declaration.value.value : null;
        // The tall-decal multiplier: `(tall ? 2 : 1)` in the function that places mutation icons.
        const scoped = context.chunks.filter((candidate) =>
          motionChunk === null
            ? candidate === chunk
            : candidate.declarations.some((d) => d.name === motionChunk),
        );
        const tallCandidates = new Set<string>();
        const tallFunctions = new Set<string>();
        for (const scope of scoped) {
          for (const fn of scope.functions) {
            // Only the functions that read the mutation art table: the multiplier of a tall decal lives in
            // the code that places mutation icons, and a `? x : 1` anywhere else is a different constant.
            if (motionChunk !== null && !fn.text.includes(motionChunk)) continue;
            for (const match of fn.text.matchAll(/([A-Za-z_$][\w$]*)\s*\?\s*([A-Za-z_$][\w$]*)\s*:\s*1\b/g)) {
              const multiplier = match[2] ?? '';
              const declared = declarationNamed(scope, multiplier);
              if (declared?.value?.kind === 'number' && declared.value.value > 1) {
                tallCandidates.add(multiplier);
                if (fn.name !== null) tallFunctions.add(fn.name);
              }
            }
          }
        }
        const multiplier = [...tallCandidates][0] ?? '';
        const multiplierDeclaration = declarationNamed(chunk, multiplier);
        const tallDecalMultiplier =
          multiplierDeclaration?.value?.kind === 'number' ? multiplierDeclaration.value.value : null;
        found.push({
          id: 'scale',
          support: [...new Set([multiplier, ...tallFunctions].filter((name) => name !== ''))].sort(),
          predicate: scaleCap.predicate,
          looksFor: scaleCap.looksFor,
          invariant: scaleCap.invariant,
          chunk: chunk.file,
          declaration: capName,
          start: declaration?.valueStart ?? 0,
          end: declaration?.valueEnd ?? 0,
          coverage: {
            counts: {
              // Both counts are about the accepted table's own text, never about how much chunk was searched:
              // the committed evidence must be identical whether it came from the game's chunk or from the
              // trimmed fixture that stands in for it.
              capFormulaOccurrences: occurrences.length,
              capConstantDeclared: declaration === null ? 0 : 1,
              tallDecalCandidates: tallCandidates.size,
            },
            notes: [
              `formula as written: ${occurrence[0]}`,
              cap === null ? 'the first argument is not a declared numeric constant' : `cap constant: ${cap}`,
              trimOrNull(tallDecalMultiplier) === null
                ? 'no tall-decal multiplier found'
                : `tall-decal multiplier: ${tallDecalMultiplier}`,
            ],
          },
          value: {
            cap: cap ?? Number.NaN,
            referenceTilePx: Number(tile),
            tallDecalMultiplier: tallDecalMultiplier ?? Number.NaN,
          },
        });
      }
    }
    return found;
  },
  violations(candidate) {
    const problems: string[] = [];
    const counts = candidate.coverage.counts;
    if ((counts['capFormulaOccurrences'] ?? 0) !== 1) {
      problems.push(`the cap formula occurs ${counts['capFormulaOccurrences'] ?? 0} times in the chunk`);
    }
    if ((counts['capConstantDeclared'] ?? 0) !== 1)
      problems.push('the cap constant is not a declared numeric literal');
    if (!(candidate.value.cap > 0 && candidate.value.cap <= 1)) {
      problems.push(`the cap ${candidate.value.cap} is not a fraction`);
    }
    if (!(candidate.value.referenceTilePx > 0)) problems.push('the divisor is not a tile size');
    if ((counts['tallDecalCandidates'] ?? 0) !== 1) {
      problems.push(`${counts['tallDecalCandidates'] ?? 0} tall-decal multipliers were found, not one`);
    }
    if (!(candidate.value.tallDecalMultiplier > 1))
      problems.push('the tall-decal multiplier is not greater than one');
    return problems;
  },
};

const mutationOverSet: TablePredicate<ArtTables['overMutations']> = {
  id: 'overMutations',
  predicate: 'mutation-over-set',
  looksFor:
    'a declared `new Set([...])` of string literals, read inside a function that also reads the mutation art table, which is the set the game tests to give a mutation icon a z-index above the crop',
  invariant:
    'every member is a key of the mutation art table and the set is used beside that table, so a set of anything else is refused',
  candidates(context) {
    const found: TableCandidate<ArtTables['overMutations']>[] = [];
    const art = context.tables.mutationArt ?? {};
    const artName = context.declarations.mutationArt ?? null;
    for (const chunk of context.chunks) {
      const usedBeside = chunk.functions.filter(
        (fn) => artName !== null && fn.text.includes(artName) && fn.text.includes('.has('),
      );
      const usedBesideTheTable = usedBeside.length > 0;
      for (const declaration of chunk.declarations) {
        const value = declaration.value;
        if (value === null || value.kind !== 'call' || !value.construct) continue;
        if (!/(^|\.)Set$/.test(value.callee)) continue;
        const items = value.args[0];
        if (items === undefined || items.kind !== 'array' || items.items.length === 0) continue;
        const members = items.items.map((item) => asString(item)?.text ?? '');
        if (members.some((member) => member === '')) continue;
        const matched = members.filter((member) => Object.hasOwn(art, member));
        found.push({
          id: 'overMutations',
          support: [
            ...new Set(usedBeside.map((fn) => fn.name).filter((name): name is string => name !== null)),
          ].sort(),
          predicate: mutationOverSet.predicate,
          looksFor: mutationOverSet.looksFor,
          invariant: mutationOverSet.invariant,
          chunk: chunk.file,
          declaration: declaration.name,
          start: declaration.valueStart,
          end: declaration.valueEnd,
          coverage: {
            counts: {
              members: members.length,
              membersThatAreMutationArtKeys: matched.length,
              setUsedBesideTheMutationArtTable: usedBesideTheTable ? 1 : 0,
            },
            notes: [`members: ${members.join(', ')}`],
          },
          value: members,
        });
      }
    }
    return found;
  },
  violations(candidate) {
    const problems: string[] = [];
    const counts = candidate.coverage.counts;
    if ((counts['members'] ?? 0) === 0) problems.push('the set is empty');
    if ((counts['membersThatAreMutationArtKeys'] ?? 0) !== (counts['members'] ?? -1)) {
      problems.push(
        `${counts['membersThatAreMutationArtKeys'] ?? 0} of ${counts['members'] ?? 0} members are mutation art keys`,
      );
    }
    if ((counts['setUsedBesideTheMutationArtTable'] ?? 0) !== 1) {
      problems.push('the set is not read in the code that places mutation icons');
    }
    return problems;
  },
};

const placementFunction: TablePredicate<ArtTables['placement']> = {
  id: 'placement',
  predicate: 'placement-function',
  looksFor:
    'a function that divides by the reference tile and closes over the anchor table and the cap: every other function dividing by the tile is a candidate and this closure is what accepts one',
  invariant:
    "exactly one function divides by the tile and closes over the anchors and the cap; every other name it reads is a host global or a table this extractor found, with the role read from how the function uses the name; and it returns an offset and a scale factor, which is the game's own name for what a placement is",
  candidates(context) {
    const found: TableCandidate<ArtTables['placement']>[] = [];
    const tile = context.tables.scale?.referenceTilePx;
    const anchors = context.declarations.anchors;
    const cap = context.declarations.scale;
    if (tile === undefined || anchors === null || anchors === undefined || cap === undefined) return found;
    const harvestMembers = new Set<string>();
    for (const record of Object.values(context.tables.plants ?? {})) {
      for (const part of [record.plant, record.seed, record.crop]) {
        if (part?.harvestType != null) harvestMembers.add(part.harvestType);
      }
    }
    for (const chunk of context.chunks) {
      const dividers = chunk.functions.filter((fn) => new RegExp(`/\\s*${tile}\\b`).test(fn.text));
      for (const fn of dividers) {
        if (!fn.free.includes(anchors) || !fn.free.includes(cap)) {
          // A function that divides by the tile but closes over something else: it is reported rather than
          // dropped, because "two functions divide by the tile and neither closes over the anchors" is the
          // failure message somebody needs. Its counts are chunk-scoped and never reach the data file.
          found.push({
            id: 'placement',
            support: [],
            predicate: placementFunction.predicate,
            looksFor: placementFunction.looksFor,
            invariant: placementFunction.invariant,
            chunk: chunk.file,
            declaration: fn.name,
            start: fn.start,
            end: fn.end,
            coverage: {
              counts: {
                functionsDividingByTheTile: dividers.length,
                closesOverTheAnchorsAndTheCap: 0,
              },
              notes: [`free names: ${fn.free.join(', ')}`],
            },
            value: { name: fn.name, source: fn.text, declarations: {}, externals: [], characters: 0 },
          });
          continue;
        }
        const declarations: Record<string, string> = {};
        const externals: { name: string; role: PlacementExternal['role']; from: string | null }[] = [];
        const unresolved: string[] = [];
        for (const name of fn.free) {
          const text = declarationText(chunk, name);
          if (text !== null) {
            declarations[name] = text;
            continue;
          }
          if (HOST_GLOBALS.has(name)) {
            externals.push({ name, role: 'host', from: null });
            continue;
          }
          const imported = chunk.imports.find((entry) => entry.local === name)?.from ?? null;
          // The role is read from how the function uses the name: a property it reads by a harvest member's
          // own name is the enum, and a table it indexes with one of its own parameters is the plants.
          const isEnum = [...harvestMembers].some((member) => fn.text.includes(`${name}.${member}`));
          const role = isEnum
            ? 'harvestTypes'
            : fn.parameters.some((parameter) => fn.text.includes(`${name}[${parameter}]`))
              ? 'plants'
              : 'unresolved';
          if (role === 'unresolved') unresolved.push(name);
          externals.push({ name, role, from: imported });
        }
        const characters = [...Object.values(declarations), fn.text].join('\n').length;
        const returnsAnOffset = /offset\s*:/.test(fn.text) && /scaleFactor\s*:/.test(fn.text);
        found.push({
          id: 'placement',
          support: Object.keys(declarations).sort(),
          predicate: placementFunction.predicate,
          looksFor: placementFunction.looksFor,
          invariant: placementFunction.invariant,
          chunk: chunk.file,
          declaration: fn.name,
          start: fn.start,
          end: fn.end,
          coverage: {
            counts: {
              // Deliberately not "how many functions divide by the tile": that is a fact about the whole
              // chunk, and the committed evidence has to be the same whether it was read from the game's
              // chunk or from the trimmed fixture that stands in for it. The chunk-scoped counts live on the
              // rejected candidates above, which only ever appear in a failure message.
              closesOverTheAnchorsAndTheCap: 1,
              chunkLocalDeclarationsInTheClosure: Object.keys(declarations).length,
              externals: externals.length,
              unresolvedExternals: unresolved.length,
              returnsAnOffsetAndAScaleFactor: returnsAnOffset ? 1 : 0,
              characters,
            },
            notes: [
              `free names: ${fn.free.join(', ')}`,
              `externals: ${externals.map((external) => `${external.name}=${external.role}`).join(', ')}`,
              unresolved.length === 0 ? '' : `unresolved: ${unresolved.join(', ')}`,
            ].filter((note) => note !== ''),
          },
          value: {
            name: fn.name,
            source: fn.text,
            declarations,
            externals,
            characters,
          },
        });
      }
    }
    return found;
  },
  violations(candidate) {
    const problems: string[] = [];
    const counts = candidate.coverage.counts;
    if ((counts['closesOverTheAnchorsAndTheCap'] ?? 0) !== 1) {
      problems.push('the function does not close over the anchor table and the cap');
    }
    if ((counts['chunkLocalDeclarationsInTheClosure'] ?? 0) === 0) {
      problems.push('the closure holds no chunk-local declaration');
    }
    if ((counts['unresolvedExternals'] ?? 0) > 0) {
      problems.push(`unresolved names: ${candidate.coverage.notes?.at(-1) ?? ''}`);
    }
    if ((counts['returnsAnOffsetAndAScaleFactor'] ?? 0) !== 1) {
      problems.push('the function does not return an offset and a scale factor');
    }
    return problems;
  },
};

/** Every predicate, in the order the extraction runs them: each stage may read the ones before it. */
export const PREDICATES = [
  spriteNameTable,
  mutationRecordTable,
  mutationArtTable,
  displayFlagTable,
  plantTable,
  harvestTypeEnum,
  anchorTable,
  scaleCap,
  mutationOverSet,
  placementFunction,
] as unknown as readonly TablePredicate<never>[];

/** `null` for a number that is not a number, so a note can say so rather than print `NaN`. */
function trimOrNull(value: number | null): number | null {
  return value === null || Number.isNaN(value) ? null : value;
}
