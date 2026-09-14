# Audit 01: `common/protocol` + `errors.ts`

Scope: `packages/common/src/protocol/{codec,close-codes,connect-url,envelope,forms,id,index,result-codes,sequencer,types}.ts`
and `packages/common/src/errors.ts`. Every finding below was reproduced by running the shipped build
(`packages/common/dist/protocol/*.js`) under `node --input-type=module`, not inferred.

Answers to the four hunt questions, up front:
- **Form selection** is single-sourced for every real caller (`FormRegistry.formOf` → `buildFrame`),
  but `BuildFrameOptions.form` is an unvalidated escape hatch that silently produces the wrong scope (F2).
- **Query-value JSON quoting** is applied in exactly one place (`encodeQueryValue`, only used by
  `buildConnectUrlDetailed`), but the *path* segments (`room`, `version`) get no encoding at all (F1).
- **Sequencing** has one abstraction with two strategies that agree on `frontier + 1`; the constructor
  silently discards a caller-supplied strategy (F3).
- **Close codes**: the 18-code table is complete and all comparisons in these files go through `CloseCode`
  members, not bare numbers (only comments quote numbers). See notes N1.

---

## F1: `room` and `version` are interpolated into the connect-URL path with no encoding (high, security)

`buildConnectUrlDetailed` builds `new URL(\`wss://${host}/version/${options.version}/api/rooms/${room}/connect\`)`
at `connect-url.ts:57`, taking `room` from `options.room` unchanged (`:52`) and `version` from
`options.version` (`:62`). Every *query* value goes through `encodeQueryValue` (`:60-75`), so the file is
strict about one half of the URL and not at all about the other.

Reproduced:

    buildConnectUrlDetailed({ version: '1157', room: 'abc&x=1#frag' })
    -> wss://magicgarden.gg/version/1157/api/rooms/abc&x=1?surface=%22web%22&...
       ...&clientVisibilityState=%22visible%22#frag/connect      // the /connect segment is now a fragment

    buildConnectUrlDetailed({ version: '../../evil' })
    -> wss://magicgarden.gg/evil/api/rooms/qvoae1xdvx/connect?...  // path traversal, /version/1157 gone

Both inputs are reachable from ordinary configuration, not a contrived one: `HeadlessClient` forwards
`roomOption` straight in (`headless/src/client.ts:640-647`) and `RoomSocketConnectOptions.room` is
documented as caller-supplied (`headless/src/room-socket.ts:67-68`); `version` is whatever
`VersionResolver` last fetched, and `extractVersion` accepts *any* non-empty string
(`headless/src/version.ts:121-128`), and its own comment worries about `/version/undefined/` but not about
`/` or `?` inside the value.

Why it matters: the failure is silent. A room slug copied from a link (`?`/`#`/`&`) produces a URL whose
path and fragment no longer address `.../connect`, and the client then retries a malformed URL on every
reconnect; a version string carrying `/` rewrites the whole path. This is the class of bug the package
exists to prevent, in the one function that hand-builds a URL by template.

Fix: in `packages/common/src/protocol/connect-url.ts`, add
`function safePathSegment(name: string, value: string): string` that rejects `/`, `?`, `#`, `%`,
whitespace and control characters (and empty values) with a thrown error naming the option, and otherwise
returns `encodeURIComponent(value)`; use it for both `version` and `room` at `:57`. Add a test next to
the existing quoting tests in `common/tests/connect-url.test.ts`.

## F2: `BuildFrameOptions.form` bypasses the form registry and silently emits the wrong scope (medium, correctness)

`buildFrame` resolves `options.form ?? registry?.formOf(action) ?? getActionSpec(action).form`
(`envelope.ts:109`) and then dispatches to a builder that hard-codes its scope:
`buildRoomFrame` → `SCOPE_ROOM`, `buildFlatFrame`/`buildWrappedFrame` → `SCOPE_QUINOA` (`:56-97`).
Nothing checks that the requested form matches the action's declared form, so a caller can put a
room-scoped action into the Quinoa scope, or wrap a `room` action, with no error:

    buildFrame({ action: 'Chat', form: 'flat', params: { message: 'hi' } })
    -> {"scopePath":["Room","Quinoa"],"type":"Chat","message":"hi"}
    buildFrame({ action: 'Chat', form: 'wrapped', commandSequence: 7 })
    -> {"scopePath":["Room","Quinoa"],"type":"QuinoaCommand",...,"command":{"type":"Chat"}}

