// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Crash/error-reporting cross-SDK fixture parity — Swift side of the
// three-decoder gate (Task 14, mirrors CrossSDKProto02Tests.swift exactly).
// The shared `crash-report.json` is decoded by the regenerated quicktype
// `ReportEnvelope` (Task 1 added `source` + `payload.crash`), re-encoded
// with sorted keys, and the canonical bytes are checked against a second
// decode -> re-encode pass for idempotence. Also spot-checks that
// `source`/`payload.crash` decode into the typed generated fields.
//
// fixture-sync.spec.ts (TS) guards this file's physical copy of
// crash-report.json against drift from the canonical
// packages/protocol/__tests__/fixtures/crash-report.json.

import Testing
@testable import TraceItXProtocol
import Foundation

struct CrashReportCrossSDKTests {
    @Test func hermesIdentityRoundTripsExactly() throws {
        let data = try Data(contentsOf: Bundle.module.url(forResource: "crash-report-hermes", withExtension: "json")!)
        let env = try Self.canonicalDecoder().decode(ReportEnvelope.self, from: data)
        #expect(env.payload.crash?.jsBundle?.buildID == " js-7 ")
        let encoded = try Self.canonicalEncoder().encode(env)
        let decoded = try Self.canonicalDecoder().decode(ReportEnvelope.self, from: encoded)
        #expect(decoded.payload.crash?.jsBundle?.platform == .android)
        #expect(decoded.payload.crash?.jsBundle?.bundleName == "index.android.bundle")
        #expect(try Self.canonicalEncoder().encode(decoded) == encoded)
    }


