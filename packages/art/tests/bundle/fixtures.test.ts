/**
 * The fixtures themselves: what a committed capture has to record to be evidence rather than convenience.
 *
 * A fixture that lost its provenance is worse than no fixture, because the numbers in it look read from the
 * game. These assertions are about the manifest rather than the tables: every cut names the chunk it came from
 * and both of its byte ranges, the ranges have the same length (which is what makes the translation back to the
 * game's bytes exact), the frames the atlas ships are the frames the name table needs, and the whole capture
 * stays small enough to review as a diff.
 */

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { spritePathsOf } from '../../src/bundle/validate.ts';
import { FIXTURE_DIR, loadFixture } from './load-fixture.ts';

const fixture = loadFixture();

void test('every cut records the chunk and both byte ranges, and the two ranges have the same length', () => {
  assert.ok(fixture.manifest.files.length >= 2, 'the capture is missing a chunk');
  for (const file of fixture.manifest.files) {
    assert.ok(file.chunk.endsWith('.js'), `${file.fixture} does not name the chunk it was cut from`);
    assert.match(file.fileUrl, /^https:\/\/magicgarden\.gg\/version\/\d+\/assets\//);
    assert.ok(
      file.imports.length > 0,
      `${file.chunk} records no imports, so an external's origin is unknown`,
    );
    assert.ok(file.cuts.length > 0, `${file.chunk} holds no cuts`);
    for (const cut of file.cuts) {
      assert.ok(cut.declaration.length > 0, `${file.chunk} has a cut with no declaration name`);
      assert.ok(cut.sourceStart < cut.sourceEnd, `${cut.declaration} has an empty source range`);
      assert.ok(cut.fixtureStart < cut.fixtureEnd, `${cut.declaration} has an empty fixture range`);
      assert.equal(
        cut.sourceEnd - cut.sourceStart,
        cut.fixtureEnd - cut.fixtureStart,
        `${cut.declaration} has different lengths in the chunk and the fixture, so a byte range could not be translated`,
      );
    }
  }
});

void test('the manifest records the versions and the atlas the capture came from', () => {
  assert.equal(fixture.manifest.sources.gameVersion, '1176');
  assert.equal(fixture.manifest.sources.artVersion, '1176');
  assert.equal(fixture.manifest.sources.origin, 'https://magicgarden.gg');
  assert.ok(fixture.manifest.sources.atlasPacks.length >= 1);
  assert.match(fixture.manifest.sources.atlasManifest, /version\/1176\/assets\/manifest\.json/);
});

void test('the atlas fixture is exactly the frames the sprite-name table needs, plus a few examples', () => {
  const paths = spritePathsOf(fixture.tables.spriteNames);
  assert.equal(fixture.atlas.frameKeys.length, paths.length);
  const frames = new Set(fixture.atlas.frameKeys);
  const missing = paths.filter((path) => !frames.has(path));
  assert.deepEqual(missing, [], 'the atlas fixture does not cover the name table');
  assert.ok(Object.keys(fixture.atlas.frames).length >= 8, 'too few complete frames to exercise a placement');
  for (const [path, frame] of Object.entries(fixture.atlas.frames)) {
    assert.ok(frames.has(path), `${path} is an example frame the key list does not carry`);
    assert.ok(frame.sourceSize.w > 0 && frame.sourceSize.h > 0, `${path} states no size`);
  }
});

void test('the capture is small enough to review, and is not the bundle', () => {
  const fixtureBytes = [
    'fixture.json',
    'atlas-frames.json',
    ...fixture.manifest.files.map((file) => file.fixture),
  ]
    .map((file) => statSync(join(FIXTURE_DIR, file)).size)
    .reduce((total, size) => total + size, 0);
  assert.ok(
    fixtureBytes < 200_000,
    `the fixture capture is ${fixtureBytes} bytes, which is a bundle, not a fixture`,
  );
  const note = readFileSync(join(FIXTURE_DIR, 'fixture.json'), 'utf8');
  assert.ok(note.includes('byte-identical'), 'the manifest does not explain what a cut is');
});
