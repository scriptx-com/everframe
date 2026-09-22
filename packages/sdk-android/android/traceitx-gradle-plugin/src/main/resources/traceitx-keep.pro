# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
#
# TraceItX Gradle plugin keep rules — applied to host app's R8 config when
# they use the `com.traceitx.android` Gradle plugin (an alternative to the
# AAR's consumer-rules.pro auto-merge path for hosts that pin proguard
# files explicitly).
#
# Policy: identical to :traceitx-core/consumer-rules.pro. The plugin path
# and the AAR auto-merge path must produce the same R8 surface so a host
# can switch between them without seeing different obfuscation behavior.
#
# Earlier revision declared `-keep class com.traceitx.** { *; }` on the
# (incorrect) theory that componentPath reflection needed our own class
# names — componentPath walks the CONSUMER's Compose tree, not ours.
# Removed; only explicit public-API + cross-module + serialization keeps
# remain. See :traceitx-core/consumer-rules.pro for the full rationale.

# ---------------------------------------------------------------------------
# Public API — keep parity with traceitx-core/consumer-rules.pro.
# ---------------------------------------------------------------------------
-keep class com.traceitx.TraceItX { *; }
-keep class com.traceitx.TraceItX$* { *; }
-keep class com.traceitx.ReportAPI { *; }
-keep class com.traceitx.ReportAPI$* { *; }
-keep class com.traceitx.SensitiveAPI { *; }

-keep class com.traceitx.config.TraceItXConfig { *; }
-keep class com.traceitx.config.CaptureConfig { *; }
-keep class com.traceitx.config.CaptureConfig$Companion { *; }
-keep class com.traceitx.config.Environment { *; }
-keep class com.traceitx.config.TXUser { *; }
-keep class com.traceitx.config.ReportResult { *; }
-keep class com.traceitx.config.ReportResult$* { *; }
-keep class com.traceitx.config.TraceItXConfigError { *; }
-keep class com.traceitx.config.TraceItXConfigError$* { *; }
-keep class com.traceitx.config.TraceItXEnvelopeError { *; }
-keep class com.traceitx.config.TraceItXEnvelopeError$* { *; }
-keep class com.traceitx.config.IngestEndpoint { *; }

-keep class com.traceitx.transport.TraceItXTransportError { *; }
-keep class com.traceitx.transport.TraceItXTransportError$* { *; }
-keep class com.traceitx.okhttp.TraceItXInterceptor { *; }
-keep class com.traceitx.okhttp.OkHttpInterceptorKt { *; }
-keep class com.traceitx.sensitive.SensitiveKt { *; }
-keep class com.traceitx.sensitive.SensitivePropertyKeyKt { *; }

-keep class com.traceitx.companion.Companion { *; }
-keep class com.traceitx.companion.CompanionState { *; }
-keep class com.traceitx.companion.CompanionState$* { *; }
-keep class com.traceitx.companion.RelayWSClient { *; }
-keep class com.traceitx.companion.RelayWSClient$* { *; }
-keep class com.traceitx.companion.CompanionCaptureBridge { *; }
-keep class com.traceitx.companion.CompanionCaptureBridge$* { *; }
-keep class com.traceitx.companion.CompanionSubmissionComposer { *; }
-keep class com.traceitx.companion.CompanionSubmissionComposer$* { *; }

-keep class com.traceitx.capture.UITreeCapture { *; }
-keep class com.traceitx.capture.ScreenshotCapture { *; }
-keep class com.traceitx.capture.SensitiveRectRegistry { *; }

-keep class com.traceitx.envelope.NetworkLogEntry { *; }
-keep class com.traceitx.envelope.LogEntry { *; }
-keep class com.traceitx.envelope.LogLevel { *; }
-keep class com.traceitx.envelope.LogLevel$* { *; }

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

# Parity with :traceitx-core/consumer-rules.pro (this file's stated policy).
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
-keep class com.traceitx.protocol.generated.** { *; }
-keepclassmembers class com.traceitx.protocol.generated.** {
    public static *** Companion;
}
-keepclassmembers class com.traceitx.protocol.generated.**$Companion {
    public *** serializer(...);
}
