/**
 * The form registry and the action surface.
 *
 * These are the highest-value tests in the package: the documented failure mode for getting a form
 * wrong is *silence*, so a wrong entry here would produce a wrapper that appears to work and does
 * nothing. The counts asserted below come from the protocol field guide's action tables.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GAME_ACTION_METHOD_COUNT, GameActions } from '../src/actions/game-actions.js';
import type { CommandResult, CommandSender } from '../src/actions/handle.js';
import { CommandHandle } from '../src/actions/handle.js';
import {
  ACTION_NAMES,
  ACTION_SPECS,
  FLAT_ALLOWLIST,
  FormRegistry,
  getActionSpec,
  scopeForForm,
} from '../src/actions/registry.js';
import { buildFrame, isWrappedFrame } from '../src/protocol/envelope.js';

/** A sender that records what the action layer produced. */
function recordingSender(): {
  sender: CommandSender;
  calls: { action: string; params: Record<string, unknown> }[];
} {
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  const sender: CommandSender = {
    send(action, params = {}) {
      calls.push({ action, params });
      const never = new Promise<CommandResult>(() => {});
      return new CommandHandle(action, 'req', 1, never, Promise.resolve(null));
    },
  };
  return { sender, calls };
}

describe('form registry', () => {
  it('contains exactly 71 distinct wire strings', () => {
    assert.equal(ACTION_NAMES.length, 71);
    const wires = new Set(ACTION_NAMES.map((name) => ACTION_SPECS[name].wire));
    assert.equal(wires.size, 71, 'every wire string must be distinct');
  });

  it('splits 9 room / 15 flat / 47 wrapped', () => {
    const counts = { room: 0, flat: 0, wrapped: 0 };
    for (const name of ACTION_NAMES) counts[ACTION_SPECS[name].form] += 1;
    assert.deepEqual(counts, { room: 9, flat: 15, wrapped: 47 });
    // 47 wrapped wire commands + fuseCrystal (which emits PlaceCrystal) = the reference's 48.
    assert.equal(counts.wrapped + 1, 48);
  });

  it('agrees exactly with the documented 15-name flat allowlist', () => {
    const declaredFlat = ACTION_NAMES.filter((name) => ACTION_SPECS[name].form === 'flat').sort();
    assert.deepEqual([...FLAT_ALLOWLIST].sort(), declaredFlat);
  });

  it('keeps the two structurally-not-commands actions flat', () => {
    // Ping gets a direct Pong rather than a QuinoaCommandResult; PlayerPosition feeds a continuous
    // snapshot channel. The doc says neither is ever expected to move into the envelope.
    assert.equal(ACTION_SPECS.Ping.form, 'flat');
    assert.equal(ACTION_SPECS.PlayerPosition.form, 'flat');
  });

  it('marks the scope each form implies', () => {
    assert.deepEqual(scopeForForm('room'), ['Room']);
    assert.deepEqual(scopeForForm('flat'), ['Room', 'Quinoa']);
    assert.deepEqual(scopeForForm('wrapped'), ['Room', 'Quinoa']);
  });

  it('maps every action to a known category', () => {
    const categories = new Set([
      'session',
      'social',
      'movement',
      'shop',
      'garden',
      'decor',
      'pets',
      'inventory',
    ]);
    for (const name of ACTION_NAMES) {
      assert.ok(categories.has(ACTION_SPECS[name].category), `${name} has an unknown category`);
    }
  });

  it('throws on an unknown action rather than guessing', () => {
    assert.throws(() => getActionSpec('HarvestCrops'), /Unknown action/);
  });

  it('records the documented wire-field divergences', () => {
    // RestartGame uses `name` while VoteForGame/SetSelectedGame use `gameName`.
    assert.ok(ACTION_SPECS.RestartGame.note?.includes('`name`'));
    // There is no separate fuse command.
    assert.ok(ACTION_SPECS.PlaceCrystal.note?.includes('no separate fuse wire command'));
    // DropObject/PickupObject declare no parameters at all.
    assert.deepEqual(ACTION_SPECS.DropObject.params, []);
    assert.deepEqual(ACTION_SPECS.PickupObject.params, []);
  });

  it('allows a runtime form override and reports it', () => {
    const registry = new FormRegistry();
    assert.equal(registry.formOf('Wish'), 'wrapped');
    registry.setActionForm('Wish', 'flat');
    assert.equal(registry.formOf('Wish'), 'flat');
    assert.equal(registry.declaredFormOf('Wish'), 'wrapped');
    assert.equal(registry.activeOverrides.get('Wish'), 'flat');
    registry.setActionForm('Wish', null);
    assert.equal(registry.formOf('Wish'), 'wrapped');
    assert.equal(registry.activeOverrides.size, 0);
  });

  it('rejects an override for an unknown action', () => {
    const registry = new FormRegistry();
    assert.throws(() => registry.setActionForm('Nope', 'flat'), /Unknown action/);
  });

  it('never rewrites a known-good flat action without a per-action opt-in', () => {
    // This test used to construct the registry with `{ formFallback: 'wrap' }`, the strongest available
    // setting, and assert that nothing changed. It could not have failed for the reason its name gave: the
    // fallback's guard was `isFallbackEnabled`, which returned a constant `false`, so the option had no
    // behaviour to observe and the assertion would have held with `'strict'` or with no option at all. The
    // test that read as coverage of the option was the thing keeping a dead knob in the public API.
    //
    // No option is passed now, because none exists: what is asserted is the real rule, that a flat action
    // stays flat until a caller opts it in.
    const registry = new FormRegistry();
    assert.equal(registry.formOf('Ping'), 'flat');
    assert.equal(registry.formOf('DropObject'), 'flat');

    // The opt-in that does exist still changes the answer, and it is the thing the deleted option only
    // pretended to be: one line, one action, and `formOf` follows it.
    registry.setActionForm('DropObject', 'wrapped');
    assert.equal(registry.formOf('DropObject'), 'wrapped');
    assert.equal(registry.formOf('Ping'), 'flat', 'the opt-in must not be a global switch');
  });
});

