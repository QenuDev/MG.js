/**
 * Where a pet is, and which copy of it is live.
 *
 * ## A pet lives in three places, and the live numbers are in a fourth
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
 * A pet that is **out in a slot** also has a copy in the save (the bag or a storage) when it was put away
 * and taken out again, and that copy is stale: the live progress is the slot record's. The game says so by
 * overlaying the slot record onto the item before showing it (`installSeatSystems-B2ZqVPv6.js` ~340426):
 *
 *     let e = F(this.activeItem), n = this.petsProgress[e], r = n?.name ?? this.activeItem.name;
 *     n && (t = { ...this.activeItem, hunger: n.hunger, xp: n.xp, targetScale: n.targetScale, name: r,
 *                 mutations: n.mutations, abilityCooldowns: n.abilityCooldowns });
 *
 * `petsProgress` is built in another chunk as a by-id map of those same slot records, so the join is by id,
 * and the slot record is the live one. The walk's order is therefore **not** a statement about which
 * carrier owns a pet: the game's own `bo` yields a carrier per entry and never reconciles two carriers that
 * name one pet. See "Two carriers, one id" below for what this module does with that.
 *
 * ## What this module is, and is not
 *
 * This is that walk and that overlay, stated once, so a consumer does not hand-roll both. It is not a
 * second reader: the carriers are read by the package's own readers (`state/reader.ts`'s `toPet` for a
 * slot, its `toInventoryItem` for a bag or storage item), which is §7 S4's "one reader per kind" — a third
 * reading of the pet schema here would be the very defect this pass removes.
 *
 * The precedence, exactly as the game's overlay states it — a slot record with the same id wins these six
 * fields, and **only** these six:
 *
 *     hunger, xp, targetScale, name, mutations, abilityCooldowns
 *
 * `name` is the game's own fallback (`n?.name ?? this.activeItem.name`): the slot's name when it states
 * one, the item's otherwise. Everything else on the joined pet is the carrier's own reading — `id`,
 * `species`, `abilities`, `sourceEggId` and `equippedCosmetics` are not in the overlay list, so the bag's
 * copy stands even where it disagrees with the slot's. `species` is the sharpest of them, because both
 * readers spell it the same way from different fields: a bag item whose save says `species: 'Fox'` joins to
 * a slot record saying `petSpecies: 'SnowFox'` and keeps `Fox`.
 *
 * ## One shape, not the game's `{pet, location}` pair
 *
 * The walker's pair carries a `location` the game needs to put a pet back where it came from. Nothing here
 * does, and the address a caller might want is already on the view. So the return is one pet-shaped value,
 * which both carriers can carry because `Pet` (the slot, `state/entities.ts`) and `PetItem` (the bag arm,
 * `state/items/pet.ts`) are built from the one `PetFields` list there. A `{pet, location}` pair here would
 * be a shape no consumer in this repo reads, which §10's YAGNI declines. Note that the walker's `location`
 * records less than this view does: it is a kind (`petSlot`, `inventory`, `storage`, with a storage's
 * `decorId`) and no address, where the joined entry's `entityPath` is the full path of the record it was
 * read from.
 *
 * ## Two carriers, one id: what the entry is addressed to
 *
 * `entityPath` is the address of the **last carrier the walk reached** that states the pet's id, and the
 * carrier-owned fields (`id`, `species`, `abilities`, `sourceEggId`, `equippedCosmetics`, `record`) are
 * that same carrier's reading. For the headline case — a pet out in a slot whose save also still holds a
 * stale bag copy — that carrier is the **bag**, precisely because the bag copy is the stale one and the
 * walk reaches it after the slot. This is not a claim that the pet "is" in the bag: the game's `bo` yields
 * both carriers and has no opinion about which owns the pet, and this library does not resolve that
 * question either. What the join does resolve is the six live fields, which come from the naming slot
 * record whichever carrier was kept.
 *
 * Nothing here reads `entityPath` as "is this pet out?". A caller that needs that asks the slots itself —
 * a pet is out when `player.pets` (or the walk's `.../petSlots/<n>` entries) states its id.
 */

import type { Pet, Player } from './entities.js';
import type { InventoryItem, PetItem } from './items/index.js';

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
 * One pet, with the live values of a slot record that names the same id.
 *
 * `slot` is `null` for a pet the walk has no slot record for, in which case the live values are the
 * carrier's own.
 *
 * Every field is stated rather than spread, because a bag carrier carries the whole item base as well as
 * `PetFields`: a spread of it would put `itemType`, `quantity`, `size`, `crops`, `toolId`,
 * `remainingActiveSeconds`, `hasLife`, `eggId` and `decorId` on a value declared as a `Pet`. A pet is not a
 * stack, and a field the shape says it does not have must not be reachable on it — the same reason the item
 * union discriminates rather than carrying everything optional.
 *
 * The pet's own fields are the carrier's (`species`, `id`, `abilities`, `sourceEggId`, `equippedCosmetics`
 * and the address: see the module note on which carrier that is), except the six the game's overlay takes
 * from the slot record.
 */
