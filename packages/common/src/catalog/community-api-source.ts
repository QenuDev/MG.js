/**
 * The community API, read through a contract check rather than trusted because it answered.
 *
 * `RemoteJsonSource` already speaks `/data/*` to any base URL, but "any base URL" is a promise a caller
 * cannot verify: a host that serves a plant list today may serve a different shape tomorrow, or be a
 * different implementation entirely. So this source fetches the host's own description of itself,
 * `GET <base>/schema.json` (`docs/mgjs-community-api-plan.md` §2), and refuses the URL unless it can see
 * that the host speaks this build's contract, declares the capabilities the caller asked for, and was
 * built from a game version that parses.
 *
 * The check runs in that order and stops at the first refusal, so the error names the first thing that is
 * wrong rather than a summary of everything. Failure is {@link CommunityApiContractError}, which carries
 * the value that was found and the value that was required, because "refused" without those two facts is
 * an error a caller can only report, not act on.
 *
 * ## What this module does not do
 *
 * It does not decide *which* host. {@link DEFAULT_COMMUNITY_API_URL} is deliberately unset, and a
 * construction with no `baseUrl` refuses instead of calling a placeholder or somebody else's deployment.
 * A consumer that wants a community API passes one; that is the setting, and this library ships the check
 * rather than a policy.
 */

import type { CatalogKind } from './defs.js';
import { gameVersionOf } from './game-version.js';
import type { FetchJsonOptions } from './http.js';
import { fetchJson } from './http.js';
import { RemoteJsonSource } from './remote-json-source.js';
import type { CatalogSource } from './source.js';

/**
 * The contract `api` version this build speaks.
 *
 * The number the host declares in its `x-mg-contract.api` block and serves at `/schema.json`
 * (`docs/mgjs-community-api-plan.md` §2: `api: 1`). A host that declares anything else is refused: this
 * is the one fact that cannot be negotiated per request, because it is the promise that the *shape* of
 * every other answer is the shape this client parses. Bumping it is how the fork announces a breaking
 * change.
 */
export const SUPPORTED_API_CONTRACT = 1;

/**
 * Where our community API is. **Unset, on purpose.**
 *
 * The library reads a fork of the community API that is ours to host (`QenuDev/mgjs-data-api`,
 * `docs/mgjs-community-api-plan.md` §1). That instance is not deployed yet, and the deployment that does
 * exist — `mg-api.ariedam.fr` — belongs to the upstream project, not to us. Defaulting to it would make
 * every consumer of this library depend on a stranger's uptime and on their choice of what to serve, and
 * would do it silently, which is the failure this constant is shaped to avoid.
 *
 * So the default is the empty string, and empty means "not configured": {@link CommunityApiSource}
 * refuses it with a named error before any request, instead of fetching a placeholder or somebody else's
 * host. When our instance is up, its URL is written here and here only — a test asserts that no other
 * module under `packages/` names a community host.
 */
export const DEFAULT_COMMUNITY_API_URL = '';

/** Which of the three ordered checks refused a host. */
export type CommunityApiContractErrorReason =
  /** No base URL at all: `DEFAULT_COMMUNITY_API_URL` is unset and the caller passed none. */
  | 'no-base-url'
  /** `/schema.json` could not be fetched or was not JSON (a 404, an HTML error page, a timeout). */
  | 'schema-unreachable'
  /** `/schema.json` answered with JSON that is not a contract document (a string, an array, `null`). */
  | 'unexpected-schema'
  /** The contract's `api` version is not one this build speaks. */
  | 'unsupported-api-version'
  /** A capability the caller asked for is not in the contract's `capabilities`. */
  | 'missing-capability'
  /** The contract's `gameVersion` is absent or does not parse as a build id. */
  | 'unparseable-game-version';

/** The `/schema.json` document, as much of it as a client reads. */
export interface CommunityApiContract {
  /** The contract version this host speaks. Must equal {@link SUPPORTED_API_CONTRACT}. */
  readonly api: number;
  /** What the host can serve, as the fork names it (`data`, `live.shops`, `compose`, …). */
  readonly capabilities: readonly string[];
  /** The game build this host's data and sprites were built from. */
  readonly gameVersion: string;
  /** `info.version` of the host's document; the same fact as `api` under the name OpenAPI uses. */
  readonly contract?: number;
  /** The paths the host's own document covers. */
  readonly paths?: readonly string[];
  /** The `/data` categories the running bundle can actually build. */
  readonly data?: readonly string[];
  /** The declared categories the running bundle cannot build, keyed by category. */
  readonly unavailable?: Record<string, unknown>;
  /** The art version, which the fork states separately from the game version. */
  readonly artVersion?: string | null;
  /** When the host's current data was built. */
  readonly generatedAt?: string | null;
  readonly [field: string]: unknown;
}

