// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.compat.exposure
import dev.everframe.config.EverframeConfig
import dev.everframe.config.ReleaseHealthConfig
object ConfigMain {
    @JvmStatic fun main(args: Array<String>) {
        check(OldConfigCaller.construct().appId == "old-app")
        val health = ReleaseHealthConfig("loaded-native-build")
        val current = EverframeConfig("current-app", "current-key", releaseHealth = health)
        val changed = OldConfigCaller.copy(current)
        check(changed.sdkKey == "copied-key" && changed.releaseHealth === health)
        check(OldJavaConstructors.config(current).appId == "current-app")
        println("CONFIG_COMPAT_OK")
    }
}
