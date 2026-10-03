// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { parseStagedBuild, parseStagedBuildPartial } from '../src/index.js';

const partial = {
  schema: 1,
  buildId: '8f3ac21e-0000-4000-8000-000000000001',
  platform: 'android',
  bundleName: 'index.android.bundle',
  dev: false,
};

const complete = {
  ...partial,
  bundlePath: '/build/index.android.bundle',
  mapPath: '/build/index.android.bundle.map',
  generatedSha256: 'a'.repeat(64),
  mapSha256: 'b'.repeat(64),
  mapBytes: 2048,
};

describe('staged build schema', () => {
  it('accepts a valid partial manifest', () => {
    expect(parseStagedBuildPartial(partial).buildId).toBe(partial.buildId);
  });

  it('accepts a valid complete manifest', () => {
    expect(parseStagedBuild(complete).mapBytes).toBe(2048);
  });

  it('rejects a bundleName the protocol would reject', () => {
    expect(() => parseStagedBuildPartial({ ...partial, bundleName: '../escape' })).toThrow();
  });

  it('rejects a non-hex sha256', () => {
    expect(() => parseStagedBuild({ ...complete, mapSha256: 'zz' })).toThrow();
  });

  it('rejects a zero-byte map', () => {
    expect(() => parseStagedBuild({ ...complete, mapBytes: 0 })).toThrow();
  });

  it('defaults native identity to empty arrays', () => {
    const parsed = parseStagedBuild({ ...complete, native: {} });
    expect(parsed.native).toEqual({ dsym: [], elf: [] });
  });
});
