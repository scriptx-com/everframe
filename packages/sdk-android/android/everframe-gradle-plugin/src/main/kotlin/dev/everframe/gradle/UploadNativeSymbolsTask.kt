// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.gradle

import com.android.build.api.dsl.ApplicationExtension
import com.android.build.api.variant.ApplicationVariant
import com.android.build.api.variant.FilterConfiguration
import com.android.build.api.variant.VariantOutputConfiguration
import com.android.build.gradle.tasks.ExternalNativeBuildTask
import java.io.File
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
import org.gradle.work.DisableCachingByDefault

/**
 * Uploads the unstripped libraries of a variant: the CLI matches each shipped
 * `.so` to its unstripped copy by GNU build ID and ABI. Only the ABIs the
 * variant packages count. Prebuilt libraries without debug information
 * (AndroidX, libc++_shared.so, prebuilt Hermes) are listed at --info only.
 * Libraries this project's own CMake or ndk-build produced without debug
 * information get one warning that names them and the fix; other libraries
 * without symbols get one warning with their count.
 */
@DisableCachingByDefault(because = "Uploads must contact the service on every invocation")
public abstract class UploadNativeSymbolsTask : DefaultTask() {
    /** AGP `merge<V>NativeLibs` output: unstripped libraries with debug info. */
    @get:InputFiles @get:PathSensitive(PathSensitivity.RELATIVE) public abstract val unstrippedLibraries: ConfigurableFileCollection
    /** AGP `strip<V>DebugSymbols` output: the libraries the APK/AAB ships. */
    @get:InputFiles @get:PathSensitive(PathSensitivity.RELATIVE) public abstract val strippedLibraries: ConfigurableFileCollection
    @get:Input @get:Optional public abstract val appId: Property<String>
    @get:Input public abstract val cliCommand: ListProperty<String>
    /** Output folders of the project's own native build (ExternalNativeBuildTask): its libraries are not prebuilt. */
    @get:InputFiles @get:PathSensitive(PathSensitivity.RELATIVE) public abstract val projectNativeLibraries: ConfigurableFileCollection
    /** ABIs the APK or bundle packages; empty means every ABI AGP merged. */
    @get:Input public abstract val packagedAbis: SetProperty<String>
    @get:Internal public abstract val variantName: Property<String>

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
        val withoutDebugInfo = sortedSetOf<String>()
        runCli(
            cliCommand.get() + listOf(
                "elf", "upload-build", "--app-id", applicationId,
                "--binaries-dir", binaries.absolutePath, "--symbols-dir", symbols.absolutePath, "--summary",
            ) + projectNativeLibraries.files.filter(File::isDirectory).sorted().flatMap { listOf("--project-native-dir", it.absolutePath) } +
                packagedAbis.get().sorted().flatMap { listOf("--abi", it) },
            logger,
            "native symbols",
        ) { line ->
            when {
                line.startsWith(OWN_WITHOUT_DEBUG_INFO) ->
                    withoutDebugInfo += File(line.removePrefix(OWN_WITHOUT_DEBUG_INFO).substringBefore(": ")).name
                line.startsWith("detail: ") && !line.startsWith("detail: prebuilt ") -> withoutSymbols++
            }
            logCliLine(logger, line)
        }
        if (withoutDebugInfo.isNotEmpty()) {
            val one = withoutDebugInfo.size == 1
            val them = if (one) "it" else "them"
            logger.warn(
                "warning: everframe: ${withoutDebugInfo.size} native ${if (one) "library" else "libraries"} this project builds " +
                    "${if (one) "has" else "have"} no debug information in ${variantName.get()}, so ${if (one) "its" else "their"} " +
                    "frames stay raw: ${withoutDebugInfo.joinToString(", ")}. Build $them with debug information (CMake: " +
                    "RelWithDebInfo, or -g in CMAKE_C_FLAGS and CMAKE_CXX_FLAGS; ndk-build: -g in LOCAL_CFLAGS) and do not " +
                    "strip $them before packaging (no -s or -Wl,--strip-all): the Android Gradle plugin strips the copy the app ships.",
            )
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
 * The ABIs a variant's APKs and its bundle ship. Empty means every ABI AGP
 * merged. A bundle ignores ABI splits: Play splits it per device itself.
 */
internal data class VariantAbis(val apk: Set<String>, val bundle: Set<String>) {
    /** What this build packages: `bundle<V>` the bundle's ABIs, both tasks together the union. */
    fun packaged(assemble: Boolean, bundle: Boolean): Set<String> = when {
        !bundle -> apk
        !assemble -> this.bundle
        apk.isEmpty() || this.bundle.isEmpty() -> emptySet()
        else -> apk + this.bundle
    }
}

/**
 * `ndk.abiFilters` from the default config, its flavors and its build type for
 * the bundle; the APKs narrow them by ABI splits when no universal APK is built.
 */
internal fun variantAbis(project: Project, variant: ApplicationVariant): VariantAbis {
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
    val apk = when {
        filters.isEmpty() -> split ?: emptySet()
        split == null -> filters
        else -> filters intersect split
    }
    return VariantAbis(apk, filters)
}

private const val OWN_WITHOUT_DEBUG_INFO = "detail: no_debug_info "

/**
 * The variant's own CMake and ndk-build output folders. None when AGP's task type is
 * missing from this AGP version: every library without debug information then stays quiet.
 */
internal fun projectNativeOutputs(project: Project, variantName: String): List<Any> = try {
    project.tasks.withType(ExternalNativeBuildTask::class.java).filter { it.variantName == variantName }.map { it.soFolder }
} catch (_: LinkageError) {
    emptyList()
}

/** The `lib` folder holding one folder of `.so` files per ABI, or null when the variant packages no native code. */
internal fun libraryRoot(files: FileCollection): File? = files.files.asSequence()
    .flatMap { root -> root.walkTopDown().filter { it.isFile && it.name.endsWith(".so") } }
    .firstOrNull()?.parentFile?.parentFile

internal fun registerNativeSymbolsUpload(project: Project, variant: ApplicationVariant, extension: EverframeExtension): TaskProvider<UploadNativeSymbolsTask> {
    val variantName = variant.name
    val name = variantName.replaceFirstChar(Char::uppercaseChar)
    val abis = variantAbis(project, variant)
    val upload = project.tasks.register("uploadEverframe${name}NativeSymbols", UploadNativeSymbolsTask::class.java) { task ->
        task.group = "Everframe"
        task.description = "Uploads unstripped $variantName native libraries to Everframe"
        task.unstrippedLibraries.from(project.tasks.matching { it.name == "merge${name}NativeLibs" })
        task.strippedLibraries.from(project.tasks.matching { it.name == "strip${name}DebugSymbols" })
        task.projectNativeLibraries.from(projectNativeOutputs(project, variantName))
        task.appId.set(extension.appId)
        task.cliCommand.set(extension.cliCommand)
        task.packagedAbis.set(abis.apk)
        task.variantName.set(variantName)
    }
    // One upload finalizes both `assemble<V>` and `bundle<V>`; which of them runs is known once
    // the task graph is. The choice is made before execution, so the configuration cache keeps it.
    fun path(task: String) = if (project.path == ":") ":$task" else "${project.path}:$task"
    project.gradle.taskGraph.whenReady { graph ->
        if (!graph.hasTask(path(upload.name))) return@whenReady
        val packaged = abis.packaged(assemble = graph.hasTask(path("assemble$name")), bundle = graph.hasTask(path("bundle$name")))
        upload.configure { it.packagedAbis.set(packaged) }
    }
    return upload
}
