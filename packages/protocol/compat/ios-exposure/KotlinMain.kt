// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.compat.ioshealth
import dev.everframe.protocol.generated.*
import kotlinx.serialization.json.Json
import java.io.File
object KotlinMain {
    @JvmStatic fun main(args: Array<String>) {
        val value = Json.decodeFromString<NativeCrashMetadata>(File(args[0]).readText())
        val copied = OldNativeCaller.copy(value)
        check(copied.timestampMicros == "12")
        check(copied.releaseHealthEvidence == value.releaseHealthEvidence && copied.releaseHealthEvidence != null)
        check(OldNativeCaller.make().releaseHealthEvidence == null)
        check(OldJavaCaller.make(value.error).releaseHealthEvidence == null)
        println("OLD_NATIVE_JVM_OK")
    }
}
