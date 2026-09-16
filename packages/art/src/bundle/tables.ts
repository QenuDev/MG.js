/**
 * What a game chunk says about its own art, once the predicates have linked it.
 *
 * These are the values, not the evidence: every one of them came out of the bundle, and none of them is a
 * constant written down here. They are also the shape of `packages/art/data/<version>.json`, because that file
 * is this record serialised, sorted and stamped with the version it was read from.
 *
 * `mutationArt` has no field this package invented: `tint` is the colour literal and the `alpha` the mutation's
 * filter construction states (or `null`), `material` says the filter was a construction with no colour at all --
 * the game's own way of saying "this one is a shader", and what the consumer used to know as a hardcoded pair
 * of names -- and the three sprite fields are the names the table states, resolved through the sprite-name
 * table so that a consumer never has to know a minified alias.
 */

/** One spelling of the game's own sprite identity: `sprite/<category>/<Name>`, the atlas's key form. */
export type SpritePath = string;

/** A species' art for one part, with the name table reference resolved. */
export interface PlantPart {
  readonly sprite: SpritePath | null;
  /** The harvest enum member the plant block names, when it names one. */
  readonly harvestType: string | null;
}

export interface PlantRecord {
  readonly seed: PlantPart | null;
  readonly plant: PlantPart | null;
  readonly crop: PlantPart | null;
}

/** A mutation's crop wash, as the filter construction states it. */
export interface MutationTint {
  readonly color: string;
  readonly alpha: number | null;
}

export interface MutationArt {
  /** Position in the game's own table, which is the order the game stacks them in. */
  readonly order: number;
  readonly tint: MutationTint | null;
  /** True when the mutation filters through a construction that states no colour (a shader material). */
  readonly material: boolean;
  readonly iconSprite: SpritePath | null;
  readonly groundSprite: SpritePath | null;
  readonly overlaySprite: SpritePath | null;
  readonly overlayFromBottom: boolean;
}

export interface MutationRecord {
  readonly name: string;
  readonly group: string;
  readonly sprite: SpritePath | null;
}

export interface DisplayFlags {
  readonly isTallPlant: boolean;
  readonly isNarrowDisplay: boolean;
}

/**
 * How the game states one item kind's share of the **256x256** inventory icon box.
 *
 * `stated` is a `sizeRatio` the fit is called with (or the `256 * <const>` scale the plant path computes);
 * `fit-default` is the fit's own default of 1, because the kind reaches the icon builder with no `sizeRatio` at
 * all; `bake-frame` is the pet, which is the one kind the item-kind switch does not route -- the game renders a
 * pet's portrait through a separate bake service, and that service's own renderer reaches the same 256-frame
 * builder with no `sizeRatio`, so its share is the fit's default rather than a figure any branch states.
 *
 * The distinction is the point: presenting all seven as "the game states them" would be a lie about the
 * evidence, and so would calling the pet's share a bake's consequence when it is the same default the other
 * four kinds take -- what is different about the pet is the route, not the number.
 */
export type IconFillSource = 'stated' | 'fit-default' | 'bake-frame';

export interface IconFill {
  /** The share of the icon box the kind's art is fitted to, in `(0, 1]`. */
  readonly fill: number;
  /** Where the share comes from: a stated `sizeRatio`, the fit's default, or the pet's route outside the switch. */
  readonly source: IconFillSource;
}

/** A number, or the per-part overrides the game states for one species. */
export type AnchorValue = number | { readonly [part: string]: number | AnchorValue };

export interface ArtTables {
  /** category -> name -> path, the game's own nesting. */
  readonly spriteNames: Readonly<Record<string, Readonly<Record<string, SpritePath>>>>;
  readonly mutationRecords: Readonly<Record<string, MutationRecord>>;
  readonly mutationArt: Readonly<Record<string, MutationArt>>;
  /** Keyed by sprite path, because the game indexes this table by the sprite it is about to draw. */
  readonly displayFlags: Readonly<Record<SpritePath, DisplayFlags>>;
  readonly anchors: Readonly<Record<string, AnchorValue>>;
  readonly plants: Readonly<Record<string, PlantRecord>>;
  /** member -> the literal the game's enum assigns it. */
  readonly harvestTypes: Readonly<Record<string, string>>;
  /**
   * item type -> the share of the icon box its art fills, and how the game states that share.
   *
   * The kinds are the game's own item-type members, which `itemTypes` carries beside this table; the share is
   * the fit function's, not a figure this package chose.
   */
  readonly iconFills: Readonly<Record<string, IconFill>>;
  /** member -> the literal the game's own item-type enum assigns it (the consumer's `itemType` string). */
  readonly itemTypes: Readonly<Record<string, string>>;
  readonly scale: {
    readonly cap: number;
    readonly referenceTilePx: number;
    readonly tallDecalMultiplier: number;
  };
  readonly overMutations: readonly string[];
  readonly placement: Placement;
}

/**
 * The game's own placement function, extracted rather than re-derived.
 *
 * `source` is the function's own text and `declarations` are the chunk-local declarations it closes over, in a
 * form a plain function body can re-declare. `externals` names what is still missing and what it is: a role the
 * extractor resolved from how the function uses the name, and the import specifier the chunk states for it.
 * `characters` is the assembled length, so a shape change that quietly pulls in half the bundle is visible.
 */
export interface Placement {
  readonly name: string | null;
  readonly source: string;
  readonly declarations: Readonly<Record<string, string>>;
  readonly externals: readonly PlacementExternal[];
  readonly characters: number;
}

export interface PlacementExternal {
  readonly name: string;
  /** The table the name stands for, as the function's own use of it states: `plants`, `harvestTypes`, or `host`. */
  readonly role: 'plants' | 'harvestTypes' | 'host' | 'unresolved';
  /** The chunk's own import specifier for the name, when the chunk states one. */
  readonly from: string | null;
}

/** The tables a consumer of the model draws with; a table outside this list is evidence, not an input. */
export const MODEL_TABLES = [
  'spriteNames',
  'mutationRecords',
  'mutationArt',
  'displayFlags',
  'anchors',
  'plants',
  'harvestTypes',
  'iconFills',
  'itemTypes',
  'scale',
  'overMutations',
  'placement',
] as const satisfies readonly (keyof ArtTables)[];

export type TableId = keyof ArtTables;

/** The version stamp and the evidence, beside the tables. */
export interface ArtData {
  readonly gameVersion: string;
  readonly artVersion: string;
  readonly tables: ArtTables;
  readonly evidence: Readonly<Record<TableId, Evidence>>;
}

/**
 * Which predicate found a table, in which chunk, by what shape, and what the invariant it carries measured.
 *
 * This is the record the provenance document is generated from, and the reason a data file can be reviewed as
 * a diff: a changed count is visible next to the byte range it was read from.
 */
export interface Evidence {
  readonly predicate: string;
  readonly looksFor: string;
  readonly invariant: string;
  readonly chunk: string;
  readonly declaration: string | null;
  readonly start: number;
  readonly end: number;
  /**
   * Other declarations in the chunk the predicate had to read to accept this table -- the default record the
   * display flags point at, the declarations the placement function closes over, the function an over set is
   * read in. They are recorded because a fixture cut from the bundle has to keep them, and because "what else
   * did this predicate need" is the question a shape change makes urgent.
   */
  readonly support: readonly string[];
  readonly coverage: Coverage;
}

/** A predicate's measurement of what it found: counts, and anything it could not resolve. */
export interface Coverage {
  readonly counts: Readonly<Record<string, number>>;
  readonly notes?: readonly string[];
}
