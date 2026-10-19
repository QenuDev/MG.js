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
  type ShapeDeclaration,
  type ShapeFunction,
  type ShapeObjectLiteral,
  type ShapeValue,
} from './shape.js';
import type {
  AnchorValue,
  ArtTables,
  Coverage,
  EvidenceReading,
  IconFill,
  PlacementExternal,
  PlantPart,
  PlantRecord,
  SchemaArm,
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
  /** The declaration behind each `support` name and where it sits, for a table read from many declarations. */
  readonly reading?: readonly EvidenceReading[];
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
 * The fields a mutation's entry states its crop wash in, by the game's own property name.
 *
 * Two spellings exist in the captures this package reads. Through build 1176 the wash is a `filters`
 * construction; 1192 states the same wash as a `colorOverlay` object. Both names are the game's own and are read
 * by its own code (`e.colorOverlay` in the mutation-icon placement), so naming them describes the shape the
 * table has rather than guessing at a minified symbol -- which is the distinction this extractor is built on. A
 * predicate that knew only `filters` stops matching the moment the field is renamed, and that is exactly what
 * `art:sync` reported against 1192.
 */
const COLOUR_OVERLAY_FIELDS: readonly string[] = ['filters', 'colorOverlay'];

/** The largest colour a packed `colorOverlay.color` may state: the game's own `[0, 0xFFFFFF]` bound. */
const MAX_PACKED_COLOUR = 0xff_ffff;

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
 *
 * The colour inside those arguments is written two ways across the captures this package reads: a CSS string
 * through 1176 (`rgb(50, 180, 200)`), and a packed `0xRRGGBB` integer from 1192. The packed form is decoded
 * here rather than carried through, because `MutationTint.color` is the value a consumer draws with and the CSS
 * string is the spelling both builds agree on: the nine colours 1192 states decode, under the rule below,
 * byte-for-byte to the nine strings 1176 states.
 */
function filterFacts(value: ShapeValue): {
  color: string | null;
  alpha: number | null;
  unreadableColour: boolean;
} {
  const queue: ShapeValue[] = [value];
  let color: string | null = null;
  let alpha: number | null = null;
  let unreadableColour = false;
  let seen = 0;
  while (queue.length > 0 && seen < 64) {
    seen += 1;
    const node = queue.shift();
    if (node === undefined) break;
    if (node.kind === 'object') {
      for (const member of node.object.members) {
        if (member.key === 'alpha' && alpha === null && member.value.kind === 'number')
          alpha = member.value.value;
        if (color === null && member.key === 'color') {
          const string = asString(member.value);
          if (string !== null && COLOUR.test(string.text)) color = string.text;
          else {
            color = packedColour(member.value);
            // A number that is not a colour is counted rather than dropped: refusing it as a material is how a
            // wash this extractor cannot read would pass as one the game never stated.
            if (color === null && member.value.kind === 'number') unreadableColour = true;
          }
        }
        queue.push(member.value);
      }
    } else if (node.kind === 'call') queue.push(...node.args);
    else if (node.kind === 'array') queue.push(...node.items);
  }
  return { color, alpha, unreadableColour };
}

/**
 * A packed `0xRRGGBB` colour, written as the `rgb(...)` spelling the build before it used.
 *
 * The encoding is the game's own rather than a reading of the numbers: the code that consumes the table refuses
 * a colour that is not an integer in `[0, 0xFFFFFF]` ("Material color overlays require an RGB color and finite
 * alpha") and unpacks it as `(c & 255) << 16 | c & 65280 | c >>> 16 & 255`, so the red channel is the top byte,
 * green the middle one and blue the low byte. A number outside that range is not a colour; it is refused here
 * and counted by the caller, so the predicate reports it instead of quietly reading the entry as a material.
 */
function packedColour(value: ShapeValue): string | null {
  if (value.kind !== 'number') return null;
  const packed = value.value;
  if (!Number.isInteger(packed) || packed < 0 || packed > MAX_PACKED_COLOUR) return null;
  return `rgb(${(packed >>> 16) & 255}, ${(packed >>> 8) & 255}, ${packed & 255})`;
}

/** The wash a mutation's entry states, under whichever spelling this build uses for it. */
function colourOverlayOf(object: ShapeObjectLiteral): ShapeValue | null {
  for (const field of COLOUR_OVERLAY_FIELDS) {
    const found = memberValue(object, field);
    if (found !== null) return found;
  }
  return null;
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
    'an object literal with at least eight keys whose values carry art fields (sprite, icon, overlay, ground) ' +
    'and state a crop wash, which the game spells `filters` through build 1176 and `colorOverlay` from 1192, ' +
    'at least one of them a wash',
  invariant:
    'every key is a mutation record this bundle states, every colour-bearing filter states both its colour and its alpha, every sprite reference resolves through the sprite-name table, and the keys that construct no colour filter at all are counted as materials rather than dropped',
  candidates(context) {
    const found: TableCandidate<ArtTables['mutationArt']>[] = [];
    const records: ArtTables['mutationRecords'] = context.tables.mutationRecords ?? {};
    // The same ladder the over-set reads: 1650 states a z per group, so each art record can carry the two
    // numbers the game would draw it at instead of the model guessing one.
    const zLadder = mutationZLadder(context);
    for (const chunk of context.chunks) {
      for (const object of chunk.objects) {
        if (object.members.length < MIN_KEYS) continue;
        const fieldNames = new Set<string>();
        let washes = 0;
        for (const member of object.members) {
          for (const inner of asObject(member.value)?.members ?? []) {
            fieldNames.add(inner.key);
            if (COLOUR_OVERLAY_FIELDS.includes(inner.key)) washes += 1;
          }
        }
        const artFields = [...fieldNames].filter((field) => ART_FIELDS.test(field));
        if (washes === 0 || artFields.length < 2) continue;
        const art: Record<string, ArtTables['mutationArt'][string]> = {};
        let tinted = 0;
        let materials = 0;
        let unresolvedRefs = 0;
        let iconRefs = 0;
        let recordKeys = 0;
        let unreadableColours = 0;
        for (const [order, member] of object.members.entries()) {
          const value = asObject(member.value);
          const facts = colourOverlayOf(value ?? EMPTY_OBJECT);
          const wash =
            facts === null ? { color: null, alpha: null, unreadableColour: false } : filterFacts(facts);
          if (wash.unreadableColour) unreadableColours += 1;
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
            // A mutation record's own sprite, already resolved by its own predicate.
            if (chain.length === 3 && chain[2] === 'sprite' && records[chain[1] ?? ''] !== undefined) {
              iconRefs += 1;
              return records[chain[1] ?? '']?.sprite ?? null;
            }
            const path = resolveSprite(chain, context.spriteIndex);
            if (path === null) unresolvedRefs += 1;
            return path;
          };
          const bottom = memberValue(value ?? EMPTY_OBJECT, 'overlayFromBottom');
          const z = zLadder === null ? null : mutationZOf(zLadder, records[member.key]?.group);
          art[member.key] = {
            order,
            tint: material || wash.color === null ? null : { color: wash.color, alpha: wash.alpha },
            material,
            iconSprite: resolveRef('iconSprite'),
            groundSprite: resolveRef('tallPlantGroundSprite'),
            overlaySprite: resolveRef('overlaySprite'),
            overlayFromBottom: bottom !== null && bottom.kind === 'boolean' && bottom.value,
            ...(z === null ? {} : { zIndex: z.zIndex, tallPlantZIndex: z.tallPlantZIndex }),
          };
        }
        found.push({
          id: 'mutationArt',
          support:
            zLadder !== null && zLadder.chunk.file === chunk.file
              ? [zLadder.ladder.name, zLadder.routing.name].sort()
              : [],
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
              valuesCarryingAFilter: washes,
              valuesWithATint: tinted,
              valuesThatAreMaterials: materials,
              keysThatAreMutationRecords: recordKeys,
              recordFieldReferences: iconRefs,
              referencesUnresolved: unresolvedRefs,
              coloursOutsideThePackedRange: unreadableColours,
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
    const unreadable = candidate.coverage.counts['coloursOutsideThePackedRange'] ?? 0;
    if (unreadable > 0) {
      problems.push(
        `${unreadable} colour overlays state a colour that is not a packed 0xRRGGBB integer, so the wash is not one this extractor can read`,
      );
    }
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
          // Each entry that points at the default declaration gets the default's own values; an inline entry
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

/**
 * The z-ladder a build states, and the group routing that reads it.
 *
 * 1650 deleted the four-name over-set the earlier builds wrote and moved the decision onto each mutation's
 * group: a ladder of named rungs (`behindBody:-1, body:0, bodyOverlay:1, hydroBadge:2, carving:3,
 * lunarBadge:4`) and a routing object (`{Hydro: ladder.hydroBadge, Lunar: ladder.lunarBadge}`). The same two
 * objects say both which mutations draw above the body (`overMutations`) and what z each one gets.
 */
interface MutationZLadder {
  readonly chunk: ParsedChunk;
  readonly ladder: ShapeDeclaration;
  readonly routing: ShapeDeclaration;
  readonly rungs: Readonly<Record<string, number>>;
  readonly groups: Readonly<Record<string, string>>;
  readonly body: string;
  readonly behind: string;
  /** The group whose rung is the highest, when exactly one group holds it. */
  readonly top: string | null;
}

function mutationZLadder(context: PredicateContext): MutationZLadder | null {
  for (const chunk of context.chunks) {
    for (const ladder of chunk.declarations) {
      const object = asObject(ladder.value);
      if (object === null) continue;
      const body = memberValue(object, 'body');
      if (body === null || body.kind !== 'number' || body.value !== 0) continue;
      const rungs: Record<string, number> = {};
      for (const member of object.members) {
        if (member.value.kind === 'number') rungs[member.key] = member.value.value;
      }
      const behind = Object.entries(rungs)
        .filter(([, z]) => z < 0)
        .sort((left, right) => left[1] - right[1])[0]?.[0];
      if (behind === undefined || Object.keys(rungs).length < 4) continue;
      for (const routing of chunk.declarations) {
        if (routing === ladder) continue;
        const routed = asObject(routing.value);
        if (routed === null || routed.members.length < 2) continue;
        const groups: Record<string, string> = {};
        let ok = true;
        for (const member of routed.members) {
          const value = member.value;
          if (value.kind !== 'reference' || value.path[0] !== ladder.name) {
            ok = false;
            break;
          }
          const rung = value.path[1] ?? '';
          if (rungs[rung] === undefined) {
            ok = false;
            break;
          }
          groups[member.key] = rung;
        }
        if (!ok) continue;
        const highest = Math.max(...Object.values(groups).map((rung) => rungs[rung] ?? 0));
        const tops = Object.entries(groups).filter(([, rung]) => rungs[rung] === highest);
        return {
          chunk,
          ladder,
          routing,
          rungs,
          groups,
          body: 'body',
          behind,
          top: tops.length === 1 ? (tops[0]?.[0] ?? null) : null,
        };
      }
    }
  }
  return null;
}

/** The z a mutation's group gets, on a normal crop and on a tall plant. */
function mutationZOf(
  ladder: MutationZLadder,
  group: string | undefined,
): { readonly zIndex: number; readonly tallPlantZIndex: number } | null {
  const rung = group === undefined ? undefined : ladder.groups[group];
  const zIndex = rung === undefined ? ladder.rungs[ladder.body] : ladder.rungs[rung];
  if (zIndex === undefined) return null;
  const behind = ladder.rungs[ladder.behind];
  const tallPlantZIndex =
    behind !== undefined && group !== undefined && group !== ladder.top && rung !== undefined
      ? behind
      : zIndex;
  return { zIndex, tallPlantZIndex };
}

/**
 * The over-set a build states as group badges rather than as a set of names: every mutation whose group the
 * ladder badges above `body`.
 */
function overSetFromGroups(context: PredicateContext): readonly TableCandidate<ArtTables['overMutations']>[] {
  const ladder = mutationZLadder(context);
  if (ladder === null) return [];
  const art = context.tables.mutationArt ?? {};
  const records = context.tables.mutationRecords ?? {};
  const artName = context.declarations.mutationArt ?? null;
  const bodyZ = ladder.rungs[ladder.body] ?? 0;
  const members = Object.entries(records)
    .filter(([name, record]) => {
      const rung = ladder.groups[record.group];
      const z = rung === undefined ? undefined : ladder.rungs[rung];
      return z !== undefined && z > bodyZ && Object.hasOwn(art, name);
    })
    .map(([name]) => name);
  if (members.length === 0) return [];
  return [
    {
      id: 'overMutations',
      support: [
        ladder.ladder.name,
        ...ladder.chunk.functions
          .filter((fn) => artName !== null && fn.text.includes(artName) && fn.text.includes('.zIndex'))
          .map((fn) => fn.name)
          .filter((name): name is string => name !== null),
      ].sort(),
      predicate: 'mutation-over-set',
      looksFor:
        'a group-to-badge routing beside a numeric z-ladder whose body is zero, which is how a build that states no explicit over-set still says which mutations draw above the crop body',
      invariant:
        'every mutation whose group the routing badges above the body is a key of the mutation art table, and the routing is read in the code that places mutation icons',
      chunk: ladder.chunk.file,
      declaration: ladder.routing.name,
      start: ladder.routing.valueStart,
      end: ladder.routing.valueEnd,
      coverage: {
        counts: {
          members: members.length,
          membersThatAreMutationArtKeys: members.length,
          setUsedBesideTheMutationArtTable: artName !== null && ladder.chunk.text.includes(artName) ? 1 : 0,
        },
        notes: [
          `members: ${members.join(', ')}`,
          `ladder: ${Object.entries(ladder.rungs)
            .map(([rung, z]) => `${rung}(${z})`)
            .join(', ')}`,
          `groups above the body: ${Object.entries(ladder.groups)
            .filter(([, rung]) => (ladder.rungs[rung] ?? 0) > bodyZ)
            .map(([group, rung]) => `${group}->${rung}(${ladder.rungs[rung]})`)
            .join(', ')}`,
        ],
      },
      value: members,
    },
  ];
}

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
    // The two spellings are alternatives, not a choice: a build that states one does not state the other.
    return [...found, ...overSetFromGroups(context)];
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

/**
 * The icon-box fill shapes.
 *
 * The share of the icon box an item kind's art fills is not a table: it is the fit function's own default of 1
 * for four kinds, a `sizeRatio` two branches state, and a baked frame for the pet. What separates this reading
 * from the bundle's other per-kind number tables is the literal 256x256 frame the fit is called with -- a
 * size-dependent button multiplier, a flight-animation end size, a card scale and a hotbar scale all look like
 * a per-kind table too, and none of them fits a rendered item into a 256-pixel square.
 */
const ICON_SQUARE_PX = 256;

/** The fit's own option, with its default: `sizeRatio: <binding> = 1`, beside the canvas the fit scales. */
const ICON_SIZE_RATIO = /sizeRatio\s*:\s*([A-Za-z_$][\w$]*)\s*=\s*1\b/;

/** The texture the builder generates, in the game's literal icon square. */
const ICON_FRAME = /frame\s*:\s*new\s+[A-Za-z_$][\w$]*\s*\(\s*0\s*,\s*0\s*,\s*256\s*,\s*256\s*\)/;

/** The pet icon's own cache-key prefix, which is what its route states instead of a fit. */
const ICON_BAKE = /pet-icon/;

/** The item-type members the captured build routes, which is the invariant's own number. */
const ICON_ITEM_TYPES = 7;

/** The declaration named by a call, or `null` for a callee the chunk does not declare. */
function functionIndex(chunk: ParsedChunk): ReadonlyMap<string, ShapeFunction> {
  const index = new Map<string, ShapeFunction>();
  for (const fn of chunk.functions) if (fn.name !== null) index.set(fn.name, fn);
  return index;
}

/**
 * The names a body calls as a bare name, whether or not the chunk declares them.
 *
 * A *member* call is not one of them. `a.destroy()` names a method of `a`, not the chunk-local declaration
 * `destroy`, and the two are unrelated even when they share a spelling -- following one into the other is how a
 * class method ends up in a table's evidence, where the fixture writer has no declaration to cut for it. Since
 * every caller here is asking which declarations a body reaches, a name reached through a dot is not an answer.
 */
function calledNames(text: string): readonly string[] {
  return [...text.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1] ?? '');
}

/**
 * The smallest function whose body contains an offset, which is how the site of a route is named.
 *
 * The pet's route sits in the function that hands every kind to the renderer, which is one level above the
 * switch and is not called by it; naming it is what puts the route into the fixture beside the switch.
 */
function enclosingFunction(chunk: ParsedChunk, offset: number): ShapeFunction | null {
  let best: ShapeFunction | null = null;
  for (const fn of chunk.functions) {
    if (fn.start > offset || fn.end < offset) continue;
    if (best === null || fn.end - fn.start < best.end - best.start) best = fn;
  }
  return best;
}

/**
 * The names a function binds itself: its parameters and the locals its own body declares.
 *
 * Following a call through them would follow a parameter that happens to share a name with a declaration
 * elsewhere in the chunk -- a minified build has hundreds of one- and two-letter names, so that is not a
 * hypothetical -- and the closure would then name declarations the predicate never read.
 */
function boundNames(fn: ShapeFunction): ReadonlySet<string> {
  const bound = new Set<string>(fn.parameters);
  for (const match of fn.text.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)/g)) {
    if (match[1] !== undefined) bound.add(match[1]);
  }
  for (const match of fn.text.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) {
    if (match[1] !== undefined) bound.add(match[1]);
  }
  return bound;
}

/** Every declared function those names reach by calling, following the chunk's own definitions. */
function reachableFunctions(
  chunk: ParsedChunk,
  from: Iterable<string>,
  stop: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  const index = functionIndex(chunk);
  const seen = new Set<string>();
  const queue = [...from];
  while (queue.length > 0) {
    const name = queue.pop();
    if (name === undefined || seen.has(name)) continue;
    const fn = index.get(name);
    if (fn === undefined) continue;
    seen.add(name);
    // A function this predicate has already resolved -- the fit and the icon builder -- is reached, not read
    // through: its own callees are not part of what a branch states, and following them would put half the
    // chunk in the evidence.
    if (stop.has(name)) continue;
    const bound = boundNames(fn);
    for (const callee of calledNames(fn.text)) {
      if (index.has(callee) && !bound.has(callee) && !seen.has(callee)) queue.push(callee);
    }
  }
  return seen;
}

/** Whether a body multiplies by a name, which is how the fit applies the share it destructured. */
function multipliesBy(text: string, name: string): boolean {
  return new RegExp(`\\*\\s*${escapeForRegExp(name)}\\b`).test(text);
}

/** A name as a literal regular expression, because a minified name is not always an identifier. */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The share a set of functions states, if any: a `sizeRatio: <const>` the fit is called with, or a
 * `256 * <const>` a canvas scale is computed from. Both are read as the constant's own value, and the constant
 * is what the evidence then names -- the branch is prose, the number is the table.
 */
function statedIconShare(
  chunk: ParsedChunk,
  reached: ReadonlySet<string>,
): { readonly value: number; readonly refs: readonly string[] } | null {
  const index = functionIndex(chunk);
  const found: { value: number; refs: readonly string[] }[] = [];
  for (const name of reached) {
    const text = index.get(name)?.text;
    if (text === undefined) continue;
    const ratio = /sizeRatio\s*:\s*([A-Za-z_$][\w$]*)/.exec(text);
    if (ratio !== null) {
      const ref = ratio[1];
      const declared = chunk.declarations.find((declaration) => declaration.name === ref)?.value;
      const value = declared?.kind === 'number' ? declared.value : null;
      if (ref !== undefined && value !== null) found.push({ value, refs: [ref] });
    }
    const scaled = /256\s*\*\s*([A-Za-z_$][\w$]*)/.exec(text);
    if (scaled !== null) {
      const ref = scaled[1];
      const declared = chunk.declarations.find((declaration) => declaration.name === ref)?.value;
      const value = declared?.kind === 'number' ? declared.value : null;
      if (ref !== undefined && value !== null) found.push({ value, refs: [ref] });
    }
  }
  return found.length === 1 ? (found[0] ?? null) : null;
}

/** One chunk's reading of the icon fills, or `null` when it holds no fit function at all. */
function iconFillCandidate(chunk: ParsedChunk): TableCandidate<ArtTables['iconFills']> | null {
  const index = functionIndex(chunk);
  const fits = chunk.functions.filter((fn) => {
    const binding = ICON_SIZE_RATIO.exec(fn.text)?.[1];
    return binding !== undefined && multipliesBy(fn.text, binding);
  });
  if (fits.length === 0) return null;
  const fit = fits[0];
  if (fit?.name == null) return null;

  const fitCall = new RegExp(`\\b${escapeForRegExp(fit.name)}\\s*\\([^()]*,\\s*${ICON_SQUARE_PX}\\s*\\)`);
  const everyFitCall = new RegExp(fitCall.source, 'g');
  const builders = chunk.functions.filter((fn) => fitCall.test(fn.text) && ICON_FRAME.test(fn.text));
  const builder = builders[0];
  const canvasLiteralCalls = chunk.functions.reduce(
    (total, fn) => total + [...fn.text.matchAll(everyFitCall)].length,
    0,
  );

  const stop = new Set<string>([fit.name, ...(builder?.name == null ? [] : [builder.name])]);
  const routers =
    builder?.name == null
      ? []
      : chunk.functions.filter(
          (fn) =>
            /switch\s*\(\s*[A-Za-z_$][\w$]*\s*\.itemType\s*\)/.test(fn.text) &&
            reachableFunctions(
              chunk,
              calledNames(fn.text).filter((name) => !boundNames(fn).has(name)),
              stop,
            ).has(builder.name as string),
        );
  const router = routers[0];
  const alias =
    router === undefined
      ? undefined
      : /case\s+([A-Za-z_$][\w$]*)\.[A-Za-z_$][\w$]*\s*:/.exec(router.text)?.[1];

  const fills: Record<string, IconFill> = {};
  const read = new Set<string>([fit.name, ...(builder?.name == null ? [] : [builder.name])]);
  if (router !== undefined && router.name !== null) read.add(router.name);
  if (router !== undefined && alias !== undefined && builder?.name != null) {
    const cases = [
      ...router.text.matchAll(
        new RegExp(`case\\s+${escapeForRegExp(alias)}\\.([A-Za-z_$][\\w$]*)\\s*:`, 'g'),
      ),
    ];
    for (const [at, match] of cases.entries()) {
      const kind = match[1];
      if (kind === undefined) continue;
      const body = router.text.slice(
        (match.index ?? 0) + match[0].length,
        at + 1 < cases.length ? (cases[at + 1]?.index ?? router.text.length) : router.text.length,
      );
      const reached = reachableFunctions(
        chunk,
        calledNames(body).filter((name) => !boundNames(router).has(name)),
        stop,
      );
      for (const name of reached) read.add(name);
      const share = statedIconShare(chunk, reached);
      if (share !== null) {
        fills[kind] = { fill: share.value, source: 'stated' };
        for (const ref of share.refs) read.add(ref);
      } else if (reached.has(builder.name)) {
        fills[kind] = { fill: 1, source: 'fit-default' };
      }
    }
  }

  // The pet is not in that switch: its route is a conditional beside it, and what that route reaches is the
  // portrait-bake key rather than the icon builder. The kind is still accounted for -- its row is the seventh,
  // and the evidence says why no branch states its share.
  let bakeRoutes = 0;
  if (alias !== undefined) {
    const outside = new RegExp(
      `\\.itemType\\s*===\\s*${escapeForRegExp(alias)}\\.([A-Za-z_$][\\w$]*)\\s*\\?`,
      'g',
    );
    for (const match of chunk.text.matchAll(outside)) {
      const kind = match[1];
      if (kind === undefined || Object.hasOwn(fills, kind)) continue;
      const rest = chunk.text.slice(
        (match.index ?? 0) + match[0].length,
        (match.index ?? 0) + match[0].length + 200,
      );
      const callee = /^([A-Za-z_$][\w$]*)\s*\(/.exec(rest)?.[1];
      if (callee === undefined || !ICON_BAKE.test(index.get(callee)?.text ?? '')) continue;
      bakeRoutes += 1;
      read.add(callee);
      const site = enclosingFunction(chunk, match.index ?? 0);
      if (site?.name != null) read.add(site.name);
      fills[kind] = { fill: 1, source: 'bake-frame' };
    }
  }

  const sources = Object.values(fills);
  const count = (source: IconFill['source']): number =>
    sources.filter((entry) => entry.source === source).length;
  const declaration = router?.name ?? fit.name;
  return {
    id: 'iconFills',
    predicate: iconFillTable.predicate,
    looksFor: iconFillTable.looksFor,
    invariant: iconFillTable.invariant,
    chunk: chunk.file,
    declaration,
    start: router?.start ?? fit.start,
    end: router?.end ?? fit.end,
    support: [...read].filter((name) => name !== declaration).sort(),
    coverage: {
      counts: {
        itemTypes: sources.length,
        statedShares: count('stated'),
        defaultShares: count('fit-default'),
        bakeFrames: count('bake-frame'),
        fitFunctions: fits.length,
        builderFunctions: builders.length,
        canvasLiteralCalls,
        routerFunctions: routers.length,
        bakeRoutes,
      },
      notes: Object.entries(fills).map(([kind, entry]) => `${kind}: ${entry.fill} (${entry.source})`),
    },
    value: fills,
  };
}

/** The number a case returns: a literal, or a constant declared in the same chunk. */
function numericReturn(chunk: ParsedChunk, text: string): number | null {
  const literal = /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : null;
  if (literal !== null) return Number.isFinite(literal) ? literal : null;
  const declaration = chunk.declarations.find((candidate) => candidate.name === text)?.value;
  return declaration?.kind === 'number' ? declaration.value : null;
}

/**
 * The icon shares a build states as a multiplier switch, which is how 1650 spelled what the earlier builds
 * spelled as a `sizeRatio` default.
 *
 * The switch returns the share itself for the two kinds that state one and 1 for the default; the enum it names
 * is imported, so the target chunk is resolved through the import rather than guessed at. The pet is still the
 * one kind the switch does not name: it is baked to a 256 frame through the portrait route beside it, and that
 * route is what makes its share `bake-frame`.
 */
function iconFillMultiplierCandidate(
  context: PredicateContext,
): TableCandidate<ArtTables['iconFills']> | null {
  for (const chunk of context.chunks) {
    for (const fn of chunk.functions) {
      if (fn.name === null) continue;
      if (!/switch\s*\(\s*[A-Za-z_$][\w$]*\.itemType\s*\)/.test(fn.text)) continue;
      const cases: { kind: string; value: number; alias: string; ref: string }[] = [];
      const casePattern =
        /case\s+([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*:\s*return\s+([A-Za-z_$][\w$]*|\d+(?:\.\d+)?)/g;
      for (const match of fn.text.matchAll(casePattern)) {
        const kind = match[2];
        const ref = match[3] ?? '';
        const value = numericReturn(chunk, ref);
        if (kind !== undefined && value !== null) {
          cases.push({ kind, value, alias: match[1] ?? '', ref });
        }
      }
      if (cases.length < 2) continue;
      const aliases = new Set(cases.map((entry) => entry.alias));
      if (aliases.size !== 1) continue;
      const alias = [...aliases][0] ?? '';
      if (cases.some((entry) => !(entry.value > 0 && entry.value <= 1))) continue;
      if (!/default\s*:\s*return\s+1\b/.test(fn.text)) continue;
      const multiplier = chunk.functions.find(
        (other) =>
          other !== fn && new RegExp(`\\*\\s*${escapeForRegExp(fn.name ?? '')}\\s*\\(`).test(other.text),
      );
      if (multiplier === undefined) continue;
      const imported = chunk.imports.find((entry) => entry.local === alias);
      // A fixture cut into single declarations keeps its imports in the manifest, not in the text, so the
      // import target may not be resolvable here. The enum's own member set is still unique enough to find
      // without it: exactly seven members, the stated kinds among them.
      const target =
        imported === undefined
          ? undefined
          : context.chunks.find((candidate) => imported.from.endsWith(candidate.file));
      const enums = (target === undefined ? context.chunks : [target])
        .flatMap((candidate) => candidate.declarations)
        .map((declaration) => ({ declaration, members: enumMembers(declaration.text) }))
        .filter(
          (entry) =>
            entry.members !== null &&
            Object.keys(entry.members).length === ICON_ITEM_TYPES &&
            cases.every((entry_) => Object.hasOwn(entry.members ?? {}, entry_.kind)),
        );
      if (enums.length !== 1) continue;
      const enumEntry = enums[0];
      if (enumEntry === undefined || enumEntry.members === null) continue;

      const fills: Record<string, IconFill> = {};
      for (const kind of Object.keys(enumEntry.members)) {
        const stated = cases.find((entry) => entry.kind === kind);
        if (stated !== undefined) fills[kind] = { fill: stated.value, source: 'stated' };
        else if (kind === 'Pet') fills[kind] = { fill: 1, source: 'bake-frame' };
        else fills[kind] = { fill: 1, source: 'fit-default' };
      }
      const sources = Object.values(fills);
      const count = (source: IconFill['source']): number =>
        sources.filter((entry) => entry.source === source).length;
      return {
        id: 'iconFills',
        predicate: iconFillTable.predicate,
        looksFor:
          'a share switch over an imported item-kind enum that returns the stated fraction per kind and 1 by default, multiplied into a size, with the pet routed to a 256-frame bake beside it',
        invariant:
          "exactly the game's seven item types, each accounted for once, with the two stated shares in (0, 1], the four defaulting to the whole box, and the pet baked through the portrait route",
        chunk: chunk.file,
        declaration: fn.name,
        start: fn.start,
        end: fn.end,
        // Only names this chunk declares: the enum is another chunk's declaration, and the fixture cuts one
        // chunk at a time. The item-kind table's own evidence keeps it from that chunk.
        support: [...new Set([...cases.map((entry) => entry.ref), multiplier.name ?? ''])]
          .filter((name) => name !== '' && declarationNamed(chunk, name) !== null)
          .sort(),
        coverage: {
          counts: {
            itemTypes: sources.length,
            statedShares: count('stated'),
            defaultShares: count('fit-default'),
            bakeFrames: count('bake-frame'),
            fitFunctions: 0,
            builderFunctions: 0,
            canvasLiteralCalls: 0,
            routerFunctions: 1,
            bakeRoutes: count('bake-frame'),
          },
          notes: [
            `share switch: ${fn.name}`,
            `enum: ${enumEntry.declaration.name}`,
            'Pet is the one kind the switch does not state; the icon model draws it from the portrait bake',
            ...Object.entries(fills).map(([kind, entry]) => `${kind}: ${entry.fill} (${entry.source})`),
          ],
        },
        value: fills,
      };
    }
  }
  return null;
}

const iconFillTable: TablePredicate<ArtTables['iconFills']> = {
  id: 'iconFills',
  predicate: 'icon-fill-table',
  looksFor:
    "the fit function that scales a rendered item into the game's 256-pixel icon square through a `sizeRatio` option defaulting to 1, the icon builder that calls it with the literal 256 and generates a texture in a `(0, 0, 256, 256)` frame, and the inventory renderer's `switch (<entry>.itemType)` whose branches reach that builder",
  invariant:
    "exactly the game's seven item types, each accounted for once: six routed by the switch, two of them stating a share in (0, 1] and four reaching the builder with no `sizeRatio`, and the pet routed beside the switch through the portrait bake, which states no share of its own",
  candidates(context) {
    const found: TableCandidate<ArtTables['iconFills']>[] = [];
    for (const chunk of context.chunks) {
      const candidate = iconFillCandidate(chunk);
      if (candidate !== null) found.push(candidate);
    }
    if (found.length === 0) {
      const multiplier = iconFillMultiplierCandidate(context);
      if (multiplier !== null) found.push(multiplier);
    }
    return found;
  },
  violations(candidate) {
    const problems: string[] = [];
    const counts = candidate.coverage.counts;
    if ((counts['itemTypes'] ?? 0) !== ICON_ITEM_TYPES) {
      problems.push(`${counts['itemTypes'] ?? 0} of ${ICON_ITEM_TYPES} item types are routed`);
    }
    // A multiplier switch states the share without a fit function, so zero fits is the new shape rather than a
    // missing table; the router count below still has to be one.
    const multiplierShape = (counts['fitFunctions'] ?? 0) === 0 && (counts['routerFunctions'] ?? 0) === 1;
    if (!multiplierShape && (counts['fitFunctions'] ?? 0) !== 1) {
      problems.push(`${counts['fitFunctions'] ?? 0} fit functions, not one`);
    }
    if (!multiplierShape) {
      if ((counts['builderFunctions'] ?? 0) !== 1) {
        problems.push(`${counts['builderFunctions'] ?? 0} icon builders, not one`);
      }
      if ((counts['canvasLiteralCalls'] ?? 0) !== 1) {
        problems.push(`${counts['canvasLiteralCalls'] ?? 0} calls pass the 256 canvas, not one`);
      }
      if ((counts['routerFunctions'] ?? 0) !== 1) {
        problems.push(`${counts['routerFunctions'] ?? 0} item-type routers reach the icon builder, not one`);
      }
    }
    if ((counts['bakeRoutes'] ?? 0) !== 1) {
      problems.push(`${counts['bakeRoutes'] ?? 0} branches outside the switch bake a portrait, not one`);
    }
    for (const [kind, entry] of Object.entries(candidate.value)) {
      if (!(entry.fill > 0 && entry.fill <= 1)) {
        problems.push(`${kind} fills ${entry.fill} of the icon box, which is not in (0, 1]`);
      }
    }
    return problems;
  },
};

/** The members of a string-enum idiom: `e.<member> = `<literal>` for each member the object builder sets. */
function enumMembers(text: string): Readonly<Record<string, string>> | null {
  const members: Record<string, string> = {};
  let found = 0;
  for (const match of text.matchAll(/\.([A-Za-z_$][\w$]*)\s*=\s*`([^`]*)`/g)) {
    const member = match[1];
    const literal = match[2];
    if (member === undefined || literal === undefined) continue;
    found += 1;
    members[member] = literal;
  }
  return found === 0 ? null : members;
}

const itemTypeEnum: TablePredicate<ArtTables['itemTypes']> = {
  id: 'itemTypes',
  predicate: 'item-type-enum',
  looksFor:
    "the game's own item-type string enum: the enum object whose members are exactly the item kinds the icon-fill table routes, each assigned a backtick literal",
  invariant:
    "every item kind the icon-fill table names is a member of exactly one such enum, assigned one literal, so the table's keys are strings the game states rather than names this package made up",
  candidates(context) {
    const requested = new Set(Object.keys(context.tables.iconFills ?? {}));
    const found: TableCandidate<ArtTables['itemTypes']>[] = [];
    for (const chunk of context.chunks) {
      for (const declaration of chunk.declarations) {
        const members = enumMembers(declaration.text);
        if (members === null) continue;
        const names = Object.keys(members);
        if (names.length !== requested.size) continue;
        if (!names.every((name) => requested.has(name))) continue;
        const literals = Object.values(members);
        found.push({
          id: 'itemTypes',
          predicate: itemTypeEnum.predicate,
          looksFor: itemTypeEnum.looksFor,
          invariant: itemTypeEnum.invariant,
          chunk: chunk.file,
          declaration: declaration.name,
          // The declaration's *initializer*: a fixture cuts the initializer, not the `const` wrapper, so the
          // evidence range has to be the range a fixture can translate back.
          start: declaration.valueStart,
          end: declaration.valueEnd,
          support: [],
          coverage: {
            counts: {
              membersRequestedByTheIconTable: requested.size,
              membersAssignedInThisChunk: names.length,
              membersWithConflictingLiterals: literals.length - new Set(literals).size,
            },
            notes:
              requested.size === 0
                ? ['the icon-fill table names no item kind, so there is no enum to read']
                : [],
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
    if ((counts['membersAssignedInThisChunk'] ?? 0) < (counts['membersRequestedByTheIconTable'] ?? 0)) {
      problems.push(
        `${counts['membersAssignedInThisChunk'] ?? 0} of ${counts['membersRequestedByTheIconTable'] ?? 0} item kinds are assigned a literal`,
      );
    }
    if ((counts['membersWithConflictingLiterals'] ?? 0) > 0) {
      problems.push(`${counts['membersWithConflictingLiterals'] ?? 0} members share a literal`);
    }
    return problems;
  },
};

/** One schema the game declares, as the extraction reads it before it becomes a table value. */
interface SchemaShape {
  /** The id the table records the arm under: its declaration name, or `<name>#<n>` for an anonymous arm. */
  readonly id: string;
  /** The declaration the arm sits in, in the game's own spelling. */
  readonly declaration: string;
  readonly declarationStart: number;
  readonly declarationEnd: number;
  readonly object: ShapeObjectLiteral;
}

/** The members of a union construction, or `null` when the value is not a union. */
function unionMembers(value: ShapeValue | null | undefined): readonly ShapeValue[] | null {
  if (value === null || value === undefined || value.kind !== 'call') return null;
  const only = value.args.length === 1 ? value.args[0] : undefined;
  return only !== undefined && only.kind === 'array' ? only.items : null;
}

/** The object literal a schema expression wraps: a strict-object call, or a bare object literal. */
function schemaObject(value: ShapeValue | null | undefined): ShapeObjectLiteral | null {
  if (value === null || value === undefined) return null;
  if (value.kind === 'object') return value.object;
  const only = value.kind === 'call' && value.args.length === 1 ? value.args[0] : undefined;
  return only !== undefined && only.kind === 'object' ? only.object : null;
}

/**
 * The declarations an object literal spreads, in the game's own order.
 *
 * The projection drops a spread element (there is no member to hold it), so the literal's own text is the only
 * place it survives. That text is byte-identical in the fixture and in the chunk, which is what keeps the answer
 * the same in both runs.
 */
function spreadNames(object: ShapeObjectLiteral): readonly string[] {
  const names: string[] = [];
  for (const match of object.text.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

/** The enum member a discriminator states: `literal(<enum>.<member>)`, or `null` for any other expression. */
function literalMember(
  value: ShapeValue | null,
): { readonly enumName: string; readonly member: string } | null {
  if (value === null || value.kind !== 'call') return null;
  const only = value.args.length === 1 ? value.args[0] : undefined;
  if (only === undefined || only.kind !== 'reference') return null;
  const enumName = only.path.at(-2);
  const member = only.path.at(-1);
  if (enumName === undefined || member === undefined) return null;
  return { enumName, member };
}

/** A declaration read as one schema arm, or `null` when it is not one. */
function armOfDeclaration(declaration: ShapeDeclaration): SchemaShape | null {
  const object = schemaObject(declaration.value);
  if (object === null) return null;
  return {
    id: declaration.name,
    declaration: declaration.name,
    declarationStart: declaration.valueStart,
    declarationEnd: declaration.valueEnd,
    object,
  };
}

/** The declaration named `name` read as one schema arm, or `null`. */
/**
 * The declaration a schema reference names, preferring the one that is a schema.
 *
 * A minified name is unique per scope, not per chunk: 1650 declares the Produce schema's name twice, once as
 * and once as a local. `declarationNamed` answers the first, which is how a union arm silently became a function
 * call. This prefers a declaration that projects as a schema or a union, and falls back to the first only when
 * none does -- the caller still checks what it got.
 */
function schemaDeclarationNamed(chunk: ParsedChunk, name: string): ShapeDeclaration | null {
  const named = chunk.declarations.filter((declaration) => declaration.name === name);
  const schema = named.find(
    (declaration) => schemaObject(declaration.value) !== null || unionMembers(declaration.value) !== null,
  );
  return schema ?? named[0] ?? null;
}

function armNamed(chunk: ParsedChunk, name: string): SchemaShape | null {
  const declaration = schemaDeclarationNamed(chunk, name);
  return declaration === null ? null : armOfDeclaration(declaration);
}

/**
 * The arms a union declaration names, in the union's own order.
 *
 * The arm may be a reference to a declaration, or an object literal written inline; a reference to a declaration
 * that is itself a union -- the game states the tools as two schemas -- contributes each of its own arms, named
 * `<declaration>#<index>` so two variants of one kind stay apart.
 */
function unionArms(chunk: ParsedChunk, union: ShapeDeclaration): readonly SchemaShape[] {
  const members = unionMembers(union.value);
  if (members === null) return [];
  const arms: SchemaShape[] = [];
  members.forEach((member, index) => {
    if (member.kind !== 'reference') {
      const object = schemaObject(member);
      if (object !== null) {
        arms.push({
          id: `${union.name}#${index}`,
          declaration: union.name,
          declarationStart: union.valueStart,
          declarationEnd: union.valueEnd,
          object,
        });
      }
      return;
    }
    const name = member.path.at(-1);
    if (name === undefined) return;
    const declaration = schemaDeclarationNamed(chunk, name);
    if (declaration === null) return;
    const nested = unionMembers(declaration.value);
    if (nested === null) {
      const arm = armOfDeclaration(declaration);
      if (arm !== null) arms.push(arm);
      return;
    }
    nested.forEach((inner, innerIndex) => {
      const object = schemaObject(inner);
      if (object !== null) {
        arms.push({
          id: `${name}#${innerIndex}`,
          declaration: name,
          declarationStart: declaration.valueStart,
          declarationEnd: declaration.valueEnd,
          object,
        });
      }
    });
  });
  return arms;
}

/** The kind an arm declares, following the schemas it spreads, or `null` when it states none. */
function discriminatorOf(
  chunk: ParsedChunk,
  arm: SchemaShape,
  key: string,
  seen: Set<string> = new Set(),
): { readonly enumName: string; readonly member: string } | null {
  const direct = literalMember(memberValue(arm.object, key));
  if (direct !== null) return direct;
  for (const base of spreadNames(arm.object)) {
    if (seen.has(base)) continue;
    seen.add(base);
    const baseArm = armNamed(chunk, base);
    if (baseArm === null) continue;
    const found = discriminatorOf(chunk, baseArm, key, seen);
    if (found !== null) return found;
  }
  return null;
}

/** The union that names every kind the game's item-type enum states, and no kind it does not. */
function itemUnionOf(
  chunk: ParsedChunk,
  enumNames: ReadonlySet<string>,
  kinds: ReadonlySet<string>,
): { readonly declaration: ShapeDeclaration; readonly arms: readonly SchemaShape[] } | null {
  for (const declaration of chunk.declarations) {
    if (unionMembers(declaration.value) === null) continue;
    const arms = unionArms(chunk, declaration);
    if (arms.length === 0) continue;
    const named = new Set<string>();
    let ok = true;
    for (const arm of arms) {
      const discriminator = discriminatorOf(chunk, arm, 'itemType');
      if (discriminator === null || !enumNames.has(discriminator.enumName)) {
        ok = false;
        break;
      }
      named.add(discriminator.member);
    }
    if (!ok) continue;
    if (named.size !== kinds.size || ![...named].every((kind) => kinds.has(kind))) continue;
    return { declaration, arms };
  }
  return null;
}

/** The schema a `slots` member holds: the reference inside an array wrapper, or the reference itself. */
function slotsReference(value: ShapeValue | null): string | null {
  if (value === null) return null;
  if (value.kind === 'reference') return value.path.at(-1) ?? null;
  const only = value.kind === 'call' && value.args.length === 1 ? value.args[0] : undefined;
  return only !== undefined && only.kind === 'reference' ? (only.path.at(-1) ?? null) : null;
}

/** The crop schema a plant arm's own `slots` member names. */
function cropArmOf(chunk: ParsedChunk, arms: readonly SchemaShape[]): SchemaShape | null {
  for (const arm of arms) {
    const reference = slotsReference(memberValue(arm.object, 'slots'));
    if (reference === null) continue;
    const crop = armNamed(chunk, reference);
    if (crop !== null) return crop;
  }
  return null;
}

/** The deepest schema an arm spreads: the base the game builds the arm on. */
function baseArmOf(chunk: ParsedChunk, arm: SchemaShape, seen: Set<string> = new Set()): SchemaShape | null {
  for (const base of spreadNames(arm.object)) {
    if (seen.has(base)) continue;
    seen.add(base);
    const baseArm = armNamed(chunk, base);
    if (baseArm === null) continue;
    return baseArmOf(chunk, baseArm, seen) ?? baseArm;
  }
  return null;
}

/**
 * Every declaration that declares the same extras over the same base as this arm.
 *
 * The game states the pet twice: one variant requires the outfit extras and one makes them optional. They are
 * the same schema with the same spread base and the same own fields, so that is the shape this looks for -- and
 * finding both is what lets the optional idiom be read off the game rather than named (see `optionalWrappers`).
 */
function variantArmsOf(chunk: ParsedChunk, arm: SchemaShape): readonly SchemaShape[] {
  const bases = new Set(spreadNames(arm.object));
  const names = new Set(arm.object.members.map((member) => member.key));
  const variants: SchemaShape[] = [];
  for (const declaration of chunk.declarations) {
    const candidate = armOfDeclaration(declaration);
    if (candidate === null) continue;
    const candidateBases = spreadNames(candidate.object);
    if (candidateBases.length !== bases.size || !candidateBases.every((base) => bases.has(base))) continue;
    const candidateNames = candidate.object.members.map((member) => member.key);
    if (candidateNames.length !== names.size || !candidateNames.every((name) => names.has(name))) continue;
    variants.push(candidate);
  }
  return variants.sort((left, right) => left.object.start - right.object.start);
}

/** A structural key for a schema expression, so two arms' members compare by shape rather than by spelling. */
function shapeKey(value: ShapeValue): string {
  switch (value.kind) {
    case 'reference':
      return `ref:${value.path.join('.')}`;
    case 'call':
      return `call:${value.callee}(${value.args.map(shapeKey).join(',')})`;
    case 'string':
      return `str:${value.text}`;
    case 'number':
      return `num:${value.text}`;
    case 'boolean':
      return `bool:${String(value.value)}`;
    case 'null':
      return 'null';
    case 'array':
      return `[${value.items.map(shapeKey).join(',')}]`;
    case 'object':
      return `{${value.object.members.map((member) => `${member.key}:${shapeKey(member.value)}`).join(',')}}`;
    default:
      return `other:${value.text}`;
  }
}

/**
 * The callee the game wraps an optional field in, learned from the game's own variants rather than named.
 *
 * Naming the wrapper would be naming a minified symbol, and it changes with every build -- the same two pet
 * variants state it under a different letter in each capture this package ships. What does not change is the
 * relationship: one variant writes a field and the other writes `<wrapper>(<the same field>)`, and the wrapper is
 * therefore optionality. Every field that wrapper is applied to anywhere in the schemas -- the crop's position,
 * a decor's mounted crop, the pet's outfit extras -- is optional for the same reason.
 */
function optionalWrappers(groups: readonly (readonly SchemaShape[])[]): ReadonlySet<string> {
  const found = new Set<string>();
  for (const group of groups) {
    for (const left of group) {
      for (const right of group) {
        if (left === right) continue;
        for (const member of left.object.members) {
          const wrapped = member.value;
          if (wrapped.kind !== 'call' || wrapped.args.length !== 1) continue;
          const inner = wrapped.args[0];
          const plain = memberValue(right.object, member.key);
          if (inner === undefined || plain === null) continue;
          if (shapeKey(inner) !== shapeKey(plain)) continue;
          found.add(wrapped.callee);
        }
      }
    }
  }
  return found;
}

/** The declaration a discriminator names, read for the members it assigns -- a reading separate from the arms. */
function enumNamed(
  chunk: ParsedChunk,
  name: string,
): { readonly declaration: ShapeDeclaration; readonly literals: Readonly<Record<string, string>> } | null {
  // A minified name can be declared in more than one scope; the enum is the declaration that reads as one.
  for (const declaration of chunk.declarations) {
    if (declaration.name !== name) continue;
    const literals = enumMembers(declaration.text);
    if (literals !== null) return { declaration, literals };
  }
  return null;
}

/**
 * The tile union: the largest union whose arms each state an `objectType` through one and the same enum.
 *
 * The game states a two-armed subset beside the four-armed union, and both name the same enum, so the member
 * count is what separates them -- the maximal union wins, and a tie is refused rather than guessed. The enum
 * itself is *not* consulted here: its members are read separately, from the declaration the arms name, so that
 * "the arms and the enum agree" is a comparison two independent readings make rather than a condition discovery
 * enforces (see `validate.ts`).
 */
function tileUnionOf(chunk: ParsedChunk): {
  readonly union: ShapeDeclaration;
  readonly arms: readonly SchemaShape[];
  readonly enumName: string;
} | null {
  let best: {
    readonly union: ShapeDeclaration;
    readonly arms: readonly SchemaShape[];
    readonly enumName: string;
  } | null = null;
  let tied = false;
  for (const declaration of chunk.declarations) {
    if (unionMembers(declaration.value) === null) continue;
    const arms = unionArms(chunk, declaration);
    if (arms.length < 2) continue;
    let enumName: string | null = null;
    const members = new Set<string>();
    let ok = true;
    for (const arm of arms) {
      const discriminator = discriminatorOf(chunk, arm, 'objectType');
      if (discriminator === null) {
        ok = false;
        break;
      }
      if (enumName === null) enumName = discriminator.enumName;
      else if (enumName !== discriminator.enumName) {
        ok = false;
        break;
      }
      members.add(discriminator.member);
    }
    if (!ok || enumName === null || members.size !== arms.length) continue;
    if (best === null || members.size > best.arms.length) {
      best = { union: declaration, arms, enumName };
      tied = false;
    } else if (members.size === best.arms.length) {
      tied = true;
    }
  }
  return tied ? null : best;
}

/** The predicate's own name and prose, shared by the candidate builder and the record the extractor keeps. */
const KIND_SCHEMA_PREDICATE = 'kind-schema-table';
const KIND_SCHEMA_LOOKS_FOR =
  "the game's own kind schemas: the strict object each item kind's union arm names, the crop schema a plant's own `slots` member holds, the pet base whose two variants add the outfit extras, and the tile union whose arms discriminate on `objectType` through the other, lowercase enum";
const KIND_SCHEMA_INVARIANT =
  "exactly the item kinds the item-type enum states, each with at least one arm; the largest union whose arms state an `objectType` through one enum, one arm per member; a crop read from the plant schema's own `slots` member; and a pet base reachable from both the item union's pet arm and the pet variants, one of which wraps the extras the other requires";

/** Read the kind schemas out of one chunk, or `null` when this chunk does not state them. */
function kindSchemaCandidate(
  context: PredicateContext,
  chunk: ParsedChunk,
): TableCandidate<ArtTables['kindSchemas']> | null {
  const enumName = context.declarations.itemTypes;
  const kinds = new Set(Object.keys(context.tables.itemTypes ?? {}));
  if (enumName === undefined || kinds.size === 0) return null;

  // The enum can live in another chunk: 1650 moved the item kinds into a shared module, so the union names
  // them through an import alias. Any local name this chunk imports from the enum's own chunk is accepted,
  // because the exported name need not equal the declaration's (the reader sees the local name, not the map).
  const enumChunk = context.chunks.find((candidate) => declarationNamed(candidate, enumName) !== null);
  const enumNames = new Set<string>([enumName]);
  if (enumChunk !== null && enumChunk !== undefined) {
    const target = `./${enumChunk.file}`;
    for (const imported of chunk.imports) {
      if (imported.from === target) enumNames.add(imported.local);
    }
  }
  const union = itemUnionOf(chunk, enumNames, kinds);
  if (union === null) return null;

  const items: Record<string, string[]> = {};
  for (const arm of union.arms) {
    const discriminator = discriminatorOf(chunk, arm, 'itemType');
    if (discriminator === null) return null;
    const ids = items[discriminator.member] ?? [];
    ids.push(arm.id);
    items[discriminator.member] = ids;
  }

  const crop = cropArmOf(chunk, union.arms);
  if (crop === null) return null;

  const petId = items['Pet']?.[0];
  const petArm = petId === undefined ? undefined : union.arms.find((arm) => arm.id === petId);
  if (petArm === undefined) return null;
  const base = baseArmOf(chunk, petArm);
  if (base === null) return null;
  const variants = variantArmsOf(chunk, petArm);
  if (variants.length === 0) return null;

  // Every arm the table records, each once: the kind's own arms, the crop, the pet variants, the base they
  // resolve through, and every declaration those spread so `spreads` names a recorded arm.
  const shapes = new Map<string, SchemaShape>();
  const record = (arm: SchemaShape): void => {
    if (!shapes.has(arm.id)) shapes.set(arm.id, arm);
  };
  for (const arm of union.arms) record(arm);
  record(crop);
  for (const arm of variants) record(arm);
  record(base);
  for (const arm of [petArm, base, ...variants]) {
    for (const name of spreadNames(arm.object)) {
      const spread = armNamed(chunk, name);
      if (spread !== null) record(spread);
    }
  }

  const tile = tileUnionOf(chunk);
  if (tile === null) return null;
  // The keys are the *members* the arms state, not the literals: the arm writes `objectType: literal(<enum>.
  // <member>)`, so the member is the arm's own reading, and the enum's own reading is kept beside it as
  // `tileTypes`. The two are compared later, so a mis-read of either is a disagreement rather than a condition
  // this loop makes impossible.
  const tiles: Record<string, string[]> = {};
  for (const arm of tile.arms) {
    const discriminator = discriminatorOf(chunk, arm, 'objectType');
    if (discriminator === null) return null;
    record(arm);
    const ids = tiles[discriminator.member] ?? [];
    ids.push(arm.id);
    tiles[discriminator.member] = ids;
  }
  const tileEnum = enumNamed(chunk, tile.enumName);

  const groups: SchemaShape[][] = Object.values(items).map((ids) =>
    ids.map((id) => shapes.get(id)).filter((arm): arm is SchemaShape => arm !== undefined),
  );
  for (const ids of Object.values(tiles)) {
    groups.push(ids.map((id) => shapes.get(id)).filter((arm): arm is SchemaShape => arm !== undefined));
  }
  groups.push([...variants]);
  const optional = optionalWrappers(groups);

  const arms: Record<string, SchemaArm> = {};
  for (const [id, shape] of shapes) {
    arms[id] = {
      declaration: shape.declaration,
      spreads: spreadNames(shape.object),
      fields: shape.object.members.map((member) => ({
        name: member.key,
        required: !(member.value.kind === 'call' && optional.has(member.value.callee)),
      })),
    };
  }

  // Every declaration a fixture has to keep, with where its initializer sits: the object arms, the tile union,
  // and the enum that assigns the tile kinds. The table's own declaration is cited above, not here.
  const declarationRanges = new Map<string, { readonly start: number; readonly end: number }>();
  for (const shape of shapes.values()) {
    if (!declarationRanges.has(shape.declaration)) {
      declarationRanges.set(shape.declaration, {
        start: shape.declarationStart,
        end: shape.declarationEnd,
      });
    }
  }
  declarationRanges.set(tile.union.name, {
    start: tile.union.valueStart,
    end: tile.union.valueEnd,
  });
  if (tileEnum !== null) {
    declarationRanges.set(tileEnum.declaration.name, {
      start: tileEnum.declaration.valueStart,
      end: tileEnum.declaration.valueEnd,
    });
  }

  const support = [...declarationRanges.keys()].filter((name) => name !== union.declaration.name).sort();
  const reading: EvidenceReading[] = [...declarationRanges.entries()]
    .filter(([name]) => name !== union.declaration.name)
    .map(([declaration, range]) => ({ declaration, start: range.start, end: range.end }))
    .sort((left, right) => left.declaration.localeCompare(right.declaration));

  const value: ArtTables['kindSchemas'] = {
    items,
    tiles,
    tileTypes: tileEnum?.literals ?? {},
    crops: [crop.id],
    pets: { base: [base.id], variants: variants.map((arm) => arm.id) },
    arms,
  };
  const fieldCount = Object.values(arms).reduce((total, arm) => total + arm.fields.length, 0);
  const optionalCount = Object.values(arms).reduce(
    (total, arm) => total + arm.fields.filter((field) => !field.required).length,
    0,
  );

  return {
    id: 'kindSchemas',
    predicate: KIND_SCHEMA_PREDICATE,
    looksFor: KIND_SCHEMA_LOOKS_FOR,
    invariant: KIND_SCHEMA_INVARIANT,
    chunk: chunk.file,
    declaration: union.declaration.name,
    start: union.declaration.valueStart,
    end: union.declaration.valueEnd,
    support,
    reading,
    coverage: {
      counts: {
        itemKinds: Object.keys(items).length,
        itemArms: union.arms.length,
        tileKinds: Object.keys(tiles).length,
        tileArms: tile.arms.length,
        tileTypes: Object.keys(tileEnum?.literals ?? {}).length,
        cropArms: 1,
        petVariants: variants.length,
        arms: Object.keys(arms).length,
        fields: fieldCount,
        optionalFields: optionalCount,
      },
      notes: [`optional wrapper(s), read from the variants: ${[...optional].sort().join(', ') || 'none'}`],
    },
    value,
  };
}

const kindSchemaTable: TablePredicate<ArtTables['kindSchemas']> = {
  id: 'kindSchemas',
  predicate: KIND_SCHEMA_PREDICATE,
  looksFor: KIND_SCHEMA_LOOKS_FOR,
  invariant: KIND_SCHEMA_INVARIANT,
  candidates(context) {
    const found: TableCandidate<ArtTables['kindSchemas']>[] = [];
    for (const chunk of context.chunks) {
      const candidate = kindSchemaCandidate(context, chunk);
      if (candidate !== null) found.push(candidate);
    }
    return found;
  },
  violations(candidate, context) {
    const problems: string[] = [];
    const counts = candidate.coverage.counts;
    const requested = Object.keys(context.tables.itemTypes ?? {}).length;
    if ((counts['itemKinds'] ?? 0) !== requested) {
      problems.push(`${counts['itemKinds'] ?? 0} of ${requested} item kinds have a schema`);
    }
    if ((counts['tileKinds'] ?? 0) < 2) {
      problems.push(`${counts['tileKinds'] ?? 0} tile kinds are declared`);
    }
    // One arm per member is the union's own shape. Whether the arms and the enum agree is *not* decided here:
    // that comparison belongs to `validate.ts`, which owes this discovery nothing.
    if ((counts['tileKinds'] ?? 0) !== (counts['tileArms'] ?? 0)) {
      problems.push(
        `${counts['tileKinds'] ?? 0} tile kinds for ${counts['tileArms'] ?? 0} arms, not one member each`,
      );
    }
    if ((counts['petVariants'] ?? 0) < 2) {
      problems.push(`${counts['petVariants'] ?? 0} pet variants, not the two the game declares`);
    }
    if ((counts['optionalFields'] ?? 0) === 0) {
      problems.push('no field is optional, so the optional wrapper was not read off the variants');
    }
    for (const [id, arm] of Object.entries(candidate.value.arms)) {
      for (const base of arm.spreads) {
        if (candidate.value.arms[base] === undefined) {
          problems.push(`${id} spreads ${base}, which is not a recorded arm`);
        }
      }
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
  iconFillTable,
  itemTypeEnum,
  kindSchemaTable,
] as unknown as readonly TablePredicate<never>[];

/** `null` for a number that is not a number, so a note can say so rather than print `NaN`. */
function trimOrNull(value: number | null): number | null {
  return value === null || Number.isNaN(value) ? null : value;
}
