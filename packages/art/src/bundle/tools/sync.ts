/**
 * `art:sync`: one command that fetches the game, reads its tables, checks them, and writes what the package
 * consumes.
 *
 * The alternative is what this project did for twelve commits -- notice a wrong constant, find it by hand, edit
 * it -- so the seven steps of §9 run in one place, in the order that makes a failure mean something:
 *
 *   1. version    `platform/v1/version` on the game's own origin, because everything downstream is keyed by it
 *   2. bundle     the chunk graph, walked the way `mgafk-pi/getMGBundle.mjs` walks it, into a version-keyed cache
 *   3. atlas      the asset manifest, every resolution-2 pack, and the frame map with its anchors and ratios
 *   4. decode     delegated: the pixel decode is `@mg.js/art/node` (commit 12), and step 4 says so when absent
 *   5. extract    the shape predicates of §8 over the chunks
 *   6. validate   the atlas and the plant table, as witnesses that owe nothing to the shape that proposed a table
 *   7. write      `data/<version>.json`, `docs/art-provenance.md`, and the fixture capture beside them
 *
 * Two modes matter more than the rest. `--check` regenerates in memory and compares against what is committed,
 * and it never opens a socket: it reads the cached bundle when this machine has one and the committed fixture
 * when it does not, which is what lets `npm run verify` run in CI with no game and no network. `--from <url>`
 * replaces steps 2 and 5 with one contract-checked `GET` against a host that publishes the same record, which is
 * the fast path for anybody who trusts one.
 *
 * The units and the costs are recorded where they bite. A missing table is an `ExtractionError` naming its
 * predicate, and this tool turns that into exit code 1 with the message on stderr, because a scheduled job has to
 * separate "the game changed shape" from "the network is down" without parsing prose.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artDataOf, serializeArtData } from '../data.js';
import { artDataFor, ExtractionError, extractArtTables } from '../extract.js';
import { provenanceFor, renderProvenanceDoc } from '../provenance.js';
import type { ArtData } from '../tables.js';
import { validateTables } from '../validate.js';
import {
  type FixtureManifest,
  type FixtureSources,
  readFixtures,
  remapEvidence,
  restoreImports,
  writeFixtures,
} from './fixtures.js';
import { projectChunk } from './typescript-reader.js';

/** Expected and documented. */
export const EXIT_OK = 0;
/** A finding: the committed data is stale, or a predicate no longer finds its table. */
export const EXIT_FAILED = 1;
/** The game could not be reached, so nothing was learned. */
export const EXIT_NO_CONNECT = 2;
/** The command was asked for something it does not do. */
export const EXIT_USAGE = 3;

const DEFAULT_ORIGIN = 'https://magicgarden.gg';
const DEFAULT_PAGE = 'https://magicgarden.gg/r/test';
const CRAWL_DEPTH = 6;

/** The slice of `fetch` this tool uses, so a test can serve fixtures with no socket. */
export type SyncHttp = (url: string) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export interface SyncArgs {
  readonly check: boolean;
  readonly from: string | null;
  readonly bundle: string | null;
  readonly fixtures: boolean;
  readonly origin: string;
  readonly page: string;
  readonly help: boolean;
}

