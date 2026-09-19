# Typed kind views: an inventory item is the game's seven schemas, discriminated

**Status:** proposed, for review. Nothing in here is implemented.
**Scope:** `@mg.js/common/state` (types, reader, tests) plus one extraction in `@mg.js/art/bundle`, and the
downstream migration it unblocks. No other package changes: measured, and §9 says why.
**Evidence base:** the game's own client bundle 1192 (`mgafk-pi/json/bundle-1192-0`, and the three committed
fixture chunks in `packages/art/fixtures/bundle-1192/chunks`), `docs/DESIGN.md`, `docs/audit/02-common-state.md`,
`docs/audit/30-verified-*.md`, the commit that discriminated `Tile` (`ac7bcb5`), and the two consumer readers
(`garden-viewer/garden.mjs`, `garden-viewer-svelte/src/lib/domain/payload/item.ts`).
**Measured at the boundary (2026-09-19, `ce6c681`):** `npm run verify` green — lint, typecheck (source and
tests), build, **1,145 tests / 0 fail / 0 skipped** (art 210, bootstrapped 238, common 492, headless 205),
`art:sync --check` current at bundle 1192 (offline, against the committed fixture), `docs:check` 808 symbols
across 46 modules.

---

## 0. Where this came from

A viewer built on this library showed a pet's card as:

```
Weight 0.00   Age 0 h
Strength 50 / 80
Hunger 0%
```

for a level-80 Sheep, 165 kg, 412 hours old, hunger 185. Every one of those is `0` because the four fields the
card needs are not on the object the reader hands out:

| field | the game states it | `InventoryItem` exposed it |
|---|---|---|
| `xp` | `1483200` | `undefined` |
| `hunger` | `185` | `undefined` |
| `targetScale` | `1.03125` | `undefined` |
| `abilities` | `['DawnCoinFinder', 'RainbowGranter', 'DawnbinderBoost']` | `undefined` |

`mutations` **did** come through — a shared field — which is exactly what made this look like a bug in the
viewer. The viewer has since been taught to read `entry.record.raw.xp` and its card is correct
(`garden-viewer-svelte` commit `1d5e94e`), but that is a workaround in a consumer for a hole in this library's
model, and the next consumer will write the same workaround or the same bug. **This plan closes the hole where
it is.**

## 1. What the game declares, and what this library models

The game's inventory item is a **union of seven schemas**, in its own bundle
(`worldDepthSortKey-BXUHHrP0.js`, commit-1192 offsets ~634098-634513). Quoted below with the minified names
kept and line breaks added — the chunk itself is one line, and nothing but whitespace is changed:

```js
ga = d({ species: L, startTime: U, endTime: U, size: ta, mutations: x(yi),
         x: c(h()), y: c(h()), rotation: c(h()), flipped: c(t()), preserved: c(t()), slotId: h() })
_a = d({ id: _, species: L, itemType: n(E.Produce), size: ta, mutations: x(yi) })
va = d({ species: L, itemType: n(E.Seed), quantity: y(h(), r(1)) })
ya = f([ d({ toolId: Gn, itemType: n(E.Tool), quantity: y(h(), r(1)) }),
         d({ id: _, toolId: cn, itemType: n(E.Tool), quantity: n(1),
             remainingActiveSeconds: y(h(), b(), r(0), a(an)) }) ])
ba = d({ id: _, species: L, itemType: n(E.Plant), slots: x(ga), plantedAt: U, maturedAt: U })
xa = d({ eggId: j, itemType: n(E.Egg), quantity: y(h(), r(1)) })
Sa = { ...aa, itemType: n(E.Pet) }
Ca = d({ ...Sa, sourceEggId: j, abilityCooldowns: ia, equippedCosmetics: oa })
wa = d({ ...Sa, sourceEggId: c(j), abilityCooldowns: c(ia), equippedCosmetics: c(oa) })
Ta = f([ _a, va, ya, ba, xa, Ca, d({ decorId: Ln, itemType: n(E.Decor), quantity: y(h(), r(1)) }) ])
```

`aa`, the pet's own base, is at ~633198:

```js
aa = { id: _, petSpecies: Qt, name: te(_()), xp: y(h(), r(0)), hunger: y(h(), r(0)),
       mutations: x(yi), targetScale: y(h(), r(0)), abilities: x(qt) }
```

