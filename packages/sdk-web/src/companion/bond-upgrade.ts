// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Crash-only sessions (spec 2026-10-12): a companion bond, a phone scanning
// the QR code or a dashboard member attaching, upgrades a session whose host
// turned the reporter off. Both hosts, `init()` and `@everframe/react`'s
// provider, watch the page-wide companion state through this one helper.
//
// Framework-free: reachable from the always-loaded entry.
'use client';

import { __getCompanionApi } from './singleton.js';
import type { CompanionState } from './state.js';

/** The states the relay client sets only while a phone or member is bonded. */
function isBonded(state: CompanionState): boolean {
  return state === 'paired' || state === 'report_in_progress';
}

/**
 * Calls `adapter.__setCompanionAttached()` as soon as the companion is
 * bonded. Seeds from the current state first, because the bond can predate
 * the adapter: React StrictMode rebuilds it, and a vanilla host may call
 * `init()` after `companion.start()`. The upgrade is sticky inside the
 * adapter, so later calls and a detach change nothing. Returns the
 * unsubscribe function.
 */
export function __watchCompanionBond(adapter: { __setCompanionAttached(): void }): () => void {
  const api = __getCompanionApi();
  const attach = (state: CompanionState): void => {
    if (!isBonded(state)) return;
    try {
      adapter.__setCompanionAttached();
    } catch {
      /* swallow — DEFE-02 */
    }
  };
  attach(api.getState());
  return api.onState((_previous, next) => attach(next));
}
