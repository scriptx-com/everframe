// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.compat.followthrough
import dev.everframe.protocol.generated.*
import kotlinx.serialization.json.Json
import java.io.File
object OldAppleComponentsCaller {
    @JvmStatic fun main(args: Array<String>) {
        val value = Json { ignoreUnknownKeys = true }.decodeFromString<Payload>(File(args[0]).readText())
        val (_, _, _, _, _, _, _, _, _, _, _, _, apple) = value
        val direct: AppleDiagnosticEvidence? = value.component13()
        check(apple != null && direct == value.appleDiagnostic && apple == direct)
        println("APPLE_COMPONENT13_OK")
    }
}
