/**
 * Fixtures: the declarations the predicates need, cut out of the captured chunks and committed beside the byte
 * ranges they came from.
 *
 * A fixture is a *view* of the original chunk, not a copy of it: each cut is one declaration, written back as
 * its own statement (`const name = <initializer>;` for a variable, the function's own text for a function), so
 * the initializer text is byte-identical to the span it was cut from and the fixture is still a parseable
 * source file. The manifest beside it records, for every cut, both the source range and the fixture range.
 *
 * That second range is what makes the fixture usable for `art:sync --check`. The extractor reports evidence as
 * byte ranges, and a range inside a trimmed file is not a range inside the game's chunk -- so `remapEvidence`
 * translates one into the other before anything is compared or written. A run over the fixture and a run over
 * the 10.7 MB bundle therefore produce the same data file, byte for byte, which is the property `--check`
 * needs and the determinism test asserts.
 *
 * The whole point of a fixture is that it is *evidence*, not convenience: it is cut by the same code that
 * extracts, it is written only for the declarations the extraction actually read (`support` in the evidence),
 * and it is refused when a cut is missing, because a fixture that quietly lost a declaration would fail the
 * extractor and look like a shape change in the game.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ParsedChunk, ShapeImport } from '../shape.js';
import type { Evidence, TableId } from '../tables.js';

/** One declaration, as it appears in the source chunk and in the fixture file. */
export interface FixtureCut {
  readonly declaration: string;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly fixtureStart: number;
  readonly fixtureEnd: number;
}

export interface FixtureFile {
  readonly fixture: string;
  readonly chunk: string;
  readonly fileUrl: string;
  readonly cuts: readonly FixtureCut[];
  /**
   * The import bindings the source chunk stated, kept in the manifest rather than written into the fixture
   * file. The layout code inside the placement function is minified, so the chunk's own `import{...}` lines
   * are long lists of one-letter names that are mostly unused in the fixture; carrying them as data keeps the
   * fixture lint-clean while still letting a predicate say where an external binding came from.
   */
  readonly imports: readonly ShapeImport[];
  readonly text: string;
}

/** Where a capture came from, so a fixture is never anonymous. */
export interface FixtureSources {
  readonly gameVersion: string;
  readonly artVersion: string;
  readonly origin: string;
  readonly atlasManifest: string;
  readonly atlasPacks: readonly string[];
  readonly origin_note?: string;
}

/** The committed `fixture.json`: the capture's provenance, and every cut with both its ranges. */
export interface FixtureManifest {
  readonly note: string;
  readonly sources: FixtureSources;
  readonly files: readonly Omit<FixtureFile, 'text'>[];
}

/**
 * The header every fixture file carries.
 *
 * A cut of a minified chunk is one very long line of code, and Biome would both reformat it and lint it as a
 * program (unused declarations, comma operators, `let` that is never reassigned). Reformatting it is worse than
 * noisy: the manifest's byte ranges would stop pointing at what they were measured against. So the file says
 * what it is, in the one form the linter honours, and the reader that parses it does not care.
 */
const FIXTURE_HEADER =
  '// biome-ignore-all lint format: a fixture is a cut of a minified chunk, parsed by the extractor and never ' +
  'run; reformatting it would move the byte ranges the manifest records.\n';

/** The note every manifest carries, so the layout is self-explaining in review. */
const FIXTURE_NOTE =
  'Each fixture file holds one declaration per line, cut from the named chunk. A variable is written back as ' +
  '`const <name> = <initializer>;` for a variable, and its own text for a function. The range in `cuts` is the ' +
  'initializer both times: inside the wrapper it is byte-identical to the source range, and `fixtureStart`/' +
  '`fixtureEnd` are where that same initializer sits in the fixture file, which is how evidence read from a ' +
  'fixture is translated back to the game chunk. Every fixture file opens with a `biome-ignore-all` line, and ' +
  'the offsets in `cuts` are measured after it.';

