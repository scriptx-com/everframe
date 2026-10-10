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
        )

        fun create(directory: File, options: Options = Options()): PluginFixture {
            File(directory, "settings.gradle.kts").writeText(
                """
                pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
                dependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }
                rootProject.name = "fixture"
                """.trimIndent(),
            )
            val sdk = System.getenv("ANDROID_HOME") ?: "${System.getProperty("user.home")}/Library/Android/sdk"
            File(directory, "local.properties").writeText("sdk.dir=$sdk\n")
            val record = File(directory, "cli-record.txt").absolutePath
            val mapping = File(directory, "cli-mapping.bin").absolutePath
            val symbols = File(directory, "cli-symbols.txt").absolutePath
            val budget = File(directory, "cli-budget.txt").absolutePath
            val d = "$"
            val recorder = File(directory, "record cli.sh").apply {
                writeText(
                    """
                    #!/bin/sh
                    { printf '%s\n' "${d}EVERFRAME_API_TOKEN"; printf '%s\n' "${d}@"; printf '%s\n' '---'; } >> '$record'
                    printf '%s\n' "${d}{EVERFRAME_UPLOAD_TIMEOUT_SECONDS:-}" > '$budget'
                    previous=""
                    for arg in "${d}@"; do
                      if [ "${d}previous" = "--mapping" ]; then cp "${d}arg" '$mapping'; fi
                      if [ "${d}previous" = "--symbols-dir" ]; then find "${d}arg" -name '*.so' | sort > '$symbols'; fi
                      previous="${d}arg"
                    done
                    """.trimIndent() + "\n" +
                    options.cliOutput.joinToString("") { "printf '%s\\n' ${shellQuote(it)}\n" } +
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
            File(directory, "build.gradle.kts").writeText(
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
                }
                everframe {
                    uploadEnabled.set(${options.uploadEnabled})
                    cliCommand.set(listOf(${quote(recorder.absolutePath)}))
                }
                """.trimIndent(),
            )
            File(directory, "rules.pro").writeText("-keep class test.fixture.MainActivity { *; }\n")
            File(directory, "src/main/java/test/fixture").mkdirs()
            File(directory, "src/main/AndroidManifest.xml").writeText("<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\"><application /></manifest>")
            File(directory, "src/main/java/test/fixture/MainActivity.java").writeText("package test.fixture; public final class MainActivity { public static String value() { return \"mapped\"; } }")
            if (options.nativeLibrary) for (abi in listOf("arm64-v8a", "x86_64"))
                File(directory, "src/main/jniLibs/$abi").apply { mkdirs() }.resolve("libfixture.so").writeText("fixture")
            return PluginFixture(directory)
        }

        private fun quote(value: String) = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
        private fun shellQuote(value: String) = "'" + value.replace("'", "'\\''") + "'"
    }
}
