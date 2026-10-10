// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.gradle

import java.io.File
import javax.inject.Inject
import org.gradle.api.DefaultTask
import org.gradle.api.Project
import org.gradle.api.file.ConfigurableFileCollection
import org.gradle.api.file.FileCollection
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFiles
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import org.gradle.api.tasks.TaskProvider
import org.gradle.process.ExecOperations
import org.gradle.work.DisableCachingByDefault

/**
 * Uploads the unstripped libraries of a variant: the CLI matches each shipped
 * `.so` to its unstripped copy by GNU build ID and ABI. Prebuilt libraries
 * without debug information (libc++_shared.so, prebuilt Hermes) only warn.
 */
@DisableCachingByDefault(because = "Uploads must contact the service on every invocation")
public abstract class UploadNativeSymbolsTask : DefaultTask() {
    /** AGP `merge<V>NativeLibs` output: unstripped libraries with debug info. */
    @get:InputFiles @get:PathSensitive(PathSensitivity.RELATIVE) public abstract val unstrippedLibraries: ConfigurableFileCollection
    /** AGP `strip<V>DebugSymbols` output: the libraries the APK/AAB ships. */
    @get:InputFiles @get:PathSensitive(PathSensitivity.RELATIVE) public abstract val strippedLibraries: ConfigurableFileCollection
    @get:Input @get:Optional public abstract val appId: Property<String>
    @get:Input public abstract val cliCommand: ListProperty<String>
    @get:Inject protected abstract val execOperations: ExecOperations

    init { outputs.upToDateWhen { false } }

    @TaskAction internal fun upload() {
        val symbols = libraryRoot(unstrippedLibraries)
        if (symbols == null) {
            logger.info("everframe: no native libraries in this variant")
            return
        }
        if (!requireUploadCredentials(System.getenv("EVERFRAME_API_TOKEN"), logger, "native symbols")) return
        val applicationId = requireAppId(appId.orNull, logger) ?: return
        val binaries = libraryRoot(strippedLibraries) ?: symbols
        runCli(
            execOperations,
            cliCommand.get() + listOf(
                "elf", "upload-build", "--app-id", applicationId,
                "--binaries-dir", binaries.absolutePath, "--symbols-dir", symbols.absolutePath,
            ),
            logger,
            "native symbols",
        )
    }
}

/** The `lib` folder holding one folder of `.so` files per ABI, or null when the variant packages no native code. */
internal fun libraryRoot(files: FileCollection): File? = files.files.asSequence()
    .flatMap { root -> root.walkTopDown().filter { it.isFile && it.name.endsWith(".so") } }
    .firstOrNull()?.parentFile?.parentFile

internal fun registerNativeSymbolsUpload(project: Project, variantName: String, extension: EverframeExtension): TaskProvider<UploadNativeSymbolsTask> {
    val name = variantName.replaceFirstChar(Char::uppercaseChar)
    return project.tasks.register("uploadEverframe${name}NativeSymbols", UploadNativeSymbolsTask::class.java) { task ->
        task.group = "Everframe"
        task.description = "Uploads unstripped $variantName native libraries to Everframe"
        task.unstrippedLibraries.from(project.tasks.matching { it.name == "merge${name}NativeLibs" })
        task.strippedLibraries.from(project.tasks.matching { it.name == "strip${name}DebugSymbols" })
        task.appId.set(extension.appId)
        task.cliCommand.set(extension.cliCommand)
    }
}
