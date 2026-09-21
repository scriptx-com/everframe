// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.gradle

import org.gradle.testkit.runner.GradleRunner
import org.gradle.testkit.runner.TaskOutcome
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.UUID
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class R8PluginFunctionalTest {
    @get:Rule val temporaryFolder = TemporaryFolder()

    @Test
    fun `disabled plugin leaves application variants untouched`() {
        val fixture = fixture("disabled project", enabled = false)
        val result = fixture.run("tasks", "--all")
        assertFalse(result.output.contains("uploadTraceItXR8"))
        assertFalse(fixture.root.walkTopDown().any { it.name == "BuildConfig.java" && it.readText().contains("TRACEITX_R8_MAPPING_ID") })
    }

    @Test
    fun `debug configures without build identity or upload credentials`() {
        val fixture = fixture("debug project")
        val result = fixture.run("assembleDebug")
        assertEquals(TaskOutcome.SUCCESS, result.task(":assembleDebug")?.outcome)
        val source = fixture.generatedBuildConfig("debug")
        assertContains(source, "TRACEITX_R8_MAPPING_ID = \"\"")
    }

    @Test
    fun `flavored release embeds exact identity and uploads actual AGP mapping`() {
        val fixture = fixture("flavored project", flavors = true)
        File(fixture.root, "build.gradle.kts").appendText("\ntraceitxR8.cliArgs.set(listOf(\"--prefix\"))\n")
        val appId = UUID.randomUUID().toString()
        val result = fixture.run(
            "generateFreeReleaseBuildConfig",
            "uploadTraceItXR8FreeReleaseMapping",
            environment = mapOf(
                "TRACEITX_R8_BUILD_ID" to "build-1",
                "TRACEITX_APP_ID" to appId,
                "TRACEITX_API_TOKEN" to "secret-one",
            ),
        )
        assertEquals(TaskOutcome.SUCCESS, result.task(":uploadTraceItXR8FreeReleaseMapping")?.outcome)
        val expectedId = "r8-5772e6aadbcc9c20ea01d7295b2b76d69449a6499f5685de9a8133b753de6e16"
        assertContains(fixture.generatedBuildConfig("freeRelease"), "TRACEITX_R8_MAPPING_ID = \"$expectedId\"")
        assertEquals(
            listOf("secret-one", "--prefix", "r8", "upload", "--app-id", appId, "--mapping-id", expectedId, "--mapping", fixture.recordedMappingPath()),
            fixture.recordedInvocations().single(),
        )
        assertTrue(fixture.recordedMappingBytes().contentEquals(File(fixture.recordedMappingPath()).readBytes()))
    }

    @Test
    fun `module and flavor produce isolated identities`() {
        val root = temporaryFolder.newFolder("identity modules")
        writeSettings(root, includeOther = true)
        writeApp(root, ".", enabled = true, flavors = true)
        writeApp(root, "other", enabled = true, flavors = false)
        val env = mapOf("TRACEITX_R8_BUILD_ID" to "build-1")
        runner(root, env).withArguments(":generateFreeReleaseBuildConfig", ":other:generateReleaseBuildConfig", "--stacktrace").build()
        val free = findBuildConfig(root, "freeRelease").readText()
        val other = findBuildConfig(File(root, "other"), "release").readText()
        assertContains(free, "r8-5772e6aadbcc9c20ea01d7295b2b76d69449a6499f5685de9a8133b753de6e16")
        assertContains(other, "r8-0806fffe5c11a5de64b5a6e4274e33b3bafa16ed169558440e9f007fd5576ac6")
    }

    @Test
    fun `selected non-minified variant fails visibly`() {
        val fixture = fixture("not minified", minified = false)
        val result = fixture.runAndFail("tasks", environment = mapOf("TRACEITX_R8_BUILD_ID" to "build-1"))
        assertContains(result.output, "selected but minification is disabled")
    }

    @Test
    fun `selected build fails when build identity is missing`() {
        val fixture = fixture("missing build id")
        val result = fixture.runAndFail("generateReleaseBuildConfig")
        assertContains(result.output, "property 'items' doesn't have a configured value")
    }

    @Test
    fun `upload rejects missing and empty mapping files before launching cli`() {
        val fixture = fixture("mapping validation")
        val appId = UUID.randomUUID().toString()
        File(fixture.root, "build.gradle.kts").appendText("""

            tasks.register<com.traceitx.gradle.UploadR8MappingTask>("uploadMissingMapping") {
                mappingFile.set(layout.projectDirectory.file("missing-mapping.txt"))
                mappingId.set("r8-${"a".repeat(64)}")
                appId.set("$appId")
                cliExecutable.set("does-not-matter")
                cliArgs.set(emptyList())
            }
            tasks.register<com.traceitx.gradle.UploadR8MappingTask>("uploadEmptyMapping") {
                mappingFile.set(layout.projectDirectory.file("empty-mapping.txt"))
                mappingId.set("r8-${"a".repeat(64)}")
                appId.set("$appId")
                cliExecutable.set("does-not-matter")
                cliArgs.set(emptyList())
            }
        """.trimIndent())
        File(fixture.root, "empty-mapping.txt").writeBytes(byteArrayOf())
        val environment = mapOf("TRACEITX_API_TOKEN" to "mapping-secret")
        val missing = fixture.runAndFail("uploadMissingMapping", environment = environment)
        assertContains(missing.output, "doesn't exist")
        assertFalse(missing.output.contains("mapping-secret"))
        val empty = fixture.runAndFail("uploadEmptyMapping", environment = environment)
        assertContains(empty.output, "R8 mapping must be a non-empty regular file")
        assertFalse(empty.output.contains("mapping-secret"))
    }

    @Test
    fun `upload validates token app and subprocess failure without leaking token`() {
        val fixture = fixture("failure project", cliExit = 19)
        val missing = fixture.runAndFail(
            "uploadTraceItXR8ReleaseMapping",
            environment = mapOf("TRACEITX_R8_BUILD_ID" to "build-1", "TRACEITX_APP_ID" to UUID.randomUUID().toString()),
        )
        assertContains(missing.output, "TRACEITX_API_TOKEN is required")

        val invalid = fixture.runAndFail(
            "uploadTraceItXR8ReleaseMapping",
            environment = mapOf("TRACEITX_R8_BUILD_ID" to "build-1", "TRACEITX_APP_ID" to "not-a-uuid", "TRACEITX_API_TOKEN" to "hidden-token"),
        )
        assertContains(invalid.output, "appId must be a UUID")
        assertFalse(invalid.output.contains("hidden-token"))

        val failed = fixture.runAndFail(
            "uploadTraceItXR8ReleaseMapping",
            environment = mapOf("TRACEITX_R8_BUILD_ID" to "build-1", "TRACEITX_APP_ID" to UUID.randomUUID().toString(), "TRACEITX_API_TOKEN" to "still-hidden"),
        )
        assertContains(failed.output, "finished with non-zero exit value 19")
        assertFalse(failed.output.contains("still-hidden"))

        val missingExecutable = fixture("missing executable")
        File(missingExecutable.root, "build.gradle.kts").appendText("\ntraceitxR8.cliExecutable.set(\"definitely-no-such-traceitx-cli\")\n")
        val executableFailure = missingExecutable.runAndFail(
            "uploadTraceItXR8ReleaseMapping",
            environment = mapOf("TRACEITX_R8_BUILD_ID" to "build-1", "TRACEITX_APP_ID" to UUID.randomUUID().toString(), "TRACEITX_API_TOKEN" to "secret-executable"),
        )
        assertContains(executableFailure.output, "definitely-no-such-traceitx-cli")
        assertFalse(executableFailure.output.contains("secret-executable"))
    }

    @Test
    fun `upload always runs and configuration cache uses rotated token`() {
        val fixture = fixture("configuration cache project")
        val appId = UUID.randomUUID().toString()
        val common = mapOf("TRACEITX_R8_BUILD_ID" to "same-build", "TRACEITX_APP_ID" to appId)
        fixture.run("uploadTraceItXR8ReleaseMapping", "--configuration-cache", environment = common + ("TRACEITX_API_TOKEN" to "token-one"))
        val second = fixture.run("uploadTraceItXR8ReleaseMapping", "--configuration-cache", environment = common + ("TRACEITX_API_TOKEN" to "token-two"))
        assertContains(second.output, "Reusing configuration cache")
        assertEquals(listOf("token-one", "token-two"), fixture.recordedInvocations().map { it.first() })
        assertEquals(2, fixture.recordedInvocations().size)
    }

    private fun fixture(name: String, enabled: Boolean = true, flavors: Boolean = false, minified: Boolean = true, cliExit: Int = 0): Fixture {
        val root = temporaryFolder.newFolder(name)
        writeSettings(root)
        writeApp(root, ".", enabled, flavors, minified, cliExit)
        return Fixture(root)
    }

    private inner class Fixture(val root: File) {
        fun run(vararg args: String, environment: Map<String, String> = emptyMap()) =
            runner(root, environment).withArguments(*args, "--stacktrace", "--console=plain").build()
        fun runAndFail(vararg args: String, environment: Map<String, String> = emptyMap()) =
            runner(root, environment).withArguments(*args, "--stacktrace", "--console=plain").buildAndFail()
        fun generatedBuildConfig(variant: String) = findBuildConfig(root, variant).readText()
        fun recordedLines() = File(root, "cli-record.txt").readLines()
        fun recordedInvocations(): List<List<String>> = recordedLines()
            .fold(mutableListOf(mutableListOf<String>())) { groups, line ->
                if (line == "---") groups.add(mutableListOf()) else groups.last().add(line)
                groups
            }
            .filter { it.isNotEmpty() }
        fun recordedMappingPath() = recordedInvocations().last().last()
        fun recordedMappingBytes() = File(root, "cli-mapping.bin").readBytes()
    }

    private fun runner(root: File, environment: Map<String, String>) = GradleRunner.create()
        .withProjectDir(root)
        .withPluginClasspath()
        .withGradleVersion("8.10.2")
        .withEnvironment(System.getenv() + environment)

    private fun writeSettings(root: File, includeOther: Boolean = false) {
        File(root, "settings.gradle.kts").writeText("""
            pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
            dependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }
            rootProject.name = "fixture"
            ${if (includeOther) "include(\":other\")" else ""}
        """.trimIndent())
        File(root, "local.properties").writeText("sdk.dir=${System.getenv("ANDROID_HOME") ?: "/Users/aurimas/Library/Android/sdk"}\n")
    }

    private fun writeApp(root: File, relative: String, enabled: Boolean, flavors: Boolean, minified: Boolean = true, cliExit: Int = 0) {
        val dir = File(root, relative).apply { mkdirs() }
        val recorder = File(dir, "record cli.sh").apply {
            writeText("""#!/bin/sh
                {
                  printf '%s\n' "${'$'}TRACEITX_API_TOKEN"
                  printf '%s\n' "${'$'}@"
                  printf '%s\n' '---'
                } >> '${File(root, "cli-record.txt").absolutePath}'
                eval "mapping=\${'$'}{${'$'}#}"
                for arg in "${'$'}@"; do mapping="${'$'}arg"; done
                cp "${'$'}mapping" '${File(root, "cli-mapping.bin").absolutePath}'
                exit $cliExit
            """.trimIndent())
            setExecutable(true)
        }
        File(dir, "build.gradle.kts").writeText("""
            plugins {
                id("com.android.application")${if (relative == ".") " version \"8.7.2\"" else ""}
                id("com.traceitx")
            }
            android {
                namespace = "test.fixture${if (relative == ".") "" else ".other"}"
                compileSdk = 35
                defaultConfig { applicationId = "test.fixture"; minSdk = 24 }
                buildTypes { release { isMinifyEnabled = $minified; proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "rules.pro") } }
                ${if (flavors) "flavorDimensions += \"tier\"; productFlavors { create(\"free\") { dimension = \"tier\" }; create(\"paid\") { dimension = \"tier\" } }" else ""}
            }
            traceitxR8 {
                enabled.set($enabled)
                cliExecutable.set(${quote(recorder.absolutePath)})
            }
        """.trimIndent())
        File(dir, "rules.pro").writeText("-keep class test.fixture.MainActivity { *; }\n")
        File(dir, "src/main").mkdirs()
        File(dir, "src/main/AndroidManifest.xml").writeText("<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\"><application /></manifest>")
        File(dir, "src/main/java/test/fixture").mkdirs()
        File(dir, "src/main/java/test/fixture/MainActivity.java").writeText("package test.fixture; public final class MainActivity { public static String value() { return \"mapped\"; } }")
    }

    private fun findBuildConfig(root: File, variant: String): File = root.walkTopDown().first {
        it.name == "BuildConfig.java" && it.relativeTo(root).invariantSeparatorsPath.startsWith("build/")
    }
    private fun quote(value: String) = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
}
