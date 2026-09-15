/**
 * Late `MagicCircle_RoomConnection` and the raw-socket → room-connection upgrade.
 *
 * ## The bug these tests exist for
 *
 * A live run reported the status badge showing:
 *
 *     attach kind : raw-socket
 *     sockets seen : 0
 *     room path rejected: the page does not expose MagicCircle_RoomConnection
 *
 * on a page that had been playing for minutes, with 2126 patch sets applied. The object was not "missing". It
 * is created **lazily**, by the game's own singleton accessor:
 *
 *     static getInstance(){ return window.MagicCircle_RoomConnection ||
 *       (window.MagicCircle_RoomConnection = new e), window.MagicCircle_RoomConnection }
 *
 * and the first `getInstance()` call comes from room subsystems the game builds *after* it joins (the avatar
 * manager, chat, and the shop announcers all name it in a field initializer or a default parameter). So it is
 * absent at `document-start` and present seconds later.
 *
 * `waitForAttachment` resolves on the first candidate whose kind is not `'none'`, and the raw-socket path
 * binds at `document-start` because it only needs `page.WebSocket`. The first attempt therefore always won
 * with the fallback and the preferred path was never probed again. The fix is not a longer wait, since that
 * would leave the mod dead for the first seconds, but a watch that promotes the live client when the object
 * finally appears.
 *
 * `detectAttachment`'s own behaviour is unchanged and still covered by `attach.test.ts`; what is new here is
 * everything *after* that first decision.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pollUntil } from '@mg.js/common';
import { watchForRoomConnection } from '../../src/attach/detect.ts';
import { bindRoomConnection } from '../../src/attach/room-connection.ts';
import { BootstrappedClient } from '../../src/client.ts';
import { installRealmOverride } from '../../src/page/override.ts';
import type { PageRealm } from '../../src/page/realm.ts';

// --------------------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------------------

/** A room connection with the documented send and observation paths. */
class UpgradeRoomConnection {
  sendMessageCalls: unknown[] = [];
  trySendCalls: unknown[] = [];
  isCommandSessionReady = true;
  lastDistributedRoomPublication: { executedCommandSequence?: unknown } | null = {
    executedCommandSequence: 3,
  };
  lastRoomStateJsonable: unknown = { data: {} };

  /**
   * The socket the real object writes through (`trySendMessageNow` → `sendOpenMessage` →
   * `devSendDelayLine` → `writeToSocket` → `currentWebSocket.send`).
   *
   * Modelled because it is the reason the socket is the renumbering seam: every path, including this one,
   * ends up in `send()`.
   */
  constructor(private readonly socket: { send(data: string): void } | null = null) {}

  sendMessage(payload: unknown): void {
    this.sendMessageCalls.push(payload);
    this.socket?.send(JSON.stringify(payload));
  }

  trySendMessageNow(payload: unknown): boolean {
    this.trySendCalls.push(payload);
    this.socket?.send(JSON.stringify(payload));
    return true;
  }

  subscribeToRoomFrames(_cb: (frame: unknown) => void): () => void {
    return () => undefined;
  }

  subscribeToWelcome(_cb: (state: unknown) => void): () => void {
    return () => undefined;
  }
}

/** An object shaped like a room connection but with no way to send, as an early partial build would be. */
function unusableConnection(): Record<string, unknown> {
  return { subscribeToRoomFrames: () => () => undefined };
}

/** A page whose socket class records what was sent, so socket counting is observable. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.OPEN;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  /** Test helper: deliver one inbound frame, as the server does. */
  deliver(data: string): void {
    for (const listener of [...(this.listeners.get('message') ?? [])]) listener({ data });
  }
}

/**
 * A deterministic timer queue.
 *
 * The poll is driven by hand rather than by real time so these tests assert *ordering* ("absent, absent, then
 * present") instead of racing a `setTimeout`.
 */
function makeScheduler() {
  const queue: Array<() => void> = [];
  return {
    schedule: (callback: () => void, _delayMs: number): unknown => {
      queue.push(callback);
      return queue.length;
    },
    cancelSchedule: (): void => {
      // Handles are positional; a cancelled tick is suppressed by the watcher's own flag.
    },
    /** Run one queued tick, if any. Returns whether one ran. */
    tick(): boolean {
      const next = queue.shift();
      if (next === undefined) return false;
      next();
      return true;
    },
    get pending(): number {
      return queue.length;
    },
  };
}

