/**
 * JSON Pointer (RFC 6901) support.
 *
 * The state tree is addressed by pointer strings that arrive from the server in patch operations, so
 * this has to be exact: `~0` escapes `~`, `~1` escapes `/`, and a leading `/` with the empty string
 * after it means "the whole document".
 */

import { MgProtocolError } from '../errors.js';

/** A parsed pointer: the sequence of reference tokens from the document root. */
export type PointerTokens = readonly string[];

/**
 * Parse a JSON Pointer into tokens.
 *
 * @throws {MgProtocolError} when the pointer is not syntactically valid.
 */
export function parsePointer(pointer: string): PointerTokens {
  if (pointer === '') return [];

  if (!pointer.startsWith('/')) {
    throw new MgProtocolError(`Invalid JSON Pointer "${pointer}": must be empty or start with "/".`);
  }

  return pointer
    .slice(1)
    .split('/')
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** Escape a single reference token for use inside a pointer. */
export function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Build a pointer string from tokens. */
export function formatPointer(tokens: PointerTokens): string {
  if (tokens.length === 0) return '';
  return `/${tokens.map(escapeToken).join('/')}`;
}

/** Join a base pointer with additional tokens. */
export function joinPointer(base: string, ...tokens: string[]): string {
  const baseTokens = parsePointer(base);
  return formatPointer([...baseTokens, ...tokens]);
}

/**
 * Resolve a pointer against a document.
 *
 * Returns `{ found: false }` rather than throwing when the path does not exist, because callers need to
 * distinguish "not there" from "malformed", and patches are allowed to fail without being errors.
 */
export function resolvePointer(
  document: unknown,
  pointer: string,
): { found: true; value: unknown; parent: unknown; key: string } | { found: false } {
  let tokens: PointerTokens;
  try {
    tokens = parsePointer(pointer);
  } catch {
    return { found: false };
  }

  if (tokens.length === 0) {
    return { found: true, value: document, parent: null, key: '' };
  }

  let current: unknown = document;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    const isLast = i === tokens.length - 1;

    if (current === null || typeof current !== 'object') return { found: false };

    if (Array.isArray(current)) {
      const index = token === '-' ? current.length : Number(token);
      if (!Number.isInteger(index) || index < 0 || index > current.length) return { found: false };
      if (isLast) return { found: true, value: current[index], parent: current, key: String(index) };
      if (index === current.length) return { found: false };
      current = current[index];
      continue;
    }

    const record = current as Record<string, unknown>;
    if (!Object.hasOwn(record, token)) return { found: false };
    if (isLast) return { found: true, value: record[token], parent: record, key: token };
    current = record[token];
  }

  return { found: false };
}

/** Read a pointer, returning `undefined` when it does not resolve. */
export function getPointer(document: unknown, pointer: string): unknown {
  const result = resolvePointer(document, pointer);
  return result.found ? result.value : undefined;
}

/**
 * True when `pointer` addresses `candidate` or something inside it.
 *
 * This is what lets a subscriber to `/data/inventory` be woken by a patch to
 * `/data/inventory/3` without walking the whole tree.
 */
export function pointerContains(candidate: string, pointer: string): boolean {
  if (candidate === '') return true;
  if (pointer === candidate) return true;
  return pointer.startsWith(`${candidate}/`);
}

/**
 * Strip a leading `child` token, if present.
 *
 * The protocol doc's prose says game-state patches are `/child`-prefixed while room-state patches are
 * not, but its own `applyPatch` sample never strips one. Kept as a named helper so the tolerance in
 * `patch.ts` is explicit rather than accidental.
 */
export function dropLeadingChild(pointer: string): string | null {
  if (pointer === '/child') return '';
  if (pointer.startsWith('/child/')) return pointer.slice('/child'.length);
  return null;
}

/** Add a leading `child` token, for the mirror-image fallback. */
export function addLeadingChild(pointer: string): string {
  return pointer === '' ? '/child' : `/child${pointer}`;
}
