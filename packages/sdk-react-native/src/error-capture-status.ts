// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** Local admission only: native acceptance is not delivery confirmation. */
export type ErrorCapturePath = 'handled' | 'errorUtils' | 'rejection';
export interface ErrorCaptureCounters {
  attempted: number;
  accepted: number;
  duplicateSuppressed: number;
  allowanceSuppressed: number;
  bridgeUnavailable: number;
  nativeRefused: number;
  captureFailed: number;
  reentrantSuppressed: number;
  inactiveAborted: number;
  legacyAttempted: number;
}
export type ErrorCaptureOutcome = Exclude<keyof ErrorCaptureCounters, 'attempted'>;
export interface ErrorCaptureStatus {
  status: 'not-mounted' | 'disabled' | 'active' | 'unsupported';
  reason: 'no-mount' | 'crash-reporting-disabled' | 'none' | 'platform';
  scope: 'mounted-js-admission';
  limits: { handled: 10; automatic: 10 };
  counters: Record<ErrorCapturePath, ErrorCaptureCounters>;
}
function emptyCounters(): ErrorCaptureCounters {
  return { attempted: 0, accepted: 0, duplicateSuppressed: 0, allowanceSuppressed: 0,
    bridgeUnavailable: 0, nativeRefused: 0, captureFailed: 0, reentrantSuppressed: 0,
    inactiveAborted: 0, legacyAttempted: 0 };
}
export function emptyErrorCaptureStatus(status: ErrorCaptureStatus['status'], reason: ErrorCaptureStatus['reason']): ErrorCaptureStatus {
  return { status, reason, scope: 'mounted-js-admission', limits: { handled: 10, automatic: 10 },
    counters: { handled: emptyCounters(), errorUtils: emptyCounters(), rejection: emptyCounters() } };
}
/** Internal bookkeeping; deliberately absent from the package barrels. */
export function incrementErrorCaptureCounter(counters: ErrorCaptureCounters, key: keyof ErrorCaptureCounters): void {
  counters[key] = Math.min(2147483647, counters[key] + 1);
}
export function createErrorCaptureLedger() {
  const counters = emptyErrorCaptureStatus('active', 'none').counters;
  return {
    begin(path: ErrorCapturePath): (outcome: ErrorCaptureOutcome) => void {
      incrementErrorCaptureCounter(counters[path], 'attempted');
      let settled = false;
      return outcome => {
        if (settled) return;
        settled = true;
        incrementErrorCaptureCounter(counters[path], outcome);
      };
    },
    snapshot(): ErrorCaptureStatus['counters'] {
      return { handled: { ...counters.handled }, errorUtils: { ...counters.errorUtils }, rejection: { ...counters.rejection } };
    },
  };
}
