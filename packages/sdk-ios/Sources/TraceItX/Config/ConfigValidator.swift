// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Validates a TraceItXConfig before TraceItX.shared.start(_:) installs it.
// Throws TraceItXConfigError on bad input.
//
// Endpoint scheme validation is gone: the ingest URL is no longer a public
// config field. The URL is baked at compile time via IngestEndpoint.swift
// (Release builds get https://traceitx.com; Debug builds may read the
// TRACEITX_DEV_INGEST_URL env var).
import Foundation

enum ConfigValidator {
    static func validate(_ config: TraceItXConfig) throws {
        // Per Phase 04.2 D-03: hard-fail at start() if the SDK key is missing,
        // wrong-prefix, or wrong-length. Reuses .missingAppId verbatim — the
        // appId/sdkKey rename is explicitly deferred (D-07). Length 41 = prefix
        // "txx_live_" (9) + 32-char body matching admin SdkKeysPanel emission.
        let trimmed = config.appId.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || !trimmed.hasPrefix("txx_live_") || trimmed.count != 41 {
            throw TraceItXConfigError.missingAppId
        }
        // Session Vitals (iOS spec 2026-09-05 §1) — a local sample-rate
        // override outside [0,1] (including NaN) is a caller bug, not a
        // silent clamp.
        if let rate = config.vitals.sampleRate, rate.isNaN || rate < 0 || rate > 1 {
            throw TraceItXConfigError.invalidVitalsSampleRate
        }
    }
}
