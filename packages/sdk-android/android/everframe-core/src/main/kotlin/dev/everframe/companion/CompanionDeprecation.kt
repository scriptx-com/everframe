// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Everframe Companion has been removed. Its documented API stays as
// deprecated no-op stubs until the next major so apps that follow the docs
// keep compiling. The first pairing call in a process logs one warning that
// points the developer at device linking and quick capture.

package dev.everframe.companion

import androidx.annotation.VisibleForTesting

/** The message every deprecated Companion symbol carries, and the one-time warning. */
internal const val COMPANION_REMOVED_MESSAGE: String =
    "Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture."

internal object CompanionDeprecation {
    /** How many times the warning has been logged in this process: 0 or 1. */
    @VisibleForTesting
    @Volatile
    internal var emittedCount: Int = 0

    /** Logs the removal warning once per process. Never throws. */
    fun warnOnce() {
        synchronized(this) {
            if (emittedCount > 0) return
            emittedCount = 1
        }
        runCatching { android.util.Log.w("Everframe", COMPANION_REMOVED_MESSAGE) }
    }
}
