// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.gradle

import java.security.MessageDigest
import java.util.UUID
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.gradle.testkit.runner.TaskOutcome
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class R8PluginFunctionalTest {
    @get:Rule val temporaryFolder = TemporaryFolder()
    private val appId = UUID.randomUUID().toString()
    private fun credentials(token: String = "secret-one") = mapOf("EVERFRAME_APP_ID" to appId, "EVERFRAME_API_TOKEN" to token)
    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    @Test fun `assembleRelease uploads the final mapping under the id packaged in the APK`() {
        val fixture = PluginFixture.create(temporaryFolder.newFolder("assemble"))
        val result = fixture.run("assembleRelease", environment = credentials())
        assertEquals(TaskOutcome.SUCCESS, result.task(":uploadEverframeReleaseR8Mapping")?.outcome)
        val invocation = fixture.recordedInvocations().single { it.getOrNull(1) == "r8" }
        val mappingId = invocation[invocation.indexOf("--mapping-id") + 1]
        assertEquals("r8-" + sha256(fixture.recordedMappingBytes()), mappingId)
        assertEquals(listOf("secret-one", "r8", "upload", "--app-id", appId, "--mapping-id", mappingId, "--mapping"), invocation.dropLast(1))
        assertEquals("r8MappingId=$mappingId", fixture.apkAsset("release", "assets/everframe/build-identity.properties").trim())
        assertEquals("600", fixture.recordedBudget())
    }

    @Test fun `bundleRelease uploads once even when assembleRelease also runs`() {
        val fixture = PluginFixture.create(temporaryFolder.newFolder("bundle"))
        fixture.run("assembleRelease", "bundleRelease", environment = credentials())
        assertEquals(1, fixture.recordedInvocations().count { it.getOrNull(1) == "r8" })
    }

    @Test fun `rebuilding identical sources reuses the mapping id`() {
        val fixture = PluginFixture.create(temporaryFolder.newFolder("rebuild"))
        fixture.run("assembleRelease", environment = credentials())
        fixture.run("clean", "assembleRelease", environment = credentials())
        val ids = fixture.recordedInvocations().filter { it.getOrNull(1) == "r8" }.map { it[it.indexOf("--mapping-id") + 1] }
        assertEquals(2, ids.size)
        assertEquals(ids[0], ids[1])
    }

    @Test fun `a build without a token warns and succeeds in CI too, and strict mode fails it`() {
        val fixture = PluginFixture.create(temporaryFolder.newFolder("no-token"))
        val result = fixture.run("assembleRelease", environment = mapOf("EVERFRAME_APP_ID" to appId, "CI" to "1"))
        assertContains(result.output, "warning: everframe: no EVERFRAME_API_TOKEN, skipping R8 mapping upload")
        assertTrue(fixture.recordedInvocations().isEmpty())
        val strict = fixture.runAndFail("assembleRelease", environment = mapOf("EVERFRAME_APP_ID" to appId, "EVERFRAME_SYMBOLS_STRICT" to "1"))
        assertContains(strict.output, "EVERFRAME_API_TOKEN is required to upload the R8 mapping")
    }

    @Test fun `a missing app id warns instead of failing the build`() {
        val fixture = PluginFixture.create(temporaryFolder.newFolder("no-app"))
        val result = fixture.run("assembleRelease", environment = mapOf("EVERFRAME_API_TOKEN" to "secret-one"))
        assertContains(result.output, "warning: everframe: set everframe.appId or EVERFRAME_APP_ID")
        assertTrue(fixture.recordedInvocations().isEmpty())
    }

    @Test fun `debug and non-minified variants register no R8 upload`() {
        val minified = PluginFixture.create(temporaryFolder.newFolder("tasks"))
        assertFalse(minified.run("tasks", "--all").output.contains("uploadEverframeDebugR8Mapping"))
        val plain = PluginFixture.create(temporaryFolder.newFolder("plain"), PluginFixture.Options(minified = false))
        val result = plain.run("assembleRelease", environment = credentials())
        assertEquals(null, result.task(":uploadEverframeReleaseR8Mapping"))
    }

    @Test fun `flavored release uploads per flavor`() {
        val fixture = PluginFixture.create(temporaryFolder.newFolder("flavors"), PluginFixture.Options(flavors = true))
        val result = fixture.run("assembleFreeRelease", environment = credentials())
        assertEquals(TaskOutcome.SUCCESS, result.task(":uploadEverframeFreeReleaseR8Mapping")?.outcome)
    }

    @Test fun `uploadEnabled false leaves the build untouched`() {
        val fixture = PluginFixture.create(temporaryFolder.newFolder("disabled"), PluginFixture.Options(uploadEnabled = false))
        val result = fixture.run("assembleRelease", environment = credentials())
        assertEquals(null, result.task(":uploadEverframeReleaseR8Mapping"))
        assertTrue(fixture.recordedInvocations().isEmpty())
    }

    @Test fun `a failing CLI warns and the build continues, strict mode fails it, and the token is never printed`() {
        val fixture = PluginFixture.create(temporaryFolder.newFolder("failing"), PluginFixture.Options(cliExit = 3))
        val result = fixture.run("assembleRelease", environment = credentials("never-print-me"))
        assertContains(result.output, "warning: everframe: R8 mapping upload failed (exit 3)")
        assertFalse(result.output.contains("never-print-me"))
        val strict = fixture.runAndFail("assembleRelease", environment = credentials("never-print-me") + ("EVERFRAME_SYMBOLS_STRICT" to "1"))
        assertFalse(strict.output.contains("never-print-me"))
    }

    @Test fun `configuration cache reuses the configuration with a rotated token and budget`() {
        val fixture = PluginFixture.create(temporaryFolder.newFolder("cc"))
        fixture.run("assembleRelease", "--configuration-cache", environment = credentials("token-one"))
        val second = fixture.run(
            "assembleRelease", "--configuration-cache",
            environment = credentials("token-two") + ("EVERFRAME_UPLOAD_TIMEOUT_SECONDS" to "45"),
        )
        assertContains(second.output, "Reusing configuration cache")
        assertEquals(listOf("token-one", "token-two"), fixture.recordedInvocations().filter { it.getOrNull(1) == "r8" }.map { it.first() })
        assertEquals("45", fixture.recordedBudget())
    }
}
