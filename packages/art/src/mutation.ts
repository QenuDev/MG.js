/**
 * What a mutation draws with: the wash it filters the crop through, the band it stacks in, and the art it
 * lays on a tall plant.
 *
 * The mutation *record* is an argument. Nothing here is a table of names or a transcribed constant: every
 * number comes off the record the caller holds, and the record is the shape `packages/art/data/<version>.json`
 * states -- the extractor's `MutationArt`, keyed by mutation name, whose own fields the predicates read out of
 * the game's table (`.logs/art-sync-spike/analysis/motion-tables.json`, the `jo` table of
 * `LayoutMotionController-CwhDlPns.js`, 11 keys, fields `filters`, `tallPlantFilters`, `iconSprite`,
 * `overlaySprite`, `tallPlantGroundSprite`, `overlayFromBottom`).
 *
 * The consumer's values and the game's table agree exactly on all eleven mutations, which is why the tests
 * beside this file can quote the consumer without quoting it as a definition: `Wet` is `rgb(50, 180, 200)` at
 * `.25` in both (`garden-viewer/server.mjs:735-736` and `jo`), and `Ambershine` is `rgb(190, 100, 40)` at `.5`
 * in both, which is the amber that `garden-viewer/server.test.mjs:228-239` measures in the composed pixels.
 */

/**
 * A mutation's crop wash, as the game's filter construction states it.
 *
 * `color` is the literal the filter was constructed with (`rgb(50, 180, 200)`); `alpha` is the nearest `alpha`
 * beside it, or `null` when the construction states none. Alpha has no other home: no mutation on any endpoint
 * carries one (`docs/mgjs-community-api-plan.md` §3.3).
 */
export interface MutationTint {
  readonly color: string;
  readonly alpha?: number | null;
}

/**
 * One mutation's art, as the game's own table states it.
 *
 * The field names are the extractor's (`bundle/tables.ts`'s `MutationArt`), which are the game's own field
 * names with the registry references resolved to sprite names. `name` is the table's key, stated here because
 * the over-set is a set of names.
 */
export interface MutationArtRecord {
  /** The key this record sits under in the mutation art table. */
  readonly name: string;
  /** Position in the game's own table, which is the order the game stacks the mutations in. */
  readonly order?: number | null;
  /** The colour filter the crop is drawn through, or `null` for a mutation that carries none. */
  readonly tint?: MutationTint | null;
  /**
   * True when the record's filter is a construction that states no colour at all.
   *
   * The game's own way of saying "this one is a shader": `Gold`'s `filters` is a bare hoisted reference and
   * `Rainbow`'s is `new Ao(xe.Crop)`, while every other mutation's is `new To({color, alpha})`. The consumer
   * knows this today as a hardcoded pair of names (`garden-viewer/server.mjs:589`).
   */
  readonly material?: boolean;
  /** The name of the mutation's own art, drawn over the crop: `Ambershine`'s is `Amberlit`. */
  readonly iconSprite?: string | null;
  /** The art that pools under a tall plant in place of that art: `Puddle`, `ThunderstruckGround`. */
  readonly groundSprite?: string | null;
  /** The art a tall plant gets as an overlay: `WetTallPlant`, `ThunderstruckTallPlant`. */
  readonly overlaySprite?: string | null;
  /** Whether that overlay is drawn from the bottom of the plant up rather than from the top down. */
  readonly overlayFromBottom?: boolean;
}

/** A mutation's wash and the name of the art it draws over the crop. */
export interface MutationDrawing {
  /** The wash as `rgba(r, g, b, a)`, or `null` when the record carries a material rather than a colour. */
  readonly tint: string | null;
  /** The opacity the wash is mixed in at, which is `1` when the filter states none. */
  readonly alpha: number;
  /** The name of the mutation's own art, or `null` when the record states none. */
  readonly icon: string | null;
  /** True when the record's filter is a material rather than a colour, so there is no wash to draw. */
  readonly material: boolean;
}

/** What a wash's opacity is when the game's filter states none. */
const OPAQUE = 1;

/** The three channels a colour literal has to state before it can be read as a wash. */
const CHANNELS = 3;

/**
 * The numbers a colour literal states.
 *
 * The shape is `/[0-9.]+/g` on purpose: it is the same reading the pixel loop applies to this function's own
 * output (`server.mjs:675`), so a wash this package states is a wash that loop can mix. A literal that does
 * not state three numbers is not a colour this package will guess at, and its mutation has no wash.
 */
function channels(colour: string): readonly [number, number, number] | null {
  const found = (colour.match(/[0-9.]+/g) ?? []).map(Number);
  if (found.length < CHANNELS) return null;
  const [red, green, blue] = found;
  if (red === undefined || green === undefined || blue === undefined) return null;
  if (!Number.isFinite(red) || !Number.isFinite(green) || !Number.isFinite(blue)) return null;
  return [red, green, blue];
}

