// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { resolve } from 'node:path';
import MagicString from 'magic-string';
import { createUnplugin, type UnpluginInstance } from 'unplugin';
import { finishBuild, identityBanner, resolveSettings, type EverframeBundlerOptions } from './core.js';
import type { uploadBuild } from '@everframe/cli/upload';

export interface PluginDeps {
  env?: NodeJS.ProcessEnv;
  upload?: typeof uploadBuild;
}

/** Factory with injectable env/upload for tests; production code uses `everframeUnplugin`. */
export function createEverframePlugin(deps: PluginDeps = {}): UnpluginInstance<EverframeBundlerOptions, false> {
  return createUnplugin<EverframeBundlerOptions, false>((options) => {
    const settings = resolveSettings(options, deps.env ?? process.env);
    const banner = identityBanner(settings.buildId);
    const finish = (dir: string) => finishBuild(dir, settings, deps.upload ? { upload: deps.upload } : {});
    // MagicString keeps the chunk's map aligned with the prepended banner line.
    const stamp = (code: string) => {
      const s = new MagicString(code);
      s.prepend(`${banner}\n`);
      return { code: s.toString(), map: s.generateMap({ hires: true }) };
    };
    let active = true;
    return {
      name: 'everframe',
      vite: {
        apply: 'build',
        config(config) {
          if (config.build?.ssr) {
            active = false;
            return;
          }
          return { build: { sourcemap: config.build?.sourcemap ?? 'hidden' } };
        },
        renderChunk(code, chunk) {
          if (!active || !chunk.isEntry) return null;
          return stamp(code);
        },
        async writeBundle(output) {
          if (active) await finish(resolve(output.dir ?? 'dist'));
        },
      },
      rollup: {
        outputOptions(output) {
          return { ...output, sourcemap: output.sourcemap ?? 'hidden' };
        },
        renderChunk(code, chunk) {
          if (!chunk.isEntry) return null;
          return stamp(code);
        },
        async writeBundle(output) {
          await finish(resolve(output.dir ?? 'dist'));
        },
      },
    };
  });
}

export const everframeUnplugin = createEverframePlugin();
