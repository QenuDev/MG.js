/**
 * `@mg.js/art/bundle`: the game's own art tables, read out of its own chunks.
 *
 * A parsed chunk in, tables out. The predicates here locate the mutation art table, the per-species
 * mutation anchors, the tall-plant flags, the scale cap, the overlay order and the placement function by
 * *shape* rather than by symbol name, because the names are minified and change every build. What makes
 * that safe is that each predicate carries a coverage invariant instead of a success boolean, and that the
 * result is validated against the atlas before anybody draws with it.
 *
 * Like the model entry, this one imports nothing at runtime: an AST is the caller's to produce.
 *
 * Nothing is exported yet -- the extractor lands with its validation and its fixtures.
 */

export {};
