/**
 * Decisive live experiment. Does the guest path work with Android's exact encoding?
 *
 * `Ariedam64/mg-afk-android` builds the guest connect URL in
 * `app/src/main/java/com/mgafk/app/data/websocket/UrlBuilder.kt:79-105` like this:
 *
 *     val styleJson = buildJsonObject {
 *         put("color", ...); put("avatarBottom", ...); put("avatarMid", ...)
 *         put("avatarTop", ...); put("avatarExpression", ...); put("name", ...)
 *     }.toString()
 *     builder.appendQueryParameter("anonymousUserStyle", styleJson)   // <-- RAW JSON
 *
 * Note `styleJson`, NOT `"$styleJson"`. Every OTHER string parameter in that file is explicitly
 * wrapped in quotes at the call site (`SURFACE = "\"web\""`, `"\"$version\""`), so the absence of
 * quoting here is intentional.
 *
 * Our implementation wrapped it in `JSON.stringify`, producing a *JSON-encoded string*, that is, an extra
 * layer of quotes, and sent only `{name}`. That is the single difference left between our guest URL and
 * a working client's, so this probe tests the encoding directly, holding every other parameter constant.
 *
 * ## Outcome classification and exit codes
 *
 * This script used to exit 0 unconditionally, which made the one result it exists to catch, an encoding
 * that is *accepted*, indistinguishable from the documented rejection. Each attempt is now classified
 * from what was measured (`open`, `Welcome`, close code, error) and the script exits non-zero unless
 * every encoding was refused with 4840 `SessionExpired`:
 *
 *   0  EXPECTED    every encoding was refused with 4840 `SessionExpired`: the documented cold,
 *                  session-less rejection.
 *   1  FINDING     at least one encoding was accepted (a `Welcome` arrived, or the socket stayed open
 *                  past the attempt window), or closed with a code that is not 4840. The server's
 *                  behaviour differs from what this file documents. A finding outranks an unmeasurable
 *                  attempt, because it is the more important signal.
 *   2  NO CONNECT  at least one encoding never reached the server (DNS, TLS, handshake, the attempt
 *                  timeout, an abnormal 1006/1005 drop, or an error), so the result is incomplete.
 *                  Also used when the live version itself cannot be resolved.
 *   3  reserved for a usage/config error; this script takes no options, so nothing reaches it today.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

import { CLOSE_CODE_LABELS, CloseCode } from '../packages/common/src/protocol/close-codes.js';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** How long one attempt may stay open before "still connected" counts as an accepted encoding. */
const ATTEMPT_TIMEOUT_MS = 15_000;

/**
 * Exit codes. The mapping is documented in the module header; 3 is reserved for a usage/config error.
 *
 * Distinct codes matter because a scheduled job has to separate "the documented refusal still happens"
 * from "anonymous access came back" and from "the network is down" without parsing prose.
 */
export const EXIT_DOCUMENTED = 0;
export const EXIT_FINDING = 1;
export const EXIT_NO_CONNECT = 2;

/**
 * Close codes that mean the socket never became a conversation.
 *
 * 1006 is `ws`'s synthetic "closed abnormally": no close frame arrived at all. That is what a DNS
 * failure, a TLS rejection or a dropped handshake looks like by the time it reaches this probe. 1005 is
 * the same situation with an explicit "no status received". Neither is an application-layer answer from
 * the game, so neither may be read as the documented 4840 rejection.
 */
const TRANSPORT_FAILURE_CODES: ReadonlySet<number> = new Set([1005, 1006]);

/** Android's `BotAvatar` defaults, used verbatim so nothing about the payload is our invention. */
const STYLE = {
  color: '#4CAF50',
  avatarBottom: 'default',
  avatarMid: 'default',
  avatarTop: 'default',
  avatarExpression: 'happy',
  name: 'mgjs probe',
};

function build(version: string, room: string, styleValue: string | null): string {
  const documentId = crypto.randomUUID();
  const params: [string, string][] = [
    ['surface', '"web"'],
    ['platform', '"desktop"'],
    ['version', `"${version}"`],
  ];
  if (styleValue !== null) params.push(['anonymousUserStyle', styleValue]);
  params.push(
    ['capabilities', '"fbo_mipmap_unsupported"'],
    ['locale', '"en"'],
    ['clientDocumentId', `"${documentId}"`],
    ['clientConnectionAttempt', '1'],
    ['clientNavigationType', '"navigate"'],
    ['clientVisibilityState', '"visible"'],
  );
  const query = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `wss://magicgarden.gg/version/${version}/api/rooms/${room}/connect?${query}`;
}

