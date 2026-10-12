// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.compat.exposure
import dev.everframe.config.EverframeConfig
import dev.everframe.config.ReleaseHealthConfig
object ConfigMain {
    @JvmStatic fun main(args: Array<String>) {
        // The old default-argument descriptor now yields the release health default.
        val old = OldConfigCaller.construct()
        check(old.appId == "old-app" && old.releaseHealth == ReleaseHealthConfig())
        val health = ReleaseHealthConfig()
        val current = EverframeConfig("current-app", "current-key", releaseHealth = health)
        val changed = OldConfigCaller.copy(current)
        check(changed.sdkKey == "copied-key" && changed.releaseHealth === health)
        // An explicit opt-out survives the old copy call.
        check(OldConfigCaller.copy(current.copy(releaseHealth = null)).releaseHealth == null)
        val java = OldJavaConstructors.config(current)
        check(java.appId == "current-app" && java.releaseHealth == ReleaseHealthConfig())
        println("CONFIG_COMPAT_OK")
    }
}
