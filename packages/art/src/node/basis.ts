/**
 * The vendored Basis Universal transcoder, loaded the only way ESM lets it be loaded.
 *
 * `assets/basis_transcoder.js` is an Emscripten IIFE that ends by assigning `var BASIS`, written to be
 * fetched by a `<script>` tag. It cannot be imported (it has no exports) and it cannot be `require`d
 * either: this package is `"type": "module"`, so Node refuses to `require` a `.js` file inside it with
 * `ERR_REQUIRE_ESM`. Evaluating its source with the `require`, `__dirname` and `__filename` it expects is
 * what the fork's own decoder does, and it is the only way in that leaves the artefact's bytes -- and the
 * digest `assets/basis_transcoder.sha256` records -- untouched.
 *
 * The `.wasm` is read here and handed to the factory as `wasmBinary`, so the runtime never goes looking for
 * it and never touches the network. `node:fs` is imported for exactly this.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The slice of the transcoder's Emscripten module this package calls. */
export interface BasisTranscoder {
  /** Brings `KTX2File` up, and must be called once after the factory resolves. */
  initializeBasis(): void;
  KTX2File: new (data: Uint8Array) => BasisKtx2File;
  transcoder_texture_format: { cTFRGBA32: { value: number } };
}

/** A transcoder file handle. Freed with `close` then `delete`, both of which the transcoder requires. */
export interface BasisKtx2File {
  isValid(): boolean;
  getWidth(): number;
  getHeight(): number;
  startTranscoding(): boolean;
  getImageTranscodedSizeInBytes(level: number, layer: number, face: number, format: number): number;
  transcodeImage(
    destination: Uint8Array,
    level: number,
    layer: number,
    face: number,
    format: number,
    decodeFlags: number,
    channel0: number,
    channel1: number,
  ): boolean;
  close(): void;
  delete(): void;
}

type TranscoderFactory = (options: { wasmBinary: Uint8Array }) => Promise<BasisTranscoder>;

// The artefact sits at the package root, two directories above both `dist/node/` and `src/node/`, so one
// relative URL resolves the same way whether this runs from the build or from `tsx`.
const assets = (name: string) => fileURLToPath(new URL(`../../assets/${name}`, import.meta.url));

let pending: Promise<BasisTranscoder> | null = null;

async function initialise(): Promise<BasisTranscoder> {
  const scriptPath = assets('basis_transcoder.js');
  const wasmPath = assets('basis_transcoder.wasm');

  const require = createRequire(scriptPath);
  const source = readFileSync(scriptPath, 'utf8');
  const evaluate = new Function('require', '__dirname', '__filename', `${source}\nreturn BASIS;`);
  const factory = evaluate(require, dirname(scriptPath), scriptPath) as TranscoderFactory;

  const transcoder = await factory({ wasmBinary: readFileSync(wasmPath) });
  transcoder.initializeBasis();
  return transcoder;
}

/**
 * The transcoder module, initialised once per process and cached.
 *
 * A failed initialisation is not cached: a test that breaks the wasm path and then fixes it should not have
 * to start a new process for the second attempt to be believed.
 */
export function loadBasisTranscoder(): Promise<BasisTranscoder> {
  pending ??= initialise().catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}
