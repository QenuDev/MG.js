/**
 * What an inventory entry draws, and how much of its icon box it fills.
 *
 * `ICON_FILL` is the share table the consumer used to keep in the page (`page.html:1203`): every icon the game
 * draws is one 256-pixel frame, and the art inside it is fitted to a share of that frame that depends on the
 * kind -- a whole frame for a seed, a tool, an egg, decor and a pet, 0.4 for produce and 0.6 for a potted
 * plant. The values are not written down here as *knowledge*: they are the extraction's, `data/<version>.json`
 * carries each one beside how the game stated it (`stated`, the fit function's `fit-default`, or the pet's
 * `bake-frame`), and `tests/icon-art.test.ts` asserts this table against that file rather than trusting that
 * somebody kept them in step.
 *
 * `iconArt` is the other half. A caller with an inventory entry and the tables in hand gets the sprite the game
 * draws the icon from and the frame the atlas states for it -- or, for the two kinds that are not one sprite,
 * the fact that they are not: a potted plant's icon is an assembled picture (the package's `plantPicture`), and
 * a pet's is a portrait baked from Rive, which is also why neither has a share the game writes down.
 *
 * Nothing here invents a name. A species part comes from the plant record, a bare id is looked up in the
 * game's own sprite-name table, and a name two categories state -- `Aloe` is a plant and a seed -- is refused
 * rather than picked between, which is the rule the extractor follows for the same reason.
 */

import type { FrameBox } from './model.js';
import { resolveSprite, type SpriteFrames, spriteName } from './sprite.js';

/** The item kinds the game's own item-type enum names, which is what an inventory entry states. */
export type IconType = 'Seed' | 'Produce' | 'Plant' | 'Tool' | 'Egg' | 'Decor' | 'Pet';

/**
 * The share of the 256-pixel icon box each kind's art fills.
 *
 * The published table, the page's own seven numbers. It is asserted against `data/1176.json`'s extraction, so
 * the two cannot drift; the extraction is where the *evidence* per kind lives.
 */
export const ICON_FILL: Readonly<Record<IconType, number>> = {
  Seed: 1,
  Produce: 0.4,
  Plant: 0.6,
  Tool: 1,
  Egg: 1,
  Decor: 1,
  Pet: 1,
};

/** How the game draws one kind of icon: one sprite, an assembled picture, or a baked portrait. */
export type IconArtKind = 'sprite' | 'picture' | 'baked';

/** One inventory entry, as much of it as an icon needs. */
export interface IconEntry {
  /** The game's item-type literal: `Seed`, `Produce`, `Plant`, `Tool`, `Egg`, `Decor` or `Pet`. */
  readonly itemType: string;
  /** A species' id, for the kinds that draw species art (`Seed`, `Produce`, `Plant`, `Pet`). */
  readonly species?: string | null | undefined;
  readonly toolId?: string | null | undefined;
  readonly eggId?: string | null | undefined;
  readonly decorId?: string | null | undefined;
}

/** What a caller has to hand: the extracted tables, and the atlas frames if it wants the frame too. */
export interface IconArtTables {
  /** The plant table, keyed by species, for the parts a species states. */
  readonly plants?: Readonly<Record<string, unknown>> | undefined;
  /** The sprite-name table, by category, for the ids that are bare names. */
  readonly spriteNames?: Readonly<Record<string, Readonly<Record<string, string>>>> | undefined;
  /** The atlas frames, so a resolved sprite can come back with the frame it is drawn in. */
  readonly frames?: SpriteFrames | undefined;
  /** The extracted fill table, when the caller wants the share from the game version it read. */
  readonly fills?: Readonly<Record<string, { readonly fill: number }>> | undefined;
}

