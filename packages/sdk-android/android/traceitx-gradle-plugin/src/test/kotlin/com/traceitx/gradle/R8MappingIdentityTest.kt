// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.gradle

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class R8MappingIdentityTest {
    @Test
    fun `identity is stable and isolates variants and modules`() {
        assertEquals(identity("build-1", ":app", "freeRelease"), identity("build-1", ":app", "freeRelease"))
        assertNotEquals(identity("build-1", ":app", "freeRelease"), identity("build-1", ":app", "paidRelease"))
        assertNotEquals(identity("build-1", ":app", "release"), identity("build-1", ":other", "release"))
        assertTrue(identity("build-1", ":app", "release").matches(Regex("r8-[a-f0-9]{64}")))
    }

    @Test
    fun `identity rejects invalid build ids without trimming`() {
        listOf("", " build", "build ", "build id", "x".repeat(129)).forEach { buildId ->
            assertFailsWith<IllegalArgumentException>(buildId) {
                identity(buildId, ":app", "release")
            }
        }
    }

    @Test
    fun `identity accepts every allowed boundary character and maximum length`() {
        val buildId = "a" + "Z09._-".repeat(21) + "x"
        assertEquals(128, buildId.length)
        assertTrue(identity(buildId, ":app", "release").matches(Regex("r8-[a-f0-9]{64}")))
    }
}
