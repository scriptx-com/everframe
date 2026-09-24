// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Reporter result + error types. After the D-05/D-07 flip (2026-05-11) the
// reporter UI lives entirely on the native side; this module retains only the
// JS-facing result shape and the not-mounted error class.

/**
 * Resolved by `useEverframe().open()` / top-level `open()`.
 * Mirrors the native NSDictionary / WritableMap shape produced by the iOS
 * (`EverframeBridge.openReporter`) and Android (`EverframeModule.openReporter`)
 * bridges. The `status` field is one of:
 *   - 'submitted' — envelope shipped successfully (reportId populated)
 *   - 'queued'    — envelope persisted for retry (reportId populated)
 *   - 'cancelled' — user dismissed the reporter without submitting
 */
export type ReporterResult =
  | { status: 'submitted'; reportId: string }
  | { status: 'queued'; reportId: string }
  | { status: 'cancelled'; reason?: string };

/**
 * Thrown when `open()` is called from a top-level (non-component) site
 * before a `<EverframeProvider>` has mounted. Components reading via
 * `useEverframe()` see a same-class error.
 */
export class EverframeNotMountedError extends Error {
  override readonly name = 'EverframeNotMountedError';
  constructor(message?: string) {
    super(message ?? 'EverframeProvider is not mounted; wrap your app root.');
  }
}
