// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveExpoAppId, uploadExpoExport } from '../src/expo-export.js';

const HERMES_MAGIC = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);
const APP = '00000000-0000-4000-8000-0000000000a0';
const APP1 = '00000000-0000-4000-8000-0000000000a1';
const APP2 = '00000000-0000-4000-8000-0000000000a2';
const APP3 = '00000000-0000-4000-8000-0000000000a3';
const API = 'https://api.example/api/v1';
const BUILD_UUID = '00000000-0000-4000-8000-0000000000b0';
const buildId = '8f3ac21e-0000-4000-8000-000000000001';

async function makeExpoProject(options: {
  platforms: Array<'android' | 'ios'>;
  extraBundle?: boolean;
  staged?: boolean;
}): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), 'everframe-expo-'));
  const staging = join(project, '.everframe');
  for (const platform of options.platforms) {
    const dir = join(project, 'dist', '_expo', 'static', 'js', platform);
    await mkdir(dir, { recursive: true });
    const names = options.extraBundle ? ['index-abc.hbc', 'index-def.hbc'] : ['index-abc.hbc'];
    for (const name of names) {
      await writeFile(join(dir, name), Buffer.concat([HERMES_MAGIC, Buffer.alloc(64)]));
      await writeFile(join(dir, `${name}.map`), JSON.stringify({ version: 3, sources: [], mappings: '' }));
    }
    if (options.staged === false) continue;
    await mkdir(join(staging, buildId), { recursive: true });
    await writeFile(join(staging, `latest-${platform}.json`), JSON.stringify({ buildId }));
    await writeFile(
      join(staging, buildId, 'manifest.partial.json'),
      JSON.stringify({ schema: 1, buildId, platform, bundleName: `index.${platform}.bundle`, dev: false }),
    );
  }
  return project;
}

/** Reserve answers `ready` straight away, echoing the manifest's artifact URLs. */
function successfulUploadFetch(): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const manifest = JSON.parse(String(init?.body ?? '{}')) as { artifacts?: Array<{ url: string }> };
    const body = {
      buildUuid: BUILD_UUID,
      status: 'ready',
      artifacts: (manifest.artifacts ?? []).map((artifact, index) => ({
        artifactUuid: `00000000-0000-4000-8000-00000000c00${index}`,
        url: artifact.url,
        available: true,
      })),
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const base = (project: string) => ({
  distDir: join(project, 'dist'),
  stagingDir: join(project, '.everframe'),
  appId: APP,
  apiUrl: API,
  token: 't',
});

describe('uploadExpoExport', () => {
  it('uploads every exported platform in one call', async () => {
    const project = await makeExpoProject({ platforms: ['android'] });
    const results = await uploadExpoExport(base(project), { fetch: successfulUploadFetch(), wait: async () => {} });
    expect(results).toEqual([{ platform: 'android', buildUuid: expect.any(String) }]);
  });

  it('fails clearly when nothing was exported', async () => {
    const project = await makeExpoProject({ platforms: [] });
    await expect(uploadExpoExport(base(project))).rejects.toThrow('no_expo_export');
  });

  it('refuses two bundles for one platform', async () => {
    const project = await makeExpoProject({ platforms: ['android'], extraBundle: true });
    await expect(uploadExpoExport(base(project))).rejects.toThrow('expo_export_ambiguous:android');
  });

  it('names withEverframe when metro never staged the platform', async () => {
    const project = await makeExpoProject({ platforms: ['android'], staged: false });
    await expect(uploadExpoExport(base(project))).rejects.toThrow(/withEverframe/);
  });
});

describe('resolveExpoAppId', () => {
  it('prefers the flag, then EVERFRAME_APP_ID, then app.json', async () => {
    const project = await mkdtemp(join(tmpdir(), 'evf-appjson-'));
    await writeFile(join(project, 'app.json'), JSON.stringify({ expo: { plugins: [['@everframe/expo', { appId: APP3 }]] } }));
    expect(await resolveExpoAppId(APP1, { EVERFRAME_APP_ID: APP2 }, project)).toBe(APP1);
    expect(await resolveExpoAppId(undefined, { EVERFRAME_APP_ID: APP2 }, project)).toBe(APP2);
    expect(await resolveExpoAppId(undefined, {}, project)).toBe(APP3);
  });

  it('fails without any source', async () => {
    const project = await mkdtemp(join(tmpdir(), 'evf-appjson-'));
    await expect(resolveExpoAppId(undefined, {}, project)).rejects.toThrow('missing_app_id');
  });
});
