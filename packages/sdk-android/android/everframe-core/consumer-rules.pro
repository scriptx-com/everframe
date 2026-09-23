# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
#
# Everframe consumer-rules.pro — applied to host app's R8 pass when they
# depend on :everframe-core (AGP merges this with their proguard config).
#
# Policy: keep ONLY the API surface a customer app or its tooling
# (RN bridge, Compose runtime, kotlinx.serialization plugin, OkHttp
# autodiscovery) resolves by name. Everything else in `dev.everframe.**`
# gets obfuscated by the customer's R8 — internal helpers, ring buffer
# implementations, transport details, redaction engine, capture
# internals, companion state machine internals, etc. all rename to
# short identifiers in the published APK.
#
# Earlier revisions of this file declared `-keep class dev.everframe.**
# { *; }` on the theory that componentPath capture needed our own class
# names reflectively. That was wrong — componentPath walks the
# CONSUMER's Compose tree (their classes, their composable names), not
# Everframe internals. The blanket keep made our deployed APK code
# fully readable to anyone with `apktool`, defeating R8 entirely for
# our surface. Removed.

# ---------------------------------------------------------------------------
# Top-level singleton + nested types (companion, ReportAPI, SensitiveAPI).
# Customer source compiles against these by name.
# ---------------------------------------------------------------------------
-keep class dev.everframe.Everframe { *; }
-keep class dev.everframe.Everframe$* { *; }
-keep class dev.everframe.ReportAPI { *; }
-keep class dev.everframe.ReportAPI$* { *; }
-keep class dev.everframe.SensitiveAPI { *; }

# Native handled-error options are constructed by Kotlin and Java callers.
# Keep the data class's generated constructors/accessors/copy members and the
# public enum constants through both the library and consumer R8 passes.
-keep class dev.everframe.CaptureExceptionOptions { *; }
-keep enum dev.everframe.ErrorSeverity { *; }

# TXScreen() navigation-marker composable (TXScreen.kt -> TXScreenKt facade).
-keep class dev.everframe.TXScreenKt { *; }

# ---------------------------------------------------------------------------
# Public config / result / error types — passed across the public boundary
# in `start(...)`, `report(...)`, exception catch blocks.
# ---------------------------------------------------------------------------
-keep class dev.everframe.config.EverframeConfig { *; }
-keep class dev.everframe.config.CaptureConfig { *; }
-keep class dev.everframe.config.CaptureConfig$Companion { *; }
-keep class dev.everframe.config.Environment { *; }
-keep class dev.everframe.config.TXUser { *; }

# Branding (spec 2026-08-26): mirrors the identical addition in
# ../proguard-rules.pro (see that file for the full rationale). This copy
# drives the CONSUMER app's own R8 pass — a host app that reads
# EverframeConfig.theme, or (via :everframe-reporter-ui, which bundles this
# file's rules transitively as its own consumer-rules dependency) collects
# BrandingServerConfigSignal/BrandingInlineTheme or calls the top-level
# shouldShowWatermark() (BrandingKt), needs these types to survive the
# customer's own release-mode R8 pass too.
-keep class dev.everframe.config.ReporterThemeOptions { *; }
-keep class dev.everframe.config.BrandingConfigWire { *; }
-keep class dev.everframe.config.BrandingThemeWire { *; }
-keep class dev.everframe.config.BrandingServerConfigSignal { *; }
-keep class dev.everframe.config.BrandingInlineTheme { *; }
-keep class dev.everframe.config.BrandingKt { *; }

# Session Vitals (Android spec 2026-09-05) — mirrors the identical addition in
# ../proguard-rules.pro (see that file for the full rationale). This copy
# drives the CONSUMER app's OWN R8 pass: a host app that builds a
# `VitalsConfig`, writes its own `PlayerIntegration`, or holds the
# `PlayerHandle` returned by `Everframe.trackPlayer(...)` needs these types to
# survive its own release-mode minification too — and `:everframe-media3`
# bundles this file transitively, so its `Media3Integration` (which implements
# `PlayerIntegration` and emits `PlayerEventTypes` constants) depends on the
# same keeps one step later.
-keep class dev.everframe.config.VitalsConfig { *; }
-keep class dev.everframe.vitals.PlayerIntegration { *; }
-keep class dev.everframe.vitals.PlayerIntegrationContext { *; }
-keep class dev.everframe.vitals.PlayerHandle { *; }
-keep class dev.everframe.vitals.PlayerSnapshot { *; }
-keep class dev.everframe.vitals.StartupTimings { *; }
-keep class dev.everframe.vitals.wire.PlayerEventTypes { *; }
# Mirrors ../proguard-rules.pro (see there for how these three were caught:
# a real `:everframe-media3:assembleRelease` against the minified core AAR).
# `PlayerIntegrationContext.emit`'s default arguments compile to the synthetic
# `$DefaultImpls` class; `sanitizeSource()`/`protocolForMime()` live on the
# file-derived `SanitizeSourceKt` facade and return `SanitizedSource`.
-keep class dev.everframe.vitals.PlayerIntegrationContext$* { *; }
-keep class dev.everframe.vitals.SanitizeSourceKt { *; }
-keep class dev.everframe.vitals.SanitizedSource { *; }

