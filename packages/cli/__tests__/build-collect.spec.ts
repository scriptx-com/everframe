// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectStagedBuild } from '../src/build-collect.js';
import { readComplete, readPointer } from '../src/staging-io.js';

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
  await writeFile(bundlePath, Buffer.concat([HERMES_MAGIC, Buffer.from(buildId), Buffer.alloc(64)]));
  await writeFile(mapPath, JSON.stringify({ version: 3, sources: [`/.everframe/${buildId}/identity.js`], mappings: '' }));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('collectStagedBuild', () => {
  it('selects the artifact identity after a later Metro configuration replaces the latest pointer', async () => {
    const newer='22222222-2222-4222-8222-222222222222';
    await mkdir(join(staging,newer));
    await writeFile(join(staging,newer,'manifest.partial.json'),JSON.stringify({schema:1,buildId:newer,platform:'android',bundleName:'index.android.bundle',dev:false}));
    await writeFile(join(staging,'latest-android.json'),JSON.stringify({buildId:newer}));
    const result=await collectStagedBuild({stagingDir:staging,platform:'android',bundlePath,mapPath});
    expect(result.buildId).toBe(buildId);
    expect(await readPointer(staging,'android')).toBe(buildId);
    await expect(readComplete(staging,newer)).rejects.toThrow('manifest_not_collected');
  });
  it('does not promote an artifact with wrong compiled identity', async () => {
    const before=await readFile(join(staging,'latest-android.json'),'utf8');
    await writeFile(bundlePath,Buffer.concat([HERMES_MAGIC,Buffer.alloc(64)]));
    await expect(collectStagedBuild({stagingDir:staging,platform:'android',bundlePath,mapPath})).rejects.toThrow('compiled_build_identity_missing');
    expect(await readFile(join(staging,'latest-android.json'),'utf8')).toBe(before);
    await expect(readComplete(staging,buildId)).rejects.toThrow('manifest_not_collected');
  });
  it('rejects a staged partial whose platform does not match the artifact', async () => {
    const file=join(staging,buildId,'manifest.partial.json');
    const partial=JSON.parse(await readFile(file,'utf8'));partial.platform='ios';await writeFile(file,JSON.stringify(partial));
    await expect(collectStagedBuild({stagingDir:staging,platform:'android',bundlePath,mapPath})).rejects.toThrow('staged_identity_mismatch');
  });
  it('reports a missing staged partial for the map identity, not a missing Metro wrapper', async () => {
    const before = await readFile(join(staging, 'latest-android.json'), 'utf8');
    await rm(join(staging, buildId, 'manifest.partial.json'));
    await expect(
      collectStagedBuild({ stagingDir: staging, platform: 'android', bundlePath, mapPath }),
    ).rejects.toThrow('staged_partial_missing');
    expect(await readFile(join(staging, 'latest-android.json'), 'utf8')).toBe(before);
  });
  it('rejects a composed map without the generated identity and keeps the pointer', async () => {
    const before = await readFile(join(staging, 'latest-android.json'), 'utf8');
    await writeFile(mapPath, JSON.stringify({ version: 3, sources: [], mappings: '' }));
    await expect(
      collectStagedBuild({ stagingDir: staging, platform: 'android', bundlePath, mapPath }),
    ).rejects.toThrow('missing_bundle_identity');
    expect(await readFile(join(staging, 'latest-android.json'), 'utf8')).toBe(before);
    await expect(readComplete(staging, buildId)).rejects.toThrow('manifest_not_collected');
  });

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

  it('rejects an artifact requested under the wrong platform', async () => {
    await expect(
      collectStagedBuild({ stagingDir: staging, platform: 'ios', bundlePath, mapPath }),
    ).rejects.toThrow('staged_identity_mismatch');
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
