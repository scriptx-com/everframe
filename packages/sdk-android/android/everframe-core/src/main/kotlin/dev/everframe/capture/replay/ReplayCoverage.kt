// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.replay

/**
 * Which replay coverage a session samples against (crash-only sessions, spec 2026-10-12). Every kind
 * compares the session's one draw against its own rate.
 */
internal enum class ReplayCoverage {
    /** A session that can file a report: `samplingRate`. */
    Report,

    /** Started with `reporterEnabled = false`: `crashOnlySamplingRate`, 0 when absent. */
    CrashOnly;

    fun samplingRate(samplingRate: Double, crashOnlySamplingRate: Double?): Double = when (this) {
        Report -> samplingRate
        CrashOnly -> crashOnlySamplingRate ?: 0.0
    }
}
