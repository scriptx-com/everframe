// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type { EverframeBundlerOptions } from './core.js';
import { everframeUnplugin } from './plugin.js';

type WebpackHook = (config: { plugins: unknown[] }, context: { isServer: boolean; dev: boolean }) => { plugins: unknown[] };

/** Client production builds only; Turbopack builds are not affected. */
export function withEverframe<T extends { webpack?: WebpackHook }>(nextConfig: T, options: EverframeBundlerOptions): T & { webpack: WebpackHook } {
  return {
    ...nextConfig,
    webpack(config, context) {
      const result = nextConfig.webpack ? nextConfig.webpack(config, context) : config;
      if (!context.isServer && !context.dev) result.plugins.push(everframeUnplugin.webpack(options));
      return result;
    },
  };
}
