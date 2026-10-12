// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.compat
import dev.everframe.protocol.generated.Payload
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
object OldE8PayloadCaller {
    @JvmStatic fun main(args: Array<String>) {
        check(Payload(null, null, null, "constructed", null, null, null, null, null, null, null, null).extra == "constructed")
        val codec = Json { ignoreUnknownKeys = true }
        val decoded = codec.decodeFromString<Payload>(File(args[0]).readText())
        println(codec.encodeToString(decoded.copy(diagnostic = decoded.diagnostic, extra = "e8 caller copy")))
    }
}
