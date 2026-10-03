// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { finishBuild, identityBanner, resolveSettings } from '../src/core.js';

const APP = '00000000-0000-4000-8000-000000000000';

async function output(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'evf-out-'));
  await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'assets', 'a.js'), 'x');
  await writeFile(join(dir, 'assets', 'a.js.map'), '{}');
  return dir;
}

describe('resolveSettings', () => {
  it('generates a fresh build id unless one is given', () => {
    const a = resolveSettings({ appId: APP }, {});
    const b = resolveSettings({ appId: APP }, {});
    expect(a.buildId).not.toBe(b.buildId);
    expect(resolveSettings({ appId: APP }, { EVERFRAME_BUILD_ID: 'env-id' }).buildId).toBe('env-id');
    expect(resolveSettings({ appId: APP, buildId: 'opt' }, { EVERFRAME_BUILD_ID: 'env-id' }).buildId).toBe('opt');
  });

  it('detects CI from CI=true or CI=1', () => {
    expect(resolveSettings({ appId: APP }, { CI: 'true' }).ci).toBe(true);
    expect(resolveSettings({ appId: APP }, { CI: '1' }).ci).toBe(true);
    expect(resolveSettings({ appId: APP }, { CI: 'false' }).ci).toBe(false);
  });

  it('rejects a missing or non-uuid app id', () => {
    expect(() => resolveSettings({ appId: '' }, {})).toThrow(/appId/);
  });
});

describe('identityBanner', () => {
  it('assigns the build id as a JSON-safe literal', () => {
    expect(identityBanner('a"b')).toBe('globalThis.__EVERFRAME_BUILD__={"buildId":"a\\"b"};');
  });
});

describe('finishBuild', () => {
  it('uploads with path-only urls and the resolved build id', async () => {
    const dir = await output();
    const upload = vi.fn().mockResolvedValue({ buildUuid: 'u', status: 'ready', artifacts: [] });
    await finishBuild(dir, resolveSettings({ appId: APP, buildId: 'b1' }, { EVERFRAME_API_TOKEN: 't' }), { upload });
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ appId: APP, buildId: 'b1', root: dir, token: 't', deleteAfterUpload: true }));
    expect(upload.mock.calls[0]![0]).not.toHaveProperty('urlPrefix');
  });

  it('fails in CI without a token', async () => {
    const dir = await output();
    await expect(finishBuild(dir, resolveSettings({ appId: APP }, { CI: 'true' }))).rejects.toThrow('missing_api_token');
  });

  it('warns, skips and deletes maps locally without a token', async () => {
    const dir = await output();
    const log = vi.fn();
    const upload = vi.fn();
    await finishBuild(dir, resolveSettings({ appId: APP }, {}), { upload, log });
    expect(upload).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('EVERFRAME_API_TOKEN'));
    expect(await readdir(join(dir, 'assets'))).toEqual(['a.js']);
  });

  it('fails the build when upload fails', async () => {
    const dir = await output();
    const upload = vi.fn().mockRejectedValue(new Error('request_failed:storage_unavailable'));
    await expect(finishBuild(dir, resolveSettings({ appId: APP }, { EVERFRAME_API_TOKEN: 't' }), { upload })).rejects.toThrow('storage_unavailable');
  });
});
