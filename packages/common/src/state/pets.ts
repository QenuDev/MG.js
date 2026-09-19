/**
 * Where a pet is, and which of its copies the game's own index reports.
 *
 * ## A pet lives in three places, and the game indexes all three
 *
 * The game's own walker (`worldDepthSortKey-BXUHHrP0.js` ~645890) yields a pet from each carrier a save has,
 * in this order:
 *
 *     function* bo(e){ for (let t of e.petSlots) yield {pet:t, location:{kind:`petSlot`}};
 *       for (let t of e.inventory.items) if (t.itemType===E.Pet) yield {pet:t, location:{kind:`inventory`}};
 *       for (let t of e.inventory.storages) for (let e of t.items)
 *         if (e.itemType===E.Pet) yield {pet:e, location:{kind:`storage`, decorId:t.decorId}} }
 *     function xo(e){ return Array.from(bo(e), ({pet:e}) => e) }
 *
 * The game's pet index is built over the same three carriers (`worldDepthSortKey-BXUHHrP0.js` ~705743). It is
 * the declaration `Yu`, exported as `Tr`, imported by `installSeatSystems` as `Bo`, and read through the
 * `{get:JA,set:YA}=x()` getter that installs it as `petsProgress`:
 *
 *     var Yu=G(e=>{let t=e(Hc),n=t.petSlots,
 *       r=[...n,...t.inventory.items.filter(e=>e.itemType===E.Pet),
 *          ...t.inventory.storages.flatMap(e=>e.items.filter(e=>e.itemType===E.Pet))],
 *       i=new Set(n.map(e=>e.id)),a={};
 *       return r.forEach(e=>{a[e.id]={speciesId:e.petSpecies,name:e.name??M[e.petSpecies].name,
 *         hunger:e.hunger,xp:e.xp,targetScale:e.targetScale,mutations:e.mutations,
 *         abilityCooldowns:e.abilityCooldowns,isInPetSlot:i.has(e.id)}}),a})
 *
 * So `petsProgress` is a **by-id index over all three carriers**. The reduction writes each carrier's own
 * fields into `a[e.id]`, so when an id appears more than once the later carrier in walk order (slots → bag →
 * storages) is the one whose values the index reports. That is how the reduction is written, and it is a
 * lookup order rather than a reconciliation rule: a save keeps a pet in one carrier, so the index normally
 * holds one entry per pet and there is nothing to reconcile. Which is why the question its `isInPetSlot` flag
 * answers — "is this pet out?" — is the one worth carrying, and "which of two copies wins" is not.
 *
 * ## What this module mirrors, and what it does not
 *
 * `petsOf`/`petById` reproduce that index: one entry per pet, the carrier's own reading, and the game's own
 * `isInPetSlot`. They do **not** overlay a slot record's fields onto a bag item. The overlay the game does
 * runs on `this.activeItem` — an item the caller is already displaying — from `petsProgress[activeItem.id]`
 * (`installSeatSystems-B2ZqVPv6.js` ~340426):
 *
 *     let e = F(this.activeItem), n = this.petsProgress[e], r = n?.name ?? this.activeItem.name;
 *     n && (t = { ...this.activeItem, hunger: n.hunger, xp: n.xp, targetScale: n.targetScale, name: r,
 *                 mutations: n.mutations, abilityCooldowns: n.abilityCooldowns });
 *
 * In a valid save the index's entry for `activeItem.id` was built from `activeItem` itself, so that overlay
 * resolves to the item's own values: it is a self-overlay, not a second source for them. An earlier draft of
 * this module instead took the six fields from the naming slot record, which is the inverse of what the index
 * reports wherever the two carriers disagree.
 *
 * ## What this module is, and is not
 *
 * This is that walk and that index, stated once, so a consumer does not hand-roll both. It is not a second
 * reader: the carriers are read by the package's own readers (`state/reader.ts`'s `toPet` for a slot, its
 * `toInventoryItem` for a bag or storage item), which is §7 S4's "one reader per kind" — a third reading of
 * the pet schema here would be the very defect this pass removes.
 *
 * ## One shape, not the game's `{pet, location}` pair
 *
 * The walker's pair carries a `location` the game needs to put a pet back where it came from. Nothing here
 * does, and the address a caller might want is already on the view. So the return is one pet-shaped value,
 * which both carriers can carry because `Pet` (the slot, `state/entities.ts`) and `PetItem` (the bag arm,
 * `state/items/pet.ts`) are built from the one `PetFields` list there. A `{pet, location}` pair here would
 * be a shape no consumer in this repo reads, which §10's YAGNI bar rules out.
 *
 * ## Two carriers, one id: what the entry is addressed to
 *
 * `entityPath` is the address of the **last carrier the walk reached** that states the pet's id, and every
 * other field is that same carrier's reading, because the last carrier is the one the game's index reports.
 * For the duplicated id this module's fixture builds, that carrier is the **bag**. That is not a claim that
 * the pet "is" in the bag: `bo` yields both carriers and `Yu` indexes them by id without an opinion about
 * which owns the pet, and this library does not resolve that question either.
 *
 * ## The three deliberate divergences
 *
 * The game's `name` falls back to the species' default name (`name ?? M[e.petSpecies].name`, the `M` table of
 * species records). This library reports the name the save states (`''` when it states none) and carries no
 * species-name table, so it does not apply that fallback; a consumer that needs the species' default name
 * supplies it.
 *
 * The game's index keys id-less carriers under `''` too, so two pets that have just hatched collapse to one
 * entry there. This module keeps each id-less carrier as its own entry: `''` names no pet to join on, and
 * collapsing two pets into one would be the walk dropping a pet rather than joining one. `petById(player,
 * '')` is a miss for the same reason, and an id-less carrier's `isInPetSlot` is its own carrier's — `true`
 * for a slot record, `false` for a bag or storage one — never the index's `i.has('')`, which is true only
 * because both sides spell "no id" the same way.
 *
 * A duplicated id whose last carrier is a **storage** is the one case the seat overlay is not self: displaying
 * the bag item for that id, the game would merge the storage entry's six fields onto the bag's object, while
 * this module reports the storage's whole record. The six values agree; the address and the fields outside the
 * overlay (`species`, `abilities`, `sourceEggId`, `equippedCosmetics`) follow the storage here and the
 * displayed bag item there. A valid save keeps a pet in one carrier, so only a synthetic duplicate reaches
 * this, and the module reports the index rather than reproducing the merge.
 */

