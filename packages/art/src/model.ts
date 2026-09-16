/**
 * The model: values in, values out, no imports at runtime.
 *
 * Two things a picture is built from live here. The first is a sprite frame's own geometry -- the atlas states
 * how large a frame's art is meant to be drawn (`sourceSize` over `sourcePixelRatio`) and which point of it a
 * position refers to (`anchor`), and a sprite PNG states neither. The second is box arithmetic: where a set of
 * placed parts actually reaches once they are turned about their own anchors, how one part sits inside that
 * box, and the two factors that fit a picture into the room a caller gives it.
 *
 * Every number that is not arithmetic is named with where it came from, because the consumer's history is
 * twelve commits of a wrong transcribed constant, anchor or sign. The values are the consumer's own
 * measurements, and the tests beside this file are its tests ported rather than rewritten.
 */

/** The reference tile a `sourcePixelRatio` is taken against, in the sprites' own pixels. */
export const REFERENCE_TILE_PX = 256;

/**
 * Which point of a frame's art a position refers to, as a share of the art's own width and height.
 *
 * The middle, when the atlas leaves the frame's own `anchor` out. Nothing else in the game defaults this way:
 * the two other anchor defaults in the drawing model are 0.4 for a mutation placement and 1 for the foot of a
 * plant's art, and they answer three different questions.
 */
const ANCHOR_MIDDLE = 0.5;

/** One frame of the game's atlas, as its JSON states it. Only the three fields the drawn size needs are read. */
export interface AtlasFrame {
  /** The art's own pixel size, which is what an untrimmed sprite PNG is. */
  readonly sourceSize?: { readonly w?: number; readonly h?: number } | undefined;
  /** How much finer a frame's pixels are than the reference tile, where the atlas states it. */
  readonly sourcePixelRatio?: number | undefined;
  /** Which point of the art a placement refers to, as a share of the art. */
  readonly anchor?: { readonly x?: number; readonly y?: number } | undefined;
}

/** The size a frame's art is drawn at, the divisor that got there, and the anchor it is drawn about. */
export interface FrameBox {
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly anchorX: number;
  readonly anchorY: number;
}

/** A number a game table stated, or `undefined` for anything that is not one. */
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * A frame's drawn size, divisor and anchor, from the frame the atlas published.
 *
 * `sourcePixelRatio` divides the art's source size: a tomato's crop art is 184 pixels and is drawn at 92 of
 * them, because the frame says its pixels are twice as fine as the tile's. A frame that omits the ratio draws
 * at its stated size -- one, not `NaN` -- and one that omits its anchor is drawn about the middle. A record
 * that states no source size draws at nothing rather than at a number this function made up.
 */
export function frameBox(frame: unknown): FrameBox {
  const record = (typeof frame === 'object' && frame !== null ? frame : {}) as AtlasFrame;
  const stated = record.sourcePixelRatio;
  const pixelRatio = isNumber(stated) && stated > 0 ? stated : 1;
  const source = typeof record.sourceSize === 'object' && record.sourceSize !== null ? record.sourceSize : {};
  const anchor = typeof record.anchor === 'object' && record.anchor !== null ? record.anchor : {};
  return {
    width: (isNumber(source.w) ? source.w : 0) / pixelRatio,
    height: (isNumber(source.h) ? source.h : 0) / pixelRatio,
    pixelRatio,
    anchorX: isNumber(anchor.x) ? anchor.x : ANCHOR_MIDDLE,
    anchorY: isNumber(anchor.y) ? anchor.y : ANCHOR_MIDDLE,
  };
}

/**
 * A part of a picture: a rectangle of the sprites' own pixels, and the point it is turned about when it turns.
 *
 * `anchorX`/`anchorY` are shares of the part's own width and height, and both default to 0 -- the top-left
 * corner -- which is what the page's own box arithmetic uses for a part that states none.
 */
export interface PlacedPart {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly anchorX?: number | undefined;
  readonly anchorY?: number | undefined;
  readonly turn?: number | undefined;
}

