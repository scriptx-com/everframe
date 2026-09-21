// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Error-storm guard (spec 2026-07-18): a render-loop error can fire hundreds
// of times a minute; suppressed occurrences still land as breadcrumbs.
export interface CrashThrottle {
  shouldReport(fingerprint: string): boolean;
}

export function createCrashThrottle(opts?: {
  maxPerFingerprint?: number;
  maxPerSession?: number;
}): CrashThrottle {
  const maxPerFingerprint = opts?.maxPerFingerprint ?? 1;
  const maxPerSession = opts?.maxPerSession ?? 10;
  const perFingerprint = new Map<string, number>();
  let total = 0;
  return {
    shouldReport(fingerprint: string): boolean {
      if (total >= maxPerSession) return false;
      const seen = perFingerprint.get(fingerprint) ?? 0;
      if (seen >= maxPerFingerprint) return false;
      perFingerprint.set(fingerprint, seen + 1);
      total += 1;
      return true;
    },
  };
}
