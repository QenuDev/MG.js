/**
 * The second half of "a predicate proposes; validation disposes": checking a table against something outside
 * itself.
 *
 * Shape alone is not enough, and the plan records why: the same predicates that find the display-flag table also
 * matched an `isHidden` table in another chunk, and the anchor shape also matched a table of animation
 * fractions. What separates them is that the atlas has the sprite paths and the plant table has the species, so
 * every check here compares a table against a witness rather than against itself.
 *
 * A failure names the table and shows the offenders, because the failure is read by somebody looking at a
 * version change: "109 keys, 3 of them are not frames the atlas has: sprite/plant/X, ..." is a sentence that
 * leads somewhere, and "validation failed" is not.
 */

import type { ArtData, ArtTables } from './tables.js';

/**
 * The atlas frames a table is checked against: either the keys of a frame map (`Object.keys(frames)`) or a set
 * of them. Nothing here reads a frame's contents -- a frame that exists is what confirms a path.
 */
export type AtlasFrames = Iterable<string> | Readonly<Record<string, unknown>>;

export interface ValidationFailure {
  /** The check that failed, in the form `<table>: <what it required>`. */
  readonly check: string;
  /** The table the offender belongs to. */
  readonly table: keyof ArtTables;
  /** Everything that violated the check, capped so a broken build does not print a megabyte. */
  readonly saw: readonly string[];
  readonly detail: string;
}

/** How many offenders a failure lists before it says "and N more". */
const LIST_LIMIT = 8;

function frameSet(atlas: AtlasFrames): ReadonlySet<string> {
  return atlas instanceof Set
    ? (atlas as ReadonlySet<string>)
    : new Set<string>(
        typeof (atlas as Iterable<string>)[Symbol.iterator] === 'function'
          ? (atlas as Iterable<string>)
          : Object.keys(atlas),
      );
}

function capped(offenders: readonly string[]): readonly string[] {
  return offenders.length <= LIST_LIMIT
    ? offenders
    : [...offenders.slice(0, LIST_LIMIT), `and ${offenders.length - LIST_LIMIT} more`];
}

/** Every sprite path the name table states, in the atlas's key form. */
export function spritePathsOf(names: ArtTables['spriteNames']): readonly string[] {
  const paths: string[] = [];
  for (const members of Object.values(names)) for (const path of Object.values(members)) paths.push(path);
  return paths;
}

/** Every sprite path a mutation's art states, wherever it states one. */
export function mutationSpritesOf(art: ArtTables['mutationArt']): readonly string[] {
  const paths: string[] = [];
  for (const mutation of Object.values(art)) {
    for (const path of [mutation.iconSprite, mutation.groundSprite, mutation.overlaySprite]) {
      if (path !== null) paths.push(path);
    }
  }
  return paths;
}

/** Every sprite path the plant table states, across all three parts. */
export function plantSpritesOf(plants: ArtTables['plants']): readonly string[] {
  const paths: string[] = [];
  for (const record of Object.values(plants)) {
    for (const part of [record.seed, record.plant, record.crop]) {
      if (part?.sprite != null) paths.push(part.sprite);
    }
  }
  return paths;
}

/**
 * Check a table set against the atlas and against itself.
 *
 * Returns every failure rather than the first: a version change that moved several things should be reviewable
 * in one run, and the caller decides whether to print them or throw.
 */
