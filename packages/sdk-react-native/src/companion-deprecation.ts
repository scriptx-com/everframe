// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The one-time Companion removal warning, kept out of `companion.ts` so the
// public `companion` namespace carries only its documented members.

/** The message every deprecated Companion symbol carries, and the one-time warning. */
export const COMPANION_REMOVED_MESSAGE =
  'Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture.';

let emitted = 0;

/** Logs the removal warning once per app session. Never throws. */
export function warnCompanionRemovedOnce(): void {
  if (emitted > 0) return;
  emitted = 1;
  try {
    console.warn(`[Everframe] ${COMPANION_REMOVED_MESSAGE}`);
  } catch {
    /* a console that throws must never break the host */
  }
}

/** Test seam: how many times the warning has been logged (0 or 1). Not exported from the package root. */
export function __companionDeprecationCount(): number {
  return emitted;
}

/** Test seam: forget the warning so the next `start()` logs again. Not exported from the package root. */
export function __resetCompanionDeprecation(): void {
  emitted = 0;
}