Three things follow, and each is a task below.

1. **`Ta` is the union this library should expose**, field for field. Today's `InventoryItem`
   (`packages/common/src/state/entities.ts:481-528`) is *one* interface carrying what every kind shares plus
   an escape hatch, so a pet's `xp`, `hunger`, `targetScale`, `abilities`, `sourceEggId`, `abilityCooldowns`
   and `equippedCosmetics` are reachable only by name; so are a potted plant's `plantedAt`/`maturedAt`, which
   `ba` declares and the view does not carry.
2. **The game's own pet schema has two variants** — `Ca` (the extras required) and `wa` (the extras optional) —
   and `Ta` uses `Ca`. The library should say which one it models rather than flatten it silently.
3. **The item kind enum is not the tile kind enum.** `E` (~3919) is
   `{Seed, Produce, Plant, Tool, Pet, Egg, Decor}` — capitalised, the `itemType` values. A tile's `objectType`
   is the other enum, `N`, whose values are lowercase (`'plant'`, `'egg'`, `'decor'`, `'crystal'`, the arms of
   `reader.ts:415-436`). `entities.ts:272` types `TileBase.objectType` as `ItemType`, which is the *item* enum;
   §7 S3.

### 1.1 The test that named the hole without looking into it

`packages/common/tests/state/reader.test.ts:247` is titled **"a player carries the whole inventory, and every
kind of item reads its own fields"**, walks all seven kinds, and asserts for the pet arm only:

```ts
assert.equal(byKind('Pet')[0]?.species, 'Fox');
assert.equal(byKind('Pet')[0]?.name, 'Rusty');
```

Both of those are shared fields. The fixture 100 lines above (`:147-157`) already carries the pet's own four:

```ts
{ itemType: 'Pet', id: 'pet_bag', petSpecies: 'Fox', name: 'Rusty',
  xp: 10, hunger: 50, mutations: [], targetScale: 1, abilities: [] }
```

So the evidence was in the test file, the title claimed it was covered, and the assertion could not see it.
This is why §6's gate is a *completeness* gate rather than one more assertion: a test that lists the fields a
human remembered is a test that agrees with the model.

### 1.2 The library's own stated version is stale

`entities.ts:8` and `:74` say every field here was read from "the game's own client bundle (**version
1171**)". `packages/art/data/` holds `1176.json` **and** `1192.json`; `art:sync --check` is current at 1192; the
bundle the schemas above are quoted from is 1192. The model's evidence line is two versions behind its own
pipeline. §6 T0 re-states it at the version the pipeline is on, and makes the claim machine-checked so it
cannot drift again.

## 2. This library already solved this problem once — for tiles

`ac7bcb5`, *"a tile is the game's four schemas, discriminated"*: `entities.ts:240-366`, `reader.ts:393-441`,
`reader.test.ts` (+183 lines), `docs/api-surface.json` regenerated. `Tile` is
`PlantTile | EggTile | DecorTile | CrystalTile | OtherTile` on `objectType`, with a shared `TileBase`, and the
commit states the two rules this plan reuses:

> "Three readings are on every arm rather than on the kind that declares them, because a tile's own fields are
> read the same way whichever kind it is."
>
> "A kind none of the four declares is read as `OtherTile` — the empty kind — rather than refused or guessed
> at: a save that grows a fifth kind is still a save this reader can hand on, and the spelling it used is in
> the tile's own record."

and, on why the empty arm is a unit type (`entities.ts:349-358`):

> "an arm typed `string` is a supertype of every literal, which silently stops the whole union from narrowing.
> The save's own spelling is not lost: `TileBase.record` states it."

An inventory item is the same shape of problem, one arm per kind, and the same answer applies. **What this plan
does not do is invent a second mechanism.**

## 3. The target shape

One new module family under `packages/common/src/state/items/` (§4), and this is its public surface:

