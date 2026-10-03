// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';
import { build, type PluginOption } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { createEverframePlugin } from '../src/plugin.js';

// unplugin's Vite types may resolve to a different Vite major than the one under test.
const plugin = (options: Parameters<ReturnType<typeof createEverframePlugin>['vite']>[0], deps: Parameters<typeof createEverframePlugin>[0]) =>
  createEverframePlugin(deps).vite(options) as unknown as PluginOption;

const APP = '00000000-0000-4000-8000-000000000000';

async function app(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'evf-vite-')));
  await writeFile(join(root, 'index.html'), '<script type="module" src="/main.js"></script>');
  await writeFile(join(root, 'main.js'), 'export function boom() { throw new Error("x"); }\nboom();\n');
  return root;
}

describe('vite', () => {
  it('stamps the entry chunk, emits hidden maps and uploads them', async () => {
    const root = await app();
    const upload = vi.fn().mockResolvedValue({ buildUuid: 'u', status: 'ready', artifacts: [] });
    await build({
      root,
      logLevel: 'silent',
      plugins: [plugin({ appId: APP, buildId: 'b1', deleteAfterUpload: false }, { env: { EVERFRAME_API_TOKEN: 't' }, upload })],
    });
    const assets = await readdir(join(root, 'dist', 'assets'));
    const js = assets.find((f) => f.endsWith('.js'))!;
    const code = await readFile(join(root, 'dist', 'assets', js), 'utf8');
    // Vite's minifier may unquote the key, so match either spelling.
    expect(code).toMatch(/globalThis\.__EVERFRAME_BUILD__=\{"?buildId"?:"b1"\}/);
    expect(code).not.toContain('sourceMappingURL');
    expect(assets).toContain(`${js}.map`);
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ buildId: 'b1', root: join(root, 'dist') }));
  });

  it('keeps source-map positions aligned after the banner is prepended', async () => {
    const root = await app();
    await build({
      root,
      logLevel: 'silent',
      build: { minify: false },
      plugins: [plugin({ appId: APP, buildId: 'b1', deleteAfterUpload: false }, { env: { EVERFRAME_API_TOKEN: 't' }, upload: vi.fn().mockResolvedValue({}) })],
    });
    const dir = join(root, 'dist', 'assets');
    const js = (await readdir(dir)).find((f) => f.endsWith('.js'))!;
    const lines = (await readFile(join(dir, js), 'utf8')).split('\n');
    const line = lines.findIndex((l) => l.includes('throw new Error')) + 1;
    expect(line).toBeGreaterThan(1);
    const column = lines[line - 1]!.indexOf('throw');
    const map = new TraceMap(await readFile(join(dir, `${js}.map`), 'utf8'));
    const original = originalPositionFor(map, { line, column });
    expect(original.source).toMatch(/main\.js$/);
    expect(original.line).toBe(1);
  });

  it('does nothing for an SSR build', async () => {
    const root = await app();
    const upload = vi.fn();
    await build({
      root,
      logLevel: 'silent',
      build: { ssr: join(root, 'main.js') },
      plugins: [plugin({ appId: APP }, { env: { CI: 'true' }, upload })],
    });
    expect(upload).not.toHaveBeenCalled();
  });

  it('keeps an explicit user sourcemap setting', async () => {
    const root = await app();
    await build({
      root,
      logLevel: 'silent',
      build: { sourcemap: true },
      plugins: [plugin({ appId: APP, deleteAfterUpload: false }, { env: { EVERFRAME_API_TOKEN: 't' }, upload: vi.fn().mockResolvedValue({}) })],
    });
    const js = (await readdir(join(root, 'dist', 'assets'))).find((f) => f.endsWith('.js'))!;
    expect(await readFile(join(root, 'dist', 'assets', js), 'utf8')).toContain('sourceMappingURL');
  });
});
