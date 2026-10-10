// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.gradle

import org.gradle.api.DefaultTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import org.gradle.work.DisableCachingByDefault

/** Uploads the variant's final `mapping.txt` under the ID packaged in its APK/AAB. */
@DisableCachingByDefault(because = "Uploads must contact the service on every invocation")
public abstract class UploadR8MappingTask : DefaultTask() {
    @get:InputFile @get:PathSensitive(PathSensitivity.NONE) public abstract val mappingFile: RegularFileProperty
    @get:InputDirectory @get:PathSensitive(PathSensitivity.RELATIVE) public abstract val identityDirectory: DirectoryProperty
    @get:Input @get:Optional public abstract val appId: Property<String>
    @get:Input public abstract val cliCommand: ListProperty<String>

    init { outputs.upToDateWhen { false } }

    @TaskAction internal fun upload() {
        if (!requireUploadCredentials(System.getenv("EVERFRAME_API_TOKEN"), logger, "R8 mapping")) return
        val applicationId = requireAppId(appId.orNull, logger) ?: return
        val mapping = mappingFile.asFile.get()
        val mappingId = readR8MappingId(identityDirectory.get().asFile.resolve(BUILD_IDENTITY_ASSET))
        runCli(
            cliCommand.get() + listOf("r8", "upload", "--app-id", applicationId, "--mapping-id", mappingId, "--mapping", mapping.absolutePath),
            logger,
            "R8 mapping",
        )
    }
}
