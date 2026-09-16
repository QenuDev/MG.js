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

## What each entry publishes

Which one to import:

- **`.`** if you already have the tables and the atlas frames and want to know what to draw and where. For
  most callers it is the whole package.
- **`/node`** as well, when you want the tables the package ships (`readArtData`) or actual pixels.
- **`/source`** when you need the game's atlas: its art version, its packs and their frames, its image.
- **`/bundle`** only when you are regenerating the tables out of the game's own bundle.

Each table below is the whole public surface of its entry — every name that entry's `index.ts` re-exports,
each described from its own doc comment, or from its declaration where the doc comment is silent.

### `.` — the model

The two recipes are `cropComposition` and `plantPicture`. The rest is the arithmetic they are built from,
the sprite and frame lookups they read, `PLANTER_POT`, and `iconArt` for inventory icons.

| Export | What it answers |
|---|---|
| `frameBox(frame)` | A frame's drawn size, divisor and anchor, from the frame the atlas published. A record that states no source size draws at nothing rather than at a number this made up. |
| `REFERENCE_TILE_PX` | The reference tile a `sourcePixelRatio` is taken against, in the sprites' own pixels (`256`). |
| `boxOf(parts)` | The box one or more placed parts together occupy, as a union; `extentOf`'s answer is one of the things you pass it. |
| `extentOf(parts)` | The box a set of parts occupies **as it is drawn**, measured around their drawn corners, so a turned part widens the box instead of being clipped by it. |
| `placePart(part, inBox)` | Where a part lands inside a box, as shares of that box rather than as CSS. |
| `fitPicture(picture, space?)` | The scale that fits a picture into the room it is given, as a width and a height share. |
| `PLACEMENT_ANCHOR_Y` | A part's own vertical share of the box it is placed in when it states no anchor (`0.4`, the share the game centres a mutation's picture at). |
| `spriteName(record, part, byName?)` | The sprite the game's own table states for one part of a record, as the path the atlas is keyed by — or `null` for a name the table does not state. |
| `resolveSprite(frames, path)` | The frame the atlas states for one sprite, or `null` when it states none. |
| `mutationArt(mutation)` | A mutation's wash as `rgba(...)` (or `null` for a shader material) and the name of the art it draws over the crop. |
| `mutationStack(mutation, overMutations)` | Where a mutation sits in the draw order, whether it is an over-mutation, and which side of the crop it is drawn on. |
| `mutationOverlayArt(mutation)` | The art a mutation lays on a tall plant: the decal that pools at its foot, the overlay over the plant, and whether that overlay climbs from the bottom. |
| `mutationAnchor(species, artName, art, harvestType, tables)` | The point of a species' art a mutation centres on, and the scale it is drawn at. |
| `mutationPlacement(mutation, icon, art, tables)` | The rectangle a mutation's art is drawn into, in the crop art's own pixels. |
| `cropComposition(species, mutations, tables, frames)` | The picture of one crop wearing some mutations: the box, and the layers in the order they are drawn. |
| `plantPicture(scene, art, pot?)` | The picture of one plant — pot, growing platform, body, weather art, crops, front layer — in the game's own order, or `null` when there is nothing to draw. |
| `PLANTER_POT` | The pot the game stands a potted plant in, and the anchor it places it by (`.5`, `.2`). |
| `ICON_FILL` | The share of the 256-pixel icon box each item kind's art fills. |
| `iconArt(entry, art?)` | One inventory entry's icon: which of the three ways the game draws it, and at what share of the icon box. |

The recipe shapes and what they are made of:

| Type | What it is |
|---|---|
| `ArtBox` | A box in the sprites' own pixels, measured from its left and top edges. |
| `AtlasFrame` | One frame of the game's atlas, as its JSON states it. Only the three fields the drawn size needs are read. |
| `CropLayer` | One layer of a crop's picture: what to draw, and where, in the crop art's own pixels. |
| `CropLayerKind` | Which band of the picture a layer is: the crop's own art, or a mutation's picture. |
| `CropRecipe` | A crop's whole picture: the box it is drawn in, and the layers in the order they are drawn. |
| `CropTables` | The tables a composition reads, in the shape `packages/art/data/<version>.json` states them. |
| `DecalArtwork` | The ground art a tall plant's mutation is drawn as, with the name a caller fetches its pixels by. |
| `DisplayFlags` | The display flags the table states per sprite. Only the tall flag turns a placement. |
| `FrameBox` | The size a frame's art is drawn at, the divisor that got there, and the anchor it is drawn about. |
| `IconArt` | One entry's icon: which of the three ways the game draws it, and at what share of the icon box. |
| `IconArtKind` | How the game draws one kind of icon: one sprite, an assembled picture, or a baked portrait. |
| `IconArtTables` | What a caller has to hand: the extracted tables, and the atlas frames if it wants the frame too. |
| `IconEntry` | One inventory entry, as much of it as an icon needs. |
| `IconType` | The item kinds the game's own item-type enum names, which is what an inventory entry states. |
| `MutationAnchor` | The point of a species' art a mutation centres on, and the scale it is drawn at. |
| `MutationArtRecord` | One mutation's art, as the game's own table states it. |
| `MutationArtwork` | A mutation's own art, resolved to the frame it is drawn from, and the decal a tall plant gets instead. |
| `MutationDrawing` | A mutation's wash and the name of the art it draws over the crop. |
| `MutationPlacement` | The rectangle a mutation's art is drawn into, in the crop art's own pixels. |
| `MutationStack` | Where a mutation sits in the draw order, and which side of the crop it is drawn on. |
| `MutationTint` | A mutation's crop wash, as the game's filter construction states it. |
| `OverlayArt` | The art a mutation lays on a tall plant: the decal that pools at its foot, and the overlay over the plant. |
| `PartExtent` | A box in the sprites' own pixels, measured from where its own left and top edges are. |
| `PartPlacement` | Where a part lands inside a box, as shares of that box rather than as CSS. |
| `PictureFit` | How large a picture is drawn inside the room it was given, as shares of that room. |
| `PictureSpace` | The box a picture is drawn in, and the room it has to be drawn in. |
| `PlacedPart` | A part of a picture: a rectangle of the sprites' own pixels, and the point it is turned about when it turns. |
| `PlacementTables` | The tables a placement reads, in the shape `packages/art/data/<version>.json` states them. |
| `PlantArt` | One species' art, as a picture of it needs them. |
| `PlantArtwork` | One art of a plant's picture, with the sprite path a caller fetches its pixels by. |
| `PlantCrop` | One crop standing on the plant, as the garden payload states where it is. |
| `PlantLayer` | One layer of a plant's picture: what to draw, where, and what it hangs. |
| `PlantLayerKind` | Which part of a plant a layer is: `pot`, `immature`, `plant`, `active`, `crop` or `topmost`. |
| `PlantOverlay` | The art a plant wears while the weather it names is the weather that is running. |
| `PlantPart` | One part of a species as the plant table states it. Only the art is read here. |
| `PlantRecipe` | A plant's whole picture: the box every part of it occupies, and the layers in the order they are drawn. |
| `PlantScene` | What a plant's picture is of: the species, the crops on it, and the two things a caller's clock decides. |
| `PotArt` | The pot every potted plant stands in, as the caller read it out of the atlas. |
| `PotDrawing` | The pot's sprite name and the anchor the game places it by. |
| `ScaleCaps` | The game's own numbers for how large a mutation's art is drawn: the cap, the tile, and the decal's own. |
| `SpeciesRecord` | A species as the plant table states it: the part whose art is the plant's own is what `plant` names. |
| `SpriteFrames` | The atlas frame maps this package produces and its captures hold: a `Map`, or a JSON object keyed the same way. |
| `SpriteNameMap` | One category of the game's sprite-name table: the sprite's own name to the path the atlas is keyed by. |
| `StatedAnchor` | A number the game's anchor table states for a species, or the numbers it states per part for one. |
| `StatedMutationArt` | A mutation's art as the game's table states it, without the name its own table keys it by. |
| `StatedPlantPart` | A species' part as the plant table states it: its art, and the harvest type the plant block names. |
| `StatedSpeciesRecord` | A species as the plant table states it: the two parts a crop can be drawn from. |

### `/bundle` — the extractor

A parsed chunk in, the game's tables out. The predicates find each table by *shape* rather than by symbol
name, because the names are minified and change every build; the parser is the caller's.