```ts
/** What every inventory item carries, whichever kind it is. `itemType` is the discriminant of InventoryItem. */
export interface InventoryItemBase extends StateView {
  readonly entityPath: string;
  readonly itemType: ItemKind | '';        // '' is the kind this release does not declare
  readonly id: string;
  readonly species: string;                // the wire's `petSpecies` for a pet, `species` for the rest
  readonly name: string;
  readonly quantity: number;
  readonly size: number;
  readonly mutations: Mutation[];
  readonly toolId: string;
  readonly remainingActiveSeconds: number;
  readonly hasLife: boolean;
  readonly eggId: string;
  readonly decorId: string;
  readonly crops: Crop[];                  // a potted plant's `slots`, read with the crop reader
  readonly record: StateRecordLike;        // the escape hatch, unchanged and still the only string field name
}

/** The fields a pet has **wherever it is carried** — a pet slot, a bag, a hutch. One list, so they cannot drift. */
export interface PetFields {
  readonly species: string;
  readonly name: string;
  readonly xp: number;
  readonly hunger: number;
  readonly targetScale: number;
  readonly mutations: Mutation[];
  readonly abilities: string[];
  readonly sourceEggId: string;            // '' when the save states none (the game's `wa` variant)
  readonly abilityCooldowns: Readonly<Record<string, number>>;
}

export interface PetItem extends InventoryItemBase, PetFields { readonly itemType: 'Pet' }
export interface SeedItem extends InventoryItemBase { readonly itemType: 'Seed'; /* species, quantity */ }
export interface ProduceItem extends InventoryItemBase { readonly itemType: 'Produce'; /* species, size, mutations */ }
export interface PlantItem extends InventoryItemBase { readonly itemType: 'Plant'; readonly plantedAt: number; readonly maturedAt: number }
export interface ToolItem extends InventoryItemBase { readonly itemType: 'Tool'; readonly toolId: string; readonly hasLife: boolean }
export interface EggItem extends InventoryItemBase { readonly itemType: 'Egg'; readonly eggId: string; readonly quantity: number }
export interface DecorItem extends InventoryItemBase { readonly itemType: 'Decor'; readonly decorId: string }

/** A kind this release does not declare. The save's own spelling stays in `record`, as `OtherTile`'s does. */
export interface OtherItem extends InventoryItemBase { readonly itemType: '' }

export type InventoryItem = PetItem | SeedItem | ProduceItem | PlantItem | ToolItem | EggItem | DecorItem | OtherItem;
```

The per-arm field lists in that sketch are the ones `Ta` declares, minus what the base already carries. **The
exact lists are an output of T0, not of this document**: three of them (`PlantItem.plantedAt`/`maturedAt`,
`PetItem.sourceEggId`/`abilityCooldowns`/`equippedCosmetics`, and the tool's two variants collapsing to one
`hasLife`) are already known to need a decision, and §11 asks about two of them.

The reader keeps one dispatch and one home per kind:

```ts
/** Read one kind's own fields off the entry's record. */
export type KindReader<K extends ItemKind> = (record: StateRecord) => Omit<ItemOfKind<K>, keyof InventoryItemBase>;

/** The one place a kind is registered. `satisfies` is what makes a missing or extra kind a compile error. */
export const ITEM_READERS = {
  Pet: readPet, Seed: readSeed, Produce: readProduce, Plant: readPlant,
  Tool: readTool, Egg: readEgg, Decor: readDecor,
} satisfies Record<ItemKind, KindReader<ItemKind>>;

/** The kinds, for a consumer that walks them generically (a dump, a count, a catalogue join). */
export const ITEM_KINDS = Object.keys(ITEM_READERS) as readonly ItemKind[];

export function toInventoryItem(value: unknown, entityPath: string, nowMs = 0): InventoryItem {
  const record = new StateRecord(value);
  const base = readBase(record, entityPath, nowMs);
  const stated = record.string('itemType');
  const reader = (ITEM_READERS as Record<string, KindReader<ItemKind> | undefined>)[stated];
  // One cast, here and only here: `satisfies` above proves every kind has a reader, and the lookup is by the
  // save's own string. Everything downstream of this line narrows without one.
  return reader === undefined ? { ...base, itemType: '' } : (reader(record) as InventoryItem);
}
```

*(The switch-with-no-cast alternative is one paragraph in §11; the registry is recommended because it is also
the runtime list a generic consumer needs, and `satisfies` gives the compile-time completeness a switch gives.)*

## 4. Modularity: where it lives, and why there

