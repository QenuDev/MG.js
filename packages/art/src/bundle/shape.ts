/**
 * The vocabulary `@mg.js/art/bundle` reads a minified chunk in: shapes, not syntax trees.
 *
 * The predicates here cannot name a minified symbol -- the names change every build -- and they cannot name a
 * parser either, because the pure entry is handed to a browser as one file with no bundler. So a chunk arrives
 * already projected into this vocabulary: object literals with their members, functions with their free
 * identifiers, declarations by name, and the one idiom minified code uses to build a string enum.
 *
 * Nothing in this module imports anything, and nothing in it knows what TypeScript is. The projection is
 * produced by whoever has the parser: `tools/typescript-reader.ts` for this repo's sync, and anything small
 * enough to read `{ key: `value` }` for a runtime that has no parser at all. That is the pluggability §8 of the
 * plan promises, and it is why the predicates below are testable against a hand-written projection.
 *
 * Two normalisations happen in the reader rather than here, and they are the reader's business because they are
 * minifier idioms rather than game shapes:
 *
 *   - `!0` and `!1` are the minifier's `true` and `false`, so a boolean member arrives as `{kind: 'boolean'}`.
 *   - a backtick literal with no substitutions is a string, so a sprite table written in backticks arrives with
 *     the same `kind` as one written in quotes. `quote` says which it was, because the plan's spike found the
 *     game's sprite names are backticks and a reader that dropped them would report an empty table.
 */

/** A string as the chunk wrote it, and how it was delimited. */
export interface ShapeString {
  readonly kind: 'string';
  readonly text: string;
  readonly quote: 'single' | 'double' | 'template';
}

/** A number, with the text the chunk wrote (`0.75`, `.75`, `1e3`) and its value. */
export interface ShapeNumber {
  readonly kind: 'number';
  readonly text: string;
  readonly value: number;
}

export interface ShapeBoolean {
  readonly kind: 'boolean';
  readonly value: boolean;
}

export interface ShapeNull {
  readonly kind: 'null';
}

export interface ShapeArray {
  readonly kind: 'array';
  readonly items: readonly ShapeValue[];
}

/** An object literal, whether or not it is assigned to a name. */
export interface ShapeObject {
  readonly kind: 'object';
  readonly object: ShapeObjectLiteral;
}

/**
 * A name or a chain of member accesses, kept as the chain: `<Alias>.<Category>.<Name>` arrives as
 * `['<Alias>', '<Category>', '<Name>']`. A computed member (`<table>[<Alias>.<Category>.<Name>]`) arrives as a
 * separate member-shape, so the chain is all this ever holds. The predicates resolve a chain they recognise and report one they cannot.
 */
export interface ShapeReference {
  readonly kind: 'reference';
  readonly path: readonly string[];
  readonly text: string;
}

/** A call or a construction. `args` are projected values, so `new Filter({color, alpha})` is readable. */
export interface ShapeCall {
  readonly kind: 'call';
  readonly callee: string;
  readonly construct: boolean;
  readonly args: readonly ShapeValue[];
  readonly text: string;
}

/** Anything else, with its source text, so a predicate can say what it saw instead of guessing. */
export interface ShapeOther {
  readonly kind: 'other';
  readonly text: string;
}

export type ShapeValue =
  | ShapeString
  | ShapeNumber
  | ShapeBoolean
  | ShapeNull
  | ShapeArray
  | ShapeObject
  | ShapeReference
  | ShapeCall
  | ShapeOther;

/** One `key: value` member of an object literal. A computed key arrives as a member-shape, see below. */
export interface ShapeMember {
  readonly key: string;
  readonly computed: boolean;
  readonly value: ShapeValue;
}

