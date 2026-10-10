// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.gradle

import java.io.File
import java.util.zip.ZipFile
import org.gradle.testkit.runner.BuildResult
import org.gradle.testkit.runner.GradleRunner

/** A minimal Android application that applies dev.everframe and records every CLI call. */
internal class PluginFixture private constructor(val root: File) {
    data class Options(
        val uploadEnabled: Boolean = true,
        val flavors: Boolean = false,
        val minified: Boolean = true,
        val cliExit: Int = 0,
        val nativeLibrary: Boolean = false,
        /** `ndk.abiFilters` of the default config; the fixture ships arm64-v8a and x86_64 libraries. */
        val abiFilters: List<String> = emptyList(),
        /** Lines the fake CLI prints before exiting. */
        val cliOutput: List<String> = emptyList(),
        /** APK ABI splits (`splits.abi.include`), with or without a universal APK. */
        val abiSplits: List<String> = emptyList(),
        val universalApk: Boolean = false,
        /** The fake CLI waits this long in a child process before it exits, as a stalled `npx` would. */
        val cliSleepSeconds: Int = 0,
        /** A CMake library `libnative.so` the project builds itself, with these C flags. */
        val cmakeFlags: String? = null,
        /**
         * The app is the `:app` subproject of a root build, and `cliCommand` is the recorder's path
         * relative to the app project's directory, as a checked-in script would be named.
         */
        val relativeCliInSubproject: Boolean = false,
    )

    fun run(vararg args: String, environment: Map<String, String> = emptyMap()): BuildResult =
        runner(environment).withArguments(*args, "--stacktrace", "--console=plain").build()
    fun runAndFail(vararg args: String, environment: Map<String, String> = emptyMap()): BuildResult =
        runner(environment).withArguments(*args, "--stacktrace", "--console=plain").buildAndFail()

    /** Each invocation: the EVERFRAME_API_TOKEN it saw, then its arguments. */
    fun recordedInvocations(): List<List<String>> {
        val record = File(root, "cli-record.txt")
        if (!record.exists()) return emptyList()
        return record.readLines()
            .fold(mutableListOf(mutableListOf<String>())) { groups, line ->
                if (line == "---") groups.add(mutableListOf()) else groups.last().add(line)
                groups
            }
            .filter { it.isNotEmpty() }
    }
    fun recordedMappingBytes(): ByteArray = File(root, "cli-mapping.bin").readBytes()
    fun recordedSymbolFiles(): List<String> = File(root, "cli-symbols.txt").readLines()
    fun recordedBudget(): String = File(root, "cli-budget.txt").readText().trim()
    /** npm_config_fetch_timeout|npm_config_fetch_retries|npm_config_fetch_retry_maxtimeout as the CLI saw them. */
    fun recordedNpmLimits(): String = File(root, "cli-npm.txt").readText().trim()
    /** The fake CLI's sleeping child, when it was asked to stall. */
    fun recordedSleeper(): Long = File(root, "cli-sleep.pid").readText().trim().toLong()
    /** The fake CLI's working directory, physical path. */
    fun recordedWorkingDirectory(): String = File(root, "cli-cwd.txt").readText().trim()
    fun apkAsset(variantDir: String, entry: String): String {
        val apk = File(root, "build/outputs/apk/$variantDir").walkTopDown().first { it.extension == "apk" }
        ZipFile(apk).use { zip -> return zip.getInputStream(zip.getEntry(entry)).bufferedReader().readText() }
    }

    private fun runner(environment: Map<String, String>) = GradleRunner.create()
        .withProjectDir(root)
        .withPluginClasspath()
        .withGradleVersion("8.10.2")
        .withEnvironment(System.getenv().filterKeys { it !in SCRUBBED } + environment)

