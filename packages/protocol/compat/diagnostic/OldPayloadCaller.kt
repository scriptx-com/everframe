// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.compat
import dev.everframe.protocol.generated.Payload
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
object OldPayloadCaller {
    @JvmStatic fun main(args: Array<String>) {
        check(Payload(extra = "constructed").extra == "constructed")
        val codec = Json { ignoreUnknownKeys = true }
        val decoded = codec.decodeFromString<Payload>(File(args[0]).readText())
        println(codec.encodeToString(decoded.copy(extra = "old caller copy")))
    }
}
