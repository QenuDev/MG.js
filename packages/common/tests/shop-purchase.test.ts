/**
 * The one action whose params are a **discriminated union**, and the silence it fails into.
 *
 * `PurchaseShopItem` takes an item that the game's own command schema states as four arms — the kind, and the
 * one id field that kind is named by:
 *
 *   Seed  → species   Egg → eggId   Tool → toolId   Decor → decorId
 *
 * (protocol field guide §4.4, which the registry's entry for this action already cites, and which the game
 * bundle's own client agrees with: its outbound schema is
 * `x("itemType", [v({itemType: Seed, species}), v({itemType: Egg, eggId}), v({itemType: Tool, toolId}),
 * v({itemType: Decor, decorId})])`, and its normaliser `RW(e)` switches the same four ways.)
 *
 * Until this file existed the union was typed as `{ itemType: string } & Record<string, unknown>` and nothing in
 * this package ever called the method, so a caller could post the *shop's* row — `{itemId, itemType, name,
 * coinPrice, stock}` — and get no compile error and no test failure. What it got instead was silence: the server
 * does not answer a command whose item it cannot parse, so the command was never acknowledged and the client's
 * sequencer reported it as `dropped as stale` — a protocol diagnostic, minutes later, about the one thing the
 * caller could have been told immediately: the id field is missing.
 *
 * That is the same class of defect the form registry exists to prevent (`forms.test.ts`: "the documented failure
 * mode for getting a form wrong is *silence*"), one level down: the form was right, the params were not.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GameActions } from '../src/actions/game-actions.js';
import type { CommandResult, CommandSender } from '../src/actions/handle.js';
import { CommandHandle } from '../src/actions/handle.js';
import { isShopPurchaseItem, type ShopPurchaseItem } from '../src/actions/params.js';

/** A sender that records what the action layer produced. Same shape as `forms.test.ts`'s. */
function recordingSender(): {
  sender: CommandSender;
  calls: { action: string; params: Record<string, unknown> }[];
} {
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  const sender: CommandSender = {
    send(action, params = {}) {
      calls.push({ action, params });
      const never = new Promise<CommandResult>(() => {});
      return new CommandHandle(action, 'req', 1, never, Promise.resolve(null));
    },
  };
  return { sender, calls };
}

describe('the shop purchase item union', () => {
  it('accepts each of the four arms the game states, and names the field each one uses', () => {
    const arms: ShopPurchaseItem[] = [
      { itemType: 'Seed', species: 'Carrot' },
      { itemType: 'Egg', eggId: 'CommonEgg' },
      { itemType: 'Tool', toolId: 'Shovel' },
      // The tool shop sells decor, which is why the field follows the kind and not the shop.
      { itemType: 'Decor', decorId: 'SeedSilo' },
    ];
    for (const item of arms) {
      assert.equal(isShopPurchaseItem(item), true, `${item.itemType} should be a valid item`);
    }
  });

  it('refuses the shop row this app used to post, which is the bug it exists to catch', () => {
    // The live platform payload's row, verbatim in shape. It has an `itemType` and no `species`, which is
    // exactly the command the server ignored: the union's arm is absent, so the id is absent.
    assert.equal(
      isShopPurchaseItem({
        itemId: 'Carrot',
        itemType: 'Seed',
        name: 'Carrot Seed',
        coinPrice: 10,
        stock: 13,
      }),
      false,
    );
  });

  it('refuses an item whose id field does not match its kind', () => {
    // The two ways to get the field wrong: the other arm's field, and the field this app's own reading calls it.
    assert.equal(isShopPurchaseItem({ itemType: 'Seed', toolId: 'Carrot' }), false);
    assert.equal(isShopPurchaseItem({ itemType: 'Decor', itemId: 'SeedSilo' }), false);
    assert.equal(isShopPurchaseItem({ itemType: 'Tool', species: 'Shovel' }), false);
  });

  it('refuses a missing, empty or non-string id, and a kind the union does not state', () => {
    assert.equal(isShopPurchaseItem({ itemType: 'Seed' }), false);
    assert.equal(isShopPurchaseItem({ itemType: 'Seed', species: '' }), false);
    assert.equal(isShopPurchaseItem({ itemType: 'Seed', species: 7 }), false);
    // No fifth arm: the game's own normaliser returns `undefined` for anything else, and a guessed field name is
    // the same silent drop again.
    assert.equal(isShopPurchaseItem({ itemType: 'Curio', itemId: 'Mystery' }), false);
    assert.equal(isShopPurchaseItem({ itemType: 'seed', species: 'Carrot' }), false);
  });

  it('refuses everything that is not an object with a kind', () => {
    for (const value of [null, undefined, 'Seed', 7, [], ['Seed', 'Carrot']]) {
      assert.equal(isShopPurchaseItem(value), false);
    }
  });

  it("tolerates the extra fields the game's own item carries", () => {
    // The game's client narrows its rich item down with `RW(e)` before sending, but whether the *server* minds an
    // extra field is not something this package has evidence for. Requiring the arm is what catches a missing or
    // mismatched id; refusing a richer object would refuse a purchase the game might have taken, which is the
    // wrong direction for a guard to fail in.
    assert.equal(
      isShopPurchaseItem({
        itemType: 'Tool',
        toolId: 'Shovel',
        name: 'Garden Shovel',
        coinPrice: 1_000_000,
        rarity: 'Uncommon',
      }),
      true,
    );
  });
});

