// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withEverframe, type EverframeBundlerOptions } from '../src/next.js';

const APP = '00000000-0000-4000-8000-000000000000';

// The parts of next's `NextConfig` the wrapper touches, with next's exact types.
interface NextConfigShape {
  reactStrictMode?: boolean;
  webpack?: ((config: any, options: any) => any) | null;
  turbopack?: { rules?: Record<string, unknown> };
}

interface CompilerLike {
  options: { devtool?: unknown; mode: string; output: { path: string } };
  webpack: { BannerPlugin: new (o: unknown) => { apply(): void } };
  hooks: { afterEmit: { tapPromise(name: string, fn: () => Promise<void>): void } };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  vi.unstubAllEnvs();
});

describe('withEverframe (next)', () => {
  it('adds the plugin to client production builds only and keeps the user webpack hook', () => {
    const user = vi.fn((config: { plugins: unknown[] }) => config);
    const next = withEverframe({ reactStrictMode: true, webpack: user }, { appId: APP });
    const client = next.webpack!({ plugins: [] }, { isServer: false, dev: false });
    const server = next.webpack!({ plugins: [] }, { isServer: true, dev: false });
    const dev = next.webpack!({ plugins: [] }, { isServer: false, dev: true });
    expect(user).toHaveBeenCalledTimes(3);
    expect(client.plugins).toHaveLength(1);
    expect(server.plugins).toHaveLength(0);
    expect(dev.plugins).toHaveLength(0);
    expect(next.reactStrictMode).toBe(true);
  });

  it('accepts a NextConfig-typed object and a null webpack hook', () => {
    const options: EverframeBundlerOptions = { appId: APP };
    const typed: NextConfigShape = { reactStrictMode: true, webpack: null };
    const wrapped: NextConfigShape = withEverframe(typed, options);
    expect(wrapped.webpack!({ plugins: [] }, { isServer: false, dev: false }).plugins).toHaveLength(1);
  });

  it('adds an empty turbopack config unless one is set', () => {
    expect(withEverframe({}, { appId: APP }).turbopack).toEqual({});
    const rules = { '*.svg': {} };
    expect(withEverframe({ turbopack: { rules } }, { appId: APP }).turbopack).toEqual({ rules });
  });

  it('warns once that Turbopack builds are not stamped or uploaded', async () => {
    vi.resetModules();
    const fresh = await import('../src/next.js');
    fresh.withEverframe({}, { appId: APP });
    fresh.withEverframe({}, { appId: APP });
    const turbopack = warn.mock.calls.filter(([m]: unknown[]) => String(m).includes('Turbopack'));
    expect(turbopack).toHaveLength(1);
    expect(String(turbopack[0]![0])).toContain('next build --webpack');
  });

  it('uploads only the static client output, never server chunks', async () => {
    vi.stubEnv('EVERFRAME_API_TOKEN', '');
    vi.stubEnv('CI', '');
    const dir = await mkdtemp(join(tmpdir(), 'evf-next-'));
    await mkdir(join(dir, 'static', 'chunks'), { recursive: true });
    await mkdir(join(dir, 'server'));
    await writeFile(join(dir, 'static', 'chunks', 'a.js'), 'x');
    await writeFile(join(dir, 'static', 'chunks', 'a.js.map'), '{}');
    await writeFile(join(dir, 'server', 'b.js'), 'x');
    await writeFile(join(dir, 'server', 'b.js.map'), '{}');
    const afterEmit: Array<() => Promise<void>> = [];
    const compiler: CompilerLike = {
      options: { mode: 'production', output: { path: dir } },
      webpack: { BannerPlugin: class { apply() {} } },
      hooks: { afterEmit: { tapPromise: (_n, fn) => void afterEmit.push(fn) } },
    };
    const config = withEverframe({}, { appId: APP }).webpack!({ plugins: [] }, { isServer: false, dev: false });
    (config.plugins[0] as { apply(c: CompilerLike): void }).apply(compiler);
    await afterEmit[0]!();
    // Without a token the plugin deletes the maps under its upload root, so this shows the root.
    expect(await readdir(join(dir, 'static', 'chunks'))).toEqual(['a.js']);
    expect((await readdir(join(dir, 'server'))).sort()).toEqual(['b.js', 'b.js.map']);
  });
});
