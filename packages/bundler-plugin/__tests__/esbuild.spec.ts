// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';
import { createEverframePlugin } from '../src/plugin.js';

const APP = '00000000-0000-4000-8000-000000000000';

async function setup(env: NodeJS.ProcessEnv = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'evf-esbuild-')));
  await writeFile(join(root, 'main.js'), 'console.log(1);\n');
  const upload = vi.fn().mockResolvedValue({});
  const plugin = createEverframePlugin({ env: { EVERFRAME_API_TOKEN: 't', ...env }, upload }).esbuild({ appId: APP, buildId: 'b1', deleteAfterUpload: false });
  return { root, upload, plugin };
}

describe('esbuild', () => {
  it('stamps and uploads from outdir for a minified build', async () => {
    const { root, upload, plugin } = await setup();
    await build({ entryPoints: [join(root, 'main.js')], bundle: true, minify: true, outdir: join(root, 'out'), plugins: [plugin], logLevel: 'silent' });
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ root: join(root, 'out') }));
    expect(await readFile(join(root, 'out', 'main.js'), 'utf8')).toContain('__EVERFRAME_BUILD__');
  });

  it('uploads from the directory of outfile', async () => {
    const { root, upload, plugin } = await setup();
    await build({ entryPoints: [join(root, 'main.js')], bundle: true, minify: true, outfile: join(root, 'dist', 'app.js'), plugins: [plugin], logLevel: 'silent' });
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ root: join(root, 'dist') }));
  });

  it('does nothing without minify or NODE_ENV=production', async () => {
    const { root, upload, plugin } = await setup();
    await build({ entryPoints: [join(root, 'main.js')], bundle: true, outdir: join(root, 'out'), plugins: [plugin], logLevel: 'silent' });
    expect(upload).not.toHaveBeenCalled();
    expect(await readFile(join(root, 'out', 'main.js'), 'utf8')).not.toContain('__EVERFRAME_BUILD__');
  });

  it('is active when the injected env says NODE_ENV=production', async () => {
    const { root, upload, plugin } = await setup({ NODE_ENV: 'production' });
    await build({ entryPoints: [join(root, 'main.js')], bundle: true, outdir: join(root, 'out'), plugins: [plugin], logLevel: 'silent' });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('stamps but skips upload with a warning for write:false', async () => {
    const { root, upload, plugin } = await setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await build({ entryPoints: [join(root, 'main.js')], bundle: true, minify: true, write: false, outdir: join(root, 'out'), plugins: [plugin], logLevel: 'silent' });
    expect(upload).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('everframe: esbuild write:false, skipping source-map upload');
    expect(result.outputFiles!.some((f) => f.text.includes('__EVERFRAME_BUILD__'))).toBe(true);
    warn.mockRestore();
  });
});
