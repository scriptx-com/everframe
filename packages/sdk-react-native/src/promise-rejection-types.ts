// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
export type RejectionReason = 'none' | 'opt-in-required' | 'crash-reporting-disabled'
  | 'platform' | 'runtime' | 'promise-identity' | 'hook-shape' | 'hook-install'
  | 'hook-displaced' | 'no-mount';

export interface PromiseRejectionCounters {
  pending: number; accepted: number; cancelled: number;
  capacityDropped: number; sizeDropped: number; expired: number;
  duplicateSuppressed: number; allowanceSuppressed: number;
  nativeRefused: number; captureFailed: number;
}
export interface PromiseRejectionStatus {
  status: 'disabled' | 'unsupported' | 'observing' | 'displaced' | 'install-failed' | 'not-mounted';
  reason: RejectionReason;
  adapterId?: string;
  previousCallbacksPresent: boolean;
  counters: PromiseRejectionCounters;
}
export function emptyPromiseRejectionStatus(
  status: PromiseRejectionStatus['status'], reason: RejectionReason,
): PromiseRejectionStatus {
  return { status, reason, previousCallbacksPresent: false, counters: {
    pending: 0, accepted: 0, cancelled: 0, capacityDropped: 0, sizeDropped: 0,
    expired: 0, duplicateSuppressed: 0, allowanceSuppressed: 0, nativeRefused: 0, captureFailed: 0,
  } };
}
