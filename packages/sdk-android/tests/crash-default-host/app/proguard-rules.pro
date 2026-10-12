# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
-keepclasseswithmembernames class * { native <methods>; }
# Readable class names in the ANR main-thread frames the acceptance test asserts.
-keep class dev.everframe.crashdefault.** { *; }