/**
 * Wait for a condition that is driven by real timers, naming it when the window closes.
 *
 * The description is the merge's one deliberate change to this helper: the copy it replaces threw
 * `'condition was not met in time'`, which named nothing, so a failure took a bisect to explain.
 */
async function waitUntil(predicate: () => boolean, description: string, timeoutMs = 3000): Promise<void> {
  const found = await pollUntil<true>({
    attempt: () => (predicate() ? true : null),
    timeoutMs,
    intervalMs: 5,
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  });
  if (found === null) assert.fail(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

void test('waitUntil names what it waited for when the window closes', async () => {
  // The chosen behaviour, pinned: a helper that gives up must say *what* never happened. The copy this
  // replaces threw `'condition was not met in time'`, so this assertion fails on it.
  await assert.rejects(
    () => waitUntil(() => false, 'the room upgrade to land', 0),
    /the room upgrade to land/,
  );
});

// --------------------------------------------------------------------------------------
// watchForRoomConnection
// --------------------------------------------------------------------------------------

void test('the watch fires when the room connection appears late, and not before', () => {
  // The page starts exactly as it does at `document-start`: no room connection at all.
  const page = {} as Record<string, unknown>;
  const scheduler = makeScheduler();
  const found: string[] = [];

  const stop = watchForRoomConnection((attachment) => found.push(attachment.kind), {
    page: page as unknown as PageRealm,
    timeoutMs: 60_000,
    intervalMs: 1,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });

  try {
    // Tick once while absent: the watch must *not* report anything. This is the behaviour the old code got
    // wrong by settling for the raw socket here and never looking again.
    assert.equal(scheduler.tick(), true);
    assert.deepEqual(found, []);
    assert.equal(scheduler.pending, 1, 'the watch must keep polling while the object is absent');

    // The game builds the singleton, seconds after document-start.
    page['MagicCircle_RoomConnection'] = new UpgradeRoomConnection();

    assert.equal(scheduler.tick(), true);
    assert.deepEqual(found, ['room-connection']);
  } finally {
    stop();
  }
});

void test('the watch keeps polling when the object is present but unusable', () => {
  const page = { MagicCircle_RoomConnection: unusableConnection() } as Record<string, unknown>;
  const scheduler = makeScheduler();
  const found: string[] = [];

  const stop = watchForRoomConnection((attachment) => found.push(attachment.kind), {
    page: page as unknown as PageRealm,
    timeoutMs: 60_000,
    intervalMs: 1,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });

  try {
    scheduler.tick();
    // Present but with no send path: attaching here would "succeed" and then fail every command, so the watch
    // must treat it as not-yet-ready rather than as the answer.
    assert.deepEqual(found, []);
    assert.equal(scheduler.pending, 1);

    page['MagicCircle_RoomConnection'] = new UpgradeRoomConnection();
    scheduler.tick();
    assert.deepEqual(found, ['room-connection']);
  } finally {
    stop();
  }
});

void test('cancelling the watch suppresses a callback that was already queued', () => {
  const page = {} as Record<string, unknown>;
  const scheduler = makeScheduler();
  const found: string[] = [];

  const stop = watchForRoomConnection((attachment) => found.push(attachment.kind), {
    page: page as unknown as PageRealm,
    timeoutMs: 60_000,
    intervalMs: 1,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });

  scheduler.tick();
  stop();

  // The object appears after teardown. Nothing may be bound, because the client that would own the binding is
  // gone. An upgrade landing after `uninstall()` would leak hooks with nobody left to release them.
  page['MagicCircle_RoomConnection'] = new UpgradeRoomConnection();
  scheduler.tick();
  assert.deepEqual(found, []);
});

void test('the watch reports a timeout once the window closes with no object', () => {
  const scheduler = makeScheduler();
  let timeouts = 0;

  const stop = watchForRoomConnection(() => assert.fail('must not report a connection'), {
    page: {} as PageRealm,
    timeoutMs: 0,
    intervalMs: 1,
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
    onTimeout: () => {
      timeouts += 1;
    },
  });

  try {
    scheduler.tick();
    assert.equal(timeouts, 1);
    // Timed out means finished: no further ticks may be queued.
    assert.equal(scheduler.pending, 0);
  } finally {
    stop();
  }
});

// --------------------------------------------------------------------------------------
// The live client upgrade
// --------------------------------------------------------------------------------------

/** Build a client over a fake page that has a socket class but no room connection yet. */
function makeClient(page: Record<string, unknown>): BootstrappedClient {
  return new BootstrappedClient({
    page: page as unknown as PageRealm,
    storage: { forceBackend: 'memory' },
    features: { render: false, catalog: false, jotai: false },
    roomUpgradeIntervalMs: 1,
    roomUpgradeTimeoutMs: 5000,
  });
}

void test('a live raw-socket client is promoted when the room connection appears', async () => {
  const page = { WebSocket: FakeWebSocket } as Record<string, unknown>;
  const restore = installRealmOverride({ page: page as unknown as PageRealm });
  const client = makeClient(page);

  try {
    const attachment = await client.waitForAttachment();
    assert.equal(attachment.kind, 'raw-socket');
    assert.match(
      String(attachment.report.roomConnectionRejected),
      /does not expose MagicCircle_RoomConnection/,
    );

    // The game joins and builds the singleton.
    page['MagicCircle_RoomConnection'] = new UpgradeRoomConnection();
    await waitUntil(() => client.attachmentKind === 'room-connection', 'the room-connection upgrade');

    assert.equal(client.attachmentKind, 'room-connection', 'the client must end up on the documented path');
    assert.equal(client.attachmentReport?.['roomConnection']?.['present'], true);
    // The stale snapshot said "0 sockets seen" while frames were flowing; the getter refreshes it.
    assert.equal(client.attachmentReport?.['socketsSeen'], 0, 'no socket was constructed in this test');
  } finally {
    await client.stop();
    restore();
  }
});

void test('the upgrade leaves exactly one renumbering seam, and it is the socket', async () => {
  const page = { WebSocket: FakeWebSocket } as Record<string, unknown>;
  const restore = installRealmOverride({ page: page as unknown as PageRealm });
  const client = makeClient(page);

  try {
    await client.waitForAttachment();

    // The game's own socket, opened through the constructor we wrapped. It must go through
    // `page.WebSocket` (the wrapper) rather than the bare class, or the per-instance `send` hook that the
    // renumbering depends on would never be installed.
    const socket = new (page['WebSocket'] as typeof FakeWebSocket)(
      'wss://magicgarden.gg/version/1158/api/rooms/r1/connect',
    );
    // A room object that forwards to that socket, exactly as the real one does
    // (`trySendMessageNow` → `writeToSocket` → `currentWebSocket.send`).
    const connection = new UpgradeRoomConnection(socket);
    page['MagicCircle_RoomConnection'] = connection;
    await waitUntil(() => client.attachmentKind === 'room-connection', 'the room-connection upgrade');

    // Observation is on the room object now.
    assert.equal(client.attachmentKind, 'room-connection');

    // Take ownership of the counter, as a mod does on its first send. Before this the renumberer only
    // *observes* foreign frames, and a rewrite that consumes no number cannot reveal a double rewrite.
    client.renumberer.claimNext();

    const before = client.renumberer.peekNext();
    connection.trySendMessageNow({
      scopePath: ['Room', 'Quinoa'],
      type: 'QuinoaCommand',
      requestId: 'foreign-1',
      commandSequence: 1,
      command: { type: 'Ping' },
    });
    const after = client.renumberer.peekNext();

    // One seam, so one number. Two rewriters (the room object's and the socket's) would consume two for a
    // single command, leaving a gap the server answers with `invalid_sequence`, which poisons every later
    // command, and that failure mode is the "connection looks frozen" report.
    assert.equal(connection.trySendCalls.length, 1);
    assert.equal(after - before, 1, 'one command must consume exactly one sequence number');

    // And the numbering really happened at the socket. A frame the game routes through
    // the room object is still numbered, and so is one it writes straight to the socket.
    assert.equal(socket.sent.length, 1, 'the command must reach the socket');
    const wire = JSON.parse(socket.sent[0] ?? '{}') as { commandSequence?: number };
    assert.equal(wire.commandSequence, before, 'the socket renumbered it to the next value');

    // A frame written straight to the socket is numbered too, even though it bypasses the room object
    // entirely. AriesMod's comment describes the game doing this. This is the property that made keeping
    // the socket hook worth it rather than handing the seam to the object.
    const secondBefore = client.renumberer.peekNext();
    socket.send(
      JSON.stringify({
        scopePath: ['Room', 'Quinoa'],
        type: 'QuinoaCommand',
        requestId: 'foreign-2',
        commandSequence: 1,
        command: { type: 'Ping' },
      }),
    );
    const bypassed = JSON.parse(socket.sent[1] ?? '{}') as { commandSequence?: number };
    assert.equal(
      client.renumberer.peekNext() - secondBefore,
      1,
      'a socket-level write must still be numbered, because the game may not route it through the room object',
    );
    assert.equal(bypassed.commandSequence, secondBefore);
  } finally {
    await client.stop();
    restore();
  }
});

/** A room object that has no `Welcome` to give, but does publish full state through patches. */
class NoWelcomeRoomConnection {
  isCommandSessionReady = true;
  lastDistributedRoomPublication: { executedCommandSequence?: unknown } | null = {
    executedCommandSequence: 5,
  };
  /** Absent, like the build the badge was reporting on. */
  lastRoomStateJsonable: unknown = undefined;
  private patchHandlers = new Set<(patches: unknown, fullState: unknown) => void>();

  constructor(private readonly fullState: unknown) {}

  sendMessage(): void {
    // Nothing needs to go out in this test.
  }

  trySendMessageNow(): boolean {
    return true;
  }

  subscribeToPatches(cb: (patches: unknown, fullState: unknown) => void): () => void {
    this.patchHandlers.add(cb);
    return () => this.patchHandlers.delete(cb);
  }

  /** Test helper: deliver a patch batch with its full state, as the game does. */
  emitPatches(patches: unknown[] = []): void {
    for (const handler of [...this.patchHandlers]) handler(patches, this.fullState);
  }
}

/**
 * The same missed-`Welcome` object, with the one extra capability the latch tests need: a real `Welcome` that
 * can still arrive later in the session (a reconnect, or a build that publishes patches before its welcome).
 */
class ReFiringWelcomeRoomConnection extends NoWelcomeRoomConnection {
  private readonly welcomeHandlers = new Set<
    (state: unknown, publishedAtServerMs?: number, executedCommandSequence?: number) => void
  >();

  subscribeToWelcome(
    cb: (state: unknown, publishedAtServerMs?: number, executedCommandSequence?: number) => void,
  ): () => void {
    this.welcomeHandlers.add(cb);
    return () => this.welcomeHandlers.delete(cb);
  }

  /** Test helper: publish a real `Welcome`, as a build that re-fires one does. */
  emitWelcome(state: unknown, executedCommandSequence?: number): void {
    for (const handler of [...this.welcomeHandlers]) handler(state, 0, executedCommandSequence);
  }
}

void test('a missed Welcome does not leave the client un-ready', async () => {
  // The live symptom this reproduces: `ready: false` with `433 patches applied` and `0 failed`. Frames were
  // arriving in bulk while the client sat un-ready, because `Welcome` had fired before the binding existed,
  // the game did not re-fire for the late subscriber, and this build exposed no `lastRoomStateJsonable`.
  //
  // The state carries **no** `selfPlayerId`, because the real one does not: the game's `Welcome`
  // handler reads it off the message (`t(g, e.selfPlayerId)`) and publishes only
  // `cloneForDistribution(e.fullState)` to subscribers, so the state is the wrong place to look.
  const page = {} as Record<string, unknown>;
  const restore = installRealmOverride({ page: page as unknown as PageRealm });
  const client = makeClient(page);

  try {
    const connection = new NoWelcomeRoomConnection({ data: {}, child: { data: {} } });
    page['MagicCircle_RoomConnection'] = connection;

    const attachment = await client.waitForAttachment();
    assert.equal(attachment.kind, 'room-connection');
    assert.equal(connection.lastRoomStateJsonable, undefined);

    // Nothing has been published yet, so the client is honestly not ready.
    assert.equal(client.isReady, false);

    // The first state update is enough: `subscribeToPatches` carries the full state, which is the one thing
    // a `Welcome` was needed for.
    connection.emitPatches([{ op: 'replace', path: '/data/weatherId', value: null }]);

    assert.equal(client.isReady, true, 'state arriving is what makes a session ready');
    assert.equal(
      client.selfPlayerId,
      null,
      'ready does not imply identified: this page has no socket seam to scrape the id from',
    );
  } finally {
    await client.stop();
    restore();
  }
});

void test('a restarted client owns a live core, so it can become ready again', async () => {
  // The defect: `stop()` stops the core, and `ClientCore.stop()` is one-way (it detaches the transport
  // subscription made in the constructor, and `start()` refuses). The client kept that same core, so a
  // second `start()` re-attached to the page but no frame could ever reach a ready session again.
  const page = {} as Record<string, unknown>;
  const restore = installRealmOverride({ page: page as unknown as PageRealm });
  const client = makeClient(page);

  try {
    const connection = new NoWelcomeRoomConnection({ data: {}, child: { data: {} } });
    page['MagicCircle_RoomConnection'] = connection;

    const first = await client.waitForAttachment();
    assert.equal(first.kind, 'room-connection');
    connection.emitPatches([{ op: 'replace', path: '/data/weatherId', value: null }]);
    assert.equal(client.isReady, true, 'the first session became ready');

    await client.stop();
    assert.equal(client.isReady, false);

    await client.start();
    const second = await client.waitForAttachment();
    assert.equal(second.kind, 'room-connection', 'the second start() re-attached to the page');
    connection.emitPatches([{ op: 'replace', path: '/data/weatherId', value: 'sunny' }]);
    assert.equal(
      client.isReady,
      true,
      'a restarted client must own a live core, not the stopped one it was built with',
    );
  } finally {
    await client.stop();
    restore();
  }
});

void test('a stand-in Welcome is latched: two patch frames start one session, not two', async () => {
  // The stand-in exists so a missed `Welcome` still makes the session ready (see above). What it must not do
  // is fire per frame. Every delivery is consumed downstream as a session start, and a session start calls
  // `CommandSequencer.seed()`, which re-points the counter at the frontier *and* clears the outstanding
  // ledger, so a command claimed between two patch frames is renumbered out from under itself, and its
  // ledger entry vanishes while the command is still in flight.
  const page = {} as Record<string, unknown>;
  const restore = installRealmOverride({ page: page as unknown as PageRealm });
  const client = makeClient(page);

  try {
    const connection = new NoWelcomeRoomConnection({ data: {}, child: { data: {} } });
    page['MagicCircle_RoomConnection'] = connection;
    const attachment = await client.waitForAttachment();
    assert.equal(attachment.kind, 'room-connection');

    const welcomes: unknown[] = [];
    client.core.on('welcome', (message) => welcomes.push(message));

    connection.emitPatches([{ op: 'replace', path: '/data/weatherId', value: null }]);
    assert.equal(client.isReady, true, 'state arriving is still what makes the session ready');
    assert.equal(welcomes.length, 1, 'the missed Welcome is stood in for exactly once');

    // A command that goes out between two frames. The observable counter matters here: `seed()` renumbers it.
    const sequenceBeforeTake = client.core.sequencer.peek();
    client.core.sequencer.take('harvest', 'req-1');
    const sequenceAfterTake = client.core.sequencer.peek();
    assert.equal(sequenceAfterTake, sequenceBeforeTake + 1, 'the claimed command took the next number');

    connection.emitPatches([{ op: 'replace', path: '/data/weatherId', value: 'sunny' }]);

    assert.equal(
      client.core.sequencer.peek(),
      sequenceAfterTake,
      'a second patch frame is not a session start, so it must not renumber the counter',
    );
    assert.deepEqual(
      client.core.sequencer.pending.map((entry) => entry.sequence),
      [sequenceBeforeTake],
      'the outstanding command is still on the ledger after the second frame',
    );
    assert.equal(welcomes.length, 1, 'one session means one welcome event');
  } finally {
    await client.stop();
    restore();
  }
});

void test('a real Welcome is still delivered, and an earlier stand-in does not swallow it', () => {
  const connection = new ReFiringWelcomeRoomConnection({ data: {}, child: { data: {} } });
  const binding = bindRoomConnection({
    page: { MagicCircle_RoomConnection: connection } as unknown as PageRealm,
    selfPlayerIdResolver: () => 'p_from_seam',
  });
  try {
    const seen: Array<{ id: string | null; sequence: number | null; state: unknown }> = [];
    binding
      .sink()
      .onWelcome((event) =>
        seen.push({ id: event.selfPlayerId, sequence: event.executedCommandSequence, state: event.state }),
      );

    connection.emitPatches([]);
    connection.emitPatches([]);
    assert.equal(seen.length, 1, 'the stand-in is once per session, not once per frame');
    assert.equal(seen[0]?.id, 'p_from_seam', 'the resolver still answers for the stand-in');

    // The real `Welcome` is authoritative: it is the one that carries the id off the message and the
    // server's own sequence, so an earlier stand-in must not suppress it. It is a session start, not a
    // stand-in, and it is delivered as one.
    const state = { selfPlayerId: 'p_42', data: {}, child: { data: {} } };
    connection.emitWelcome(state, 9);

    assert.equal(seen.length, 2, 'a real Welcome fires normally even after a stand-in');
    assert.deepEqual(seen[1], { id: 'p_42', sequence: 9, state });

    // And once a real one has been seen, no further stand-in is manufactured at all.
    connection.emitPatches([]);
    assert.equal(seen.length, 2);
  } finally {
    binding.release();
  }
});

void test('a subscriber that was replayed the stand-in is not given a second one by the frame path', () => {
  const connection = new ReFiringWelcomeRoomConnection({ data: {}, child: { data: {} } });
  // A build that *does* expose `lastRoomStateJsonable`, so the late-subscriber replay can answer before any
  // patch has arrived and the two stand-in paths overlap.
  connection.lastRoomStateJsonable = { data: {}, child: { data: {} } };
  const binding = bindRoomConnection({
    page: { MagicCircle_RoomConnection: connection } as unknown as PageRealm,
  });
  try {
    const replayed: number[] = [];
    const listening: number[] = [];
    binding.sink().onWelcome(() => listening.push(1));
    binding.subscribeToWelcome(() => replayed.push(1));
    assert.equal(replayed.length, 1, 'a late subscriber is replayed the state it missed');

    connection.emitPatches([]);

    assert.equal(replayed.length, 1, 'the replay was this session, so the frame path must not restate it');
    assert.equal(listening.length, 1, 'the frame path still announces the session to every other subscriber');
  } finally {
    binding.release();
  }
});

void test('an id in the state is believed over the injected resolver', () => {
  // Precedence, not the live path: the state is the authority *when a build puts the id in it*, since that is
  // the copy every other subscriber sees, while the resolver is reading it off the wire. The shipped build
  // puts it nowhere but the wire, so this only fixes the order of two fallbacks.
  const connection = new NoWelcomeRoomConnection({
    selfPlayerId: 'p_from_state',
    data: {},
    child: { data: {} },
  });
  const binding = bindRoomConnection({
    page: { MagicCircle_RoomConnection: connection } as unknown as PageRealm,
    selfPlayerIdResolver: () => 'p_from_seam',
  });
  try {
    const seen: Array<string | null> = [];
    binding.sink().onWelcome((event) => seen.push(event.selfPlayerId));
    connection.emitPatches([]);
    assert.deepEqual(seen, ['p_from_state'], 'the state wins when it carries the id');
  } finally {
    binding.release();
  }
});

void test('a forced attachment path is not second-guessed by the upgrade watch', async () => {
  const page = { WebSocket: FakeWebSocket } as Record<string, unknown>;
  const restore = installRealmOverride({ page: page as unknown as PageRealm });
  const client = new BootstrappedClient({
    page: page as unknown as PageRealm,
    storage: { forceBackend: 'memory' },
    features: { render: false, catalog: false, jotai: false },
    forceAttachment: 'raw-socket',
    roomUpgradeIntervalMs: 1,
  });

  try {
    const attachment = await client.waitForAttachment();
    assert.equal(attachment.kind, 'raw-socket');

    page['MagicCircle_RoomConnection'] = new UpgradeRoomConnection();
    // Give the watch every chance to fire if it were (wrongly) running.
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(client.attachmentKind, 'raw-socket', 'an explicit choice stays in force');
  } finally {
    await client.stop();
    restore();
  }
});

void test('attachmentReport refreshes socketsSeen from the live binding', async () => {
  const page = { WebSocket: FakeWebSocket } as Record<string, unknown>;
  const restore = installRealmOverride({ page: page as unknown as PageRealm });
  const client = new BootstrappedClient({
    page: page as unknown as PageRealm,
    storage: { forceBackend: 'memory' },
    features: { render: false, catalog: false, jotai: false },
    // No room connection will ever appear here, so the socket path stays and keeps its binding.
    roomUpgradeTimeoutMs: 0,
  });

  try {
    await client.waitForAttachment();
    // The report is built before the game opens its socket, so the stored value is 0.
    assert.equal(client.attachmentReport?.socketsSeen, 0);
    assert.equal(client.attachmentReport?.kind, 'raw-socket');

    // The game opens its room socket through the class we wrapped.
    void new (page['WebSocket'] as typeof FakeWebSocket)(
      'wss://magicgarden.gg/version/1158/api/rooms/r1/connect',
    );

    assert.equal(
      client.attachmentReport?.socketsSeen,
      1,
      'a diagnostic that reads zero while the counted event is happening is worse than no diagnostic',
    );
  } finally {
    await client.stop();
    restore();
  }
});

void test('selfPlayerId can come from an injected resolver when the state has no id', () => {
  // The shipped build's situation: the state tree carries no id. The client supplies a resolver that reads
  // what the socket seam scraped off the wire, and that is what makes `mg.js · ready · no id` resolvable.
  const connection = new NoWelcomeRoomConnection({ data: {}, child: { data: {} } });
  const binding = bindRoomConnection({
    page: { MagicCircle_RoomConnection: connection } as unknown as PageRealm,
    selfPlayerIdResolver: () => 'p_from_seam',
  });
  try {
    const seen: Array<string | null> = [];
    binding.sink().onWelcome((event) => seen.push(event.selfPlayerId));
    connection.emitPatches([]);
    assert.deepEqual(seen, ['p_from_seam'], 'the resolver is the source that answers here');
  } finally {
    binding.release();
  }
});

void test('the id is scraped off the socket, at read time, and survives the upgrade', async () => {
  // The fix that actually resolved `mg.js · ready · no id` on a live session. The id is not in the state tree
  // and the room object never hands it to a subscriber, but every inbound frame passes the socket seam's
  // scrape, and that seam is retained when the client is promoted to the room object, so the id keeps
  // answering afterwards. Resolving it once at welcome time is what missed it.
  const page = { WebSocket: FakeWebSocket } as Record<string, unknown>;
  const restore = installRealmOverride({ page: page as unknown as PageRealm });
  const client = makeClient(page);

  try {
    const attachment = await client.waitForAttachment();
    assert.equal(attachment.kind, 'raw-socket');
    assert.equal(client.selfPlayerId, null, 'nothing has been scraped yet');

    // The game opens its room socket through the class the binding replaced.
    const socket = new (page['WebSocket'] as typeof FakeWebSocket)(
      'wss://magicgarden.gg/version/1158/api/rooms/r1/connect',
    );
    // A `Welcome` as the server sends it: the id is on the message, and nowhere in the state tree.
    socket.deliver('{"selfPlayerId":"p_wire","executedCommandSequence":4}');

    assert.equal(client.selfPlayerId, 'p_wire', 'the frame is what makes the id knowable at all');

    // The game joins and builds the singleton, so the client promotes and the room object becomes the
    // observation path. The id must not be lost with the attachment that found it.
    page['MagicCircle_RoomConnection'] = new UpgradeRoomConnection(socket);
    await waitUntil(() => client.attachmentKind === 'room-connection', 'the room-connection upgrade');

    assert.equal(client.attachmentReport?.socketsSeen, 1, 'the seam that scraped it is still installed');
    assert.equal(client.selfPlayerId, 'p_wire', 'the retained seam keeps answering after the upgrade');
  } finally {
    await client.stop();
    restore();
  }
});