/**
 * The wash a mutation filters its crop through, and the name of the art it draws over it.
 *
 * A mutation reaches a crop two ways -- a flat wash the art is filtered through, and its own art laid over the
 * top -- and this says both. The wash is `rgba(r, g, b, a)` from the colour the filter was constructed with
 * and the alpha beside it, which is what the consumer builds at `server.mjs:830-835` and what the composed
 * crop's pixel test measures. A record whose filter states no colour (a shader material) has no wash: `null`,
 * not a black one, because a colour this package made up would tint every Gold and Rainbow crop wrongly.
 *
 * A record that states no source of colour at all is also `null`. The alpha defaults to `1`, which is the
 * consumer's own default for a filter that states none (`server.mjs:832`), and not a guess: it is "mix
 * nothing of the stated colour away".
 */
export function mutationArt(mutation: MutationArtRecord): MutationDrawing {
  const tint = mutation.tint ?? null;
  const alpha = typeof tint?.alpha === 'number' ? tint.alpha : OPAQUE;
  const colour = tint === null ? null : channels(tint.color);
  return {
    tint: colour === null ? null : `rgba(${colour[0]}, ${colour[1]}, ${colour[2]}, ${alpha})`,
    alpha,
    icon: mutation.iconSprite ?? null,
    // A record that states a colour but not one this package can read is a material as far as drawing is
    // concerned: there is no wash to mix, whatever the record's own flag says.
    material: mutation.material === true || (tint !== null && colour === null),
  };
}

/** Where a mutation sits in the draw order, and which side of the crop it is drawn on. */
export interface MutationStack {
  /** The position the game's own table states for it, which is the order the game stacks them in. */
  readonly order: number;
  /** Whether it is one of the game's over-mutations, drawn above the crop rather than with the rest. */
  readonly over: boolean;
  /** The z-index the game gives its art: `10` for an over-mutation, `0` for one that keeps the order. */
  readonly zIndex: number;
  /** The art it pools under a tall plant with, or `null` when it lays no ground. */
  readonly ground: string | null;
}

/**
 * The z-index the game draws an over-mutation's art at.
 *
 * `LayoutMotionController`: `a = Ko.has(e) ... a && (o.zIndex = 10)` inside `Jo`, and the z-ladder's own label
 * for that site is "over-mutation icons 10" (`.logs/art-sync-spike/analysis/motion-tables.json`, `zLadder`).
 * Every other mutation keeps the container's own order, which is `0`.
 */
const OVER_Z_INDEX = 10;

/** The order a mutation keeps when the table states none. */
const UNSTATED_ORDER = 0;

/**
 * Where a mutation sits in the draw order, and whether it paints over the crop or pools under it.
 *
 * `overMutations` is the game's own over-set, passed rather than written down: `Ko = new Set(['Dawnlit',
 * 'Ambershine', 'Dawncharged', 'Ambercharged'])` in `LayoutMotionController`, which is the four the consumer
 * holds as `OVER_MUTATIONS` (`server.mjs:813`). An over-mutation is drawn at z-index 10 rather than in the
 * container's order, which is what makes "a moonlit clover lit over the frost it also carries" true.
 *
 * The order is the table's own position, not a sort over coin multipliers: the game's table stacks them in
 * key order, and `Rainbow` (first) is above `Gold` (second) and both above `Wet` (third) -- the same three the
 * order is asserted on. The consumer reaches the same sequence by sorting its transcribed table by coin
 * multiplier, which agrees with the table's order on all eleven.
 *
 * A mutation that states a ground art pools under a tall plant instead of drawing its own art there; one that
 * states none draws over the crop.
 */
export function mutationStack(mutation: MutationArtRecord, overMutations: readonly string[]): MutationStack {
  const over = overMutations.includes(mutation.name);
  return {
    order: typeof mutation.order === 'number' ? mutation.order : UNSTATED_ORDER,
    over,
    zIndex: over ? OVER_Z_INDEX : 0,
    ground: mutation.groundSprite ?? null,
  };
}

/**
 * The art a mutation lays on a tall plant: the decal that pools at its foot, and the overlay over the plant.
 *
 * A tall plant's mutation is not the mutation's own art drawn over the crop -- it is the ground art at the
 * plant's foot (drawn twice the size and underneath, which is the next commit's arithmetic) or, for the
 * weather mutations, an overlay up the plant. `ground` is the same name `mutationStack` reports as the split,
 * read here for what to draw rather than for which side of the crop it lands on.
 */
export interface OverlayArt {
  /** The art that pools at a tall plant's foot, or `null` when the mutation states none. */
  readonly ground: string | null;
  /** The art drawn over a tall plant, or `null` when the mutation states none. */
  readonly overlay: string | null;
  /** Whether the overlay is drawn from the bottom up. */
  readonly fromBottom: boolean;
}

/**
 * The art a mutation lays on a tall plant.
 *
 * Three mutations state a ground art (`Wet`'s `Puddle`, `Thunderstruck`'s and `Thundercharged`'s own grounds)
 * and five state an overlay (`WetTallPlant`, `ChilledTallPlant`, `FrozenTallPlant`, `ThunderstruckTallPlant`,
 * `ThunderchargedTallPlant`); the two weather ones state `overlayFromBottom`, so their overlay climbs the
 * plant rather than hanging down it. The four over-mutations and the two shader materials state neither, and
 * `null` is the answer for them rather than an empty string.
 */
export function mutationOverlayArt(mutation: MutationArtRecord): OverlayArt {
  return {
    ground: mutation.groundSprite ?? null,
    overlay: mutation.overlaySprite ?? null,
    fromBottom: mutation.overlayFromBottom === true,
  };
}
