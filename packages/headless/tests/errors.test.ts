/**
 * The headless `MgConfigError` is the *shared* one, not a second hierarchy root.
 *
 * This file exists only for the behavioural half of E7. Before the fix, `headless/src/errors.ts`
 * declared `class MgConfigError extends Error` with its own header saying it lived there "because the
 * common taxonomy has no `MgConfigError` yet". A caller that classifies failures with
 * `isMgError(error)`, the documented way to branch on type rather than message text,
 * therefore misclassified every headless config error as "not ours".
 *
 * The assertion is `isMgError`/`instanceof MgError` and not "the file re-exports
 * something": re-exporting a fresh class, or setting the prototype without sharing the constructor,
 * would satisfy a source-level check while leaving the classification wrong.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isMgError, MgError } from '@mg.js/common';

import { MgConfigError } from '../src/errors.js';

describe('the headless MgConfigError', () => {
  it('is an MgError, so isMgError classifies it as one of ours', () => {
    const error = new MgConfigError('bad token');
    assert.equal(
      isMgError(error),
      true,
      'a caller that classifies with isMgError must not misclassify the headless config error',
    );
    assert.equal(error instanceof MgError, true, 'the base class must be the shared MgError');
    assert.equal(error.name, 'MgConfigError', 'the public class name must not move');
  });
});
