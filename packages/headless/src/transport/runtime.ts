/**
 * WebSocket acquisition for the standalone transport.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The headless client has exactly one hard runtime requirement: something that can open a `wss://`
 * socket. Node 22 ships a global `WebSocket` (undici's spec-compliant implementation) and this
 * package targets that, so the package has **zero runtime dependencies**. `ws` is a devDependency
 * used only by the test mock server.
 *
 * That is not the whole story, and pretending otherwise would break the authenticated path. The
 * protocol recon §3.3 says the connect handshake should carry:
 *
 *   > "a normal-looking `Origin` header (`https://<host>`) and a real desktop-Chrome `User-Agent`"
 *
 * and §3.1 says the Discord-account path authenticates with a `Cookie: mc_jwt=<token>` header.
 * **The WHATWG `WebSocket` API has no way to set request headers.** It is not a Node limitation that
 * a flag turns off, because the spec defines no header channel. Verified empirically on this box: passing
 * `new WebSocket(url, [], { headers: {...} })` does not throw (undici ignores the extra argument), and a
 * `ws` server on the other end receives no `origin`, no custom `user-agent`, and no `cookie`.
 *
 * So the runtime seam is shaped in two ways on purpose:
 *
 *   1. {@link WebSocketFactory} covers anything with the `ws`/undici constructor/event shape. This is where
 *      headers become possible: undici's global ignores them, the `ws` package honours them.
 *   2. An optional injected factory (`HeadlessClientOptions.webSocketFactory`), so a host that already
 *      depends on `ws` can get real headers without this package taking a dependency on it.
 *
 * {@link loadWebSocketAdapter} is the documented third option: a **dynamic import inside try/catch**
 * of the `ws` package, resolved at runtime only when the caller explicitly opts in via
 * `preferAdapter: true`. It is loosely typed on purpose, since a static `import 'ws'` would make `ws` a
 * hard runtime dependency and would break `tsc -b` for consumers who do not install it. That is
 * what the zero-dependency requirement forbids.
 *
 * The safe default is the global: the guest/anonymous path works with it, because everything that
 * path needs goes in the query string. Only the cookie path (and any server-side Origin check) is
 * degraded, and the caller is told so in a log record rather than left to guess.
 */

/**
 * The minimal socket surface this package uses.
 *
 * Structural rather than nominal, because the global `WebSocket` (DOM lib) and `ws`'s `WebSocket`
 * declare their own incompatible classes and neither is a supertype of the other. Every member here
 * exists on both, with the same meaning.
 */
