# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
#
# Everframe Gradle plugin keep rules — applied to host app's R8 config when
# they use the `dev.everframe.android` Gradle plugin (an alternative to the
# AAR's consumer-rules.pro auto-merge path for hosts that pin proguard
# files explicitly).
#
# Policy: identical to :everframe-core/consumer-rules.pro. The plugin path
# and the AAR auto-merge path must produce the same R8 surface so a host
# can switch between them without seeing different obfuscation behavior.
#
# Earlier revision declared `-keep class dev.everframe.** { *; }` on the
# (incorrect) theory that componentPath reflection needed our own class
# names — componentPath walks the CONSUMER's Compose tree, not ours.
# Removed; only explicit public-API + cross-module + serialization keeps
# remain. See :everframe-core/consumer-rules.pro for the full rationale.

# ---------------------------------------------------------------------------
# Public API — keep parity with everframe-core/consumer-rules.pro.
# ---------------------------------------------------------------------------
-keep class dev.everframe.Everframe { *; }
-keep class dev.everframe.Everframe$* { *; }
-keep class dev.everframe.ReportAPI { *; }
-keep class dev.everframe.ReportAPI$* { *; }
-keep class dev.everframe.SensitiveAPI { *; }

-keep class dev.everframe.config.EverframeConfig { *; }
-keep class dev.everframe.config.CaptureConfig { *; }
-keep class dev.everframe.config.CaptureConfig$Companion { *; }
-keep class dev.everframe.config.Environment { *; }
-keep class dev.everframe.config.TXUser { *; }
-keep class dev.everframe.config.ReportResult { *; }
-keep class dev.everframe.config.ReportResult$* { *; }
-keep class dev.everframe.config.EverframeConfigError { *; }
-keep class dev.everframe.config.EverframeConfigError$* { *; }
-keep class dev.everframe.config.EverframeEnvelopeError { *; }
-keep class dev.everframe.config.EverframeEnvelopeError$* { *; }
-keep class dev.everframe.config.IngestEndpoint { *; }

-keep class dev.everframe.transport.EverframeTransportError { *; }
-keep class dev.everframe.transport.EverframeTransportError$* { *; }
-keep class dev.everframe.okhttp.EverframeInterceptor { *; }
-keep class dev.everframe.okhttp.OkHttpInterceptorKt { *; }
-keep class dev.everframe.sensitive.SensitiveKt { *; }
-keep class dev.everframe.sensitive.SensitivePropertyKeyKt { *; }

-keep class dev.everframe.companion.Companion { *; }
-keep class dev.everframe.companion.CompanionState { *; }
-keep class dev.everframe.companion.CompanionState$* { *; }
-keep class dev.everframe.companion.RelayWSClient { *; }
-keep class dev.everframe.companion.RelayWSClient$* { *; }
-keep class dev.everframe.companion.CompanionCaptureBridge { *; }
-keep class dev.everframe.companion.CompanionCaptureBridge$* { *; }
-keep class dev.everframe.companion.CompanionSubmissionComposer { *; }
-keep class dev.everframe.companion.CompanionSubmissionComposer$* { *; }

-keep class dev.everframe.capture.UITreeCapture { *; }
-keep class dev.everframe.capture.ScreenshotCapture { *; }
-keep class dev.everframe.capture.SensitiveRectRegistry { *; }

-keep class dev.everframe.envelope.NetworkLogEntry { *; }
-keep class dev.everframe.envelope.LogEntry { *; }
-keep class dev.everframe.envelope.LogLevel { *; }
-keep class dev.everframe.envelope.LogLevel$* { *; }

# ---------------------------------------------------------------------------
# Compose semantics walk — componentPath capture reflects on the CONSUMER's
# Compose tree.
# ---------------------------------------------------------------------------
-keep @androidx.compose.runtime.Composable class **
-keepclasseswithmembers class * {
    @androidx.compose.runtime.Composable <methods>;
}
-keepclassmembers class * {
    @androidx.compose.runtime.Composable <methods>;
}

# Parity with :everframe-core/consumer-rules.pro (this file's stated policy).
# These framework accessors are what the semantics walk resolves by name, and
# the Compose text-style chain below CANNOT work without them — it reaches
# TextStyle through SemanticsConfiguration and SemanticsPropertyKey.getName().
-keep class androidx.compose.ui.platform.AndroidComposeView {
    public *** getSemanticsOwner();
}
-keep class androidx.compose.ui.semantics.SemanticsOwner {
    public *** getRootSemanticsNode();
    public *** getUnmergedRootSemanticsNode();
}
-keep class androidx.compose.ui.semantics.SemanticsNode {
    public *** getChildren();
    public *** getConfig();
    public *** getBoundsInWindow();
}
-keep class androidx.compose.ui.semantics.SemanticsConfiguration { *; }
-keep class androidx.compose.ui.semantics.SemanticsPropertyKey {
    public *** getName();
}
-keep class androidx.compose.ui.geometry.Rect {
    public *** getLeft();
    public *** getTop();
    public *** getRight();
    public *** getBottom();
}

-keepattributes RuntimeVisibleAnnotations
-keepattributes RuntimeInvisibleAnnotations
-keepattributes Signature
-keepattributes InnerClasses
-keepattributes EnclosingMethod
-keepattributes SourceFile,LineNumberTable

# ---------------------------------------------------------------------------
# kotlinx.serialization.
# ---------------------------------------------------------------------------
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,allowobfuscation,allowshrinking class * extends kotlinx.serialization.KSerializer
-keep,allowobfuscation,allowshrinking class * implements kotlinx.serialization.KSerializer
-keep class dev.everframe.protocol.generated.** { *; }
-keepclassmembers class dev.everframe.protocol.generated.** {
    public static *** Companion;
}
-keepclassmembers class dev.everframe.protocol.generated.**$Companion {
    public *** serializer(...);
}
