// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe

import org.junit.Assert.*
import org.junit.Test

/** Crash capture has one switch (CaptureConfig.crash) and one readiness query; nothing to call per start. */
class CrashCapturePublicSurfaceTest {
    @Test fun `crash capture exposes one readiness query and no per-start switches`() {
        val names = Everframe::class.java.methods.map { it.name }.toSet()
        for (removed in listOf("setProcessExitDiagnosticsEnabled", "setNativeCrashRecoveryEnabled", "setNativeSignalCaptureEnabled",
            "isProcessExitDiagnosticsReady", "isNativeCrashRecoveryReady", "isNativeSignalCaptureReady")) {
            assertFalse("$removed must not be public", removed in names)
        }
        assertEquals(0, Everframe::class.java.getMethod("isNativeCrashCaptureReady").parameterCount)
        // The recovered-stall observer is not crash capture and stays opt-in.
        assertNotNull(Everframe::class.java.getMethod("setRecoveredStallObserverEnabled", Boolean::class.javaPrimitiveType))
    }
}
