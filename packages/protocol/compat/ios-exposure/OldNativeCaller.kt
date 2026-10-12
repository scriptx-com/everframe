// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.compat.ioshealth
import dev.everframe.protocol.generated.*
object OldNativeCaller {
    @JvmStatic fun copy(value: NativeCrashMetadata): NativeCrashMetadata = value.copy(timestampMicros = "12")
    @JvmStatic fun make(): NativeCrashMetadata = NativeCrashMetadata(0, NativeCrashError(), emptyList(), false, emptyList(), false, NativeCrashPlatform.Apple, "11")
}