/** One entry's icon: which of the three ways the game draws it, and at what share of the icon box. */
export interface IconArt {
  /** The share of the icon box to fit the art to. */
  readonly fill: number;
  readonly kind: IconArtKind;
  /** The game's own sprite path, when the kind is one sprite the tables state. */
  readonly sprite: string | null;
  /** The atlas frame for `sprite`, when the caller handed the frames in and the atlas states one. */
  readonly frame: FrameBox | null;
}

/** The kinds the game composes rather than draws from one sprite. */
const COMPOSED_KINDS: Readonly<Record<string, IconArtKind>> = {
  Plant: 'picture',
  Pet: 'baked',
};

/** The entry field that names a kind's art, for the kinds whose id is a bare name. */
const ID_FIELDS: Readonly<Record<string, keyof IconEntry>> = {
  Tool: 'toolId',
  Egg: 'eggId',
  Decor: 'decorId',
};

/**
 * The share for one kind: the caller's extracted table when it handed one in, and the published table
 * otherwise. A kind neither names keeps the fit's own default of 1, which is also what the page does today.
 */
function fillFor(kind: string, fills: IconArtTables['fills']): number {
  const extracted = fills?.[kind]?.fill;
  if (typeof extracted === 'number') return extracted;
  const published = (ICON_FILL as Readonly<Record<string, number>>)[kind];
  return published ?? 1;
}

/**
 * The sprite a species' part is drawn from, read from the plant record and the name table's own category.
 *
 * The record states either the path itself or a name the category resolves; a species the table does not hold,
 * or a part it does not state, is `null` rather than a name built here.
 */
function speciesSprite(entry: IconEntry, art: IconArtTables, part: 'seed' | 'crop'): string | null {
  const species = entry.species;
  if (typeof species !== 'string' || species === '') return null;
  const record = art.plants?.[species];
  const byName = art.spriteNames?.[part === 'seed' ? 'Seed' : 'Plant'];
  return spriteName(record, part, byName);
}

/**
 * The sprite a bare id is drawn from, looked up across the game's own name table.
 *
 * A tool, an egg and a decoration are each named by an id the game's table holds under a category of its own,
 * and the categories are the game's rather than a convention this package adds. A name two categories state
 * with different paths -- which is a real case, `Aloe` -- is ambiguous for a caller that stated only an id, so
 * it is refused; the same name under two categories that agree is one answer and is kept.
 */
function namedSprite(entry: IconEntry, art: IconArtTables): string | null {
  const field = ID_FIELDS[entry.itemType];
  const id = field === undefined ? undefined : entry[field];
  if (typeof id !== 'string' || id === '') return null;
  const stated = new Set<string>();
  for (const members of Object.values(art.spriteNames ?? {})) {
    const path = members[id];
    if (typeof path === 'string') stated.add(path);
  }
  return stated.size === 1 ? ([...stated][0] ?? null) : null;
}

/**
 * The sprite an inventory entry draws, the frame it is drawn in, and the share of the icon box it fills.
 *
 * `Plant` and `Pet` are the two kinds that are not one sprite: a potted plant's icon is the assembled picture
 * `plantPicture` describes, and a pet's is a portrait baked from Rive rather than a sprite in the atlas. Both
 * come back with `sprite: null` and their own `kind`, because answering `sprite/item/Plant` for the first would
 * name a sprite the game does not state, and a pet has no atlas sprite to answer with at all.
 */
export function iconArt(entry: IconEntry, art: IconArtTables = {}): IconArt {
  const fill = fillFor(entry.itemType, art.fills);
  const kind = COMPOSED_KINDS[entry.itemType];
  if (kind !== undefined) return { fill, kind, sprite: null, frame: null };

  const sprite =
    entry.itemType === 'Seed'
      ? speciesSprite(entry, art, 'seed')
      : entry.itemType === 'Produce'
        ? speciesSprite(entry, art, 'crop')
        : namedSprite(entry, art);
  const frame = sprite === null || art.frames === undefined ? null : resolveSprite(art.frames, sprite);
  return { fill, kind: 'sprite', sprite, frame };
}
