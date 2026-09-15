/**
 * Live end-to-end check against the real game host.
 *
 * Opt-in, like `verify-catalog.ts`, because it needs the internet and talks to a real server. Run it
 * by hand:
 *
 *     npm run verify:socket        (after a build; see the next paragraph)
 *
 * It imports `@mg.js/headless` by its **published name** rather than by a source path, so it also proves
 * the package's `exports` map actually resolves. That has been broken here before
 * (`./auth` pointed at a file with no auth providers). That means it needs `npm run build` first.
 *
 * Everything else in this repo verifies the wrapper against a mock server that *we* wrote, which can
 * only ever confirm that our implementation matches our own understanding. This script is the only
 * check that the understanding itself is right: it opens a real `wss://` connection to
 * `magicgarden.gg`, performs the documented handshake, and reports what the actual server does.
 *
 * It is gentle by design: one connection, a private room, anonymous (guest) auth, no gameplay
 * commands, and it disconnects as soon as it has what it needs. It never retries.
 *
 * ## What this actually found
 *
 * Everything up to the handshake is confirmed correct: the URL is accepted, the live version resolves,
 * every query value is JSON-encoded with strings quoted and numbers bare, and the guest auth parameter
 * is accepted.
 *
 * Then the server closes with **code 4840**, before sending a single frame. `4840` appears nowhere in
 * the protocol field guide, which lists 4250/4300/4400/4710/4800 and calls five more "undocumented",
 * but it *is* in the game's own client bundle, named:
 *
 *     e[e.SessionExpired=4840]=`SessionExpired`
 *
 * So a cold, session-less connection is rejected as `SessionExpired`. The HTTP layer accepts the
 * upgrade; the application layer requires a session that this process never established. Probing
 * confirmed the cause is none of the obvious candidates: it is identical with and without `Origin` and
 * User-Agent headers, with every room-slug shape tried (lowercase, uppercase, mixed, 4/6/10 chars, and
 * a real room taken from a live site redirect), with and without `anonymousUserStyle`, and with and
 * without sending the handshake at all. The site itself sets no cookies on a plain visit, so the session
 * is established through some path that neither document describes.
 *
 * This script therefore reports what the server does rather than asserting a success it cannot reach.
 *
 * ## Outcome classification and exit codes
 *
 * The verdict is decided by the *measured* close the transport reported and by whether a `Welcome`
 * arrived, never by "the client was not ready". That distinction matters: a DNS failure, a
 * TLS rejection, a wrong URL, the overall timeout, a 1006 abnormal drop and an unexpected close
 * code all leave `isReady === false`. A script that reads "not ready" as the documented outcome therefore
 * reports PASS for an outage. This one did that: it printed the 4840 line without ever checking
 * the code, because neither the error message nor `client.stopped` carries the number.
 *
 *   0  EXPECTED    (a) a `Welcome` arrived: the full documented flow works; or
 *                  (b) the server closed with 4840 `SessionExpired`: the transport, URL encoding,
 *                      version discovery and handshake are all exercised and correct, and the *session*
 *                      is what is missing.
 *   1  UNEXPECTED  the socket reached the server and then closed with any other code: a 4xxx that is not
 *                  4840, or a clean 1000. The server's behaviour differs from what this file documents.
 *                  A failed field check below is reported the same way.
 *   2  NO CONNECT  the socket never got there: DNS, TLS, handshake, the overall timeout, an abnormal
 *                  1006/1005 drop, or any exception. Never `PASS`.
 *   3  reserved for a usage/config error; this script takes no options, so nothing reaches it today.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuestAuthProvider, HeadlessClient } from '@mg.js/headless';
import { createLogger, MemoryLogSink } from '../packages/common/src/log.js';
import { CLOSE_CODE_LABELS, CloseCode } from '../packages/common/src/protocol/close-codes.js';

const OVERALL_TIMEOUT_MS = 45_000;

/**
 * Exit codes. The mapping is documented in the module header; 3 is reserved for a usage/config error.
 *
 * Distinct codes matter because a scheduled job has to separate "the documented refusal still happens"
 * from "the server changed" and from "the network is down" without parsing prose.
 */
export const EXIT_DOCUMENTED = 0;
export const EXIT_UNEXPECTED = 1;
export const EXIT_NO_CONNECT = 2;

