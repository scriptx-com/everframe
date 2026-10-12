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
        #expect(RedactionEngine().redact("token%3D\(jwe)") == "token%3D[REDACTED:jwt]")
        #expect(RedactionEngine().redact("x_\(jwe)") == "x_[REDACTED:jwt]")
    }

    /// A JWE glued to the text before it has no JSON payload to mark it: the five-segment shape does.
    @Test(arguments: ["token%3D", "session", "x_"])
    func redact_replacesGluedJWE(prefix: String) {
        let jwe = "eyJhbGciOiJSU0EtT0FFUCIsImVuYyI6IkEyNTZHQ00ifQ.OKOawDo13gRp2ojaHV7LFpZcgV7T6DVZKTyKOMTYUmKoTCVJRgckCL9kiMT03JGeipsEdY3mx_etLbbWSrFr05kLzc.48V1_ALb6US04U3b.5eym8TW_c8SuK0ltJ3rpYIzOeDQz7TALvtu6UG9oMo4.XFBoMYUZodetZdvTiFvSkQ"
        #expect(RedactionEngine().redact(prefix + jwe) == prefix + "[REDACTED:jwt]")
    }

    /// A JSON header with whitespace: `{ ` → eyA, `{\n` → ewo, `{\t` → ewk, `{\r` → ew0.
    @Test(arguments: ["{ \"alg\": \"HS256\" }", "{\n  \"alg\": \"HS256\"\n}", "{\t\"alg\":\"HS256\"}", "{\r\n\"alg\":\"HS256\"}"])
    func redact_replacesSpacedHeaderJWT(header: String) {
        func b64(_ text: String) -> String {
            Data(text.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        }
        let token = "\(b64(header)).\(b64(#"{"sub":"1234567890"}"#)).SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
        #expect(RedactionEngine().redact("token \(token)") == "token [REDACTED:jwt]")
        #expect(RedactionEngine().redact("id%3D\(token)") == "id%3D[REDACTED:jwt]")
    }

    /// The decode check keeps dotted names that start like an encoded `{`, however long their segments.
    @Test(arguments: ["ewok.something.else", "eyAudit.Foo.Bar", "com.example.ewokFactory.create(EwokFactory.swift:7)",
                      "ewokFactory.createInstance.something", "com.example.SurveyJobScheduler.internal.coroutines.dispatcher.something",
                      "version 1.2.3.4567890"])
    func redact_keepsNamesThatStartLikeAJSONHeader(name: String) {
        #expect(RedactionEngine().redact(name) == name)
    }

    /// One reference implementation (TS) wrote the expected output for every case; this scanner must match it.
    @Test func jwtScan_matchesTheSharedCorpus() throws {
        struct Corpus: Decodable { struct Case: Decodable { let name: String; let input: String; let expected: String }
            let replacement: String; let cases: [Case] }
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("protocol/__tests__/fixtures/jwt-redaction-corpus.v1.json")
        let corpus = try JSONDecoder().decode(Corpus.self, from: Data(contentsOf: url))
        #expect(corpus.cases.count > 400)
        for entry in corpus.cases {
            #expect(JwtScan.replace(in: entry.input, with: corpus.replacement) == entry.expected, "\(entry.name)")
        }
    }

    @Test func jwtScan_staysLinearOnHostileMegabytes() {
        let compact = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
        let longAlgLast = Data("{\"kid\":\"\(String(repeating: "k", count: 3_000))\",\"alg\":\"HS256\"}".utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        for value in [String(repeating: "eyJ-", count: 262_144), String(repeating: "a.", count: 524_288),
                      String(repeating: "abcdefgh.ab.c ", count: 74_899),
                      String(repeating: String(repeating: "e30", count: 370) + ".e30.x ", count: 940),
                      String(repeating: String(repeating: "Zm9vYmFy", count: 140) + ".YmF6.cXV4 ", count: 925),
                      String(repeating: String(repeating: "x", count: 64) + "e30e30e30e30.e30. ", count: 12_337),
                      String(repeating: "\(compact).e30.sig ", count: 23_000),
                      String(repeating: String(repeating: "eyJi", count: 250) + ".e30.x ", count: 1_000),
                      String(repeating: "eyJi", count: 262_144) + ".e30.x",
                      String(repeating: longAlgLast + ".e30.sig ", count: 250)] {
            #expect(value.utf16.count >= 1_000_000)
            let started = Date()
            _ = RedactionEngine().redact(value)
            #expect(Date().timeIntervalSince(started) < 10, "a megabyte took \(Date().timeIntervalSince(started)) s")
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

    @Test func configValidator_throwsOnMissingSdkKey() {
        let cfg = EverframeConfig(sdkKey: "")
        #expect(throws: EverframeConfigError.self) {
            try ConfigValidator.validate(cfg)
        }
    }

    @Test func configValidator_throwsOnHTTPEndpoint() {
        let cfg = EverframeConfig(sdkKey: "ok")
        #expect(throws: EverframeConfigError.self) {
            try ConfigValidator.validate(cfg)
        }
    }

    @Test func configValidator_acceptsHTTPSEndpoint() {
        // 41-char txx_live_… key, matching the strict predicate in
        // ConfigValidator (Phase 04.2 D-03).
        let cfg = EverframeConfig(
            sdkKey: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"
        )
        #expect(throws: Never.self) {
            try ConfigValidator.validate(cfg)
        }
    }
}
