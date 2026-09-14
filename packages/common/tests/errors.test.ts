/**
 * One error hierarchy, asserted on behaviour, not on the presence of a `catch`.
 *
 * `common/src/errors.ts` promises that every failure this package can produce is a named class, so a
 * caller branches on type rather than on message text. Two things falsified that promise before this file:
 * `headless/src/errors.ts` declared a *second* root (`MgConfigError extends Error`), so `isMgError`
 * answered `false` for it, and transport/HTTP faults were bare `Error`s. The headless half is pinned
 * behaviourally in `packages/headless/tests/errors.test.ts`; this file holds the shared taxonomy the
 * rest of the packages now branch on.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getActionSpec } from '../src/actions/registry.js';
import type { CommandRejection } from '../src/actions/result-codes.js';
import {
  isMgError,
  MgAuthError,
  MgCommandDroppedError,
  MgCommandRejectedError,
  MgCommandUnconfirmedError,
  MgConfigError,
  MgConnectionError,
  MgError,
  MgNotReadyError,
  MgProtocolError,
  MgSupersededError,
  MgTransportError,
  MgVersionExpiredError,
  summarizeError,
  toMgError,
} from '../src/errors.js';
import { buildFrame } from '../src/protocol/envelope.js';
import { parsePointer } from '../src/state/pointer.js';

const DISPOSITIONS = ['fatal', 'retry', 'ignore'] as const;

/** A minimal rejection, so every concrete subclass can be constructed here. */
const REJECTION: CommandRejection = {
  code: null,
  commandType: 'unknown',
  isUnknownCommandType: true,
  requiresSequenceResync: false,
  suggestsWrongForm: true,
  message: 'nope',
};

/** Run `fn` and return what it threw, failing the test when it throws nothing. */
function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected the call to throw');
}

describe('MgError', () => {
  it('carries a disposition, defaulting to fatal', () => {
    assert.equal(new MgError('m', 'x').disposition, 'fatal');
    assert.equal(new MgTransportError('m').disposition, 'retry');
    assert.equal(new MgProtocolError('m').disposition, 'ignore');
    assert.equal(new MgConfigError('m').disposition, 'fatal');
  });

  it('gives every subclass a disposition and an isMgError of true', () => {
    const instances: readonly [string, MgError][] = [
      ['MgError', new MgError('m', 'x')],
      ['MgConnectionError', new MgConnectionError('m')],
      ['MgVersionExpiredError', new MgVersionExpiredError()],
      ['MgAuthError', new MgAuthError('m')],
      ['MgSupersededError', new MgSupersededError(4409)],
      ['MgCommandRejectedError', new MgCommandRejectedError(REJECTION, 'HarvestCrops')],
      ['MgCommandUnconfirmedError', new MgCommandUnconfirmedError('HarvestCrops', 'r', 1)],
      ['MgCommandDroppedError', new MgCommandDroppedError('HarvestCrops', 1)],
      ['MgNotReadyError', new MgNotReadyError()],
      ['MgProtocolError', new MgProtocolError('m')],
      ['MgTransportError', new MgTransportError('m')],
      ['MgConfigError', new MgConfigError('m')],
    ];
    for (const [name, error] of instances) {
      assert.equal(isMgError(error), true, `${name} must be an MgError`);
      assert.ok(
        (DISPOSITIONS as readonly string[]).includes(error.disposition),
        `${name}.disposition must be one of ${DISPOSITIONS.join(' | ')}, got "${error.disposition}"`,
      );
      assert.equal(typeof error.code, 'string', `${name} must carry a stable code`);
    }
  });

  it('defaults a transport failure to retry, with a stable code and kind', () => {
    const error = new MgTransportError('socket said no');
    assert.equal(error.kind, 'socket');
    assert.equal(error.code, 'transport_failure');
    assert.equal(error.disposition, 'retry');
    assert.equal(new MgTransportError('http said no', 'http').kind, 'http');
  });

  it('accepts the headless token code as an explicit MgConfigError code', () => {
    assert.equal(new MgConfigError('m').code, 'config_invalid');
    assert.equal(new MgConfigError('m', 'config_invalid_token').code, 'config_invalid_token');
  });

  it('branches on the type of a caller mistake, not on message text', () => {
    const action = caught(() => getActionSpec('Nope'));
    if (!(action instanceof MgProtocolError)) {
      assert.fail(`an unknown action must throw MgProtocolError, got ${String(action)}`);
    }
    assert.equal(isMgError(action), true);

    const pointer = caught(() => parsePointer('data/players'));
    if (!(pointer instanceof MgProtocolError)) {
      assert.fail(`a malformed pointer must throw MgProtocolError, got ${String(pointer)}`);
    }

    const frame = caught(() => buildFrame({ action: 'WaterPlant', params: { slot: 1 } }));
    if (!(frame instanceof MgProtocolError)) {
      assert.fail(`a wrapped frame without a sequence must throw MgProtocolError, got ${String(frame)}`);
    }
  });
});

describe('toMgError', () => {
  it('preserves the message and supplies a branchable code for a bare error', () => {
    const wrapped = toMgError(new TypeError('t'), 'source_failure');
    assert.equal(isMgError(wrapped), true);
    assert.equal(wrapped.code, 'source_failure');
    assert.equal(wrapped.message, 't');
  });

  it('is identity for a value that is already an MgError', () => {
    const already = new MgProtocolError('m');
    assert.equal(toMgError(already, 'x'), already);
  });

  it('wraps a non-Error value without throwing', () => {
    const wrapped = toMgError('plain string', 'source_failure');
    assert.equal(wrapped.code, 'source_failure');
    assert.equal(wrapped.message, 'plain string');
  });
});

describe('summarizeError', () => {
  it('is total and JSON-safe', () => {
    const inputs: readonly unknown[] = [
      new MgProtocolError('x'),
      new TypeError('t'),
      'a string',
      null,
      { code: 42 },
    ];
    for (const input of inputs) {
      const summary = summarizeError(input);
      assert.deepEqual(JSON.parse(JSON.stringify(summary)), summary);
      assert.equal(typeof summary.name, 'string');
      assert.equal(typeof summary.code, 'string');
      assert.equal(typeof summary.message, 'string');
    }
  });

  it('names the class and code a caller branches on', () => {
    assert.equal(summarizeError(new MgProtocolError('x')).name, 'MgProtocolError');
    assert.equal(summarizeError(new MgProtocolError('x')).code, 'protocol_error');
    assert.equal(summarizeError(new TypeError('t')).name, 'TypeError');
  });

  it('never prints a credential', () => {
    const summary = summarizeError(new MgError('Cookie: mc_jwt=SECRET.JWT.VALUE', 'x'));
    assert.ok(!summary.message.includes('SECRET.JWT.VALUE'), summary.message);
    assert.match(summary.message, /mc_jwt=\[redacted\]/);
  });
});
