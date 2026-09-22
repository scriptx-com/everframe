# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
#
# traceitx-core LIBRARY-level R8/proguard rules. Applied to this module's own
# R8 pass when `isMinifyEnabled = true` on the release variant (see
# build.gradle.kts).
#
# Policy: shrink + obfuscate. Internal helpers, ring buffer impls, redaction
# engine, capture internals, transport details — all renamed to short ids in
# the published AAR. Only the documented public API surface + the cross-module
# API that `:traceitx-reporter-ui` references in core + kotlinx.serialization-
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
# Public API surface — kept here so :traceitx-reporter-ui's R8 pass can
# resolve references against the published core AAR. Anything reporter-ui
# imports from core MUST be listed (verified via grep over reporter-ui's
# `import com.traceitx.*` lines, 2026-05-22).
# ---------------------------------------------------------------------------

# Top-level singleton + nested types.
-keep class com.traceitx.TraceItX { *; }
-keep class com.traceitx.TraceItX$* { *; }
-keep class com.traceitx.ReportAPI { *; }
-keep class com.traceitx.ReportAPI$* { *; }
-keep class com.traceitx.SensitiveAPI { *; }

# Native handled-error options are constructed by Kotlin and Java callers.
# Keep the data class's generated constructors/accessors/copy members and the
# public enum constants through both the library and consumer R8 passes.
-keep class com.traceitx.CaptureExceptionOptions { *; }
-keep enum com.traceitx.ErrorSeverity { *; }

# TXScreen() navigation-marker composable (TXScreen.kt -> TXScreenKt facade).
-keep class com.traceitx.TXScreenKt { *; }

# Public config / result / error.
-keep class com.traceitx.config.TraceItXConfig { *; }
-keep class com.traceitx.config.CaptureConfig { *; }
-keep class com.traceitx.config.CaptureConfig$Companion { *; }
-keep class com.traceitx.config.Environment { *; }
-keep class com.traceitx.config.TXUser { *; }

# Branding (spec 2026-08-26): cross-module types read by traceitx-reporter-ui
# at runtime — TraceItXConfig.theme's ReporterThemeOptions payload; the
# BrandingServerConfigSignal / BrandingInlineTheme StateFlow-holding singletons
# ProvideReporterTheme (com.traceitx.ui.theme) collects from directly; the
# BrandingConfigWire / BrandingThemeWire shapes that server signal carries;
# and BrandingKt, the top-level-function facade for shouldShowWatermark(),
# which ReporterRoot.kt calls by name (TXScreenKt above is the precedent for
# keeping a top-level-function facade). Missing any of these fails
# :traceitx-reporter-ui's own R8 pass with "Missing class com.traceitx.config
# .<Type>" the same way TXCapturedUser did below before it was added here.
-keep class com.traceitx.config.ReporterThemeOptions { *; }
-keep class com.traceitx.config.BrandingConfigWire { *; }
-keep class com.traceitx.config.BrandingThemeWire { *; }
-keep class com.traceitx.config.BrandingServerConfigSignal { *; }
-keep class com.traceitx.config.BrandingInlineTheme { *; }
-keep class com.traceitx.config.BrandingKt { *; }

