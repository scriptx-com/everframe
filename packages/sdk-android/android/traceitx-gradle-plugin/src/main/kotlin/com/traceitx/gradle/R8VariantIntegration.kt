// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.gradle

import com.android.build.api.artifact.SingleArtifact
import com.android.build.api.variant.ApplicationAndroidComponentsExtension
import com.android.build.api.variant.BuildConfigField
import org.gradle.api.Project

internal fun wireR8Variants(project: Project, extension: TraceItXR8Extension) {
    val components = project.extensions.getByType(ApplicationAndroidComponentsExtension::class.java)

    components.finalizeDsl { android ->
        if (extension.enabled.get()) android.buildFeatures.buildConfig = true
    }
    components.onVariants(components.selector().all()) { variant ->
        if (!extension.enabled.get()) return@onVariants
        val projectPath = project.path
        val variantName = variant.name
        val selected = variant.buildType in extension.buildTypes.get()
        val field = if (selected) {
            require(variant.isMinifyEnabled) {
                "TraceItX R8 variant ${variant.name} is selected but minification is disabled"
            }
            extension.buildId.map { buildId ->
                BuildConfigField("String", "\"${identity(buildId, projectPath, variantName)}\"", "Exact TraceItX R8 mapping identity")
            }
        } else {
            project.providers.provider {
                BuildConfigField("String", "\"\"", "TraceItX R8 mapping identity is disabled for this variant")
            }
        }
        variant.buildConfigFields.put("TRACEITX_R8_MAPPING_ID", field)

        if (selected) {
            project.tasks.register(
                "uploadTraceItXR8${variant.name.replaceFirstChar(Char::uppercaseChar)}Mapping",
                UploadR8MappingTask::class.java,
            ) { task ->
                task.group = "TraceItX"
                task.description = "Uploads the final ${variant.name} R8 mapping to TraceItX"
                task.mappingFile.set(variant.artifacts.get(SingleArtifact.OBFUSCATION_MAPPING_FILE))
                task.mappingId.set(extension.buildId.map { identity(it, projectPath, variantName) })
                task.appId.set(extension.appId)
                task.cliExecutable.set(extension.cliExecutable)
                task.cliArgs.set(extension.cliArgs)
            }
        }
    }
}