/** A box in the sprites' own pixels, measured from where its own left and top edges are. */
export interface PartExtent {
  readonly minX: number;
  readonly minY: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The four corners of a part as it is drawn, once it is turned about its own anchor.
 *
 * A turned part reaches outside the rectangle it was laid out in, and the corners are what says by how much:
 * a crop turned on its plant has to be held by the picture it is drawn in, or the top of the fruit is cut off.
 */
function cornersOf(part: PlacedPart): readonly (readonly [number, number])[] {
  const anchorAtX = part.left + (part.anchorX ?? 0) * part.width;
  const anchorAtY = part.top + (part.anchorY ?? 0) * part.height;
  const turned = ((part.turn ?? 0) * Math.PI) / 180;
  const cos = Math.cos(turned);
  const sin = Math.sin(turned);
  const corners: readonly (readonly [number, number])[] = [
    [part.left, part.top],
    [part.left + part.width, part.top],
    [part.left, part.top + part.height],
    [part.left + part.width, part.top + part.height],
  ];
  return corners.map(([x, y]) => {
    const across = x - anchorAtX;
    const down = y - anchorAtY;
    return [anchorAtX + across * cos - down * sin, anchorAtY + across * sin + down * cos] as const;
  });
}

/**
 * The box a set of parts occupies **as it is drawn**, in the sprites' own pixels.
 *
 * Measured around the parts' drawn corners rather than around where they were put, so a part turned about its
 * anchor widens the box instead of being clipped by it. An empty set is an empty box at the origin rather than
 * an infinite one, because `Math.min()` of nothing is `Infinity`.
 */
export function extentOf(parts: readonly PlacedPart[]): PartExtent {
  const corners = parts.flatMap(cornersOf);
  if (corners.length === 0) return { minX: 0, minY: 0, width: 0, height: 0 };
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { minX, minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/** A box in the sprites' own pixels, measured the way a placement is: from its left and top edges. */
export interface ArtBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A rectangle, from either way of measuring one: left/top or minX/minY. */
type Rectangle = ArtBox | PartExtent;

/** One rectangle as a box, whichever way it was measured. */
function asBox(part: Rectangle): ArtBox {
  if ('minX' in part) return { left: part.minX, top: part.minY, width: part.width, height: part.height };
  return { left: part.left, top: part.top, width: part.width, height: part.height };
}

/**
 * The box one or more placed parts together occupy, as a union.
 *
 * A crop's art unioned with every mutation picture placed on it is the composed crop's box, and the box is
 * what makes the composed picture placeable inside the page's own layout: a mutation's art can only add to a
 * crop's, never take from it. A part that turns first has to be measured around its own corners, which is
 * what `extentOf` is for -- pass that extent here rather than the placement. An empty set is an empty box at
 * the origin rather than an infinite one.
 */
export function boxOf(parts: readonly Rectangle[]): ArtBox {
  if (parts.length === 0) return { left: 0, top: 0, width: 0, height: 0 };
  const boxes = parts.map(asBox);
  const left = Math.min(...boxes.map((box) => box.left));
  const top = Math.min(...boxes.map((box) => box.top));
  const right = Math.max(...boxes.map((box) => box.left + box.width));
  const bottom = Math.max(...boxes.map((box) => box.top + box.height));
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * A part's own vertical share of the box it is placed in, as a share of the box's height.
 *
 * Not a default this function applies: it is the value a *caller* applies when it states no anchor of its own,
 * and the drawing model defaults it to 0.4 -- the share the game centres a mutation's picture at when a
 * species states no override.
 *
 * The page has no such default today. `page.html:1309-1312` divides by `inBox.width` and `inBox.height`, and
 * gives a part with no anchor a share of `NaN`. This package states the default rather than inheriting that.
 */
export const PLACEMENT_ANCHOR_Y = 0.4;

/** Where a part lands inside a box, as shares of that box rather than as CSS. */
export interface PartPlacement {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** The share of the part's own width its turning is about, or `null` when it does not turn. */
  readonly transformOriginX: number | null;
  /** The share of the part's own height its turning is about, or `null` when it does not turn. */
  readonly transformOriginY: number | null;
}

/**
 * Where a part lands inside a box, as a placement.
 *
 * A placement and not a style: the page writes these shares into `style.left` and its neighbours, and it is
 * the page's business that they end up as a percentage. A crop that turns is stated to turn about its own
 * anchor -- the point it is pinned to its plant by, not its middle -- and a part that does not turn states no
 * origin at all, so a caller cannot apply a rotation nobody asked for. A box with no width or height has no
 * shares to give, and its parts land at nothing rather than at `NaN` or `Infinity`.
 */
export function placePart(part: PlacedPart, inBox: PartExtent): PartPlacement {
  const share = (of: number, whole: number) => (whole === 0 ? 0 : of / whole);
  const turns = part.turn !== undefined && part.turn !== 0;
  return {
    left: share(part.left - inBox.minX, inBox.width),
    top: share(part.top - inBox.minY, inBox.height),
    width: share(part.width, inBox.width),
    height: share(part.height, inBox.height),
    transformOriginX: turns ? (part.anchorX ?? 0) : null,
    transformOriginY: turns ? (part.anchorY ?? 0) : null,
  };
}

/** The box a picture is drawn in, and the room it has to be drawn in. */
export interface PictureSpace {
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

/** How large a picture is drawn inside the room it was given, as shares of that room. */
export interface PictureFit {
  readonly width: number;
  readonly height: number;
}

/** The room a picture gets when the caller states none: a square, so the longer side takes all of its axis. */
const FULL_SPACE = 100;

/**
 * The scale that fits a picture into the room it is given, as a width and a height share.
 *
 * The picture keeps its own shape whatever the room's. Today's page fits every picture into a square
 * (`page.html:1510-1512`: `aspect >= 1` takes the whole width and the same fraction of the height), so the
 * default room is square and the longer side takes all of its axis. A room that is not square is a different
 * question the page has not had to ask yet, and the answer here is the one a `contain` fit gives: one factor
 * for both axes, never a stretch. It is a share rather than a style for the same reason `placePart` is -- the
 * page is what knows a share becomes a percentage, and the community API's scene endpoint, which rasterises
 * the same recipe, has no stylesheet at all.
 */
export function fitPicture(picture: ArtBox | PictureSpace, space?: PictureSpace): PictureFit {
  const width = picture.width ?? 0;
  const height = picture.height ?? 0;
  const intoWidth = space?.width ?? FULL_SPACE;
  const intoHeight = space?.height ?? FULL_SPACE;
  if (width <= 0 || height <= 0 || intoWidth <= 0 || intoHeight <= 0) return { width: 0, height: 0 };
  const fit = Math.min(intoWidth / width, intoHeight / height);
  return { width: (width * fit) / intoWidth, height: (height * fit) / intoHeight };
}
