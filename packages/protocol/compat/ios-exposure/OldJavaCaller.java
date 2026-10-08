// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.compat.ioshealth;
import dev.everframe.protocol.generated.*;
import java.util.Collections;
public final class OldJavaCaller {
    public static NativeCrashMetadata make(NativeCrashError error) {
        return new NativeCrashMetadata(0L, error, Collections.emptyList(), false, Collections.emptyList(), false, NativeCrashPlatform.Apple, "13");
    }
}
