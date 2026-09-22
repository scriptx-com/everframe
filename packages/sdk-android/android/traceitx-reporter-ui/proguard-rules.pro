# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
#
# traceitx-reporter-ui LIBRARY-level R8 rules. Applied to this module's own
# R8 pass when `isMinifyEnabled = true` on the release variant.
#
# Policy: shrink + obfuscate. Only the documented public entry points host
# apps + the RN bridge resolve by name stay readable; @Composable functions
# are kept by name so the Compose runtime's slot-table lookup resolves them.
# Everything else (ReporterRoot internals, annotation overlay helpers, baked-
# PNG composer, etc.) renames to short ids in the published AAR.

# Strip debug info — see :traceitx-core/proguard-rules.pro for rationale.
-keepattributes !SourceFile, !SourceDir, !LineNumberTable, !LocalVariableTable, !LocalVariableTypeTable

# ---------------------------------------------------------------------------
# Public reporter entry points — TraceItX.shared.report.open() walks through
# the ReporterResolverInstaller singleton to find the host-presented dialog.
# RN bridge resolves this via Class.forName("com.traceitx.ui.ReporterResolverInstaller").
# TXReporterPresenter is the canonical handle host apps reference directly.
# ---------------------------------------------------------------------------
-keep class com.traceitx.ui.TXReporterPresenter { *; }
-keep class com.traceitx.ui.TXReporterPresenter$* { *; }
-keep class com.traceitx.ui.ReporterResolverInstaller { *; }

# ---------------------------------------------------------------------------
# Compose @Composable methods — Compose runtime resolves them via
# reflection-via-keys; renaming the method breaks the slot table lookup.
# ---------------------------------------------------------------------------
-keep @androidx.compose.runtime.Composable class com.traceitx.ui.**
-keepclasseswithmembers class com.traceitx.ui.** {
    @androidx.compose.runtime.Composable <methods>;
}
-keepclassmembers class com.traceitx.ui.** {
    @androidx.compose.runtime.Composable <methods>;
}

# ---------------------------------------------------------------------------
# Compose runtime metadata.
# ---------------------------------------------------------------------------
-keepattributes RuntimeVisibleAnnotations
-keepattributes RuntimeInvisibleAnnotations
-keepattributes Signature
-keepattributes InnerClasses
-keepattributes EnclosingMethod

# Compose semantics walk — UITreeCapture in :traceitx-core hits the
# reporter subtree's SemanticsOwner too.
-keep class androidx.compose.ui.platform.AndroidComposeView { *** getSemanticsOwner(); }
-keep class androidx.compose.ui.semantics.SemanticsOwner { *** getRootSemanticsNode(); *** getUnmergedRootSemanticsNode(); }
-keep class androidx.compose.ui.semantics.SemanticsNode { *** getChildren(); *** getConfig(); *** getBoundsInWindow(); }

# Don't-warn list.
-dontwarn java.lang.invoke.StringConcatFactory
-dontwarn com.google.errorprone.annotations.**