# Session Vitals (Android spec 2026-09-05) — the customer-facing surface of
# the vitals feature. `TraceItXConfig.vitals` carries a `VitalsConfig`; the
# `PlayerIntegration` / `PlayerIntegrationContext` / `PlayerHandle` /
# `PlayerSnapshot` / `StartupTimings` types are the seam a customer (or
# `:traceitx-media3`, which is compiled SEPARATELY against the published core
# AAR) implements and passes to `TraceItX.trackPlayer(integration, name)`;
# `PlayerEventTypes` is the string vocabulary an integration emits with. Same
# reasoning as the branding block above: a keep on `TraceItX` does not cascade
# to the parameter/return types in its members' signatures, so without these
# the media3 module's own R8 pass — and any customer integration — fails to
# resolve them against a minified core AAR.
-keep class com.traceitx.config.VitalsConfig { *; }
-keep class com.traceitx.vitals.PlayerIntegration { *; }
-keep class com.traceitx.vitals.PlayerIntegrationContext { *; }
-keep class com.traceitx.vitals.PlayerHandle { *; }
-keep class com.traceitx.vitals.PlayerSnapshot { *; }
-keep class com.traceitx.vitals.StartupTimings { *; }
-keep class com.traceitx.vitals.wire.PlayerEventTypes { *; }
# Verified by running `:traceitx-media3:assembleRelease` against the minified
# core AAR: without the three entries below, media3's OWN R8 pass fails with
# "Missing class com.traceitx.vitals.PlayerIntegrationContext$DefaultImpls /
# SanitizeSourceKt / SanitizedSource". `PlayerIntegrationContext.emit` has
# default arguments, so kotlinc emits the call through the synthetic
# `$DefaultImpls` class — a keep on the interface does NOT cover its nested
# types. `sanitizeSource()` / `protocolForMime()` are public top-level
# functions in SanitizeSource.kt (facade class `SanitizeSourceKt`, derived
# from the FILE name — same rename-drift hazard as OkHttpExtensionsKt) and
# `SanitizedSource` is the former's return type; every integration that turns
# a stream URL into the wire's `src`/`protocol` pair calls them.
-keep class com.traceitx.vitals.PlayerIntegrationContext$* { *; }
-keep class com.traceitx.vitals.SanitizeSourceKt { *; }
-keep class com.traceitx.vitals.SanitizedSource { *; }

# RN spec 2026-09-06 — the host-fed player seam. `RemotePlayerRegistry` is
# constructed BY THE CONSUMER (the @traceitx/react-native bridge module, which
# compiles separately against the published core AAR, exactly like
# :traceitx-media3 above), so it is customer-facing surface even though nothing
# inside core names it. Without this keep, R8 renames it to a single letter and
# the bridge fails with `Unresolved reference 'RemotePlayerRegistry'` — the
# same failure mode the media3 entries above document. The `$*` entry covers
# the nested `Companion` object (`safeEpochMs`, `MAX_TOKENS`) the same way the
# `PlayerIntegrationContext$*` entry above covers `$DefaultImpls`: a keep on
# the outer class does NOT cascade to its nested types.
-keep class com.traceitx.vitals.RemotePlayerRegistry { *; }
-keep class com.traceitx.vitals.RemotePlayerRegistry$* { *; }
-keep class com.traceitx.vitals.RemotePlayerIntegration { *; }

# Self-declared user snapshot (external review, finding 1, 2026-08-12) —
# `TraceItX.captureUserSnapshot()` returns it and :traceitx-reporter-ui threads
# it through `submitBaked` into `CompanionSubmissionComposer.Inputs`, so
# reporter-ui's own R8 pass must resolve it against the published core AAR.
# Without this the reporter-ui release build fails with "Missing class
# com.traceitx.TXCapturedUser".
-keep class com.traceitx.TXCapturedUser { *; }

