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

    @Test fun `bundle uploads the bundle's ABIs, and assemble with bundle uploads the union`() {
        // ABI splits without a universal APK narrow the APKs to arm64-v8a; the bundle still ships x86_64.
        val fixture = PluginFixture.create(
            temporaryFolder.newFolder("splits"),
            PluginFixture.Options(minified = false, nativeLibrary = true, abiSplits = listOf("arm64-v8a")),
        )
        fun abis() = fixture.recordedInvocations().last { it.getOrNull(1) == "elf" }.let { invocation ->
            invocation.indices.filter { invocation[it] == "--abi" }.map { invocation[it + 1] }
        }
        fixture.run("assembleRelease", environment = credentials)
        assertEquals(listOf("arm64-v8a"), abis())
        fixture.run("bundleRelease", environment = credentials)
        assertEquals(emptyList(), abis(), "the bundle packages every merged ABI")
        fixture.run("assembleRelease", "bundleRelease", environment = credentials)
        assertEquals(emptyList(), abis(), "both together need the union")
        // The choice survives the configuration cache.
        fixture.run("bundleRelease", "--configuration-cache", environment = credentials)
        val reused = fixture.run("bundleRelease", "--configuration-cache", environment = credentials)
        assertContains(reused.output, "Reusing configuration cache")
        assertEquals(emptyList(), abis())
        fixture.run("assembleRelease", "--configuration-cache", environment = credentials)
        assertEquals(listOf("arm64-v8a"), abis())
        assertEquals(6, fixture.recordedInvocations().count { it.getOrNull(1) == "elf" })
    }

    @Test fun `a CLI that outlives its time budget is stopped with its children, and the build continues`() {
        val fixture = PluginFixture.create(
            temporaryFolder.newFolder("stalled"),
            PluginFixture.Options(minified = false, nativeLibrary = true, cliSleepSeconds = 120),
        )
        val budget = credentials + ("EVERFRAME_UPLOAD_TIMEOUT_SECONDS" to "1")
        val started = System.nanoTime()
        val result = fixture.run("assembleRelease", environment = budget)
        assertContains(result.output, "warning: everframe: the native symbols upload did not finish within 2 seconds and was stopped " +
            "(EVERFRAME_UPLOAD_TIMEOUT_SECONDS=1, plus time for npx to fetch the CLI)")
        assertTrue(System.nanoTime() - started < java.util.concurrent.TimeUnit.SECONDS.toNanos(100), "the build waited for the stalled CLI")
        assertFalse(ProcessHandle.of(fixture.recordedSleeper()).map { it.isAlive }.orElse(false), "the CLI's child still runs")
        // npx gets bounded registry fetches, as in the Xcode phase.
        assertEquals("20000|1|5000", fixture.recordedNpmLimits())
        val strict = fixture.runAndFail("assembleRelease", environment = budget + ("EVERFRAME_SYMBOLS_STRICT" to "1"))
        assertContains(strict.output, "everframe: the native symbols upload did not finish within 2 seconds")
    }

    @Test fun `the project's own CMake output folders are passed to the CLI`() {
        val fixture = PluginFixture.create(
            temporaryFolder.newFolder("cmake"),
            PluginFixture.Options(minified = false, abiFilters = listOf("arm64-v8a"), cmakeFlags = "-g0"),
        )
        fixture.run("assembleRelease", environment = credentials)
        val invocation = fixture.recordedInvocations().single { it.getOrNull(1) == "elf" }
        val folders = invocation.indices.filter { invocation[it] == "--project-native-dir" }.map { java.io.File(invocation[it + 1]) }
        assertTrue(folders.isNotEmpty(), invocation.toString())
        assertTrue(folders.flatMap { it.walkTopDown().toList() }.any { it.name == "libnative.so" && it.parentFile.name == "arm64-v8a" }, folders.toString())
        assertTrue(fixture.recordedSymbolFiles().any { it.endsWith("arm64-v8a/libnative.so") })
    }

    @Test fun `the project's own libraries without debug information warn once with the fix`() {
        val fixture = PluginFixture.create(
            temporaryFolder.newFolder("own"),
            PluginFixture.Options(
                minified = false,
                nativeLibrary = true,
                cliOutput = listOf(
                    "Symbols for 0 images are ready (0 ELF files).",
                    "detail: prebuilt /p/x86_64/libc++_shared.so: prebuilt without debug information (build ID aa, x86_64)",
                    "detail: no_debug_info /p/arm64-v8a/libnative.so: built by this project without debug information (build ID cc, arm64-v8a)",
                    "detail: no_debug_info /p/x86_64/libnative.so: built by this project without debug information (build ID dd, x86_64)",
                    "detail: missing /p/arm64-v8a/libother.so: no unstripped library with build ID bb (arm64-v8a) under /m",
                ),
            ),
        )
        val result = fixture.run("assembleRelease", environment = credentials)
        assertContains(result.output, "warning: everframe: 1 native library this project builds has no debug information in release, " +
            "so its frames stay raw: libnative.so. Build it with debug information (CMake: RelWithDebInfo, or -g in CMAKE_C_FLAGS and " +
            "CMAKE_CXX_FLAGS; ndk-build: -g in LOCAL_CFLAGS) and do not strip it before packaging (no -s or -Wl,--strip-all): " +
            "the Android Gradle plugin strips the copy the app ships.")
        assertContains(result.output, "warning: everframe: 1 native library has no symbols in release, so their frames stay raw.")
        assertEquals(2, Regex("warning: everframe:").findAll(result.output).count(), result.output)
        assertFalse(result.output.contains("libc++_shared"), result.output)
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

    @Test fun `a relative CLI command runs in the owning project's directory when Gradle runs from the root`() {
        // `:app` of a root build, with cliCommand "./record cli.sh" beside app/build.gradle.kts. Gradle
        // runs from the root and its daemon's working directory is neither, so only the project
        // directory resolves the command.
        val fixture = PluginFixture.create(
            temporaryFolder.newFolder("subproject"),
            PluginFixture.Options(minified = true, nativeLibrary = true, relativeCliInSubproject = true),
        )
        val result = fixture.run("assembleRelease", environment = credentials)
        assertEquals(TaskOutcome.SUCCESS, result.task(":app:uploadEverframeReleaseNativeSymbols")?.outcome)
        assertFalse(result.output.contains("could not run the Everframe CLI"), result.output)
        assertEquals(listOf("elf", "r8"), fixture.recordedInvocations().map { it[1] }.sorted())
        assertEquals(java.io.File(fixture.root, "app").canonicalPath, fixture.recordedWorkingDirectory())
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
