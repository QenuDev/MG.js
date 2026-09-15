/**
 * Envelope construction.
 *
 * The three outbound shapes are the crux of the whole protocol: sending a wrapped action flat fails
 * silently, and the frame shapes here are the only thing standing between a caller and that.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FormRegistry } from '../src/actions/registry.js';
import {
  buildFlatFrame,
  buildFrame,
  buildRoomFrame,
  buildWrappedFrame,
  frameAction,
  frameScope,
  isWrappedFrame,
  pruneUndefined,
} from '../src/protocol/envelope.js';
import { SCOPE_QUINOA, SCOPE_ROOM } from '../src/protocol/wire.js';

describe('pruneUndefined', () => {
  it('drops undefined-valued keys but keeps null and falsy values', () => {
    const result = pruneUndefined({
      a: undefined,
      b: null,
      c: 0,
      d: '',
      e: false,
      f: 'kept',
    });
    assert.deepEqual(result, { b: null, c: 0, d: '', e: false, f: 'kept' });
    assert.ok(!('a' in result));
  });
});

describe('room-scoped frames', () => {
  it('are flat with the Room scope', () => {
    const frame = buildRoomFrame('Chat', { message: 'hello' });
    assert.deepEqual(frame, { scopePath: ['Room'], type: 'Chat', message: 'hello' });
    assert.deepEqual(frame.scopePath, SCOPE_ROOM);
    assert.equal(isWrappedFrame(frame), false);
    assert.equal(frameAction(frame), 'Chat');
    assert.deepEqual(frameScope(frame), ['Room']);
  });

  it('prune undefined params', () => {
    const frame = buildRoomFrame('SetPlayerData', { name: 'Ada', cosmetic: undefined });
    assert.deepEqual(frame, { scopePath: ['Room'], type: 'SetPlayerData', name: 'Ada' });
  });
});

describe('flat Quinoa-scoped frames', () => {
  it('carry the Quinoa scope without an envelope', () => {
    const frame = buildFlatFrame('Teleport', { position: { x: 1, y: 2 } });
    assert.deepEqual(frame, {
      scopePath: ['Room', 'Quinoa'],
      type: 'Teleport',
      position: { x: 1, y: 2 },
    });
    assert.deepEqual(frame.scopePath, SCOPE_QUINOA);
    assert.equal(isWrappedFrame(frame), false);
    assert.equal(frameAction(frame), 'Teleport');
  });

  it('send DropObject with no parameters, since any parameter is rejected as malformed', () => {
    const frame = buildFlatFrame('DropObject');
    assert.deepEqual(frame, { scopePath: ['Room', 'Quinoa'], type: 'DropObject' });
  });
});

describe('wrapped QuinoaCommand envelopes', () => {
  it('match the documented shape exactly', () => {
    const frame = buildWrappedFrame('HarvestCrop', { slot: 3, cropItemId: 'c1' }, 42, 'req-1');
    assert.deepEqual(frame, {
      scopePath: ['Room', 'Quinoa'],
      type: 'QuinoaCommand',
      requestId: 'req-1',
      commandSequence: 42,
      command: { type: 'HarvestCrop', slot: 3, cropItemId: 'c1' },
    });
    assert.equal(isWrappedFrame(frame), true);
    assert.equal(frameAction(frame), 'HarvestCrop');
  });

  it('generate a requestId when none is supplied', () => {
    const frame = buildWrappedFrame('WaterPlant', { slot: 1 }, 7);
    assert.equal(typeof frame.requestId, 'string');
    assert.ok(frame.requestId.length > 0);
  });
});

describe('buildFrame form selection', () => {
  it('chooses the declared form for each kind of action', () => {
    const room = buildFrame({ action: 'UsurpHost', params: {} });
    assert.equal(room.type, 'UsurpHost');
    assert.deepEqual(room.scopePath, ['Room']);

    const flat = buildFrame({ action: 'Teleport', params: { position: { x: 0, y: 0 } } });
    assert.equal(flat.type, 'Teleport');
    assert.deepEqual(flat.scopePath, ['Room', 'Quinoa']);

    const wrapped = buildFrame({ action: 'WaterPlant', params: { slot: 2 }, commandSequence: 5 });
    assert.equal(wrapped.type, 'QuinoaCommand');
    assert.equal(isWrappedFrame(wrapped) && wrapped.command.type, 'WaterPlant');
  });

  it('refuses to build a wrapped frame without a sequence number', () => {
    // Sending a wrapped command with an undefined sequence is the silent-failure class this
    // package exists to prevent, so it throws instead.
    assert.throws(
      () => buildFrame({ action: 'WaterPlant', params: { slot: 1 } }),
      /requires a commandSequence/,
    );
  });

  it('does not require a sequence for room or flat actions', () => {
    assert.doesNotThrow(() => buildFrame({ action: 'Chat', params: { message: 'hi' } }));
    assert.doesNotThrow(() => buildFrame({ action: 'Teleport', params: { position: { x: 0, y: 0 } } }));
  });

  it('honours a registry override', () => {
    const registry = new FormRegistry();
    registry.setActionForm('Wish', 'flat');
    const frame = buildFrame({ action: 'Wish', params: { itemId: 'coin' }, registry });
    assert.equal(frame.type, 'Wish');
    assert.deepEqual(frame.scopePath, ['Room', 'Quinoa']);
  });

  it('honours an explicit form argument over the registry', () => {
    const frame = buildFrame({
      action: 'WaterPlant',
      params: { slot: 1 },
      form: 'flat',
      commandSequence: 9,
    });
    assert.equal(frame.type, 'WaterPlant');
  });
});
