// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.gradle

import java.util.UUID
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.gradle.testkit.runner.TaskOutcome
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class NativeSymbolsPluginFunctionalTest {
    @get:Rule val temporaryFolder = TemporaryFolder()
    private val appId = UUID.randomUUID().toString()
    private val credentials = mapOf("EVERFRAME_APP_ID" to appId, "EVERFRAME_API_TOKEN" to "secret")

    @Test fun `assembleRelease uploads merged native libraries against the stripped ones it ships`() {
        val fixture = PluginFixture.create(temporaryFolder.newFolder("native"), PluginFixture.Options(minified = false, nativeLibrary = true))
        val result = fixture.run("assembleRelease", environment = credentials)
        assertEquals(TaskOutcome.SUCCESS, result.task(":uploadEverframeReleaseNativeSymbols")?.outcome)
        val invocation = fixture.recordedInvocations().single { it.getOrNull(1) == "elf" }
        assertEquals(listOf("secret", "elf", "upload-build", "--app-id", appId, "--binaries-dir"), invocation.take(6))
        assertTrue(invocation[6].contains("stripped_native_libs"), invocation[6])
        assertEquals("--symbols-dir", invocation[7])
        assertTrue(invocation[8].contains("merged_native_libs"), invocation[8])
        assertTrue(fixture.recordedSymbolFiles().single().endsWith("arm64-v8a/libfixture.so"))
    }

    @Test fun `a variant without native libraries never calls the CLI`() {
        val fixture = PluginFixture.create(temporaryFolder.newFolder("jvm"), PluginFixture.Options(minified = false))
        val result = fixture.run("assembleRelease", environment = credentials)
        assertEquals(TaskOutcome.SUCCESS, result.task(":uploadEverframeReleaseNativeSymbols")?.outcome)
        assertTrue(fixture.recordedInvocations().none { it.getOrNull(1) == "elf" })
    }

    @Test fun `bundleRelease uploads native symbols too, and a failed upload only warns`() {
        val fixture = PluginFixture.create(temporaryFolder.newFolder("bundle"), PluginFixture.Options(minified = false, nativeLibrary = true, cliExit = 2))
        val result = fixture.run("bundleRelease", environment = credentials)
        assertEquals(1, fixture.recordedInvocations().count { it.getOrNull(1) == "elf" })
        assertContains(result.output, "warning: everframe: native symbols upload failed (exit 2)")
    }
}