    // NOTE: crash-report.json's `submittedAt`/`occurredAt` carry millisecond
    // precision (matching JS `Date.toISOString()`), which plain `.iso8601`
    // (default-options `ISO8601DateFormatter`, no fractional seconds) cannot
    // parse. Same fix as CrossSDKProto02Tests.swift / ProtocolRoundTripTests.swift
    // (Task 14) — see those files' notes for the full pre-existing-bug story.
    private static func canonicalEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .custom { date, enc in
            var container = enc.singleValueContainer()
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            try container.encode(formatter.string(from: date))
        }
        return encoder
    }

    private static func canonicalDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { dec in
            let container = try dec.singleValueContainer()
            let string = try container.decode(String.self)
            let withFractional = ISO8601DateFormatter()
            withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = withFractional.date(from: string) { return date }
            let plain = ISO8601DateFormatter()
            if let date = plain.date(from: string) { return date }
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "Expected ISO8601 date string, got \(string)")
        }
        return decoder
    }

    private static func fixtureData() throws -> Data {
        let url = Bundle.module.url(
            forResource: "crash-report",
            withExtension: "json"
        )!
        return try Data(contentsOf: url)
    }

    private static func jvmFixtureData() throws -> Data {
        let url = Bundle.module.url(
            forResource: "jvm-crash-envelope",
            withExtension: "json"
        )!
        return try Data(contentsOf: url)
    }

    private static func causeFixtureData() throws -> Data {
        let url = Bundle.module.url(
            forResource: "crash-causes",
            withExtension: "json"
        )!
        return try Data(contentsOf: url)
    }

    /// Round-trip the crash-report cross-SDK fixture: decode via the
    /// regenerated `ReportEnvelope`, re-encode canonically, decode the
    /// canonical bytes, re-encode — the two canonical encodings MUST be
    /// byte-identical.
    @Test func crashReportFixture_decodesAndReencodesIdempotently() throws {
        let data = try Self.fixtureData()
        let decoder = Self.canonicalDecoder()
        let encoder = Self.canonicalEncoder()

        let env = try decoder.decode(ReportEnvelope.self, from: data)
        let firstBytes = try encoder.encode(env)
        let env2 = try decoder.decode(ReportEnvelope.self, from: firstBytes)
        let secondBytes = try encoder.encode(env2)

        #expect(firstBytes == secondBytes)
    }

    /// `source` and `payload.crash` MUST decode into the typed generated
    /// fields (not just survive as untyped JSON) — proves the Task 1
    /// codegen regeneration wired both into the generated types.
    @Test func crashReportFixture_decodesSourceAndPayloadCrash() throws {
        let data = try Self.fixtureData()
        let decoder = Self.canonicalDecoder()

        let env = try decoder.decode(ReportEnvelope.self, from: data)
        #expect(env.source == .crash)

        let crash = try #require(env.payload.crash)
        #expect(crash.exceptionType == "java.lang.NullPointerException")
        #expect(crash.fingerprint.count == 16)
        #expect(crash.handled == false)
    }

    @Test func jvmCrashFixture_preservesOrderedCausesAndMappingIdentity() throws {
        let env = try Self.canonicalDecoder().decode(ReportEnvelope.self, from: Self.jvmFixtureData())
        let crash = try #require(env.payload.crash)
        #expect(env.context.app.build == "42")
        #expect(crash.jsBundle == nil)

        let jvm = try #require(crash.jvm)
        #expect(jvm.mappingID == "android-release-ci-123")
        #expect(jvm.causesTruncated == false)
        #expect(jvm.causes.count == 2)
        #expect(jvm.causes[0].exceptionType == "java.lang.IllegalArgumentException")
        #expect(jvm.causes[0].message == "middle failure")
        #expect(jvm.causes[0].frames[0].raw == "sample.Middle.run(Middle.kt:11)")
        #expect(jvm.causes[0].frames[0].function == "run")
        #expect(jvm.causes[0].framesTruncated == false)
        #expect(jvm.causes[1].exceptionType == "java.lang.IllegalStateException")
        #expect(jvm.causes[1].message == "inner failure")
        #expect(jvm.causes[1].frames[0].raw == "sample.Inner.fail(Inner.kt:7)")
        #expect(jvm.causes[1].frames[0].function == "fail")
        #expect(jvm.causes[1].framesTruncated == false)

        let encoded = try Self.canonicalEncoder().encode(env)
        let decoded = try Self.canonicalDecoder().decode(ReportEnvelope.self, from: encoded)
        let decodedJVM = try #require(decoded.payload.crash?.jvm)
        #expect(decodedJVM.mappingID == "android-release-ci-123")
        #expect(decodedJVM.causesTruncated == false)
        #expect(decodedJVM.causes.count == 2)
        #expect(decodedJVM.causes[0].exceptionType == "java.lang.IllegalArgumentException")
        #expect(decodedJVM.causes[0].message == "middle failure")
        #expect(decodedJVM.causes[0].framesTruncated == false)
        #expect(decodedJVM.causes[0].frames[0].raw == "sample.Middle.run(Middle.kt:11)")
        #expect(decodedJVM.causes[0].frames[0].function == "run")
        #expect(decodedJVM.causes[1].exceptionType == "java.lang.IllegalStateException")
        #expect(decodedJVM.causes[1].message == "inner failure")
        #expect(decodedJVM.causes[1].framesTruncated == false)
        #expect(decodedJVM.causes[1].frames[0].raw == "sample.Inner.fail(Inner.kt:7)")
        #expect(decodedJVM.causes[1].frames[0].function == "fail")
        #expect(try Self.canonicalEncoder().encode(decoded) == encoded)
    }

    @Test func preJvmCrashInitializerRemainsSourceCompatible() {
        let crash = Crash(
            exceptionType: "TypeError",
            fatal: false,
            fingerprint: "0123456789abcdef",
            frames: [Frame(col: 2, file: "index.js", function: "run", line: 1, raw: "at run")],
            handled: true,
            jsBundle: nil,
            mechanism: "captureException",
            message: "boom",
            occurredAt: Date(timeIntervalSince1970: 0),
            threadName: "main"
        )
        #expect(crash.jvm == nil)
        #expect(crash.details == nil)
    }

    @Test func preDetailsCrashInitializerPreservesJvmMetadata() {
        let jvm = JVMCrashMetadata(causes: [], causesTruncated: false, mappingID: "release-7")
        let crash = Crash(
            exceptionType: "TypeError",
            fatal: false,
            fingerprint: "0123456789abcdef",
            frames: [],
            handled: true,
            jsBundle: nil,
            jvm: jvm,
            mechanism: "captureException",
            message: "boom",
            occurredAt: Date(timeIntervalSince1970: 0),
            threadName: "main"
        )
        #expect(crash.jvm?.mappingID == "release-7")
        #expect(crash.details == nil)
    }

    @Test func generatedCrashDetailsDecodeStructuredMetadata() throws {
        let data = Data(#"{"details":{"severity":"warning","context":"checkout","metadata":{"retry":2,"flags":[true,null]}},"exceptionType":"TypeError","fingerprint":"0123456789abcdef","frames":[],"handled":true,"mechanism":"captureException","message":"boom","occurredAt":"2026-09-15T00:00:00.000Z"}"#.utf8)
        let crash = try Self.canonicalDecoder().decode(Crash.self, from: data)
        #expect(crash.details?.severity == .warning)
        #expect(crash.details?.context == "checkout")

        let encoded = try Self.canonicalEncoder().encode(crash)
        let object = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let details = try #require(object["details"] as? [String: Any])
        let metadata = try #require(details["metadata"] as? [String: Any])
        #expect(metadata["retry"] as? Double == 2)
        #expect(metadata["flags"] as? [AnyHashable] == [true, NSNull()])
    }

    @Test func genericCauseFixtureRoundTripsAndWithPreservesCause() throws {
        let crash = try Self.canonicalDecoder().decode(Crash.self, from: Self.causeFixtureData())
        #expect(crash.causeChain?.causes.map(\.exceptionType) == ["TypeError", "RangeError"])
        #expect(crash.causeChain?.causes.first?.frames.first?.function == "middle")

        let copied = crash.with(message: "copied")
        #expect(copied.causeChain?.causes.first?.exceptionType == "TypeError")

        let encoded = try Self.canonicalEncoder().encode(copied)
        let decoded = try Self.canonicalDecoder().decode(Crash.self, from: encoded)
        #expect(decoded.message == "copied")
        #expect(decoded.causeChain?.causes[1].message == "root-range")
    }
}
