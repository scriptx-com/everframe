// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** Detached acceptance state. It must never reference its original error. */
export interface CaptureIdentity { accepted: boolean }
export interface PreparedRejection {
  readonly payload: string;
  readonly key: string;
  readonly identity?: CaptureIdentity;
}
export type RejectionOutcome = 'accepted' | 'duplicate' | 'allowance' | 'inactive'
  | 'native-refused' | 'capture-failed';

export function captureKey(facts: { exceptionType: string; framesRaw: string[] }): string {
  return `${facts.exceptionType}:${(facts.framesRaw[0] ?? '').replace(/\d+/g, '#')}`;
}
