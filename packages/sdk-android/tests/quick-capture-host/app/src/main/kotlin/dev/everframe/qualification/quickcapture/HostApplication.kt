// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.qualification.quickcapture

import android.app.Application
import dev.everframe.Everframe
import dev.everframe.config.EverframeConfig

/**
 * One start call with the default configuration and the local platform's key. The key is never logged.
 * `debugBuild` is null (the app's own flag) unless the host was built with `-PquickCaptureHost.releaseMode=true`.
 */
class HostApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        Everframe.start(this, EverframeConfig(appId = "quick-capture-host", sdkKey = BuildConfig.HOST_SDK_KEY, debugBuild = BuildConfig.HOST_DEBUG_BUILD))
    }
}
