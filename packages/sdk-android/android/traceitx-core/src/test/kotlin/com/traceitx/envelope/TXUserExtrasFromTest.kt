// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 9 review fix (spec 2026-08-12) — `TXUserExtras.from(TXUser?)` is the
// single mapping used by all three real `buildEncoded` call sites
// (CompanionSubmissionComposer, CrashReporter, ReporterDialog). It's a plain
// Kotlin function with no Android/Compose dependency, so it's covered here
// directly rather than only indirectly through each call site's own
// (heavier, Robolectric-backed) test — this one test now covers the mapping
// behavior for all three, including ReporterDialog's, without any UI test
// infrastructure.
package com.traceitx.envelope

import com.traceitx.config.TXUser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TXUserExtrasFromTest {

    @Test
    fun `fully-populated TXUser maps all three fields`() {
        val extras = EnvelopeBuilder.TXUserExtras.from(
            TXUser(id = "u_1", email = "a@b.com", displayName = "A"),
        )
        assertEquals("u_1", extras?.id)
        assertEquals("a@b.com", extras?.email)
        assertEquals("A", extras?.displayName)
    }

    @Test
    fun `email-only TXUser maps id and displayName to null, not empty strings`() {
        val extras = EnvelopeBuilder.TXUserExtras.from(TXUser(email = "a@b.com"))
        assertNull(extras?.id)
        assertNull(extras?.displayName)
        assertEquals("a@b.com", extras?.email)
    }

    @Test
    fun `null TXUser maps to null`() {
        assertNull(EnvelopeBuilder.TXUserExtras.from(null))
    }
}
