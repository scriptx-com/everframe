// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type { ErrorSeverity } from '@everframe/protocol';

/** Optional per-occurrence details captured with a handled exception. */
export interface CaptureExceptionOptions {
  severity?: ErrorSeverity;
  context?: string;
  metadata?: Record<string, unknown>;
  /**
   * React's component stack, from an app's own error boundary:
   * `componentDidCatch(error, info)` passes it as `info.componentStack`. The
   * dashboard shows it under the message and maps its names through the
   * source map, so an error thrown inside React itself still says which
   * components it happened in. React types it as optional and nullable, so
   * `info.componentStack` can be passed as it is; null is ignored.
   */
  componentStack?: string | null | undefined;
}

/** The host's `componentStack` option, when it is a non-blank string. A hostile getter yields none. */
export function captureOptionComponentStack(
  options: CaptureExceptionOptions | undefined,
): string | undefined {
  try {
    const value: unknown = options?.componentStack;
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  } catch {
    return undefined;
  }
}
