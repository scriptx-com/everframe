// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.gradle

import java.io.File
import java.util.UUID
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.gradle.testkit.runner.TaskOutcome
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class HermesPluginFunctionalTest {
    @get:Rule val temporaryFolder = TemporaryFolder()
    private val appId = UUID.randomUUID().toString()

    private fun PluginFixture.hermesSteps() = recordedInvocations().filter { it.getOrNull(1) == "build" || it.getOrNull(1) == "sourcemaps" }

    @Test fun `the generated Groovy form uploads the release Hermes bundle after React Native bundles it`() {
        // As generated: dev.everframe applied before React Native's plugin, the app id in `everframe {}`.
        val fixture = PluginFixture.create(
            temporaryFolder.newFolder("rn"),
            PluginFixture.Options(minified = false, reactNative = true, groovyAppId = appId),
        )
        val result = fixture.run("assembleRelease", "--configuration-cache", environment = mapOf("EVERFRAME_API_TOKEN" to "secret"))
        assertEquals(TaskOutcome.SUCCESS, result.task(":uploadEverframeReleaseHermesSourceMap")?.outcome)
        val build = File(fixture.root, "build/generated").canonicalPath
        val staging = File(fixture.root.parentFile, ".everframe").canonicalPath
        val steps = fixture.hermesSteps().map { step -> step.map { File(it).takeIf { file -> file.isAbsolute }?.canonicalPath ?: it } }
        assertEquals(
            listOf(
                listOf("secret", "build", "collect", "--staging", staging, "--platform", "android",
                    "--bundle", "$build/assets/react/release/index.android.bundle",
                    "--source-map", "$build/sourcemaps/react/release/index.android.bundle.map"),
                listOf("secret", "build", "verify", "--staging", staging, "--platform", "android", "--release"),
                listOf("secret", "sourcemaps", "upload-hermes", "--manifest", staging, "--platform", "android", "--app-id", appId),
            ),
            steps,
        )
        // Runs after the bundle exists, and again from the configuration cache.
        assertTrue(result.output.indexOf("createBundleReleaseJsAndAssets") < result.output.indexOf("uploadEverframeReleaseHermesSourceMap"))
        val reused = fixture.run("assembleRelease", "--configuration-cache", environment = mapOf("EVERFRAME_API_TOKEN" to "secret"))
        assertContains(reused.output, "Reusing configuration cache")
        assertEquals(6, fixture.hermesSteps().size)
    }

    @Test fun `a missing token or a failed step warns and the build continues, and strict mode fails it`() {
        val fixture = PluginFixture.create(
            temporaryFolder.newFolder("policy"),
            PluginFixture.Options(minified = false, reactNative = true, cliExit = 2, hermesStagingDir = "js/.everframe"),
        )
        val noToken = fixture.run("assembleRelease", environment = mapOf("EVERFRAME_APP_ID" to appId))
        assertContains(noToken.output, "warning: everframe: no EVERFRAME_API_TOKEN, skipping Hermes source map upload. Crashes from this build " +
            "will show raw frames. Set EVERFRAME_API_TOKEN to a token with the artifacts:write scope, or EVERFRAME_SYMBOLS_STRICT=1 to fail the build instead.")
        assertTrue(fixture.hermesSteps().isEmpty())
        val strictNoToken = fixture.runAndFail("assembleRelease", environment = mapOf("EVERFRAME_APP_ID" to appId, "EVERFRAME_SYMBOLS_STRICT" to "1"))
        assertContains(strictNoToken.output, "EVERFRAME_API_TOKEN is required to upload the Hermes source map")

        val credentials = mapOf("EVERFRAME_APP_ID" to appId, "EVERFRAME_API_TOKEN" to "secret")
        val failed = fixture.run("assembleRelease", environment = credentials)
        assertContains(failed.output, "warning: everframe: Hermes source map upload failed (exit 2). Crashes from this build will show raw frames " +
            "until it is uploaded. Set EVERFRAME_SYMBOLS_STRICT=1 to fail the build instead.")
        // collect failed, so verify and upload never ran; the configured staging folder was used.
        val collect = fixture.hermesSteps().single()
        assertEquals(listOf("build", "collect"), collect.subList(1, 3))
        assertEquals(File(fixture.root, "js/.everframe").canonicalPath, File(collect[collect.indexOf("--staging") + 1]).canonicalPath)
        val strict = fixture.runAndFail("assembleRelease", environment = credentials + ("EVERFRAME_SYMBOLS_STRICT" to "1"))
        assertContains(strict.output, "everframe: Hermes source map upload failed (exit 2)")
    }

    @Test fun `the default CLI command runs with NODE_BINARY for every upload`() {
        // No cliCommand: the build finds node_modules/@everframe/cli and runs it with NODE_BINARY,
        // as the removed generated Gradle block did with ${NODE_BINARY:-node}.
        val fixture = PluginFixture.create(
            temporaryFolder.newFolder("node binary"),
            PluginFixture.Options(minified = true, nativeLibrary = true, reactNative = true, defaultCli = true),
        )
        val stub = fixture.stubNode().absolutePath
        val environment = mapOf("EVERFRAME_APP_ID" to appId, "EVERFRAME_API_TOKEN" to "secret", "NODE_BINARY" to stub)
        fixture.run("assembleRelease", "--configuration-cache", environment = environment)
        val cli = fixture.installedCli().canonicalPath
        val first = fixture.recordedInvocations()
        assertEquals(setOf("r8", "elf", "build", "sourcemaps"), first.map { it.getOrNull(2) }.toSet(), first.toString())
        assertTrue(first.all { it[1] == cli }, first.toString())
        assertEquals(List(first.size) { stub }, fixture.recordedNodes())
        // The configuration cache keeps it, and EVERFRAME_CLI_JS runs with NODE_BINARY too.
        val reused = fixture.run("assembleRelease", "--configuration-cache", environment = environment)
        assertContains(reused.output, "Reusing configuration cache")
        assertEquals(2 * first.size, fixture.recordedNodes().size)
        fixture.run("assembleRelease", environment = environment + ("EVERFRAME_CLI_JS" to "/custom/cli.js"))
        val custom = fixture.recordedInvocations().drop(2 * first.size)
        assertEquals(first.size, custom.size)
        assertTrue(custom.all { it[1] == "/custom/cli.js" }, custom.toString())
        assertEquals(List(3 * first.size) { stub }, fixture.recordedNodes())
    }

    @Test fun `an app without React Native gets no Hermes task and no Hermes warnings`() {
        val fixture = PluginFixture.create(temporaryFolder.newFolder("native"), PluginFixture.Options(minified = false))
        assertFalse(fixture.run("tasks", "--all").output.contains("HermesSourceMap"))
        val result = fixture.run("assembleRelease")
        assertEquals(null, result.task(":uploadEverframeReleaseHermesSourceMap"))
        assertFalse(result.output.contains("Hermes"), result.output)
        assertFalse(result.output.contains("JS-bundling"), result.output)
    }
}