/** Which declarations each accepted table had to read: the one it sits in, plus the names it resolved. */
export function declarationsRead(evidence: Readonly<Record<TableId, Evidence>>): Map<string, Set<string>> {
  const needed = new Map<string, Set<string>>();
  for (const entry of Object.values(evidence)) {
    const names = needed.get(entry.chunk) ?? new Set<string>();
    if (entry.declaration !== null) names.add(entry.declaration);
    for (const support of entry.support) names.add(support);
    needed.set(entry.chunk, names);
  }
  return needed;
}

/**
 * The fixture files a set of chunks can produce, or a refusal naming the declaration that is missing.
 *
 * A declaration the evidence names but the chunk does not hold is a bug in the extractor, not a fixture
 * problem, so this throws rather than writing a fixture that would fail later for the wrong reason.
 */
export function fixtureFiles(
  chunks: readonly ParsedChunk[],
  evidence: Readonly<Record<TableId, Evidence>>,
  sources: FixtureSources,
): readonly FixtureFile[] {
  const needed = declarationsRead(evidence);
  const files: FixtureFile[] = [];
  for (const [chunkName, names] of needed) {
    const chunk = chunks.find((candidate) => candidate.file === chunkName);
    if (chunk === undefined)
      throw new Error(`fixture: the extraction read ${chunkName}, which is not among the chunks`);
    const cuts: FixtureCut[] = [];
    const lines: string[] = [];
    let offset = 0;
    const declarations = [...names]
      .map((name) => {
        const declaration = chunk.declarations.find((candidate) => candidate.name === name);
        if (declaration === undefined) {
          throw new Error(
            `fixture: the extraction read ${name} in ${chunkName}, which that chunk does not declare`,
          );
        }
        return declaration;
      })
      .sort((left, right) => left.start - right.start);
    for (const declaration of declarations) {
      const text = declaration.text;
      // The cut's own range is the *initializer* inside the statement this writes, because that is the text a
      // re-declaration reproduces byte for byte: the wrapper's whitespace may differ from the game's minified
      // one, so both ranges are the initializer's and a single delta maps every span inside it.
      cuts.push({
        declaration: declaration.name,
        sourceStart: declaration.valueStart,
        sourceEnd: declaration.valueEnd,
        fixtureStart: offset + declaration.bodyStart,
        fixtureEnd: offset + declaration.bodyStart + (declaration.valueEnd - declaration.valueStart),
      });
      lines.push(text);
      offset += text.length + 1;
    }
    // The header shifts every offset, and the shifts are recorded rather than recomputed on read: the manifest
    // is the record of where each cut is, so it has to be the thing that is right.
    const headerLength = FIXTURE_HEADER.length;
    files.push({
      fixture: `chunks/${chunkName}`,
      chunk: chunkName,
      fileUrl: `${sources.origin}/version/${sources.gameVersion}/assets/${chunkName}`,
      cuts: cuts.map((cut) => ({
        ...cut,
        fixtureStart: cut.fixtureStart + headerLength,
        fixtureEnd: cut.fixtureEnd + headerLength,
      })),
      imports: chunk.imports,
      text: `${FIXTURE_HEADER}${lines.join('\n')}\n`,
    });
  }
  return files.sort((left, right) => left.chunk.localeCompare(right.chunk));
}

