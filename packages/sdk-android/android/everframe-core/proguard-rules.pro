# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
#
# everframe-core LIBRARY-level R8/proguard rules. Applied to this module's own
# R8 pass when `isMinifyEnabled = true` on the release variant (see
# build.gradle.kts).
#
# Policy: shrink + obfuscate. Internal helpers, ring buffer impls, redaction
# engine, capture internals, transport details — all renamed to short ids in
# the published AAR. Only the documented public API surface + the cross-module
# API that `:everframe-reporter-ui` references in core + kotlinx.serialization-
# annotated wire types stay readable. Net result: an attacker downloading the
# AAR from Maven Central sees `a.b.c()` for most call sites; `apktool` /
# javap dumps don't yield readable class structure for internals.
#
# The sister `consumer-rules.pro` carries the SAME keep list. Both files exist
# because:
#   * proguard-rules.pro  — drives the LIBRARY's R8 pass at publish time
#   * consumer-rules.pro  — drives the CONSUMER app's R8 pass at their
#                           release-build time
# A symbol kept here but not in consumer-rules ships obfuscated in the AAR but
# obfuscated again in the customer APK; a symbol kept there but not here ships
# readable in the AAR. The two lists are intentionally identical for v1 so a
# downloaded AAR and a consumer APK present the same surface.

# Strip debug info. R8's default-minified config does this when minification
# is on, but we restate it explicitly so the strip survives any future
# `-keepattributes` additions that might unintentionally re-add SourceFile.
-keepattributes !SourceFile, !SourceDir, !LineNumberTable, !LocalVariableTable, !LocalVariableTypeTable

# ---------------------------------------------------------------------------
# Public API surface — kept here so :everframe-reporter-ui's R8 pass can
# resolve references against the published core AAR. Anything reporter-ui
# imports from core MUST be listed (verified via grep over reporter-ui's
# `import dev.everframe.*` lines, 2026-05-22).
# ---------------------------------------------------------------------------

# Top-level singleton + nested types.
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

# Public config / result / error.
-keep class dev.everframe.config.EverframeConfig { *; }
-keep class dev.everframe.config.CaptureConfig { *; }
-keep class dev.everframe.config.CaptureConfig$Companion { *; }
-keep class dev.everframe.config.Environment { *; }
-keep class dev.everframe.config.TXUser { *; }

# Branding (spec 2026-08-26): cross-module types read by everframe-reporter-ui
# at runtime — EverframeConfig.theme's ReporterThemeOptions payload; the
# BrandingServerConfigSignal / BrandingInlineTheme StateFlow-holding singletons
# ProvideReporterTheme (dev.everframe.ui.theme) collects from directly; the
# BrandingConfigWire / BrandingThemeWire shapes that server signal carries;
# and BrandingKt, the top-level-function facade for shouldShowWatermark(),
# which ReporterRoot.kt calls by name (TXScreenKt above is the precedent for
# keeping a top-level-function facade). Missing any of these fails
# :everframe-reporter-ui's own R8 pass with "Missing class dev.everframe.config
# .<Type>" the same way TXCapturedUser did below before it was added here.
-keep class dev.everframe.config.ReporterThemeOptions { *; }
-keep class dev.everframe.config.BrandingConfigWire { *; }
-keep class dev.everframe.config.BrandingThemeWire { *; }
-keep class dev.everframe.config.BrandingServerConfigSignal { *; }
-keep class dev.everframe.config.BrandingInlineTheme { *; }
-keep class dev.everframe.config.BrandingKt { *; }

# Session Vitals (Android spec 2026-09-05) — the customer-facing surface of
# the vitals feature. `EverframeConfig.vitals` carries a `VitalsConfig`; the
# `PlayerIntegration` / `PlayerIntegrationContext` / `PlayerHandle` /
# `PlayerSnapshot` / `StartupTimings` types are the seam a customer (or
# `:everframe-media3`, which is compiled SEPARATELY against the published core
# AAR) implements and passes to `Everframe.trackPlayer(integration, name)`;
# `PlayerEventTypes` is the string vocabulary an integration emits with. Same
# reasoning as the branding block above: a keep on `Everframe` does not cascade
# to the parameter/return types in its members' signatures, so without these
# the media3 module's own R8 pass — and any customer integration — fails to
# resolve them against a minified core AAR.
-keep class dev.everframe.config.VitalsConfig { *; }
-keep class dev.everframe.vitals.PlayerIntegration { *; }
-keep class dev.everframe.vitals.PlayerIntegrationContext { *; }
-keep class dev.everframe.vitals.PlayerHandle { *; }
-keep class dev.everframe.vitals.PlayerSnapshot { *; }
-keep class dev.everframe.vitals.StartupTimings { *; }
-keep class dev.everframe.vitals.wire.PlayerEventTypes { *; }
# Verified by running `:everframe-media3:assembleRelease` against the minified
# core AAR: without the three entries below, media3's OWN R8 pass fails with
# "Missing class dev.everframe.vitals.PlayerIntegrationContext$DefaultImpls /
# SanitizeSourceKt / SanitizedSource". `PlayerIntegrationContext.emit` has
# default arguments, so kotlinc emits the call through the synthetic
# `$DefaultImpls` class — a keep on the interface does NOT cover its nested
# types. `sanitizeSource()` / `protocolForMime()` are public top-level
# functions in SanitizeSource.kt (facade class `SanitizeSourceKt`, derived
# from the FILE name — same rename-drift hazard as OkHttpExtensionsKt) and
# `SanitizedSource` is the former's return type; every integration that turns
# a stream URL into the wire's `src`/`protocol` pair calls them.
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

