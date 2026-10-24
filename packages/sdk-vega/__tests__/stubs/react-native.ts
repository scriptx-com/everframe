// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Vitest-only stand-in for `react-native` (a peer, not installed here). It
// answers the reads src/device.ts makes with React Native for Vega's shapes:
// Platform.OS is 'kepler' and Platform.constants has no model or release.
import { createElement, type ReactNode } from 'react';
export const Platform = {
  OS: 'kepler',
  isTV: true,
  constants: {
    keplerOSVariant: 'tv',
    uiMode: 'tv',
    reactNativeVersion: { major: 0, minor: 72, patch: 0 },
  },
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

export const AppState = {
  currentState: null as string | null,
  currentModuleStates: null as unknown,
  addEventListener(_event: string, _listener: (value: unknown) => void) {
    return { remove() {} };
  },
};

// Root wrapper pieces (src/overlay.ts). View and Text render plain DOM
// elements so react-dom/server can render the wrapper in tests.

type HostProps = { children?: ReactNode; testID?: string; [key: string]: unknown };

export function View(props: HostProps) {
  return createElement('div', { 'data-rn': 'View', 'data-testid': props.testID }, props.children);
}

export function Text(props: HostProps) {
  return createElement('span', { 'data-rn': 'Text' }, props.children);
}

export const StyleSheet = {
  create<T>(styles: T): T {
    return styles;
  },
};

/** Handlers passed to `useTVEventHandler`, in call order. */
export const tvEventHandlers: Array<(event: unknown) => void> = [];

export function useTVEventHandler(handler: (event: unknown) => void): void {
  tvEventHandlers.push(handler);
}

export const AppRegistry = {
  wrapperProviders: [] as Array<(params: unknown) => unknown>,
  setWrapperComponentProvider(provider: (params: unknown) => unknown) {
    AppRegistry.wrapperProviders.push(provider);
  },
};
