// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.compat.inferredtermination
import dev.everframe.protocol.generated.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
object OldPayloadCaller {
    @JvmStatic fun main(args: Array<String>) {
        // The full positional constructor immediately before inferred terminations were added.
        val constructed = Payload(null, null, null, "constructed", null, null, null, null, null, null, null,
            null as DiagnosticEvidence?, null as AppleDiagnosticEvidence?, null as RecoveredStallEvidence?)
        check(constructed.extra == "constructed")
        val codec = Json { ignoreUnknownKeys = true }
        val value = codec.decodeFromString<Payload>(File(args[0]).readText())
        println(codec.encodeToString(value.copy(diagnostic = value.diagnostic, appleDiagnostic = value.appleDiagnostic,
            recoveredStall = value.recoveredStall, extra = "old caller copy")))
    }
}
