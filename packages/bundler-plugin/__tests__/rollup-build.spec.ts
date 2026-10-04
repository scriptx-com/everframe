// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rollup } from 'rollup';
import { describe, expect, it, vi } from 'vitest';
import { createEverframePlugin } from '../src/plugin.js';

const APP = '00000000-0000-4000-8000-000000000000';

describe('rollup', () => {
  it('uploads from the directory of output.file and stamps the bundle', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'evf-rollup-')));
    await writeFile(join(root, 'main.js'), 'console.log(1);\n');
    const upload = vi.fn().mockResolvedValue({});
    const bundle = await rollup({
      input: join(root, 'main.js'),
      plugins: [createEverframePlugin({ env: { EVERFRAME_API_TOKEN: 't' }, upload }).rollup({ appId: APP, buildId: 'b1', deleteAfterUpload: false })],
    });
    await bundle.write({ file: join(root, 'build', 'bundle.js'), format: 'es' });
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ root: join(root, 'build') }));
    expect(await readFile(join(root, 'build', 'bundle.js'), 'utf8')).toContain('__EVERFRAME_BUILD__');
  });
});
