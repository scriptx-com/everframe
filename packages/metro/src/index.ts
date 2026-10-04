// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { deriveBundleName, generateBuildId } from './identity.js';
import { stagingRoot, writeStagedIdentity } from './staging.js';

export { deriveBundleName, generateBuildId, identityModuleSource } from './identity.js';
export { stagingRoot, writeStagedIdentity } from './staging.js';

export interface WithEverframeOptions {
  /**
   * Stamp a build identity into the bundle (default `true`). Set it to the
   * same condition that puts the Everframe SDK in the bundle; when `false`
   * the config is returned untouched.
   */
  enabled?: boolean;
  projectRoot?: string;
  dev?: boolean;
}

type PolyfillArgs = { platform: string };
type MetroLikeConfig = {
  serializer?: { getPolyfills?: (args: PolyfillArgs) => string[] };
};

type WithIdentity<T> = T & {
  serializer: { getPolyfills: (args: PolyfillArgs) => string[] };
};

export function withEverframe<T extends MetroLikeConfig>(
  config: T,
  options: WithEverframeOptions = {},
): WithIdentity<T> {
  if (options.enabled === false) return config as WithIdentity<T>;
  const projectRoot = options.projectRoot ?? process.cwd();
  const dev = options.dev ?? false;
  const previous = config.serializer?.getPolyfills;

  // Staged at config time: Metro crawls the project before calling
  // getPolyfills and cannot hash a file created later. Both platforms are
  // staged because `eas update` can export both from one process.
  const staged: Record<'android' | 'ios', string> = {
    android: writeStagedIdentity(projectRoot, {
      schema: 1,
      buildId: generateBuildId(),
      platform: 'android',
      bundleName: deriveBundleName('android'),
      dev,
    }),
    ios: writeStagedIdentity(projectRoot, {
      schema: 1,
      buildId: generateBuildId(),
      platform: 'ios',
      bundleName: deriveBundleName('ios'),
      dev,
    }),
  };

  // Must stay synchronous: Metro calls `.concat()` on the result without awaiting.
  const getPolyfills = (args: PolyfillArgs): string[] => {
    const base = previous ? previous(args) : [];
    if (args.platform !== 'android' && args.platform !== 'ios') return base;
    return [...base, staged[args.platform]];
  };

  return { ...config, serializer: { ...config.serializer, getPolyfills } } as WithIdentity<T>;
}
