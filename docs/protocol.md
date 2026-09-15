# Wire protocol

## The three outbound forms

This is the single most important thing the wrapper gets right for you.

| Form | Scope | Shape |
|---|---|---|
| `room` | `["Room"]` | `{ scopePath, type, ...params }` |
| `flat` | `["Room","Quinoa"]` | `{ scopePath, type, ...params }` |
| `wrapped` | `["Room","Quinoa"]` | `{ scopePath, type:"QuinoaCommand", requestId, commandSequence, command:{ type, ...params } }` |

Getting it wrong fails **silently**. A wrapped action sent flat comes back as
`{type:"QuinoaCommandResult", commandType:"unknown", ok:false, code:"invalid_message"}` and the action simply
never happens. The field guide calls this "the single most common way a hand-rolled client 'does nothing' for
no visible reason."

So the classification lives in exactly one place (`actions/registry.ts`, `ACTION_SPECS`), every action method reads it, and a test asserts the counts:

```
71 wire strings  =  9 room  +  15 flat  +  47 wrapped
```

Plus `fuseCrystal()`, a documented convenience over `PlaceCrystal` with `intent:{type:"merge"}`. The field
guide states flatly that "there is no separate fuse command", giving **72 methods**.

Because the migration is a moving target, `FormRegistry.setActionForm(name, form)` lets you flip a form at runtime when an action starts silently doing nothing, without waiting for a release.

---

## Sequence integrity

`commandSequence` must be exactly `executedCommandSequence + 1`, and contiguous. A duplicate is dropped without a word; a **gap** produces `invalid_sequence` and then rejects every later command too.

Both strategies therefore refuse to fall behind the confirmed frontier, and the core hands a number back if a frame never reaches the wire:

- **`MonotonicStrategy`** (headless): increments, and jumps forward if the server's confirmed `executedCommandSequence` has already reached its next number. A lost ack or a dropped frame would otherwise strand it one behind, silently, forever.
- **`FrontierAnchoredStrategy`** (bootstrapped): also consults a live frontier reader *before every stamp*, because the host game has its own module-private counter on the same socket and may have consumed numbers since our last frame. On `invalid_sequence` it heals to `frontier + 1`, so a desync costs at most the one command that tripped it.

---

## Ack correlation, honestly

The protocol gives one feedback channel (`QuinoaCommandResult`) and, in the documented payload, **no `requestId`** to correlate it with. The API reference marks `requestId` optional, implying some builds echo it.

Rather than pretend, there are three explicit modes and every result says how it was matched:

| `ackMode` | Behaviour | `confirmed` |
|---|---|---|
| `'strict'` | settles only on a matching `requestId` | `true` when matched |
| `'fifo'` *(default)* | matches by action name and send order | `false`; ordering is probable, not proof |
| `'none'` | never correlates; settles from the frontier ledger or the timeout | `false` |

```ts
const handle = client.actions.harvestCrop({ slot: 3 });  // CommandHandle, thenable
const result = await handle;
if (!result.confirmed) { /* matched by ordering: probable, not proven */ }
```

`handle.settled` never rejects, for callers who want the outcome without exceptions. Fire-and-forget (`void client.actions.teleport(...)`) does not produce unhandled-rejection noise, but an explicit `await`/`.catch()` still sees failures.

The server never sends `dropped_stale`; the API reference explicitly calls it "a client-side inference". The core synthesises it: when the server's own frontier advances past a command that was never acknowledged, that command did not happen, and the handle is told so.


---

## Design decisions to know

**`null` means a resolved value, not an absence.** The live weather endpoint returns literal `null` when nothing is active. A `null` from a capable source is remembered and resolved if no later source supplies something better, so "no weather" is never confused with "no weather source". (Weather no longer has to lean on this: `PlatformApiSource` now normalises both shapes into a `WeatherForecast`, so "nothing is active" is `{ current: null, upcoming: [...] }` and only an absent source yields `null`. The mechanism still matters for the other categories.)

**A throwing catalogue source is skipped, not fatal.** The existing reference server degrades its `/data` tree with `Promise.allSettled` for the same reason. `missing` and `provenance` tell you what came from where.

**Patch application resolves paths in a fixed priority order.** The state tree is rooted at the whole `fullState`, so `/child/...` resolves literally. Beyond that, four passes run in order, and the order is required:

1. literal path, no container creation;
2. `/child`-corrected path, still no creation;
3. literal path **with** container creation;
4. (absent by design; creation is never combined with a `/child` correction)

Steps 1 and 2 must precede 3, because otherwise a `/child`-prefixed patch against a non-`/child`-rooted tree satisfies itself by inventing a phantom `/child` branch instead of correcting to the real one. That is quiet tree corruption, the worst possible failure mode here. Step 4 is absent for the same reason: a `/child` variant is already a guess about which sub-tree a patch means, and letting that guess also fabricate containers compounds two uncertainties.

Creation itself matches the documented `JsonPatch.apply`: "creating an array when the next segment is numeric, an object otherwise", and extending an array with nulls past its end. Without it, a patch naming a branch the client has not seen yet is dropped and local state drifts. Every fallback that fires is recorded: a created container is reported as `created-parent` and surfaces in `result.tolerated` and in the engine's logs, so drift is visible rather than silent. `JsonPatch.apply(root, patch)` is exposed as the documented static facade; `applyPatch` is the batch form with full outcome detail.

**The two documented `/child` readings are both handled.** The protocol doc's prose says game-state patches are `/child`-prefixed; its own `applyPatch` sample never strips one. Rather than pick a winner, both work, and which one matched is reported.

**Unparseable input never throws.** An unknown message type, a non-JSON frame, or a patch that cannot be applied are all reported as events and dropped. A wrapper that dies on one odd message is worse than one that logs it.

**Actions take one params object, not positional arguments.** This is the one intentional deviation from the API reference's signatures (44 of 72 methods have optional parameters, several have adjacent optionals, and the documented rule for several is "omit it entirely; do not send `null`"). Field names inside the object match the wire fields, so code and a packet capture read the same.

