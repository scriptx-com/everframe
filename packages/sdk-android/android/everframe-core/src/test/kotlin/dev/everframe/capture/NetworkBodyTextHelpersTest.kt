// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkBodyTextHelpersTest {

    private val allowlist = listOf("application/json", "text/*")

    @Test
    fun exactMatchIsAllowed() {
        assertTrue(NetworkBodyTee.contentTypeAllowed("application/json", allowlist))
    }

    @Test
    fun parametersAndCaseAreIgnored() {
        assertTrue(NetworkBodyTee.contentTypeAllowed("Application/JSON; charset=utf-8", allowlist))
    }

    @Test
    fun wildcardMatchesSubtypes() {
        assertTrue(NetworkBodyTee.contentTypeAllowed("text/plain", allowlist))
        assertTrue(NetworkBodyTee.contentTypeAllowed("text/html", allowlist))
    }

    @Test
    fun wildcardDoesNotMatchAcrossTypes() {
        assertFalse(NetworkBodyTee.contentTypeAllowed("textual/plain", allowlist))
    }

    @Test
    fun unlistedTypeIsRejected() {
        assertFalse(NetworkBodyTee.contentTypeAllowed("image/png", allowlist))
    }

    // Ported edge case: iOS review found "" / ";" / ";;" crash a naive [0] index.
    @Test
    fun degenerateInputsAreRejectedNotCrashed() {
        assertFalse(NetworkBodyTee.contentTypeAllowed(null, allowlist))
        assertFalse(NetworkBodyTee.contentTypeAllowed("", allowlist))
        assertFalse(NetworkBodyTee.contentTypeAllowed(";", allowlist))
        assertFalse(NetworkBodyTee.contentTypeAllowed(";;", allowlist))
        assertFalse(NetworkBodyTee.contentTypeAllowed("   ", allowlist))
    }

    @Test
    fun utf8PrefixReturnsWholeStringWhenUnderCap() {
        val data = "hello".toByteArray(Charsets.UTF_8)
        assertEquals("hello", NetworkBodyTee.utf8Prefix(data, 100))
    }

    @Test
    fun utf8PrefixBacksOffFromASplitCodepoint() {
        // "é" is 2 bytes (0xC3 0xA9). Cutting at 2 splits it; expect back-off to "a".
        val data = "aé".toByteArray(Charsets.UTF_8) // a(1) + é(2) = 3 bytes
        assertEquals("a", NetworkBodyTee.utf8Prefix(data, 2))
    }

    @Test
    fun utf8PrefixReturnsNullForNonUtf8Bytes() {
        val data = byteArrayOf(0xFF.toByte(), 0xFE.toByte(), 0xFF.toByte(), 0xFE.toByte())
        assertNull(NetworkBodyTee.utf8Prefix(data, 4))
    }
}
