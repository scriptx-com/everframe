// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.gradle

import java.security.MessageDigest
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class R8MappingIdentityTest {
    @get:Rule val temporaryFolder = TemporaryFolder()

    @Test fun `mapping id is r8- plus the sha256 of the mapping bytes and a valid SDK id`() {
        val mapping = temporaryFolder.newFile("mapping.txt").apply { writeText("a -> b:\n") }
        val expected = "r8-" + MessageDigest.getInstance("SHA-256").digest("a -> b:\n".toByteArray()).joinToString("") { "%02x".format(it) }
        assertEquals(expected, r8MappingId(mapping))
        assertTrue(Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,127}").matches(expected))
    }

    @Test fun `reads the id back from the generated asset and rejects a file without it`() {
        val file = temporaryFolder.newFile("identity.properties").apply { writeText("r8MappingId=r8-abc\n") }
        assertEquals("r8-abc", readR8MappingId(file))
        file.writeText("other=1\n")
        assertFailsWith<org.gradle.api.GradleException> { readR8MappingId(file) }
    }
}
