// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Validates an EverframeConfig before Everframe.shared.start(_:) installs it.
// Throws EverframeConfigError on bad input.
//
// Endpoint scheme validation is gone: the ingest URL is no longer a public
// config field. The URL is baked at compile time via IngestEndpoint.swift
// (Release builds get https://everframe.dev; Debug builds may read the
// EVERFRAME_DEV_INGEST_URL env var).
import Foundation

enum ConfigValidator {
    static func validate(_ config: EverframeConfig) throws {
        // Per Phase 04.2 D-03: hard-fail at start() if the Everframe SDK key is missing,
        // wrong-prefix, or wrong-length; all three throw .missingSdkKey.
        // The dashboard issues evf_live_ keys; older txx_live_ keys remain valid.
        // Both prefixes are 9 chars followed by a 32-char body (length 41).
        let trimmed = config.sdkKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.count != 41 ||
            !(trimmed.hasPrefix("evf_live_") || trimmed.hasPrefix("txx_live_")) {
            throw EverframeConfigError.missingSdkKey
        }
        // Session Vitals (iOS spec 2026-09-05 §1) — a local sample-rate
        // override outside [0,1] (including NaN) is a caller bug, not a
        // silent clamp.
        if let rate = config.vitals.sampleRate, rate.isNaN || rate < 0 || rate > 1 {
            throw EverframeConfigError.invalidVitalsSampleRate
        }
    }
}
