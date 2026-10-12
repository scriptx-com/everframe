// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

/**
 * Android keeps one process-state summary per process. While capture.crash is on, the SDK owns it.
 * A summary another writer left on an earlier exit of this process means that writer replaced the
 * SDK's token: those exits cannot be matched and are not reported. They are never misattributed.
 */
internal object ProcessStateSummaryConflict {
    const val REASON = "process-state-summary-conflict"
    private val prefix = "everframe-native-".toByteArray(Charsets.US_ASCII)

    fun foreign(exits: List<AndroidNativeExit>, processName: String): Boolean = exits.any { exit ->
        val summary = exit.stateSummary ?: return@any false
        exit.processName == processName &&
            (summary.size < prefix.size || !summary.copyOfRange(0, prefix.size).contentEquals(prefix))
    }

    fun warn() {
        android.util.Log.w("Everframe", "OS exit capture: $REASON. Another writer called " +
            "ActivityManager.setProcessStateSummary in this process; exits it overwrote are not reported.")
    }
}