The doc comment on the option is itself wrong: "A pre-built frame is returned unchanged when set. Used by
the bootstrapped send-hook" (`envelope.ts:30-31`). The code never returns a pre-built frame; it only picks
a builder, and no in-repo caller passes `form` at all (`common/src/client.ts:329` is the only `buildFrame`
call site, and it passes `registry` instead).

Why it matters: the registry exists because "sending a `wrapped` action flat fails silently"
(`forms.ts:5-8`). An undocumented-in-practice escape hatch that re-introduces silent wrong-form output
undermines the guarantee, and the misleading comment invites a future caller to rely on behaviour that
does not exist.

Fix: in `packages/common/src/protocol/envelope.ts`, make `buildFrame(options: BuildFrameOptions): OutboundFrame`
throw an `MgProtocolError` when `options.form` differs from `getActionSpec(action).form` (or delete the
option entirely, since nothing uses it), and correct the `form` doc comment.

## F3: `CommandSequencer` silently discards a caller-supplied `MonotonicStrategy` (medium, correctness)

The constructor takes `options.strategy ?? new MonotonicStrategy(0)` and then, at `sequencer.ts:288`,
replaces it whenever a frontier reader is present:

    if (options.getFrontier && this.strategy instanceof MonotonicStrategy) {
      this.strategy = new FrontierAnchoredStrategy({ getFrontier: options.getFrontier });
    }

The test is on the *class*, so it also matches a strategy the caller explicitly passed. Unlike
`options.strategy`, `executedCommandSequence` is never consulted on this path (`FrontierAnchoredStrategy`
ctor, `:177-187`). Reproduced against the shipped build:

    new CommandSequencer({ strategy: new MonotonicStrategy(41) }).take('X','r1')                    -> 42
    new CommandSequencer({ strategy: new MonotonicStrategy(41), getFrontier: () => null }).take(...) -> 1
    new CommandSequencer({ strategy: new MonotonicStrategy(41), getFrontier: () => 5 }).take(...)    -> 6

