# `@mg.js/art`

Everything magicgarden.js knows about *drawing* a garden: which sprite a thing is drawn from, how large and
where that sprite lands, what a mutation paints over it, in what order the layers stack, and the pixels when
a consumer needs a picture rather than a description.

It is a fourth package rather than more of `@mg.js/common` because the two answer different questions.
`common` holds what a consumer could have learned by asking the server. This holds what it has to draw
with. An art position cannot be asked for — the game states it in its own bundle and publishes it as an
endpoint nowhere — so it cannot live in the package whose rule is that the server is the source.

## The four entries

| Import | Imports at runtime | What it is for |
|---|---|---|
| `@mg.js/art` | nothing | The model. Values in, values out. Because it imports nothing, the built file can be served to a browser as one module with no bundler. |
| `@mg.js/art/bundle` | nothing | The extractor: predicates over a parsed game chunk, plus the validator. An AST in, the game's tables out. The parser is the caller's, so this entry needs none. |
| `@mg.js/art/source` | `@mg.js/common/catalog` | The network: the game's version, its atlas packs and their frames, the atlas image, the caches and the content revision. |
| `@mg.js/art/node` | `node:zlib`, `node:fs` | The pixels — KTX2 to RGBA, frame cropping, the PNG codec — and the shipped tables: `artDataVersions()` and `readArtData(version)` read `data/<version>.json` the way the sync wrote it, validated by the same parser a fetched document goes through. |

Four tests hold that table up: the two pure entries import nothing, `bootstrapped` never reaches `art`
(it has a bundle-size budget), the exports map resolves to the names it promises, and the extractor's
predicates are pure — same AST in, same tables out, no clock, no disk, no socket.

## Where the numbers come from

Two sources, and the difference matters when one of them moves:

- **The game's public API** for the atlas: version, atlas packs, frame rects, the atlas image. Ordinary
  HTTP, cached, revisioned.
- **The game's own bundle** for the tables it never publishes: the mutation art table, the per-species
  mutation anchors, the tall-plant flags, the scale cap, the overlay order, and the placement function
  itself. Read by shape, never by symbol name, because the names are minified. `art:sync` regenerates them
  into `data/<version>.json`; `art:sync --check` fails when the committed file no longer matches what the
  current bundle says.

Nothing in here invents a value. Every constant is either the game's own, or arithmetic over the game's own,
and `docs/art-provenance.md` names the bundle symbol each table came from.

## Licence

MIT, like the rest of the monorepo. `assets/basis_transcoder.{js,wasm}` is a third-party artefact and keeps
its own licence beside it.
