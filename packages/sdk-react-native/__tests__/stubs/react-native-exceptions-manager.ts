// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Stand-in for react-native/Libraries/Core/ExceptionsManager (aliased in
// vitest.config.ts). A plain mutable object, like RN's: the SDK replaces its
// handleException property. Tests read `reported` to see what reached RN.
export const reported: Array<{ error: unknown; isFatal: boolean }> = [];

const ExceptionsManager = {
  handleException(error: unknown, isFatal: boolean): void {
    reported.push({ error, isFatal });
  },
};

export default ExceptionsManager;