import type { Pet, Player } from './entities.js';
import type { InventoryItem, PetItem } from './items/index.js';

/**
 * A pet from {@link petsOf}: the carrier's own reading, plus the game's own "is this pet out?" flag.
 *
 * Not exported, because it is `Pet` plus the index's one boolean and the two functions below are the only
 * things that hand it out; the public surface stays what it was.
 */
type JoinedPet = Pet & { readonly isInPetSlot: boolean };

/**
 * True when an inventory entry is the pet arm.
 *
 * A guard rather than a filter with a cast: the discriminant is a literal, so the compiler narrows the union
 * itself and every caller below sees `PetItem` rather than `InventoryItem`.
 */
function isPetItem(item: InventoryItem): item is PetItem {
  return item.itemType === 'Pet';
}

/**
 * One entry for the index: the carrier's own reading, plus whether a pet slot states the same id.
 *
 * Every field is stated rather than spread, because a bag carrier carries the whole item base as well as
 * `PetFields`: a spread of it would put `itemType`, `quantity`, `size`, `crops`, `toolId`,
 * `remainingActiveSeconds`, `hasLife`, `eggId` and `decorId` on a value declared as a `Pet`. A pet is not a
 * stack, and a field the shape says it does not have must not be reachable on it — the same reason the item
 * union discriminates rather than carrying everything optional.
 */