# Independent review, codex round 10, CRITICAL — verified identity's actual
# customer-facing type, missing from this list entirely since Task 1
# introduced it. `TraceItX.setIdentityToken(source: IdentityTokenSource?)`
# is a public method on the already-kept `TraceItX` class (line ~39 above),
# but that keep does NOT cascade to the PARAMETER type: R8 does not
# transitively keep classes referenced only in a kept member's signature,
# only the member itself. Every other release build in this branch's history
# ran against source or the debug variant (isMinifyEnabled = false), which
# is why nothing caught this — a released AAR is the ONLY build shape where
# this class can be renamed/obfuscated, and it is the ONLY build shape a
# real customer ever links against. Without this keep, `import
# com.traceitx.identity.IdentityTokenSource` in customer code (documented
# in the user-recognition contract's Android section) fails to resolve
# against the published AAR, and the entire feature is dead on that
# platform. Keeps the sealed interface and both its nested cases (`Token`,
# `Provider`) — the customer-constructed values passed to
# `setIdentityToken`. `IdentityTokenHolder` itself (and everything else in
# `com.traceitx.identity`) is deliberately NOT kept: nothing outside
# `:traceitx-core` references it by name (checked: `:traceitx-reporter-ui`'s
# main source, the RN bridge module — neither imports anything from this
# package), so it is genuinely internal and correctly renamed, matching this
# file's own "internal helpers ... all renamed" policy. Mechanically
# verified going forward, not just by inspection — see
# `.github/workflows/android.yml`'s `r8-string-survival` job, which now
# greps a real release-minified sample-app APK's DEX for this exact class
# name, so a future regression here fails CI instead of only a
# code-review.
-keep class com.traceitx.identity.IdentityTokenSource { *; }
-keep class com.traceitx.identity.IdentityTokenSource$* { *; }

# Crash-entry session snapshot (follow-ups item 6, 2026-08-13) — the sibling of
# the above and kept for the same reason: `TraceItX.captureSessionSnapshot()` is
# public and returns it, so it is part of the published surface, and follow-ups
# item 9 threads it through :traceitx-reporter-ui exactly as `TXCapturedUser` is
# threaded today. Without this, R8 renames the return type of a public method in
# a minified release and reporter-ui's own pass fails to resolve it.
# `{ *; }` does NOT re-expose the `internal` `copy()`: `@ConsistentCopyVisibility`
# makes kotlinc emit it pre-mangled as `copy$traceitx_core`, and a keep rule only
# stops R8 removing or renaming that symbol — it does not rewrite Kotlin
# @Metadata, which is what enforces visibility for Kotlin consumers. Same as
# TXCapturedUser, whose constructor has been `internal` under this same rule
# since 2026-08-12.
-keep class com.traceitx.TXCapturedSession { *; }
-keep class com.traceitx.config.ReportResult { *; }
-keep class com.traceitx.config.ReportResult$* { *; }
-keep class com.traceitx.config.TraceItXConfigError { *; }
-keep class com.traceitx.config.TraceItXConfigError$* { *; }
-keep class com.traceitx.config.TraceItXEnvelopeError { *; }
-keep class com.traceitx.config.TraceItXEnvelopeError$* { *; }
-keep class com.traceitx.config.IngestEndpoint { *; }

# Transport error.
-keep class com.traceitx.transport.TraceItXTransportError { *; }
-keep class com.traceitx.transport.TraceItXTransportError$* { *; }

# OkHttp interceptor — consumer extension entry.
# Keep the whole public package: the consumer-facing entry point is the
# top-level `addTraceItXInterceptor()` extension whose Kotlin facade class is
# derived from the FILE name (OkHttpExtensions.kt -> OkHttpExtensionsKt). Naming
# a specific facade is fragile — a file rename silently drops public API from
# the R8'd AAR (this exact drift shipped a broken AAR once). Wildcard the package.
-keep class com.traceitx.okhttp.** { *; }

# Sensitive marker surface — public Modifier.txSensitive() extension
# (TxSensitiveModifier.kt -> TxSensitiveModifierKt), TX_SENSITIVE_KEY, and the
# open TXSensitiveView consumers subclass. Wildcard for the same rename-drift
# reason as above.
-keep class com.traceitx.sensitive.** { *; }

