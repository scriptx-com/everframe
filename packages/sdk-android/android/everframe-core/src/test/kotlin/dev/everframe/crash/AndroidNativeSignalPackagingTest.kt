// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import android.content.Context
import android.content.pm.ApplicationInfo
import android.util.Log
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [30])
class AndroidNativeSignalPackagingTest {
    @get:Rule val folder = TemporaryFolder()
    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private val extract = ApplicationInfo.FLAG_EXTRACT_NATIVE_LIBS
    private val handlers = arrayOf("libeverframe_native_trampoline.so", "libeverframe_native_handler.so")

    private fun installed(vararg names: String): String =
        folder.newFolder().also { dir -> names.forEach { File(dir, it).writeBytes(ByteArray(8)) } }.path
    private fun warnings() = ShadowLog.getLogsForTag("Everframe").filter { it.type == Log.WARN }.map { it.msg }

    @Before fun clearLog() = ShadowLog.clear()

    @Test fun `default app packaging names the missing extraction before arming`() {
        context.applicationInfo.flags = context.applicationInfo.flags and extract.inv()
        context.applicationInfo.nativeLibraryDir = installed()
        assertTrue(AndroidNativeSignalPackaging.refuses(context, modulePresent = true))
        assertEquals(1, warnings().size)
        assertTrue(warnings().single(), warnings().single().contains(AndroidNativeSignalPackaging.NOT_EXTRACTED))
        assertTrue(warnings().single().contains("useLegacyPackaging = true"))
    }

    @Test fun `extracted handler libraries continue setup silently`() {
        context.applicationInfo.flags = context.applicationInfo.flags or extract
        context.applicationInfo.nativeLibraryDir = installed(*handlers, "libeverframe_native_client.so")
        assertFalse(AndroidNativeSignalPackaging.refuses(context, modulePresent = true))
        assertEquals(emptyList<String>(), warnings())
    }

    @Test fun `core-only apps keep their silent not-ready state`() {
        context.applicationInfo.flags = context.applicationInfo.flags and extract.inv()
        context.applicationInfo.nativeLibraryDir = installed()
        // The real module probe: core's test classpath has no native-crash bridge.
        assertFalse(AndroidNativeSignalPackaging.refuses(context))
        assertEquals(emptyList<String>(), warnings())
    }

    @Test fun `extraction alone does not hide a missing handler`() {
        val partial = installed("libeverframe_native_trampoline.so")
        assertEquals(AndroidNativeSignalPackaging.HANDLER_MISSING, AndroidNativeSignalPackaging.refusal(true, extract, partial))
        assertEquals(AndroidNativeSignalPackaging.HANDLER_MISSING, AndroidNativeSignalPackaging.refusal(true, extract, null))
        assertEquals(AndroidNativeSignalPackaging.NOT_EXTRACTED, AndroidNativeSignalPackaging.refusal(true, 0, partial))
    }

    @Test fun `an installed handler is accepted whatever the flag reports`() {
        assertNull(AndroidNativeSignalPackaging.refusal(true, 0, installed(*handlers)))
        assertNull(AndroidNativeSignalPackaging.refusal(false, 0, null))
    }
}