/** Parse the flags. Unknown flags are a usage error rather than something quietly ignored. */
export function parseArgs(argv: readonly string[]): SyncArgs {
  const args: {
    check: boolean;
    from: string | null;
    bundle: string | null;
    fixtures: boolean;
    origin: string;
    page: string;
    help: boolean;
  } = {
    check: false,
    from: null,
    bundle: null,
    fixtures: false,
    origin: DEFAULT_ORIGIN,
    page: DEFAULT_PAGE,
    help: false,
  };
  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at];
    const value = (): string => {
      const next = argv[at + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${String(flag)} needs a value`);
      at += 1;
      return next;
    };
    switch (flag) {
      case '--check':
        args.check = true;
        break;
      case '--from':
        args.from = value();
        break;
      case '--bundle':
        args.bundle = resolve(value());
        break;
      case '--fixtures':
        args.fixtures = true;
        break;
      case '--origin':
        args.origin = value().replace(/\/$/, '');
        break;
      case '--page':
        args.page = value();
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`unknown flag ${String(flag)}`);
    }
  }
  if (args.check && args.from !== null) throw new Error('--check and --from are different sources: use one');
  return args;
}

/** One step's outcome, reported whether it ran, was skipped, or found something. */
export interface SyncStep {
  readonly step: string;
  readonly detail: string;
}

export interface SyncOptions {
  readonly repoRoot?: string;
  readonly args?: Partial<SyncArgs>;
  readonly fetch?: SyncHttp;
  readonly cacheRoot?: string;
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
}

/** Everything the sync decided, in memory: what would be written, and how it was learned. */
export interface SyncPlan {
  readonly gameVersion: string;
  readonly artVersion: string;
  readonly source: 'bundle' | 'fixture' | 'url';
  readonly data: ArtData;
  readonly serialized: string;
  readonly provenance: string;
  readonly steps: readonly SyncStep[];
  readonly chunks: readonly { readonly file: string; readonly text: string }[];
  readonly frameKeys: readonly string[];
  readonly frames: Readonly<Record<string, unknown>>;
  readonly fixtureSources: FixtureSources | null;
}

/** Where a version's things live, derived from the repo root rather than from the working directory. */
function paths(
  repoRoot: string,
  version: string,
): {
  readonly dataFile: string;
  readonly provenanceDoc: string;
  readonly fixtureDir: string;
  readonly dataDir: string;
} {
  return {
    dataFile: join(repoRoot, 'packages/art/data', `${version}.json`),
    provenanceDoc: join(repoRoot, 'docs/art-provenance.md'),
    fixtureDir: join(repoRoot, 'packages/art/fixtures', `bundle-${version}`),
    dataDir: join(repoRoot, 'packages/art/data'),
  };
}

/** `bundle-<major>-<minor>`, which is the directory name `mgafk-pi/getMGBundle.mjs` writes. */
export function bundleDirectoryName(version: string): string {
  const parts = version.match(/\d+/g) ?? [];
  if (parts.length >= 2) return `bundle-${parts[0]}-${parts[1]}`;
  if (parts.length === 1) return `bundle-${parts[0]}-0`;
  return `bundle-${Date.now()}-0`;
}

/**
 * Where a fetched bundle is cached.
 *
 * The workspace's own capture directory first, because that is the cache this project already has and `--check`
 * is expected to run against it; the system temporary directory otherwise, so a consumer of the package gets a
 * working command without a configuration step.
 */
function defaultCacheRoot(repoRoot: string): string {
  const workspace = resolve(repoRoot, '../../mgafk-pi/json');
  return existsSync(workspace) ? workspace : join(tmpdir(), 'mgjs-art-bundles');
}

/** The newest committed data file, with the version it stamps and its bytes. */
function committedData(repoRoot: string): { version: string; text: string } | null {
  const directory = join(repoRoot, 'packages/art/data');
  if (!existsSync(directory)) return null;
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse();
  const newest = files[0];
  if (newest === undefined) return null;
  return { version: newest.replace(/\.json$/, ''), text: readFileSync(join(directory, newest), 'utf8') };
}

function chunksOf(directory: string): readonly { file: string; text: string }[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => ({ file: name, text: readFileSync(join(directory, name), 'utf8') }));
}

/** The atlas capture a bundle directory or a fixture carries, if either states one. */
function cachedAtlas(directories: readonly string[]): {
  frameKeys: readonly string[];
  frames: Readonly<Record<string, unknown>>;
  packs?: readonly string[];
} | null {
  for (const directory of directories) {
    const file = join(directory, 'atlas-frames.json');
    if (!existsSync(file)) continue;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      frameKeys?: readonly string[];
      frames?: Readonly<Record<string, unknown>>;
      sources?: { atlasPacks?: readonly string[] };
    };
    if (parsed.frameKeys !== undefined && parsed.frameKeys.length > 0) {
      return {
        frameKeys: parsed.frameKeys,
        frames: parsed.frames ?? {},
        ...(parsed.sources?.atlasPacks === undefined ? {} : { packs: parsed.sources.atlasPacks }),
      };
    }
  }
  return null;
}

/** 1. Version, from the game's own origin. */
async function readVersion(http: SyncHttp, origin: string): Promise<string> {
  const response = await http(`${origin}/platform/v1/version`);
  if (!response.ok) throw new Error(`the version endpoint responded ${response.status}`);
  const body = (await response.json()) as { version?: unknown };
  if (typeof body.version !== 'string' || body.version === '') {
    throw new Error(`the version endpoint stated no version: ${JSON.stringify(body)}`);
  }
  return body.version;
}

/** 2. The bundle: page HTML -> index chunk -> every chunk it imports, depth six, into a version-keyed cache. */
async function captureBundle(input: {
  readonly http: SyncHttp;
  readonly page: string;
  readonly directory: string;
  readonly log: (line: string) => void;
  readonly now: () => Date;
}): Promise<void> {
  const { http, directory, log } = input;
  const manifestPath = join(directory, 'capture-manifest.json');
  if (existsSync(manifestPath)) {
    log(`2. bundle: ${directory} is already captured (${readdirSync(directory).length} files)`);
    return;
  }
  mkdirSync(directory, { recursive: true });
  const html = await (async () => {
    const response = await http(input.page);
    if (!response.ok) throw new Error(`the game page responded ${response.status}`);
    return response.text();
  })();
  const indexRelative = /src="([^"]*\/assets\/index-[^"]+\.js)"/.exec(html)?.[1];
  if (indexRelative === undefined) throw new Error('the game page names no index chunk');
  const indexUrl = new URL(indexRelative, input.page).href;

  const queue: { url: string; depth: number }[] = [{ url: indexUrl, depth: 0 }];
  const seen = new Set<string>();
  const captured: { filename: string; url: string; bytes: number }[] = [];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    if (seen.has(next.url) || next.depth > CRAWL_DEPTH) continue;
    seen.add(next.url);
    const response = await http(next.url);
    if (!response.ok) {
      log(`   skipped ${next.url} (${response.status})`);
      continue;
    }
    const text = await response.text();
    const filename = new URL(next.url).pathname.split('/').at(-1) ?? `chunk-${seen.size}.js`;
    writeFileSync(join(directory, filename), text);
    captured.push({ filename, url: next.url, bytes: text.length });
    // The same reference forms the reference implementation collects: `assets/foo.js` resolves against the
    // origin's asset directory, `./foo.js` beside the chunk that named it.
    for (const [, spec] of text.matchAll(/["'`](assets\/[^"'`\s]+\.js)["'`]/g)) {
      if (spec !== undefined)
        queue.push({ url: new URL(spec, `${new URL(next.url).origin}/`).href, depth: next.depth + 1 });
    }
    for (const [, spec] of text.matchAll(/["'`](\.{1,2}\/[^"'`\s]+\.js)["'`]/g)) {
      if (spec !== undefined) queue.push({ url: new URL(spec, next.url).href, depth: next.depth + 1 });
    }
  }
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        pageUrl: input.page,
        indexUrl,
        capturedAt: input.now().toISOString(),
        chunkCount: captured.length,
        chunks: captured,
      },
      null,
      2,
    )}\n`,
  );
  log(`2. bundle: captured ${captured.length} chunks into ${directory}`);
}

/** 3. The atlas: the asset manifest, every resolution-2 pack, and the frame map. */
async function readAtlas(input: {
  readonly http: SyncHttp;
  readonly origin: string;
  readonly artVersion: string;
  readonly log: (line: string) => void;
}): Promise<{
  frameKeys: readonly string[];
  frames: Readonly<Record<string, unknown>>;
  packs: readonly string[];
}> {
  const at = (path: string): string => `${input.origin}/version/${input.artVersion}/assets/${path}`;
  const manifestResponse = await input.http(at('manifest.json'));
  if (!manifestResponse.ok) throw new Error(`the asset manifest responded ${manifestResponse.status}`);
  const manifest = (await manifestResponse.json()) as {
    bundles?: readonly { assets?: readonly { alias?: unknown; src?: unknown }[] }[];
  };
  const wanted = ['atlases/sprites-0.json', 'atlases/tiles.json', 'atlases/weather.json'];
  const starts: string[] = [];
  for (const bundle of manifest.bundles ?? []) {
    for (const asset of bundle.assets ?? []) {
      const aliases = Array.isArray(asset.alias) ? asset.alias : [asset.alias];
      if (!aliases.some((alias) => typeof alias === 'string' && wanted.includes(alias))) continue;
      const sources = Array.isArray(asset.src) ? asset.src : [asset.src];
      const twoX = sources.find(
        (source): source is { src: string; resolution?: number } =>
          source !== null &&
          typeof source === 'object' &&
          (source as { resolution?: number }).resolution === 2,
      );
      const path = twoX?.src ?? (sources[0] as { src?: string } | undefined)?.src;
      if (typeof path === 'string') starts.push(path);
    }
  }
  if (starts.length === 0) throw new Error('the asset manifest names no sprite, tile or weather atlas');
  const frames: Record<string, unknown> = {};
  const packs: string[] = [];
  const seen = new Set<string>();
  const queue = [...starts];
  while (queue.length > 0) {
    const path = queue.shift();
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);
    const response = await input.http(at(path));
    if (!response.ok) throw new Error(`atlas ${path} responded ${response.status}`);
    const pack = (await response.json()) as {
      frames?: Readonly<Record<string, unknown>>;
      meta?: { related_multi_packs?: readonly string[] };
    };
    packs.push(path);
    for (const [key, frame] of Object.entries(pack.frames ?? {})) frames[key] = frame;
    // A pack names the rest of its own set by bare filename, beside itself.
    const directory = path.includes('/') ? `${path.slice(0, path.lastIndexOf('/'))}/` : '';
    for (const related of pack.meta?.related_multi_packs ?? []) queue.push(`${directory}${related}`);
  }
  input.log(
    `3. atlas: ${Object.keys(frames).length} frames across ${packs.length} packs at art version ${input.artVersion}`,
  );
  return { frameKeys: Object.keys(frames), frames, packs };
}

/** Everything up to, but not including, writing: the same work `--check` does before it compares. */
export async function planSync(options: SyncOptions = {}): Promise<SyncPlan> {
  const repoRoot = options.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
  const args: SyncArgs = { ...parseArgs([]), ...options.args };
  const http: SyncHttp = options.fetch ?? ((url: string) => fetch(url) as unknown as ReturnType<SyncHttp>);
  const log = options.log ?? ((): void => {});
  const now = options.now ?? ((): Date => new Date());
  const steps: SyncStep[] = [];

  /** A capture directory is read the same way whether it is a bundle or a fixture that stands in for one. */
  const readCapture = (
    directory: string,
  ): { chunks: readonly { file: string; text: string }[]; manifest: FixtureManifest | null } => {
    if (existsSync(join(directory, 'fixture.json'))) {
      const { manifest } = readFixtures(directory);
      return {
        chunks: manifest.files.map((file) => ({
          file: file.chunk,
          text: readFileSync(join(directory, file.fixture), 'utf8'),
        })),
        manifest,
      };
    }
    return { chunks: chunksOf(directory), manifest: null };
  };

  /** The version a capture states, so `--bundle` can run with no socket at all. */
  const statedVersion = (directory: string): { gameVersion: string; artVersion: string } | null => {
    const fixtureFile = join(directory, 'fixture.json');
    if (existsSync(fixtureFile)) {
      const { manifest } = readFixtures(directory);
      return { gameVersion: manifest.sources.gameVersion, artVersion: manifest.sources.artVersion };
    }
    const captureFile = join(directory, 'capture-manifest.json');
    if (existsSync(captureFile)) {
      const capture = JSON.parse(readFileSync(captureFile, 'utf8')) as { gameVersion?: string };
      if (typeof capture.gameVersion === 'string')
        return { gameVersion: capture.gameVersion, artVersion: capture.gameVersion };
    }
    return null;
  };

  const cacheRoot = options.cacheRoot ?? defaultCacheRoot(repoRoot);
  let gameVersion: string;
  let artVersion: string;
  let source: 'bundle' | 'fixture' | 'url';
  let chunks: readonly { file: string; text: string }[];
  let manifest: FixtureManifest | null = null;
  let directory: string;
  let sourceAtlas: {
    frameKeys: readonly string[];
    frames: Readonly<Record<string, unknown>>;
    packs?: readonly string[];
  } | null = null;

  if (args.from !== null) {
    // The fast path: one contract-checked GET replaces steps 2 and 5.
    const response = await http(args.from);
    if (!response.ok) throw new Error(`${args.from} responded ${response.status}`);
    const document = artDataOf(await response.json());
    const fixtureDir = paths(repoRoot, document.gameVersion).fixtureDir;
    const atlas =
      cachedAtlas([fixtureDir]) ??
      (await readAtlas({ http, origin: args.origin, artVersion: document.artVersion, log }));
    const failures = validateTables(document.tables, atlas.frameKeys);
    if (failures.length > 0) throw new ValidationFailed(failures);
    return {
      gameVersion: document.gameVersion,
      artVersion: document.artVersion,
      source: 'url',
      data: document,
      serialized: serializeArtData(document),
      provenance: renderProvenanceDoc(provenanceFor(), {
        gameVersion: document.gameVersion,
        artVersion: document.artVersion,
        evidence: document.evidence,
      }),
      steps: [
        { step: '1. version', detail: `${document.gameVersion} (stated by ${args.from})` },
        { step: '2. bundle', detail: `replaced by one contract-checked GET of ${args.from}` },
        { step: '3. atlas', detail: `${atlas.frameKeys.length} frames` },
        { step: '4. decode', detail: 'not needed: the host published the tables, not the pixels' },
        { step: '5. extract', detail: 'replaced by the same GET' },
        { step: '6. validate', detail: `${atlas.frameKeys.length} atlas frames confirm every path` },
      ],
      chunks: [],
      frameKeys: atlas.frameKeys,
      frames: atlas.frames,
      fixtureSources: null,
    };
  }

  if (args.check) {
    // Offline by construction: not one step below may open a socket, which is what lets `verify` run in CI.
    const committed = committedData(repoRoot);
    if (committed === null) {
      throw new Error('--check has nothing to check: packages/art/data holds no committed data file');
    }
    const candidates =
      args.bundle !== null
        ? [args.bundle]
        : [
            join(cacheRoot, bundleDirectoryName(committed.version)),
            paths(repoRoot, committed.version).fixtureDir,
          ];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (found === undefined) {
      throw new Error(
        `--check found no offline source for ${committed.version}: looked in ${candidates.join(', ')}. ` +
          'Capture the bundle, or run a live sync once.',
      );
    }
    const stated = statedVersion(found);
    gameVersion = stated?.gameVersion ?? committed.version;
    artVersion = stated?.artVersion ?? gameVersion;
    const capture = readCapture(found);
    chunks = capture.chunks;
    manifest = capture.manifest;
    directory = found;
    source = manifest === null ? 'bundle' : 'fixture';
    sourceAtlas = cachedAtlas([found, paths(repoRoot, gameVersion).fixtureDir]);
    steps.push({ step: '1. version', detail: `${gameVersion} (from the committed data, offline)` });
    steps.push({ step: '2. bundle', detail: `${source} at ${found} (${chunks.length} chunks)` });
    steps.push({
      step: '3. atlas',
      detail: sourceAtlas === null ? 'missing' : `${sourceAtlas.frameKeys.length} frames`,
    });
  } else if (args.bundle !== null) {
    // A capture or a fixture named on the command line: no version request, and an atlas from the capture if it
    // carries one. That is what makes a new-version test possible with no socket.
    const stated = statedVersion(args.bundle);
    gameVersion = stated?.gameVersion ?? (await readVersion(http, args.origin));
    artVersion = stated?.artVersion ?? gameVersion;
    const capture = readCapture(args.bundle);
    chunks = capture.chunks;
    manifest = capture.manifest;
    directory = args.bundle;
    source = manifest === null ? 'bundle' : 'fixture';
    sourceAtlas = cachedAtlas([args.bundle, paths(repoRoot, gameVersion).fixtureDir]);
    steps.push({ step: '1. version', detail: `${gameVersion} (stated by ${args.bundle})` });
    steps.push({ step: '2. bundle', detail: `${source} at ${args.bundle} (${chunks.length} chunks)` });
    steps.push({
      step: '3. atlas',
      detail: sourceAtlas === null ? 'fetched' : `${sourceAtlas.frameKeys.length} frames (cached)`,
    });
  } else {
    gameVersion = await readVersion(http, args.origin);
    artVersion = gameVersion;
    directory = join(cacheRoot, bundleDirectoryName(gameVersion));
    steps.push({ step: '1. version', detail: `${gameVersion} (${args.origin}/platform/v1/version)` });
    await captureBundle({ http, page: args.page, directory, log, now });
    const capture = readCapture(directory);
    chunks = capture.chunks;
    manifest = capture.manifest;
    source = manifest === null ? 'bundle' : 'fixture';
    sourceAtlas = cachedAtlas([directory]);
    steps.push({ step: '2. bundle', detail: `${chunks.length} chunks at ${directory}` });
  }

  if (chunks.length === 0) throw new Error(`no chunks in ${directory}`);
  const fetched =
    sourceAtlas === null ? await readAtlas({ http, origin: args.origin, artVersion, log }) : null;
  const atlas: { frameKeys: readonly string[]; frames: Readonly<Record<string, unknown>> } = sourceAtlas ??
    fetched ?? { frameKeys: [], frames: {} };
  const packs = fetched?.packs ?? sourceAtlas?.packs ?? [];

  // 4. Decode: the pixels are another entry's business, and the step says so rather than pretending.
  const decoder = await import('@mg.js/art/node').catch(() => null);
  const hasDecoder =
    decoder !== null && typeof (decoder as Record<string, unknown>)['frameBytes'] === 'function';
  steps.push({
    step: '4. decode',
    detail: hasDecoder
      ? 'the atlas decode is available in @mg.js/art/node: the frames a fixture needs are written with it'
      : 'skipped: the atlas decode is @mg.js/art/node (commit 12), which is not in this build',
  });

  // 5. Extract. A fixture is projected through the same reader and then translated back to the game's bytes, so
  // a check against the committed data compares the game's chunk offsets and not the fixture's.
  const projected = chunks.map((chunk) => projectChunk(chunk.file, chunk.text));
  const extraction = extractArtTables(manifest === null ? projected : restoreImports(projected, manifest));
  const evidence = manifest === null ? extraction.evidence : remapEvidence(extraction.evidence, manifest);
  steps.push({
    step: '5. extract',
    detail: Object.entries(evidence)
      .map(([id, entry]) => `${id} by ${entry.predicate}`)
      .join('; '),
  });

  // 6. Validate against the atlas, which owes nothing to the shape that proposed each table.
  const failures = validateTables(extraction.tables, atlas.frameKeys);
  if (failures.length > 0) throw new ValidationFailed(failures);
  steps.push({ step: '6. validate', detail: `${atlas.frameKeys.length} atlas frames confirm every path` });

  const data = artDataFor({ tables: extraction.tables, evidence }, { gameVersion, artVersion });
  return {
    gameVersion,
    artVersion,
    source,
    data,
    serialized: serializeArtData(data),
    provenance: renderProvenanceDoc(provenanceFor(), { gameVersion, artVersion, evidence }),
    steps,
    chunks,
    frameKeys: atlas.frameKeys,
    frames: atlas.frames,
    fixtureSources: {
      gameVersion,
      artVersion,
      origin: args.origin,
      atlasManifest: `version/${artVersion}/assets/manifest.json`,
      atlasPacks: packs,
    },
  };
}

/** Validation said no: the witness disagreed with the shape, and both are named. */
export class ValidationFailed extends Error {
  readonly failures: readonly {
    readonly check: string;
    readonly saw: readonly string[];
    readonly detail: string;
  }[];

  constructor(
    failures: readonly { readonly check: string; readonly saw: readonly string[]; readonly detail: string }[],
  ) {
    super(
      `the atlas refused ${failures.length} of the extracted tables: ` +
        failures
          .map((failure) => `${failure.check} (${failure.detail}: ${failure.saw.join(', ')})`)
          .join(' | '),
    );
    this.name = 'ValidationFailed';
    this.failures = failures;
  }
}

/** What `--check` found: the differences, as readable lines. */
export interface CheckReport {
  readonly differences: readonly string[];
}

/** Compare a plan against what is committed, without writing anything. */
export function checkPlan(plan: SyncPlan, repoRoot: string): CheckReport {
  const names = paths(repoRoot, plan.gameVersion);
  const differences: string[] = [];
  if (!existsSync(names.dataFile)) {
    differences.push(`${names.dataFile} does not exist: run \`npm run art:sync\` to write it`);
  } else {
    const committed = readFileSync(names.dataFile, 'utf8');
    if (committed !== plan.serialized) {
      differences.push(
        `packages/art/data/${plan.gameVersion}.json differs from a fresh extraction ` +
          `(${committed.length} bytes committed, ${plan.serialized.length} bytes extracted)`,
      );
    }
  }
  if (!existsSync(names.provenanceDoc)) {
    differences.push(
      `${names.provenanceDoc} does not exist: run \`npm run art:sync -- --fixtures\` to write it`,
    );
  } else if (readFileSync(names.provenanceDoc, 'utf8') !== plan.provenance) {
    differences.push('docs/art-provenance.md differs from the record regenerated from the committed data');
  }
  return { differences };
}

/** Write the plan: the data file, the provenance document, and the fixture capture beside them. */
export function applySync(
  plan: SyncPlan,
  repoRoot: string,
  options: { readonly fixtures: boolean } = { fixtures: false },
): readonly string[] {
  const names = paths(repoRoot, plan.gameVersion);
  mkdirSync(names.dataDir, { recursive: true });
  writeFileSync(names.dataFile, plan.serialized);
  writeFileSync(names.provenanceDoc, plan.provenance);
  const written = [names.dataFile, names.provenanceDoc];
  if (options.fixtures && plan.fixtureSources !== null && plan.source !== 'url') {
    const chunks = plan.chunks.map((chunk) => projectChunk(chunk.file, chunk.text));
    writeFixtures(names.fixtureDir, chunks, plan.data.evidence, plan.fixtureSources, {
      artVersion: plan.artVersion,
      frameKeys: plan.frameKeys,
      frames: plan.frames,
    });
    written.push(names.fixtureDir);
  }
  return written;
}

/** The command: plan, then either compare or write, and answer with an exit code. */
export async function main(argv: readonly string[], options: SyncOptions = {}): Promise<number> {
  const log = options.log ?? ((line: string): void => console.log(line));
  const error = (line: string): void => console.error(line);
  let args: SyncArgs;
  try {
    args = parseArgs(argv);
  } catch (cause) {
    error(`art:sync: ${cause instanceof Error ? cause.message : String(cause)}`);
    error('usage: npm run art:sync [-- --check] [--from <url>] [--bundle <dir>] [--fixtures]');
    return EXIT_USAGE;
  }
  if (args.help) {
    log('usage: npm run art:sync [-- --check] [--from <url>] [--bundle <dir>] [--fixtures]');
    log('  (no flags)        fetch the game, extract, validate, and write data/<version>.json');
    log('  --check           regenerate in memory and fail on any difference; never opens a socket');
    log('  --from <url>      replace steps 2 and 5 with one contract-checked GET of an art data document');
    log('  --bundle <dir>    read the chunks from a capture instead of fetching them');
    log('  --fixtures        also write the fixture capture the offline tests read');
    return EXIT_OK;
  }
  const repoRoot = options.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
  try {
    const plan = await planSync({ ...options, args });
    for (const step of plan.steps) log(step.step.includes('\n') ? step.step : `${step.step}: ${step.detail}`);
    if (args.check) {
      const report = checkPlan(plan, repoRoot);
      if (report.differences.length > 0) {
        for (const difference of report.differences) error(`art:sync --check: ${difference}`);
        return EXIT_FAILED;
      }
      log(`art:sync --check: ${plan.gameVersion} is current (checked offline against ${plan.source})`);
      return EXIT_OK;
    }
    const written = applySync(plan, repoRoot, { fixtures: args.fixtures || plan.source === 'bundle' });
    for (const path of written) log(`7. write: ${path}`);
    log(`art:sync: ${plan.gameVersion} refreshed (${plan.source})`);
    return EXIT_OK;
  } catch (cause) {
    if (cause instanceof ExtractionError) {
      error(`art:sync: the game changed shape: ${cause.message}`);
      return EXIT_FAILED;
    }
    if (cause instanceof ValidationFailed) {
      error(`art:sync: ${cause.message}`);
      return EXIT_FAILED;
    }
    error(`art:sync: ${cause instanceof Error ? cause.message : String(cause)}`);
    return EXIT_NO_CONNECT;
  }
}

// Only when executed as a script: importing this module from a test must not touch the network, and must not
// call `process.exit` either -- the exit code is the caller's.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (cause: unknown) => {
      console.error('art:sync: fatal:', cause);
      process.exitCode = EXIT_NO_CONNECT;
    },
  );
}