function joinedPet(carrier: Pet, isInPetSlot: boolean): JoinedPet {
  return {
    entityPath: carrier.entityPath,
    id: carrier.id,
    species: carrier.species,
    name: carrier.name,
    hunger: carrier.hunger,
    xp: carrier.xp,
    targetScale: carrier.targetScale,
    mutations: carrier.mutations,
    abilityCooldowns: carrier.abilityCooldowns,
    abilities: carrier.abilities,
    sourceEggId: carrier.sourceEggId,
    equippedCosmetics: carrier.equippedCosmetics,
    record: carrier.record,
    isInPetSlot,
  };
}

/** The pet arms of a list of inventory entries, in the order the list has them. */
function petItemsOf(items: readonly InventoryItem[]): PetItem[] {
  return items.filter(isPetItem);
}

/**
 * Every pet the player has, wherever it lives: slots, the bag, then each storage — the walk `bo` makes, and
 * the entries the game's `Yu` index reports.
 *
 * ## One entry per pet
 *
 * `bo` yields a **carrier**, so a pet that is out in a slot and also has a copy in the bag is two entries to
 * it. `Yu` reduces them to one by id, and this function does the same: the entry is the carrier's own
 * reading — for a duplicated id, the last carrier the walk reached, because that is the carrier the index
 * reports — plus the game's own `isInPetSlot`.
 *
 * A carrier that states no id names no pet to join on, so it is not collapsed: each such carrier stands
 * alone. It is what the game sends for a pet that has just hatched, and reporting one entry for two of them
 * would be this function dropping a pet rather than joining one. Those entries come after the named ones
 * rather than in their walk position, and an empty id is a miss for {@link petById} rather than a lookup that
 * picks the first of them. See the module note for why this is a deliberate divergence from the index's own
 * `''` key.
 */
export function petsOf(player: Player): JoinedPet[] {
  const ordered = new Map<string, JoinedPet>();
  const unnamed: JoinedPet[] = [];
  const add = (carrier: Pet, isInPetSlot: boolean): void => {
    const joined = joinedPet(carrier, isInPetSlot);
    if (carrier.id === '') {
      unnamed.push(joined);
      return;
    }
    // A later named carrier replaces an earlier one with the same id, which is the index's own
    // last-writer-wins in walk order. `Map` keeps a replaced key in its original position, so the list stays
    // in the walk's order.
    ordered.set(carrier.id, joined);
  };

  // The game's `i`: the ids its pet slots state. An empty id is not one a carrier can be matched on, so a
  // bag or storage carrier that states none is never reported as out.
  const slotIds = new Set(player.pets.map((pet) => pet.id));
  const statedInSlot = (item: PetItem): boolean => item.id !== '' && slotIds.has(item.id);

  for (const pet of player.pets) add(pet, true);

  // The carriers arrive read — `toInventory` filled the inventory and `toPet` the slots — so this joins the
  // views rather than reaching back to the wire, and there is no clock to thread: `nowMs` reads only the
  // base reader's crops, and a pet states no `slots`.
  for (const item of petItemsOf(player.inventory.items)) add(item, statedInSlot(item));
  for (const storage of player.inventory.storages) {
    for (const item of petItemsOf(storage.items)) add(item, statedInSlot(item));
  }
  return [...ordered.values(), ...unnamed];
}

/**
 * One pet by id: the index's own reading for that id, with the game's own `isInPetSlot`.
 *
 * `null` when no carrier holds a pet with that id — `reader.ts`'s rule for a lookup that finds nothing,
 * which is `null` rather than a throw or an `undefined`. An empty id names nothing, so it is `null` too.
 *
 * Reached through the same walk {@link petsOf} makes, so the two agree by construction: the entry for that
 * id, with the last carrier's reading and the slot flag. The empty-id guard is also what keeps the answer
 * stable while {@link petsOf} can hold more than one id-less carrier: without it this would answer with
 * whichever of them came first.
 */
export function petById(player: Player, id: string): JoinedPet | null {
  if (id === '') return null;
  // `?? null` is `reader.ts`'s contract at the boundary: `Array.prototype.find` answers a miss with
  // `undefined`, and a lookup in this package answers with `null`.
  return petsOf(player).find((pet) => pet.id === id) ?? null;
}