export function validateTables(tables: ArtTables, atlas: AtlasFrames): readonly ValidationFailure[] {
  const frames = frameSet(atlas);
  const failures: ValidationFailure[] = [];
  const namePaths = new Set(spritePathsOf(tables.spriteNames));

  // 1. Every sprite path in the name table is a frame the atlas has. This is the check the whole approach
  //    rests on: the atlas is published by the game, so it is the one witness that is neither this package
  //    nor a value somebody wrote down.
  const missingFrames = spritePathsOf(tables.spriteNames).filter((path) => !frames.has(path));
  if (missingFrames.length > 0) {
    failures.push({
      check: 'sprite-name-table: every path is a frame the atlas has',
      table: 'spriteNames',
      saw: capped(missingFrames),
      detail: `${missingFrames.length} of ${namePaths.size} sprite paths are not atlas frames`,
    });
  }

  // 2. Every key of the display-flag table is a path the name table states -- and therefore a frame, by 1.
  const flagOffenders = Object.keys(tables.displayFlags).filter((path) => !namePaths.has(path));
  if (flagOffenders.length > 0) {
    failures.push({
      check: 'display-flag-table: every key is a sprite path the name table states',
      table: 'displayFlags',
      saw: capped(flagOffenders),
      detail: `${flagOffenders.length} of ${Object.keys(tables.displayFlags).length} flag keys are not in the name table`,
    });
  }
  const tall = Object.entries(tables.displayFlags)
    .filter(([, flags]) => flags.isTallPlant)
    .map(([path]) => path);
  if (tall.length === 0) {
    failures.push({
      check: 'display-flag-table: the tall set is not empty',
      table: 'displayFlags',
      saw: [],
      detail: 'no key states isTallPlant, so the tall set the model draws with would be empty',
    });
  }

  // 3. Every anchor key is a species the plant table states. A table of animation fractions is keyed by names
  //    that are not species, which is exactly how the shape predicate's other match is refused.
  const species = new Set(Object.keys(tables.plants));
  const anchorOffenders = Object.keys(tables.anchors).filter((key) => !species.has(key));
  if (anchorOffenders.length > 0) {
    failures.push({
      check: 'anchor-table: every key is a species in the plant table',
      table: 'anchors',
      saw: capped(anchorOffenders),
      detail: `${anchorOffenders.length} of ${Object.keys(tables.anchors).length} anchor keys are not species`,
    });
  }

  // 4. The scale cap is a fraction and the reference tile is a size: both are read from the formula, and both
  //    are absurd if they are not.
  if (!(tables.scale.cap > 0 && tables.scale.cap <= 1)) {
    failures.push({
      check: 'scale-cap: the cap is a fraction',
      table: 'scale',
      saw: [String(tables.scale.cap)],
      detail: `the cap constant reads as ${tables.scale.cap}`,
    });
  }
  if (!(tables.scale.referenceTilePx > 0)) {
    failures.push({
      check: 'scale-cap: the divisor is a tile size',
      table: 'scale',
      saw: [String(tables.scale.referenceTilePx)],
      detail: `the formula divides by ${tables.scale.referenceTilePx}`,
    });
  }

  // 5. Every mutation the art table states is a mutation the records state, every sprite it names is in the
  //    name table, and every one of them is either a wash or a material -- never neither, which is what a
  //    filter neither this reader nor a consumer could use looks like.
  const recordKeys = new Set(Object.keys(tables.mutationRecords));
  const artOffenders = Object.keys(tables.mutationArt).filter((key) => !recordKeys.has(key));
  if (artOffenders.length > 0) {
    failures.push({
      check: 'mutation-art-table: every key is a mutation the records state',
      table: 'mutationArt',
      saw: capped(artOffenders),
      detail: `${artOffenders.length} of ${Object.keys(tables.mutationArt).length} art keys have no record`,
    });
  }
  const mutationOffenders = mutationSpritesOf(tables.mutationArt).filter((path) => !namePaths.has(path));
  if (mutationOffenders.length > 0) {
    failures.push({
      check: 'mutation-art-table: every sprite it names is in the name table',
      table: 'mutationArt',
      saw: capped(mutationOffenders),
      detail: `${mutationOffenders.length} mutation sprite paths are not in the name table`,
    });
  }
  const neither = Object.entries(tables.mutationArt)
    .filter(([, art]) => art.tint === null && !art.material)
    .map(([name]) => name);
  if (neither.length > 0) {
    failures.push({
      check: 'mutation-art-table: every mutation is a wash or a material',
      table: 'mutationArt',
      saw: capped(neither),
      detail: `${neither.length} mutations state neither a colour filter nor a material`,
    });
  }

  // 6. The over set is a subset of the art table: it is read as a set of names the game tests before giving an
  //    icon a z-index, so a name the art table does not state is a name nothing can be drawn for.
  const overOffenders = tables.overMutations.filter(
    (mutation) => !Object.hasOwn(tables.mutationArt, mutation),
  );
  if (overOffenders.length > 0) {
    failures.push({
      check: 'mutation-over-set: every member is a mutation the art table states',
      table: 'overMutations',
      saw: capped(overOffenders),
      detail: `${overOffenders.length} of ${tables.overMutations.length} over-set members are not in the art table`,
    });
  }

  // 7. Every plant sprite is in the name table, and every harvest type a plant states is a member of the
  //    harvest enum -- unless the plant table states harvest types as literals, in which case there is no enum
  //    to check against and the coverage of the enum predicate says so.
  const plantOffenders = plantSpritesOf(tables.plants).filter((path) => !namePaths.has(path));
  if (plantOffenders.length > 0) {
    failures.push({
      check: 'plant-table: every sprite it names is in the name table',
      table: 'plants',
      saw: capped(plantOffenders),
      detail: `${plantOffenders.length} plant sprite paths are not in the name table`,
    });
  }
  const harvestMembers = new Set(Object.keys(tables.harvestTypes));
  if (harvestMembers.size > 0) {
    const harvestOffenders: string[] = [];
    for (const [name, record] of Object.entries(tables.plants)) {
      for (const part of [record.seed, record.plant, record.crop]) {
        if (part?.harvestType != null && !harvestMembers.has(part.harvestType)) {
          harvestOffenders.push(`${name}: ${part.harvestType}`);
        }
      }
    }
    if (harvestOffenders.length > 0) {
      failures.push({
        check: 'harvest-type-enum: every harvest type a plant states is a member',
        table: 'harvestTypes',
        saw: capped(harvestOffenders),
        detail: `${harvestOffenders.length} plants state a harvest type the enum does not name`,
      });
    }
  }

  // 8. The icon fills are keyed by the strings the game's own item-type enum *assigns*, exactly once each:
  //    a consumer passes the enum's literal as `itemType`, so a key that is only the enum's member name -- or
  //    a literal with no fill -- is a string nobody can ask with. This is the same shape as the harvest-type
  //    check above, one level stricter: there the member name is what a plant states, here the literal is what
  //    a caller states, and the two chunks that state them are different ones.
  const iconOffenders: string[] = [];
  const literalCounts = new Map<string, number>();
  for (const literal of Object.values(tables.itemTypes)) {
    literalCounts.set(literal, (literalCounts.get(literal) ?? 0) + 1);
  }
  for (const kind of Object.keys(tables.iconFills)) {
    if (!literalCounts.has(kind)) iconOffenders.push(`${kind}: not an item-type literal`);
  }
  for (const [literal, count] of literalCounts) {
    if (count !== 1) iconOffenders.push(`${literal}: ${count} members assign it`);
    else if (!Object.hasOwn(tables.iconFills, literal)) iconOffenders.push(`${literal}: no icon fill`);
  }
  if (iconOffenders.length > 0) {
    failures.push({
      check: "icon-fill-table: every item type is a literal the game's item-type enum assigns exactly once",
      table: 'iconFills',
      saw: capped(iconOffenders),
      detail: `${iconOffenders.length} item-type literals do not have exactly one icon fill`,
    });
  }

  return failures;
}

/** The same check over a stamped data file, for a caller that has one and not a table set. */
export function validateArtData(data: ArtData, atlas: AtlasFrames): readonly ValidationFailure[] {
  return validateTables(data.tables, atlas);
}
