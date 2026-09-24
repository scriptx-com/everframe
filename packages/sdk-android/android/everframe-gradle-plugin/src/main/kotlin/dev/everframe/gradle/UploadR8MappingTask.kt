// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.gradle

import org.gradle.api.DefaultTask
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import org.gradle.process.ExecOperations
import org.gradle.work.DisableCachingByDefault
import java.util.UUID
import javax.inject.Inject

@DisableCachingByDefault(because = "Uploads must contact the service on every invocation")
public abstract class UploadR8MappingTask : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    public abstract val mappingFile: RegularFileProperty

    @get:Input public abstract val mappingId: Property<String>
    @get:Input public abstract val appId: Property<String>
    @get:Input public abstract val cliExecutable: Property<String>
    @get:Input public abstract val cliArgs: ListProperty<String>

    @get:Inject protected abstract val execOperations: ExecOperations

    init {
        outputs.upToDateWhen { false }
    }

    @TaskAction
    internal fun upload() {
        require(!System.getenv("EVERFRAME_API_TOKEN").isNullOrEmpty()) {
            "EVERFRAME_API_TOKEN is required to upload an R8 mapping"
        }
        val applicationId = appId.orNull ?: error("everframeR8.appId is required to upload an R8 mapping")
        require(runCatching { UUID.fromString(applicationId) }.isSuccess) {
            "everframeR8.appId must be a UUID"
        }
        val mapping = mappingFile.asFile.get()
        require(mapping.isFile && mapping.length() > 0) { "R8 mapping must be a non-empty regular file: $mapping" }

        execOperations.exec { spec ->
            spec.executable(cliExecutable.get())
            spec.args(cliArgs.get() + listOf(
                "r8", "upload",
                "--app-id", applicationId,
                "--mapping-id", mappingId.get(),
                "--mapping", mapping.absolutePath,
            ))
        }.assertNormalExitValue()
    }
}