# Companion — RN bridge refs by FQN. `Companion.attachChallenge` +
# `AttachPinUi` (spec 2026-08-19) mean reporter-ui touches this section now
# too — see the AttachChallengeInfo entry below.
-keep class com.traceitx.companion.Companion { *; }
-keep class com.traceitx.companion.CompanionState { *; }
-keep class com.traceitx.companion.CompanionState$* { *; }
-keep class com.traceitx.companion.RelayWSClient { *; }
-keep class com.traceitx.companion.RelayWSClient$* { *; }
-keep class com.traceitx.companion.CompanionCaptureBridge { *; }
-keep class com.traceitx.companion.CompanionCaptureBridge$* { *; }
-keep class com.traceitx.companion.CompanionSubmissionComposer { *; }
-keep class com.traceitx.companion.CompanionSubmissionComposer$* { *; }
# Task 11 — PreviewCapture is CompanionCaptureBridge.__previewProvider's
# return type; a TOP-LEVEL class (CompanionPreviewSession.kt), not a nested
# type of CompanionCaptureBridge, so it needs its own entry. Consumed by the
# RN bridge's preview-provider lambda (Task 11b, :sdk-react-native).
-keep class com.traceitx.companion.PreviewCapture { *; }
# Task 6 (naming spec 2026-08-24) — CompanionBadge's __activityProvider seam
# is installed by FQN from the RN bridge (TraceItXModule.startCompanion/
# stopCompanion), same reasoning as CompanionCaptureBridge above: an
# unrenamed reference from OUTSIDE this AAR needs its own explicit keep,
# package wildcards don't cover cross-module FQN lookups. Mirrors the removed
# CompanionSharingIndicator's identical keep entry (see git history).
-keep class com.traceitx.companion.CompanionBadge { *; }
-keep class com.traceitx.companion.CompanionBadge$* { *; }
# External review, finding N1 (High) — the original Task 6 keep-scoping above
# only listed `CompanionBadge`/`CompanionBadge$*`; `TraceItXModule.kt` also
# constructs `CompanionBadgeOptions(enabled=..., position=...)` directly, and
# `position` comes from calling core's `parseCompanionBadgePosition()` helper
# (moved into core by finding N3 so the facade's own native-host companion
# start path can share it) — that call's return type embeds
# `CompanionBadgePosition` in the RN module's compiled invokestatic
# descriptor even though nothing there declares a local of that type. Same
# "unrenamed reference from OUTSIDE this AAR" reasoning as CompanionBadge
# itself — package wildcards don't cover cross-module FQN construction.
-keep class com.traceitx.companion.CompanionBadgeOptions { *; }
-keep class com.traceitx.companion.CompanionBadgePosition { *; }
# External review, finding N1 (High) — `TraceItXModule.kt`'s deviceProvider
# closure (`startCompanion()`) calls `CompanionDeviceFacts.current(...)`
# directly by FQN. Same cross-AAR reasoning as CompanionCaptureBridge/
# CompanionBadge above.
-keep class com.traceitx.companion.CompanionDeviceFacts { *; }
# Finding N3's fix moved `parseCompanionBadgePosition` (a top-level function
# in CompanionBadge.kt, compiled to the synthetic `CompanionBadgeKt` class)
# out of `TraceItXModule.kt` and into core so both the RN bridge and the
# core facade's own native-host companion start path (`TraceItX.startCompanion`)
# share one copy. `TraceItXModule.kt` now calls it by FQN — same cross-AAR
# reasoning as every other entry in this section. Verified the hard way:
# omitting this keep left the RELEASE AAR's `CompanionBadgeKt` renamed while
# the RN module (compiled separately against that AAR) still called the
# original name, so `:traceitx_react-native`'s own compile failed with
# "Unresolved reference 'parseCompanionBadgePosition'" — the exact failure
# shape this whole file exists to prevent.
-keep class com.traceitx.companion.CompanionBadgeKt { *; }
# Attach-PIN challenge (spec 2026-08-19) — `Companion.attachChallenge:
# StateFlow<AttachChallengeInfo?>` is public, and :traceitx-reporter-ui's
# `CompanionPinPresenter` references `AttachChallengeInfo` by name
# (`present(challenge: AttachChallengeInfo)`), so reporter-ui's own R8 pass
# must resolve it against this module's release output — same failure shape
# as `TXCapturedUser` above ("Missing class com.traceitx.companion
# .AttachChallengeInfo (referenced from: ... CompanionPinPresenter
# $present$1.$challenge ...)" is the exact error this rule fixes). AttachPinUi
# is kept for the same "RN bridge refs by FQN" reason as the other companion
# types above — `TraceItXModule.kt` now imports it directly.
-keep class com.traceitx.companion.AttachChallengeInfo { *; }
-keep class com.traceitx.companion.AttachPinUi { *; }

