# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX

# Public entry point used by Flutter and KMP hosts after app-level shrinking.
-keep class dev.everframe.ui.EFReporterFromImage { *; }

# RN and already-compiled native bridges resolve this API reflectively.
# Library shrinking and the consuming app's shrinking are separate passes.
-keep class dev.everframe.ui.ReporterResolverInstaller {
    public <init>();
    public *** create(android.content.Context);
    public java.lang.Object openForActivity(android.content.Context, android.app.Activity, kotlin.coroutines.Continuation);
}