| Export | What it answers |
|---|---|
| `ART_DATA_CONTRACT` | The document a host must serve for the sync's `--from` to accept it (`art-data/1`): a stamped table set with evidence. |
| `ArtDataError` | Raised when a document is not an art data file, or not one this build can read. |
| `artDataOf(value)` | Checks a value against the contract, returning it as `ArtData` or refusing with what it saw. |
| `parseArtData(text)` | Parses a committed data file back into the record its consumer reads. |
| `serializeArtData(data)` | The exact bytes of `data/<version>.json`: sorted keys, two-space indent, LF, and byte-identical across runs. |
| `artDataFor(extraction, versions)` | Stamps an extraction with the versions it was read from. |
| `ExtractionError` | A predicate could not be satisfied. The message names the predicate, the shape it looked for, and what it saw. |
| `evidenceOf(candidate)` | The evidence of a table: the candidate without the value, which the data file carries instead. |
| `extractArtTables(chunks)` | Pulls the tables out of a set of parsed chunks, or refuses and says why. |
| `PREDICATES` | Every predicate, in the order the extraction runs them: each stage may read the ones before it. |
| `spriteIndexOf(names)` | `Category.Name` for every leaf of the sprite-name table, so a reference can be resolved by its tail. |
| `PROVENANCE` | Every table the model consumes, and how it is known to be the right table. |
| `provenanceFor(record, predicates)` | Joins the record with the predicates, and refuses a gap in either direction. |
| `renderProvenanceDoc(record, evidence)` | `docs/art-provenance.md`, generated from the record and one extraction's evidence, deterministically. |
| `MODEL_TABLES` | The tables a consumer of the model draws with; a table outside this list is evidence, not an input. |
| `asObject(value)` | The object literal a value wraps, or `null` when the value is not one. |
| `asString(value)` | The string a value states, or `null`. Both quoted strings and bare backtick literals count. |
| `declarationNamed(chunk, name)` | The declaration named `name` in a chunk, or `null`. |
| `memberValue(object, key)` | The value of the member `key` of an object literal, or `null` when it has no such member. |
| `memberKeys(object)` | The keys of an object literal, in source order. A computed key contributes its source text. |
| `leafStrings(object)` | Every string leaf of an object literal, following object values and nothing else. |
| `leafEntries(object)` | Every string leaf's `[path, value]`, where `path` is the chain of member keys from the root. |
| `contains(outer, inner)` | True when `outer` covers `inner`: the same node, or a node that contains it. |
| `literalJson(value)` | Serialises a shape value back to JSON when it is a literal, or `null` when it is an expression. |
| `spritePathsOf(names)` | Every sprite path the name table states, in the atlas's key form. |
| `mutationSpritesOf(art)` | Every sprite path a mutation's art states, wherever it states one. |
| `plantSpritesOf(plants)` | Every sprite path the plant table states, across all three parts. |
| `validateTables(tables, atlas)` | Checks a table set against the atlas and against itself, returning every failure rather than the first. |
| `validateArtData(data, atlas)` | The same check over a stamped data file, for a caller that has one and not a table set. |

The chunk projection the predicates read, and the tables they produce:

| Type | What it is |
|---|---|
| `Extraction` | The result of a successful extraction: the tables, and the evidence for each one. |
| `PredicateContext` | What every predicate needs: the chunks, what has been found so far, and the names it was found under. |
| `TableCandidate` | A candidate a predicate matched, with everything needed to review the match later. |
| `TablePredicate` | One predicate: the shape it looks for in one sentence, the invariant that must hold of what it found, and the candidates it matched. |
| `ProvenanceStamp` | The version and the evidence a document is stamped with. |
| `StampedProvenance` | A table's provenance with the predicate's own words joined in: what the doc and the tests read. |
| `TableProvenance` | One table's account of itself. |
| `ParsedChunk` | A chunk as the predicates see it. `objects` holds every object literal in the chunk, nested ones included. |
| `ShapeAssignment` | `e.Single = 'Single'`, the minifier's string enum: a function that assigns a literal to each member of the object it returns. |
| `ShapeBoolean` | A `true` or `false` literal and its value. |
| `ShapeCall` | A call or a construction. `args` are projected values, so `new Filter({color, alpha})` is readable. |
| `ShapeDeclaration` | A chunk-local named declaration, in a form a plain function body could re-declare. |
| `ShapeFunction` | A function declaration or expression, with the reads that are not bound inside it. |
| `ShapeImport` | One named import: an aliased import is recorded as its local name, the name it states, and its module. |
| `ShapeMember` | One `key: value` member of an object literal. A computed key arrives as a member-shape. |
| `ShapeNull` | A `null` literal. |
| `ShapeNumber` | A number, with the text the chunk wrote (`0.75`, `.75`, `1e3`) and its value. |
| `ShapeObject` | Every object literal, whether or not it is assigned to a name. |
| `ShapeObjectLiteral` | One projected object literal: the name it is assigned to (or `null`), its members, and its byte range in the chunk. |
| `ShapeReference` | A name or a chain of member accesses, kept as the chain: `<Alias>.<Category>.<Name>` arrives as three strings. |
| `ShapeString` | A string as the chunk wrote it, and how it was delimited. |
| `ShapeValue` | Any projected value: a string, a number, a boolean, `null`, an array, an object, a reference, a call, or something else carrying its source text. |
| `AnchorValue` | A number, or the per-part overrides the game states for one species. |
| `ArtData` | The version stamp and the evidence, beside the tables. |
| `ArtTables` | The extracted tables themselves: `spriteNames`, `mutationRecords`, `mutationArt`, `displayFlags`, `anchors`, `plants`, `harvestTypes`, `iconFills`, `itemTypes`, `scale`, `overMutations` and `placement`. |
| `AtlasFrames` | The atlas frames a table is checked against: the keys of a frame map, or a set of them. Nothing here reads a frame's contents. |
| `Coverage` | A predicate's measurement of what it found: counts, and anything it could not resolve. |
| `DisplayFlags` | The display flags the game states per sprite: whether it is drawn tall, and whether it is drawn narrow. |
| `Evidence` | Which predicate found a table, in which chunk, by what shape, and what the invariant it carries measured. |
| `IconFill` | One kind's share of the icon box, and how the game stated it. |
| `IconFillSource` | Where a kind's share comes from: a stated `sizeRatio`, the fit's default, or the pet's bake route. |
| `MutationArt` | One mutation's art as the game's table states it: its order, its tint, whether it is a material, and its icon, ground and overlay sprites. |
| `MutationRecord` | One mutation's record: its name, its wash group, and its sprite. |
| `MutationTint` | A mutation's crop wash, as the filter construction states it: a colour literal and its alpha. |
| `Placement` | The game's own placement function, extracted rather than re-derived: its source, the declarations it closes over, its externals and its assembled length. |
| `PlacementExternal` | A name the placement function needs from outside: its name, the role it plays, and the chunk's own import specifier for it. |
| `PlantPart` | A species' art for one part, with the name table reference resolved. |
| `PlantRecord` | A species' three parts as the plant table states them: `seed`, `plant` and `crop`. |
| `SpritePath` | One spelling of the game's own sprite identity: `sprite/<category>/<Name>`, the atlas's key form. |
| `TableId` | The name of one table in `ArtTables`. |
| `ValidationFailure` | One failed check: the check, the table, everything that violated it (capped), and the detail. |

### `/source` — the network

The game's assets, fetched, cached and revisioned. `fetch` and `now` are injected, so a test needs no
socket; the timeout, byte cap and redirect policy come from `fetchJson` in `@mg.js/common/catalog`.

| Export | What it answers |
|---|---|
| `gameVersion(options?)` | The art version the game states, as the string it states it in. |
| `atlasPacks(artVersion, options?)` | Every frame of the sprite atlas, keyed as the game keys it, at resolution 2. |
| `atlasImage(pack, options?)` | A pack's atlas image — the `.ktx2` its own `meta.image` points at — as bytes. |
| `contentRevision(inputs)` | The revision of a picture, as sixteen hex characters: arithmetic over the inputs, with no socket and no clock. |

| Type | What it is |
|---|---|
| `AtlasPacks` | The frame map `atlasPacks` answers, and the packs it was read from. |
| `ArtSourceOptions` | What every source call is handed: `fetch`, `now`, the TTL and the timeout, all optional. |
| `RevisionInput` | A value a picture's pixels can depend on. |

### `/node` — the pixels and the shipped tables

Four jobs, each needing something the pure entry must not have: KTX2 to RGBA, frame cropping, the PNG
codec, and the tables in `data/<version>.json`.

