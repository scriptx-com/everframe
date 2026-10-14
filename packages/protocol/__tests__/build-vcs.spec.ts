// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { expect, it } from 'vitest';
import {
  parseManifest,
  parseStagedBuild,
  parseStagedBuildPartial,
} from '../src/build-artifacts.js';
const sha = 'a'.repeat(64);
const map = { mapSha256: sha, mapBytes: 10 };
const manifests = [
  { version: 1, buildId: 'web', artifacts: [{ ...map, generatedSha256: sha, url: '~/app.js' }] },
  {
    version: 2,
    runtime: 'hermes',
    platform: 'ios',
    buildId: 'ios-1',
    artifacts: [{ ...map, generatedSha256: sha, url: 'hermes://ios/main.jsbundle' }],
  },
  {
    version: 3,
    runtime: 'r8',
    platform: 'android',
    buildId: 'ci-1',
    artifacts: [{ ...map, url: 'r8://android/mapping.txt' }],
  },
  {
    version: 4,
    runtime: 'apple',
    platform: 'apple',
    buildId: `dsym:${sha}`,
    artifacts: [{ ...map, url: 'dsym://apple/dwarf' }],
  },
  {
    version: 5,
    runtime: 'android-native',
    platform: 'android',
    buildId: `elf:${sha}`,
    artifacts: [{ ...map, url: 'elf://android/library' }],
  },
];
it.each(manifests)(
  'preserves provenance on manifest v$version without altering legacy content',
  (manifest) => {
    const legacy = parseManifest(manifest);
    const parsed = parseManifest({
      ...manifest,
      vcs: { commit: 'A'.repeat(40), branch: 'release', dirty: false },
    });
    expect(parsed).toEqual({
      ...legacy,
      vcs: { commit: 'a'.repeat(40), branch: 'release', dirty: false },
    });
    const { vcs, ...content } = parsed as typeof parsed & { vcs: unknown };
    expect(JSON.stringify(content)).toBe(JSON.stringify(legacy));
  },
);
it.each([39, 41, 63, 65])('rejects abbreviated or malformed %i-character commits', (length) => {
  expect(() => parseManifest({ ...manifests[0], vcs: { commit: 'a'.repeat(length) } })).toThrow();
});
it.each([
  { commit: 'g'.repeat(40) },
  { commit: 'a'.repeat(40), branch: 'x'.repeat(256) },
  { commit: 'a'.repeat(40), branch: 'a\nb' },
  { commit: 'a'.repeat(40), dirty: 'false' },
])('rejects malformed provenance %j', (vcs) => {
  expect(() => parseManifest({ ...manifests[0], vcs })).toThrow();
});
it('preserves unknown dirty and 64-character commits through staging', () => {
  const partial = {
    schema: 1,
    buildId: 'ios-1',
    platform: 'ios',
    bundleName: 'main.jsbundle',
    dev: false,
    vcs: { commit: 'B'.repeat(64) },
  };
  expect(parseStagedBuildPartial(partial)).toHaveProperty('vcs', { commit: 'b'.repeat(64) });
  expect(
    parseStagedBuild({
      ...partial,
      bundlePath: '/bundle',
      mapPath: '/map',
      generatedSha256: sha,
      ...map,
    }),
  ).toHaveProperty('vcs', { commit: 'b'.repeat(64) });
});
