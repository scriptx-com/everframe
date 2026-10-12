// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crashdefault

import android.app.Application
import dev.everframe.Everframe
import dev.everframe.config.EverframeConfig

/** A fresh integration: one start call with the default configuration and nothing else. */
class ProofApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        Everframe.start(this, EverframeConfig(appId = "crash-default-proof", sdkKey = BuildConfig.PROOF_SDK_KEY))
    }
}