describe('purchaseShopItem', () => {
  it('sends the shop and the item, and nothing else', () => {
    const { sender, calls } = recordingSender();
    new GameActions(sender).purchaseShopItem({
      shop: 'seed',
      item: { itemType: 'Seed', species: 'Carrot' },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.action, 'PurchaseShopItem');
    // The two fields the wire takes. The item is the union's own arm, not this app's reading of a shop row.
    assert.deepEqual(calls[0]?.params, {
      shop: 'seed',
      item: { itemType: 'Seed', species: 'Carrot' },
    });
  });

  it('refuses an item the game cannot parse instead of sending a command that will be ignored', () => {
    // The guard's whole value: this is the difference between an immediate, named failure and a command that is
    // reported as `dropped as stale` a minute later.
    const { sender, calls } = recordingSender();
    const actions = new GameActions(sender);

    assert.throws(
      () =>
        actions.purchaseShopItem({
          shop: 'seed',
          // The shape a caller reaches for when it has a shop row in hand.
          item: { itemId: 'Carrot', itemType: 'Seed' } as never,
        }),
      (error: Error) => {
        // The message has to name the arms, or a caller reads "refused" and has to go and find the union.
        assert.match(error.message, /species/);
        assert.match(error.message, /eggId/);
        assert.match(error.message, /toolId/);
        assert.match(error.message, /decorId/);
        // And it should say what the caller actually handed over, since that is what they are looking at.
        assert.match(error.message, /Seed/);
        return true;
      },
    );
    // **Nothing was sent**: this is the point of the guard, and the reason it is a throw rather than a comment.
    assert.equal(calls.length, 0);
  });
});

/**
 * The union against the game's own extracted schemas.
 *
 * The four arms above are a transcription, and a transcription that is only asserted against itself agrees with
 * whoever wrote it. This block reads the other side: `kindSchemas` in `packages/art/data/<newest>.json`, the table
 * the art package's predicate cut out of the game's client bundle (`art:sync --check` in the root `verify` proves
 * the committed file is that extraction). For each kind the union states, the id field it requires has to be a
 * field the game's own schema for that kind **requires** — so a rename in the bundle moves the data, `art:sync`
 * moves with it, and this gate fails rather than leaving the union quietly wrong.
 *
 * The file is read **by path** and not through `@mg.js/art`, for the reason
 * `tests/state/items/kind-completeness.test.ts` states: `common` must not depend on `art`. The newest shipped
 * version is resolved the same way, by name sort, so a version bump moves this gate with the pipeline. A missing
 * file or a table without `kindSchemas` **throws rather than skips**: a gate that cannot fail is not a gate.
 */
describe("the union against the game's extracted kind schemas", () => {
  /** The committed extraction, two directories up: `tests` -> `packages/art/data`. */
  const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../art/data');

  /** One schema arm, to the shape `packages/art/src/bundle/tables.ts` states it. */
  interface Arm {
    readonly fields: readonly { readonly name: string; readonly required?: boolean }[];
    readonly spreads: readonly string[];
  }

  function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /** The newest version `packages/art/data` ships, resolved the way `load-fixture.ts` resolves it. */
  function newestVersion(): string {
    const versions = readdirSync(DATA_DIR)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort();
    const newest = versions.at(-1);
    if (newest === undefined) throw new Error('packages/art/data ships no extraction to check against');
    return newest;
  }

  /**
   * The field names the game's schema **requires** for one kind, following the arms it spreads.
   *
   * Throws on anything unreadable rather than walking past it: a table this gate cannot read is a gate that is
   * not checking the claim it exists to check.
   */
  function requiredFieldsFor(kind: string): Set<string> {
    const file = JSON.parse(readFileSync(resolve(DATA_DIR, `${newestVersion()}.json`), 'utf8')) as unknown;
    if (!isObject(file) || !isObject(file.tables)) throw new Error('the extraction states no tables');
    const schemas = file.tables.kindSchemas;
    if (!isObject(schemas) || !isObject(schemas.items) || !isObject(schemas.arms)) {
      throw new Error('the extraction states no kindSchemas table');
    }
    const arms = schemas.arms as Record<string, Arm>;
    const kinds = schemas.items as Record<string, unknown>;
    const declared = kinds[kind];
    if (!Array.isArray(declared)) throw new Error(`the extraction states no arms for ${kind}`);

    const names = new Set<string>();
    const visit = (armId: unknown): void => {
      if (typeof armId !== 'string') throw new Error(`${kind} names an arm that is not a string`);
      const arm = arms[armId];
      if (arm === undefined) throw new Error(`${kind} names arm ${armId}, which the table does not state`);
      for (const field of arm.fields) if (field.required !== false) names.add(field.name);
      for (const spread of arm.spreads) visit(spread);
    };
    for (const armId of declared) visit(armId);
    return names;
  }

  it("states each kind's id field exactly as the game's own schema requires it", () => {
    const expected: Record<string, string> = {
      Seed: 'species',
      Egg: 'eggId',
      Tool: 'toolId',
      Decor: 'decorId',
    };

    for (const [kind, field] of Object.entries(expected)) {
      const required = requiredFieldsFor(kind);
      assert.equal(required.has('itemType'), true, `${kind} should require itemType`);
      assert.equal(required.has(field), true, `${kind} should require ${field}, as the union states`);
      // And the union's own predicate agrees with the game about that arm, which is what makes the guard above
      // enforce the same rule the schema does.
      assert.equal(isShopPurchaseItem({ itemType: kind, [field]: 'anything' }), true);
    }
  });

  it('states the kinds a shop sells by quantity, and no others', () => {
    // Corroboration rather than the source of the rule — the command's union is the source. The four arms are the
    // four item kinds whose own schema carries a `quantity`, which is also what the live platform payload shows:
    // ten shops, four kinds (`Seed`, `Egg`, `Tool`, `Decor`), and never a Pet, a Plant or Produce. If the game
    // ever gives a fifth kind a quantity — a new thing to buy — this fails, which is the moment to look at the
    // union rather than the moment to trust it.
    const byQuantity = ['Decor', 'Egg', 'Pet', 'Plant', 'Produce', 'Seed', 'Tool'].filter((kind) =>
      requiredFieldsFor(kind).has('quantity'),
    );
    assert.deepEqual(byQuantity.sort(), ['Decor', 'Egg', 'Seed', 'Tool']);
  });
});
