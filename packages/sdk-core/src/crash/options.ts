// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type { ErrorSeverity } from '@everframe/protocol';

/** Optional per-occurrence details captured with a handled exception. */
export interface CaptureExceptionOptions {
  severity?: ErrorSeverity;
  context?: string;
  metadata?: Record<string, unknown>;
}
