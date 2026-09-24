# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
#
# everframe-reporter-ui LIBRARY-level R8 rules. Applied to this module's own
# R8 pass when `isMinifyEnabled = true` on the release variant.
#
# Policy: shrink + obfuscate. Only the documented public entry points host
# apps + the RN bridge resolve by name stay readable; @Composable functions
# are kept by name so the Compose runtime's slot-table lookup resolves them.
# Everything else (ReporterRoot internals, annotation overlay helpers, baked-
# PNG composer, etc.) renames to short ids in the published AAR.

# Strip debug info — see :everframe-core/proguard-rules.pro for rationale.
-keepattributes !SourceFile, !SourceDir, !LineNumberTable, !LocalVariableTable, !LocalVariableTypeTable

# ---------------------------------------------------------------------------
# Public reporter entry points — Everframe.shared.report.open() walks through
# the ReporterResolverInstaller singleton to find the host-presented dialog.
# RN bridge resolves this via Class.forName("dev.everframe.ui.ReporterResolverInstaller").
# TXReporterPresenter is the canonical handle host apps reference directly.
# ---------------------------------------------------------------------------
-keep class dev.everframe.ui.TXReporterPresenter { *; }
-keep class dev.everframe.ui.TXReporterPresenter$* { *; }
-keep class dev.everframe.ui.ReporterResolverInstaller { *; }

# ---------------------------------------------------------------------------
# Compose @Composable methods — Compose runtime resolves them via
# reflection-via-keys; renaming the method breaks the slot table lookup.
# ---------------------------------------------------------------------------
-keep @androidx.compose.runtime.Composable class dev.everframe.ui.**
-keepclasseswithmembers class dev.everframe.ui.** {
    @androidx.compose.runtime.Composable <methods>;
}
-keepclassmembers class dev.everframe.ui.** {
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

# Compose semantics walk — UITreeCapture in :everframe-core hits the
# reporter subtree's SemanticsOwner too.
-keep class androidx.compose.ui.platform.AndroidComposeView { *** getSemanticsOwner(); }
-keep class androidx.compose.ui.semantics.SemanticsOwner { *** getRootSemanticsNode(); *** getUnmergedRootSemanticsNode(); }
-keep class androidx.compose.ui.semantics.SemanticsNode { *** getChildren(); *** getConfig(); *** getBoundsInWindow(); }

# Don't-warn list.
-dontwarn java.lang.invoke.StringConcatFactory
-dontwarn com.google.errorprone.annotations.**