`docs/DESIGN.md:211-233` — "a concept gets a folder when it has ≥2 modules or it is a published subpath.
Every folder has an `index.ts` barrel. No module imports a barrel." Seven kinds × (types + a reader) + the base
+ the registry is well past two modules, and it is exactly the unit a game update touches, so:

```
packages/common/src/state/
  entities.ts        KEEPS the shared views (Crop, Garden, Storage, Player, Room, Tile) and loses InventoryItem
  items/
    index.ts         barrel: types, readers, ITEM_READERS, ITEM_KINDS
    base.ts          InventoryItemBase, ItemKind, ItemFields, ItemOfKind, OtherItem, the union
    pet.ts           PetFields, PetItem, readPet          <- PetFields is shared with entities' Pet (S2)
    produce.ts  seed.ts  plant.ts  tool.ts  egg.ts  decor.ts
    registry.ts      ITEM_READERS, ITEM_KINDS, itemKindOf()
  reader.ts          toInventoryItem dispatches into items/registry.ts; the rest of the reader is untouched
```

`docs/DESIGN.md:334-350` (tests mirror the source) puts the tests at `packages/common/tests/state/items/*`:
`base.test.ts` (the union narrows), `pet.test.ts` (the arm's own fields, and the shared list with the slot
pet), and one `reader.test.ts` case per kind extended in place — the existing item test at `:247` keeps its
name and finally earns it.

**Adding a kind is adding a module and a line**: a new `ItemFields` entry (which fails the `satisfies` until
`ITEM_READERS` has it), a loader for it in `items/`, and nothing else anywhere in the package. That is the
property the user asked for, and it is the property the *tile* union already has.

## 5. Adaptability: what happens when the game changes

| the game does | what happens | what tells us |
|---|---|---|
| adds a field to a kind it already has | `OtherItem` is not involved; the arm is missing a field a consumer may want | **T0's extracted list vs the arm — a red test**, and the field stays readable through `record` until it lands |
| adds an eighth kind | `itemType` reads `''`, the save's spelling stays in `record`, every consumer's `switch` keeps its `default` arm and goes on working | the same gate reports it as a kind the release does not declare |
| renames a field | the arm reads `0`/`''` where the game now sends something else | the gate (the extracted list is per field *and* kind) |
| ships a save with a kind we do not know | `OtherItem`: no throw, no guess, no `undefined`-typed field | — |

The escape hatch is unchanged and still has its one purpose (`entities.ts:24-30`): "one deliberate hole for a
mod that cannot wait for a library release, and it is the only place in the public API where a field name is a
string." Finishing a kind does not close it; `record` stays on every arm, `Tile`'s does too.

## 6. The gate: declared vs exposed, checked by machine

This is the part that makes the plan worth more than the eight interfaces. The repo already has the machinery:
`art:sync` reads the game's bundle, extracts tables through `TablePredicate`s
(`packages/art/src/bundle/predicates.ts`), validates them (`validate.ts`), writes `data/<version>.json` plus
`docs/art-provenance.md`, and `--check` re-derives all of it **offline** from the committed fixture chunks and
fails on any drift (`docs/plans/2026-09-13-phase-7…` §"Two modes matter more than the rest"). One of its
tables is already the item kind enum — step 5 of today's run says `itemTypes by item-type-enum`.

**T0. Extract the item schemas.** A new predicate for the union `Ta` and its member schemas (`aa`, `_a`, `va`,
`ya`, `ba`, `xa`, `Ca`, `wa`), yielding, per kind, the field names and which are required. The tool's own
rules apply: a missing table is an `ExtractionError` naming its predicate, the fixture capture grows the slices
it read (the committed `worldDepthSortKey` fixture is 35,941 B of a 769 KB chunk — the schemas are not in it
yet, and `tools/fixtures.ts` is what cuts them in), and provenance records the ranges. The kind enum is
already extracted this way (`predicates.ts:1640`, `predicate: 'item-type-enum'`), so the new predicate is the
shape of one that exists rather than a new mechanism.

**T3. The completeness test.** In `packages/common/tests/state/items/`, against the extraction:

```ts
for (const kind of ITEM_KINDS)
  test(`every field the game declares for ${kind} is on its arm`, () => {
    const declared = itemSchemaFields(kind);                     // from the committed extraction
    const exposed = Object.keys(ARM_SAMPLE[kind]);               // a real read of a fixture entry of that kind
    assert.deepEqual(declared.filter((f) => !exposed.includes(f)), []);
  });
```

