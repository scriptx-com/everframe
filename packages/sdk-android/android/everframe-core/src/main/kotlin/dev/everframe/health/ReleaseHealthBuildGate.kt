// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.health

import android.content.Context
import android.util.Log
import androidx.annotation.VisibleForTesting
import dev.everframe.capture.DeviceMetadata
import dev.everframe.config.ReleaseHealthConfig

/**
 * Decides once per start whether release health runs. The host app's own FLAG_DEBUGGABLE marks a debug
 * build unless `debugBuild` overrides it: the SDK's BuildConfig.DEBUG describes how the SDK was built, not the app, and is never used.
 */
internal object ReleaseHealthBuildGate {
    /** Logged once per start that skips a debug build. */
    const val DEBUG_BUILD_SKIPPED = "[everframe] Release health is off in debug builds."

    /** Test seam replacing the host's debuggable flag. Never set in production. */
    @VisibleForTesting @Volatile internal var __debuggableForTesting: Boolean? = null

    /**
     * [debugBuild] is `EverframeConfig.debugBuild` and wins when set, exactly as it does for the envelopes'
     * `context.app.debug`; otherwise the host's flag decides, via the one reader in [DeviceMetadata].
     */
    fun debuggable(context: Context, debugBuild: Boolean? = null): Boolean = debugBuild
        ?: __debuggableForTesting
        ?: DeviceMetadata.isDebugBuild(context, null)

    /**
     * Off for `null` or `enabled = false`. A debug build, per [debuggable], is off unless
     * [ReleaseHealthConfig.includeDebugBuilds].
     */
    fun enabled(context: Context, config: ReleaseHealthConfig?, debugBuild: Boolean? = null): Boolean {
        if (config == null || !config.enabled) return false
        if (config.includeDebugBuilds || !debuggable(context, debugBuild)) return true
        Log.i("Everframe", DEBUG_BUILD_SKIPPED)
        return false
    }
}
