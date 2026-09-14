/**
 * The cinematic-claim registry: the cross-load guarantee that one load does not fight another for the
 * camera.
 *
 * Split out of `world.ts` (Phase 5 Task 5.7c). The map is exported for the scene module rather than kept
 * private, because the class reads and writes it at five sites; it is absent from
 * `render/index.ts`, so it is not part of the package surface.
 */

/** A hook the host installs so cinematic-mode claims reach the game's own atom. */
export interface CinematicClaimHooks {
  /**
   * Claim cinematic mode.
   *
   * Must be a *refcounted* claim rather than an assignment, because §18 requires releasing "not forcing
   * it off... in case something else also claimed it". The `client.ts` wiring supplies this from the jotai
   * `isCinematicModeAtom`; when no hook is supplied, claims are tracked locally and the game's own state
   * is left untouched, which is the honest degradation for a mod that has not found the atom.
   */
  claim?: (owner: string) => void;
  /** Release this owner's claim. Should decrement, not clear. */
  release?: (owner: string) => void;
}

/** Per-owner cinematic claim counts, module-scoped because they describe the page, not one scene. */
export const cinematicClaims = new Map<string, number>();

/** How many owners currently hold a cinematic claim. Diagnostics and tests. */
export function activeCinematicClaims(): number {
  return cinematicClaims.size;
}

/** Reset the claim ledger. Exported for tests; the game's own state is not touched. */
export function resetCinematicClaims(): void {
  cinematicClaims.clear();
}