function slug(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 10; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/** `4840 SessionExpired`, named from the game's own enum rather than repeated as a bare number. */
export function describeClose(code: number): string {
  const label = CLOSE_CODE_LABELS[code];
  return label === undefined ? `${code} (not in the game's enum)` : `${code} ${label}`;
}

/** What one encoding's attempt measured. Serialisable, so every field can be printed or asserted on. */
export interface AttemptMeasurement {
  /** The encoding under test, as printed in the result line. */
  readonly label: string;
  readonly opened: boolean;
  readonly welcomed: boolean;
  /** The close code, or null when the attempt ended on a timeout or a socket error. */
  readonly code: number | null;
  /** The close reason the server sent, when it sent one. */
  readonly reason: string;
  /** The socket error, when the attempt ended on one. */
  readonly error: string | null;
  /** Milliseconds from the start of the attempt to its end. */
  readonly elapsedMs: number;
  readonly firstFrame: string | null;
}

/** What one attempt proved. */
export type EncodingOutcome = 'session-expired' | 'accepted' | 'unexpected-close' | 'connect-failure';

/** Short, printable text for each outcome. The 4840 one is built from the constant, not retyped. */
const OUTCOME_TEXT: Readonly<Record<EncodingOutcome, string>> = {
  'session-expired': `${CloseCode.SessionExpired} rejected (expected)`,
  accepted: 'ACCEPTED: finding',
  'unexpected-close': 'unexpected close: finding',
  'connect-failure': 'could not connect',
};

/**
 * Classify one attempt from what was measured. Pure, so every branch can be exercised without the
 * internet, which matters, because only the rejection branch is reachable against the live server.
 *
 * A `Welcome` outranks everything: it is the definitive evidence that the guest path worked, whatever
 * happens to the socket afterwards. A socket that opened and was still open when the attempt window
 * expired is the same finding by a different route. Only then does the close code decide.
 */
export function classifyEncodingAttempt(measured: AttemptMeasurement): EncodingOutcome {
  if (measured.welcomed) return 'accepted';
  if (measured.code === null) {
    return measured.opened && measured.error === null ? 'accepted' : 'connect-failure';
  }
  if (measured.code === CloseCode.SessionExpired) return 'session-expired';
  if (TRANSPORT_FAILURE_CODES.has(measured.code)) return 'connect-failure';
  return 'unexpected-close';
}

/** The overall result: the exit code, the findings, the unmeasurable attempts, and one summary line. */
export interface ProbeVerdict {
  readonly exitCode: 0 | 1 | 2;
  /** One line per encoding whose result is a finding, naming the encoding and what it did. */
  readonly findings: readonly string[];
  /** One line per encoding that could not be measured at all. */
  readonly failures: readonly string[];
  /** The single line that states the overall result. */
  readonly summary: string;
}

/**
 * Aggregate the attempts into a verdict.
 *
 * Priority is intentional: a finding outranks a failure to connect. "Anonymous access came back" is the
 * event this probe exists to detect, and it must not be hidden by one room slug that failed to resolve.
 */
export function classifyProbe(results: readonly AttemptMeasurement[]): ProbeVerdict {
  const classified = results.map((measurement) => ({
    measurement,
    outcome: classifyEncodingAttempt(measurement),
  }));
  const describe = ({ measurement, outcome }: (typeof classified)[number]): string =>
    `${measurement.label} → close=${measurement.code ?? '-'} ` +
    `reason=${JSON.stringify(measurement.reason)} ${measurement.elapsedMs}ms (${OUTCOME_TEXT[outcome]})`;

  const findings = classified.filter(
    ({ outcome }) => outcome === 'accepted' || outcome === 'unexpected-close',
  );
  const failures = classified.filter(({ outcome }) => outcome === 'connect-failure');
  const refused = classified.filter(({ outcome }) => outcome === 'session-expired');

  if (findings.length > 0) {
    return {
      exitCode: EXIT_FINDING,
      findings: findings.map(describe),
      failures: failures.map(describe),
      summary:
        `FINDING  ${findings.length} of ${results.length} encoding(s) were NOT refused with ` +
        `${describeClose(CloseCode.SessionExpired)}. An unauthenticated connection was not rejected, so ` +
        "the server's behaviour differs from what this script documents.",
    };
  }
  if (failures.length > 0) {
    return {
      exitCode: EXIT_NO_CONNECT,
      findings: [],
      failures: failures.map(describe),
      summary:
        `NO CONNECT  ${failures.length} of ${results.length} encoding(s) never reached the server, so ` +
        `${refused.length} measured rejection(s) is not a complete result. Nothing was proven.`,
    };
  }
  return {
    exitCode: EXIT_DOCUMENTED,
    findings: [],
    failures: [],
    summary:
      `EXPECTED  all ${results.length} encodings were refused with ` +
      `${describeClose(CloseCode.SessionExpired)}. The guest path rejects an unauthenticated ` +
      'connection, so a real `mc_jwt` from the browser OAuth flow is required.',
  };
}

function attempt(label: string, url: string): Promise<AttemptMeasurement> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let opened = false;
    let welcomed = false;
    let firstFrame: string | null = null;
    let settled = false;
    const ws = new WebSocket(url, { headers: { 'User-Agent': UA, Origin: 'https://magicgarden.gg' } });
    const timer = setTimeout(() => finish(null, '', null), ATTEMPT_TIMEOUT_MS);

    function finish(code: number | null, reason: string, error: string | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      const measurement: AttemptMeasurement = {
        label,
        opened,
        welcomed,
        code,
        reason,
        error,
        elapsedMs: Date.now() - startedAt,
        firstFrame,
      };
      // Print the measured values, not just a verdict: a reader has to be able to see *what* was
      // observed, meaning the encoding, the close code, the reason and the elapsed time, without
      // reading this source.
      console.log(
        `${label.padEnd(34)} open=${opened ? 'Y' : 'n'} welcome=${welcomed ? 'Y' : 'n'} ` +
          `close=${code ?? '-'} reason=${JSON.stringify(reason)} ${measurement.elapsedMs}ms ` +
          `outcome=${OUTCOME_TEXT[classifyEncodingAttempt(measurement)]}` +
          (firstFrame ? ` first=${firstFrame.slice(0, 64)}` : ''),
      );
      resolve(measurement);
    }

    ws.on('open', () => {
      opened = true;
      ws.send(JSON.stringify({ scopePath: ['Room'], type: 'VoteForGame', gameName: 'Quinoa' }));
      ws.send(JSON.stringify({ scopePath: ['Room'], type: 'SetSelectedGame', gameName: 'Quinoa' }));
    });
    ws.on('message', (data: WebSocket.RawData) => {
      const text = data.toString();
      firstFrame ??= text;
      if (text.includes('Welcome')) welcomed = true;
      if (text === 'ping' || text === '"ping"') ws.send('pong');
    });
    ws.on('close', (code: number, reason: Buffer) => finish(code, reason.toString(), null));
    ws.on('error', (error: Error) => finish(null, '', error.message));
  });
}

