// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture

import android.os.Build

internal object EmulatorEnvironment {
    /**
     * Emulator heuristic (naming spec 2026-08-24): the same signals Android
     * tooling has used for a decade to detect a stock AVD / Genymotion /
     * Google-Play-emulator image. Null-safe throughout — every `Build` field
     * involved reads back null under a plain (unmocked) JVM, which a bare
     * `.contains` call on a non-null-asserted String would otherwise NPE on.
     */
    fun isEmulator(): Boolean {
        val fingerprint = Build.FINGERPRINT
        val model = Build.MODEL
        val product = Build.PRODUCT
        return fingerprint?.contains("generic") == true ||
            fingerprint?.contains("emulator") == true ||
            model?.contains("sdk_gphone") == true ||
            product?.contains("sdk") == true
    }
}
