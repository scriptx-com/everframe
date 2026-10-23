// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.quickcapture

import android.content.Context
import android.content.ContextWrapper
import android.provider.Settings
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class CaptureTokenReaderTest {
    private companion object {
        const val INGEST = "https://everframe.dev"
    }

    private val context: Context = ApplicationProvider.getApplicationContext()

    @After
    fun tearDown() {
        Settings.Global.putString(context.contentResolver, CaptureTokenReader.SETTINGS_KEY, null)
        Settings.Global.putString(context.contentResolver, CaptureTokenReader.ORIGIN_SETTINGS_KEY, null)
    }

    private fun tokenFor(origin: String?, ingest: String = INGEST): String? {
        Settings.Global.putString(context.contentResolver, CaptureTokenReader.SETTINGS_KEY, "abc123")
        Settings.Global.putString(context.contentResolver, CaptureTokenReader.ORIGIN_SETTINGS_KEY, origin)
        return CaptureTokenReader.read(context, ingest)
    }

    @Test
    fun matchingOriginReturnsTheToken() {
        assertEquals("abc123", tokenFor("https://everframe.dev"))
        assertEquals("abc123", tokenFor("https://EverFrame.dev:443/"))
        assertEquals("abc123", tokenFor("https://everframe.dev", ingest = "https://everframe.dev/api/ingest"))
        assertEquals("abc123", tokenFor("http://10.0.2.2:8787", ingest = "http://10.0.2.2:8787"))
    }

    @Test
    fun differentHostPortOrSchemeReturnsNull() {
        assertNull(tokenFor("https://evil.example"))
        assertNull(tokenFor("https://everframe.dev:8443"))
        assertNull(tokenFor("http://everframe.dev"))
        assertNull(tokenFor("https://staging.everframe.dev"))
    }

    @Test
    fun noRecordedOriginKeepsTheToken() {
        assertEquals("abc123", tokenFor(null))
    }

    @Test
    fun unparseableOriginReturnsNull() {
        assertNull(tokenFor("garbage"))
        assertNull(tokenFor(""))
        assertNull(tokenFor("https://"))
        assertNull(tokenFor("ftp://everframe.dev"))
        assertNull(tokenFor("https://everframe.dev", ingest = "not a url"))
    }

    @Test
    fun readsTokenFromSettingsGlobal() {
        Settings.Global.putString(context.contentResolver, CaptureTokenReader.SETTINGS_KEY, "abc123")
        assertEquals("abc123", CaptureTokenReader.read(context, INGEST))
    }

    @Test
    fun absentKeyReturnsNull() {
        Settings.Global.putString(context.contentResolver, CaptureTokenReader.SETTINGS_KEY, null)
        assertNull(CaptureTokenReader.read(context, INGEST))
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
        assertNull(CaptureTokenReader.read(throwing, INGEST))
    }
}