function joinedPet(carrier: Pet, slot: Pet | null): Pet {
  const live = slot ?? carrier;
  return {
    entityPath: carrier.entityPath,
    id: carrier.id,
    species: carrier.species,
    // The game's own rule: the slot's name when it has one, the item's otherwise.
    name: live.name === '' ? carrier.name : live.name,
    hunger: live.hunger,
    xp: live.xp,
    targetScale: live.targetScale,
    mutations: live.mutations,
    abilityCooldowns: live.abilityCooldowns,
    abilities: carrier.abilities,
    sourceEggId: carrier.sourceEggId,
    equippedCosmetics: carrier.equippedCosmetics,
    record: carrier.record,
  };
}

/** The pet arms of a list of inventory entries, in the order the list has them. */
function petItemsOf(items: readonly InventoryItem[]): PetItem[] {
  return items.filter(isPetItem);
}

/**
 * Every pet the player has, wherever it lives: slots, the bag, then each storage.
 *
 * The game's `bo`, in the game's order, with the live slot record winning for each pet it names. A player
 * with no pets has an empty list rather than `undefined`.
 *
 * ## One entry per pet, and why that is not quite the walker
 *
 * `bo` yields a **carrier**, so a pet that is out in a slot and also has a stale copy in the bag is two
 * entries to it. Returning those two would put the very bug this module exists to close back in the list: a
 * caller doing `petsOf(player).find((pet) => pet.id === id)` would get whichever carrier it walked first,
 * which for the stale copy is the save's numbers. So the entries are collapsed by id, and — because the
 * game has no rule for which of two carriers owns a pet — the entry keeps the address and the carrier-owned
 * fields of the **last** carrier the walk reached, with the six live fields coming from the naming slot
 * record either way. See the module note for why that carrier is the bag in the headline case, and why it
 * is not a claim that the pet is in the bag.
 *
 * A carrier that states no id names no pet to join on, so it is not collapsed: each such carrier stands
 * alone. It is what the game sends for a pet that has just hatched, and reporting one entry for two of them
 * would be this function dropping a pet rather than joining one. Those entries come after the named ones
 * rather than in their walk position, and an empty id is a miss for {@link petById} rather than a lookup
 * that picks the first of them.
 *
 * The id is the join key, which is the game's own (`petsProgress[e]`). A carrier whose id names no slot
 * record joins to nothing and keeps its own values.
 */
export function petsOf(player: Player): Pet[] {
  const ordered = new Map<string, Pet>();
  const unnamed: Pet[] = [];
  const add = (carrier: Pet, slot: Pet | null): void => {
    // A later named carrier replaces an earlier one that states the same id, so the entry ends up addressed
    // by the last carrier the walk reached for that id, while the live fields come from the slot record
    // whichever carrier that was. `Map` keeps a replaced key in its original position, so the list stays in
    // the walk's order.
    if (carrier.id === '') {
      unnamed.push(joinedPet(carrier, slot));
      return;
    }
    ordered.set(carrier.id, joinedPet(carrier, slot));
  };

  // The naming slot record for a carrier's id, or `null` when no slot states it. A slot carrier is joined to
  // itself below, so it is already its own live reading.
  const slots = new Map(player.pets.map((pet) => [pet.id, pet]));
  for (const pet of player.pets) add(pet, pet);

  // The carriers arrive read — `toInventory` filled the inventory and `toPet` the slots — so this joins the
  // views rather than reaching back to the wire, and there is no clock to thread: `nowMs` reads only the
  // base reader's crops, and a pet states no `slots`.
  for (const item of petItemsOf(player.inventory.items)) add(item, slots.get(item.id) ?? null);
  for (const storage of player.inventory.storages) {
    for (const item of petItemsOf(storage.items)) add(item, slots.get(item.id) ?? null);
  }
  return [...ordered.values(), ...unnamed];
}

/**
 * One pet by id, with the live values: the slot record over the bag or storage item.
 *
 * `null` when no carrier holds a pet with that id — `reader.ts`'s rule for a lookup that finds nothing,
 * which is `null` rather than a throw or an `undefined`. An empty id names nothing, so it is `null` too.
 *
 * This is the overlay the game performs before showing a pet (`petsProgress[id]`), reached through the same
 * walk {@link petsOf} makes, so the two agree by construction: the entry for that id, with the live values
 * and the address of the last carrier the walk reached for it.
 */
export function petById(player: Player, id: string): Pet | null {
  // An empty id names nothing, so it is a miss before the walk even runs. This also keeps the answer stable
  // while {@link petsOf} can now hold more than one id-less carrier: without the guard this would answer
  // with whichever of them came first.
  if (id === '') return null;
  // `?? null` is `reader.ts`'s contract at the boundary: `Array.prototype.find` answers a miss with
  // `undefined`, and a lookup in this package answers with `null`.
  return petsOf(player).find((pet) => pet.id === id) ?? null;
}