async function main(): Promise<void> {
  // Resolve the live version first. It is the only pre-flight step, and failing it means no connect URL
  // can be built at all, a "could not connect", not a finding about the guest path.
  let version: string;
  try {
    const payload = (await (await fetch('https://magicgarden.gg/platform/v1/version')).json()) as {
      version?: unknown;
    };
    if (typeof payload.version !== 'string' || payload.version.length === 0) {
      throw new Error(`no version string in the response: ${JSON.stringify(payload)}`);
    }
    version = payload.version;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`NO CONNECT  could not resolve the live version from magicgarden.gg: ${message}`);
    process.exitCode = EXIT_NO_CONNECT;
    return;
  }

  console.log(`Guest-encoding probe against live version ${version}\n`);

  const results: AttemptMeasurement[] = [];

  // A: what we currently send, JSON-encoded string, single field.
  results.push(
    await attempt(
      'A ours: JSON.stringify({name})',
      build(version, slug(), JSON.stringify({ name: STYLE.name })),
    ),
  );

  // B: Android's exact shape, raw JSON object, all six fields.
  results.push(await attempt('B android: raw JSON, 6 fields', build(version, slug(), JSON.stringify(STYLE))));

  // C: raw JSON, single field, isolates encoding from field count.
  results.push(
    await attempt('C raw JSON, 1 field', build(version, slug(), JSON.stringify({ name: STYLE.name }))),
  );

  // D: quoted JSON, all six fields, isolates field count from encoding.
  results.push(
    await attempt('D quoted JSON, 6 fields', build(version, slug(), JSON.stringify(JSON.stringify(STYLE)))),
  );

  // E: no style at all, the control.
  results.push(await attempt('E control: no anonymousUserStyle', build(version, slug(), null)));

  const verdict = classifyProbe(results);
  console.log(`\n${verdict.summary}`);
  for (const finding of verdict.findings) console.log(`  finding:          ${finding}`);
  for (const failure of verdict.failures) console.log(`  could not measure: ${failure}`);
  process.exitCode = verdict.exitCode;
}

// Only when executed as a script: importing this module from a test must not run the live probes.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('Fatal:', error);
    process.exitCode = EXIT_NO_CONNECT;
  });
}