export interface SocketLike {
  /** Standard `WebSocket.readyState` values: 0 connecting, 1 open, 2 closing, 3 closed. */
  readonly readyState: number;
  /** Complete the close handshake. Code/reason are optional per both implementations. */
  close(code?: number, reason?: string): void;
  /** Write one frame. Must never be called before `open` (both implementations throw). */
  send(data: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'close', listener: (event: SocketCloseEventLike) => void): void;
  addEventListener(type: 'message', listener: (event: SocketMessageEventLike) => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  removeEventListener(type: 'open', listener: () => void): void;
  removeEventListener(type: 'close', listener: (event: SocketCloseEventLike) => void): void;
  removeEventListener(type: 'message', listener: (event: SocketMessageEventLike) => void): void;
  removeEventListener(type: 'error', listener: (event: unknown) => void): void;
}

/** The subset of a `CloseEvent` this package reads. */
export interface SocketCloseEventLike {
  code?: number;
  reason?: string;
  wasClean?: boolean;
}

/** The subset of a `MessageEvent` this package reads. `ws` also emits bare strings here. */
export interface SocketMessageEventLike {
  data?: unknown;
}

/**
 * A WebSocket constructor this package can drive.
 *
 * `options.headers` is honoured by `ws` and ignored by the global; see the file header. It is typed
 * as `Record<string, unknown>` rather than the DOM's absent options bag so an injected Node
 * constructor is assignable without a cast at the call site.
 *
 * `protocols` is typed `never`: the third argument is passed positionally for the constructor's
 * benefit, and this package always passes `undefined` for the protocol (the Quinoa endpoint takes no
 * subprotocol). Saying so exactly is what keeps both the DOM global (declared `string[]`) and `ws`
 * (declared `string | string[]`) assignable. A `readonly string[]` would be rejected by both.
 */
export interface WebSocketFactory {
  new (url: string, protocols?: never, options?: Record<string, unknown>): SocketLike;
  /**
   * Optional, explicit statement of whether this constructor forwards an `options.headers` bag.
   *
   * There is no runtime feature test for this: the WHATWG API accepts a third constructor argument and
   * discards it, so "it did not throw" proves nothing. A host that injects a factory therefore gets to
   * declare its own posture. If it does not, the only case that can still be detected is the global
   * constructor, which is known to discard headers. Everything else is assumed capable and says so in
   * {@link WebSocketRuntime.description}.
   */
  supportsConnectHeaders?: boolean | undefined;
}

/** Where the socket came from, for logging and for honesty about header support. */
export type WebSocketRuntimeKind = 'injected' | 'node-ws-adapter' | 'global';

/** A resolved runtime: the constructor, its provenance, and whether headers will actually be sent. */
export interface WebSocketRuntime {
  kind: WebSocketRuntimeKind;
  factory: WebSocketFactory;
  /**
   * True only when this runtime forwards an `options.headers` bag.
   *
   * The global `WebSocket` returns `false` here even though it accepts a third constructor argument
   * without complaint, the argument is silently discarded, so treating acceptance as support would
   * report headers as applied when they are not.
   */
  supportsHeaders: boolean;
  /** Human-readable note for the connect log. */
  description: string;
}

/** Options for {@link acquireWebSocketRuntime}. */
export interface AcquireWebSocketOptions {
  /** An explicit constructor, which wins over everything else: the host knows its own runtime best. */
  factory?: WebSocketFactory | undefined;
  /**
   * Try `import('ws')` when no global exists.
   *
   * Only worth setting for a header-bearing connect on a runtime older than Node 22 (which has no
   * global `WebSocket`). Requires `ws` to be resolvable from the *consumer's* module graph.
   */
  preferAdapter?: boolean | undefined;
}

/** Thrown when no usable WebSocket implementation can be found. */
export class NoWebSocketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoWebSocketError';
  }
}

/** True when a value looks like a WebSocket constructor rather than an instance. */
function isConstructor(value: unknown): value is WebSocketFactory {
  return typeof value === 'function' && typeof (value as { prototype?: unknown }).prototype === 'object';
}

/**
 * The global WHATWG constructor, when this build has one.
 *
 * Captured so a caller that injects the global explicitly can be recognised: passing
 * `globalThis.WebSocket` as `webSocketFactory` is the natural mistake the docs invite ("pass
 * `import('ws').WebSocket`"), and it must not be mistaken for a header-capable adapter.
 */
function globalWebSocketConstructor(): WebSocketFactory | null {
  const candidate = (globalThis as { WebSocket?: unknown }).WebSocket;
  return isConstructor(candidate) ? candidate : null;
}

/**
 * Classify an injected factory's header capability.
 *
 * Three outcomes, in order of trustworthiness:
 *   1. The factory declares `supportsConnectHeaders`, which is believed in either direction.
 *   2. The factory *is* the global constructor, known to discard an `options.headers` bag, so `false`.
 *   3. Anything else is assumed capable, with the assumption stated in the description, because there is
 *      no feature test for a third-argument headers bag and refusing every undeclared adapter would
 *      break the documented `ws` path.
 *
 * The `description` strings below are runtime output rather than prose, and they use a colon as a
 * separator; leave those literals unchanged.
 */
function resolveInjectedFactory(factory: WebSocketFactory): WebSocketRuntime {
  const declared = factory.supportsConnectHeaders;
  if (declared === false) {
    return {
      kind: 'injected',
      factory,
      supportsHeaders: false,
      description:
        'injected WebSocket constructor: declared header-incapable (`supportsConnectHeaders: false`)',
    };
  }
  if (declared === true) {
    return {
      kind: 'injected',
      factory,
      supportsHeaders: true,
      description: 'injected WebSocket constructor: declared header-capable (`supportsConnectHeaders: true`)',
    };
  }
  if (factory === globalWebSocketConstructor()) {
    return {
      kind: 'injected',
      factory,
      supportsHeaders: false,
      description:
        'injected globalThis.WebSocket (WHATWG spec implementation): cannot set Origin, User-Agent or Cookie headers',
    };
  }
  return {
    kind: 'injected',
    factory,
    supportsHeaders: true,
    description:
      'injected WebSocket constructor: header support cannot be detected, so it is assumed to honour an `options.headers` bag (declare `supportsConnectHeaders` to remove the assumption)',
  };
}

