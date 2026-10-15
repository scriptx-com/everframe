// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Reporter result + error types. After the D-05/D-07 flip (2026-05-11) the
// reporter UI lives entirely on the native side; this module retains only the
// JS-facing result shape and the two reporter error classes.

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

/**
 * Native error code both bridges reject `openReporter()` with when the host
 * set `reporter: { disabled: true }` (crash-only sessions, spec 2026-10-12).
 */
export const REPORTER_DISABLED_CODE = 'EVERFRAME_REPORTER_DISABLED';

/**
 * Rejected by `open()` when the host turned the reporter off
 * (`reporter: { disabled: true }`, a crash-only session). The session keeps
 * this for its whole life, including after a companion bond upgrades it:
 * reports then come through the companion, not through `open()`. Same name
 * as the web SDK's error of the same purpose.
 */
export class EverframeReporterDisabledError extends Error {
  override readonly name = 'EverframeReporterDisabledError';
  constructor(message?: string) {
    super(message ?? 'The Everframe reporter is disabled in this session (reporter.disabled).');
  }
}

/** Explicit entry point attribution; never inferred from display text or a previous key. */
export type ReporterTrigger = 'button' | 'shake' | 'menu' | 'companion';
export interface ReporterOpenOptions {
  trigger?: ReporterTrigger;
}
export function isReporterTrigger(value: unknown): value is ReporterTrigger {
  return value === 'button' || value === 'shake' || value === 'menu' || value === 'companion';
}
