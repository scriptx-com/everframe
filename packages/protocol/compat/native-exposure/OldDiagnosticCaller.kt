// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.compat.exposure
import dev.everframe.protocol.generated.DiagnosticEvidence
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
object OldDiagnosticCaller {
    @JvmStatic fun main(args: Array<String>) {
        val codec = Json { ignoreUnknownKeys = true }
        val value = codec.decodeFromString<DiagnosticEvidence>(File(args[0]).readText())
        val constructed = DiagnosticEvidence(value.android, value.attribution, value.cause, value.collectedAt,
            value.evidenceID, value.kind, value.occurredAt, value.outcome, value.processLaunchID,
            value.provenance, value.scope, value.trace, value.version)
        check(constructed.evidenceID == value.evidenceID)
        println(codec.encodeToString(value.copy(version = value.version)))
    }
}