/** A host was refused. Carries what was found, what was required, and which check refused it. */
export class CommunityApiContractError extends Error {
  /** Which of the ordered checks refused the host. */
  readonly reason: CommunityApiContractErrorReason;
  /** The origin that was checked, normalised, or `''` when none was configured. */
  readonly baseUrl: string;
  /** The value that was found: the contract's, the host's response, or the underlying error. */
  readonly found: unknown;
  /** The value that was required: the supported version, the requested capabilities, the path. */
  readonly required: unknown;

  constructor(
    message: string,
    options: {
      reason: CommunityApiContractErrorReason;
      baseUrl: string;
      found: unknown;
      required: unknown;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'CommunityApiContractError';
    this.reason = options.reason;
    this.baseUrl = options.baseUrl;
    this.found = options.found;
    this.required = options.required;
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/** Options for {@link verifyContract}. */
export interface VerifyContractOptions {
  /** The fetch to use. Default the global one; this is the seam the tests run through. */
  fetch?: typeof fetch;
  /** Capabilities the caller needs. Each must appear in the contract's `capabilities`. */
  require?: readonly string[];
}

/** Options for {@link CommunityApiSource}. */
export interface CommunityApiSourceOptions {
  /**
   * The origin to read, without a trailing slash. Defaults to {@link DEFAULT_COMMUNITY_API_URL}, which is
   * unset: a construction with neither refuses rather than calling a placeholder.
   */
  baseUrl?: string;
  /** The fetch to use. Default the global one. */
  fetch?: typeof fetch;
  /**
   * A contract the caller has already verified, so the source does not fetch `/schema.json` again.
   *
   * This is for a process that checks a host once and then hands the same host to several sources.
   */
  contract?: CommunityApiContract;
  /** Capabilities the caller needs, checked by {@link verifyContract} on first use. */
  require?: readonly string[];
}

/**
 * Fetch `<base>/schema.json` and check, in order, that this build can read the host.
 *
 * The three checks, and why that order:
 *
 *   1. **The contract `api` version is one this build supports.** Nothing else can be trusted until the
 *      host promises the shape this client parses, so it is checked first and reported alone.
 *   2. **Every requested capability is declared.** A host can speak the right contract and still not have
 *      the part the caller came for; the error names which capabilities were requested and what the host
 *      declared instead.
 *   3. **The game version it was built from parses.** A version that cannot be read is worse than none:
 *      the whole point of the number is telling one build's data from another's.
 *
 * @returns the parsed contract, so a caller can report what it is using.
 * @throws {CommunityApiContractError} with `reason`, `found` and `required` set.
 */
export async function verifyContract(
  baseUrl: string,
  options: VerifyContractOptions = {},
): Promise<CommunityApiContract> {
  const base = baseUrl.replace(/\/+$/, '');
  if (base.length === 0) {
    throw new CommunityApiContractError(
      'No community API base URL: DEFAULT_COMMUNITY_API_URL is unset and no baseUrl was passed. ' +
        'Pass the origin of the instance you want to read, e.g. { baseUrl: "https://your-host" }.',
      { reason: 'no-base-url', baseUrl: '', found: null, required: 'a community API base URL' },
    );
  }

  const requested = options.require ?? [];
  const schemaUrl = `${base}/schema.json`;
  const fetchOptions: FetchJsonOptions = options.fetch ? { fetch: options.fetch } : {};

  let payload: unknown;
  try {
    payload = await fetchJson<unknown>(schemaUrl, fetchOptions);
  } catch (error) {
    throw new CommunityApiContractError(`${schemaUrl} could not be read as JSON, so the host was refused.`, {
      reason: 'schema-unreachable',
      baseUrl: base,
      found: error,
      required: 'a JSON contract document',
      cause: error,
    });
  }

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CommunityApiContractError(
      `${schemaUrl} answered ${JSON.stringify(payload)?.slice(0, 100) ?? 'undefined'}, which is not a contract document.`,
      {
        reason: 'unexpected-schema',
        baseUrl: base,
        found: payload,
        required: 'an object carrying api, capabilities and gameVersion',
      },
    );
  }

  const document = payload as Record<string, unknown>;

  // 1. The contract api version.
  if (document.api !== SUPPORTED_API_CONTRACT) {
    throw new CommunityApiContractError(
      `${base} declares contract api ${JSON.stringify(document.api)}, and this build speaks ` +
        `${SUPPORTED_API_CONTRACT}.`,
      {
        reason: 'unsupported-api-version',
        baseUrl: base,
        found: document.api,
        required: SUPPORTED_API_CONTRACT,
      },
    );
  }

  // 2. Every requested capability.
  const declared = Array.isArray(document.capabilities)
    ? document.capabilities.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const missing = requested.filter((capability) => !declared.includes(capability));
  if (missing.length > 0) {
    throw new CommunityApiContractError(
      `${base} does not declare ${missing.map((name) => JSON.stringify(name)).join(', ')}; it declares ` +
        `${declared.length === 0 ? 'nothing' : declared.map((name) => JSON.stringify(name)).join(', ')}.`,
      {
        reason: 'missing-capability',
        baseUrl: base,
        found: declared,
        required: missing,
      },
    );
  }

  // 3. The game version the data was built from.
  if (!parsesGameVersion(document.gameVersion)) {
    throw new CommunityApiContractError(
      `${base} declares game version ${JSON.stringify(document.gameVersion)}, which is not a build id.`,
      {
        reason: 'unparseable-game-version',
        baseUrl: base,
        found: document.gameVersion,
        required: 'a numeric game build id, e.g. "1189"',
      },
    );
  }

  return { ...document, api: document.api, capabilities: declared, gameVersion: document.gameVersion };
}

/** True when `value` is a non-empty string that reads as a build id. */
function parsesGameVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Number(value));
}

