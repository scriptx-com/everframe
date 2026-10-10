// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.gradle

import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit
import org.gradle.api.GradleException
import org.gradle.api.logging.Logger

/**
 * Symbols never fail a customer's build by default: a missing token, a missing
 * app ID, a missing CLI or a failed upload is a `warning:` line and the build
 * continues, in CI and locally. EVERFRAME_SYMBOLS_STRICT=1 turns them into failures.
 */
internal fun symbolsStrict(): Boolean = System.getenv("EVERFRAME_SYMBOLS_STRICT").let { it == "1" || it == "true" }

/** Default time budget, in seconds, the CLI gets for one upload. */
internal const val DEFAULT_UPLOAD_TIMEOUT_SECONDS: String = "600"

/** The CLI's budget: EVERFRAME_UPLOAD_TIMEOUT_SECONDS when the CLI would accept it, else the default. */
internal fun uploadBudgetSeconds(raw: String?): Long =
    raw?.takeIf { Regex("[1-9][0-9]{0,6}").matches(it) }?.toLong() ?: DEFAULT_UPLOAD_TIMEOUT_SECONDS.toLong()

/**
 * How long the CLI process may run: its upload budget, plus as long again but at most a minute for
 * `npx` to fetch the CLI first. The CLI's own deadline ends a slow upload; this one ends a stalled
 * registry or any child that never reaches its own clock.
 */
internal fun cliTimeoutSeconds(budget: Long): Long = budget + minOf(budget, 60)

/** npm settings that keep `npx` from waiting minutes on a stalled registry, as in the Xcode phase. */
internal val NPM_FETCH_LIMITS: Map<String, String> = mapOf(
    "npm_config_fetch_timeout" to "20000",
    "npm_config_fetch_retries" to "1",
    "npm_config_fetch_retry_maxtimeout" to "5000",
)

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
 * so callers can summarize instead of echoing one warning per file. A child that
 * outlives [cliTimeoutSeconds] is stopped with everything it started. It runs in
 * [workingDirectory], the owning project's directory, so a relative command or
 * `EVERFRAME_CLI_JS` resolves against the project wherever Gradle was started.
 */
internal fun runCli(
    command: List<String>,
    workingDirectory: File,
    logger: Logger,
    what: String,
    environment: Map<String, String> = System.getenv(),
    output: (String) -> Unit = { logCliLine(logger, it) },
) {
    val budget = uploadBudgetSeconds(environment["EVERFRAME_UPLOAD_TIMEOUT_SECONDS"])
    val limit = cliTimeoutSeconds(budget)
    // Files, not pipes: nothing has to drain them while the child runs, and a killed child's
    // grandchildren cannot hold them open.
    val stdout = File.createTempFile("everframe-cli", ".out")
    val stderr = File.createTempFile("everframe-cli", ".err")
    try {
        val process = try {
            ProcessBuilder(command).directory(workingDirectory).redirectOutput(stdout).redirectError(stderr).also { builder ->
                builder.environment().putAll(environment)
                // A project's own npm settings win; these only bound the defaults.
                for ((name, value) in NPM_FETCH_LIMITS) builder.environment().putIfAbsent(name, value)
                builder.environment()["EVERFRAME_UPLOAD_TIMEOUT_SECONDS"] = budget.toString()
            }.start()
        } catch (error: Exception) {
            problem(logger, "could not run the Everframe CLI for the $what upload (${error.message?.substringBefore('\n')})")
            return
        }
        process.outputStream.close()
        val finished = try { process.waitFor(limit, TimeUnit.SECONDS) } catch (error: InterruptedException) {
            stop(process)
            Thread.currentThread().interrupt()
            throw error
        }
        if (!finished) stop(process)
        (stdout.readLines() + stderr.readLines()).filter { it.isNotBlank() }.forEach(output)
        when {
            !finished -> problem(logger, "the $what upload did not finish within $limit seconds and was stopped " +
                "(EVERFRAME_UPLOAD_TIMEOUT_SECONDS=$budget, plus time for npx to fetch the CLI)")
            process.exitValue() != 0 -> problem(logger, "$what upload failed (exit ${process.exitValue()})")
        }
    } finally {
        stdout.delete()
        stderr.delete()
    }
}

/** Ends the child and everything it started (npx runs the CLI in a process of its own). */
private fun stop(process: Process) {
    val descendants = process.descendants().toList()
    process.destroyForcibly()
    descendants.forEach { it.destroyForcibly() }
    process.waitFor(10, TimeUnit.SECONDS)
}
