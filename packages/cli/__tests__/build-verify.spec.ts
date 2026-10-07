// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adviceFor, verifyStagedBuild } from '../src/build-verify.js';

const buildId = '8f3ac21e-0000-4000-8000-000000000001';
const base = {
  schema: 1,
  buildId,
  platform: 'android',
  bundleName: 'index.android.bundle',
  dev: false,
  bundlePath: '/b/index.android.bundle',
  mapPath: '/b/index.android.bundle.map',
  generatedSha256: 'a'.repeat(64),
  mapSha256: 'b'.repeat(64),
  mapBytes: 4096,
};

let staging: string;
beforeEach(async () => {
  staging = join(await mkdtemp(join(tmpdir(), 'everframe-verify-')), '.everframe');
  await mkdir(join(staging, buildId), { recursive: true });
  await writeFile(join(staging, 'latest-android.json'), JSON.stringify({ buildId }));
  await writeFile(join(staging, buildId, 'manifest.partial.json'), JSON.stringify(base));
});
afterEach(async () => { await rm(staging, { recursive: true, force: true }); });

const options = { stagingDir: '', platform: 'android' as const, release: true, allowMissing: false, hasToken: true };

describe('verifyStagedBuild', () => {
  it('passes when the manifest is complete', async () => {
    await writeFile(join(staging, buildId, 'manifest.json'), JSON.stringify(base));
    const result = await verifyStagedBuild({ ...options, stagingDir: staging });
    expect(result).toEqual({ ok: true, failures: [], warnings: [] });
  });

  it('fails a release build when collect never ran', async () => {
    const result = await verifyStagedBuild({ ...options, stagingDir: staging });
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('manifest_not_collected');
  });

  it('warns instead of failing on a dev build', async () => {
    const result = await verifyStagedBuild({ ...options, stagingDir: staging, release: false });
    expect(result.ok).toBe(true);
    expect(result.warnings[0]).toContain('manifest_not_collected');
  });

  it('downgrades failures when allow-missing is set', async () => {
    const result = await verifyStagedBuild({ ...options, stagingDir: staging, allowMissing: true });
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });

  it('fails a release build with no token', async () => {
    await writeFile(join(staging, buildId, 'manifest.json'), JSON.stringify(base));
    const result = await verifyStagedBuild({ ...options, stagingDir: staging, hasToken: false });
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('missing_api_token');
  });

  it('is a silent no-op on a dev build with no token', async () => {
    const result = await verifyStagedBuild({
      ...options, stagingDir: staging, release: false, hasToken: false,
    });
    expect(result).toEqual({ ok: true, failures: [], warnings: [] });
  });

  it('warns but does not fail when native identity is empty', async () => {
    await writeFile(
      join(staging, buildId, 'manifest.json'),
      JSON.stringify({ ...base, native: { dsym: [], elf: [] } }),
    );
    const result = await verifyStagedBuild({ ...options, stagingDir: staging });
    expect(result.ok).toBe(true);
  });

  // `build collect` aborts the generated build phase under `set -e` before
  // verify ever runs, so its coded failures have to carry their own advice.
  it('has advice for every code collect and upload-hermes can raise', () => {
    for (const code of [
      'bundle_not_found',
      'source_map_not_found',
      'invalid_hermes_bytecode',
      'source_map_empty',
      'source_map_too_large',
      'missing_bundle_identity',
      'ambiguous_bundle_identity',
      'invalid_bundle_identity',
      'staged_identity_mismatch',
      'compiled_build_identity_missing',
      'staged_partial_missing',
      'staged_bundle_changed',
      'staged_source_map_changed',
    ]) {
      const advice = adviceFor(code);
      expect(advice).not.toBe(code);
      expect(advice.startsWith(`${code}: `)).toBe(true);
      // The CLI's top-level handler truncates at 256 characters.
      expect(advice.length).toBeLessThanOrEqual(256);
    }
  });

  it('leaves an unknown code as-is', () => {
    expect(adviceFor('something_new')).toBe('something_new');
  });

  it('fails a release build that metro never staged', async () => {
    const result = await verifyStagedBuild({ ...options, stagingDir: staging, platform: 'ios' });
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('no_staged_build');
  });
});
