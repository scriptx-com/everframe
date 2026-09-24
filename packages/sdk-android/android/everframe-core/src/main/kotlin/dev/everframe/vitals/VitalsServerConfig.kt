// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Server-driven vitals gate (spec 2026-09-05 §1). Written at ReplaySession's
// config-apply site, read by VitalsController. Copy of BrandingServerConfigSignal.
package dev.everframe.vitals

import androidx.annotation.RestrictTo
import androidx.annotation.VisibleForTesting
import dev.everframe.config.ReplayConfig
import kotlinx.coroutines.flow.MutableStateFlow

data class VitalsServerConfig(val vitalsEnabled: Boolean, val vitalsSampleRate: Double)

@RestrictTo(RestrictTo.Scope.LIBRARY_GROUP)
object VitalsServerConfigSignal {
    /** null = no config applied yet this session. */
    val flow = MutableStateFlow<VitalsServerConfig?>(null)

    /**
     * Codex round-4, #4 — serializes the "is my generation still current?"
     * decision with the write it guards. Every writer used to check its own
     * predicate and then assign: `start(B)`'s check passed, B was descheduled,
     * `start(C)` completed and its replay refresh published C's vitals gate,
     * and B then resumed and wrote `null` over it — disabling C's collector
     * for the rest of the session if C's own fetch never refreshed again. The
     * predicate now runs INSIDE the same critical section as the assignment,
     * so a competing publish is ordered either entirely before it (and the
     * predicate answers false) or entirely after it.
     */
    private val gate = Any()

    /**
     * Publish [value] iff [ifCurrent] — evaluated under [gate] — still says
     * this writer owns the signal.
     *
     * Lock order: [gate] is OUTERMOST with respect to `Everframe.stateLock`
     * and `ReplaySession.sessionLock`, both of which the predicates reach
     * for. No caller may hold either of those when calling this, and none
     * does: `start()`'s and `kill()`'s vitals clears sit outside `stateLock`
     * (a `StateFlow` assignment can run collectors on the assigning thread,
     * which is why they were moved out in the first place), and
     * `ReplaySession.refreshConfigNow` holds `sessionLock` only inside
     * `currentGenerationValid` itself.
     */
    fun publish(value: VitalsServerConfig?, ifCurrent: () -> Boolean) {
        synchronized(gate) { if (ifCurrent()) flow.value = value }
    }

    @VisibleForTesting
    fun resetForTesting() { synchronized(gate) { flow.value = null } }
}

fun ReplayConfig.toVitalsServerConfig(): VitalsServerConfig = VitalsServerConfig(
    vitalsEnabled = vitalsEnabled ?: false,
    vitalsSampleRate = (vitalsSampleRate ?: 1.0).coerceIn(0.0, 1.0),
)
