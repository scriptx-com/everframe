// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { __getCurrentContext, __getContextEpoch } from '../contextSeam.js';
// Resolve the intrinsic before host metadata can mutate its property.
const applyFunction = Reflect.apply;

/**
 * Call from an application's componentDidCatch after EverframeProvider mounts.
 * The application owns its fallback and recovery policy. Native acceptance does
 * not establish delivery; fatal escalation can still produce a separate report.
 */
export function captureReactError(error: unknown, info?: { componentStack?: string | null }): void {
  const owner = __getCurrentContext();
  if (!owner) return;
  const epoch = __getContextEpoch();
  let componentStack: string | undefined;
  try {
    if (info != null) {
      const descriptor = Object.getOwnPropertyDescriptor(info, 'componentStack');
      if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') componentStack = descriptor.value;
    }
  } catch { /* Hostile info is omitted; the error can still be captured. */ }
  try {
    const capture = owner.captureException;
    if (__getCurrentContext() !== owner || __getContextEpoch() !== epoch) return;
    // The normalizer owns bounded scanning and truncation evidence.
    applyFunction(capture, owner, [error, { context: 'react.error-boundary',
      ...(componentStack !== undefined ? { metadata: { componentStack } } : {}) }]);
  } catch { /* Reporting must not break the application's boundary callback. */ }
}
