// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.gradle

import com.android.build.api.artifact.SingleArtifact
import com.android.build.api.variant.ApplicationAndroidComponentsExtension
import org.gradle.api.Project
import org.gradle.api.Task
import org.gradle.api.tasks.TaskProvider

/** Finalizes `assemble<V>` and `bundle<V>` of each selected variant with its symbol uploads. */
internal fun wireVariants(project: Project, extension: EverframeExtension) {
    val components = project.extensions.getByType(ApplicationAndroidComponentsExtension::class.java)
    components.onVariants(components.selector().all()) { variant ->
        if (!extension.uploadEnabled.get() || variant.buildType !in extension.buildTypes.get()) return@onVariants
        val name = variant.name.replaceFirstChar(Char::uppercaseChar)
        val uploads = mutableListOf<TaskProvider<out Task>>()
        if (variant.isMinifyEnabled) {
            val mapping = variant.artifacts.get(SingleArtifact.OBFUSCATION_MAPPING_FILE)
            val identity = project.tasks.register("generateEverframe${name}BuildIdentity", GenerateBuildIdentityTask::class.java) {
                it.mappingFile.set(mapping)
            }
            variant.sources.assets?.addGeneratedSourceDirectory(identity, GenerateBuildIdentityTask::outputDirectory)
            uploads += project.tasks.register("uploadEverframe${name}R8Mapping", UploadR8MappingTask::class.java) { task ->
                task.group = "Everframe"
                task.description = "Uploads the final ${variant.name} R8 mapping to Everframe"
                task.mappingFile.set(mapping)
                task.identityDirectory.set(identity.flatMap { it.outputDirectory })
                task.appId.set(extension.appId)
                task.cliCommand.set(extension.cliCommand)
            }
        }
        uploads += registerNativeSymbolsUpload(project, variant, extension)
        project.tasks.matching { it.name == "assemble$name" || it.name == "bundle$name" }.configureEach { it.finalizedBy(uploads) }
    }
}
