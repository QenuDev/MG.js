/**
 * RFC 6902 JSON Patch application.
 *
 * The server sends state as a full snapshot in `Welcome` and then as JSON-Patch deltas. Applying
 * those deltas correctly is the difference between a wrapper that knows where your crops are and one
 * that quietly drifts out of sync.
 *
 * ## The `/child` question
 *
 * THE DOCUMENTED CONTRADICTION: the protocol doc's prose says that "game/farm state ... lives one level
 * deeper, at `fullState.child.data`" and warns that the extra nesting trips up naive path code later when
 * reconciling with patches, which implies game patches arrive `/child`-prefixed. But the doc's own
 * `applyPatch` reference sample never strips a `/child` prefix.
 *
 * Resolution: we root the state tree at the whole `fullState` object (`{ data, child: { data } }`),
 * so a `/child/...` path resolves literally and no stripping is needed. On top of that the applier is
 * *tolerant*: when a literal apply fails, it retries with the `child` token dropped, then with one
 * added. Every fallback that fires is recorded on the result, so drift is visible instead of silent.
 */

import type { Patch } from '../protocol/wire.js';
import { addLeadingChild, dropLeadingChild, formatPointer, parsePointer, resolvePointer } from './pointer.js';

/** What happened to one patch operation. */
export interface PatchOutcome {
  op: string;
  /** The path as the server sent it. */
  path: string;
  /** The path actually applied, which differs from `path` when a tolerance fallback fired. */
  appliedPath: string;
  /** How the path was resolved. */
  resolution:
    | 'literal'
    /** A `/child` prefix was dropped to find the target. */
    | 'dropped-child'
    /** A `/child` prefix was added to find the target. */
    | 'added-child'
    /**
     * A container along the path did not exist and was created.
     *
     * This mirrors the documented `JsonPatch.apply`, which walks the path "creating an array when the
     * next segment is numeric, an object otherwise" and extends an array "with nulls if the index is
     * past its current end". Without it, a patch referring to a branch the client has not seen yet is
     * dropped and the local state silently drifts from the server's.
     */
    | 'created-parent'
    | 'failed';
  ok: boolean;
  /** Why it failed, when it did. */
  error?: string;
}

/** The result of applying a batch. */
export interface ApplyPatchResult {
  /** Operations that applied cleanly, in order. */
  applied: number;
  /** Operations that did not. */
  failed: number;
  /** Per-operation detail, always the same length as the input batch. */
  outcomes: PatchOutcome[];
  /**
   * Paths where a tolerance fallback changed the target.
   *
   * Non-empty means the server's patch paths and this client's state root disagree, so log it,
   * because this kind of drift is otherwise invisible.
   */
  tolerated: PatchOutcome[];
  /** True when every operation applied. */
  ok: boolean;
}

/** Options for {@link applyPatch}. */
export interface ApplyPatchOptions {
  /**
   * When true (default), a failed literal apply is retried with the `child` token dropped, then with
   * one added. Set false to enforce literal RFC 6902 semantics.
   */
  tolerant?: boolean;
  /**
   * When true (default), containers missing along a path are created: an array when the next segment
   * is numeric, an object otherwise. An array index past the end is padded with `null`.
   *
   * This is the documented `JsonPatch.apply` behaviour, and it is the default because the real client
   * does it: a patch that references a branch this client has not seen yet must still land, or local
   * state drifts.
   */
  createMissing?: boolean;
  /** Called for every operation that fails outright. */
  onError?: (outcome: PatchOutcome) => void;
}

/** Per-operation context threaded through the applier. */
interface OpContext {
  createMissing: boolean;
  /** Set by {@link ensurePath} when it had to create something. */
  created: boolean;
}

// --------------------------------------------------------------------------------------
// Single-operation primitives, applied to a parent + key
// --------------------------------------------------------------------------------------

function isArrayIndex(token: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(token);
}

/**
 * Tokens that must never be used as a write key, however the path was spelled.
 *
 * A JSON Pointer is attacker-controlled: it arrives in a patch from the socket. `add /__proto__/pwned/inner`
 * used to read the *inherited* `__proto__` slot in {@link ensureContainer}, find an object, descend into it
 * and then assign onto it, so the container walk was itself the write primitive, and it ran before the
 * failure was recorded. Measured: `applied 0, failed 1`, and `Object.prototype.pwned` set anyway.
 *
 * `constructor` and `prototype` are the same idea one hop out (`/constructor/prototype/...`). A pointer that
 * names any of them is refused, and the operation is reported as failed.
 */