and its converse, scoped to the fields the kind's own reader produced: a name there that the game does not
declare for that kind is as wrong as a missing one, and it is the same assertion with the two lists swapped.

**It must be shown to fail**, per I8 (`docs/DESIGN.md:629`): delete `hunger` from `readPet` and watch the pet
case go red; add a field name to the extracted list and watch it go red. Both are one-line mutations, and the
plan's acceptance is that both were run.

**The generalisation, which is the same fix for the same class.** The gate is not item-specific once the field
lists exist: the same test shape covers `Tile` (four arms, extracted in the same predicate pass), `Crop`, and
`Pet` (the slot carrier). All four pass today — which is the point: the test's job is the *next* game field,
and it is the reason §1.2's stale version claim cannot recur.

## 7. Sibling issues this pass closes

The same fix should take the same-shaped problems with it, and most of the value here is in the last few: every
item below is a per-kind field with no typed home, or two carriers of one schema, which is what makes the
completeness gate worth building once rather than per kind.

**S1 — a pet lives in three places, and the game indexes all three.** The game's own walker
(`worldDepthSortKey-BXUHHrP0.js` ~645890):

```js
function* bo(e){ for (let t of e.petSlots) yield {pet:t, location:{kind:`petSlot`}};
  for (let t of e.inventory.items) if (t.itemType===E.Pet) yield {pet:t, location:{kind:`inventory`}};
  for (let t of e.inventory.storages) for (let e of t.items)
    if (e.itemType===E.Pet) yield {pet:e, location:{kind:`storage`, decorId:t.decorId}} }
function xo(e){ return Array.from(bo(e), ({pet:e}) => e) }
```

and the game builds `petsProgress`, a **by-id index over all three carriers**, which the seat system applies to
the item it is showing (`installSeatSystems-B2ZqVPv6.js` ~340426; the index itself is `Yu`, exported as `Tr`,
in `worldDepthSortKey-BXUHHrP0.js` ~705743, and it carries `isInPetSlot`, the game's own answer to whether a
pet is out):

```js
let e = F(this.activeItem), n = this.petsProgress[e], r = n?.name ?? this.activeItem.name;
n && (t = { ...this.activeItem, hunger: n.hunger, xp: n.xp, targetScale: n.targetScale, name: r,
            mutations: n.mutations, abilityCooldowns: n.abilityCooldowns });
```

So a consumer that types `PetItem` and reads `item.xp` has the **saved** value, which for a pet that is out in
a slot is not the live one. This library's `Player.pets` (`entities.ts:589`) is the slot list only, so today a
consumer must hand-roll `bo` and the index — and the consumer in §0 will need exactly that next (a card that
shows a charging cooldown). **T5** adds it where the game has it: `state/pets.ts` with
`petsOf(player)`/`petById(player, id)` returning that index's entry per pet — the last carrier's own fields
plus its `isInPetSlot` — documented as the game's own map, not a precedence (§13 corrects this passage).

**S2 — one pet schema, two hand-written field lists.** `Pet` (slot, `entities.ts:397-425`) and the bag pet
share `aa`; today `Pet` has the fields and the bag arm has none. `PetFields` (§3) is stated once and both
implement it, so `toPet` and `readPet` cannot drift — which is how the bag pet came to be missing them.

**S3 — `ItemType` is two of the game's enums wearing one name.** `TileBase.objectType` is typed `ItemType`
(`entities.ts:272`), which is `E` — capitalised item kinds including `'Pet'` — while a tile's `objectType` is
`N`, lowercase, and `OtherTile.objectType` is `''`, which is not an `ItemType` member at all. The arms still
narrow (their literals are disjoint), so this is a correctness-of-name defect rather than a live bug, and it is
the same class as the item hole: a kind family typed by another family's enum. **T6** splits `ItemKind` from
`TileKind`, and `TileKind` is **closed**: `TileBase.objectType: TileKind | ''`, where `''` is `OtherTile`'s
empty kind. An open tail would accept `'Seed'` as a tile kind and stop the family narrowing, so a fifth
*declared* kind is a decision here rather than a string that compiles.

