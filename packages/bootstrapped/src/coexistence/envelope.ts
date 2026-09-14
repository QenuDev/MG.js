/**
 * The one home for the `QuinoaCommand` envelope predicate.
 *
 * ## Why this module exists
 *
 * Both outbound renumbering paths need the same two answers: "is this parsed value an envelope?" and "is
 * this raw frame worth parsing at all?". Before this module existed, each answered them itself.
 * `coexistence/renumber.ts` and `client.ts` each defined their own `asEnvelope`, and each carried its own
 * copy of the length/substring/parse gate; `client.ts`'s copy was justified in a comment as keeping "the two
 * modules independent", which was untrue, because `client.ts` already imported `Renumberer` from
 * `renumber.ts`. The copies were byte-identical, so nothing observable differed *yet*. That is precisely
 * the danger: a wire predicate with several homes drifts silently, and a frame one copy renumbers while
 * another leaves alone is a sequence violation the player sees as a dead session.
 *
 * `tests/coexistence/envelope.test.ts` asserts that every consumer reaches the same function *objects*, so a
 * fourth copy cannot be introduced without failing a test.
 *
 * ## What this is not
 *
 * `common/protocol/envelope.ts` exports `isWrappedFrame`, which reads similarly and is not this module by
 * design. That one is a *typed* guard over the outbound union, for code that already holds a frame this
 * library built. These two work in the unknown domain, where the value came off the wire, possibly from
 * the game's own send path, so nothing may be assumed about it.
 */

/**
 * The shortest string that can hold the marker as a JSON `type`.
 *
 * `{"type":"QuinoaCommand"}` is 24 characters and 16 is the length of its prefix `{"type":"QuinoaC`, so
 * nothing shorter can be an envelope and the substring scan can be skipped outright. The bound is a fast
 * path, never a decision: everything it rejects would have been rejected by {@link asEnvelope} too.
 */
const MIN_ENVELOPE_LENGTH = 16;

/**
 * The wire shape of a `QuinoaCommand` envelope, as far as renumbering cares.
 *
 * Loose on purpose: the value arrives from `JSON.parse` of traffic we did not build, so every field is
 * unknown until it is checked, and every unrecognised field has to survive a re-serialisation untouched.
 */
export interface CommandEnvelope {
  type?: unknown;
  commandSequence?: unknown;
  requestId?: unknown;
  [key: string]: unknown;
}

/**
 * Extract a `QuinoaCommand` envelope from an arbitrary value.
 *
 * The check is on `type === 'QuinoaCommand'` rather than on the presence of `commandSequence`, because the
 * protocol's `QuinoaCommand` is the only frame that carries a sequence and gating on `type` is what stops us
 * rewriting some future frame that happens to have a `commandSequence` field for an unrelated reason. The
 * recon's own send path does the same thing with `data.includes('QuinoaCommand')` on the serialised string.
 *
 * Accepts a parsed object only. A string is not parsed here: that is {@link parseEnvelope}'s job, so a
 * caller is free to keep the cheap string gate ahead of the expensive one.
 */
export function asEnvelope(frame: unknown): CommandEnvelope | null {
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return null;
  const record = frame as Record<string, unknown>;
  if (record['type'] !== 'QuinoaCommand') return null;
  return record;
}

/**
 * The cheap gate in front of {@link asEnvelope}: length, then substring, then parse.
 *
 * The order carries the value. The recon records that an earlier version of the companion mod "scan[ned] the
 * big frames for substrings they cannot contain" and that this "turned this hook into a per-frame cost heavy
 * enough to be felt as jank", so this does the O(1) length reject, then the O(n) substring scan, and only
 * then the parse, which runs once per outbound command and so must not run on frames that cannot match.
 *
 * Total on purpose: a non-string, an unparseable string, and a string that is JSON but not an envelope all
 * answer `null`, so a caller can hand it whatever the socket produced without guarding first.
 */
export function parseEnvelope(raw: unknown): CommandEnvelope | null {
  if (typeof raw !== 'string' || raw.length < MIN_ENVELOPE_LENGTH) return null;
  if (!raw.includes('QuinoaCommand')) return null;
  try {
    return asEnvelope(JSON.parse(raw));
  } catch {
    return null;
  }
}
