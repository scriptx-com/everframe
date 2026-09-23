// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Vitest-only stub for `react-native`. The real RN package is a peerDependency
// of @everframe/react-native and is NOT installed in this workspace (it would
// drag in the entire metro/babel toolchain). For unit tests we alias
// `import 'react-native'` to this file via vitest.config.ts → resolve.alias.
//
// The vi.mock('react-native', ...) call in vitest.setup.ts then replaces the
// `TurboModuleRegistry.getEnforcing` return value with vi.fn() stubs so the
// 5 D-05 methods are inspectable from spec-shape tests.

export interface TurboModule {
  readonly getConstants?: () => object;
}

export const TurboModuleRegistry = {
  getEnforcing<T>(_name: string): T {
    // Replaced by vi.mock in vitest.setup.ts. If a test forgets to install the
    // mock, blow up loudly rather than silently returning a half-built object.
    throw new Error(
      `[react-native stub] TurboModuleRegistry.getEnforcing('${_name}') called without vi.mock — install vitest.setup.ts.`,
    );
  },
};

// Component/primitive stubs — vi.mock in vitest.setup.ts overrides at runtime,
// but the type aliases here let .tsx source files resolve symbols at typecheck.
type Cmp = (props: object) => unknown;
export const View: Cmp = () => null;
export const Text: Cmp = () => null;
export const TextInput: Cmp = () => null;
export const Pressable: Cmp = () => null;
export const Image: Cmp = () => null;
export const ScrollView: Cmp = () => null;
export const FlatList: Cmp = () => null;
export const Modal: Cmp = () => null;
export const ActivityIndicator: Cmp = () => null;

export interface ViewProps {
  children?: unknown;
  style?: unknown;
  onLayout?: (event: LayoutChangeEvent) => void;
  accessibilityLabel?: string;
}
export interface LayoutChangeEvent {
  nativeEvent: { layout: { x: number; y: number; width: number; height: number } };
}

export const StyleSheet = {
  create<T>(styles: T): T {
    return styles;
  },
  hairlineWidth: 1,
};
