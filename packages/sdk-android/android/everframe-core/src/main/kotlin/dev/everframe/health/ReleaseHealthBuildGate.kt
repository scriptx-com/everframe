// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.health

import android.content.Context
import android.content.pm.ApplicationInfo
import android.util.Log
import androidx.annotation.VisibleForTesting
import dev.everframe.config.ReleaseHealthConfig

/**
 * Decides once per start whether release health runs. The host app's own FLAG_DEBUGGABLE marks a debug
 * build: the SDK's BuildConfig.DEBUG describes how the SDK was built, not the app, and is never used.
 */
internal object ReleaseHealthBuildGate {
    /** Logged once per start that skips a debug build. */
    const val DEBUG_BUILD_SKIPPED = "[everframe] Release health is off in debug builds."

    /** Test seam replacing the host's debuggable flag. Never set in production. */
    @VisibleForTesting @Volatile internal var __debuggableForTesting: Boolean? = null

    /** An unreadable ApplicationInfo counts as a release build. */
    fun debuggable(context: Context): Boolean = __debuggableForTesting
        ?: (((context.applicationInfo?.flags ?: 0) and ApplicationInfo.FLAG_DEBUGGABLE) != 0)

    /** Off for `null` or `enabled = false`. A debuggable host is off unless [ReleaseHealthConfig.includeDebugBuilds]. */
    fun enabled(context: Context, config: ReleaseHealthConfig?): Boolean {
        if (config == null || !config.enabled) return false
        if (config.includeDebugBuilds || !debuggable(context)) return true
        Log.i("Everframe", DEBUG_BUILD_SKIPPED)
        return false
    }
}