const FORBIDDEN_TOKENS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** True when `token` may not be used as a write key. See {@link FORBIDDEN_TOKENS}. */
function isForbiddenToken(token: string): boolean {
  return FORBIDDEN_TOKENS.has(token);
}

/**
 * The most holes one operation may create in an array.
 *
 * Padding is a bounded tolerance. The server's patches may name an index past the end, and the nulls are
 * filled in by the next write, but an unbounded tolerance is a denial of service.
 * `add /data/chat/20000000/x` used to allocate twenty million slots in a couple of hundred milliseconds,
 * from a single frame.
 *
 * RFC 6902 in fact forbids an `add` index greater than the array's length, so every gap is already beyond
 * spec; this caps the courtesy rather than removing it. The game's own arrays are a few dozen entries.
 */
const MAX_ARRAY_PADDING = 10_000;

function setAt(parent: unknown, key: string, value: unknown): void {
  if (isForbiddenToken(key)) {
    throw new Error(`Refusing to write the reserved key "${key}".`);
  }
  if (Array.isArray(parent)) {
    if (key === '-') {
      parent.push(value);
      return;
    }
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`Array index "${key}" is not a valid index.`);
    }
    if (index > parent.length + MAX_ARRAY_PADDING) {
      throw new Error(
        `Array index ${index} is more than ${MAX_ARRAY_PADDING} entries past the end of a ` +
          `${parent.length}-entry array.`,
      );
    }
    parent[index] = value;
    return;
  }
  if (parent !== null && typeof parent === 'object') {
    (parent as Record<string, unknown>)[key] = value;
    return;
  }
  throw new Error('Cannot set a property on a non-object value.');
}

function deleteAt(parent: unknown, key: string): void {
  if (isForbiddenToken(key)) {
    throw new Error(`Refusing to delete the reserved key "${key}".`);
  }
  if (Array.isArray(parent)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= parent.length) {
      throw new Error(`Array index ${key} out of range for removal.`);
    }
    parent.splice(index, 1);
    return;
  }
  if (parent !== null && typeof parent === 'object') {
    delete (parent as Record<string, unknown>)[key];
    return;
  }
  throw new Error('Cannot delete a property from a non-object value.');
}

/**
 * Ensure one container exists at `token` within `current`, typed by the segment that follows it.
 *
 * "creating an array when the next segment is numeric, an object otherwise". An existing container is
 * descended into rather than replaced, and a `null` left by array padding is filled in. That is the
 * case that matters, because padding produces nulls that are not yet containers.
 *
 * @returns the container, or `null` when the path cannot be created.
 */
function ensureContainer(
  current: unknown,
  token: string,
  nextToken: string,
  context: OpContext,
): unknown | null {
  // Refuse before any lookup: reading the inherited slot is what made a path like `/__proto__/a/b` walk
  // into `Object.prototype` and turn this function into a write primitive.
  if (isForbiddenToken(token)) return null;

  const wantArray = isArrayIndex(nextToken);

  if (Array.isArray(current)) {
    const index = Number(token);
    if (!Number.isInteger(index) || index < 0) return null;
    if (index > current.length + MAX_ARRAY_PADDING) return null;
    while (current.length <= index) current.push(null);
    let slot: unknown = current[index];
    if (slot === null || typeof slot !== 'object') {
      slot = wantArray ? [] : {};
      current[index] = slot;
      context.created = true;
    }
    return slot;
  }

  if (current !== null && typeof current === 'object') {
    const record = current as Record<string, unknown>;
    let slot: unknown = record[token];
    if (slot === null || typeof slot !== 'object') {
      slot = wantArray ? [] : {};
      record[token] = slot;
      context.created = true;
    }
    return slot;
  }

  return null;
}

/**
 * Create any missing containers on the path down to the leaf's *parent*.
 *
 * Takes the **full** token list, including the leaf, because the leaf's own name is what decides the
 * type of its parent container: `players` must become an array when the next segment is `0`, and an
 * object when it is `coins`.
 *
 * @returns true when the whole parent path now exists.
 */
function ensurePath(document: unknown, tokens: readonly string[], context: OpContext): boolean {
  let current: unknown = document;

  // Stop before the leaf: the leaf is the value being assigned, not a container to create.
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const token = tokens[i] as string;
    const nextToken = tokens[i + 1] as string;
    const next = ensureContainer(current, token, nextToken, context);
    if (next === null) return false;
    current = next;
  }

  return true;
}

