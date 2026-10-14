// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it.each(['hermes', 'dsym', 'elf', 'r8'])(
  'sends explicit provenance for direct %s uploads',
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'command-vcs-'));
    roots.push(root);
    const file = join(root, 'artifact'),
      map = join(root, 'map');
    await writeFile(file, Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f, 0]));
    await writeFile(map, '{}');
    let received: any;
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      received = JSON.parse(String(init.body));
      return Response.json({
        buildUuid: 'b',
        status: 'ready',
        artifacts: received.artifacts.map((a: any) => ({
          artifactUuid: 'a',
          url: a.url,
          available: true,
        })),
      });
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const args =
      kind === 'hermes'
        ? [
            'sourcemaps',
            'upload-hermes',
            '--build',
            'b',
            '--platform',
            'ios',
            '--bundle-name',
            'main.jsbundle',
            '--bundle',
            file,
            '--source-map',
            map,
          ]
        : kind === 'dsym'
          ? ['dsym', 'upload', '--dwarf', file]
          : kind === 'elf'
            ? ['elf', 'upload', '--library', file]
            : ['r8', 'upload', '--mapping-id', 'b', '--mapping', file];
    const code = await main([...args, '--app-id', 'app', '--commit', 'B'.repeat(40)], {
      EVERFRAME_API_TOKEN: 'token',
      EVERFRAME_API_URL: 'https://api.example',
    });
    expect(code).toBe(0);
    expect(received.vcs).toEqual({ commit: 'b'.repeat(40) });
  },
);
