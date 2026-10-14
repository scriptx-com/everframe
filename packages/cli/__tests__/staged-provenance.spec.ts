// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { collectStagedBuild } from '../src/build-collect.js';
import { uploadStagedHermes } from '../src/staged-upload.js';
import { uploadExpoExport } from '../src/expo-export.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it.each(['ios', 'android'] as const)(
  'preserves %s build-time provenance through delayed and Expo uploads',
  async (platform) => {
    const root = await mkdtemp(join(tmpdir(), 'staged-vcs-'));
    roots.push(root);
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    await writeFile(join(root, 'source'), 'a');
    git('add', '.');
    git('commit', '-m', 'source');
    const commit = git('rev-parse', 'HEAD');
    const buildId = '8f3ac21e-0000-4000-8000-000000000001';
    const stagingDir = join(root, '.everframe');
    const directory = join(stagingDir, buildId);
    const exportDir = join(root, 'dist/_expo/static/js', platform);
    await mkdir(directory, { recursive: true });
    await mkdir(exportDir, { recursive: true });
    const bundlePath = join(exportDir, 'index.hbc'),
      mapPath = `${bundlePath}.map`;
    const partial = {
      schema: 1,
      buildId,
      platform,
      bundleName: platform === 'android' ? 'index.android.bundle' : 'main.jsbundle',
      dev: false,
      vcs: { commit, branch: 'main', dirty: false },
    };
    await writeFile(join(directory, 'manifest.partial.json'), JSON.stringify(partial));
    await writeFile(
      bundlePath,
      Buffer.concat([
        Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]),
        Buffer.from(buildId),
        Buffer.alloc(64),
      ]),
    );
    await writeFile(
      mapPath,
      JSON.stringify({ version: 3, sources: [`/.everframe/${buildId}/identity.js`], mappings: '' }),
    );
    git('add', '.');
    git('commit', '-m', 'new checkout');
    expect(git('rev-parse', 'HEAD')).not.toBe(commit);
    await collectStagedBuild({ stagingDir, platform, bundlePath, mapPath });
    const manifests: Array<{ vcs?: unknown; artifacts: Array<{ url: string }> }> = [];
    const fetcher: typeof fetch = async (_url, init) => {
      const manifest = JSON.parse(String(init?.body));
      manifests.push(manifest);
      return Response.json({
        buildUuid: '00000000-0000-4000-8000-000000000001',
        status: 'ready',
        artifacts: manifest.artifacts.map((a: { url: string }) => ({
          artifactUuid: '00000000-0000-4000-8000-000000000002',
          url: a.url,
          available: true,
        })),
      });
    };
    const options = {
      stagingDir,
      platform,
      appId: 'app',
      apiUrl: 'https://api.example',
      token: 'token',
    };
    await uploadStagedHermes(options, { fetch: fetcher });
    expect(manifests.at(-1)?.vcs).toEqual(partial.vcs);
    const originalArtifacts = manifests[0]!.artifacts;
    await uploadStagedHermes({ ...options, commit: 'B'.repeat(40) } as never, { fetch: fetcher });
    expect(manifests.at(-1)?.vcs).toEqual({ commit: 'b'.repeat(40) });
    expect(manifests.at(-1)?.artifacts).toEqual(originalArtifacts);
    await uploadExpoExport({ ...options, distDir: join(root, 'dist') }, { fetch: fetcher });
    expect(manifests.at(-1)?.vcs).toEqual(partial.vcs);
    await writeFile(
      join(directory, 'manifest.partial.json'),
      JSON.stringify({ ...partial, vcs: undefined }),
    );
    await collectStagedBuild({ stagingDir, platform, bundlePath, mapPath });
    await uploadStagedHermes(options, { fetch: fetcher });
    expect(manifests.at(-1)?.vcs).toBeUndefined();
  },
);
