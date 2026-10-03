// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it, vi } from 'vitest';
import { applyWebpack } from '../src/plugin.js';
import { resolveSettings } from '../src/core.js';

const APP = '00000000-0000-4000-8000-000000000000';

function fakeCompiler(devtool: unknown) {
  const afterEmit: Array<() => Promise<void>> = [];
  const applied: unknown[] = [];
  return {
    compiler: {
      options: { devtool, mode: 'production', output: { path: '/out' } },
      webpack: { BannerPlugin: class { constructor(public opts: unknown) {} apply() { applied.push(this.opts); } } },
      hooks: { afterEmit: { tapPromise: (_n: string, fn: () => Promise<void>) => afterEmit.push(fn) } },
    },
    afterEmit,
    applied,
  };
}

describe('webpack', () => {
  it('defaults to hidden maps, adds an entry-only raw banner and uploads after emit', async () => {
    const fake = fakeCompiler(false);
    const finish = vi.fn().mockResolvedValue(undefined);
    applyWebpack(fake.compiler as never, resolveSettings({ appId: APP, buildId: 'b1' }, {}), finish);
    expect(fake.compiler.options.devtool).toBe('hidden-source-map');
    expect(fake.applied).toEqual([expect.objectContaining({ entryOnly: true, raw: true, banner: expect.stringContaining('"b1"') })]);
    await fake.afterEmit[0]!();
    expect(finish).toHaveBeenCalledWith('/out');
  });

  it('keeps a user devtool and skips development builds', () => {
    const user = fakeCompiler('source-map');
    applyWebpack(user.compiler as never, resolveSettings({ appId: APP }, {}), vi.fn());
    expect(user.compiler.options.devtool).toBe('source-map');
    const dev = fakeCompiler(false);
    dev.compiler.options.mode = 'development';
    applyWebpack(dev.compiler as never, resolveSettings({ appId: APP }, {}), vi.fn());
    expect(dev.afterEmit).toHaveLength(0);
  });
});
