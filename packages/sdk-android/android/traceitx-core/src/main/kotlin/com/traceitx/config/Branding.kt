// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Branding state shared between config plumbing and the reporter UI
// (Android spec 2026-08-26).
//
// BrandingServerConfigSignal mirrors CompanionBadgeServerConfigSignal
// (companion/CompanionBadge.kt): written by ReplaySession on every config
// commit, cleared by TraceItX at both session boundaries (start() epoch
// reset and kill()) so a dead/previous session's entitlement never outlives
// it. Collected as Compose state by the reporter root, so a config landing
// while the dialog is open re-themes it live.
package com.traceitx.config

import androidx.annotation.RestrictTo
import androidx.annotation.VisibleForTesting
import kotlinx.coroutines.flow.MutableStateFlow

// LIBRARY_GROUP (#136 review follow-up, paired deliberately with
// CompanionBadgeServerConfigSignal): the signal is plumbing between
// traceitx-core and traceitx-reporter-ui (same com.traceitx library group),
// never host API — a host writing the flow could spoof entitlement locally,
// which is pointless (the server enforces at emission) but noisy.
@RestrictTo(RestrictTo.Scope.LIBRARY_GROUP)
object BrandingServerConfigSignal {
    val flow = MutableStateFlow<BrandingConfigWire?>(null)

    /** Serialized destination mutation; guard must never acquire the facade state lock. */
    @Synchronized
    internal fun publish(value: BrandingConfigWire?, isCurrent: () -> Boolean) {
        if (isCurrent()) flow.value = value
    }

    @VisibleForTesting
    fun resetForTesting() { flow.value = null }
}

/**
 * The host's inline theme option, mirrored out of TraceItXConfig at start()
 * so the reporter UI (a separate module) can read it without a TraceItX
 * dependency cycle. Cleared on kill(); re-seeded by every start().
 */
object BrandingInlineTheme {
    val flow = MutableStateFlow<ReporterThemeOptions?>(null)

    /** Serialized destination mutation; guard must never acquire the facade state lock. */
    @Synchronized
    internal fun publish(value: ReporterThemeOptions?, isCurrent: () -> Boolean) {
        if (isCurrent()) flow.value = value
    }

    @VisibleForTesting
    fun resetForTesting() { flow.value = null }
}

/**
 * Watermark gate. TRUE unless the LATEST server block confirms paid
 * entitlement (`watermark == false`). Absent block (old server, feature not
 * negotiated, fresh/killed session, malformed block) ⇒ shown — fail closed
 * to watermarked.
 */
fun shouldShowWatermark(server: BrandingConfigWire?): Boolean = server?.watermark != false