describe('GameActions surface', () => {
  it('exposes exactly 72 methods', () => {
    // 71 wire strings + fuseCrystal, which the reference exposes alongside placeCrystal.
    const methods = Object.getOwnPropertyNames(GameActions.prototype).filter(
      (name) => name !== 'constructor',
    );
    assert.equal(methods.length, GAME_ACTION_METHOD_COUNT);
    assert.equal(methods.length, 72);
  });

  it('sends fuseCrystal as PlaceCrystal with a merge intent', () => {
    const { sender, calls } = recordingSender();
    const actions = new GameActions(sender);
    actions.fuseCrystal({
      shard: { itemId: 'shard-1', crystalType: 'ruby' },
      tileType: 'Dirt',
      localTileIndex: 4,
      mergeGainSeconds: 120,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.action, 'PlaceCrystal');
    assert.deepEqual(calls[0]?.params.intent, { type: 'merge', mergeGainSeconds: 120 });
  });

  it('sends placeCrystal with a place intent', () => {
    const { sender, calls } = recordingSender();
    const actions = new GameActions(sender);
    actions.placeCrystal({
      shard: { itemId: 'shard-1', crystalType: 'ruby' },
      tileType: 'Dirt',
      localTileIndex: 4,
    });
    assert.deepEqual(calls[0]?.params.intent, { type: 'place' });
  });

  it('sends restartGame with the wire field `name`, not `gameName`', () => {
    const { sender, calls } = recordingSender();
    const actions = new GameActions(sender);
    actions.restartGame({ gameName: 'Quinoa' });
    assert.deepEqual(calls[0]?.params, { name: 'Quinoa' });
    assert.equal(calls[0]?.action, 'RestartGame');
  });

  it('defaults the game name to Quinoa for the voting handshake', () => {
    const { sender, calls } = recordingSender();
    const actions = new GameActions(sender);
    actions.voteForGame();
    actions.setSelectedGame();
    assert.deepEqual(calls[0]?.params, { gameName: 'Quinoa' });
    assert.deepEqual(calls[1]?.params, { gameName: 'Quinoa' });
  });

  it('mints a cropItemId for harvestCrop when none is supplied', () => {
    const { sender, calls } = recordingSender();
    const actions = new GameActions(sender);
    actions.harvestCrop({ slot: 3 });
    const minted = calls[0]?.params.cropItemId;
    assert.equal(typeof minted, 'string');
    assert.match(String(minted), /^[0-9a-f-]{36}$/);
  });

  it('preserves a caller-supplied cropItemId', () => {
    const { sender, calls } = recordingSender();
    const actions = new GameActions(sender);
    actions.harvestCrop({ slot: 3, cropItemId: 'mine' });
    assert.equal(calls[0]?.params.cropItemId, 'mine');
  });

  it('nests x/y under position for the movement and pet actions', () => {
    const { sender, calls } = recordingSender();
    const actions = new GameActions(sender);
    actions.move({ x: 1, y: 2 });
    actions.teleport({ x: 3, y: 4 });
    actions.dawnCapture({ petItemId: 'p', x: 5, y: 6 });
    actions.requestPetGreet({ x: 7, y: 8 });
    assert.deepEqual(calls[0]?.params, { position: { x: 1, y: 2 } });
    assert.deepEqual(calls[1]?.params, { position: { x: 3, y: 4 } });
    assert.deepEqual(calls[2]?.params, { petItemId: 'p', position: { x: 5, y: 6 } });
    assert.deepEqual(calls[3]?.params, { position: { x: 7, y: 8 } });
  });

  it('gives dropObject and pickupObject no parameters at all', () => {
    const { sender, calls } = recordingSender();
    const actions = new GameActions(sender);
    actions.dropObject();
    actions.pickupObject();
    assert.deepEqual(calls[0]?.params, {});
    assert.deepEqual(calls[1]?.params, {});
  });

  it('omits an absent Wish itemId rather than sending null', () => {
    const { sender, calls } = recordingSender();
    const actions = new GameActions(sender);
    actions.wish();
    // `undefined` is what the action layer passes; buildFrame prunes it. Assert on the frame itself.
    const frame = buildFrame({ action: 'Wish', params: calls[0]?.params ?? {}, commandSequence: 1 });
    assert.ok(isWrappedFrame(frame), 'Wish is a wrapped action, so the params live under `command`');
    assert.ok(!('itemId' in frame.command), 'itemId must not appear in the frame at all');
  });

  it('passes a pet team emblem through as an object', () => {
    const { sender, calls } = recordingSender();
    const actions = new GameActions(sender);
    const emblem = { type: 'icon', icon: 'star' };
    actions.setPetTeamEmblem({ teamId: 't1', emblem });
    assert.deepEqual(calls[0]?.params.emblem, emblem);
  });
});
