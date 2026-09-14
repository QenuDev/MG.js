/**
 * The render facade is built from a seam, not from the client's private fields.
 *
 * ## The defect this replaces
 *
 * The facade used to be built as `createRenderFacade(client)` and read the client's private capture handle
 * with bracket-string access, `client['captureHandle']`. That compiles, and it is why it survived: the
 * bracket form defeats TypeScript's visibility check, so nothing flags it, while `private` stops meaning
 * anything for the one field a second module reaches for. The audit named it correctly: *"that is a
 * missing seam, not a shortcut"*.
 *
 * The seam is now explicit: `createRenderFacade({ capture, jotai })`. Both are **thunks**, and that is the
 * part worth testing rather than the refactor's shape. The facade is created once in the constructor
 * (`client.ts:335`), while the capture handle is installed later, on attachment when the Pixi init hook
 * fires, and the jotai bridge is released on `stop()` and rebuilt on the next `start()`. A facade that
 * captured the *values* at construction would report `null` forever and would wire cinematic claims to a
 * bridge that had already been released, so laziness is a behavioural requirement, not a style choice.
 *
 * These tests are also the guard on the seam's shape: a plain object literal satisfies it, so the facade
 * cannot quietly go back to requiring a whole `BootstrappedClient`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRenderFacade } from '../../src/render/facade.js';
import * as graphics from '../../src/render/graphics.js';
import type { PixiCaptureHandle } from '../../src/render/pixi.js';
import { PixiStage } from '../../src/render/pixi.js';
import { RiveRegistry } from '../../src/render/rive.js';
import * as sprite from '../../src/render/sprite.js';
import * as text from '../../src/render/text.js';

function handle(): PixiCaptureHandle {
  return { release: () => undefined, active: true, stats: { app: 0, renderer: 0, recreations: 0 } };
}

void test('the facade reports no capture before one is installed, then reports it', () => {
  let installed: PixiCaptureHandle | null = null;
  const facade = createRenderFacade({ captureHandle: () => installed, jotai: () => null });

  assert.equal(facade.capture, null, 'nothing has been captured at construction time');

  installed = handle();
  assert.equal(facade.capture, installed, 'a handle installed after construction must be visible');
});

void test('the facade reports a released capture as gone again', () => {
  let installed: PixiCaptureHandle | null = handle();
  const facade = createRenderFacade({ captureHandle: () => installed, jotai: () => null });

  assert.notEqual(facade.capture, null);
  installed = null;
  assert.equal(facade.capture, null, 'a released handle must not be reported as installed');
});

void test('the facade exposes the documented render surface', () => {
  const facade = createRenderFacade({ captureHandle: () => null, jotai: () => null });

  assert.equal(facade.stage, PixiStage);
  assert.equal(facade.text, text);
  assert.equal(facade.graphics, graphics);
  assert.equal(facade.sprite, sprite);
  assert.equal(facade.rive instanceof RiveRegistry, true);
  assert.equal(typeof facade.worldScene, 'function');
});

void test('the seam is a plain object, not a client', () => {
  // If this ever needs a `BootstrappedClient` again, the bracket access has come back with it.
  const seam = { captureHandle: () => null, jotai: () => null };
  assert.equal(createRenderFacade(seam).capture, null);
});
