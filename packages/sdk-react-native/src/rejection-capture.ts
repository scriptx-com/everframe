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

const VALUE_KEY = 'UnhandledValue:value-';
/** Non-Error reasons may spend at most this many of a mount's 10 automatic keys. */
const MAX_VALUE_KEYS = 5;

export function captureKey(facts: { exceptionType: string; framesRaw: string[] }): string {
  return `${facts.exceptionType}:${(facts.framesRaw[0] ?? '').replace(/\d+/g, '#')}`;
}

/**
 * Non-Error reasons have no frame, so they are keyed by a hash of their bounded
 * reported value. Digit runs are ignored, as in frames, so one call site's ids
 * and counts share a key.
 */
export function rejectionKey(facts: { exceptionType: string; message: string; framesRaw: string[] }): string {
  if (facts.exceptionType !== 'UnhandledValue' || facts.framesRaw.length > 0) return captureKey(facts);
  const value = facts.message.replace(/\d+/g, '#');
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193);
  return `${VALUE_KEY}${(hash >>> 0).toString(16)}`;
}

/** One call site's changing values must not use up the automatic keys ErrorUtils reports share. */
export function exceedsValueShare(keys: Iterable<string>, key: string): boolean {
  if (!key.startsWith(VALUE_KEY)) return false;
  let spent = 0;
  for (const existing of keys) if (existing.startsWith(VALUE_KEY)) spent++;
  return spent >= MAX_VALUE_KEYS;
}
