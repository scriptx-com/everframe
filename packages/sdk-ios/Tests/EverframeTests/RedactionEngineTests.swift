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

    /// Stack frames are what a crash report is for: the JWT rule must never eat dotted names.
    @Test(arguments: [
        "MyAppModule.CheckoutViewModel.submitOrder(_:) + 120",
        "EverframeTests.HandledErrorCaptureTests.testNativeUnderlyingErrorTextIsRedactedBeforePersistence",
        "dev.everframe.crashdefault.MainActivity.onCreate",
        "kotlinx.coroutines.internal.DispatchedContinuation",
        "SurveyKit.SurveyJobScheduler.scheduleNextRun.invokeSuspend",
        "SurveyKit.SurveyJobScheduler.scheduleNextRun(_:)",
        "com.example.survey.SurveyJobScheduler$schedule$1.invokeSuspend$lambda$0(SurveyJobScheduler.kt:30)",
        "com.example.app.extension",
        "-[SurveyJobScheduler scheduleWithCompletion:]",
        "$s9SurveyKit18SurveyJobSchedulerC8scheduleyyFTf4n_g",
        "SurveyKit`specialized SurveyJobScheduler.schedule(with:) + 1184",
    ])
    func redact_keepsDottedModuleAndTypeNames(name: String) {
        #expect(RedactionEngine().redact(name) == name)
    }

    /// URL-encoded, glued (no word boundary: the eyJ payload marks the token) and JWE tokens.
    @Test(arguments: [
        ("state%3D", "&x=1"), ("%22", "%22"), ("Bearer%20", ""), ("x_", ""), ("_", ""), (#"{"line":"auth\n"#, #""}"#),
    ])
    func redact_replacesGluedJWT(prefix: String, suffix: String) {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwZXJzb24ifQ.SflKxwRJSMeKKF2QT4fw"
        #expect(RedactionEngine().redact(prefix + jwt + suffix) == prefix + "[REDACTED:jwt]" + suffix)
    }

    @Test func redact_replacesDirJWE() {
        let jwe = "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..48V1_ALb6US04U3b.5eym8TW_c8SuK0ltJ3rpYIzOeDQz7TALvtu6UG9oMo4.XFBoMYUZodetZdvTiFvSkQ"
        #expect(RedactionEngine().redact("token=\(jwe)&next=1") == "token=[REDACTED:jwt]&next=1")
    }

    /// JwtScan gives exactly the plain regex result, and stays linear where the plain scan is quadratic.
    @Test func jwtScan_matchesThePlainRegexAndStaysLinear() throws {
        let rule = try #require(SharedData.redactionPatterns.first { $0.id == "jwt" })
        let regex = try NSRegularExpression(pattern: rule.regex)
        var seed: UInt32 = 0x2545f491
        func random(_ n: Int) -> Int { seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5; return Int(seed % UInt32(n)) }
        let alphabet = Array("aZ09_-eyJ")
        let glue = ["", " ", "_", "-", "x", "%3D", "é", #"\n"#, ".", "="]
        var redacted = 0
        for _ in 0..<2_000 {
            var value = ""
            for _ in 0...random(3) {
                value += glue[random(glue.count)]
                value += (0...random(6)).map { _ in
                    (random(2) == 0 ? "eyJ" : "") + String((0..<random(13)).map { _ in alphabet[random(alphabet.count)] })
                }.joined(separator: ".")
            }
            let expected = regex.stringByReplacingMatches(in: value, range: NSRange(value.startIndex..., in: value), withTemplate: "[J]")
            #expect(JwtScan.replace(regex, in: value, with: "[J]") == expected, "\(value)")
            if expected != value { redacted += 1 }
        }
        #expect(redacted > 200)
        for value in [String(repeating: "eyJ-", count: 262_144), String(repeating: "eyJabcde.eyJabcde.", count: 58_254),
                      String(repeating: "-eyJ", count: 262_143) + ".abcdefgh"] {
            let started = Date()
            _ = RedactionEngine().redact(value)
            #expect(Date().timeIntervalSince(started) < 5, "a megabyte took \(Date().timeIntervalSince(started)) s")
        }
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
