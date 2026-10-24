// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// React Native for Vega exports `useTVEventHandler` from `react-native`
// (`@amazon-devices/react-native-kepler`); upstream React Native's types do
// not declare it. The `export {}` makes this an augmentation, not a
// replacement, of the `react-native` types.
export {};

declare module 'react-native' {
  export function useTVEventHandler(
    handler: (event: { eventType?: unknown; eventKeyAction?: unknown }) => void,
  ): void;
}
