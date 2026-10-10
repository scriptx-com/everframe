// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.config

import java.io.IOException
import java.io.InputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class BuildArtifactIdentityTest {
    private val config = EverframeConfig(appId = "test-app-id", sdkKey = "txx_live_test1234567890")
    private val id = "r8-" + "a".repeat(64)
    private fun asset(text: String?): (String) -> InputStream? = { path ->
        if (path == BuildArtifactIdentity.ASSET_PATH && text != null) text.byteInputStream() else null
    }

    @Test fun `packaged mapping id fills an unset config`() {
        assertEquals(id, BuildArtifactIdentity.withBuildIdentity(config, asset("r8MappingId=$id\n")).r8MappingId)
    }

    @Test fun `explicit config wins over the asset`() {
        val explicit = config.copy(r8MappingId = "manual-1")
        assertSame(explicit, BuildArtifactIdentity.withBuildIdentity(explicit, asset("r8MappingId=$id\n")))
    }

    @Test fun `missing, empty or malformed assets leave the config unchanged`() {
        for (text in listOf(null, "", "r8MappingId=\n", "r8MappingId=../etc\n", "other=1\n"))
            assertNull(text, BuildArtifactIdentity.withBuildIdentity(config, asset(text)).r8MappingId)
    }

    @Test fun `an unreadable asset never throws`() {
        assertNull(BuildArtifactIdentity.withBuildIdentity(config) { throw IOException("boom") }.r8MappingId)
    }
}