| Export | What it answers |
|---|---|
| `readKtx2Header(bytes)` | The KTX2 header of `bytes`, refusing a file whose identifier is wrong or whose level index does not fit. |
| `decodeKtx2(bytes)` | Transcodes a KTX2's level 0, layer 0, face 0 to RGBA, with the dimensions checked against the transcoder's own reading. |
| `decodeKtx2File(path)` | `decodeKtx2` for a file on disk. Nothing is cached: a caller who wants a cache owns it. |
| `frameSize(frame)` | The size a frame is drawn at: `sourceSize` when the frame states one, else the frame's own rect. |
| `frameBytes(frame, atlas)` | A frame's RGBA, cut out of a decoded atlas, un-rotated and padded back to `frameSize(frame)`. |
| `decodePng(buffer)` | The image a PNG holds: `{ width, height, pixels }`, RGBA, straight (not premultiplied) alpha. |
| `pngSize(bytes)` | The size a PNG states in its header, without decoding any of its pixels. |
| `encodePng(image)` | The same shape back as a `Buffer`: 8-bit RGBA, non-interlaced, one IDAT chunk, every scanline filtered with type 0. |
| `drawOver(base, layer, x, y)` | `layer` composited over `base`, source-over, with the layer's top-left at `(x, y)`. Mutates `base.pixels`. |
| `scaled(image, width, height)` | The image scaled to the given size: an area average when shrinking, interpolation when growing. |
| `washArt(image, washes)` | The art with the washes filtered through it, which is what the game's filter does to the sprite's pixels. |
| `artDataVersions()` | The game versions the installed package ships tables for, in name order. |
| `readArtData(version)` | One shipped version's tables, checked against the contract `parseArtData` states. A version the package does not ship is refused, naming the versions it does. |

| Type | What it is |
|---|---|
| `AtlasFrame` | One frame of an atlas pack, as the game publishes it. A different `AtlasFrame` from the model's: this one is the pack's record, with the rect, `sourceSize` and `spriteSourceSize`. |
| `DecodedAtlas` | A whole atlas in memory: level 0, layer 0, face 0, as RGBA. |
| `FrameRect` | A rect in a pack's coordinates: the four numbers every atlas frame states. |
| `Ktx2Header` | The KTX2 header, read rather than assumed. |
| `Ktx2Level` | One mip level's place in the file, as the level index states it. |
| `PngImage` | An image as this codec reads and writes it: `width` by `height` pixels, RGBA, straight alpha, four bytes per pixel. |

## A worked example

One crop's picture, from the game's own atlas to the recipe. It is the whole package in seven lines: the
version and the frames come off the game, the tables come out of the package, and the answer is a value.

```ts
import { cropComposition } from '@mg.js/art';
import { atlasPacks, gameVersion } from '@mg.js/art/source';
import { readArtData } from '@mg.js/art/node';

// The art version the game states now, and every frame of its atlas keyed `sprite/<category>/<Name>`.
const artVersion = await gameVersion();
const frames = await atlasPacks(artVersion);

// The tables are shipped, not fetched. `readArtData` refuses a version this package carries no tables
// for, and names the ones it does; `artDataVersions()` answers that list without throwing.
const { tables } = readArtData(artVersion);

// `null`, or the crop's box and its layers in draw order. Nothing here rasterises anything.
const picture = cropComposition('Clover', ['Wet'], tables, frames);
```

`cropComposition` takes the mutations the crop carries by name, and the tables and frames are exactly what
`readArtData` and `atlasPacks` answer: `data.tables` is a `CropTables` as it stands, with no subset built
out of it.

## Values, not pixels

Neither recipe rasterises anything. `cropComposition` answers a box and an ordered list of layers, and
`plantPicture` answers a box and an ordered list of layers; each layer is a sprite path, a rectangle, a
turn, and the washes it is drawn through. That is the point rather than a limitation — the same recipe can
be a page's absolutely-positioned elements or a server's composited PNG, and the two draw the same picture
rather than two pictures that merely agree.

The pixels are the caller's business. `@mg.js/art/node` holds the pieces a rasteriser needs — `decodePng`,
`frameBytes`, `scaled`, `washArt`, `drawOver`, `encodePng` — and a caller that wants none of them can draw
the recipe with its own.

## Tables, not endpoints

`@mg.js/art/source` fetches the atlas and only the atlas: the art version, the packs and their frames, and
the atlas image, all off the game's own origin. The *tables* are not fetched at all. They are committed as
`data/<version>.json` and shipped inside the package, for the versions somebody captured with `art:sync`,
and they are read by name:

```ts
import { artDataVersions, readArtData } from '@mg.js/art/node';

artDataVersions();      // the versions this installed package carries, in name order
readArtData('1192');    // one version's tables, or a refusal naming the versions it does carry
```

The caller names a version, never a directory or a filename, so the path is never built out of a caller's
string. A version the package does not ship has to be captured — `art:sync` reads the game's own bundle —
because there is no endpoint to ask.

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