**S4 — per-kind readers have no home.** `toInventoryItem` (`reader.ts:224`) reads the shared fields, `toPet`
(`:500`) reads a pet's own, `toCrop` (`:350`) reads a crop's, and each of them half-reads a pet. After T1-T3
there is exactly one reader per kind, and the door for the next kind is a file.

**S5 — the test that named the hole.** §1.1. The fix is not only asserting the new fields but **making the
title true**: the item test's pet arm asserts the four, and the fixture keeps them.

**S6 — the consumers' duplicated readers, and the ones that flow free.** `Storage.items` and
`Inventory.items` are `InventoryItem[]` (`entities.ts:545,559`), so both get the union with no change. The two
downstream readers that re-state the flat shape —
`garden-viewer/garden.mjs:140-155` ("An item is one shape whatever kind it is, with `itemType` saying which
fields are filled in") and `garden-viewer-svelte/src/lib/domain/payload/item.ts` — become narrowing reads; §9.

**S7 — `Player.pets` is not the player's pets.** The same `bo` above; part of T5, and named here so the doc
line at `entities.ts:589` ("The pets this player has out. A pet in a bag or a storage is an inventory item, not
one of these") is not read as "these are all of them".

## 8. Tasks

Each task states the test that fails without it — the repo's own bar
(`docs/plans/2026-09-13-phase-7-missing-capabilities.md:5`). `Breaking:` follows D1 (`docs/DESIGN.md:38`):
pre-1.0, private, no deprecation shims, so a breaking change is a decision rather than a blocker.

**T0 — extract the item schemas into the art tables.**
*Why:* every later task measures against the game's own lists, and the extraction is what makes them evidence
rather than memory. *Files:* `packages/art/src/bundle/predicates.ts` (the predicate),
`tables.ts` (the table id + type), `extract.ts` (the wiring), `validate.ts` (a witness that owes nothing to the
predicate), `tools/sync.ts` (the step list), `docs/art-provenance.md` + `data/1192.json` + the fixture slices
(all regenerated by `npm run art:sync`). *Test first:* a determinism test in the art suite: the fixture run and
the full-bundle run produce the same table, byte for byte — the property `--check` already asserts for the
existing tables. *Gate:* `npm run art:sync -- --check` offline. *Breaking:* no (added table).

**T1 — the types.** `state/items/{base,pet,produce,seed,plant,tool,egg,decor,index}.ts`; `entities.ts` loses
`InventoryItem`/`ItemType`'s item half and its doc gains the pointer. `ItemFields`/`ItemOfKind` derive the
union from one map, so an arm cannot exist without its fields. *Test first:* `tests/state/items/base.test.ts` —
a `switch` over `itemType` with one case per kind compiles, narrows to the arm's own fields without a cast, and
the last case is `''`. *Breaking:* **yes** for a consumer that constructed an `InventoryItem` literal or read
`itemType` for display (an unknown kind is `''` now, with the spelling in `record`) — both consumers are ours.

**T2 — the reader.** `toInventoryItem` builds the base then dispatches through `ITEM_READERS`; `OtherItem` for
an unknown spelling. `Pet` reads through `PetFields`, shared with `toPet`. *Test first:* the existing item test
(`reader.test.ts:247`) extended to assert each arm's own fields off the same fixture it already has — the pet's
`xp: 10`, `hunger: 50`, `targetScale: 1`, `abilities: []` are in the fixture today and unread. *Breaking:*
yes (see T1); the field *values* for every existing case are unchanged, which the same test proves.

**T3 — the completeness gate.** §6. *Test first:* the two tests, both shown red before the arms exist.
*Breaking:* no.

**T4 — the docs and the surface.** `docs/api-surface.json` regenerated (`npm run docs:build`, then read the
diff); `packages/common/tests/symbol-parity.test.ts` and `exports-map.test.ts` updated in the same commit as
the symbols they pin (runtime only — `toInventoryItem`/`toInventoryItems` keep their names); `DESIGN.md` §5's
"Types and API shape" gains the rule this plan establishes, in one sentence: *a kind family is a discriminated
union on its discriminant, or it is not modelled yet.* *Breaking:* no.

**T5 — where a pet is (S1/S7).** `state/pets.ts`: `petsOf(player)` (slots, bag, storages — the game's `bo`) and
`petById(player, id)` (that index's entry per pet: the last carrier's own fields plus `isInPetSlot`; §13). *Test
first:* a fixture with one pet in a slot and the same id in the bag, where the two carriers disagree, so the
test can say which one the index reports; and a bag pet with no slot, which is itself. *Breaking:* no (new
functions); `Player.pets` keeps its meaning and its doc points at `petsOf`.

**T6 — the enum split (S3).** `ItemKind` (from `ItemFields`) vs `TileKind`
(`'plant'|'egg'|'decor'|'crystal'`, closed); `TileBase.objectType: TileKind | ''`. *Test first:* a compile-only
test that an item kind is not assignable to a tile's `objectType` and vice versa (the `Extract`-against-`never`
shape `tests/client-contract.test.ts` established — with `ItemType`'s open tail `'Seed'` would be accepted and
the assertion could not hold). *Breaking:* yes, in name only.

**Ordering.** T0 first (nothing can be measured without it), then T1+T2+T3 in one commit (the union, its
reader, and the gate are one unit of work — the tile commit `ac7bcb5` is the precedent for the size), T4 with
them, then T5 and T6 as their own commits. T5 is separable if the human wants it deferred; T6 is separable
entirely.

## 9. Consumer migration

| consumer | what changes | why |
|---|---|---|
| `garden-viewer-svelte` (this workspace) | `src/lib/domain/payload/item.ts`: the `record.raw` read (commit `1d5e94e`) becomes `entry.xp`/`entry.hunger`/…; the package's arm is the type. Its pet-card tests stay, unchanged, as the cross-repo witness that the numbers are real. | the workaround is deleted, not duplicated |
| `garden-viewer` (the original) | `garden.mjs:140-155`'s flat `item()` can narrow per kind; it has the same pet hole today. Its own change, in its own repo, because the brief freezes that tree. | same class, second consumer |
| `Magic-garden-API` | **nothing** — measured: it depends on `@mg.js/art`, not `@mg.js/common`. | no item state is read there |
| `@mg.js/bootstrapped`, `@mg.js/headless` | **nothing** — measured: no `.raw` read outside `state/reader.ts`, and neither package touches `InventoryItem` fields. | — |

The acceptance that matters is the pair: the viewer's `payload/item.ts` stops reaching into `record`, and the
viewer's pet-card test (Sheep, 165 kg, 412 h, 80/80, 74%) passes against the library's own arm — with no
`record.raw` anywhere in the viewer.

## 10. Not doing (YAGNI, `DESIGN.md:788`)

- **Not typing every schema in the game.** This pass covers the seven item kinds plus the four tile kinds'
  completeness check. Shops, weather, cosmetics and the pet-team schemas stay as they are until a consumer
  needs them, and the gate is built so that adding one is a predicate and an interface, not a re-design.
- **Not generating the TypeScript from the bundle.** T0 extracts *field lists* as data to test against.
  Generating the interfaces themselves would make `entities.ts` a build artifact and put the game's minifier in
  the library's public types; the repo's own art plan drew that line at art tables, and this keeps it.
- **Not keeping `InventoryItem` as a wide interface for compatibility.** D1: pre-1.0, private, two consumers,
  both ours. An alias would leave the hole reachable.
- **Not a `petStrength`/`petWeight` helper here.** The arithmetic the viewer needed (`domain/pets.ts`) is one
  consumer's presentation of the game's own maths; whether it belongs in this library is a separate question
  and is not answered by typing the fields.
- **No inert surface** (`DESIGN.md` §5): every reader added here is called by `toInventoryItem`, and
  `ITEM_KINDS` is read by the completeness test.

## 11. Open questions for the human

1. **`PetItem`'s optional extras.** The game has `Ca` (extras required) and `wa` (extras optional) and uses
   `Ca` in the item union. Model the union's arm as `Ca`, or model the *shared* `PetFields` with the extras
   optional so one interface serves both carriers (slots use `Ca` too, per `toPet`'s current field list)?
   The plan recommends the second — one list, both carriers, `''`/`{}` for absent — but `aa`/`wa` exist
   because the game itself distinguishes them.
2. **`OtherItem.itemType: ''`.** This matches `OtherTile`, and it costs the spelling on the discriminant (it
   stays in `record`). The alternative is a second field (`statedKind: string`) on the empty arm only. The
   plan recommends matching the tile arm and leaving the spelling to the escape hatch.
3. **Where the extracted item schemas live.** Recommended: an `@mg.js/art` table (offline-checkable, provenance
   recorded) with the *common* test reading a committed JSON fixture that the root `verify` script checks
   against it — because `common` must not import `art`. The alternative is a fixture maintained inside
   `common`'s tests with its own checked-in provenance, which needs no cross-package script but breaks the
   "cut by the same code that extracts" property the art fixtures have.
4. **Whether T5 (the pet join) belongs in this pass or the next.** It is the capability the §0 consumer needs
   next, and it is the same neighbourhood; it is also the only task here that adds behaviour rather than
   typing an existing one. The plan includes it and marks it deferrable.
5. **Registering this in the master plan** (`docs/mgjs-improvement-plan.md`). Wave 1 is "what a tile is" and
   landed as `ac7bcb5`; this is the same wave's remaining half. The insertion is one row — suggested commit:
   `feat(state): an inventory item is the game's seven schemas, discriminated` — and one line in the wave's
   prose. Left to the human because the master plan is the roadmap, not this document.

## 12. Acceptance

1. `npm run verify` green: lint, typecheck (source and tests), build, **1,145 tests plus the new ones**, 0 fail,
   `art:sync --check` current at 1192 **with the new table in it**, `docs:check` regenerated.
2. Both completeness tests observed red before they were green (I8).
3. `InventoryItem` narrows: a `switch` over the seven kinds plus `''` compiles with every arm's own fields
   reachable and no cast at the call site.
4. The two consumer migrations (§9) land, and `grep -rn "record.raw" garden-viewer-svelte/src` returns nothing.
5. The §0 report's pet reads correctly through the library's own arm — level 80, 165 kg, 412 h, hunger 185 —
   with the viewer's reader no longer touching the escape hatch.

## 13. Deviations and rulings

Every decision this pass took that changed what the plan above says. The code is the record; this table is so
the document and the code agree and the decisions outlive the pass's own workspace.

| the plan said | what landed, and why |
|---|---|
| T0 extracts the item union (§6 T0), with the tile kinds' completeness check elsewhere | T0 extracted **four** families — the item union, the tile union, the crop schema and the pet base — because §6 puts the tile arms "in the same predicate pass" and §10 puts the tile kinds' completeness check in this pass. The table is named `kindSchemas`, not `itemSchemas`, because it holds tiles too. |
| the minified-name guard excludes a name that occurs in the extractor's prose | Narrowed to a **provable stoplist**: a name is excluded only if it genuinely occurs as a whole word in that prose (`as`, `is`, `ts`), each with a measured count, and a pinned floor on how many distinctive names remain greped keeps the exclusion from growing silently. |
| T1–T4 land in one commit (§8 Ordering) | **Two** commits: T1+T2+T4, then T3. The surface manifest forces the docs into the first, and the gate's honest outcome may be red until its arms exist, so the surface and a provably-red gate do not share a commit. |
| the gate's per-kind converse is scoped to the kind's own reader (§6 T3) | That converse is vacuous for the five item kinds whose readers return `{}`, so the pass added an items-only **base-step converse**, plus two renames the plan did not name: `slots`→`plots` for tile arms and `slotId`→`id` for crops. |
| `petsOf` returns one entry per carrier with the live slot record winning (§7 S1, §8 T5) | `petsOf` **collapses duplicate ids** to one entry per pet and follows the game's own index (`Yu`, exported as `Tr` and installed as `Bo`), which reports the **last** carrier in walk order and carries the index's own `isInPetSlot`. The plan's slot-record overlay is not in that index and is not applied; the pass's divergence from the game's species-name fallback is stated in `state/pets.ts`. This row corrects §7 S1's characterization of `petsProgress` and §8 T5's task text, which are otherwise unchanged. |
| `TileKind` keeps `ItemType`'s open tail (§7 S3, §8 T6) | `TileKind` is **closed**, with `TileBase.objectType: TileKind \| ''`. The tail is the hazard §2 quotes, and with it T6's assertion could not hold because `'Seed'` would extend the union. |