# RN spec 2026-09-06 — the host-fed player seam. `RemotePlayerRegistry` is
# constructed BY THE CONSUMER (the @everframe/react-native bridge module, which
# compiles separately against the published core AAR, exactly like
# :everframe-media3 above), so it is customer-facing surface even though nothing
# inside core names it. Without this keep, R8 renames it to a single letter and
# the bridge fails with `Unresolved reference 'RemotePlayerRegistry'` — the
# same failure mode the media3 entries above document. The `$*` entry covers
# the nested `Companion` object (`safeEpochMs`, `MAX_TOKENS`) the same way the
# `PlayerIntegrationContext$*` entry above covers `$DefaultImpls`: a keep on
# the outer class does NOT cascade to its nested types.
-keep class dev.everframe.vitals.RemotePlayerRegistry { *; }
-keep class dev.everframe.vitals.RemotePlayerRegistry$* { *; }
-keep class dev.everframe.vitals.RemotePlayerIntegration { *; }

# Self-declared user snapshot (external review, finding 1, 2026-08-12) —
# `Everframe.captureUserSnapshot()` returns it and :everframe-reporter-ui threads
# it through `submitBaked` into `CompanionSubmissionComposer.Inputs`, so
# reporter-ui's own R8 pass must resolve it against the published core AAR.
# Without this the reporter-ui release build fails with "Missing class
# dev.everframe.TXCapturedUser".
-keep class dev.everframe.TXCapturedUser { *; }

# Independent review, codex round 10, CRITICAL — mirrors the identical keep
# in ../proguard-rules.pro (see that file's own comment for the full
# rationale). This copy drives the CONSUMER app's OWN R8 pass — without it,
# a customer app that imports `dev.everframe.identity.IdentityTokenSource`
# and calls `Everframe.setIdentityToken(IdentityTokenSource.Token(jwt))` (the
# documented Android usage, the user-recognition contract) compiles fine
# against the AAR but the TYPE gets renamed again in THEIR OWN release APK,
# same failure mode one step later. The two files must stay in sync for this
# type for the same reason the file header states they do for every other
# customer-facing type.
-keep class dev.everframe.identity.IdentityTokenSource { *; }
-keep class dev.everframe.identity.IdentityTokenSource$* { *; }

# Crash-entry session snapshot (follow-ups item 6, 2026-08-13) — the sibling of
# the above and kept for the same reason: `Everframe.captureSessionSnapshot()` is
# public and returns it, so it is part of the published surface, and follow-ups
# item 9 threads it through :everframe-reporter-ui exactly as `TXCapturedUser` is
# threaded today. Without this, R8 renames the return type of a public method in
# a minified release and reporter-ui's own pass fails to resolve it.
# `{ *; }` does NOT re-expose the `internal` `copy()`: `@ConsistentCopyVisibility`
# makes kotlinc emit it pre-mangled as `copy$everframe_core`, and a keep rule only
# stops R8 removing or renaming that symbol — it does not rewrite Kotlin
# @Metadata, which is what enforces visibility for Kotlin consumers. Same as
# TXCapturedUser, whose constructor has been `internal` under this same rule
# since 2026-08-12.
-keep class dev.everframe.TXCapturedSession { *; }
-keep class dev.everframe.config.ReportResult { *; }
-keep class dev.everframe.config.ReportResult$* { *; }
-keep class dev.everframe.config.EverframeConfigError { *; }
-keep class dev.everframe.config.EverframeConfigError$* { *; }
-keep class dev.everframe.config.EverframeEnvelopeError { *; }
-keep class dev.everframe.config.EverframeEnvelopeError$* { *; }

# IngestEndpoint is build-time baked via BuildConfig; the consumer never
# references it but the publishing variant's bytecode does.
-keep class dev.everframe.config.IngestEndpoint { *; }

