// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.diagnostics

import dev.everframe.outbox.OutboxEntry
import kotlinx.serialization.json.*
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

/** Frozen template is prepared while healthy; no current identity or release is consulted here. */
internal fun recoveredStallEntry(template: OutboxEntry, observation: RecoveredStallObservation, apiLevel: Int): OutboxEntry {
    val id = UUID.randomUUID().toString()
    val frozen = Json.parseToJsonElement(template.envelopeBytes.toString(Charsets.UTF_8)).jsonObject
    val evidence = buildJsonObject {
        put("version", 1); put("evidenceId", id); put("kind", "recovered_main_thread_stall")
        put("provenance", "android_main_looper_probe"); put("outcome", "recovered"); put("scope", "main_looper")
        put("queuedAt", Instant.ofEpochMilli(observation.queuedAtMs).toString())
        put("recoveredAt", Instant.ofEpochMilli(observation.recoveredAtMs).toString())
        put("probeDelayMs", observation.probeDelayMs); put("thresholdMs", 5000); put("sampleIntervalMs", 1000)
        put("clock", "uptime"); put("eligibility", "foreground-debugger-checked-v1"); put("trace", "not_collected")
        put("attribution", buildJsonObject {
            put("release", "frozen"); put("session", "unavailable")
            put("webExposure", "unavailable"); put("nativeExposure", "unavailable")
        })
        put("android", buildJsonObject { put("apiLevel", apiLevel) })
    }
    val bytes = JsonObject((frozen - "sessionId") + mapOf(
        "reportId" to JsonPrimitive(id), "source" to JsonPrimitive("diagnostic"),
        "submittedAt" to JsonPrimitive(Instant.ofEpochMilli(observation.recoveredAtMs).toString()),
        "reporter" to buildJsonObject {
            put("title", "Recovered main-thread delay")
            put("description", "An SDK main-looper probe executed after a delay. This is not an OS ANR or process termination.")
        },
        "captures" to buildJsonObject {
            for (name in listOf("screenshot", "uiTree", "focus", "logs", "network")) put(name, false)
        },
        "captureControl" to buildJsonObject { put("included", JsonArray(emptyList())); put("excluded", JsonArray(emptyList())) },
        "payload" to buildJsonObject { put("recoveredStall", evidence) },
        "attachments" to JsonArray(emptyList()),
    )).toString().toByteArray(Charsets.UTF_8)
    require(bytes.size <= 64 * 1024) { "Recovered observation exceeds record limit" }
    val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    return template.copy(reportId = id, createdAt = observation.recoveredAtMs, envelopeBytes = bytes,
        idempotencyKey = digest, attachmentRefs = emptyList(), identitySubject = null)
}
