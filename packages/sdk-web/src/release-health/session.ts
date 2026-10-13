// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type { WebReleaseHealthExposure, WebReleaseHealthRecord } from '@everframe/protocol';
import { generateReportId } from '../transport/draft-to-envelope.js';
export function createWebHealthSession(input: WebReleaseHealthExposure) {
  const exposure = Object.freeze({
    ...input,
    app: Object.freeze({ ...input.app }),
    subject: Object.freeze({ ...input.subject }),
  });
  const common = (at: Date) => ({
    schemaVersion: 6 as const,
    recordId: generateReportId(),
    exposure,
    capturedAt: new Date(Math.max(at.getTime(), Date.parse(exposure.startedAt))).toISOString(),
    elapsedMs: Math.min(
      31 * 86_400_000,
      Math.max(0, at.getTime() - Date.parse(exposure.startedAt)),
    ),
  });
  const start: WebReleaseHealthRecord = Object.freeze({
    ...common(new Date(exposure.startedAt)),
    phase: 'start',
    sequence: 0,
    elapsedMs: 0,
  });
  let completed = false,
    failed = false;
  return {
    start: () => start,
    complete(at: Date): WebReleaseHealthRecord | null {
      if (completed || failed) return null;
      completed = true;
      return Object.freeze({
        ...common(at),
        phase: 'end',
        sequence: 1,
        outcome: 'completed',
        endReason: 'pagehide',
      });
    },
    fail(
      mechanism: 'onerror' | 'unhandledrejection',
      at: Date,
      reportId?: string,
    ): WebReleaseHealthRecord | null {
      if (failed) return null;
      failed = true;
      return Object.freeze({
        ...common(at),
        phase: 'failure',
        sequence: 2,
        outcome: 'crashed',
        mechanism,
        ...(reportId ? { reportId } : {}),
      });
    },
  };
}