/**
 * Apply one operation to `document`, in place.
 *
 * @returns `null` on success, or the error message.
 */
function applyOperation(document: unknown, patch: Patch, context: OpContext): string | null {
  const tokens = parsePointer(patch.path);

  switch (patch.op) {
    case 'add': {
      if (tokens.length === 0) return 'Cannot add to the document root.';
      const parentTokens = tokens.slice(0, -1);
      const parentPointer = formatPointer(parentTokens);
      const key = tokens[tokens.length - 1] as string;

      let parent = resolvePointer(document, parentPointer);
      if (!parent.found) {
        if (!context.createMissing) return `Parent path "${parentPointer}" does not exist.`;
        if (!ensurePath(document, tokens, context)) {
          return `Could not create the parent path "${parentPointer}".`;
        }
        parent = resolvePointer(document, parentPointer);
        if (!parent.found) return `Parent path "${parentPointer}" still does not exist.`;
      }

      if (Array.isArray(parent.value)) {
        if (key === '-') {
          parent.value.push(patch.value);
          return null;
        }
        if (!isArrayIndex(key)) return `"${key}" is not a valid array index.`;
        const index = Number(key);
        if (index > parent.value.length) {
          if (!context.createMissing) return `Array index ${index} is beyond the end.`;
          if (index - parent.value.length > MAX_ARRAY_PADDING) {
            return (
              `Array index ${index} is more than ${MAX_ARRAY_PADDING} entries past the end of a ` +
              `${parent.value.length}-entry array.`
            );
          }
          // Documented: pad with nulls rather than refusing.
          while (parent.value.length < index) parent.value.push(null);
          context.created = true;
          parent.value.push(patch.value);
          return null;
        }
        parent.value.splice(index, 0, patch.value);
        return null;
      }

      if (parent.value === null || typeof parent.value !== 'object') {
        return `Parent "${parentPointer}" is not an object or array.`;
      }
      if (isForbiddenToken(key)) return `Refusing to write the reserved key "${key}".`;
      (parent.value as Record<string, unknown>)[key] = patch.value;
      return null;
    }

    case 'remove': {
      if (tokens.length === 0) return 'Cannot remove the document root.';
      const parentPointer = formatPointer(tokens.slice(0, -1));
      const key = tokens[tokens.length - 1] as string;
      const parent = resolvePointer(document, parentPointer);
      if (!parent.found) return `Parent path "${parentPointer}" does not exist.`;
      const target = resolvePointer(document, patch.path);
      if (!target.found) return `Path "${patch.path}" does not exist.`;
      try {
        deleteAt(parent.value, key);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return null;
    }

    case 'replace': {
      const target = resolvePointer(document, patch.path);
      if (tokens.length === 0) return 'Cannot replace the whole document via a patch.';

      if (!target.found) {
        // RFC 6902 says replace requires an existing target, but the documented server applier treats
        // anything that is not `remove` as an assign, and a replace for a branch we have not seen yet
        // would otherwise be dropped. Honour the documented behaviour when allowed.
        if (!context.createMissing) return `Path "${patch.path}" does not exist.`;
        const parentTokens = tokens.slice(0, -1);
        const parentPointer = formatPointer(parentTokens);
        if (!ensurePath(document, tokens, context)) {
          return `Could not create the parent path "${parentPointer}".`;
        }
        const parent = resolvePointer(document, parentPointer);
        if (!parent.found) return `Parent path "${parentPointer}" does not exist.`;
        try {
          setAt(parent.value, tokens[tokens.length - 1] as string, patch.value);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
        context.created = true;
        return null;
      }

      try {
        setAt(target.parent, target.key, patch.value);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return null;
    }

    case 'move': {
      if (patch.from === undefined) return 'move requires "from".';
      const source = resolvePointer(document, patch.from);
      if (!source.found) return `Source path "${patch.from}" does not exist.`;
      // Guard against moving a container into itself: RFC 6902 forbids it and it corrupts the tree.
      const sourceTokens = parsePointer(patch.from);
      const destTokens = parsePointer(patch.path);
      if (
        destTokens.length > sourceTokens.length &&
        sourceTokens.every((token, i) => destTokens[i] === token)
      ) {
        return 'Cannot move a value into one of its own children.';
      }
      const value = source.value;
      try {
        deleteAt(source.parent, source.key);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return applyOperation(document, { op: 'add', path: patch.path, value }, context);
    }

    case 'copy': {
      if (patch.from === undefined) return 'copy requires "from".';
      const source = resolvePointer(document, patch.from);
      if (!source.found) return `Source path "${patch.from}" does not exist.`;
      return applyOperation(
        document,
        { op: 'add', path: patch.path, value: deepClone(source.value) },
        context,
      );
    }

    case 'test': {
      const target = resolvePointer(document, patch.path);
      if (!target.found) return `Path "${patch.path}" does not exist for test.`;
      if (!deepEqual(target.value, patch.value)) {
        return `Test failed at "${patch.path}".`;
      }
      return null;
    }

    default:
      return `Unsupported patch op "${String((patch as { op?: unknown }).op)}".`;
  }
}

/** Structured deep clone that survives the plain JSON data the server sends. */
export function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => deepClone(entry)) as unknown as T;
  // `Object.fromEntries` rather than a plain assignment loop: it creates every key with
  // `CreateDataPropertyOrThrow`, so an own `__proto__` key (which `JSON.parse` really does produce for a
  // `{"__proto__": ...}` input) is copied as a key instead of running the inherited setter, which
  // silently lost the key *and* replaced the clone's prototype.
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, deepClone(entry)]),
  ) as T;
}