Why it matters: the seed is lost silently, and the comment at `:288-289` ("A caller asking for frontier
anchoring but passing no strategy gets the useful one") shows the intent was the no-strategy case only.
The wrong number goes on the wire, and a wrong sequence poisons every later command with
`invalid_sequence` (`:7-9`). No in-repo caller passes both today (`common/src/client.ts:171`,
`headless/src/client.ts:700`), so this is latent rather than live. The documented option pair is a
trap, and `MonotonicStrategy` is exported.

Fix: in `packages/common/src/protocol/sequencer.ts`, change the guard in
`constructor(options: CommandSequencerOptions = {})` to `if (options.strategy === undefined && options.getFrontier)`,
and add a test asserting a supplied `MonotonicStrategy(41)` is preserved when `getFrontier` is also given.

## F4: The `FormFallback` capability can never fire; `setFormFallback` is a no-op (medium, missing-capability)

`FormRegistry.formOf` only upgrades a `flat` action when `this.fallback === 'wrap'` **and**
`this.isFallbackEnabled(name)` (`forms.ts:496`), and that method is hard-coded:

    private isFallbackEnabled(_name: string): boolean { return false; }   // forms.ts:528-530

`'wrap'` is the constructor default (`:487`) and the documented default of `FormFallback` (`:460-464`),
and `setFormFallback(fallback: FormFallback): void` (`:514-517`) mutates `this.fallback`, but no code
path can ever make `isFallbackEnabled` return true. Reproduced: `new FormRegistry({ formFallback: 'wrap' })
.formOf('Ping')` returns `'flat'`, and no sequence of public calls changes it. The doc above it even
promises the opposite: "a caller has to opt a specific action in via `setActionForm`, or turn this on"
(`:524-525`).

Why it matters: this is a documented public capability with a public setter and a documented default that
does nothing, so a caller who follows the docs to recover from a silently-failing `flat` action gets no
effect and no error. The docs at `result-codes.ts:88` tell them to do this. It also leaves an
unused-parameter shim (`_name`) in a file that follows the convention of naming live parameters.

Fix: in `packages/common/src/protocol/forms.ts`, either implement it, so that `setFormFallback('wrap')`
flips an explicit opt-in set consumed by `private isFallbackEnabled(name: string): boolean` (which declares
the exported `FormFallback` capability as real), or remove `FormFallback`, `setFormFallback` and
`isFallbackEnabled` and document that only per-action `setActionForm` overrides exist.

## F5: No size bound on WS frames, unlike every other untrusted-JSON path (medium, security)

`parseFrame(raw: string)` calls `JSON.parse(raw)` directly (`codec.ts:63`) with no length or nesting check,
and neither transport sets a limit: there is no `maxPayload`/`maxFrame` anywhere in `headless/src`, and
`serializeFrame` (`codec.ts:83-89`) is likewise unbounded in what it will serialise. The sibling
untrusted-JSON path in the same package *does* bound input:
`common/src/catalog/http.ts:81-88` rejects a response over `options.maxBytes ?? 8 * 1024 * 1024`.

Reachability: `parseFrame` is called from `ClientCore.handleFrame` (`common/src/client.ts:499`) for every
inbound frame, and the bootstrapped userscript also re-parses the raw payloads it taps from the host
socket (`bootstrapped/src/client.ts:945-957`), so a single oversized frame is parsed twice inside the
game's page.

Why it matters: a compromised or hostile server, or for the bootstrapped client anything that can
inject a frame into the page's socket, can force a multi-hundred-megabyte allocation and a blocking
`JSON.parse` in the client's realm. The package's own HTTP client treats this as a real hazard and caps it.

Fix: in `packages/common/src/protocol/codec.ts`, extend the signature to
`parseFrame(raw: string, options: { maxBytes?: number } = {}): ParseResult`, returning
`{ kind: 'unparsed', text: '' }` (plus a caller-visible reason) when `raw.length` exceeds
`options.maxBytes ?? 8 * 1024 * 1024`, and thread the limit through `ClientCore.handleFrame`.

---

## Notes checked, not scored as findings

- **N1 (close codes).** `CLOSE_CODE_LABELS` (`close-codes.ts:178-197`) is a hand-written duplicate of the
  enum even though its doc claims it is "Built from the enum rather than hand-written twice, so the two can
  never drift" (`:173-177`); the nine `@deprecated` alias members in the same enum (`:90-109`) are what make
  derivation awkward, and one is still used (`errors.ts:58` uses `CloseCode.AuthFailed` where the same file
  uses the canonical `CloseCode.VersionExpired` at `:50`). The only guard is a count assertion
  (`common/tests/connect-url.test.ts:179`), which cannot detect one code being added and another dropped.
- **N2 (`result-codes.ts:36`, `:40-44`).** `ResultCode.UnknownCommandType = 'unknown_command_type'` is
  accepted by `parseResultCode` but is never a wire value and is never produced by `interpretRejection`
  (which derives it from `commandType === 'unknown'`, `:79`); it is unreachable.
- **N3 (`codec.ts:126-131`).** `extractFrontier` accepts any finite number, so `executedCommandSequence: 5.5`
  seeds a fractional counter (`sequencer.ts:302-303`) and the next frame carries a fractional sequence;
  `Number.isSafeInteger` would match the protocol.
- **N4 (`id.ts:50-67`).** `randomRoomSlug` uses `bytes[i] % 36`, giving 4 of 36 characters a 1.6% relative
  bias, and accepts any `length` (including 0 or negative, which yields `''`). Cosmetic for a
  correlation-token-grade identifier.
- **N5 (cross-ref).** `extractPatches` (`codec.ts:104-118`) forwards wire arrays as `Patch[]` with no
  element validation; the exploit that matters for that (`/__proto__` paths reaching the applier) is
  reported in `02-common-state.md` F1 and is not double-counted here.

## What works well here

- The three outbound forms are single-sourced where it counts: `ACTION_SPECS`/`FormRegistry`
  own the classification, `buildFrame` is the only assembler, and `common/src/client.ts:315-335` validates
  the action and derives `needsSequence` from the same registry the builder reads.
- Query-value encoding lives in exactly one function (`encodeQueryValue`, `connect-url.ts:25-27`) and the
  test asserts it value by value, including the deliberate asymmetry of the unquoted numeric attempt
  number and `reclaimSupersededSession=true`.
- `parseFrame`'s `ParseResult` union is a clean boundary: keepalive, unparsed, known and unknown are
  distinct kinds, `isKnown` narrows without a cast, and the non-JSON keepalive is handled before parsing.
- The close-code dispositions are unusually careful about the dangerous case. A real supersession refuses
  to reconnect without `supersedeConfirmed` (`close-codes.ts:346-362`), and 4300 with a heartbeat reason is
  explicitly exempted.
- `CommandSequencer` carries a real ledger with frontier-based `DroppedStale` inference and a
  `rollback` that refuses to rewind over an already-issued number, so a failed
  `buildFrame` or transport throw cannot leave a permanent gap.
