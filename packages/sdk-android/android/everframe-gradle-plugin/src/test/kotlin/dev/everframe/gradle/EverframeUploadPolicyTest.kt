// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.gradle

import java.io.File
import java.lang.reflect.Proxy
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.gradle.api.logging.Logger
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class EverframeUploadPolicyTest {
    @get:Rule val temporaryFolder = TemporaryFolder()
    private val warnings = mutableListOf<String>()
    private val logger = Proxy.newProxyInstance(Logger::class.java.classLoader, arrayOf(Logger::class.java)) { _, method, args ->
        if (method.name == "warn" && args?.size == 1) warnings += args[0] as String
        if (method.returnType == Boolean::class.javaPrimitiveType) false else null
    } as Logger

    @Test fun `the CLI budget follows EVERFRAME_UPLOAD_TIMEOUT_SECONDS as the CLI reads it`() {
        assertEquals(600, uploadBudgetSeconds(null))
        assertEquals(45, uploadBudgetSeconds("45"))
        assertEquals(600, uploadBudgetSeconds("0"))
        assertEquals(600, uploadBudgetSeconds("ten"))
        // The process gets its budget plus as long again, at most a minute, for npx to fetch the CLI.
        assertEquals(2, cliTimeoutSeconds(1))
        assertEquals(660, cliTimeoutSeconds(600))
    }

    @Test fun `a child that outlives its budget is stopped with everything it started`() {
        val pid = temporaryFolder.newFile("pid")
        val started = System.nanoTime()
        val lines = mutableListOf<String>()
        runCli(
            listOf("/bin/sh", "-c", "echo started; sleep 120 & echo \$! > '${pid.absolutePath}'; wait"),
            temporaryFolder.root, logger, "native symbols", mapOf("EVERFRAME_UPLOAD_TIMEOUT_SECONDS" to "1"),
        ) { lines += it }
        assertTrue(System.nanoTime() - started < TimeUnit.SECONDS.toNanos(20), "runCli waited for the stalled child")
        assertEquals(listOf("started"), lines)
        assertEquals(listOf("warning: everframe: the native symbols upload did not finish within 2 seconds and was stopped " +
            "(EVERFRAME_UPLOAD_TIMEOUT_SECONDS=1, plus time for npx to fetch the CLI). Crashes from this build will show raw frames " +
            "until it is uploaded. Set EVERFRAME_SYMBOLS_STRICT=1 to fail the build instead."), warnings)
        val sleeper = pid.readText().trim().toLong()
        assertFalse(ProcessHandle.of(sleeper).map { it.isAlive }.orElse(false), "the child's own child still runs")
    }

    @Test fun `npm fetches are bounded unless the project set its own limits`() {
        val script = "echo \"\$npm_config_fetch_timeout \$npm_config_fetch_retries \$npm_config_fetch_retry_maxtimeout \$EVERFRAME_UPLOAD_TIMEOUT_SECONDS\""
        val lines = mutableListOf<String>()
        runCli(listOf("/bin/sh", "-c", script), temporaryFolder.root, logger, "R8 mapping", mapOf("PATH" to "/usr/bin:/bin")) { lines += it }
        runCli(listOf("/bin/sh", "-c", script), temporaryFolder.root, logger, "R8 mapping",
            mapOf("npm_config_fetch_timeout" to "90000", "EVERFRAME_UPLOAD_TIMEOUT_SECONDS" to "30")) { lines += it }
        assertEquals(listOf("20000 1 5000 600", "90000 1 5000 30"), lines)
        assertEquals(emptyList(), warnings)
    }

    @Test fun `a relative command and its relative arguments resolve in the project directory`() {
        val project = temporaryFolder.newFolder("app")
        File(project, "tools").mkdirs()
        File(project, "tools/cli.sh").apply { writeText("#!/bin/sh\npwd -P\ncat \"\$1\"\n"); setExecutable(true) }
        File(project, "tools/args.txt").writeText("relative argument read\n")
        val lines = mutableListOf<String>()
        runCli(listOf("./tools/cli.sh", "tools/args.txt"), project, logger, "native symbols", emptyMap()) { lines += it }
        assertEquals(listOf(project.canonicalPath, "relative argument read"), lines)
        assertEquals(emptyList(), warnings)
    }

    @Test fun `a failed or missing CLI is a warning`() {
        runCli(listOf("/bin/sh", "-c", "exit 3"), temporaryFolder.root, logger, "R8 mapping", emptyMap()) {}
        runCli(listOf(File(temporaryFolder.root, "missing-cli").absolutePath), temporaryFolder.root, logger, "R8 mapping", emptyMap()) {}
        assertEquals(2, warnings.size)
        assertTrue(warnings[0].startsWith("warning: everframe: R8 mapping upload failed (exit 3)"), warnings[0])
        assertTrue(warnings[1].startsWith("warning: everframe: could not run the Everframe CLI for the R8 mapping upload"), warnings[1])
    }
}
