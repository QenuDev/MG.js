/**
 * The revision a derived picture carries, derived from what the picture was made of rather than bumped by hand.
 *
 * The viewer has its own version of this: a hand-bumped integer that rides with the art version in a cache key,
 * `` `${artVersion}-${COMPOSITION_REVISION}` `` (`garden-viewer/server.mjs:86`, `:494`). It works, and it has
 * been bumped by hand twice, for changes nobody could have predicted a consumer would keep cached. The third
 * time somebody forgets, a garden goes on showing last week's picture and nothing throws.
 *
 * So this is a digest instead. Everything the pixels depend on goes in -- the art version, the sprite names,
 * the frames, the mutations in the order they stack -- and the same inputs produce the same string for as long
 * as this file's algorithm is unchanged. The art version is one input rather than the whole of it, because the
 * atlas can be repacked under a version that does not move, and a species' art can move without any version
 * moving at all.
 *
 * It is deliberately not a cryptographic digest. 64 bits of FNV-1a and djb2 over a canonical rendering of the
 * inputs is enough to key a cache, it costs nothing, and it needs no `node:crypto` -- which this entry cannot
 * have, because `@mg.js/art/source` is allowed `@mg.js/common/catalog` and the pure entry and nothing else.
 * What it is not is a security boundary, and the comment says so rather than leaving a reader to assume.
 */

/**
 * A value a picture's pixels can depend on.
 *
 * Strings and numbers are what these inputs actually are -- an art version, a sprite name, a frame's rect, a
 * mutation's name and the art it draws -- with arrays for the ordered things (layers, a stack of mutations)
 * and objects for the records. `undefined` is accepted so a caller can pass an optional field through without
 * a conditional; it hashes the same as the field being absent, which is the honest reading of it.
 */
export type RevisionInput =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly RevisionInput[]
  | { readonly [key: string]: RevisionInput };

/**
 * A key order is not a value: `{a: 1, b: 2}` and `{b: 2, a: 1}` are the same picture, so they must hash the
 * same. An array's order *is* a value: layers stack, and swapping two of them changes the pixels.
 */
function canonical(value: RevisionInput, out: string[], path: string): void {
  if (value === undefined) {
    out.push('~');
    return;
  }
  if (value === null) {
    out.push('null');
    return;
  }

  switch (typeof value) {
    case 'string':
      // Quoted, so a string can never be confused with the structural characters around it: without this,
      // `['a,b']` and `['a', 'b']` would render the same.
      out.push(JSON.stringify(value));
      return;
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      if (!Number.isFinite(value)) {
        // `NaN !== NaN` and two infinities render identically to their finite neighbours in some languages'
        // `toString`. Neither can be a sprite name or a frame coordinate, so refuse rather than collide.
        throw new TypeError(`${path} is ${String(value)}, which cannot key a cache`);
      }
      out.push(String(value));
      return;
    case 'object': {
      if (Array.isArray(value)) {
        out.push('[');
        for (const [index, item] of value.entries()) canonical(item, out, `${path}[${index}]`);
        out.push(']');
        return;
      }
      const record = value as { readonly [key: string]: RevisionInput };
      out.push('{');
      for (const key of Object.keys(record).sort()) {
        const item = record[key];
        if (item === undefined) continue; // Absent and undefined are one value, not two.
        out.push(`${JSON.stringify(key)}:`);
        canonical(item, out, `${path}.${key}`);
      }
      out.push('}');
      return;
    }
    default:
      // A function or a symbol got in here through a cast. Hashing `String(value)` would produce a revision
      // that does not change when the value does, which is the one failure this whole file exists to prevent.
      throw new TypeError(`${path} is a ${typeof value}, which cannot key a cache`);
  }
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function djb2(text: string): number {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = (Math.imul(hash, 33) + text.charCodeAt(index)) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The revision of a picture, as sixteen hex characters.
 *
 * Sixteen rather than eight because one 32-bit digest over a few thousand distinct pictures has a collision
 * probability nobody would accept in a cache key; two independent 32-bit digests over the same text do not
 * make a collision impossible, they make it something a caller will not see.
 *
 * Changing the algorithm changes every revision, which invalidates every cache once. That is the correct
 * failure for a cache, and it is why the algorithm is stated here rather than left to a dependency's version.
 */
export function contentRevision(inputs: RevisionInput): string {
  const out: string[] = [];
  canonical(inputs, out, 'inputs');
  const text = out.join('');
  return `${fnv1a(text).toString(16).padStart(8, '0')}${djb2(text).toString(16).padStart(8, '0')}`;
}
