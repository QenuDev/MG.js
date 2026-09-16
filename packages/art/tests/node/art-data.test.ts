/**
 * The tables the package ships, read the way a consumer with no checkout can read them.
 *
 * `data/<version>.json` is the game's tables and it is the whole of what a consumer needs before
 * `cropComposition` can answer anything -- but it lived inside the package with nothing pointing at it:
 * `parseArtData` takes the file's *text*, and the text is at a path only this repository knows. A published
 * copy that did not carry the directory, or a loader that could not reach it, is an installed package that
 * silently cannot draw a crop.
 *
 * So this file checks both halves of that, against the package as it is:
 *
 *   - the install half: `package.json`'s `files` carries `data`, which is what decides whether the directory
 *     is in the tarball at all (`npm pack --dry-run` is the authority; this asserts the declaration).
 *   - the read half: `readArtData` resolves the file from the module's own URL, parses it through the same
 *     contract check `parseArtData` applies to a fetched document, and equals what reading the committed
 *     file by hand gives.
 *
 * And the refusal, which is the part that keeps the loader from being a path built out of caller input.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { ArtDataError, parseArtData } from '../../src/bundle/data.ts';
import { artDataVersions, readArtData } from '../../src/node/index.ts';

const HERE = new URL('../../', import.meta.url);

void test('the shipped data directory is declared as part of the package', () => {
  const manifest = JSON.parse(readFileSync(new URL('package.json', HERE), 'utf8')) as {
    files?: readonly string[];
  };

  assert.ok(manifest.files?.includes('data'), 'package.json’s files must carry the data directory');
  // The other three, unchanged, so this test says the directory was added rather than swapped for one.
  for (const kept of ['dist', 'src', 'assets']) {
    assert.ok(manifest.files?.includes(kept), `files still carries ${kept}`);
  }
});

void test('the versions the package ships are the table files beside it', () => {
  const versions = artDataVersions();

  assert.ok(versions.length >= 1, 'the package ships at least one version of tables');
  // Name order is all this promises. It was previously justified here as "so a caller can take the last", which
  // is only true while every version has the same number of digits: '990' sorts after '1192'. A caller that
  // wants the newest has to compare the numbers — the viewer does exactly that, and this comment was inviting
  // the bug it avoids.
  assert.deepEqual(versions, [...versions].sort(), 'in name order');
  for (const version of versions) {
    const bytes = readFileSync(new URL(`data/${version}.json`, HERE));
    assert.ok(bytes.byteLength > 0, `${version}.json is not empty`);
  }
});

void test('readArtData answers the same tables as reading the committed file, for every version it ships', () => {
  // Every version, not the first one: the caller names a version precisely so that more than one can be
  // shipped, and a loader checked against a single file is a loader checked against the case it was written
  // for. The two version names also have to be answered from their own files rather than from each other.
  const read: string[] = [];
  for (const version of artDataVersions()) {
    const data = readArtData(version);
    const byHand = parseArtData(readFileSync(new URL(`data/${version}.json`, HERE), 'utf8'));

    assert.deepEqual(data, byHand, `the loader reads ${version} and applies the same contract check`);
    assert.equal(data.gameVersion, byHand.gameVersion, 'with the game version stamped inside it');
    assert.equal(data.artVersion, byHand.artVersion, 'and the art version it was read at');
    // A table no other entry can hand a caller without the file: the mutation art, which is what a wash needs.
    assert.ok(
      Object.keys(data.tables.mutationArt).includes('Frozen'),
      `the tables a consumer reads for ${version} are the game's mutation art`,
    );
    read.push(data.gameVersion);
  }
  assert.equal(new Set(read).size, read.length, 'two shipped versions answered with the same game version');
});

void test('a version the package does not ship is refused, not resolved as a path', () => {
  // The three shapes a caller-built path has to survive: an unknown version, a relative hop out of the
  // directory, and the filename itself. Each names what is shipped instead of throwing ENOENT.
  for (const version of ['9999', '../1176', '1176.json', '']) {
    assert.throws(
      () => readArtData(version),
      (error: unknown) => {
        assert.ok(error instanceof ArtDataError, `${JSON.stringify(version)} is refused as art data`);
        assert.match(error.message, /ships no tables for game version/);
        assert.match(error.message, new RegExp(artDataVersions().join('|')), 'and names what it ships');
        return true;
      },
      `${JSON.stringify(version)} must not reach readFileSync`,
    );
  }
});
