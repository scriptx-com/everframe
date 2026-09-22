// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Validates a TraceItXConfig before TraceItX.start(...) installs it. Throws
// TraceItXConfigError on bad input — synchronously, so misconfiguration fails
// at app boot (not at runtime).
//
// Endpoint scheme validation is gone: the ingest URL is no longer a public
// config field. It's baked into BuildConfig.INGEST_URL per-variant (release
// = prod, debug = TRACEITX_DEV_INGEST_URL env). See IngestEndpoint.kt.
package com.traceitx.config

object ConfigValidator {
    fun validate(config: TraceItXConfig) {
        if (config.appId.isBlank()) throw TraceItXConfigError.MissingAppId
        if (config.sdkKey.isBlank()) throw TraceItXConfigError.BlankSdkKey
        val rate = config.vitals.sampleRate
        if (rate != null && (rate.isNaN() || rate !in 0.0..1.0)) throw TraceItXConfigError.InvalidVitalsSampleRate
    }
}
