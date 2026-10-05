// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readComplete, readPartial, readPointer, writeComplete } from '../src/staging-io.js';

const buildId = '8f3ac21e-0000-4000-8000-000000000001';
const partial = {
  schema: 1 as const,
  buildId,
  platform: 'android' as const,
  bundleName: 'index.android.bundle',
  dev: false,
};

let staging: string;
beforeEach(async () => {
  staging = join(await mkdtemp(join(tmpdir(), 'everframe-cli-')), '.everframe');
  await mkdir(join(staging, buildId), { recursive: true });
  await writeFile(join(staging, 'latest-android.json'), JSON.stringify({ buildId }));
  await writeFile(join(staging, buildId, 'manifest.partial.json'), JSON.stringify(partial));
});
afterEach(async () => { await rm(staging, { recursive: true, force: true }); });

describe('staging io', () => {
  it('resolves the pointer to a build id', async () => {
    expect(await readPointer(staging, 'android')).toBe(buildId);
  });

  it('throws no_staged_build when the platform was never bundled', async () => {
    await expect(readPointer(staging, 'ios')).rejects.toThrow('no_staged_build');
  });

  it('reads the partial manifest', async () => {
    expect((await readPartial(staging, buildId)).bundleName).toBe('index.android.bundle');
  });

  it('throws manifest_not_collected before collect has run', async () => {
    await expect(readComplete(staging, buildId)).rejects.toThrow('manifest_not_collected');
  });

  it('round-trips a completed manifest', async () => {
    const staged = {
      ...partial,
      bundlePath: '/b/index.android.bundle',
      mapPath: '/b/index.android.bundle.map',
      generatedSha256: 'a'.repeat(64),
      mapSha256: 'b'.repeat(64),
      mapBytes: 4096,
    };
    await writeComplete(staging, staged);
    expect(await readComplete(staging, buildId)).toMatchObject(staged);
  });

  it('rejects a build id containing a path separator', async () => {
    await expect(readPartial(staging, '../escape')).rejects.toThrow('invalid_build_id');
  });

  it('throws invalid_staged_manifest when partial manifest has wrong schema', async () => {
    await writeFile(join(staging, buildId, 'manifest.partial.json'), JSON.stringify({ schema: 99 }));
    await expect(readPartial(staging, buildId)).rejects.toThrow('invalid_staged_manifest');
  });

  it('throws invalid_staged_manifest when complete manifest has wrong schema', async () => {
    await writeFile(join(staging, buildId, 'manifest.json'), JSON.stringify({ schema: 99 }));
    await expect(readComplete(staging, buildId)).rejects.toThrow('invalid_staged_manifest');
  });

  it('still throws manifest_not_collected when complete manifest is missing', async () => {
    await expect(readComplete(staging, buildId)).rejects.toThrow('manifest_not_collected');
  });
});
