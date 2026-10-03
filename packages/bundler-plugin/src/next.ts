// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type { EverframeBundlerOptions } from './core.js';
import { createNextWebpackPlugin } from './plugin.js';

export type { EverframeBundlerOptions } from './core.js';

// Matches next's `NextConfig['webpack']`, which allows null.
type WebpackHook = ((config: any, options: any) => any) | null;

interface NextConfigLike {
  webpack?: WebpackHook;
  turbopack?: object;
}

type Wrapped<T extends NextConfigLike> = Omit<T, 'webpack' | 'turbopack'> & {
  webpack: (config: any, options: any) => any;
  turbopack: NonNullable<T['turbopack']> | {};
};

let warnedTurbopack = false;

/**
 * Client production webpack builds only. Turbopack builds are not stamped or uploaded;
 * the empty `turbopack` config keeps Next 16's default Turbopack build from rejecting the webpack hook.
 */
export function withEverframe<T extends NextConfigLike>(nextConfig: T, options: EverframeBundlerOptions): Wrapped<T> {
  if (!warnedTurbopack) {
    warnedTurbopack = true;
    console.warn('everframe: Turbopack builds are not stamped or uploaded; build with `next build --webpack` to upload source maps.');
  }
  const userHook = nextConfig.webpack;
  return {
    ...nextConfig,
    turbopack: nextConfig.turbopack ?? {},
    webpack(config: { plugins: unknown[] }, context: { isServer: boolean; dev: boolean }) {
      const result: { plugins: unknown[] } = userHook ? userHook(config, context) : config;
      if (!context.isServer && !context.dev) result.plugins.push(createNextWebpackPlugin(options));
      return result;
    },
  } as Wrapped<T>;
}