export interface ShapeObjectLiteral {
  /** The variable the literal is assigned to, when it is assigned to one; `null` otherwise. */
  readonly name: string | null;
  readonly members: readonly ShapeMember[];
  /** Byte offsets in the chunk's own source, so provenance can name them. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * `e.Single = 'Single'`, the minifier's string enum: a function that assigns a literal to each member of the
 * object it returns. Kept chunk-wide rather than inside a declaration because the enum is often built through
 * an immediately-invoked function expression, which is not an object literal at all.
 */
export interface ShapeAssignment {
  readonly path: readonly string[];
  readonly value: ShapeValue;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** A function declaration or expression, with the reads that are not bound inside it. */
export interface ShapeFunction {
  readonly name: string | null;
  readonly parameters: readonly string[];
  /** Identifiers read inside the function that it does not itself bind, sorted and unique. */
  readonly free: readonly string[];
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** A chunk-local named declaration, in a form a plain function body could re-declare. */
export interface ShapeDeclaration {
  readonly name: string;
  /** The form `text` re-declares it in: `const` for a value, `function` for a function. */
  readonly kind: 'const' | 'function';
  /** What the chunk itself wrote (`const`, `let`, `var`), which `kind` deliberately does not repeat. */
  readonly sourceKind: 'const' | 'let' | 'var' | 'function';
  /** The initializer's shape, or `null` for a function declaration. */
  readonly value: ShapeValue | null;
  /** `<kind> <declarator>;` for a variable, the function's own text for a function. */
  readonly text: string;
  /**
   * Where the chunk's own declarator text begins inside `text` (`0` for a function declaration). The declarator
   * inside is byte-identical to `[start, end)` of the chunk, which is what lets a fixture be cut from a chunk
   * and its byte ranges be translated back: `text.slice(bodyStart, bodyStart + (end - start))` is that span.
   */
  readonly bodyStart: number;
  /**
   * The chunk's span of the declaration, and of its initializer.
   *
   * Evidence cites the *initializer* wherever it can, because that is the text a fixture reproduces byte for
   * byte: the statement wrapper a re-declaration adds may differ in whitespace from the game's minified one, and
   * a byte range that included it would not survive the trip through a fixture.
   */
  readonly start: number;
  readonly end: number;
  readonly valueStart: number;
  readonly valueEnd: number;
}

/** One named import: an aliased import is recorded as its local name, the name it states, and its module. */
export interface ShapeImport {
  readonly local: string;
  readonly imported: string;
  readonly from: string;
}

/**
 * A chunk as the predicates see it. `objects` holds every object literal in the chunk, including nested ones
 * and including literals that are not assigned to a name.
 */
export interface ParsedChunk {
  readonly file: string;
  readonly text: string;
  readonly objects: readonly ShapeObjectLiteral[];
  readonly functions: readonly ShapeFunction[];
  readonly declarations: readonly ShapeDeclaration[];
  readonly assignments: readonly ShapeAssignment[];
  readonly imports: readonly ShapeImport[];
}

/** The object literal a value wraps, or `null` when the value is not one. */
export function asObject(value: ShapeValue | null | undefined): ShapeObjectLiteral | null {
  return value !== null && value !== undefined && value.kind === 'object' ? value.object : null;
}

/** The string a value states, or `null`. Both quoted strings and bare backtick literals count. */
export function asString(value: ShapeValue | null | undefined): ShapeString | null {
  return value !== null && value !== undefined && value.kind === 'string' ? value : null;
}

/** The declaration named `name` in a chunk, or `null`. */
export function declarationNamed(chunk: ParsedChunk, name: string): ShapeDeclaration | null {
  return chunk.declarations.find((declaration) => declaration.name === name) ?? null;
}

/** The value of the member `key` of an object literal, or `null` when it has no such member. */
export function memberValue(object: ShapeObjectLiteral, key: string): ShapeValue | null {
  const member = object.members.find((candidate) => candidate.key === key);
  return member?.value ?? null;
}

/** The keys of an object literal, in source order. A computed key contributes its source text. */
export function memberKeys(object: ShapeObjectLiteral): readonly string[] {
  return object.members.map((member) => member.key);
}

/**
 * Every string leaf of an object literal, following object values and nothing else.
 *
 * A table of tables is the game's normal shape (a category, then a name), and a member that is a function or a
 * reference is not a leaf this reads: it is reported by the predicate that met it, not silently flattened.
 */
export function leafStrings(object: ShapeObjectLiteral): readonly ShapeString[] {
  const found: ShapeString[] = [];
  const walk = (node: ShapeObjectLiteral, depth: number): void => {
    if (depth > MAX_LEAF_DEPTH) return;
    for (const member of node.members) {
      const string = asString(member.value);
      if (string !== null) found.push(string);
      else {
        const nested = asObject(member.value);
        if (nested !== null) walk(nested, depth + 1);
      }
    }
  };
  walk(object, 0);
  return found;
}

/**
 * A depth cap on {@link leafStrings}. The tables this reads are two levels deep; a deeper literal is a
 * different table that happens to sit inside this one, and flattening it would inflate a coverage count.
 */
const MAX_LEAF_DEPTH = 4;

/**
 * Every string leaf's `[path, value]`, where `path` is the chain of member keys from the root.
 *
 * This is what resolves a reference by its tail: the sprite-name table is keyed `Plant` → `Aloe`, and a chunk
 * elsewhere writes the same chain as a computed key or as a value, so the tail `<Category>.<Name>` is the
 * lookup.
 */
export function leafEntries(
  object: ShapeObjectLiteral,
  prefix: readonly string[] = [],
  depth = 0,
): readonly (readonly [readonly string[], ShapeString])[] {
  const found: (readonly [readonly string[], ShapeString])[] = [];
  if (depth > MAX_LEAF_DEPTH) return found;
  for (const member of object.members) {
    const path = [...prefix, member.key];
    const string = asString(member.value);
    if (string !== null) found.push([path, string]);
    else {
      const nested = asObject(member.value);
      if (nested !== null) found.push(...leafEntries(nested, path, depth + 1));
    }
  }
  return found;
}

/** True when `outer` covers `inner`: the same node, or a node that contains it. */
export function contains(outer: ShapeObjectLiteral, inner: ShapeObjectLiteral): boolean {
  return outer.start <= inner.start && outer.end >= inner.end;
}

/** Serialise a shape value back to JSON when it is a literal, or `null` when it is an expression. */
export function literalJson(value: ShapeValue): unknown {
  switch (value.kind) {
    case 'string':
      return value.text;
    case 'number':
      return value.value;
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'array': {
      const items: unknown[] = [];
      for (const item of value.items) {
        const literal = literalJson(item);
        if (literal === UNRESOLVED) return UNRESOLVED;
        items.push(literal);
      }
      return items;
    }
    case 'object': {
      const record: Record<string, unknown> = {};
      for (const member of value.object.members) {
        const literal = literalJson(member.value);
        if (literal === UNRESOLVED) return UNRESOLVED;
        record[member.key] = literal;
      }
      return record;
    }
    default:
      return UNRESOLVED;
  }
}

/** A sentinel: this shape value is an expression, so it has no literal JSON to hand back. */
export const UNRESOLVED: unique symbol = Symbol('unresolved');
