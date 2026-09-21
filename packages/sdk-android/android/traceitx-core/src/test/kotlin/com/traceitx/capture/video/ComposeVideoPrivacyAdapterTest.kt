// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.capture.video

import android.view.View
import androidx.compose.ui.semantics.*
import com.traceitx.sensitive.TX_SENSITIVE_KEY
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import androidx.test.core.app.ApplicationProvider

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], manifest = Config.NONE)
class ComposeVideoPrivacyAdapterTest {
    class NullOwner { fun getSemanticsOwner(): SemanticsOwner? = null }
    class WrongOwner { fun getSemanticsOwner(): String = "wrong" }
    class ThrowingOwner { fun getSemanticsOwner(): SemanticsOwner = throw IllegalStateException() }
    @Test fun accessorNullWrongTypeAndExceptionExclude() {
        for (host in listOf(NullOwner(), WrongOwner(), ThrowingOwner())) {
            assertNull(ComposeVideoPrivacyAdapter.ownerFromAccessor(host.javaClass.getMethod("getSemanticsOwner"), host))
        }
        assertNull(ComposeVideoPrivacyAdapter.ownerFromAccessor(null, Any()))
    }
    @Test fun versionResourceIsStrictBoundedAndFailClosed() {
        for (value in listOf("1.7.5", "1.9.4")) assertEquals(value, ComposeVideoPrivacyAdapter.readVersion { value.byteInputStream() })
        for (value in listOf("", "1.9.5", "1.7.5\n1.9.4", " ".repeat(32) + "1.7.5"))
            assertNull(ComposeVideoPrivacyAdapter.readVersion { value.byteInputStream() })
        assertNull(ComposeVideoPrivacyAdapter.readVersion { null })
        assertNull(ComposeVideoPrivacyAdapter.readVersion { error("unreadable") })
    }
    @Test fun everySensitivePropertyExcludesWithoutReadingText() {
        assertFalse(ComposeVideoPrivacyAdapter.sensitive(SemanticsConfiguration()))
        val configs = listOf(
            SemanticsConfiguration().apply { this[SemanticsProperties.Password] = Unit },
            SemanticsConfiguration().apply { this[SemanticsProperties.EditableText] = androidx.compose.ui.text.AnnotatedString("") },
            SemanticsConfiguration().apply { this[SemanticsActions.SetText] = AccessibilityAction(null) { _: androidx.compose.ui.text.AnnotatedString -> throw IllegalStateException("must never invoke") } },
            SemanticsConfiguration().apply { this[TX_SENSITIVE_KEY] = true },
            SemanticsConfiguration().apply { isClearingSemantics = true },
        )
        configs.forEach { assertTrue(ComposeVideoPrivacyAdapter.sensitive(it)) }
    }
    @Test fun absentAccessorAndExhaustedBudgetExclude() {
        val view = View(ApplicationProvider.getApplicationContext())
        val adapter = ComposeVideoPrivacyAdapter()
        assertEquals(VideoPrivacyAdapter.Classification.EXCLUDE, adapter.inspect(view, Long.MAX_VALUE, 2048))
        assertEquals(VideoPrivacyAdapter.Classification.EXCLUDE, adapter.inspect(view, 0, 2048))
        assertEquals(VideoPrivacyAdapter.Classification.EXCLUDE, adapter.inspect(view, Long.MAX_VALUE, 0))
    }
}