# Capture entry points consumed by RN bridge + reporter-ui.
-keep class com.traceitx.capture.UITreeCapture { *; }
-keep class com.traceitx.capture.ScreenshotCapture { *; }
-keep class com.traceitx.capture.ScreenshotCapture$* { *; }
-keep class com.traceitx.capture.SensitiveRectRegistry { *; }

# Crash reporter (Task 12) — RN bridge's reportCrash() calls
# com.traceitx.crash.CrashReporter.captureFacts(...) by FQN from the
# separate :sdk-react-native module's published-AAR classpath.
-keep class com.traceitx.crash.CrashReporter { *; }

# Cross-module API used by :traceitx-reporter-ui — reporter-ui imports
# from core directly AND transitively reaches into internal helpers
# (NetworkRingBuffer, InternalLogger, MultipartUploader, ...). Since
# library R8 runs per-module and can't rename across artifacts
# consistently, the whole reachable surface must stay readable in the
# AAR. The CONSUMER's R8 pass (sees both AARs at once) still renames
# these consistently — see consumer-rules.pro for that tighter keep
# list. Net result: published AAR exposes internal-package names, but
# the deployed customer APK obfuscates them.
-keep class com.traceitx.capture.** { *; }
-keep class com.traceitx.envelope.** { *; }
-keep class com.traceitx.outbox.** { *; }
-keep class com.traceitx.transport.** { *; }

# Public model types.
-keep class com.traceitx.envelope.NetworkLogEntry { *; }
-keep class com.traceitx.envelope.LogEntry { *; }
-keep class com.traceitx.envelope.LogLevel { *; }
-keep class com.traceitx.envelope.LogLevel$* { *; }

# Kotlin data-class Companion accessors for public-API packages — without
# this, `Foo.Companion` references resolve to a renamed inner class and
# fail at link time.
-keepclassmembers class com.traceitx.config.** {
    public static **$Companion Companion;
}
-keepclassmembers class com.traceitx.transport.** {
    public static **$Companion Companion;
}
-keepclassmembers class com.traceitx.companion.** {
    public static **$Companion Companion;
}

# ---------------------------------------------------------------------------
# kotlinx.serialization — @Serializable plugin emits Companion.serializer()
# resolved by name at runtime. Wire types live in
# com.traceitx.protocol.generated; their companions must survive R8.
# ---------------------------------------------------------------------------
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt

-keep,allowobfuscation,allowshrinking class * extends kotlinx.serialization.KSerializer
-keep,allowobfuscation,allowshrinking class * implements kotlinx.serialization.KSerializer

-keepclassmembers class com.traceitx.protocol.generated.** {
    public static *** Companion;
}
-keepclassmembers class com.traceitx.protocol.generated.**$Companion {
    public *** serializer(...);
}
# Polymorphic discriminator metadata for RelayMessage / its sealed subtypes —
# JsonClassDiscriminator depends on @SerialName values surviving R8.
-keep,includedescriptorclasses class com.traceitx.protocol.generated.** {
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
-keep public interface com.traceitx.capture.video.VideoPrivacyAdapter { *; }
-keep public enum com.traceitx.capture.video.VideoPrivacyAdapter$Classification { *; }
# Production fallback identifies absent RN privacy facilities by native View ancestry.
-keepnames class com.facebook.react.** extends android.view.View
