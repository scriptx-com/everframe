// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe

import dev.everframe.crash.AndroidNativeCrashRuntime
import dev.everframe.crash.AndroidNativeRecoveryRequests
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Public recovery switches must erase previous-process evidence only on an explicit false or an API30 narrowing. */
@RunWith(RobolectricTestRunner::class)
class ProcessExitRecoveryModeTest {
    private val publishedStartEpoch = Everframe::class.java.getDeclaredField("_publishedStartEpoch").apply { isAccessible = true }

    /** Enables are fenced until a start publishes its epoch, so publish the current one as start() does. */
    private var previousPublishedStartEpoch: Any? = null

    @Before fun publishStart() {
        previousPublishedStartEpoch = publishedStartEpoch.get(null)
        val epoch = Everframe::class.java.getDeclaredField("_startEpoch").apply { isAccessible = true }.getInt(null)
        publishedStartEpoch.set(null, epoch)
    }

    @After fun restorePublishedStart() { publishedStartEpoch.set(null, previousPublishedStartEpoch) }

    /** Consumes and reports any durable-erasure obligation the switch calls left for the next owner. */
    private fun erasureScheduled(): Boolean {
        val runtime = AndroidNativeCrashRuntime::class.java
        val requests = runtime.getDeclaredField("requests").apply { isAccessible = true }.get(null) as AndroidNativeRecoveryRequests
        val deferred = runtime.getDeclaredField("eraseWhenContextAvailable").apply { isAccessible = true }
        var scheduled = deferred.getBoolean(null)
        deferred.setBoolean(null, false)
        requests.finishRevocation { scheduled = true; true }
        return scheduled
    }

    @Test @Config(sdk = [31])
    fun `switching recovery mode in one start keeps previous process evidence`() {
        Everframe.setNativeCrashRecoveryEnabled(true)
        Everframe.setProcessExitDiagnosticsEnabled(true)
        assertFalse("selecting diagnostics after native-only erased evidence", erasureScheduled())
        Everframe.setNativeCrashRecoveryEnabled(true)
        assertFalse("selecting native-only after diagnostics erased evidence", erasureScheduled())
        Everframe.setProcessExitDiagnosticsEnabled(false)
        assertTrue("explicit false must erase unadmitted evidence", erasureScheduled())
    }

    @Test @Config(sdk = [30])
    fun `API30 native-only switch erases only the diagnostics mode it narrows`() {
        Everframe.setNativeCrashRecoveryEnabled(true)
        assertFalse("unsupported native-only mode erased previous process diagnostics", erasureScheduled())
        Everframe.setProcessExitDiagnosticsEnabled(true)
        assertFalse(erasureScheduled())
        Everframe.setNativeCrashRecoveryEnabled(true)
        assertTrue("narrowing to unsupported native-only mode must erase unadmitted diagnostics", erasureScheduled())
    }
}
