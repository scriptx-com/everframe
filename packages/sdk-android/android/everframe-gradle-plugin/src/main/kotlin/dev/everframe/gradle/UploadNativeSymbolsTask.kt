// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.gradle

import com.android.build.api.dsl.ApplicationExtension
import com.android.build.api.variant.ApplicationVariant
import com.android.build.api.variant.FilterConfiguration
import com.android.build.api.variant.VariantOutputConfiguration
import java.io.File
import javax.inject.Inject
import org.gradle.api.DefaultTask
import org.gradle.api.Project
import org.gradle.api.file.ConfigurableFileCollection
import org.gradle.api.file.FileCollection
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.provider.SetProperty
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFiles
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import org.gradle.api.tasks.TaskProvider
import org.gradle.process.ExecOperations
import org.gradle.work.DisableCachingByDefault

/**
 * Uploads the unstripped libraries of a variant: the CLI matches each shipped
 * `.so` to its unstripped copy by GNU build ID and ABI. Only the ABIs the
 * variant packages count. Prebuilt libraries without debug information
 * (AndroidX, libc++_shared.so, prebuilt Hermes) are listed at --info only; the
 * variant's own libraries without symbols get one warning with their count.
 */
@DisableCachingByDefault(because = "Uploads must contact the service on every invocation")
public abstract class UploadNativeSymbolsTask : DefaultTask() {
    /** AGP `merge<V>NativeLibs` output: unstripped libraries with debug info. */
    @get:InputFiles @get:PathSensitive(PathSensitivity.RELATIVE) public abstract val unstrippedLibraries: ConfigurableFileCollection
    /** AGP `strip<V>DebugSymbols` output: the libraries the APK/AAB ships. */
    @get:InputFiles @get:PathSensitive(PathSensitivity.RELATIVE) public abstract val strippedLibraries: ConfigurableFileCollection
    @get:Input @get:Optional public abstract val appId: Property<String>
    @get:Input public abstract val cliCommand: ListProperty<String>
    /** ABIs the APK or bundle packages; empty means every ABI AGP merged. */
    @get:Input public abstract val packagedAbis: SetProperty<String>
    @get:Internal public abstract val variantName: Property<String>
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
        var withoutSymbols = 0
        runCli(
            execOperations,
            cliCommand.get() + listOf(
                "elf", "upload-build", "--app-id", applicationId,
                "--binaries-dir", binaries.absolutePath, "--symbols-dir", symbols.absolutePath, "--summary",
            ) + packagedAbis.get().sorted().flatMap { listOf("--abi", it) },
            logger,
            "native symbols",
        ) { line ->
            if (line.startsWith("detail: ") && !line.startsWith("detail: prebuilt ")) withoutSymbols++
            logCliLine(logger, line)
        }
        if (withoutSymbols > 0) {
            val libraries = if (withoutSymbols == 1) "library has" else "libraries have"
            logger.warn(
                "warning: everframe: $withoutSymbols native $libraries no symbols in ${variantName.get()}, so their " +
                    "frames stay raw. Run with --info to list them.",
            )
        }
    }
}

/**
 * The ABIs a variant ships: `ndk.abiFilters` from the default config, its
 * flavors and its build type, narrowed by ABI splits when no universal APK is
 * built. Empty means AGP packages every merged ABI.
 */
internal fun packagedAbis(project: Project, variant: ApplicationVariant): Set<String> {
    val android = project.extensions.findByType(ApplicationExtension::class.java)
    val filters = mutableSetOf<String>()
    if (android != null) {
        filters += android.defaultConfig.ndk.abiFilters
        for ((_, flavor) in variant.productFlavors) android.productFlavors.findByName(flavor)?.let { filters += it.ndk.abiFilters }
        variant.buildType?.let { name -> android.buildTypes.findByName(name)?.let { filters += it.ndk.abiFilters } }
    }
    val splits = variant.outputs
        .flatMap { output -> output.filters.filter { it.filterType == FilterConfiguration.FilterType.ABI }.map { it.identifier } }
        .toSet()
    val universal = variant.outputs.any { it.outputType == VariantOutputConfiguration.OutputType.UNIVERSAL }
    val split = splits.takeIf { it.isNotEmpty() && !universal }
    return when {
        filters.isEmpty() -> split ?: emptySet()
        split == null -> filters
        else -> filters intersect split
    }
}

/** The `lib` folder holding one folder of `.so` files per ABI, or null when the variant packages no native code. */
internal fun libraryRoot(files: FileCollection): File? = files.files.asSequence()
    .flatMap { root -> root.walkTopDown().filter { it.isFile && it.name.endsWith(".so") } }
    .firstOrNull()?.parentFile?.parentFile

internal fun registerNativeSymbolsUpload(project: Project, variant: ApplicationVariant, extension: EverframeExtension): TaskProvider<UploadNativeSymbolsTask> {
    val variantName = variant.name
    val name = variantName.replaceFirstChar(Char::uppercaseChar)
    val abis = packagedAbis(project, variant)
    return project.tasks.register("uploadEverframe${name}NativeSymbols", UploadNativeSymbolsTask::class.java) { task ->
        task.group = "Everframe"
        task.description = "Uploads unstripped $variantName native libraries to Everframe"
        task.unstrippedLibraries.from(project.tasks.matching { it.name == "merge${name}NativeLibs" })
        task.strippedLibraries.from(project.tasks.matching { it.name == "strip${name}DebugSymbols" })
        task.appId.set(extension.appId)
        task.cliCommand.set(extension.cliCommand)
        task.packagedAbis.set(abis)
        task.variantName.set(variantName)
    }
}
