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

/** Non-Error reasons have no frame, so they are keyed by a hash of their bounded reported value. */
export function rejectionKey(facts: { exceptionType: string; message: string; framesRaw: string[] }): string {
  if (facts.exceptionType !== 'UnhandledValue' || facts.framesRaw.length > 0) return captureKey(facts);
  let hash = 0x811c9dc5;
  for (let i = 0; i < facts.message.length; i++) hash = Math.imul(hash ^ facts.message.charCodeAt(i), 0x01000193);
  return `UnhandledValue:value-${(hash >>> 0).toString(16)}`;
}
