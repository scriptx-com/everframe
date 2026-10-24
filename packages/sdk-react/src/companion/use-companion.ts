// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Everframe Companion has been removed. `useCompanion()` stays, deprecated,
// until the next major so components that call it keep compiling. It returns
// the same frozen idle object on every render and subscribes to nothing.
'use client';

import type { CompanionState, CompanionAttachChallenge } from '@everframe/web';

interface CompanionSnapshot {
  state: CompanionState;
  pairUrl: string | null;
  code: string | null;
  attachedUserName: string | null;
  resolvedName: string | null;
  attachChallenge: CompanionAttachChallenge | null;
  running: boolean;
}

const IDLE: CompanionSnapshot = Object.freeze({
  state: 'unpaired',
  pairUrl: null,
  code: null,
  attachedUserName: null,
  resolvedName: null,
  attachChallenge: null,
  running: false,
});

/**
 * Returns the idle Companion snapshot — the same object on every render.
 *
 * @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture.
 */
export function useCompanion(): {
  state: CompanionState;
  pairUrl: string | null;
  code: string | null;
  attachedUserName: string | null;
  resolvedName: string | null;
  attachChallenge: CompanionAttachChallenge | null;
  running: boolean;
} {
  return IDLE;
}
