// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.compat.followthrough
import dev.everframe.protocol.generated.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
object OldApplePayloadCaller {
    @JvmStatic fun main(args: Array<String>) {
        check(Payload(null, null, null, "constructed", null, null, null, null, null, null, null, null, null as AppleDiagnosticEvidence?).extra == "constructed")
        val codec = Json { ignoreUnknownKeys = true }
        val value = codec.decodeFromString<Payload>(File(args[0]).readText())
        println(codec.encodeToString(value.copy(appleDiagnostic = value.appleDiagnostic, extra = "apple caller copy")))
    }
}