/**
 * The community API as a catalogue source, gated on {@link verifyContract}.
 *
 * Reads `${baseUrl} + DEFAULT_REMOTE_PATHS[kind]` through a {@link RemoteJsonSource}, so the origin
 * pinning, the path resolution, the `{ plants: [...] }` unwrapping and the 304 handling are the existing
 * reader's rather than a second copy of them; the contract check is the only thing this class adds, and
 * it runs before the first `load` reaches the network.
 *
 * The origin must be an `https:` URL. That is {@link RemoteJsonSource}'s rule, kept rather than relaxed
 * here: the community API is read from a page as often as from Node, and a page cannot mix an `https:`
 * origin with an `http:` one.
 */
export class CommunityApiSource implements CatalogSource {
  readonly id: string;
  readonly capabilities: ReadonlySet<CatalogKind>;

  private readonly baseUrl: string;
  private readonly fetchOption: typeof fetch | undefined;
  private readonly requiredCapabilities: readonly string[];
  private readonly reader: RemoteJsonSource;
  private verified: CommunityApiContract | null;
  private inflight: Promise<CommunityApiContract> | null = null;

  constructor(options: CommunityApiSourceOptions = {}) {
    const baseUrl = options.baseUrl ?? DEFAULT_COMMUNITY_API_URL;
    if (baseUrl.replace(/\/+$/, '').length === 0) {
      throw new CommunityApiContractError(
        'CommunityApiSource: no base URL. DEFAULT_COMMUNITY_API_URL is unset, so this library has no ' +
          'community host to default to. Pass { baseUrl } for the instance you want to read.',
        {
          reason: 'no-base-url',
          baseUrl: '',
          found: null,
          required: 'a community API base URL',
        },
      );
    }

    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.id = `community-api:${this.baseUrl}`;
    // The contract check is what this class adds; the reader under it is the existing one, with the
    // injected fetch (if any) threaded through so that one seam covers both requests.
    this.reader = new RemoteJsonSource({
      baseUrl: this.baseUrl,
      fetchOptions: options.fetch ? { fetch: options.fetch } : {},
    });
    this.capabilities = this.reader.capabilities;
    this.fetchOption = options.fetch;
    this.requiredCapabilities = options.require ?? [];
    this.verified = options.contract ?? null;
  }

  /**
   * The contract this source verified against, or the one it was constructed with, or `null` before the
   * first `load`. Readable so a caller can report which host's contract it is actually using.
   */
  get contract(): CommunityApiContract | null {
    return this.verified;
  }

  /** Read one category, checking the host's contract first. */
  async load(kind: CatalogKind): Promise<unknown> {
    await this.ensureContract();
    const value = await this.reader.load(kind);
    // The version category is a string; the route states it in a body. See game-version.ts.
    return kind === 'version' ? gameVersionOf(value) : value;
  }

  /** Verify once, and share one in-flight check between concurrent callers. */
  private async ensureContract(): Promise<CommunityApiContract> {
    const known = this.verified;
    if (known !== null) return known;
    if (this.inflight === null) {
      this.inflight = verifyContract(this.baseUrl, {
        fetch: this.fetchOption,
        require: this.requiredCapabilities,
      })
        .then((contract) => {
          this.verified = contract;
          return contract;
        })
        .catch((error: unknown) => {
          // A refusal is not cached: a caller that fixes the host and calls again gets a real check.
          this.inflight = null;
          throw error;
        });
    }
    return this.inflight;
  }
}
