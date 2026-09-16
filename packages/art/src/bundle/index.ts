/**
 * `@mg.js/art/bundle`: the game's own art tables, read out of its own chunks.
 *
 * A parsed chunk in, tables out. The predicates here locate the sprite-name table, the mutation records, the
 * mutation art table, the per-species anchors, the display flags, the scale cap, the over set and the placement
 * function by *shape* rather than by symbol name, because the names are minified and change every build. What
 * makes that safe is that each predicate carries a coverage invariant instead of a success boolean, that a
 * failure names the predicate and what it saw, and that the result is refused when the atlas cannot confirm it.
 *
 * The parser is the caller's. This entry imports nothing at runtime -- no `node:`, no other package -- so a
 * browser can load the built file directly, and a runtime with no parser can feed the predicates its own
 * twenty-line projection of `{ key: 'value' }` literals. `tools/typescript-reader.ts` is what this repo's sync
 * feeds them, and it is deliberately not exported here: it is a tool, not a name a consumer needs.
 */

export {
  ART_DATA_CONTRACT,
  ArtDataError,
  artDataOf,
  parseArtData,
  serializeArtData,
} from './data.js';
export {
  artDataFor,
  type Extraction,
  ExtractionError,
  evidenceOf,
  extractArtTables,
} from './extract.js';
export {
  PREDICATES,
  type PredicateContext,
  spriteIndexOf,
  type TableCandidate,
  type TablePredicate,
} from './predicates.js';
export {
  PROVENANCE,
  type ProvenanceStamp,
  provenanceFor,
  renderProvenanceDoc,
  type StampedProvenance,
  type TableProvenance,
} from './provenance.js';
export {
  asObject,
  asString,
  contains,
  declarationNamed,
  leafEntries,
  leafStrings,
  literalJson,
  memberKeys,
  memberValue,
  type ParsedChunk,
  type ShapeAssignment,
  type ShapeBoolean,
  type ShapeCall,
  type ShapeDeclaration,
  type ShapeFunction,
  type ShapeImport,
  type ShapeMember,
  type ShapeNull,
  type ShapeNumber,
  type ShapeObject,
  type ShapeObjectLiteral,
  type ShapeReference,
  type ShapeString,
  type ShapeValue,
} from './shape.js';
export {
  type AnchorValue,
  type ArtData,
  type ArtTables,
  type Coverage,
  type DisplayFlags,
  type Evidence,
  type IconFill,
  type IconFillSource,
  MODEL_TABLES,
  type MutationArt,
  type MutationRecord,
  type MutationTint,
  type Placement,
  type PlacementExternal,
  type PlantPart,
  type PlantRecord,
  type SpritePath,
  type TableId,
} from './tables.js';
export {
  type AtlasFrames,
  mutationSpritesOf,
  plantSpritesOf,
  spritePathsOf,
  type ValidationFailure,
  validateArtData,
  validateTables,
} from './validate.js';
