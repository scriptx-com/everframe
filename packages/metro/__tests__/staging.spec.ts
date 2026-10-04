// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stagingRoot, writeStagedIdentity } from '../src/staging.js';

const partial = {
  schema: 1 as const,
  buildId: '8f3ac21e-0000-4000-8000-000000000001',
  platform: 'android' as const,
  bundleName: 'index.android.bundle',
  dev: false,
};

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'everframe-metro-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('writeStagedIdentity', () => {
  it('is synchronous, returning a plain string path, never a Promise', () => {
    const result = writeStagedIdentity(root, partial);
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof result).toBe('string');
  });

  it('writes the partial manifest under the build id', () => {
    writeStagedIdentity(root, partial);
    const written = JSON.parse(
      readFileSync(join(stagingRoot(root), partial.buildId, 'manifest.partial.json'), 'utf8'),
    );
    expect(written).toEqual(partial);
  });

  it('writes an identity module that assigns the global', () => {
    const path = writeStagedIdentity(root, partial);
    expect(readFileSync(path, 'utf8')).toContain(partial.buildId);
  });

  it('writes a per-platform pointer so the CLI never guesses', () => {
    writeStagedIdentity(root, partial);
    const pointer = JSON.parse(readFileSync(join(stagingRoot(root), 'latest-android.json'), 'utf8'));
    expect(pointer).toEqual({ buildId: partial.buildId });
  });

  it('overwrites the pointer on a second run but keeps both build directories', () => {
    writeStagedIdentity(root, partial);
    const second = { ...partial, buildId: '8f3ac21e-0000-4000-8000-000000000002' };
    writeStagedIdentity(root, second);
    const pointer = JSON.parse(readFileSync(join(stagingRoot(root), 'latest-android.json'), 'utf8'));
    expect(pointer).toEqual({ buildId: second.buildId });
    expect(
      readFileSync(join(stagingRoot(root), partial.buildId, 'manifest.partial.json'), 'utf8'),
    ).toBeTruthy();
  });

  it('keeps platforms independent', () => {
    writeStagedIdentity(root, partial);
    writeStagedIdentity(root, {
      ...partial,
      platform: 'ios',
      bundleName: 'main.jsbundle',
      buildId: '8f3ac21e-0000-4000-8000-000000000003',
    });
    const android = JSON.parse(readFileSync(join(stagingRoot(root), 'latest-android.json'), 'utf8'));
    expect(android).toEqual({ buildId: partial.buildId });
  });
});