# ---------------------------------------------------------------------------
# Transport error surface — escapes via thrown exceptions consumers catch.
# ---------------------------------------------------------------------------
-keep class dev.everframe.transport.EverframeTransportError { *; }
-keep class dev.everframe.transport.EverframeTransportError$* { *; }

# ---------------------------------------------------------------------------
# OkHttp interceptor — consumers register via the addEverframeInterceptor
# extension function. Keep the whole public package: the facade class name is
# derived from the FILE (OkHttpExtensions.kt -> OkHttpExtensionsKt), so naming a
# specific *Kt facade is fragile — a file rename silently strips public API from
# the consumer's R8 pass. Wildcard the package instead.
# ---------------------------------------------------------------------------
-keep class dev.everframe.okhttp.** { *; }

# ---------------------------------------------------------------------------
# Sensitive marker — public Modifier.txSensitive extension
# (TxSensitiveModifier.kt -> TxSensitiveModifierKt), TX_SENSITIVE_KEY, and the
# open TXSensitiveView consumers subclass. Wildcard for the same rename-drift
# reason as above.
# ---------------------------------------------------------------------------
-keep class dev.everframe.sensitive.** { *; }

# ---------------------------------------------------------------------------
# Companion (phone-companion reporter) — RN bridge in EverframeModule.kt
# references these classes by FQN. Keep so cross-package autolinking works.
# ---------------------------------------------------------------------------
-keep class dev.everframe.companion.Companion { *; }
-keep class dev.everframe.companion.CompanionState { *; }
-keep class dev.everframe.companion.CompanionState$* { *; }
-keep class dev.everframe.companion.RelayWSClient { *; }
-keep class dev.everframe.companion.RelayWSClient$* { *; }
-keep class dev.everframe.companion.CompanionCaptureBridge { *; }
# Nested types — AssembledPayload, SubmitResult (sealed + Ok/Err) consumed
# by the RN bridge's provider lambdas.
-keep class dev.everframe.companion.CompanionCaptureBridge$* { *; }
-keep class dev.everframe.companion.CompanionSubmissionComposer { *; }
-keep class dev.everframe.companion.CompanionSubmissionComposer$* { *; }
# Task 11 — PreviewCapture is CompanionCaptureBridge.__previewProvider's
# return type; a TOP-LEVEL class (CompanionPreviewSession.kt), not a nested
# type of CompanionCaptureBridge, so it needs its own entry. Consumed by the
# RN bridge's preview-provider lambda (Task 11b, :sdk-react-native).
-keep class dev.everframe.companion.PreviewCapture { *; }
# Task 6 (naming spec 2026-08-24) — CompanionBadge's __activityProvider seam
# is installed by FQN from the RN bridge (EverframeModule.startCompanion/
# stopCompanion), same reasoning as CompanionCaptureBridge above: an
# unrenamed reference from OUTSIDE this AAR needs its own explicit keep,
# package wildcards don't cover cross-module FQN lookups. Mirrors the removed
# CompanionSharingIndicator's identical keep entry (see git history).
-keep class dev.everframe.companion.CompanionBadge { *; }
-keep class dev.everframe.companion.CompanionBadge$* { *; }
# External review, finding N1 (High) — mirrors the identical addition in
# ../proguard-rules.pro (see that file for the full rationale). This copy
# drives the CONSUMER app's own R8 pass: `EverframeModule.kt` constructs
# `CompanionBadgeOptions(enabled=..., position=...)` directly, and `position`
# comes from calling core's `parseCompanionBadgePosition()` helper (moved
# into core by finding N3), whose return type embeds `CompanionBadgePosition`
# in the RN module's compiled call even with no local of that type declared.
-keep class dev.everframe.companion.CompanionBadgeOptions { *; }
-keep class dev.everframe.companion.CompanionBadgePosition { *; }
# External review, finding N1 (High) — `EverframeModule.kt`'s deviceProvider
# closure (`startCompanion()`) calls `CompanionDeviceFacts.current(...)`
# directly by FQN. Same cross-AAR reasoning as CompanionCaptureBridge/
# CompanionBadge above.
-keep class dev.everframe.companion.CompanionDeviceFacts { *; }
# Finding N3's fix moved `parseCompanionBadgePosition` (a top-level function
# in CompanionBadge.kt, compiled to the synthetic `CompanionBadgeKt` class)
# out of `EverframeModule.kt` and into core so both the RN bridge and the
# core facade's own native-host companion start path (`Everframe.startCompanion`)
# share one copy. `EverframeModule.kt` now calls it by FQN — same cross-AAR
# reasoning as every other entry in this section. Mirrors ../proguard-rules.pro;
# see that file for how omitting this was actually caught (a real RN-module
# compile against the R8'd release AAR).
-keep class dev.everframe.companion.CompanionBadgeKt { *; }
# Attach-PIN challenge (spec 2026-08-19) — `Companion.attachChallenge:
# StateFlow<AttachChallengeInfo?>` is public, and :everframe-reporter-ui's
# `CompanionPinPresenter` references `AttachChallengeInfo` by name
# (`present(challenge: AttachChallengeInfo)`); AGP applies this file's rules
# to reporter-ui's OWN R8 pass too, since it depends on :everframe-core as a
# library. Without this, reporter-ui's release build fails with "Missing
# class dev.everframe.companion.AttachChallengeInfo (referenced from: ...
# CompanionPinPresenter$present$1.$challenge ...)" — same failure shape as
# `TXCapturedUser` above. `AttachPinUi` is kept for the same "RN bridge refs
# by FQN" reason as the rest of this section — `EverframeModule.kt` now
# imports it directly.
-keep class dev.everframe.companion.AttachChallengeInfo { *; }
-keep class dev.everframe.companion.AttachPinUi { *; }

