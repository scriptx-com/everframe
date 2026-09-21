// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// :traceitx-gradle-plugin — optional Gradle plugin (Plan 05-08).
//
// Purpose:
//   1. Inject `traceitx-keep.pro` (a copy of `:traceitx-core/consumer-rules.pro`)
//      into the host module's R8 keep set. The same rules already auto-merge from
//      the AAR's `consumer-rules.pro` (Plan 05-01) — this is a value-add for hosts
//      that want explicit control or want to verify the rules are present.
//   2. Turn on Compose Compiler's keep-all-composables flag so composable function
//      names (which TraceItX walks reflectively to derive `componentPath`) survive
//      R8 minification even when the host's own keep rules don't preserve them.
//
// The plugin is OPTIONAL. `:traceitx-core`'s consumer-rules.pro already auto-merges
// via the AAR; the plugin is a customer-opt-in convenience for stricter R8 setups.
//
// Customer usage in their `build.gradle.kts`:
//
//   plugins { id("com.traceitx") version "1.2.0" }
//
// or, for project-local development:
//
//   plugins { id("com.traceitx") }   // resolved via includeBuild("../android")

package com.traceitx.gradle

import org.gradle.api.Plugin
import org.gradle.api.Project
import java.io.File

public class TraceItXPlugin : Plugin<Project> {

    override fun apply(target: Project) {
        val r8 = target.extensions.create("traceitxR8", TraceItXR8Extension::class.java).apply {
            enabled.convention(false)
            buildTypes.convention(setOf("release"))
            buildId.convention(target.providers.environmentVariable("TRACEITX_R8_BUILD_ID"))
            appId.convention(target.providers.environmentVariable("TRACEITX_APP_ID"))
            cliExecutable.convention("traceitx")
            cliArgs.convention(emptyList())
        }
        target.pluginManager.withPlugin("com.android.application") {
            wireR8Variants(target, r8)
        }
        target.afterEvaluate {
            // 1. Extract the bundled keep file to the project's build directory so
            //    the Android plugin can hand it to R8 as a real on-disk path.
            val keepFile = extractKeepFile(target)

            // 2. Wire it into Library and Application R8 configs.
            wireKeepRulesIntoLibrary(target, keepFile)
            wireKeepRulesIntoApp(target, keepFile)

            // 3. Compose Compiler — keep all composables so componentPath reflection
            //    survives R8. This is a no-op on modules that don't apply the
            //    Compose plugin.
            wireComposeCompilerArgs(target)
        }
    }

    /**
     * Copies `/traceitx-keep.pro` (bundled in the plugin JAR resources) to
     * `<projectBuildDir>/traceitx-gradle-plugin/traceitx-keep.pro`. Idempotent —
     * re-extracts on each apply so a refreshed plugin version is honored.
     */
    private fun extractKeepFile(project: Project): File {
        val out = File(project.layout.buildDirectory.asFile.get(), "traceitx-gradle-plugin/traceitx-keep.pro")
        out.parentFile.mkdirs()
        val resource = javaClass.classLoader.getResourceAsStream("traceitx-keep.pro")
            ?: error("traceitx-gradle-plugin: bundled traceitx-keep.pro missing from plugin JAR resources.")
        resource.use { input ->
            out.outputStream().use { output -> input.copyTo(output) }
        }
        return out
    }

    /**
     * Adds the keep file to the Android library's `consumerProguardFiles` so any
     * downstream app that depends on this library inherits the rules.
     */
    private fun wireKeepRulesIntoLibrary(project: Project, keepFile: File) {
        val libraryExtClass = try {
            Class.forName("com.android.build.gradle.LibraryExtension")
        } catch (_: ClassNotFoundException) {
            return
        }
        val libraryExt = project.extensions.findByType(libraryExtClass) ?: return
        val defaultConfig = libraryExtClass.getMethod("getDefaultConfig").invoke(libraryExt)
        val cmd = defaultConfig.javaClass.methods.firstOrNull {
            it.name == "consumerProguardFiles" && it.parameterTypes.size == 1
        } ?: return
        cmd.invoke(defaultConfig, arrayOf<Any>(keepFile))
    }

    /**
     * Adds the keep file to the Android application's `release` build type so
     * R8 / ProGuard preserves TraceItX symbols in the customer's release APK.
     */
    private fun wireKeepRulesIntoApp(project: Project, keepFile: File) {
        val appExtClass = try {
            Class.forName("com.android.build.gradle.AppExtension")
        } catch (_: ClassNotFoundException) {
            return
        }
        val appExt = project.extensions.findByType(appExtClass) ?: return
        @Suppress("UNCHECKED_CAST")
        val buildTypes = appExtClass.getMethod("getBuildTypes").invoke(appExt) as? Iterable<Any> ?: return
        val release = buildTypes.firstOrNull {
            (it.javaClass.getMethod("getName").invoke(it) as? String) == "release"
        } ?: return
        val pgm = release.javaClass.methods.firstOrNull {
            it.name == "proguardFiles" && it.parameterTypes.size == 1
        } ?: return
        pgm.invoke(release, arrayOf<Any>(keepFile))
    }

    /**
     * Adds `-Xandroidx-compose-runtime-keep-all-composables` to the Kotlin compile
     * task so composable function names survive R8. Only applied when the Compose
     * plugin is also applied (otherwise the flag is a no-op anyway). Uses
     * reflection to avoid a hard dependency on the Kotlin Gradle plugin classes —
     * keeps `:traceitx-gradle-plugin`'s runtime classpath minimal.
     */
    private fun wireComposeCompilerArgs(project: Project) {
        if (!project.plugins.hasPlugin("org.jetbrains.kotlin.plugin.compose")) return
        project.tasks.matching { it.javaClass.simpleName.contains("KotlinCompile") }.configureEach {
            try {
                val compilerOptionsAccessor = this.javaClass.methods.firstOrNull { it.name == "getCompilerOptions" }
                val compilerOptions = compilerOptionsAccessor?.invoke(this)
                val freeArgsAccessor = compilerOptions?.javaClass?.methods?.firstOrNull { it.name == "getFreeCompilerArgs" }
                val listProperty = freeArgsAccessor?.invoke(compilerOptions)
                val addMethod = listProperty?.javaClass?.methods?.firstOrNull {
                    it.name == "add" && it.parameterTypes.size == 1
                }
                addMethod?.invoke(listProperty, "-Xandroidx-compose-runtime-keep-all-composables")
            } catch (_: Throwable) {
                // Kotlin Gradle plugin shape changed; skip — consumer-rules.pro from the AAR
                // already provides composable-name keep via @Composable annotation rules.
            }
        }
    }
}
