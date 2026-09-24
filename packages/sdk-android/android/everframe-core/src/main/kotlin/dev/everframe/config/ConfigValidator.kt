// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Validates a EverframeConfig before Everframe.start(...) installs it. Throws
// EverframeConfigError on bad input — synchronously, so misconfiguration fails
// at app boot (not at runtime).
//
// Endpoint scheme validation is gone: the ingest URL is no longer a public
// config field. It's baked into BuildConfig.INGEST_URL per-variant (release
// = prod, debug = EVERFRAME_DEV_INGEST_URL env). See IngestEndpoint.kt.
package dev.everframe.config

object ConfigValidator {
    fun validate(config: EverframeConfig) {
        if (config.appId.isBlank()) throw EverframeConfigError.MissingAppId
        if (config.sdkKey.isBlank()) throw EverframeConfigError.BlankSdkKey
        val rate = config.vitals.sampleRate
        if (rate != null && (rate.isNaN() || rate !in 0.0..1.0)) throw EverframeConfigError.InvalidVitalsSampleRate
    }
}
