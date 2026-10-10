// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.gradle

import java.util.UUID
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
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
        assertEquals("--summary", invocation[9])
        assertFalse(invocation.contains("--abi"), "no ABI filter means every merged ABI")
        val symbols = fixture.recordedSymbolFiles()
        assertEquals(2, symbols.size)
        assertTrue(symbols[0].endsWith("arm64-v8a/libfixture.so") && symbols[1].endsWith("x86_64/libfixture.so"), symbols.toString())
    }

    @Test fun `only the ABIs the variant packages are considered`() {
        val fixture = PluginFixture.create(
            temporaryFolder.newFolder("abi"),
            PluginFixture.Options(minified = false, nativeLibrary = true, abiFilters = listOf("arm64-v8a")),
        )
        fixture.run("assembleRelease", environment = credentials)
        val invocation = fixture.recordedInvocations().single { it.getOrNull(1) == "elf" }
        assertEquals(listOf("--abi", "arm64-v8a"), invocation.takeLast(2))
        assertEquals(1, invocation.count { it == "--abi" })
    }

    @Test fun `prebuilt libraries stay at info and own libraries without symbols warn once with a count`() {
        val fixture = PluginFixture.create(
            temporaryFolder.newFolder("summary"),
            PluginFixture.Options(
                minified = false,
                nativeLibrary = true,
                cliOutput = listOf(
                    "Symbols for 1 images are ready (1 ELF files).",
                    "detail: prebuilt /p/libandroidx.graphics.path.so: prebuilt without debug information (build ID aa, arm64-v8a)",
                    "detail: missing /p/libown.so: no unstripped library with build ID bb (arm64-v8a) under /m",
                    "detail: not_an_image /p/libother.so: no GNU build ID or not a shared library",
                ),
            ),
        )
        val quiet = fixture.run("assembleRelease", environment = credentials)
        assertContains(quiet.output, "Symbols for 1 images are ready (1 ELF files).")
        assertEquals(1, Regex("warning: everframe:").findAll(quiet.output).count(), quiet.output)
        assertContains(quiet.output, "warning: everframe: 2 native libraries have no symbols in release, so their frames stay raw. Run with --info to list them.")
        assertFalse(quiet.output.contains("libandroidx"), quiet.output)
        assertFalse(quiet.output.contains("libown.so"), quiet.output)
        val info = fixture.run("assembleRelease", "--info", environment = credentials)
        assertContains(info.output, "everframe: prebuilt /p/libandroidx.graphics.path.so: prebuilt without debug information")
        assertContains(info.output, "everframe: missing /p/libown.so")
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
