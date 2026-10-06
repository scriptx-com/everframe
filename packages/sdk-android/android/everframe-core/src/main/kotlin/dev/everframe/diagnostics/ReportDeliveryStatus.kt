// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.diagnostics

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** Best-effort local observations. HTTP acceptance and queue removal are separate facts. */
@Serializable
data class ReportDeliveryStatus(
    val schemaVersion: Int = 1,
    val status: String = "not-started",
    val reason: String = "no-start",
    val scope: String = "native-runtime-observations",
    val coverage: String = "best-effort",
    val revision: Int = 0,
    val capture: CaptureStatus = CaptureStatus(),
    val queue: QueueStatus = QueueStatus(),
    val transport: Map<String, TransportStatus> = TransportOrigin.entries.associate { it.code to TransportStatus() },
) {
    fun toJson(): String = wireJson.encodeToString(this)
    private companion object { val wireJson = Json { encodeDefaults = true; explicitNulls = false } }
}

@Serializable
data class CaptureStatus(
    val enabled: Boolean = false,
    val paths: Map<String, CapturePathStatus> = CapturePath.entries.associate { it.code to CapturePathStatus() },
)

@Serializable
data class CapturePathStatus(
    val supported: Boolean = true,
    val settledAttempts: Int = 0,
    val outcomes: Map<String, Int> = CaptureOutcome.entries.associate { it.code to 0 },
    val lastOutcome: String? = null,
)

@Serializable
data class QueueStatus(
    val scope: String = "sdk-report-outbox",
    val observation: String = "not-observed",
    val quality: String = "unknown",
    val pendingCount: Int? = null,
    val capacityPolicy: String = "reject-new",
    val terminalHttpPolicy: String = "retain",
    val operations: Map<String, Int> = QueueOperation.entries.associate { it.code to 0 },
    val lastFailure: String? = null,
    val migration: String = "not-observed",
)

@Serializable
data class TransportStatus(
    val settledAttempts: Int = 0,
    val outcomes: Map<String, Int> = TransportOutcome.entries.associate { it.code to 0 },
    val lastOutcome: String? = null,
    val lastHttpStatus: Int? = null,
)

internal enum class CapturePath(val code: String) {
    NATIVE_HANDLED("native-handled"), BRIDGE_HANDLED("bridge-handled"),
    BRIDGE_AUTOMATIC("bridge-automatic"), JVM_UNCAUGHT("jvm-uncaught")
}
internal enum class CaptureOutcome(val code: String) {
    PERSISTED("persisted"), DISABLED("disabled"), ADMISSION_SUPPRESSED("admission-suppressed"),
    REENTRANT("reentrant"), INVALID_INPUT("invalid-input"), OWNERSHIP_LOST("ownership-lost"),
    STORAGE_UNAVAILABLE("storage-unavailable"), FAILED("failed")
}
internal enum class QueueQuality(val code: String) { COMPLETE("complete"), PARTIAL("partial"), UNKNOWN("unknown") }
internal enum class QueueOperation(val code: String) {
    ENQUEUE_COMMITTED("enqueue-committed"), ENQUEUE_FAILED("enqueue-failed"), CAPACITY_EVICTED("capacity-evicted"),
    REMOVED_AFTER_ACCEPTANCE("removed-after-acceptance"), REMOVED_AFTER_TERMINAL("removed-after-terminal"),
    REMOVAL_FAILED("removal-failed"), READ_FAILED("read-failed")
}
internal enum class StorageFailure(val code: String) {
    CAPACITY("capacity"), KEY_UNAVAILABLE("key-unavailable"), CORRUPT("corrupt"), IO("io"),
    REVOKED("revoked"), INVALID_ENTRY("invalid-entry"), BUSY("busy"), UNKNOWN("unknown"),
    UNSUPPORTED_FORMAT("unsupported-format")
}
internal enum class TransportOrigin(val code: String) { LIVE_SUBMIT("live-submit"), OUTBOX_DRAIN("outbox-drain") }
internal enum class TransportOutcome(val code: String) {
    SERVER_ACCEPTED("server-accepted"), RETRYABLE_HTTP("retryable-http"), TERMINAL_HTTP("terminal-http"),
    NETWORK_FAILURE("network-failure"), AUTHORIZATION_CANCELLED("authorization-cancelled"),
    CANCELLED("cancelled"), FAILED("failed")
}