# Independent review, codex round 10, CRITICAL — verified identity's actual
# customer-facing type, missing from this list entirely since Task 1
# introduced it. `Everframe.setIdentityToken(source: IdentityTokenSource?)`
# is a public method on the already-kept `Everframe` class (line ~39 above),
# but that keep does NOT cascade to the PARAMETER type: R8 does not
# transitively keep classes referenced only in a kept member's signature,
# only the member itself. Every other release build in this branch's history
# ran against source or the debug variant (isMinifyEnabled = false), which
# is why nothing caught this — a released AAR is the ONLY build shape where
# this class can be renamed/obfuscated, and it is the ONLY build shape a
# real customer ever links against. Without this keep, `import
# dev.everframe.identity.IdentityTokenSource` in customer code (documented
# in the user-recognition contract's Android section) fails to resolve
# against the published AAR, and the entire feature is dead on that
# platform. Keeps the sealed interface and both its nested cases (`Token`,
# `Provider`) — the customer-constructed values passed to
# `setIdentityToken`. `IdentityTokenHolder` itself (and everything else in
# `dev.everframe.identity`) is deliberately NOT kept: nothing outside
# `:everframe-core` references it by name (checked: `:everframe-reporter-ui`'s
# main source, the RN bridge module — neither imports anything from this
# package), so it is genuinely internal and correctly renamed, matching this
# file's own "internal helpers ... all renamed" policy. Mechanically
# verified going forward, not just by inspection — see
# `.github/workflows/android.yml`'s `r8-string-survival` job, which now
# greps a real release-minified sample-app APK's DEX for this exact class
# name, so a future regression here fails CI instead of only a
# code-review.
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
-keep class dev.everframe.config.IngestEndpoint { *; }

# Transport error.
-keep class dev.everframe.transport.EverframeTransportError { *; }
-keep class dev.everframe.transport.EverframeTransportError$* { *; }

# OkHttp interceptor — consumer extension entry.
# Keep the whole public package: the consumer-facing entry point is the
# top-level `addEverframeInterceptor()` extension whose Kotlin facade class is
# derived from the FILE name (OkHttpExtensions.kt -> OkHttpExtensionsKt). Naming
# a specific facade is fragile — a file rename silently drops public API from
# the R8'd AAR (this exact drift shipped a broken AAR once). Wildcard the package.
-keep class dev.everframe.okhttp.** { *; }

# Sensitive marker surface — public Modifier.txSensitive() extension
# (TxSensitiveModifier.kt -> TxSensitiveModifierKt), TX_SENSITIVE_KEY, and the
# open TXSensitiveView consumers subclass. Wildcard for the same rename-drift
# reason as above.
-keep class dev.everframe.sensitive.** { *; }

# Companion — RN bridge refs by FQN. `Companion.attachChallenge` +
# `AttachPinUi` (spec 2026-08-19) mean reporter-ui touches this section now
# too — see the AttachChallengeInfo entry below.
-keep class dev.everframe.companion.Companion { *; }
-keep class dev.everframe.companion.CompanionState { *; }
-keep class dev.everframe.companion.CompanionState$* { *; }
-keep class dev.everframe.companion.RelayWSClient { *; }
-keep class dev.everframe.companion.RelayWSClient$* { *; }
-keep class dev.everframe.companion.CompanionCaptureBridge { *; }
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
# External review, finding N1 (High) — the original Task 6 keep-scoping above
# only listed `CompanionBadge`/`CompanionBadge$*`; `EverframeModule.kt` also
# constructs `CompanionBadgeOptions(enabled=..., position=...)` directly, and
# `position` comes from calling core's `parseCompanionBadgePosition()` helper
# (moved into core by finding N3 so the facade's own native-host companion
# start path can share it) — that call's return type embeds
# `CompanionBadgePosition` in the RN module's compiled invokestatic
# descriptor even though nothing there declares a local of that type. Same
# "unrenamed reference from OUTSIDE this AAR" reasoning as CompanionBadge
# itself — package wildcards don't cover cross-module FQN construction.
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
# reasoning as every other entry in this section. Verified the hard way:
# omitting this keep left the RELEASE AAR's `CompanionBadgeKt` renamed while
# the RN module (compiled separately against that AAR) still called the
# original name, so `:everframe_react-native`'s own compile failed with
# "Unresolved reference 'parseCompanionBadgePosition'" — the exact failure
# shape this whole file exists to prevent.
-keep class dev.everframe.companion.CompanionBadgeKt { *; }
# Attach-PIN challenge (spec 2026-08-19) — `Companion.attachChallenge:
# StateFlow<AttachChallengeInfo?>` is public, and :everframe-reporter-ui's
# `CompanionPinPresenter` references `AttachChallengeInfo` by name
# (`present(challenge: AttachChallengeInfo)`), so reporter-ui's own R8 pass
# must resolve it against this module's release output — same failure shape
# as `TXCapturedUser` above ("Missing class dev.everframe.companion
# .AttachChallengeInfo (referenced from: ... CompanionPinPresenter
# $present$1.$challenge ...)" is the exact error this rule fixes). AttachPinUi
# is kept for the same "RN bridge refs by FQN" reason as the other companion
# types above — `EverframeModule.kt` now imports it directly.
-keep class dev.everframe.companion.AttachChallengeInfo { *; }
-keep class dev.everframe.companion.AttachPinUi { *; }

