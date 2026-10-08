// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.time.Instant
import kotlinx.serialization.json.*

internal object AndroidExitDiagnostic {
    const val MAX_TRACE_BYTES = 256 * 1024
    const val MAX_FRAMES = 64
    private val header = Regex("^----- pid ([0-9]+) at .+ -----$")
    // Kotlin value-class and lambda names (FeedRow-8Feqmps, lambda-1) contain '-'.
    private val frame = Regex("^\\s+at ([A-Za-z0-9_.$<>-]{1,256})\\((?:([A-Za-z0-9_.$-]{1,128})(?::([0-9]{1,10}))?|Native method|Unknown Source)\\).*$")
    private val frameLine = Regex("^\\s+at ")

    fun cause(reason: Int): String = when (reason) {
        6 -> "anr"
        5 -> "native_crash"
        4 -> "java_crash"
        3 -> "system_low_memory"
        10, 11 -> "user_requested"
        1, 7, 8, 9, 12, 13, 14, 15, 16 -> "system_other"
        else -> "unknown"
    }

    fun trace(status: String, format: String = "none", truncated: Boolean = false, frames: List<JsonObject> = emptyList()) = buildJsonObject {
        put("status", status); put("format", format); put("truncated", truncated); put("frames", JsonArray(frames))
    }

    /** Keep only structured frames from this PID's main thread. Never retain raw trace text. */
    fun readAnr(open: () -> InputStream?, expectedPid: Int): JsonObject {
        var truncated = false
        try {
            val stream = open() ?: return trace("unavailable")
            val bytes = stream.use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(4096)
                while (output.size() <= MAX_TRACE_BYTES) {
                    val count = input.read(buffer, 0, minOf(buffer.size, MAX_TRACE_BYTES + 1 - output.size()))
                    if (count < 0) break
                    if (count == 0) return trace("malformed")
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            }
            truncated = bytes.size > MAX_TRACE_BYTES
            val text = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes, 0, minOf(bytes.size, MAX_TRACE_BYTES))).toString()
            var matchingProcess = false
            var main = false
            val frames = ArrayList<JsonObject>()
            for (line in text.lineSequence()) {
                val processHeader = header.matchEntire(line)
                if (processHeader != null) {
                    if (main) break
                    matchingProcess = processHeader.groupValues[1].toIntOrNull() == expectedPid
                }
                if (line.startsWith("----- end")) { if (main) break; matchingProcess = false }
                if (!matchingProcess) continue
                if (line.startsWith('"')) {
                    if (main) break
                    main = line.startsWith("\"main\"")
                    continue
                }
                if (!main) continue
                val match = frame.matchEntire(line)
                if (match == null) {
                    // A frame outside the retained grammar is omitted, never silently.
                    if (frameLine.containsMatchIn(line)) truncated = true
                    continue
                }
                if (frames.size == MAX_FRAMES) { truncated = true; break }
                frames.add(buildJsonObject {
                    put("function", match.groupValues[1])
                    match.groupValues[2].takeIf { it.isNotEmpty() }?.let { put("file", it) }
                    match.groupValues[3].toIntOrNull()?.takeIf { it > 0 }?.let { put("line", it) }
                })
            }
            return if (frames.isEmpty()) trace("malformed", truncated = truncated)
                else trace("available", "android_anr_text", truncated, frames)
        } catch (_: Exception) { return trace("malformed", truncated = truncated) }
    }

    fun evidence(reportId: String, processLaunchId: String, apiLevel: Int, exit: AndroidNativeExit,
                 nowMs: Long, trace: JsonObject) = buildJsonObject {
        put("version", 1); put("evidenceId", reportId); put("processLaunchId", processLaunchId)
        put("kind", "process_exit"); put("provenance", "android_application_exit_info"); put("scope", "os_process")
        put("outcome", "terminated"); put("cause", cause(exit.reason))
        put("occurredAt", Instant.ofEpochMilli(exit.timestamp).toString()); put("collectedAt", Instant.ofEpochMilli(nowMs).toString())
        put("attribution", buildJsonObject {
            put("process", "exact_os_token"); put("release", "frozen"); put("session", "unavailable"); put("webExposure", "unavailable")
        })
        put("android", buildJsonObject { put("apiLevel", apiLevel); put("reason", exit.reason); put("pid", exit.pid) })
        put("trace", trace)
    }
}
