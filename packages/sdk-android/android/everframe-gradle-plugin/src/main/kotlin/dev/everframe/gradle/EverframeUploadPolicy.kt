// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.gradle

import java.io.ByteArrayOutputStream
import java.util.UUID
import org.gradle.api.GradleException
import org.gradle.api.logging.Logger
import org.gradle.process.ExecOperations

/**
 * Symbols never fail a customer's build by default: a missing token, a missing
 * app ID, a missing CLI or a failed upload is a `warning:` line and the build
 * continues, in CI and locally. EVERFRAME_SYMBOLS_STRICT=1 turns them into failures.
 */
internal fun symbolsStrict(): Boolean = System.getenv("EVERFRAME_SYMBOLS_STRICT").let { it == "1" || it == "true" }

/** Default time budget, in seconds, the CLI gets for one upload. */
internal const val DEFAULT_UPLOAD_TIMEOUT_SECONDS: String = "600"

private fun problem(logger: Logger, message: String): Nothing? {
    if (symbolsStrict()) throw GradleException("everframe: $message")
    logger.warn("warning: everframe: $message. Crashes from this build will show raw frames until it is uploaded. Set EVERFRAME_SYMBOLS_STRICT=1 to fail the build instead.")
    return null
}

/** True when the upload should run. */
internal fun requireUploadCredentials(token: String?, logger: Logger, what: String): Boolean {
    if (!token.isNullOrEmpty()) return true
    if (symbolsStrict()) throw GradleException("everframe: EVERFRAME_API_TOKEN is required to upload the $what (artifacts:write scope)")
    logger.warn("warning: everframe: no EVERFRAME_API_TOKEN, skipping $what upload. Crashes from this build will show raw frames. Set EVERFRAME_API_TOKEN to a token with the artifacts:write scope, or EVERFRAME_SYMBOLS_STRICT=1 to fail the build instead.")
    return false
}

/** The application UUID, or null (after a warning) when it is missing or malformed. */
internal fun requireAppId(value: String?, logger: Logger): String? {
    if (value.isNullOrEmpty()) return problem(logger, "set everframe.appId or EVERFRAME_APP_ID to upload symbols")
    if (runCatching { UUID.fromString(value) }.isFailure) return problem(logger, "everframe.appId must be an application UUID")
    return value
}

/** `warning:` lines stay warnings, `detail:` lines go to --info, anything else is lifecycle output. */
internal fun logCliLine(logger: Logger, line: String) {
    when {
        line.startsWith("warning:") -> logger.warn(line)
        line.startsWith("detail: ") -> logger.info("everframe: ${line.removePrefix("detail: ")}")
        else -> logger.lifecycle(line)
    }
}

/**
 * Runs the CLI with the inherited token and a time budget; a failure follows
 * the strict policy. Its output is captured and handed to [output] line by line,
 * so callers can summarize instead of echoing one warning per file.
 */
internal fun runCli(
    execOperations: ExecOperations,
    command: List<String>,
    logger: Logger,
    what: String,
    output: (String) -> Unit = { logCliLine(logger, it) },
) {
    val stdout = ByteArrayOutputStream()
    val stderr = ByteArrayOutputStream()
    val result = try {
        execOperations.exec { spec ->
            spec.commandLine(command)
            spec.isIgnoreExitValue = true
            spec.standardOutput = stdout
            spec.errorOutput = stderr
            spec.environment("EVERFRAME_UPLOAD_TIMEOUT_SECONDS", System.getenv("EVERFRAME_UPLOAD_TIMEOUT_SECONDS") ?: DEFAULT_UPLOAD_TIMEOUT_SECONDS)
        }
    } catch (error: Exception) {
        problem(logger, "could not run the Everframe CLI for the $what upload (${error.message?.substringBefore('\n')})")
        return
    }
    (stdout.toString(Charsets.UTF_8).lines() + stderr.toString(Charsets.UTF_8).lines())
        .filter { it.isNotBlank() }
        .forEach(output)
    if (result.exitValue != 0) problem(logger, "$what upload failed (exit ${result.exitValue})")
}