/** Structural equality for the JSON data the server sends. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((entry, i) => deepEqual(entry, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as object);
    const bKeys = Object.keys(b as object);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) =>
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}

/**
 * Apply a batch of patch operations to a document, in place.
 *
 * Tolerant by default: a path that does not resolve literally is retried with the `child` token
 * dropped and then added, and whichever form worked is recorded in the outcome.
 */
export function applyPatch(
  document: unknown,
  patches: readonly Patch[],
  options: ApplyPatchOptions = {},
): ApplyPatchResult {
  const tolerant = options.tolerant ?? true;
  const createMissing = options.createMissing ?? true;
  const outcomes: PatchOutcome[] = [];

  for (const patch of patches) {
    const outcome = applyOne(document, patch, tolerant, createMissing);
    outcomes.push(outcome);
    if (!outcome.ok && options.onError) options.onError(outcome);
  }

  const applied = outcomes.filter((entry) => entry.ok).length;
  return {
    applied,
    failed: outcomes.length - applied,
    outcomes,
    tolerated: outcomes.filter((entry) => entry.ok && entry.resolution !== 'literal'),
    ok: applied === outcomes.length,
  };
}

/**
 * Apply a single operation, in strict priority order.
 *
 * The order matters, and it is deliberate:
 *
 *   1. **Literal path, no creation.** A path that resolves must never be second-guessed, and it must
 *      never have a container fabricated for it. A tree where both readings are valid always takes
 *      the literal one.
 *   2. **`/child` normalisation, still without creation.** This has to come *before* creation, or a
 *      `/child`-prefixed patch against a non-`/child`-rooted tree would satisfy itself by inventing a
 *      phantom `/child` branch instead of correcting to the real one. That would corrupt the tree
 *      quietly, which is the worst possible failure mode for a state engine.
 *   3. **Creation.** Only once the path is known not to resolve literally or under either `/child`
 *      reading do we create containers, following the documented "creating an array when the next
 *      segment is numeric, an object otherwise" behaviour.
 *   4. **Creation with `/child` normalisation**, as a last resort for a new branch reached
 *      through the other nesting convention.
 *
 * Every fallback that fires is recorded on the outcome, so drift is visible rather than silent.
 */
