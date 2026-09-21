// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Public reporter result + error shapes. Mirrors @traceitx/react-native
// (`reporter/types.ts`) so consumers writing cross-platform code see the same
// surface from both SDKs:
//
//   const result = await useTraceItX().open();
//   if (result.status === 'submitted') ...

/**
 * Resolved by `useTraceItX().open()` / top-level `open()`. Mirrors the native
 * iOS / Android bridge shape exposed by sdk-react-native.
 *   - 'submitted' — envelope shipped successfully (reportId populated).
 *   - 'queued'    — envelope persisted to the outbox for retry (reportId populated).
 *   - 'cancelled' — user dismissed the reporter without submitting.
 */
export type ReporterResult =
  | { status: 'submitted'; reportId: string }
  | { status: 'queued'; reportId: string }
  | { status: 'cancelled'; reason?: string };

/**
 * Thrown when the top-level `open()` re-export is called before any
 * `<TraceItXProvider>` has mounted. Components reading via `useTraceItX()`
 * see a different (provider-missing) error class — both are subclasses of
 * `Error` and safe to catch.
 */
export class TraceItXNotMountedError extends Error {
  override readonly name = 'TraceItXNotMountedError';
  constructor(message?: string) {
    super(message ?? 'TraceItXProvider is not mounted; wrap your app root.');
  }
}
