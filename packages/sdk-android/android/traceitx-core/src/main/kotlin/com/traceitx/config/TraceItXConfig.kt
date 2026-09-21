// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Public config types for TraceItX. Kotlin port of
// `packages/sdk-ios/Sources/TraceItX/Config/TraceItXConfig.swift`.
//
// Plan 05.1-02 stripped host-UX trigger config (TV keys and bubbles). Native
// mobile shake-to-report is the narrow exception; `bubble` remains a hint only.
package com.traceitx.config

// MARK: - Config

data class TraceItXConfig(
    val appId: String,
    val sdkKey: String,
    val environment: Environment = Environment.production,
    val release: String? = null,
    val capture: CaptureConfig = CaptureConfig(),
    /**
     * Hint: host wants the floating bubble trigger pattern. The SDK does NOT
     * install a bubble — host code is responsible for the UI. See
     * `android/README.md` "Triggers are host-app concern" for canonical recipes.
     * Kept as a config field so sample apps can branch on it without changing
     * the public surface again.
     */
    val bubble: Boolean = true,
    /** Compose Material You dynamic-color opt-in (UI-SPEC line 48). */
    val useDynamicColor: Boolean = false,
    /**
     * Explicit companion device-identity override (naming spec 2026-08-24) —
     * an MDM id or provisioning serial the host already knows, hashed
     * (SHA-256 → UUID shape) before it ever reaches the announce `device`
     * block; see `CompanionDeviceId.resolve`. `null` (the default) falls
     * through to the SSAID-then-stored-UUID chain.
     */
    val companionDeviceId: String? = null,
    /**
     * Companion on-screen name-badge visibility toggle (naming spec
     * 2026-08-24, controller ruling / Task 6b) — lets a host that finds the
     * badge intrusive turn it off in one line. Defaults to `true` (badge
     * shown), matching `CompanionBadgeOptions.enabled`'s own default. Flat
     * `Boolean`, not `CompanionBadgeOptions` itself — mirrors
     * [companionDeviceId] above staying a flat wire-shaped field rather
     * than a richer type. Mirrors iOS's `TraceItXConfig.companionBadgeEnabled`.
     */
    val companionBadgeEnabled: Boolean = true,
    /** Local veto for native mobile shake-to-report. Dashboard disablement always wins. */
    val shakeToReportEnabled: Boolean = true,
    /**
     * Companion on-screen name-badge corner (naming spec 2026-08-24,
     * controller ruling / Task 6b) — raw string mirroring
     * [com.traceitx.companion.CompanionBadgePosition]'s four cases
     * ('bottom-right' | 'bottom-left' | 'top-right' | 'top-left'). `null` or
     * an unrecognised value falls through to `BOTTOM_RIGHT` — see
     * `TraceItXModule.parseCompanionBadgePosition`. Mirrors iOS's
     * `TraceItXConfig.companionBadgePosition`.
     */
    val companionBadgePosition: String? = null,
    /**
     * Inline reporter theme (branding spec 2026-08-26) — 8 semantic color
     * roles, #rrggbb strings only, exact web names. Applies ONLY once the
     * server confirms a paid plan (the /api/config branding block says
     * watermark: false); per-field precedence is server theme → this inline
     * theme → BrandTokens default. Invalid values are ignored per-field.
     * The RN bridge (stacked PR 3) maps its flattened theme fields onto this.
     */
    val theme: ReporterThemeOptions? = null,
    /**
     * Install-identifier client control (MAI meter spec 2026-08-27). ON by
     * default: the SDK sends a value derived from a locally-minted,
     * non-secret per-install seed at most once a day, so distinct installs
     * can be counted toward your plan. Nothing about the person using the
     * app is derived or stored, and the seed itself never leaves the device.
     *
     * CLIENT VETO only — `false` turns it off locally from that point on; it
     * can never force it on. Flat `Boolean` rather than web's nested
     * `{ disabled }`, matching this platform's existing veto idiom
     * ([CaptureConfig.networkBodies], [companionBadgeEnabled]). Mirrors iOS's
     * `TraceItXConfig.installIdentifierEnabled`.
     *
     * NOT retroactive and NOT org-wide: installs already recorded earlier in
     * the calendar month stay counted, and the number shown is per
     * ORGANIZATION — another app in the same org that still sends one keeps
     * contributing.
     */
    val installIdentifierEnabled: Boolean = true,
    /**
     * Session Vitals (spec 2026-09-05 §1). `enabled = null` defers to the
     * server's per-app toggle; `false` opts out locally. Local config can only
     * opt OUT or LOWER the rate — never override a server that says off.
     */
    val vitals: VitalsConfig = VitalsConfig(),
    /**
     * Public identity of the R8 mapping used for this exact optimized build.
     * The crash path validates the wire grammar and omits invalid values.
     */
    val r8MappingId: String? = null,
)

