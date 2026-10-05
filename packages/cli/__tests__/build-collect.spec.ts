// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectStagedBuild } from '../src/build-collect.js';
import { readComplete } from '../src/staging-io.js';

const HERMES_MAGIC = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);
const buildId = '8f3ac21e-0000-4000-8000-000000000001';

let root: string;
let staging: string;
let bundlePath: string;
let mapPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'everframe-collect-'));
  staging = join(root, '.everframe');
  await mkdir(join(staging, buildId), { recursive: true });
  await writeFile(join(staging, 'latest-android.json'), JSON.stringify({ buildId }));
  await writeFile(
    join(staging, buildId, 'manifest.partial.json'),
    JSON.stringify({
      schema: 1,
      buildId,
      platform: 'android',
      bundleName: 'index.android.bundle',
      dev: false,
    }),
  );
  bundlePath = join(root, 'index.android.bundle');
  mapPath = join(root, 'index.android.bundle.map');
  await writeFile(bundlePath, Buffer.concat([HERMES_MAGIC, Buffer.alloc(64)]));
  await writeFile(mapPath, JSON.stringify({ version: 3, sources: [], mappings: '' }));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('collectStagedBuild', () => {
  it('completes the manifest with hashes and sizes', async () => {
    const staged = await collectStagedBuild({
      stagingDir: staging, platform: 'android', bundlePath, mapPath,
    });
    expect(staged.buildId).toBe(buildId);
    expect(staged.generatedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(staged.mapBytes).toBeGreaterThan(0);
  });

  it('persists the completed manifest for later steps', async () => {
    await collectStagedBuild({ stagingDir: staging, platform: 'android', bundlePath, mapPath });
    expect((await readComplete(staging, buildId)).bundlePath).toBe(bundlePath);
  });

  it('rejects a bundle that is not hermes bytecode', async () => {
    await writeFile(bundlePath, 'console.log("plain js")');
    await expect(
      collectStagedBuild({ stagingDir: staging, platform: 'android', bundlePath, mapPath }),
    ).rejects.toThrow('invalid_hermes_bytecode');
  });

  it('rejects an empty source map', async () => {
    await writeFile(mapPath, '');
    await expect(
      collectStagedBuild({ stagingDir: staging, platform: 'android', bundlePath, mapPath }),
    ).rejects.toThrow('source_map_empty');
  });

  it('names the bundle when --bundle does not exist', async () => {
    await expect(
      collectStagedBuild({
        stagingDir: staging,
        platform: 'android',
        bundlePath: join(root, 'nope.bundle'),
        mapPath,
      }),
    ).rejects.toThrow('bundle_not_found');
  });

  it('names the source map when --source-map does not exist', async () => {
    await expect(
      collectStagedBuild({
        stagingDir: staging,
        platform: 'android',
        bundlePath,
        mapPath: join(root, 'nope.map'),
      }),
    ).rejects.toThrow('source_map_not_found');
  });

  it('fails when metro never staged this platform', async () => {
    await expect(
      collectStagedBuild({ stagingDir: staging, platform: 'ios', bundlePath, mapPath }),
    ).rejects.toThrow('no_staged_build');
  });

  it('records native identity when a dsym directory is supplied', async () => {
    const run = async () =>
      'UUID: 8D6D4A1C-0F2B-3C4D-9E5F-6A7B8C9D0E1F (arm64) /tmp/App.dSYM/Contents/Resources/DWARF/App';
    const staged = await collectStagedBuild({
      stagingDir: staging, platform: 'android', bundlePath, mapPath, dsymDir: '/tmp/App.dSYM', run,
    });
    expect(staged.native?.dsym).toHaveLength(1);
  });
});