/** Write the fixture files and their manifest under `directory`. */
export function writeFixtures(
  directory: string,
  chunks: readonly ParsedChunk[],
  evidence: Readonly<Record<TableId, Evidence>>,
  sources: FixtureSources,
  atlas: {
    readonly artVersion: string;
    readonly frameKeys: readonly string[];
    readonly frames: Readonly<Record<string, unknown>>;
  },
): FixtureManifest {
  const files = fixtureFiles(chunks, evidence, sources);
  for (const file of files) {
    const path = join(directory, file.fixture);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.text);
  }
  const manifest: FixtureManifest = {
    note: FIXTURE_NOTE,
    sources,
    files: files.map((file) => ({
      fixture: file.fixture,
      chunk: file.chunk,
      fileUrl: file.fileUrl,
      cuts: file.cuts,
      imports: file.imports,
    })),
  };
  writeFileSync(
    join(directory, 'atlas-frames.json'),
    `${JSON.stringify(
      {
        note: 'The atlas frames the sprite-name table was validated against: every frame key the game published at this art version, plus a few complete frames as examples of the shape.',
        sources,
        frameKeys: atlas.frameKeys,
        frames: atlas.frames,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(directory, 'fixture.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Read a fixture back: its manifest, and the text of every chunk it stands for. */
export function readFixtures(directory: string): {
  readonly manifest: FixtureManifest;
  readonly chunks: readonly { readonly file: string; readonly text: string }[];
} {
  const manifest = JSON.parse(readFileSync(join(directory, 'fixture.json'), 'utf8')) as FixtureManifest;
  return { manifest, chunks: fixtureChunkTexts(directory, manifest) };
}

/** The fixture file texts, keyed by the chunk they stand for -- what a parser needs, without a parser. */
export function fixtureChunkTexts(
  directory: string,
  manifest: FixtureManifest,
): readonly { readonly file: string; readonly text: string }[] {
  return manifest.files.map((file) => ({
    file: file.chunk,
    text: readFileSync(join(directory, file.fixture), 'utf8'),
  }));
}

/** The frame keys a fixture ships, which is what the validator is handed. */
export function fixtureFrameKeys(directory: string): readonly string[] {
  const atlas = JSON.parse(readFileSync(join(directory, 'atlas-frames.json'), 'utf8')) as {
    frameKeys: readonly string[];
  };
  return atlas.frameKeys;
}

/**
 * Put a chunk's own imports back onto its fixture projection.
 *
 * The fixture text carries no `import` statements (see {@link FixtureFile.imports}), so the one thing a
 * predicate reads from them -- the specifier an external binding came from -- is restored here. Everything else
 * about the projection is what the trimmed file really says.
 */
export function restoreImports(
  chunks: readonly ParsedChunk[],
  manifest: FixtureManifest,
): readonly ParsedChunk[] {
  return chunks.map((chunk) => {
    const file = manifest.files.find((candidate) => candidate.chunk === chunk.file);
    return file === undefined ? chunk : { ...chunk, imports: file.imports };
  });
}

/**
 * Translate evidence read from a fixture back to the game's own byte ranges.
 *
 * The two ends are mapped separately, because a predicate may report a span that crosses declarations -- the
 * harvest-type enum's assignments live in more than one, and the range it reports runs from the first to the
 * last. Every end that is not inside any cut is left alone: that happens for a predicate that reads a chunk
 * globally, and changing it silently would be worse than leaving a fixture-relative number visible.
 */
export function remapEvidence(
  evidence: Readonly<Record<TableId, Evidence>>,
  manifest: FixtureManifest,
): Readonly<Record<TableId, Evidence>> {
  const remapped: Partial<Record<TableId, Evidence>> = {};
  for (const [id, entry] of Object.entries(evidence) as [TableId, Evidence][]) {
    const file = manifest.files.find((candidate) => candidate.chunk === entry.chunk);
    if (file === undefined) {
      remapped[id] = entry;
      continue;
    }
    const map = (offset: number): number => {
      // The *latest* cut that has begun by this offset, rather than the first that contains it: two adjacent
      // cuts share a boundary, and a start at that boundary belongs to the later one.
      const cut = [...file.cuts].reverse().find((candidate) => candidate.fixtureStart <= offset);
      return cut === undefined ? offset : offset + (cut.sourceStart - cut.fixtureStart);
    };
    remapped[id] = { ...entry, start: map(entry.start), end: map(entry.end) };
  }
  return remapped as Readonly<Record<TableId, Evidence>>;
}
