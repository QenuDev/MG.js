/**
 * Which sprite the game draws a thing from, and how large that sprite is drawn.
 *
 * The naming is the reason this is code rather than a convention: `Clover` is drawn from `CloverThreeLeaf`,
 * `Tomato` the picked crop is not `SproutVine` the vine that grows it, `Ambershine` is drawn from `Amberlit`,
 * and an inventory icon called `Hunger` has no sprite at all -- the art is `HungerCrystal`. None of those is
 * guessable from the other, which is why the consumer keeps a per-kind candidate list
 * (`garden-viewer/server.mjs:687-709`) and asks an index rather than building a URL
 * (`server.mjs:99-110`: "the naming is not uniform and is not guessable").
 *
 * The game's own tables state every one of those names, so there is nothing left to guess: a plant record
 * states a sprite per part, a mutation's art states its icon, its overlay and its ground, and a name the wire
 * states is either in the game's sprite-name table or is not a sprite the game has. This file reads those
 * records; it writes none of their values down.
 *
 * The two functions compose. `spriteName` answers the game's own key form, `sprite/<category>/<Name>` --
 * not a convention this package invented but the form the name table's leaves are written in and the form the
 * atlas is keyed by -- and `resolveSprite` turns that key into the frame the atlas states for it. `spriteName`
 * refuses a *name* it cannot resolve rather than stitching one together, and `resolveSprite` refuses anything
 * that is not already that key form, so a caller cannot end up drawing a URL nobody published.
 */

import type { FrameBox } from './model.js';

/**
 * The prefix every sprite path the game states begins with, and therefore the form `resolveSprite` is asked in.
 *
 * It is the shape the extractor's own predicate looks for in the name table ("an object literal whose leaf
 * strings are `sprite/<category>/<Name>` paths", `docs/art-provenance.md`), so it is the game's key form
 * rather than a convention added here.
 */
const SPRITE_PREFIX = 'sprite/';

/**
 * One category of the game's sprite-name table: the sprite's own name -> the path the atlas is keyed by.
 *
 * A category and not the whole table, because the same name is stated under two of them (`Aloe` is both a
 * plant and a seed) and the category is the caller's to know -- it is asking about a plant or about an
 * inventory icon -- rather than this package's to guess. `tables.spriteNames` is the whole table; a caller
 * passes the one category of the thing the record is about.
 */
export type SpriteNameMap = Readonly<Record<string, string>>;

/**
 * The atlas frame maps this package produces and its captures hold: `atlasPacks`' map, or a JSON object.
 *
 * Accepting both is not politeness: `@mg.js/art/source` returns a `Map` because it walks the packs, and a
 * capture on disk is an object keyed the same way, and a caller with either in hand should not have to build
 * the other one to ask a question this file can answer.
 */
export type SpriteFrames = ReadonlyMap<string, FrameBox> | Readonly<Record<string, FrameBox>>;

/** Whether a value is an object with fields, which is what a record the game states is. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The art one record states under one part's own name.
 *
 * Two shapes are stated by the game's own records and both are read directly: the part is the art's own path
 * (`plants` states `{plant: {sprite: 'sprite/plant/CloverThreeLeaf', harvestType: …}}`, `mutationArt` states
 * `{iconSprite: 'sprite/mutation/Amberlit'}`, a plant block states `{immatureSprite, topmostLayerSprite}`), or
 * the part is a record that holds the art under `sprite` (`activeState.sprite`). A part that states something
 * else -- a number, a nested table, nothing at all -- is `undefined` rather than a name this package made up.
 */
function statedArt(record: unknown, part: string): string | undefined {
  if (!isRecord(record)) return undefined;
  const stated = record[part];
  if (typeof stated === 'string') return stated;
  if (isRecord(stated) && typeof stated['sprite'] === 'string') return stated['sprite'];
  return undefined;
}

/**
 * The sprite the game's own table states for one part of a record, as the path the atlas is keyed by.
 *
 * `part` names what is wanted, in the game's own field name for it: `seed`, `plant` and `crop` for a species
 * (`plants`), `iconSprite`, `groundSprite` and `overlaySprite` for a mutation's art (`mutationArt`),
 * `immatureSprite`, `activeState` and `topmostLayerSprite` for a plant block. The record supplies that part's
 * art, and nothing else is consulted -- the tables already state resolved paths, because the extractor
 * resolves every reference through the sprite-name table and refuses a build where one does not resolve.
 *
 * `byName` is that name table's category for the kind of thing the record is (`spriteNames.Item` for an
 * inventory icon), and it is what makes a record that states a *name* rather than a path -- a wire record, or
 * the sprite's own name the game builds -- either a path or `null`. A name the game's table does not state is
 * `null`, which is the whole point: the consumer's candidate list builds `HungerCrystal` from `Hunger` and
 * hopes, and the table is what says whether the guess was a sprite.
 */
export function spriteName(record: unknown, part: string, byName?: SpriteNameMap): string | null {
  const stated = statedArt(record, part);
  if (stated === undefined || stated === '') return null;
  // A path is already the form the atlas is keyed by. A bare name is not, and is resolved through the game's
  // own table for the category the caller named -- or refused, rather than turned into a path here.
  if (stated.startsWith(SPRITE_PREFIX)) return stated;
  const found = byName?.[stated];
  return typeof found === 'string' ? found : null;
}

/**
 * The frame the atlas states for one sprite, or `null` when it states none.
 *
 * `path` is the game's key form, `sprite/<category>/<Name>` -- what `spriteName` answered, or a path a caller
 * read out of the tables itself. Anything else is `null`: a bare name is not a key this package will build,
 * which is what keeps the two functions' jobs apart. A map that does not hold the path answers `null` too,
 * and that is a real answer rather than an error -- the atlas is republished with the game, and a frame this
 * capture does not hold is not a frame the caller can draw.
 */
export function resolveSprite(frames: SpriteFrames, path: string): FrameBox | null {
  if (!path.startsWith(SPRITE_PREFIX)) return null;
  if (frames instanceof Map) return frames.get(path) ?? null;
  const found = (frames as Readonly<Record<string, FrameBox | undefined>>)[path];
  return found ?? null;
}
