// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.gradle

import org.gradle.api.DefaultTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.tasks.CacheableTask
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction

/** Writes the asset the Android SDK reads at start: `everframe/build-identity.properties`. */
@CacheableTask
public abstract class GenerateBuildIdentityTask : DefaultTask() {
    @get:InputFile @get:PathSensitive(PathSensitivity.NONE) public abstract val mappingFile: RegularFileProperty
    @get:OutputDirectory public abstract val outputDirectory: DirectoryProperty

    @TaskAction internal fun generate() {
        val out = outputDirectory.get().asFile.resolve(BUILD_IDENTITY_ASSET)
        out.parentFile.mkdirs()
        out.writeText("$R8_MAPPING_ID_KEY=${r8MappingId(mappingFile.get().asFile)}\n")
    }
}
