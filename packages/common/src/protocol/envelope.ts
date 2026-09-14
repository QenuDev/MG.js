/**
 * Envelope construction.
 *
 * The only place in the codebase that knows how to shape an outbound message. Action methods call
 * `buildFrame`; nothing else should be assembling `scopePath`/`type`/`command` by hand.
 */

import type { FormRegistry } from '../actions/registry.js';
import { getActionSpec } from '../actions/registry.js';
import { MgProtocolError } from '../errors.js';
import { isCanonicalSequence } from './codec.js';
import { randomUuid } from './id.js';
import type {
  ActionForm,
  CommandBody,
  FlatFrame,
  OutboundFrame,
  RoomFrame,
  ScopePath,
  WrappedFrame,
} from './wire.js';
import { SCOPE_QUINOA, SCOPE_ROOM } from './wire.js';

/** A command payload: the parameter bag that goes alongside the action's `type`. */
export type ActionParams = Record<string, unknown>;

export interface BuildFrameOptions {
  /** The action name, matching a key of the action registry. */
  action: string;
  /** Parameters for the action. Keys with `undefined` values are dropped. */
  params?: ActionParams;
  /** A pre-built frame is returned unchanged when set, used by the bootstrapped send-hook. */
  form?: ActionForm;
  /** Overrides the generated request id. */
  requestId?: string;
  /** Required when the effective form is `wrapped`. */
  commandSequence?: number;
  /** Form registry to consult. Defaults to the shared registry. */
  registry?: FormRegistry;
}

/**
 * Drop keys whose value is `undefined`.
 *
 * This matters more than it looks: several actions have optional parameters whose documented rule is
 * "omit it entirely", not "send null". `Wish.itemId` is the clearest example, and
 * `DropObject`/`PickupObject` are "rejected as malformed" if they carry any parameters at all.
 */
export function pruneUndefined(params: ActionParams): ActionParams {
  const out: ActionParams = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Build a room-scoped frame: `{ scopePath: ["Room"], type, ...params }`. */
export function buildRoomFrame(action: string, params: ActionParams = {}): RoomFrame {
  const spec = getActionSpec(action);
  return {
    scopePath: SCOPE_ROOM,
    type: spec.wire,
    ...pruneUndefined(params),
  } as RoomFrame;
}

/** Build a flat Quinoa-scoped frame: `{ scopePath: ["Room","Quinoa"], type, ...params }`. */
export function buildFlatFrame(action: string, params: ActionParams = {}): FlatFrame {
  const spec = getActionSpec(action);
  return {
    scopePath: SCOPE_QUINOA,
    type: spec.wire,
    ...pruneUndefined(params),
  } as FlatFrame;
}

/**
 * Build the `QuinoaCommand` envelope:
 * `{ scopePath: ["Room","Quinoa"], type: "QuinoaCommand", requestId, commandSequence, command }`.
 */
export function buildWrappedFrame(
  action: string,
  params: ActionParams,
  commandSequence: number,
  requestId: string = randomUuid(),
): WrappedFrame {
  const spec = getActionSpec(action);
  const command: CommandBody = {
    type: spec.wire,
    ...pruneUndefined(params),
  };
  return {
    scopePath: SCOPE_QUINOA,
    type: 'QuinoaCommand',
    requestId,
    commandSequence,
    command,
  };
}

/**
 * Build the correct frame for an action, choosing the form automatically.
 *
 * Throws when the effective form is `wrapped` and no `commandSequence` was supplied. Sending a
 * wrapped command with an undefined sequence is the silent-failure class this package
 * exists to prevent.
 */
export function buildFrame(options: BuildFrameOptions): OutboundFrame {
  const { action, params = {}, requestId, commandSequence } = options;
  const registry = options.registry;
  const form: ActionForm = options.form ?? registry?.formOf(action) ?? getActionSpec(action).form;

  switch (form) {
    case 'room':
      return buildRoomFrame(action, params);
    case 'flat':
      return buildFlatFrame(action, params);
    case 'wrapped': {
      if (!isCanonicalSequence(commandSequence)) {
        throw new MgProtocolError(
          `buildFrame: "${action}" is a wrapped action and requires a commandSequence. ` +
            'Seed a CommandSequencer from Welcome.executedCommandSequence first.',
        );
      }
      return buildWrappedFrame(action, params, commandSequence, requestId);
    }
  }
}

/** The scope path an already-built frame carries. */
export function frameScope(frame: OutboundFrame): ScopePath {
  return frame.scopePath;
}

/** True when the frame is a `QuinoaCommand` envelope. */
export function isWrappedFrame(frame: OutboundFrame): frame is WrappedFrame {
  return frame.type === 'QuinoaCommand';
}

/** The action wire string a frame carries, whether wrapped or not. */
export function frameAction(frame: OutboundFrame): string {
  return isWrappedFrame(frame) ? frame.command.type : frame.type;
}