# Capture entry points consumed by RN bridge + reporter-ui.
-keep class dev.everframe.capture.UITreeCapture { *; }
-keep class dev.everframe.capture.ScreenshotCapture { *; }
-keep class dev.everframe.capture.ScreenshotCapture$* { *; }
-keep class dev.everframe.capture.SensitiveRectRegistry { *; }

# Crash reporter (Task 12) — RN bridge's reportCrash() calls
# dev.everframe.crash.CrashReporter.captureFacts(...) by FQN from the
# separate :sdk-react-native module's published-AAR classpath.
-keep class dev.everframe.crash.CrashReporter { *; }

# Cross-module API used by :everframe-reporter-ui — reporter-ui imports
# from core directly AND transitively reaches into internal helpers
# (NetworkRingBuffer, InternalLogger, MultipartUploader, ...). Since
# library R8 runs per-module and can't rename across artifacts
# consistently, the whole reachable surface must stay readable in the
# AAR. The CONSUMER's R8 pass (sees both AARs at once) still renames
# these consistently — see consumer-rules.pro for that tighter keep
# list. Net result: published AAR exposes internal-package names, but
# the deployed customer APK obfuscates them.
-keep class dev.everframe.capture.** { *; }
-keep class dev.everframe.envelope.** { *; }
-keep class dev.everframe.outbox.** { *; }
-keep class dev.everframe.transport.** { *; }

# Public model types.
-keep class dev.everframe.envelope.NetworkLogEntry { *; }
-keep class dev.everframe.envelope.LogEntry { *; }
-keep class dev.everframe.envelope.LogLevel { *; }
-keep class dev.everframe.envelope.LogLevel$* { *; }

# Kotlin data-class Companion accessors for public-API packages — without
# this, `Foo.Companion` references resolve to a renamed inner class and
# fail at link time.
-keepclassmembers class dev.everframe.config.** {
    public static **$Companion Companion;
}
-keepclassmembers class dev.everframe.transport.** {
    public static **$Companion Companion;
}
-keepclassmembers class dev.everframe.companion.** {
    public static **$Companion Companion;
}

# ---------------------------------------------------------------------------
# kotlinx.serialization — @Serializable plugin emits Companion.serializer()
# resolved by name at runtime. Wire types live in
# dev.everframe.protocol.generated; their companions must survive R8.
# ---------------------------------------------------------------------------
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt

-keep,allowobfuscation,allowshrinking class * extends kotlinx.serialization.KSerializer
-keep,allowobfuscation,allowshrinking class * implements kotlinx.serialization.KSerializer

-keepclassmembers class dev.everframe.protocol.generated.** {
    public static *** Companion;
}
-keepclassmembers class dev.everframe.protocol.generated.**$Companion {
    public *** serializer(...);
}
# Polymorphic discriminator metadata for RelayMessage / its sealed subtypes —
# JsonClassDiscriminator depends on @SerialName values surviving R8.
-keep,includedescriptorclasses class dev.everframe.protocol.generated.** {
    *;
}

# ---------------------------------------------------------------------------
# Kotlin metadata for the public-API surface — Java callers + IDE
# autocomplete need it to see typed signatures instead of `Object`-typed
# returns. R8 strips Kotlin metadata on un-kept classes by default, which
# is fine: internals don't expose Kotlin types.
# ---------------------------------------------------------------------------
-keep class kotlin.Metadata { *; }

# ---------------------------------------------------------------------------
# Don't-warn list — symbolic references R8 sees that aren't resolvable at
# build time (Timber compileOnly, Tink transitive errorprone deps, Java 9+
# StringConcatFactory desugared at consume time).
# ---------------------------------------------------------------------------
-dontwarn timber.log.**
-dontwarn com.google.errorprone.annotations.**
-dontwarn kotlinx.serialization.**
-dontwarn org.jetbrains.annotations.**
-dontwarn java.lang.invoke.StringConcatFactory

# Cross-module native video privacy facade types.
-keep public interface dev.everframe.capture.video.VideoPrivacyAdapter { *; }
-keep public enum dev.everframe.capture.video.VideoPrivacyAdapter$Classification { *; }
# Production fallback identifies absent RN privacy facilities by native View ancestry.
-keepnames class com.facebook.react.** extends android.view.View
