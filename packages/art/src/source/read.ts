/**
 * Reading the game's own JSON without trusting its shape.
 *
 * Every value below came off the wire, so a field can be absent, of a type it should not be, or an object
 * where an array was expected: the manifest and the packs are the game's own build output, not a contract
 * this package controls. None of these reads a value the game did not state, and none supplies a default
 * for one it did not -- a missing field is `undefined`, and the caller decides whether that is a refusal or
 * something to skip.
 */

/** An object, or `undefined` for anything that is not one. An array is not a record here. */
export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** An array, or an empty one for anything that is not. */
export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A non-empty string, or `undefined` for anything that is not one. */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