    companion object {
        private val SCRUBBED = setOf(
            "CI", "EVERFRAME_API_TOKEN", "EVERFRAME_APP_ID", "EVERFRAME_CLI_JS",
            "EVERFRAME_SYMBOLS_STRICT", "EVERFRAME_UPLOAD_TIMEOUT_SECONDS",
            "npm_config_fetch_timeout", "npm_config_fetch_retries", "npm_config_fetch_retry_maxtimeout",
        )

        fun create(directory: File, options: Options = Options()): PluginFixture {
            File(directory, "settings.gradle.kts").writeText(
                """
                pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
                dependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }
                rootProject.name = "fixture"
                """.trimIndent() + if (options.relativeCliInSubproject) "\ninclude(\":app\")\n" else "\n",
            )
            // The Android application project; Gradle always runs from [directory].
            val app = if (options.relativeCliInSubproject) File(directory, "app").apply { mkdirs() } else directory
            val sdk = System.getenv("ANDROID_HOME") ?: "${System.getProperty("user.home")}/Library/Android/sdk"
            File(directory, "local.properties").writeText("sdk.dir=$sdk\n")
            val record = File(directory, "cli-record.txt").absolutePath
            val mapping = File(directory, "cli-mapping.bin").absolutePath
            val symbols = File(directory, "cli-symbols.txt").absolutePath
            val budget = File(directory, "cli-budget.txt").absolutePath
            val npm = File(directory, "cli-npm.txt").absolutePath
            val sleeper = File(directory, "cli-sleep.pid").absolutePath
            val cwd = File(directory, "cli-cwd.txt").absolutePath
            val d = "$"
            val recorder = File(app, "record cli.sh").apply {
                writeText(
                    """
                    #!/bin/sh
                    { printf '%s\n' "${d}EVERFRAME_API_TOKEN"; printf '%s\n' "${d}@"; printf '%s\n' '---'; } >> '$record'
                    pwd -P > '$cwd'
                    printf '%s\n' "${d}{EVERFRAME_UPLOAD_TIMEOUT_SECONDS:-}" > '$budget'
                    printf '%s|%s|%s\n' "${d}{npm_config_fetch_timeout:-}" "${d}{npm_config_fetch_retries:-}" "${d}{npm_config_fetch_retry_maxtimeout:-}" > '$npm'
                    previous=""
                    for arg in "${d}@"; do
                      if [ "${d}previous" = "--mapping" ]; then cp "${d}arg" '$mapping'; fi
                      if [ "${d}previous" = "--symbols-dir" ]; then find "${d}arg" -name '*.so' | sort > '$symbols'; fi
                      previous="${d}arg"
                    done
                    """.trimIndent() + "\n" +
                    options.cliOutput.joinToString("") { "printf '%s\\n' ${shellQuote(it)}\n" } +
                    (if (options.cliSleepSeconds > 0) "sleep ${options.cliSleepSeconds} & printf '%s\\n' \"${d}!\" > '$sleeper'; wait\n" else "") +
                    "exit ${options.cliExit}\n",
                )
                setExecutable(true)
            }
            val flavors = if (options.flavors) {
                "flavorDimensions += \"tier\"; productFlavors { create(\"free\") { dimension = \"tier\" }; create(\"paid\") { dimension = \"tier\" } }"
            } else ""
            val packaging = if (options.nativeLibrary) "packaging { jniLibs { keepDebugSymbols += \"**/*.so\" } }" else ""
            val abiFilters = if (options.abiFilters.isEmpty()) "" else
                "defaultConfig { ndk { abiFilters += listOf(${options.abiFilters.joinToString { quote(it) }}) } }"
            val splits = if (options.abiSplits.isEmpty()) "" else
                "splits { abi { isEnable = true; reset(); include(${options.abiSplits.joinToString { quote(it) }}); isUniversalApk = ${options.universalApk} } }"
            val cmake = if (options.cmakeFlags == null) "" else
                "externalNativeBuild { cmake { path = file(\"src/main/cpp/CMakeLists.txt\") } }"
            val cliCommand = if (options.relativeCliInSubproject) "./record cli.sh" else recorder.absolutePath
            File(app, "build.gradle.kts").writeText(
                """
                plugins {
                    id("com.android.application") version "8.7.2"
                    id("dev.everframe")
                }
                android {
                    namespace = "test.fixture"
                    compileSdk = 35
                    defaultConfig { applicationId = "test.fixture"; minSdk = 24; versionCode = 1; versionName = "1.0" }
                    buildTypes { release { isMinifyEnabled = ${options.minified}; proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "rules.pro") } }
                    $flavors
                    $packaging
                    $abiFilters
                    $splits
                    $cmake
                }
                everframe {
                    uploadEnabled.set(${options.uploadEnabled})
                    cliCommand.set(listOf(${quote(cliCommand)}))
                }
                """.trimIndent(),
            )
            File(app, "rules.pro").writeText("-keep class test.fixture.MainActivity { *; }\n")
            File(app, "src/main/java/test/fixture").mkdirs()
            File(app, "src/main/AndroidManifest.xml").writeText("<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\"><application /></manifest>")
            File(app, "src/main/java/test/fixture/MainActivity.java").writeText("package test.fixture; public final class MainActivity { public static String value() { return \"mapped\"; } }")
            if (options.nativeLibrary) for (abi in listOf("arm64-v8a", "x86_64"))
                File(app, "src/main/jniLibs/$abi").apply { mkdirs() }.resolve("libfixture.so").writeText("fixture")
            if (options.cmakeFlags != null) File(app, "src/main/cpp").apply { mkdirs() }.let { cpp ->
                cpp.resolve("CMakeLists.txt").writeText(
                    "cmake_minimum_required(VERSION 3.22.1)\nproject(native C)\n" +
                        "set(CMAKE_C_FLAGS \"${d}{CMAKE_C_FLAGS} ${options.cmakeFlags}\")\nadd_library(native SHARED native.c)\n",
                )
                cpp.resolve("native.c").writeText("int everframe_fixture(int value) { return value * 2; }\n")
            }
            return PluginFixture(directory)
        }

        private fun quote(value: String) = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
        private fun shellQuote(value: String) = "'" + value.replace("'", "'\\''") + "'"
    }
}
