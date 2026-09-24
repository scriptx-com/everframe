// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// RED-phase tests for the default-deny RedactionEngine + SharedData loader +
// ConfigValidator. Mirrors the JS sdk-core engine.ts behavior contract per
// CONTEXT decision 4 (data is shared via packages/protocol/data, logic is
// reimplemented per language).
import Testing
import Foundation
@testable import EverframeKit

struct RedactionEngineTests {
    // MARK: - SharedData

    @Test func sharedData_loadsRedactionPatterns() {
        let patterns = SharedData.redactionPatterns
        #expect(patterns.count >= 3)
        let ids = Set(patterns.map(\.id))
        #expect(ids.contains("jwt"))
        #expect(ids.contains("bearer"))
        #expect(ids.contains("luhn-cc"))
    }

    @Test func sharedData_loadsSensitiveHeadersLowercased() {
        #expect(SharedData.sensitiveHeadersToRedact.contains("authorization"))
        #expect(SharedData.sensitiveHeadersToRedact.contains("cookie"))
    }

    @Test func sharedData_loadsAllowedHeadersLowercased() {
        #expect(SharedData.allowedHeadersToCapture.contains("content-type"))
        #expect(SharedData.allowedHeadersToCapture.contains("x-trace-id"))
    }

    // MARK: - Redaction string-level

    @Test func redact_replacesBearerToken() {
        let engine = RedactionEngine()
        let out = engine.redact("Authorization: Bearer abc.def.ghi")
        #expect(out.contains("[REDACTED:bearer]"))
        #expect(!out.contains("abc.def.ghi"))
    }

    @Test func redact_replacesJWT() {
        let engine = RedactionEngine()
        // Valid 3-segment JWT shape
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
        let out = engine.redact("token=\(jwt)")
        #expect(out.contains("[REDACTED:jwt]"))
        #expect(!out.contains(jwt))
    }

    @Test func redact_replacesLuhnValidCC() {
        let engine = RedactionEngine()
        // Visa test number 4242 4242 4242 4242 — Luhn-valid
        let out = engine.redact("card: 4242 4242 4242 4242 ok")
        #expect(out.contains("[REDACTED:luhn-cc]"))
        #expect(!out.contains("4242 4242 4242 4242"))
    }

    @Test func redact_keepsLuhnInvalidNumbers() {
        let engine = RedactionEngine()
        // 4242 0000 0000 0001 fails Luhn
        let input = "phone: 4242 0000 0000 0001"
        let out = engine.redact(input)
        #expect(out == input, "Luhn-invalid digit run should NOT be redacted, got: \(out)")
    }

    // MARK: - Header filtering (default-deny)

    @Test func filterHeaders_redactsSensitive() {
        let engine = RedactionEngine()
        let out = engine.filterHeaders(["authorization": "Bearer xyz"])
        #expect(out["authorization"] == "[REDACTED]")
    }

    @Test func filterHeaders_preservesAllowed() {
        let engine = RedactionEngine()
        let out = engine.filterHeaders(["x-trace-id": "abc"])
        #expect(out["x-trace-id"] == "abc")
    }

    @Test func filterHeaders_dropsUnknownByDefault() {
        let engine = RedactionEngine()
        let out = engine.filterHeaders(["x-custom-thing": "leaky"])
        #expect(out["x-custom-thing"] == nil)
    }

    @Test func filterHeaders_caseInsensitiveMatching() {
        let engine = RedactionEngine()
        let out = engine.filterHeaders(["Authorization": "Bearer xyz", "X-Trace-Id": "abc"])
        #expect(out["Authorization"] == "[REDACTED]")
        #expect(out["X-Trace-Id"] == "abc")
    }

    // MARK: - ConfigValidator

    @Test func configValidator_throwsOnMissingAppId() {
        let cfg = EverframeConfig(appId: "")
        #expect(throws: EverframeConfigError.self) {
            try ConfigValidator.validate(cfg)
        }
    }

    @Test func configValidator_throwsOnHTTPEndpoint() {
        let cfg = EverframeConfig(appId: "ok")
        #expect(throws: EverframeConfigError.self) {
            try ConfigValidator.validate(cfg)
        }
    }

    @Test func configValidator_acceptsHTTPSEndpoint() {
        // 41-char txx_live_… key, matching the strict predicate in
        // ConfigValidator (Phase 04.2 D-03).
        let cfg = EverframeConfig(
            appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"
        )
        #expect(throws: Never.self) {
            try ConfigValidator.validate(cfg)
        }
    }
}
