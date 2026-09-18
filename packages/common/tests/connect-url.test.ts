/**
 * The connect URL, close codes and result codes.
 *
 * The URL test is the one that matters most: "Every value in the query string is JSON-encoded,
 * including plain strings, which arrive quoted (`"web"`, not `web`)". The doc adds that this mirrors
 * what the real client sends, string quoting included. Getting that wrong is the kind of thing that
 * produces a connection the server accepts but behaves oddly on, so it is asserted value by value.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { interpretRejection, parseResultCode, ResultCode } from '../src/actions/result-codes.js';
import { analyzeClose, CLOSE_CODE_LABELS, CloseCode } from '../src/protocol/close-codes.js';
import {
  buildConnectUrl,
  buildConnectUrlDetailed,
  DEFAULT_HOST,
  encodeQueryValue,
} from '../src/protocol/connect-url.js';

describe('encodeQueryValue', () => {
  it('JSON-encodes strings so they arrive quoted', () => {
    assert.equal(encodeQueryValue('web'), '"web"');
    assert.equal(encodeQueryValue('desktop'), '"desktop"');
  });

  it('does not quote numbers or booleans', () => {
    assert.equal(encodeQueryValue(1), '1');
    assert.equal(encodeQueryValue(true), 'true');
  });
});

describe('buildConnectUrl', () => {
  it('uses the documented URL template', () => {
    const url = buildConnectUrl({ version: '1157', room: 'abcde12345', documentId: 'doc-1' });
    assert.ok(
      url.startsWith('wss://magicgarden.gg/version/1157/api/rooms/abcde12345/connect?'),
      `unexpected prefix: ${url}`,
    );
  });

  it('quotes every string query value and leaves numeric ones bare', () => {
    const { url } = buildConnectUrlDetailed({
      version: '1157',
      room: 'r1',
      documentId: 'd1',
      connectionAttempt: 3,
    });
    const params = new URL(url).searchParams;

    // URLSearchParams stores the decoded value, so the quotes are visible here.
    assert.equal(params.get('surface'), '"web"');
    assert.equal(params.get('platform'), '"desktop"');
    assert.equal(params.get('version'), '"1157"');
    assert.equal(params.get('capabilities'), '"fbo_mipmap_unsupported"');
    assert.equal(params.get('locale'), '"en"');
    assert.equal(params.get('clientDocumentId'), '"d1"');
    assert.equal(params.get('clientNavigationType'), '"navigate"');
    assert.equal(params.get('clientVisibilityState'), '"visible"');

    // Not quoted, per the doc's own reference builder.
    assert.equal(params.get('clientConnectionAttempt'), '3');
  });

  it('percent-encodes the quotes on the wire', () => {
    // The doc's reference builder passes '"web"' through URLSearchParams, which escapes it.
    const { url } = buildConnectUrlDetailed({ version: '1', room: 'r', documentId: 'd' });
    assert.ok(url.includes('surface=%22web%22'), `expected %22 encoding in: ${url}`);
    assert.ok(!url.includes('surface="web"'), 'raw quotes must not appear in the serialised URL');
  });

  it('sends reclaimSupersededSession only when reclaiming', () => {
    const plain = new URL(buildConnectUrl({ version: '1', room: 'r', documentId: 'd' })).searchParams;
    assert.equal(plain.get('reclaimSupersededSession'), null);

    const reclaim = new URL(
      buildConnectUrl({ version: '1', room: 'r', documentId: 'd', reclaimSuperseded: true }),
    ).searchParams;
    assert.equal(reclaim.get('reclaimSupersededSession'), 'true');
  });

  it('never sends reclaimSupersededSession=false', () => {
    const { url } = buildConnectUrlDetailed({
      version: '1',
      room: 'r',
      documentId: 'd',
      reclaimSuperseded: false,
    });
    assert.ok(!url.includes('reclaimSupersededSession'));
  });

  it('uses reload for a retry and navigate for the first attempt', () => {
    const first = new URL(buildConnectUrl({ version: '1', room: 'r', documentId: 'd' })).searchParams;
    assert.equal(first.get('clientNavigationType'), '"navigate"');
    const retry = new URL(buildConnectUrl({ version: '1', room: 'r', documentId: 'd', isReload: true }))
      .searchParams;
    assert.equal(retry.get('clientNavigationType'), '"reload"');
  });

  it('defaults the host to magicgarden.gg and honours an override', () => {
    assert.equal(DEFAULT_HOST, 'magicgarden.gg');
    const custom = buildConnectUrl({ host: 'example.test', version: '1', room: 'r', documentId: 'd' });
    assert.ok(custom.startsWith('wss://example.test/version/1/'));
  });

  it('generates a room slug and document id when omitted, and reports them', () => {
    const built = buildConnectUrlDetailed({ version: '1' });
    assert.ok(built.room.length > 0);
    assert.ok(built.documentId.length > 0);
    assert.equal(built.connectionAttempt, 1);
    assert.ok(built.url.includes(`/api/rooms/${built.room}/connect`));
  });

  it('reports the values it chose so they can be reused across reconnect attempts', () => {
    // The document id and room must stay stable across reconnects, so the builder must not hide them.
    const first = buildConnectUrlDetailed({ version: '1' });
    const second = buildConnectUrlDetailed({
      version: '1',
      room: first.room,
      documentId: first.documentId,
      connectionAttempt: 2,
      isReload: true,
      reclaimSuperseded: true,
    });
    assert.ok(second.url.includes(`/api/rooms/${first.room}/connect`));
    const params = new URL(second.url).searchParams;
    assert.equal(params.get('clientDocumentId'), `"${first.documentId}"`);
    assert.equal(params.get('clientConnectionAttempt'), '2');
  });

  it('honours every overridable query value', () => {
    const { url } = buildConnectUrlDetailed({
      version: '1',
      room: 'r',
      documentId: 'd',
      surface: 'mobile',
      platform: 'android',
      capabilities: 'none',
      locale: 'fr',
      clientVisibilityState: 'hidden',
    });
    const params = new URL(url).searchParams;
    assert.equal(params.get('surface'), '"mobile"');
    assert.equal(params.get('platform'), '"android"');
    assert.equal(params.get('capabilities'), '"none"');
    assert.equal(params.get('locale'), '"fr"');
    assert.equal(params.get('clientVisibilityState'), '"hidden"');
  });
});

describe('hostile room and version values', () => {
  // `URL`'s own path handling tolerates `..`, `?`, `#` and empty segments, so an unencoded room name
  // rewrites the request shape: measured on the pre-fix tree, `../../evil` produced
  // `/version/1.0/evil/connect` (the `/api/rooms/` prefix gone), `a?x=1` moved `/connect` into the query
  // (`searchParams.get('x') === '1/connect'`) and `a#frag` put it in the fragment, where it is never sent.
  // Encoding protects the characters that have meaning *inside* a segment (`?`, `#`, space), which the
  // cases below cover. It cannot protect `.`/`..`, an empty value, or a `/`/`\`/NUL, because the server
  // decodes the path before routing, so those are refused instead, in the loops further down.
  for (const room of ['a?x=1', 'a#frag', 'a b']) {
    it(`keeps a hostile room name inside its path segment: ${JSON.stringify(room)}`, () => {
      const { url } = buildConnectUrlDetailed({ version: '1.0', room, documentId: 'd' });
      const parsed = new URL(url);

      assert.equal(parsed.pathname, `/version/1.0/api/rooms/${encodeURIComponent(room)}/connect`);
      assert.equal(parsed.hash, '', 'the room name must not introduce a fragment');
      assert.equal(parsed.searchParams.get('x'), null, 'the room name must not inject a query parameter');
    });
  }

  // `encodeURIComponent` leaves `.` alone, and `%2E%2E` still decodes to `..` on the server, so dot
  // segments (and separators, and NUL) are refused rather than encoded.
  for (const room of ['.', '..', '../evil', '../../evil', '//evil', 'a/b', 'a\\b', 'a\u0000b']) {
    it(`refuses a room that cannot stay one path segment: ${JSON.stringify(room)}`, () => {
      assert.throws(
        () => buildConnectUrlDetailed({ version: '1.0', room, documentId: 'd' }),
        /room must be a single path segment/,
      );
    });
  }

  for (const version of ['', '.', '..', '../../x', 'a/b']) {
    it(`refuses a version that cannot stay one path segment: ${JSON.stringify(version)}`, () => {
      assert.throws(
        () => buildConnectUrlDetailed({ version, room: 'r', documentId: 'd' }),
        /version must be a single path segment/,
      );
    });
  }

  it('leaves an ordinary room and version byte-identical', () => {
    // The live-host regression guard: the encoding must be a no-op for the slugs the real host issues.
    const { url } = buildConnectUrlDetailed({ version: '1157', room: 'abcde12345', documentId: 'doc-1' });

    assert.ok(
      url.startsWith('wss://magicgarden.gg/version/1157/api/rooms/abcde12345/connect?'),
      `unexpected prefix: ${url}`,
    );
    const params = new URL(url).searchParams;
    assert.equal(params.get('version'), '"1157"');
    assert.equal(params.get('clientDocumentId'), '"doc-1"');
    assert.equal(params.get('surface'), '"web"');
    assert.equal(params.get('clientConnectionAttempt'), '1');
  });

  it('keeps the whole ordinary URL byte-identical to the pre-guard output', () => {
    // The guard has to be a no-op down to the serialised bytes: this literal is the exact URL the builder
    // produced before the segment guard existed.
    const { url } = buildConnectUrlDetailed({ version: '1167', room: '7g8hvtucyl', documentId: 'd' });

    assert.equal(
      url,
      'wss://magicgarden.gg/version/1167/api/rooms/7g8hvtucyl/connect?surface=%22web%22&platform=%22desktop%22&version=%221167%22&capabilities=%22fbo_mipmap_unsupported%22&locale=%22en%22&clientDocumentId=%22d%22&clientConnectionAttempt=1&clientNavigationType=%22navigate%22&clientVisibilityState=%22visible%22',
    );
  });
});

describe("analyzeClose: the game's own close-code enum", () => {
  it('names every code in the bundle enum', () => {
    // Verified in magicgarden.gg/version/1206/assets/bootScreen-BN8P_Yml.js. The protocol field guide
    // catalogues only ten codes and calls five of them undocumented; the client's own enum has twenty —
    // the eighteen the 1192 capture had, and the two 1206 added: `AdmissionTimedOut` (the bare
    // `{"type":"SocketOpened"}` frame the client writes on open, which a silent socket is closed with once
    // the server's admission window runs out) and `ConnectionAttemptObsolete` (the `clientConnectionAttempt`
    // in the connect URL, answered to a stale attempt).
    const expected: Record<number, string> = {
      4100: 'ReconnectInitiated',
      4200: 'PlayerLeftVoluntarily',
      4250: 'UserSessionSuperseded',
      4300: 'ConnectionSuperseded',
      4310: 'ServerDisposed',
      4320: 'RoomTransitioning',
      4400: 'HeartbeatExpired',
      4410: 'AdmissionTimedOut',
      4420: 'ConnectionAttemptObsolete',
      4500: 'PlayerKicked',
      4700: 'VersionMismatch',
      4710: 'VersionExpired',
      4720: 'UserDataSchemaAhead',
      4721: 'UnreadableUserData',
      4800: 'AuthenticationFailure',
      4801: 'UnexpectedHandshakeError',
      4810: 'UserNotFound',
      4830: 'AuthenticatingExternalAccountRemoved',
      4840: 'SessionExpired',
      4900: 'Banned',
    };
    assert.equal(Object.keys(CLOSE_CODE_LABELS).length, 20);
    for (const [code, name] of Object.entries(expected)) {
      assert.equal(analyzeClose(Number(code)).label, name, `code ${code}`);
    }
  });

  it('stops on the terminal codes the documentation called reconnect-worthy', () => {
    // The guide said 4100/4200/4310/4500/4700 were "not otherwise documented" and to reconnect by
    // default. The bundle names them, and three of those five are terminal. Guessing wrong here means a
    // kicked or banned client sits in a reconnect loop forever.
    for (const [code, why] of [
      [4200, /left deliberately/],
      [4500, /kicked/],
      [4900, /banned/],
      [4720, /schema is ahead/],
      [4721, /could not be read/],
      [4830, /account .* removed|was removed/],
    ] as [number, RegExp][]) {
      const analysis = analyzeClose(code);
      assert.equal(analysis.shouldReconnect, false, `${code} must not reconnect`);
      assert.equal(analysis.disposition, 'stop', `${code} must be terminal`);
      assert.equal(analysis.isTerminal, true);
      assert.match(analysis.reason, why, `${code} reason`);
    }
  });

  it('refetches the version on BOTH version codes', () => {
    // 4700 VersionMismatch is a second version code the documented table conflates with the
    // "undocumented" bucket.
    for (const code of [4700, 4710]) {
      const analysis = analyzeClose(code);
      assert.equal(analysis.disposition, 'refetch-version', `${code}`);
      assert.equal(analysis.requiresVersionRefetch, true, `${code}`);
    }
  });

  it('renews the session on 4840 rather than merely reconnecting', () => {
    // This is the code a cold, session-less connection actually receives, verified live.
    const analysis = analyzeClose(4840);
    assert.equal(analysis.label, 'SessionExpired');
    assert.equal(analysis.disposition, 'renew-session');
    assert.equal(analysis.isBounded, true);
    assert.match(analysis.reason, /fresh session/);
  });

  it('reconnects normally on the four codes that want a new socket', () => {
    for (const code of [4100, 4310, 4320, 4400]) {
      const analysis = analyzeClose(code);
      assert.equal(analysis.disposition, 'reconnect', `${code}`);
      assert.equal(analysis.shouldReconnect, true, `${code}`);
      assert.equal(analysis.isTerminal, false, `${code}`);
    }
  });

  it('stops on a manual close regardless of code', () => {
    const analysis = analyzeClose(4710, '', true);
    assert.equal(analysis.shouldReconnect, false);
    assert.equal(analysis.disposition, 'stop');
  });

  it('stops on a normal closure that we did not initiate', () => {
    assert.equal(analyzeClose(CloseCode.Normal).disposition, 'stop');
  });

  it('refuses to reconnect a real supersede until a person confirms it', () => {
    // The game's developers asked for this explicitly: reconnecting a superseded session automatically "is
    // unsafe, and can result in data loss", and as of v473+ it is "only safe to do so with explicit
    // confirmation from the player". A client that quietly reclaimed the session here would be the mod they
    // were warning about.
    for (const code of [4250, 4300]) {
      const analysis = analyzeClose(code, 'newer user session');
      assert.equal(analysis.disposition, 'reconnect-confirm', `${code}`);
      assert.equal(analysis.shouldReconnect, false, `${code}`);
      assert.equal(analysis.requiresConfirmation, true, `${code}`);
      assert.equal(analysis.isSuperseded, true, `${code}`);
      // Not terminal: this is recoverable, just not by the client alone.
      assert.equal(analysis.isTerminal, false, `${code}`);
    }
  });

  it('takes the slow path once a supersede has been confirmed', () => {
    for (const code of [4250, 4300]) {
      const analysis = analyzeClose(code, 'newer user session', false, { supersedeConfirmed: true });
      assert.equal(analysis.disposition, 'reconnect-slow', `${code}`);
      assert.equal(analysis.shouldReconnect, true, `${code}`);
      assert.equal(analysis.isSuperseded, true, `${code}`);
      assert.equal(analysis.requiresConfirmation, false, `${code}`);
    }
  });

  it('does not let a confirmation turn a heartbeat supersede into a supersession', () => {
    // `supersedeConfirmed` must not be able to reclassify a close that was never a real supersede: the
    // heartbeat case is our own reconnect racing itself, and it stays an ordinary one.
    const analysis = analyzeClose(4300, 'heartbeat superseded', false, { supersedeConfirmed: true });
    assert.equal(analysis.disposition, 'reconnect');
    assert.equal(analysis.isSuperseded, false);
    assert.equal(analysis.requiresConfirmation, false);
  });

  it('treats a heartbeat supersede as a normal reconnect', () => {
    const analysis = analyzeClose(4300, 'heartbeat superseded');
    assert.equal(analysis.disposition, 'reconnect');
    assert.equal(analysis.isSuperseded, false);
    assert.equal(analysis.requiresConfirmation, false);
  });

  it('never asks for confirmation on an ordinary close', () => {
    // `requiresConfirmation` is a promise that a human decision is what unblocks the reconnect. If any
    // ordinary close set it, a client that waits for a person would hang forever on a routine drop.
    for (const code of [1000, 4100, 4310, 4400, 4700, 4710, 4800, 4840, 4999]) {
      assert.equal(analyzeClose(code).requiresConfirmation, false, `${code}`);
    }
  });

  it('bounds retries on the auth and handshake codes', () => {
    for (const code of [4800, 4801, 4810]) {
      const analysis = analyzeClose(code);
      assert.equal(analysis.disposition, 'reconnect-bounded', `${code}`);
      assert.equal(analysis.isBounded, true, `${code}`);
    }
  });

  it('reconnects on a code absent from the enum, and says so', () => {
    const analysis = analyzeClose(4999);
    assert.equal(analysis.shouldReconnect, true);
    assert.equal(analysis.known, null);
    assert.equal(analysis.label, null);
    assert.match(analysis.reason, /not present in the game's own close-code enum/);
  });

  it("keeps the guide's names available as aliases", () => {
    // Existing callers written against the documented table must keep compiling.
    assert.equal(CloseCode.IdleTimeout, 4400);
    assert.equal(CloseCode.AuthFailed, 4800);
    assert.equal(CloseCode.Superseded, 4250);
    assert.equal(CloseCode.SupersededByNewerSession, 4300);
    assert.equal(CloseCode.Unspecified4500, 4500);
    assert.equal(analyzeClose(CloseCode.IdleTimeout).label, 'HeartbeatExpired');
  });
});

describe('result codes', () => {
  it('parses the documented code set', () => {
    assert.equal(parseResultCode('invalid_message'), ResultCode.InvalidMessage);
    assert.equal(parseResultCode('invalid_sequence'), ResultCode.InvalidSequence);
    assert.equal(parseResultCode('no_slot'), ResultCode.NoSlot);
    assert.equal(parseResultCode('rate_limited'), ResultCode.RateLimited);
    assert.equal(parseResultCode('not_ackable'), ResultCode.NotAckable);
    assert.equal(parseResultCode('handler_error'), ResultCode.HandlerError);
    assert.equal(parseResultCode('dropped_stale'), ResultCode.DroppedStale);
  });

  it('returns null for an unknown or absent code', () => {
    assert.equal(parseResultCode('something_new'), null);
    assert.equal(parseResultCode(undefined), null);
  });

  it('flags invalid_message as the wrong-form signature', () => {
    const rejection = interpretRejection('HarvestCrop', 'invalid_message');
    assert.equal(rejection.suggestsWrongForm, true);
    assert.equal(rejection.requiresSequenceResync, false);
    assert.match(rejection.message, /wrapped/);
  });

  it('flags an unnamed command as the wrong-form signature too', () => {
    // {"commandType":"unknown","ok":false,"code":"invalid_message"} is the documented silent failure.
    const rejection = interpretRejection('unknown', 'invalid_message');
    assert.equal(rejection.isUnknownCommandType, true);
    assert.equal(rejection.suggestsWrongForm, true);
  });

  it('flags invalid_sequence as requiring a resync', () => {
    const rejection = interpretRejection('WaterPlant', 'invalid_sequence');
    assert.equal(rejection.requiresSequenceResync, true);
    assert.match(rejection.message, /frontier/);
  });

  it('does not flag other codes as wrong-form', () => {
    assert.equal(interpretRejection('WaterPlant', 'rate_limited').suggestsWrongForm, false);
    assert.equal(interpretRejection('WaterPlant', 'no_slot').suggestsWrongForm, false);
    assert.equal(interpretRejection('WaterPlant', 'handler_error').suggestsWrongForm, false);
  });

  it('preserves an unrecognised raw code', () => {
    const rejection = interpretRejection('WaterPlant', 'brand_new_code');
    assert.equal(rejection.code, null);
    assert.equal(rejection.rawCode, 'brand_new_code');
    assert.match(rejection.message, /brand_new_code/);
  });

  it('handles a rejection with no code at all', () => {
    const rejection = interpretRejection('WaterPlant', undefined);
    assert.equal(rejection.code, null);
    assert.equal(rejection.rawCode, undefined);
  });
});
