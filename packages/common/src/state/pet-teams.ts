/**
 * The two questions the game asks of a saved pet team, stated once.
 *
 * ## A team is a list of ids, and both answers are joins over the save
 *
 * A team names its members by `petId` and carries its own copy of each one's species and name, so nothing in
 * the team itself says whether those pets are still with the player, or whether the team is the one they have
 * out. The game asks both, in `installPlayerSystems-NMjL0ny-.js`, and this module is those two expressions:
 *
 *     function Uu(e,t){ let n=new Set(e.petSlots.map(e=>e.id)), r=new Set(t.members.map(e=>e.petId));
 *       return r.size>0 && r.size===t.members.length && r.size===n.size && t.members.every(e=>n.has(e.petId)) }
 *
 *     function Hu(e,t){ let n=[],r=[],i=[],a=new Set;
 *       for(let o of t.members){ let t=qc(e,o.petId); if(!t){ r.push(o); continue } n.push(o), a.add(o.petId), … }
 *       … return { resolvedMembers:n, missingMembers:r, swaps:c, placePetIds:…, pickupPetIds:… } }
 *
 * `Uu` is {@link teamIsOut} and `Hu`'s `qc` lookup is what {@link teamMembersOf} reports per member. What
 * `Hu` computes beyond that is an **action plan** — which pets to swap, in what order, what to place and what
 * to pick up — and none of it is here: a plan is about performing `ApplyPetTeam`, and a caller that only
 * reads a save has nothing to do with it.
 *
 * ## Both sides of `Uu` are sets, in both places
 *
 * `n` and `r` are `Set`s, so the comparison is between **distinct ids**: a save that listed one id in two pet
 * slots compares as one pet, and a team that named one pet twice is not the team that is out even when the
 * slots hold exactly that pet. Comparing `player.pets.length` against `team.members.length` looks equivalent
 * and is not; the guards `r.size > 0` and `r.size === t.members.length` are what keep an empty team and a
 * repeated member from being called out.
 *
 * ## Why the live pet is reported beside the team's own copy
 *
 * A member's species and name are the team's, and they can differ from the pet's for as long as the server
 * takes to patch a rename. The game's own card draws the live pet when there is one and the team's copy when
 * there is not (`Xo(livePet, member)` in its `buildTeamIllustration`), so both are reported here rather than
 * one being chosen: which to show is a caller's question, and a join that picked would be answering it in a
 * module that cannot know.
 */

import type { Pet, PetTeam, PetTeamMember, Player } from './entities.js';
import { petById } from './pets.js';

/**
 * One team member with the pet the player still has under that id.
 *
 * `pet` is `null` when nothing in the save states the id — the sold, or traded, member — which is the game's
 * `missingMembers`. The member's own three fields are always the team's, whatever `pet` holds.
 */
export interface PetTeamMemberView extends PetTeamMember {
  /** The live pet, read across every carrier the player owns, or `null` when there is none. */
  readonly pet: Pet | null;
}

/**
 * A team's members, each paired with the pet the player still has.
 *
 * The lookup is `state/pets.ts`'s `petById`, which is the game's own `qc` — one pet by id across the slots,
 * the bag and the storages — so a member in the bag or in a hutch is still with the player. One entry per
 * member, in the team's own order, and a member that resolves to nothing is reported rather than dropped.
 */
export function teamMembersOf(player: Player, team: PetTeam): PetTeamMemberView[] {
  return team.members.map((member) => ({ ...member, pet: petById(player, member.petId) }));
}

/**
 * Whether this is the team the player has **out**, in the game's own sense.
 *
 * True only when the team's members are exactly the pets in the player's pet slots: the same ids, the same
 * count, and at least one of them. A team that names a pet the player no longer has is not out, and neither
 * is a team whose members are all still with the player but not in the slots.
 */
export function teamIsOut(player: Player, team: PetTeam): boolean {
  const out = new Set(player.pets.map((pet) => pet.id));
  const named = new Set(team.members.map((member) => member.petId));

  return (
    named.size > 0 &&
    named.size === team.members.length &&
    named.size === out.size &&
    team.members.every((member) => out.has(member.petId))
  );
}