/**
 * Pull a `WebSocket` constructor off a dynamically imported module.
 *
 * Both shapes are accepted:
 *   - Node's cjs-module-lexer resolves `import('ws')` as the CJS namespace `{ WebSocket, default, ... }`.
 *   - A hand-written adapter may export the constructor as `default`.
 *
 * Typed loosely (`unknown` in, guarded narrow out) because this path exists to avoid a
 * compile-time dependency on `ws`.
 */
function factoryFromModuleNamespace(namespace: unknown): WebSocketFactory | null {
  if (namespace === null || typeof namespace !== 'object') return null;
  const record = namespace as Record<string, unknown>;
  const candidate = record.WebSocket ?? record.default;
  return isConstructor(candidate) ? candidate : null;
}

/**
 * Resolve the best available WebSocket runtime.
 *
 * Order, and why:
 *   1. **injected**: the caller knows whether their runtime can send headers, so they win.
 *   2. **global**: the zero-dependency default; headers are silently impossible here.
 *   3. **`ws` adapter**: only when explicitly requested *and* the global is missing, so we never
 *      reach for an uninstalled optional peer on a machine that would have worked without it.
 *
 * The `ws` attempt is last-but-not-least rather than first because preferring it would make a
 * zero-dependency install fail at the exact moment it was working fine.
 */
export async function acquireWebSocketRuntime(
  options: AcquireWebSocketOptions = {},
): Promise<WebSocketRuntime> {
  if (options.factory) {
    return resolveInjectedFactory(options.factory);
  }

  const globalCtor = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (!options.preferAdapter && isConstructor(globalCtor)) {
    return {
      kind: 'global',
      factory: globalCtor,
      supportsHeaders: false,
      description:
        'globalThis.WebSocket (WHATWG spec implementation): cannot set Origin, User-Agent or Cookie headers',
    };
  }

  if (options.preferAdapter) {
    try {
      // This is not a static import, and not a string literal either.
      //
      // A static `import ... from 'ws'` would make `ws` a hard runtime dependency of this package,
      // which the zero-dependency requirement forbids, and `tsc -b` would fail with TS2307
      // for every consumer that does not install it. Routing the specifier through a variable keeps
      // TypeScript from resolving it at compile time, and that is the purpose of this path: it is
      // reached only when the caller explicitly asked for it at runtime.
      const specifier = 'ws';
      const namespace: unknown = await import(specifier);
      const factory = factoryFromModuleNamespace(namespace);
      if (factory) {
        return {
          kind: 'node-ws-adapter',
          factory,
          supportsHeaders: true,
          description: "dynamically imported 'ws' package: honours an `options.headers` bag",
        };
      }
    } catch {
      // Not installed, or not resolvable from here. Fall through and report the honest outcome.
    }
  }

  if (isConstructor(globalCtor)) {
    return {
      kind: 'global',
      factory: globalCtor,
      supportsHeaders: false,
      description:
        'globalThis.WebSocket (WHATWG spec implementation): cannot set Origin, User-Agent or Cookie headers',
    };
  }

  throw new NoWebSocketError(
    'No WebSocket implementation available. This Node build has no global WebSocket (Node >= 22 ' +
      'provides one); either upgrade Node, pass `webSocketFactory`, or pass ' +
      '`preferWebSocketAdapter: true` with the `ws` package installed.',
  );
}

/**
 * Decode a socket message payload into a string.
 *
 * Both implementations deliver text frames as a `string`, but the general spec type is
 * `string | ArrayBuffer | Buffer | Blob`, and a wrapper that assumes `string` will silently drop
 * frames on some runtimes (and crash the message handler on others). Decoding is best-effort and
 * synchronous. A `Blob` is impossible for a text frame in undici, which only produces one when
 * `binaryType` is `'blob'` *and* the frame is binary, so it yields `null` and is reported rather than
 * guessed at with an async read that would reorder frames.
 *
 * The Quinoa protocol is newline-free JSON text both ways (§1.2), so anything that is not decodable
 * text is not a protocol frame and is dropped by the caller.
 */
export function decodeSocketPayload(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  if (data !== null && typeof data === 'object' && 'data' in (data as Record<string, unknown>)) {
    // `ws` hands the listener a `MessageEvent`; undici hands a `MessageEvent` to addEventListener.
    return decodeSocketPayload((data as { data: unknown }).data);
  }
  return null;
}
