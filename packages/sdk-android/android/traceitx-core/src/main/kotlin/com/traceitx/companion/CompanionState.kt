// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Plan 06.2-08 — Companion runtime state enum (Android phone + Android TV +
// Fire TV). Mirrors iOS `CompanionState` in Plan 06.2-07; the four cases
// are the SPEC §State Machine surface that hosts observe via
// `TraceItX.companion.state: StateFlow<CompanionState>`.
//
// Transitions are driven solely by `RelayWSClient.onMessage` /
// `onClosing` / lifecycle observers via the `__setState` indirection seam
// in `Companion.kt` — keep this file dependency-free.

package com.traceitx.companion

enum class CompanionState {
    /** No active pairing — relay has issued a pair_token; show QR. */
    Unpaired,

    /** Phone bonded; awaiting `report.request` from phone trigger. */
    Paired,

    /** A `report.request` arrived; capture-on-request bridge is shipping payload. */
    ReportInProgress,

    /** Backgrounded or socket lost; reconnect-with-backoff is scheduled. */
    PhoneDisconnected,
}
