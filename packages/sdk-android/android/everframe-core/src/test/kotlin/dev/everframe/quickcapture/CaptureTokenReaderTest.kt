// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.quickcapture

import android.content.Context
import android.content.ContextWrapper
import android.provider.Settings
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class CaptureTokenReaderTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    @Test
    fun readsTokenFromSettingsGlobal() {
        Settings.Global.putString(context.contentResolver, CaptureTokenReader.SETTINGS_KEY, "abc123")
        assertEquals("abc123", CaptureTokenReader.read(context))
    }

    @Test
    fun absentKeyReturnsNull() {
        Settings.Global.putString(context.contentResolver, CaptureTokenReader.SETTINGS_KEY, null)
        assertNull(CaptureTokenReader.read(context))
    }

    @Test
    fun validateRules() {
        assertEquals("abc", CaptureTokenReader.validate("  abc  "))
        assertNull(CaptureTokenReader.validate(""))
        assertNull(CaptureTokenReader.validate(null))
        assertNull(CaptureTokenReader.validate("a".repeat(513)))
        assertEquals("a".repeat(512), CaptureTokenReader.validate("a".repeat(512)))
        assertNull(CaptureTokenReader.validate("ab c"))
        assertNull(CaptureTokenReader.validate("tök"))
    }

    @Test
    fun readSwallowsSecurityException() {
        val throwing = object : ContextWrapper(context) {
            override fun getContentResolver(): android.content.ContentResolver =
                throw SecurityException("restricted")
        }
        assertNull(CaptureTokenReader.read(throwing))
    }
}