/**
 * Close codes that mean the socket never became a conversation.
 *
 * 1006 is `ws`'s synthetic "closed abnormally": no close frame arrived at all. That is what a DNS
 * failure, a TLS rejection or a dropped handshake looks like by the time it reaches this script. 1005 is
 * the same situation with an explicit "no status received". Neither is an application-layer answer from
 * the game, so neither may be read as the documented 4840 outcome.
 */
const TRANSPORT_FAILURE_CODES: ReadonlySet<number> = new Set([1005, 1006]);

/** `4840 SessionExpired`, named from the game's own enum rather than repeated as a bare number. */
export function describeClose(code: number): string {
  const label = CLOSE_CODE_LABELS[code];
  return label === undefined ? `${code} (not in the game's enum)` : `${code} ${label}`;
}

/** What the live attempt measured. Serialisable, so every field can be printed or asserted on. */
export interface LiveObservations {
  /** True when the client was READY, and still ready, at the end of the keepalive window. */
  readonly ready: boolean;
  /** True when the WebSocket upgrade was accepted (`open` fired). */
  readonly opened: boolean;
  /** Milliseconds from process start to `open`, or null when it never opened. */
  readonly openedAtMs: number | null;
  /** The first close the *server* caused, with the time it took to arrive. */
  readonly close: {
    readonly code: number;
    readonly reason: string;
    readonly elapsedMs: number;
  } | null;
  /** The error that ended the attempt, as text, or null. */
  readonly error: string | null;
  /** True when the overall deadline expired. */
  readonly timedOut: boolean;
  /** Milliseconds from process start to classification. */
  readonly elapsedMs: number;
}

/** The classified outcome, the lines reporting it, and the exit code that follows from it. */
export interface LiveVerdict {
  readonly kind: 'ready' | 'session-expired' | 'unexpected-close' | 'no-connect';
  readonly exitCode: 0 | 1 | 2;
  /** One line per reportable fact, each naming the measured values it is about. */
  readonly lines: readonly string[];
}

/**
 * Classify a live attempt from what was measured. Pure, so every branch can be exercised without the
 * internet, which matters, because only one of these branches is reachable against the live server.
 *
 * Order matters. READY outranks everything: a real `Welcome` is the strongest evidence there is. A
 * measured 4840 close is the documented refusal. An abnormal transport drop, and "no close at all", are
 * failures to connect rather than answers from the application.
 */
export function classifyLiveObservations(observed: LiveObservations): LiveVerdict {
  if (observed.ready) {
    return {
      kind: 'ready',
      exitCode: EXIT_DOCUMENTED,
      lines: [
        'EXPECTED  a real Welcome arrived: the full documented flow works.',
        `            observed ready=true after ${observed.elapsedMs}ms ` +
          `(upgrade accepted at ${observed.openedAtMs ?? '-'}ms)`,
      ],
    };
  }

  if (observed.close !== null) {
    const { code, reason, elapsedMs } = observed.close;
    const measured = `observed code=${code} reason=${JSON.stringify(reason)} after ${elapsedMs}ms`;

    if (code === CloseCode.SessionExpired) {
      return {
        kind: 'session-expired',
        exitCode: EXIT_DOCUMENTED,
        lines: [
          `EXPECTED  server closed with ${describeClose(code)}: the documented cold, session-less refusal.`,
          `            ${measured}`,
          '            the transport, connect URL, version discovery, JSON encoding and handshake were all',
          '            exercised; the *session* is what is missing.',
        ],
      };
    }

    if (TRANSPORT_FAILURE_CODES.has(code)) {
      return {
        kind: 'no-connect',
        exitCode: EXIT_NO_CONNECT,
        lines: [
          `NO CONNECT  the socket dropped abnormally (${describeClose(code)}): it never became a`,
          '            conversation, so nothing about the server was verified.',
          `            ${measured}`,
        ],
      };
    }

    return {
      kind: 'unexpected-close',
      exitCode: EXIT_UNEXPECTED,
      lines: [
        `UNEXPECTED  server closed with ${describeClose(code)}, not ` +
          `${describeClose(CloseCode.SessionExpired)}.`,
        "            The server's behaviour differs from what this script documents.",
        `            ${measured}`,
      ],
    };
  }

  // No close frame arrived at all: the socket never opened, or the deadline beat it.
  return {
    kind: 'no-connect',
    exitCode: EXIT_NO_CONNECT,
    lines: [
      observed.timedOut
        ? `NO CONNECT  no close frame within ${observed.elapsedMs}ms: the overall deadline expired.`
        : 'NO CONNECT  the socket never reached the server, so nothing was verified.',
      `            observed opened=${observed.opened} elapsed=${observed.elapsedMs}ms ` +
        `error=${JSON.stringify(observed.error)}`,
    ],
  };
}

