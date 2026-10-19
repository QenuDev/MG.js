# Provenance of vendored sources

This repository vendors two third-party HTML documents under `docs/sources/`. They were
not authored here: they are someone else's documents, included as primary-source evidence
for the protocol notes, wire-format descriptions, and API summaries derived from them.
The protocol guide is copied in unchanged, and the SHA-256 of the copied bytes is recorded
below so a later reader can confirm it is still the same document the derived work was
based on. The API reference began as a vendored copy and was then updated in this repo to
the 1650 surface: its action table was regenerated from the library's own registry, and its
`CrystalItem` / `LogItemTarget` types replace the obsolete `CrystalShard`. Its hash below
records the current edited copy; the original vendored hash is kept beside it so the change
is auditable.

## Where this comes from

Nothing here is official. The protocol was reconstructed from the two documents vendored in `docs/sources/`, each of which is itself a reverse-engineering of community mod source:

- **`docs/sources/quinoa-protocol-docs.html`**: the field guide to the wire. Connect URL, handshake,
  close codes, the three outbound forms, 71 action wire strings, sequencing, JSON-Patch state, multi-mod
  collision policy.
- **`docs/sources/quinoa-api-reference.html`**: an unofficial client API reference: 3 packages, 9
  classes, 109 methods, 19 typedefs, 2 enums. This package implements its `protocol` and `state` packages
  in shape, and `@mg.js/bootstrapped` implements its `render` package.

Both documents self-declare as drift-prone and mid-migration. Every wire fact in this codebase carries a comment naming its source section, and every place the two documents contradict each other is called out in code rather than silently resolved.

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `docs/sources/quinoa-protocol-docs.html` | 104897 | `02411ab07b39fcb57696f98366f7d36c7f827a08265ec26413c424b906d5c4ee` |
| `docs/sources/quinoa-api-reference.html` | 85896 | `35877e2ac20b27a01ae77034d2913928278ac436e81bff09a5230206a136d970` |

## `quinoa-protocol-docs.html`

- **What it is:** "The Quinoa Protocol, an unofficial field guide", a single-file HTML
  document describing the wire protocol.
- **Where it came from:** a third-party document that lives **outside this repository**
  (it is not part of the checkout, and no path inside the repository leads to the
  original); the vendored copy is under `docs/sources/`.
- **Size:** 104897 bytes.
- **SHA-256 (of the copied bytes):** `02411ab07b39fcb57696f98366f7d36c7f827a08265ec26413c424b906d5c4ee`

## `quinoa-api-reference.html`

- **What it is:** "Quinoa API Reference", a single-file HTML document describing the
  HTTP/API surface.
- **Where it came from:** a third-party document that lives **outside this repository**
  (it is not part of the checkout, and no path inside the repository leads to the
  original); the vendored copy is under `docs/sources/`.
- **Size:** 85896 bytes (74671 before the 1650 update).
- **SHA-256 (of the current edited bytes):** `35877e2ac20b27a01ae77034d2913928278ac436e81bff09a5230206a136d970`
- **Original vendored SHA-256 (before the 1650 update):** `32a2cb79b3f392f9851d4c64eca28590f958f8e49ca564a0d81a11a7a3c67d8c`
- **Update:** the `GameActions` action table now mirrors the 108 wire strings / 109 methods of
  build 1650; `CrystalShard` became `CrystalItem`; `LogItemTarget` was added; `MoveItem` and
  `LogItem` replace the six removed storage commands; and the 1650 quest/NPC/capsule/credits
  commands are present.

## Re-verifying

```sh
sha256sum docs/sources/*.html
```

Expected output:

```
35877e2ac20b27a01ae77034d2913928278ac436e81bff09a5230206a136d970  docs/sources/quinoa-api-reference.html
02411ab07b39fcb57696f98366f7d36c7f827a08265ec26413c424b906d5c4ee  docs/sources/quinoa-protocol-docs.html
```

For the protocol guide, if the file hashes to anything else, the copy is not the document
this work was derived from; do not update its recorded hash to match the file. The API
reference is different: its hash records the current edited copy, and the original vendored
hash is recorded above so a reviewer can audit the 1650 rewrite.
