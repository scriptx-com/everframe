// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

/**
 * React Native codegen recognizes the `UnsafeObject` identifier as its
 * generic-object escape hatch. Keeping the structural TypeScript alias local
 * avoids the legacy `react-native/Libraries/Types/CodegenTypes` deep import,
 * whose declaration is disabled by default in React Native 0.87.
 */
export type UnsafeObject = object;

