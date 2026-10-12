// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.gradle

import com.android.build.api.variant.ApplicationVariant
import java.io.File
import org.gradle.api.DefaultTask
import org.gradle.api.Project
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.TaskAction
import org.gradle.api.tasks.TaskProvider
import org.gradle.work.DisableCachingByDefault

/** The plugin id of React Native's Gradle plugin, which bundles JavaScript into the APK. */
internal const val REACT_NATIVE_PLUGIN_ID: String = "com.facebook.react"

/**
 * Uploads the Hermes bytecode bundle of a React Native variant with its composed source map.
 * It runs the CLI steps the generated Gradle block used to run: `build collect` (matches the
 * bundle to the build `@everframe/metro` staged), `build verify --release`, then
 * `sourcemaps upload-hermes`. A missing token or a failed step warns and the build
 * continues, unless EVERFRAME_SYMBOLS_STRICT=1.
 */
@DisableCachingByDefault(because = "Uploads must contact the service on every invocation")
public abstract class UploadHermesSourceMapTask : DefaultTask() {
    /** `index.android.bundle` as React Native's `createBundle<V>JsAndAssets` wrote it. */
    @get:Internal public abstract val bundleFile: RegularFileProperty
    /** The composed (Metro plus Hermes) source map of [bundleFile]. */
    @get:Internal public abstract val sourceMapFile: RegularFileProperty
    /** The `.everframe` folder `@everframe/metro` staged the build in. */
    @get:Internal public abstract val stagingDirectory: DirectoryProperty
    @get:Input @get:Optional public abstract val appId: Property<String>
    @get:Input public abstract val cliCommand: ListProperty<String>
    /** Where the CLI runs: the owning project's directory, against which a relative command resolves. */
    @get:Internal public abstract val workingDirectory: DirectoryProperty

    init {
        outputs.upToDateWhen { false }
        workingDirectory.convention(project.layout.projectDirectory)
    }

    @TaskAction internal fun upload() {
        if (!requireUploadCredentials(System.getenv("EVERFRAME_API_TOKEN"), logger, HERMES)) return
        val applicationId = requireAppId(appId.orNull, logger) ?: return
        val staging = stagingDirectory.get().asFile.absolutePath
        val steps = listOf(
            listOf(
                "build", "collect", "--staging", staging, "--platform", "android",
                "--bundle", bundleFile.get().asFile.absolutePath, "--source-map", sourceMapFile.get().asFile.absolutePath,
            ),
            listOf("build", "verify", "--staging", staging, "--platform", "android", "--release"),
            listOf("sourcemaps", "upload-hermes", "--manifest", staging, "--platform", "android", "--app-id", applicationId),
        )
        // A failed step already warned (or failed the build when strict); the next one would only fail too.
        for (step in steps) if (!runCli(cliCommand.get() + step, workingDirectory.get().asFile, logger, HERMES)) return
    }

    private companion object {
        const val HERMES = "Hermes source map"
    }
}

/**
 * Runs the Hermes upload after React Native's `createBundle<V>JsAndAssets`, the task that writes
 * the final bytecode and composed map. Called only for projects that apply React Native's plugin.
 */
internal fun registerHermesUpload(project: Project, variant: ApplicationVariant, extension: EverframeExtension): TaskProvider<UploadHermesSourceMapTask> {
    val variantName = variant.name
    val name = variantName.replaceFirstChar(Char::uppercaseChar)
    val upload = project.tasks.register("uploadEverframe${name}HermesSourceMap", UploadHermesSourceMapTask::class.java) { task ->
        task.group = "Everframe"
        task.description = "Uploads the $variantName Hermes bundle and source map to Everframe"
        // React Native's paths for a variant: generated/{assets,sourcemaps}/react/<variant name>.
        task.bundleFile.set(project.layout.buildDirectory.file("generated/assets/react/$variantName/index.android.bundle"))
        task.sourceMapFile.set(project.layout.buildDirectory.file("generated/sourcemaps/react/$variantName/index.android.bundle.map"))
        task.stagingDirectory.set(extension.hermesStagingDir)
        task.appId.set(extension.appId)
        task.cliCommand.set(extension.cliCommand)
    }
    project.tasks.matching { it.name == "createBundle${name}JsAndAssets" }.configureEach { it.finalizedBy(upload) }
    return upload
}

/** `.everframe` beside the Gradle root folder (`android`), where `@everframe/metro` stages by default. */
internal fun defaultHermesStagingDir(project: Project): File = File(project.rootDir.absoluteFile.parentFile, ".everframe")
