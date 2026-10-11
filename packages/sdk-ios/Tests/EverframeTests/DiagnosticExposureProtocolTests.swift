// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import EverframeProtocol

final class DiagnosticExposureProtocolTests: XCTestCase {
    private func pointer(build: String?) -> EverframeNativeExposure {
        EverframeNativeExposure(app: EverframeNativeExposureApp(build: build, debug: false, version: "2.4.0"), exposureID: "exposure",
            loadedBuildID: nil, loadedBundleStatus: .notApplicable, processLaunchID: "process",
            startedAt: Date(timeIntervalSince1970: 0))
    }
    // Review Focus 1: the API links a crash to its session by comparing the whole pointer,
    // so a missing build must be written as null, never omitted.
    func testRequiredNullableBuildsSurviveEncoding() throws {
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(pointer(build: nil))) as? [String: Any])
        XCTAssertTrue(encoded["loadedBuildId"] is NSNull)
        let app = try XCTUnwrap(encoded["app"] as? [String: Any])
        XCTAssertEqual(app["version"] as? String, "2.4.0")
        XCTAssertTrue(app["build"] is NSNull)
        XCTAssertEqual(Set(encoded.keys), ["app", "exposureId", "loadedBuildId", "loadedBundleStatus", "processLaunchId", "startedAt"])
    }
    func testAPresentBuildRoundTrips() throws {
        let decoded = try JSONDecoder().decode(EverframeNativeExposure.self, from: JSONEncoder().encode(pointer(build: "412")))
        XCTAssertEqual(decoded.app.version, "2.4.0"); XCTAssertEqual(decoded.app.build, "412")
    }
    func testAPointerWithoutAnAppDoesNotDecode() {
        let old = Data(#"{"exposureId":"exposure","processLaunchId":"process","startedAt":0,"loadedBuildId":null,"loadedBundleStatus":"not_applicable"}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(EverframeNativeExposure.self, from: old))
    }
    func testTheEnvelopeAppKeepsItsGeneratedName() {
        // If quicktype renamed the envelope's app type to tell it from the pointer's app, this stops compiling.
        let app: EverframeApp = EverframeApp(build: "412", debug: false, name: "dev.example", version: "2.4.0")
        XCTAssertEqual(app.version, "2.4.0")
    }
    func testLegacyInitializerDoesNotRequireAnExposure() throws {
        let source = try Self.canonicalDecoder().decode(EverframeDiagnosticEvidence.self, from: Data("""
        {"version":1,"evidenceId":"11111111-1111-4111-8111-111111111111","processLaunchId":"22222222-2222-4222-8222-222222222222","kind":"process_exit","provenance":"android_application_exit_info","scope":"os_process","outcome":"terminated","cause":"anr","occurredAt":"2026-10-07T10:00:00.000Z","collectedAt":"2026-10-07T10:01:00.000Z","attribution":{"process":"exact_os_token","release":"frozen","session":"unavailable","webExposure":"unavailable"},"android":{"apiLevel":35,"reason":6,"pid":100},"trace":{"status":"unavailable","format":"none","truncated":false,"frames":[]}}
        """.utf8))
        let copy = EverframeDiagnosticEvidence(android: source.android, attribution: source.attribution,
            cause: source.cause, collectedAt: source.collectedAt, evidenceID: source.evidenceID,
            kind: source.kind, occurredAt: source.occurredAt, outcome: source.outcome,
            processLaunchID: source.processLaunchID, provenance: source.provenance,
            scope: source.scope, trace: source.trace, version: source.version)
        XCTAssertNil(copy.nativeExposure)
        XCTAssertEqual(copy.processLaunchID, source.processLaunchID)
    }

    // Protocol timestamps carry milliseconds. The generated `.iso8601` decoder rejects them on
    // Foundation before Swift 6.2 (macOS 15, iOS 18), so decode them explicitly.
    private static func canonicalDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { dec in
            let container = try dec.singleValueContainer()
            let string = try container.decode(String.self)
            let withFractional = ISO8601DateFormatter()
            withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = withFractional.date(from: string) { return date }
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "Expected ISO8601 date string, got \(string)")
        }
        return decoder
    }
}
