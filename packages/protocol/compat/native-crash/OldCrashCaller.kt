// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// Compile against the predecessor jar, then keep these class bytes unchanged.
package dev.everframe.compat
import dev.everframe.protocol.generated.Crash
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
object OldCrashCaller {
    @JvmStatic fun main(args: Array<String>) {
        val constructed = Crash(exceptionType = "Synthetic", fingerprint = "aaaaaaaaaaaaaaaa",
            frames = emptyList(), handled = false, mechanism = "native-mach", message = "constructed",
            occurredAt = "2026-10-07T00:00:00Z", causeChain = null)
        check(constructed.message == "constructed")
        val codec = Json { ignoreUnknownKeys = true }
        val decoded = codec.decodeFromString<Crash>(File(args[0]).readText())
        val copied = decoded.copy(causeChain = decoded.causeChain, message = "old copy")
        val olderCopy = copied.copy(message = "older copy")
        println(codec.encodeToString(olderCopy))
    }
}