/**
 * The 8 semantic theme roles (branding spec 2026-08-26). Names mirror the
 * wire contract and web's ReporterTheme exactly.
 */
data class ReporterThemeOptions(
    val background: String? = null,
    val surface: String? = null,
    val border: String? = null,
    val text: String? = null,
    val textMuted: String? = null,
    val accent: String? = null,
    val accentForeground: String? = null,
    val destructive: String? = null,
)

data class VitalsConfig(
    val enabled: Boolean? = null,
    /** Must be in [0, 1]; min()'d with the server rate. null = server rate. */
    val sampleRate: Double? = null,
    /** Keep query strings on `source_change.src`. Off: signed CDN URLs carry tokens. */
    val captureSourceQuery: Boolean = false,
)

enum class Environment {
    development,
    staging,
    production,
}

// MARK: - Capture config

data class CaptureConfig(
    val screenshot: Boolean = true,
    val focus: Boolean = true,
    val logs: Boolean = true,
    val network: Boolean = false,
    /** Automatic crash reporting (spec 2026-07-18). Default ON — deliberate
     *  contrast with `network` (the payload is already-captured, redacted data;
     *  what changes is that reports ship without user action). */
    val crash: Boolean = true,
    val ringBufferCapacity: Int = 250,
    /**
     * Client veto for network-body capture (network-body-capture spec).
     * Veto-only semantics: `false` always wins and disables body capture
     * even when the server config says ON. The reverse is never true —
     * `true` (the default) does NOT force capture ON; the server block's
     * `captureBodies` + sampling still gate it (see
     * [com.traceitx.capture.NetworkBodyCaptureState]).
     */
    val networkBodies: Boolean = true,
) {
    companion object {
        @JvmField
        val defaults = CaptureConfig()
    }
}

// MARK: - User

/**
 * Host-declared user for self-declared recognition (spec 2026-08-12).
 *
 * `id` is nullable to match iOS's `TXUser` and sdk-core's `UserMetadata`. The
 * server's keying rule falls back to `email` when `id` is absent, so a
 * required `id` here would have made the email-only path — the common case for
 * apps with no backend — silently unsupported on Android alone.
 */
data class TXUser(
    val id: String? = null,
    val email: String? = null,
    val displayName: String? = null,
)

// MARK: - Result

sealed class ReportResult {
    data class Submitted(val reportId: java.util.UUID) : ReportResult()
    data class Queued(val reportId: java.util.UUID) : ReportResult()
    data class Cancelled(val reason: String) : ReportResult()
}

// MARK: - Errors

sealed class TraceItXConfigError(message: String) : Exception(message) {
    object MissingAppId : TraceItXConfigError("appId is blank")
    object BlankSdkKey : TraceItXConfigError("sdkKey is blank")
    object InvalidVitalsSampleRate : TraceItXConfigError("vitals.sampleRate must be within 0.0..1.0")
}

// `TraceItXTransportError` lives at `com.traceitx.transport.TraceItXTransportError`
// (Plan 05-05 canonical home). Plan 05-02 declared a placeholder here; Plan 05-05
// relocated it per its `files_modified` path and added `RetryPolicyError` plus an
// extended `ServerError(statusCode, responseBody)` shape that the submitter needs.

sealed class TraceItXEnvelopeError(message: String) : Exception(message) {
    data class PayloadTooLarge(val bytes: Int, val limit: Int) :
        TraceItXEnvelopeError("envelope $bytes bytes exceeds 25 MB cap (PIPE-03)")
}
