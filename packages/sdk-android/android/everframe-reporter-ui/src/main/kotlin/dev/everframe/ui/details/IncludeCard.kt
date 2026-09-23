// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// ReporterIncludes — Task 9 (native report-window parity) removed the
// "Include in this report" per-section toggle UI (IncludeCard/IncludeRow/
// IncludeCardState/rememberIncludeCardState/IncludeRowSpec, previously
// defined in this file per Phase 13 D1) in favor of an always-include
// hardwire: ReporterRoot.onSubmit now always passes `ReporterIncludes()`
// (every field true), so `excludedKeys()` always returns `[]`.
//
// This data shape survives the UI removal because the envelope gating
// contract at ReporterDialog.kt (`captureControl.excluded`) still reads it —
// keeping the type (rather than deleting it and inlining `emptyList()`)
// preserves that contract's shape and keeps ReporterDialog.kt's call sites
// diff-stable.
package dev.everframe.ui.details

/**
 * Snapshot of the per-section include toggles surfaced by the (now removed)
 * reporter modal include card. Plumbed through `ReporterRoot.onSubmit` →
 * `ReporterDialog.submitBaked` → `EnvelopeBuilder` so any unchecked sections
 * would drop from the shipped envelope (and land in `captureControl.
 * excluded`). Since Task 9, every field is always `true` at the call site —
 * this class only still exists so `excludedKeys()` stays the single source
 * of truth for the envelope's exclusion-key spelling.
 */
internal data class ReporterIncludes(
    val logs: Boolean = true,
    val network: Boolean = true,
    val metadata: Boolean = true,
    val extra: Boolean = true,
) {
    fun excludedKeys(): List<String> = buildList {
        if (!logs) add("logs")
        if (!network) add("network")
        if (!metadata) add("metadata")
        if (!extra) add("extra")
    }
}
