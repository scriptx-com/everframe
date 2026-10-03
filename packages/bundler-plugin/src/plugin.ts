// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { dirname, resolve } from 'node:path';
import MagicString from 'magic-string';
import { createUnplugin, type UnpluginInstance } from 'unplugin';
import { finishBuild, identityBanner, resolveSettings, type EverframeBundlerOptions, type Settings } from './core.js';
import type { uploadBuild } from '@everframe/cli/upload';

export interface PluginDeps {
  env?: NodeJS.ProcessEnv;
  upload?: typeof uploadBuild;
}

function outputRoot(output: { dir?: string | undefined; file?: string | undefined }): string {
  return resolve(output.dir ?? (output.file ? dirname(output.file) : 'dist'));
}

interface WebpackCompilerLike {
  options: { devtool?: unknown; mode?: string; output: { path?: string } };
  webpack: { BannerPlugin: new (options: { banner: string; raw: boolean; entryOnly: boolean }) => { apply(c: unknown): void } };
  hooks: { afterEmit: { tapPromise(name: string, fn: () => Promise<void>): void } };
}

/** Webpack reads `devtool` after plugins apply, so setting it here takes effect. */
export function applyWebpack(compiler: WebpackCompilerLike, settings: Settings, finish: (dir: string) => Promise<void>): void {
  if (compiler.options.mode !== 'production') return;
  if (!compiler.options.devtool) compiler.options.devtool = 'hidden-source-map';
  new compiler.webpack.BannerPlugin({ banner: identityBanner(settings.buildId), raw: true, entryOnly: true }).apply(compiler);
  compiler.hooks.afterEmit.tapPromise('everframe', () => finish(resolve(compiler.options.output.path ?? 'dist')));
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
    return {
      name: 'everframe',
      vite: {
        apply: 'build',
        // Only the browser bundle is stamped and uploaded; SSR/server environments are skipped.
        applyToEnvironment(environment) {
          return environment.config.consumer === 'client';
        },
        configEnvironment(name, config) {
          // consumer is unset for the default client environment at this stage.
          if ((config.consumer ?? (name === 'client' ? 'client' : 'server')) !== 'client') return;
          return { build: { sourcemap: config.build?.sourcemap ?? 'hidden' } };
        },
        renderChunk(code, chunk) {
          if (!chunk.isEntry) return null;
          return stamp(code);
        },
        async writeBundle(output) {
          await finish(outputRoot(output));
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
          await finish(outputRoot(output));
        },
      },
      webpack(compiler) {
        applyWebpack(compiler as unknown as WebpackCompilerLike, settings, finish);
      },
      esbuild: {
        setup(build) {
          build.initialOptions.sourcemap ??= 'external';
          build.initialOptions.banner = {
            ...build.initialOptions.banner,
            js: `${banner}\n${build.initialOptions.banner?.js ?? ''}`,
          };
          build.onEnd(async (result) => {
            if (result.errors.length) return;
            const dir = build.initialOptions.outdir;
            if (!dir) throw new Error('everframe: esbuild needs outdir to upload source maps');
            await finish(resolve(dir));
          });
        },
      },
    };
  });
}

export const everframeUnplugin = createEverframePlugin();
