// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { emptyErrorCaptureStatus, type ErrorCaptureStatus } from './error-capture-status.js';
// React Native web uses the existing browser reporter and capture implementation.
export * from '@everframe/react';
import { emptyPromiseRejectionStatus, type PromiseRejectionStatus } from './promise-rejection-types.js';
export type { PromiseRejectionStatus, PromiseRejectionCounters, RejectionReason } from './promise-rejection-types.js';
/** Hermes observation is separate from the browser SDK's own rejection handling. */
export function getPromiseRejectionStatus(): PromiseRejectionStatus {
  return emptyPromiseRejectionStatus('unsupported', 'platform');
}

export type { ErrorCaptureStatus, ErrorCaptureCounters, ErrorCapturePath, ErrorCaptureOutcome } from './error-capture-status.js';
/** Mobile admission diagnostics are unavailable on the browser entry. */
export function getErrorCaptureStatus(): ErrorCaptureStatus { return emptyErrorCaptureStatus('unsupported', 'platform'); }
