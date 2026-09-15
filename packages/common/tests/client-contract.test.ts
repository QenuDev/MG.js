/**
 * The one client contract.
 *
 * `common/src/client-contract.ts` is a *type* module: it is the single description of the four
 * client-shaped classes (`ClientCore`, `HeadlessClient`, `BootstrappedClient`, `RoomSocket`), and it is
 * silent at runtime. The two runtime cases below hold that line (the module's namespace is empty),
 * while the compile-time assertions pin the shape decisions 4.2 to 4.4 consume. A contract nothing
 * can be assigned to is a contract those tasks would discover the hard way, so the assertions fail here
 * first.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ClientCore, ClientEvents } from '../src/client.js';
import type {
  ClientCloseEvent,
  ClientKind,
  ClientReport,
  MgClient,
  MgClientEvents,
  MgErrorSummary,
} from '../src/client-contract.js';
import type { TransportCloseInfo } from '../src/transport/seam.js';
import { MG_VERSION } from '../src/version.js';

/** Resolves to `true`, or the file stops compiling. */
type Assert<T extends true> = T;

/** The lifecycle namespace must be a legal event map for `Emitter`. */
export type _LifecycleIsAnEventMap = Assert<MgClientEvents extends Record<string, unknown[]> ? true : false>;

/**
 * `close` carries `{ info }` rather than the bare `TransportCloseInfo`, so a platform client can extend
 * the payload (`HeadlessCloseEvent extends ClientCloseEvent`) without renaming the event.
 */
export type _CloseCarriesTheWrapper = Assert<
  MgClientEvents['close'] extends [ClientCloseEvent] ? true : false
>;
export type _CloseInfoIsATransportCloseInfo = Assert<
  ClientCloseEvent['info'] extends TransportCloseInfo ? true : false
>;

/** Every documented report axis must exist: a missing one is an error here, not in 4.2. */
export type _ReportHasEveryAxis = Assert<
    | 'kind'
    | 'started'
    | 'ready'
    | 'selfPlayerId'
    | 'attachment'
    | 'socketsSeen'
    | 'renumbering'
    | 'errors'
    | 'version' extends keyof ClientReport
    ? true
    : false
>;

/**
 * The report's identity axis is nullable, and it is the same nullable as the accessor's.
 *
 * This is the compile-time half of I6: a report that typed identity as `string` could not describe a
 * client that has not seen a `Welcome`, and one that typed it as a placeholder-carrying `string` would
 * make the two surfaces disagree.
 */
export type _ReportIdentityAllowsNull = Assert<null extends ClientReport['selfPlayerId'] ? true : false>;
export type _ReportIdentityMatchesTheAccessor = Assert<
  ClientReport['selfPlayerId'] extends MgClient<MgClientEvents>['selfPlayerId'] ? true : false
>;

/** The same for the client surface itself. */
export type _ContractHasEveryMember = Assert<
    | 'start'
    | 'stop'
    | 'events'
    | 'isReady'
    | 'selfPlayerId'
    | 'lastError'
    | 'report' extends keyof MgClient<MgClientEvents>
    ? true
    : false
>;

/** Identity is nullable by contract, so a placeholder is not an option (I6). */
export type _IdentityAllowsNull = Assert<
  null extends MgClient<MgClientEvents>['selfPlayerId'] ? true : false
>;

/**
 * `ClientCore` is a `MgClient`, and the only chance to prove it is a compile-time assignment.
 *
 * The contract's own members compile without an adopter, so the shape decisions 4.2 makes for the core
 * (`stop` where `dispose` was, `report` where `stats` was, `close` carrying `{ info }`) would otherwise
 * be discovered by 4.3 and 4.4 instead of here. `ClientEvents extends MgClientEvents` is the constraining
 * half: now that `close` is `[ClientCloseEvent]` on both sides, the assignment type-checks, and it is the
 * invariant keeping them from drifting apart again.
 */
export type _ClientCoreSatisfiesTheContract = Assert<
  ClientCore extends MgClient<ClientEvents> ? true : false
>;

/** A summary is three strings and nothing else; it is what gets printed (I3). */
export type _SummaryIsThreeStrings = Assert<
  'name' | 'code' | 'message' extends keyof MgErrorSummary ? true : false
>;

/** The set of client kinds is closed. */
export type _KindsAreClosed = Assert<
  ClientKind extends 'common' | 'headless' | 'bootstrapped' ? true : false
>;

describe('client contract', () => {
  it('is types only, so importing it emits no runtime code', async () => {
    const contract = await import('../src/client-contract.js');
    assert.deepEqual(Object.keys(contract), []);
  });

  it('keeps the version number in one module', async () => {
    const version = await import('../src/version.js');
    assert.deepEqual(Object.keys(version), ['MG_VERSION']);
    assert.match(MG_VERSION, /^\d+\.\d+\.\d+$/);
  });
});
