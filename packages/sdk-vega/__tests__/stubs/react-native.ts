// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Vitest-only stand-in for `react-native` (a peer, not installed here). It
// answers the reads src/device.ts makes with React Native for Vega's shapes:
// Platform.OS is 'kepler' and Platform.constants has no model or release.
export const Platform = {
  OS: 'kepler',
  isTV: true,
  constants: { keplerOSVariant: 'tv', uiMode: 'tv', reactNativeVersion: { major: 0, minor: 72, patch: 0 } },
};

export const Dimensions = {
  get(_dim: 'window' | 'screen') {
    return { width: 1920, height: 1080, scale: 1, fontScale: 1 };
  },
};

export const PixelRatio = {
  get() {
    return 1;
  },
};
