/**
 * The two kind families are two enums: no item kind is a tile's `objectType`, and no tile kind is an item's
 * `itemType`.
 *
 * ## Why this file exists
 *
 * §7 S3 of `docs/plans/2026-09-19-typed-kind-views.md` names the defect: this library spelled the game's two
 * kind enums with one name. `E` is capitalised (`Seed`, `Produce`, `Plant`, `Tool`, `Pet`, `Egg`, `Decor` — the
 * save's `itemType` values) and `N` is lowercase (`plant`, `egg`, `decor`, `crystal` — a tile's `objectType`
 * values), and neither enum declares a member of the other. `TileBase.objectType` was typed by the first while
 * a tile states the second, which is a kind family typed by another family's enum — the same class of defect
 * as the item hole §1.1 of the plan reports. The two unions narrowed anyway, because each tile arm redeclares
 * its own lowercase literal over the base's, which is why the misnomer never surfaced as a bug.
 *
 * Splitting the name is the fix and this file is the measurement. The assertion is the `Assert`-style compile
 * check `tests/client-contract.test.ts` established for a claim only the type system can state: "is not
 * assignable" is a negative claim, and a negative claim cannot be written as an assignment that must compile.
 * `Extract` asks it member by member — `Extract<A, B>` keeps the members of `A` that `B` accepts — so wrapping
 * the result in a tuple and testing it against `never` is true exactly when the two share no declared kind.
 *
 * ## The field that is measured, and the one that is not
 *
 * The assertion is against `TileBase['objectType']`, the shared discriminant, rather than `Tile['objectType']`.
 * The latter is already the four lowercase kinds plus the empty one — each of the five arms redeclares its own
 * literal over the base's — so an assertion against it passed before this split too and measures nothing. What
 * the arms inherit, and what a sixth arm would inherit, is the base's field, and that is what was wrong.
 *
 * The `(string & Record<never, never>)` tail the item enum carried is the reason this is measured by
 * assignability rather than by reading the declaration: the tail accepts *every* string literal, so a tile kind
 * that kept one would accept `'Seed'` and the first assertion below would fail. The plan's T6 text asked for
 * the tail on `TileKind`; it is not there, because `reader.ts`'s arms state the narrowed literal on each
 * branch, a kind none of the four declares reads as `''`, and `TileBase.objectType` is `TileKind | ''` for
 * exactly that reason.
 *
 * ## The runtime half
 *
 * Nothing changes at runtime, but the claim the typing rests on is a runtime one: each reader's arms compare
 * its own enum's spellings, so a save that spells a tile with the item enum does not read as that kind. That
 * is driven through both real readers below, because two readers that returned `''` for everything would agree
 * with the compile check while stating no kind at all.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TileBase, TileType } from '../../src/state/entities.js';
import type { InventoryItem } from '../../src/state/items/base.js';
import { toInventoryItem, toTile } from '../../src/state/reader.js';

/** Resolves to `true`, or the file stops compiling. */
type Assert<T extends true> = T;

/** The members of `A` that `B` accepts: the empty union exactly when the two have none in common. */
type Common<A, B> = Extract<A, B>;

/**
 * A family's declared kinds, without the empty kind.
 *
 * `''` is on both sides and is meant to be: it is the arm each reader falls back to for a spelling its own
 * enum does not declare (`OtherItem`/`OtherTile`), so it is the one member the two families share, and the
 * claims below are about the kinds they declare.
 */
type Declared<T> = Exclude<T, ''>;

/** The four the game's own tile schema declares, quoted in §1 of the plan. */
type GameTileKinds = 'plant' | 'egg' | 'decor' | 'crystal';

/** No item kind is a tile's `objectType`. */
export type _NoItemKindIsATileKind = Assert<
  [Common<Declared<InventoryItem['itemType']>, Declared<TileBase['objectType']>>] extends [never]
    ? true
    : false
>;

/** And no tile kind is an item's `itemType`. */
export type _NoTileKindIsAnItemKind = Assert<
  [Common<Declared<TileBase['objectType']>, Declared<InventoryItem['itemType']>>] extends [never]
    ? true
    : false
>;

/** The tile family is closed at the four: a fifth tile kind is a decision here, not a string that compiles. */
export type _TileKindsAreTheDeclaredFour = Assert<
  [Declared<TileBase['objectType']>] extends [GameTileKinds] ? true : false
>;

void test('a spelling belongs to one family only: each reader reads the enum it states', () => {
  const tileType: TileType = 'Dirt';
  const plant = toTile(0, { objectType: 'plant', species: 'Clover' }, 0, '/garden/tileObjects/0', tileType);
  const item = toInventoryItem({ itemType: 'Plant', species: 'Clover' }, '/items/0');
  assert.equal(plant.objectType, 'plant');
  assert.equal(item.itemType, 'Plant');

  // The same kind in the other family's spelling. A tile saying `Plant` is a kind none of the four declares, so
  // it reads as no kind and the save's own spelling stays in the record — as an item saying `plant` does.
  const tileInTheItemSpelling = toTile(
    1,
    { objectType: 'Plant', species: 'Clover' },
    0,
    '/garden/tileObjects/1',
    tileType,
  );
  const itemInTheTileSpelling = toInventoryItem({ itemType: 'plant', species: 'Clover' }, '/items/1');
  assert.equal(tileInTheItemSpelling.objectType, '');
  assert.equal(itemInTheTileSpelling.itemType, '');
  assert.equal(tileInTheItemSpelling.record.string('objectType'), 'Plant');
});
