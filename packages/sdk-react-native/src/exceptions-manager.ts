// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// React Native's JS exception funnel. Since RN 0.78 (React 19) an error that
// no error boundary catches reaches the root's onUncaughtError, which calls
// ExceptionsManager.handleException(error, true) directly: the ErrorUtils
// global handler never sees it. RN has no public API for this module, so the
// SDK imports it by path; the file has existed at this path since RN 0.4x.
import ExceptionsManager from 'react-native/Libraries/Core/ExceptionsManager';

export interface ExceptionsManagerLike {
  handleException: (error: unknown, isFatal: boolean) => void;
}

/** The live ExceptionsManager object, or undefined when its shape is unrecognised. */
export function reactNativeExceptionsManager(): ExceptionsManagerLike | undefined {
  try {
    const candidate: unknown = ExceptionsManager;
    if (typeof candidate !== 'object' || candidate === null) return undefined;
    return typeof Reflect.get(candidate, 'handleException') === 'function'
      ? (candidate as ExceptionsManagerLike)
      : undefined;
  } catch {
    return undefined;
  }
}
