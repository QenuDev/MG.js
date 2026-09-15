/**
 * A hand-driven `SocketLike`, shared by the transport unit tests.
 *
 * `WebSocketFactory` is structurally typed, so a hand-written object satisfies it: every assertion can be
 * about bytes on the wire, with no I/O and no timers. Extracted from `transport-keepalive.test.ts` when a
 * second file (`transport-dispose.test.ts`) needed the same fixture.
 */

import assert from 'node:assert/strict';
import type {
  SocketCloseEventLike,
  SocketLike,
  SocketMessageEventLike,
} from '../../src/transport/runtime.js';
import { StandaloneTransport } from '../../src/transport/standalone.js';

/** A hand-driven socket: the test decides when `open`/`message`/`close` happen. */
export class FakeSocket implements SocketLike {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  /** Everything written by the transport, in order. */
  readonly sent: string[] = [];
  /** Close calls, in order. */
  readonly closes: Array<{ code: number | undefined; reason: string | undefined }> = [];
  /** Thrown by `send`, when set; used to prove the transport never lets it escape. */
  sendError: Error | null = null;
  /** Thrown by `close`, when set; used to prove teardown survives a socket that refuses to close. */
  closeError: Error | null = null;

  private readonly listeners = new Map<string, Set<(...args: never[]) => void>>();
  /** Arguments every constructor call in the test saw, for header assertions. */
  static readonly constructed: Array<{ url: string; options: Record<string, unknown> | undefined }> = [];

  constructor(url: string, _protocols?: unknown, options?: Record<string, unknown>) {
    FakeSocket.constructed.push({ url, options });
    FakeSocket.last = this;
  }

  static last: FakeSocket | null = null;

  send(data: string): void {
    if (this.sendError !== null) throw this.sendError;
    if (this.readyState !== FakeSocket.OPEN) throw new Error('not open');
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    // Recorded before the throw: a close that *threw* is still a close the transport asked for, and
    // teardown assertions care that the attempt happened.
    this.closes.push({ code, reason });
    if (this.closeError !== null) throw this.closeError;
    this.readyState = FakeSocket.CLOSED;
    // A real WebSocket answers `close()` with a close event; the fake does the same so the transport's
    // `wasManual` bookkeeping is exercised the way it is in production.
    this.closed({ code: code ?? 1005, reason: reason ?? '', wasClean: true });
  }

  /** Event types with a listener still attached, sorted, which is how teardown proves it detached. */
  listenerTypes(): string[] {
    return [...this.listeners.entries()]
      .filter(([, set]) => set.size > 0)
      .map(([type]) => type)
      .sort();
  }

  addEventListener(type: string, listener: (...args: never[]) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (...args: never[]) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** Fire a listener, mimicking an `EventTarget` dispatch. */
  emit(type: 'open' | 'message' | 'close' | 'error', event?: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      (listener as (arg?: unknown) => void)(event);
    }
  }

  /** Put the socket in the open state and announce it. */
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.emit('open');
  }

  /** Deliver one text frame. */
  message(data: string): void {
    const event: SocketMessageEventLike = { data };
    this.emit('message', event);
  }

  /** Deliver a close. */
  closed(event: SocketCloseEventLike): void {
    this.readyState = FakeSocket.CLOSED;
    this.emit('close', event);
  }
}

/** The structural constructor the transport needs. */
export const FakeFactory = FakeSocket as unknown as new (
  url: string,
  protocols?: readonly string[] | string,
  options?: Record<string, unknown>,
) => SocketLike;

/** Build a connected transport over a fresh fake socket. */
export async function connectedTransport(options: { headers?: Record<string, string> } = {}): Promise<{
  transport: StandaloneTransport;
  socket: FakeSocket;
}> {
  FakeSocket.constructed.length = 0;
  const transport = new StandaloneTransport({
    runtime: {
      kind: 'injected',
      factory: FakeFactory,
      supportsHeaders: true,
      description: 'fake socket',
    },
    ...(options.headers !== undefined ? { headers: options.headers as never } : {}),
  });
  const connecting = transport.connect('wss://example.test/version/1/api/rooms/r/connect');
  const socket = FakeSocket.last;
  assert.ok(socket, 'expected the factory to have been called');
  socket.open();
  await connecting;
  return { transport, socket };
}
