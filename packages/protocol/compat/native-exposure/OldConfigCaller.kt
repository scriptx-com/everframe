// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.compat.exposure
import dev.everframe.config.EverframeConfig
object OldConfigCaller {
    @JvmStatic fun construct() = EverframeConfig("old-app", "old-key")
    @JvmStatic fun copy(value: EverframeConfig) = value.copy(sdkKey = "copied-key")
}
