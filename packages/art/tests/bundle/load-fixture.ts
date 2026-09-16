/**
 * Loading the committed fixture for the bundle tests.
 *
 * The fixture is parsed by the same reader and extracted by the same predicates the sync uses, so a test here
 * is a test of the shipped path rather than of a test-only echo of it. Evidence comes back with its byte ranges
 * translated to the game's own chunk (see `remapEvidence`), which is what makes an assertion about a byte range
 * meaningful and lets the full-bundle test compare the two runs directly.
 *
 * Everything is offline: the fixture is committed under `packages/art/fixtures/`, the atlas is the game's own
 * frame keys captured beside it, and nothing here opens a socket.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractArtTables } from '../../src/bundle/extract.ts';
import type { ParsedChunk } from '../../src/bundle/shape.ts';
import type { ArtTables, Evidence, TableId } from '../../src/bundle/tables.ts';
import {
  type FixtureManifest,
  readFixtures,
  remapEvidence,
  restoreImports,
} from '../../src/bundle/tools/fixtures.ts';
import { projectChunk } from '../../src/bundle/tools/typescript-reader.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** The captured build every bundle test reads. */
export const FIXTURE_DIR = resolve(here, '../../fixtures/bundle-1176');

/** A frame as the game's atlas manifest states it, trimmed to what a placement reads. */
export interface FixtureFrame {
  readonly frame: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly rotated: boolean;
  readonly trimmed: boolean;
  readonly spriteSourceSize: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  };
  readonly sourceSize: { readonly w: number; readonly h: number };
  readonly anchor: { readonly x: number; readonly y: number };
  readonly sourcePixelRatio?: number;
  readonly visualBaselineY?: number;
}

export interface FixtureAtlas {
  readonly note: string;
  readonly frameKeys: readonly string[];
  readonly frames: Readonly<Record<string, FixtureFrame>>;
}

export interface LoadedFixture {
  readonly tables: ArtTables;
  readonly evidence: Readonly<Record<TableId, Evidence>>;
  readonly atlas: FixtureAtlas;
  readonly manifest: FixtureManifest;
  /** The fixture chunks as text, keyed by the chunk they stand for: a test can mutate one and re-extract. */
  readonly chunkTexts: readonly { readonly file: string; readonly text: string }[];
}

/** Read, project and extract the committed fixture. */
export function loadFixture(directory: string = FIXTURE_DIR): LoadedFixture {
  const { manifest, chunks } = readFixtures(directory);
  const chunks_ = chunks;
  const projected = restoreImports(
    chunks_.map((chunk) => projectChunk(chunk.file, chunk.text)),
    manifest,
  );
  const { tables, evidence } = extractArtTables(projected);
  const atlas = JSON.parse(readFileSync(join(directory, 'atlas-frames.json'), 'utf8')) as FixtureAtlas;
  return {
    tables,
    evidence: remapEvidence(evidence, manifest),
    atlas,
    manifest,
    chunkTexts: chunks_,
  };
}

/** Extract from chunk texts a test has changed; throws what the extractor throws. */
export function extractTexts(texts: readonly { readonly file: string; readonly text: string }[]): {
  readonly tables: ArtTables;
  readonly evidence: Readonly<Record<TableId, Evidence>>;
} {
  return extractArtTables(texts.map((chunk) => projectChunk(chunk.file, chunk.text)));
}

/** The chunk text for one fixture file, so a test can name what it is changing. */
export function chunkText(fixture: LoadedFixture, file: string): string {
  const chunk = fixture.chunkTexts.find((candidate) => candidate.file === file);
  if (chunk === undefined) throw new Error(`the fixture holds no chunk named ${file}`);
  return chunk.text;
}

/** All chunk texts of a fixture, ready to be projected. */
export function textsOf(fixture: LoadedFixture): readonly { readonly file: string; readonly text: string }[] {
  return fixture.chunkTexts;
}

/** The parsed chunk the placement function lives in, for a test that wants its projections. */
export function parsedChunks(fixture: LoadedFixture): readonly ParsedChunk[] {
  return fixture.chunkTexts.map((chunk) => projectChunk(chunk.file, chunk.text));
}