function applyOne(document: unknown, patch: Patch, tolerant: boolean, createMissing: boolean): PatchOutcome {
  const base: Pick<PatchOutcome, 'op' | 'path'> = { op: patch.op, path: patch.path };

  const attempt = (target: Patch, allowCreate: boolean): { ok: boolean; created: boolean } => {
    const context: OpContext = { createMissing: allowCreate, created: false };
    const error = applyOperation(document, target, context);
    return { ok: error === null, created: context.created };
  };

  // 1. Literal, strict.
  const literal = attempt(patch, false);
  if (literal.ok) {
    return { ...base, appliedPath: patch.path, resolution: 'literal', ok: true };
  }

  // 2. `/child` normalisation, strict.
  if (tolerant) {
    for (const variant of childVariants(patch)) {
      const result = attempt(variant.patch, false);
      if (result.ok) {
        return { ...base, appliedPath: variant.path, resolution: variant.resolution, ok: true };
      }
    }
  }

  // 3. Creation: literal path only, by design.
  //
  // Creation is NOT combined with a `/child` correction. A `/child` variant is already a guess about
  // which sub-tree a patch means; letting that guess also fabricate containers compounds two
  // uncertainties and produces phantom branches. Concretely: `add /data/list/abc` against
  // `{data:{list:[]}}` has no valid home, but the `/child` variant `/child/data/list/abc` would happily
  // invent an object at `/child/data/list` and "succeed". A patch that is definitely right but not yet
  // present gets created; a patch whose *target tree is uncertain* does not.
  if (createMissing) {
    const created = attempt(patch, true);
    if (created.ok) {
      return { ...base, appliedPath: patch.path, resolution: 'created-parent', ok: true };
    }
  }

  // Report the literal failure message, since it is the most useful one for a caller.
  const context: OpContext = { createMissing: false, created: false };
  const literalError = applyOperation(document, patch, context);
  return {
    ...base,
    appliedPath: patch.path,
    resolution: 'failed',
    ok: false,
    error: literalError ?? 'Patch could not be applied.',
  };
}

/**
 * The two `/child`-corrected readings of a patch, in preference order.
 *
 * Dropping a prefix is tried before adding one because the documentation's prose ("game/farm state
 * lives one level deeper, at `fullState.child.data`") describes patches that carry the prefix while a
 * client rooted lower would not.
 */
function childVariants(
  patch: Patch,
): { patch: Patch; path: string; resolution: PatchOutcome['resolution'] }[] {
  const variants: {
    patch: Patch;
    path: string;
    resolution: PatchOutcome['resolution'];
  }[] = [];

  const dropped = dropLeadingChild(patch.path);
  if (dropped !== null) {
    const variant: Patch = { ...patch, path: dropped };
    if (patch.from !== undefined) {
      const droppedFrom = dropLeadingChild(patch.from);
      if (droppedFrom !== null) variant.from = droppedFrom;
    }
    variants.push({ patch: variant, path: dropped, resolution: 'dropped-child' });
  }

  const added = addLeadingChild(patch.path);
  const addedVariant: Patch = { ...patch, path: added };
  if (patch.from !== undefined) addedVariant.from = addLeadingChild(patch.from);
  variants.push({ patch: addedVariant, path: added, resolution: 'added-child' });

  return variants;
}

/**
 * The documented `JsonPatch` helper.
 *
 * The API reference describes it as "static helper implementing the restricted JSON-Pointer patch
 * format the server sends inside `PartialStateMessage`. Not instantiable", and every member is static,
 * with a single method `apply(root, patch)` returning the new root.
 *
 * Its documented algorithm is more permissive than RFC 6902 by design, and the differences matter:
 *
 *   - it **creates containers along the path**: "creating an array when the next segment is numeric,
 *     an object otherwise";
 *   - at the leaf it "extends an array with nulls if the index is past its current end";
 *   - `op:"remove"` deletes, and **anything else assigns**, so `add` and `replace` converge on a path
 *     that does not exist yet.
 *
 * All three are provided here. This class is a thin, faithful facade over {@link applyPatch} restricted
 * to a single operation, so there is one applier implementation in the codebase rather than two
 * that can disagree.
 */
export class JsonPatch {
  /**
   * Not instantiable, matching the reference: every member is static.
   *
   * Enforced at runtime as well as in the type system: a `private constructor` is erased by the
   * compiler, so a plain-JavaScript caller would otherwise be able to `new JsonPatch()` happily.
   */
  private constructor() {
    throw new TypeError('JsonPatch is not instantiable; every member is static.');
  }

  /**
   * Apply one patch operation to `root`, in place, and return the root.
   *
   * @param root The state tree (room or game) to patch. Mutated in place for arrays/objects created
   *   along the way; the return value is the new root.
   * @param patch A single operation from a `PartialStateMessage`'s patches array.
   */
  static apply(root: unknown, patch: Patch): unknown {
    const context: OpContext = { createMissing: true, created: false };
    applyOperation(root, patch, context);
    return root;
  }

  /**
   * Apply a batch, returning the outcome detail as well as the root.
   *
   * Not part of the documented surface, provided because the useful part of applying a batch is
   * knowing which operations did not land.
   */
  static applyAll(
    root: unknown,
    patches: readonly Patch[],
    options?: ApplyPatchOptions,
  ): { root: unknown; result: ApplyPatchResult } {
    const result = applyPatch(root, patches, { createMissing: true, ...options });
    return { root, result };
  }
}
