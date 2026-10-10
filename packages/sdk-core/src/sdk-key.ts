// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// `apiKey` was the SDK key's config name until 1.2, when every SDK settled on
// `sdkKey`. Published 1.1 configs still pass `apiKey`, so the public entry
// points accept it and normalise it here, once, before anything reads the key.
// Only the config name changed: the key still travels as
// `Authorization: Bearer <key>` (and as `apiKey` in the vitals beacon body).

let warned = false;

/**
 * Returns `config` with its SDK key under `sdkKey` and no `apiKey`. `sdkKey`
 * wins when both are set. The first config in a page or app that uses
 * `apiKey` logs one deprecation warning. A config with neither comes back
 * unchanged.
 */
export function resolveSdkKey<C extends { sdkKey?: string | undefined; apiKey?: string | undefined }>(
  config: C,
): Omit<C, 'apiKey' | 'sdkKey'> & { sdkKey: string } {
  if (config === null || typeof config !== 'object' || !('apiKey' in config)) {
    return config as unknown as Omit<C, 'apiKey' | 'sdkKey'> & { sdkKey: string };
  }
  const { apiKey, ...rest } = config;
  const hasSdkKey = rest.sdkKey !== undefined;
  if (!warned && apiKey !== undefined) {
    warned = true;
    console.warn(
      hasSdkKey
        ? '[everframe] Both `sdkKey` and the deprecated `apiKey` are set; using `sdkKey`. Remove `apiKey`.'
        : '[everframe] `apiKey` is deprecated; rename it to `sdkKey`. It still works for now.',
    );
  }
  return { ...rest, sdkKey: hasSdkKey ? rest.sdkKey : apiKey } as Omit<C, 'apiKey' | 'sdkKey'> & {
    sdkKey: string;
  };
}

/** Test seam: let the next deprecated `apiKey` warn again. */
export function __resetSdkKeyWarning(): void {
  warned = false;
}