async function main(): Promise<void> {
  const sink = new MemoryLogSink(200);
  const logger = createLogger({ namespace: 'mg:live', level: 'debug', sink });

  const client = new HeadlessClient({
    logger,
    auth: new GuestAuthProvider({ name: 'mgjs-live-check' }),
    // A stale version is the documented 4710 cause, so let the client discover the live one.
    reconnect: { enabled: false },
  });

  let failures = 0;
  const report = (label: string, ok: boolean, detail: string): void => {
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(36)} ${detail}`);
  };

  const startedAt = Date.now();
  // The deadline carries its own sentinel error: `Promise.race` cannot say *which* promise rejected, and
  // "the overall timeout fired" has to stay distinguishable from a DNS or TLS failure in the report.
  const timeoutError = new Error(`Live check exceeded ${OVERALL_TIMEOUT_MS}ms`);
  // Kept so the deadline can be cleared once the race is over. `Promise.race` does not cancel the loser,
  // and an uncleared 45s timer holds the event loop open long after the verdict is decided: this script
  // took 45.5s to report a 1.4s observation. A gate that slow is a gate nobody runs.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let ready = false;
  let timedOut = false;
  let failure: string | null = null;

  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => reject(timeoutError), OVERALL_TIMEOUT_MS);
  });

  // The measured facts. `open`/`close` come straight off the transport, so the verdict below is decided
  // by what the server actually did rather than by which `await` happened to reject. `wasManual`
  // excludes this script's own teardown in the `finally`. Held in one mutable record because the values
  // are filled in by callbacks, which control-flow narrowing cannot see through.
  const measured: {
    opened: boolean;
    openedAtMs: number | null;
    close: LiveObservations['close'];
  } = { opened: false, openedAtMs: null, close: null };
  client.on('open', () => {
    measured.opened = true;
    measured.openedAtMs = Date.now() - startedAt;
  });
  client.on('close', (event) => {
    if (event.info.wasManual || measured.close !== null) return;
    measured.close = {
      code: event.info.code,
      reason: event.info.reason,
      elapsedMs: Date.now() - startedAt,
    };
  });

  console.log('Connecting to the real magicgarden.gg …\n');

  try {
    await Promise.race([client.start(), deadline]);

    const url = client.url;
    report('connect URL built', url.startsWith('wss://magicgarden.gg/'), url.replace(/\?.*$/, '?…'));
    report('version resolved live', client.version.length > 0, `version=${client.version}`);

    const parsed = new URL(url);
    report(
      'query values are JSON-encoded',
      parsed.searchParams.get('surface') === '"web"' &&
        parsed.searchParams.get('version') === `"${client.version}"`,
      `surface=${parsed.searchParams.get('surface')} version=${parsed.searchParams.get('version')}`,
    );
    report(
      'attempt counter is NOT quoted',
      parsed.searchParams.get('clientConnectionAttempt') === '1',
      `clientConnectionAttempt=${parsed.searchParams.get('clientConnectionAttempt')}`,
    );
    report(
      'guest auth is on the URL',
      parsed.searchParams.has('anonymousUserStyle'),
      `anonymousUserStyle present (${(parsed.searchParams.get('anonymousUserStyle') ?? '').slice(0, 40)}…)`,
    );

    await Promise.race([client.waitUntilReady(), deadline]);

    report('reached READY (a real Welcome arrived)', client.isReady, 'Welcome parsed');
    report(
      'selfPlayerId is server-assigned and p_-prefixed',
      typeof client.selfPlayerId === 'string' && client.selfPlayerId.startsWith('p_'),
      `selfPlayerId=${client.selfPlayerId}`,
    );

    const welcome = client.welcome;
    const sequence = welcome?.executedCommandSequence;
    report(
      'executedCommandSequence is present on Welcome',
      typeof sequence === 'number' && Number.isFinite(sequence),
      `executedCommandSequence=${String(sequence)}`,
    );
    report(
      'sequencer seeded to frontier + 1',
      // `stats.sequencer` never existed on `HeadlessClient.stats`, so this line used to read
      // `undefined !== undefined`, a check that could not fail. The seeded counter is the sequencer
      // itself (`lastIssued` is what the next command continues from), so that is what is read now.
      typeof sequence === 'number' && client.sequencer?.lastIssued === sequence,
      `lastIssued=${String(client.sequencer?.lastIssued ?? null)}, expected ${String(sequence)}`,
    );

    // The nesting claim the protocol doc makes, checked against real bytes.
    const room = client.room as Record<string, unknown> | undefined;
    const game = client.game as Record<string, unknown> | undefined;
    report(
      'room state is at fullState.data',
      room !== undefined && room !== null && typeof room === 'object',
      room ? `keys: ${Object.keys(room).slice(0, 6).join(', ')}` : 'absent',
    );
    report(
      'game state is at fullState.child.data',
      game !== undefined && game !== null && typeof game === 'object',
      game ? `keys: ${Object.keys(game).slice(0, 6).join(', ')}` : 'absent',
    );

    report(
      'state store received the snapshot',
      client.store.version > 0,
      `store version=${client.store.version}, patchCount=${client.store.stats.patchCount}`,
    );

    // Give the server a chance to send a keepalive and see whether the transport answered it.
    console.log('\nListening briefly for a server keepalive …');
    await new Promise((resolve) => setTimeout(resolve, 6000));
    report('survived the keepalive window', client.isReady, 'still ready, so pings were answered');
    // Read readiness here: the `finally` tears the client down, after which `isReady` is always false.
    ready = client.isReady;
  } catch (error) {
    timedOut = error === timeoutError;
    failure = error instanceof Error ? error.message : String(error);
    // The transport log is the only place the handshake's own view survives. Keep it for the outcomes
    // that need explaining, but not for the expected refusal, where it is 12 lines of noise.
    if (measured.close?.code !== CloseCode.SessionExpired) {
      console.error(`\nLive socket check ended with: ${failure}`);
      for (const record of sink.snapshot().slice(-12)) {
        console.error(`  [${record.level}] ${record.namespace}: ${record.message}`, record.fields ?? '');
      }
    }
  } finally {
    // The verdict is decided by the time we get here; drop the deadline so the process can exit instead of
    // waiting out the remaining ~40s of it. Clearing an already-fired timer is a no-op.
    //
    // Teardown does NOT happen here, on purpose. `disconnect()` awaits any pending reconnect backoff, and
    // some of its internal waits are `unref`'d, so a stall inside it lets the event loop drain and the
    // process exit *before* the verdict is printed, with exit code 0. A live gate that reports nothing and
    // exits green is worse than one that fails: it is indistinguishable from "everything verified". So the
    // verdict is printed first and the teardown is bounded and last.
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }

  const verdict = classifyLiveObservations({
    ready,
    opened: measured.opened,
    openedAtMs: measured.openedAtMs,
    close: measured.close,
    error: failure,
    timedOut,
    elapsedMs: Date.now() - startedAt,
  });

  console.log('');
  for (const line of verdict.lines) console.log(line);

  // A FAIL in the field checks means the contract this script documents did not hold locally, even when
  // the socket outcome was the expected one. Do not let a green verdict mask it.
  const exitCode = verdict.exitCode === EXIT_DOCUMENTED && failures > 0 ? EXIT_UNEXPECTED : verdict.exitCode;
  console.log(
    `\n${
      exitCode === EXIT_DOCUMENTED
        ? 'LIVE SOCKET CHECK PASSED (documented behaviour observed)'
        : `LIVE SOCKET CHECK FAILED (exit ${exitCode})`
    }`,
  );
  process.exitCode = exitCode;

  // Teardown last, and bounded. It cannot suppress the verdict above, and the bound means a stalled
  // `disconnect()` costs at most a second. The timer is intentionally NOT `unref`'d, so the event loop
  // stays alive long enough for the race to settle rather than exiting underneath it.
  await Promise.race([
    client.stop().catch(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, 1_000);
    }),
  ]);
}

// Only when executed as a script: importing this module from a test must not hit the live server.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('Fatal:', error);
    process.exitCode = EXIT_NO_CONNECT;
  });
}