# ---------------------------------------------------------------------------
# Capture entry points used by the RN bridge.
# ---------------------------------------------------------------------------
-keep class dev.everframe.capture.UITreeCapture { *; }
-keep class dev.everframe.capture.ScreenshotCapture { *; }
-keep class dev.everframe.capture.SensitiveRectRegistry { *; }

# ---------------------------------------------------------------------------
# Crash reporter (Task 12) — EverframeModule.kt's reportCrash() calls
# dev.everframe.crash.CrashReporter.captureFacts(...) by FQN from the
# separate :sdk-react-native Gradle module. Same rationale as the Companion
# block above.
# ---------------------------------------------------------------------------
-keep class dev.everframe.crash.CrashReporter { *; }

# ---------------------------------------------------------------------------
# Public model types crossing the public boundary.
# ---------------------------------------------------------------------------
-keep class dev.everframe.envelope.NetworkLogEntry { *; }
-keep class dev.everframe.envelope.LogEntry { *; }
-keep class dev.everframe.envelope.LogLevel { *; }
-keep class dev.everframe.envelope.LogLevel$* { *; }

# ---------------------------------------------------------------------------
# kotlinx.serialization — @Serializable plugin emits Companion.serializer()
# resolved by name at runtime. Wire types live in dev.everframe.protocol.generated;
# their serializer companions must survive R8.
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

# ---------------------------------------------------------------------------
# Compose semantics walk — componentPath capture reflects on the CONSUMER's
# Compose tree (not our internals). Keep the framework-level accessor surface
# so the customer's release-mode Compose code remains walkable.
# ---------------------------------------------------------------------------
-keep @androidx.compose.runtime.Composable class **
-keepclasseswithmembers class * {
    @androidx.compose.runtime.Composable <methods>;
}
-keepclassmembers class * {
    @androidx.compose.runtime.Composable <methods>;
}
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

# ---------------------------------------------------------------------------
# Runtime annotations + signatures needed by Compose / kotlinx.serialization
# reflection across our public boundary.
# ---------------------------------------------------------------------------
-keepattributes RuntimeVisibleAnnotations
-keepattributes RuntimeInvisibleAnnotations
-keepattributes Signature
-keepattributes InnerClasses
-keepattributes EnclosingMethod
-keepattributes SourceFile,LineNumberTable

# ---------------------------------------------------------------------------
# Don't-warn list — symbolic references R8 sees that aren't resolvable at
# build time (Timber compileOnly, Tink transitive errorprone deps).
# ---------------------------------------------------------------------------
-dontwarn timber.log.**
-dontwarn timber.log.Timber
-dontwarn timber.log.Timber$Tree
-dontwarn timber.log.Timber$Forest
-dontwarn com.google.errorprone.annotations.**
-dontwarn com.google.errorprone.annotations.CanIgnoreReturnValue
-dontwarn com.google.errorprone.annotations.CheckReturnValue
-dontwarn com.google.errorprone.annotations.Immutable

# Cross-module native video privacy facade types.
-keep public interface dev.everframe.capture.video.VideoPrivacyAdapter { *; }
-keep public enum dev.everframe.capture.video.VideoPrivacyAdapter$Classification { *; }
# Production fallback identifies absent RN privacy facilities by native View ancestry.
-keepnames class com.facebook.react.** extends android.view.View
