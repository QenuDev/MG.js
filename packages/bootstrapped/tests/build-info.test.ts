/**
 * Build identity has one home, and the page namespace still agrees with it.
 *
 * `BUNDLE_VERSION` used to live in the page-namespace module, which is where the audit's structure report
 * objected to it (its `realm.ts:55`): a namespace is a *communication* concern, meaning which keys this
 * bundle claims on the page and how it refcounts a shared install, while the version is build identity that
 * happens to be stamped into that namespace. Task 5.7e moves it to `build-info.ts`.
 *
 * A move like this has one failure mode a name-set guard cannot see: the namespace keeps reporting a
 * literal instead of the moved constant, so the two are equal today and drift silently later. The last
 * assertion reads the value the namespace actually stamps onto the page, which is the one a restated
 * literal would change.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MG_VERSION } from '@mg.js/common';
import { BUNDLE_VERSION } from '../src/build-info.js';
import { getNamespace } from '../src/page/namespace.js';
import type { PageRealm } from '../src/page/realm.js';

void test('BUNDLE_VERSION is the version common publishes', () => {
  // The cross-package identity is the assertion a restated literal cannot fake.
  assert.equal(BUNDLE_VERSION, MG_VERSION);
});

void test('BUNDLE_VERSION is a non-empty string, not a placeholder', () => {
  assert.equal(typeof BUNDLE_VERSION, 'string');
  assert.notEqual(BUNDLE_VERSION.trim(), '');
});

void test('the namespace stamps the version this package builds as', () => {
  // Not a duplicate definition: the namespace reads the moved constant, so this fails if it ever restates
  // one, and that is the drift a `.ts`-level re-export check cannot see.
  const page: PageRealm = {};
  assert.equal(getNamespace(page).version, BUNDLE_VERSION);
});
