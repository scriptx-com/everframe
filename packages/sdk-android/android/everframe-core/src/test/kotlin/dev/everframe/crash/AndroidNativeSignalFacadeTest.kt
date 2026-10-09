// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import dev.everframe.Everframe
import org.junit.Assert.*
import org.junit.Test

class AndroidNativeSignalFacadeTest {
    @Test fun `core exposes optional native signal activation without changing OS recovery signatures`() {
        val methods = Everframe::class.java.methods
        assertTrue("normal SDK activation is missing", methods.any { it.name == "setNativeSignalCaptureEnabled" && it.parameterTypes.contentEquals(arrayOf(Boolean::class.javaPrimitiveType)) })
        assertTrue("normal SDK readiness is missing", methods.any { it.name == "isNativeSignalCaptureReady" && it.parameterCount == 0 })
        assertNotNull(Everframe::class.java.getMethod("setNativeCrashRecoveryEnabled", Boolean::class.javaPrimitiveType))
        assertNotNull(Everframe::class.java.getMethod("setProcessExitDiagnosticsEnabled", Boolean::class.javaPrimitiveType))
    }
}
