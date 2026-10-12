// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.compat.followthrough
import dev.everframe.protocol.generated.*
import kotlinx.serialization.json.Json
import java.io.File
object OldObserverComponentsCaller {
    @JvmStatic fun main(args: Array<String>) {
        val value = Json { ignoreUnknownKeys = true }.decodeFromString<Payload>(File(args[0]).readText())
        val (_, _, _, _, _, _, _, _, _, _, _, _, recovered) = value
        val direct: RecoveredStallEvidence? = value.component13()
        check(recovered != null && direct == value.recoveredStall && recovered == direct)
        println("OBSERVER_COMPONENT13_OK")
    }
}
