// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Report Resource Window (spec 2026-09-05) — `payload.resources` on the
// report-envelope path. Deviations from task-11-brief.md's literal pseudocode
// (note 7 — follow the package's actual conventions):
//   * There is no static `EnvelopeBuilder.build(...)`; the real entry point
//     is the INSTANCE method `EnvelopeBuilder(redactor:).buildEncoded(...)`,
//     which returns `(bytes: Data, idempotencyKey: String)`, not a bare
//     envelope value. `encodeToDict` below decodes those bytes back into a
//     `[String: Any]` via `JSONSerialization`, mirroring
//     `EnvelopeUserTests.captureAndDecodeReporter`'s established idiom for
//     reaching into an encoded envelope.
//   * Minimal-args fixture: reused from `EnvelopeUserTests`'s own
//     `sessionConfig`/`buildEncoded` call shape rather than inventing one —
//     `reportId`/`sdkVersion` are the only required arguments.
import XCTest
@testable import TraceItXKit

final class ResourceEnvelopeTests: XCTestCase {
    private func encodeToDict(_ bytes: Data) throws -> [String: Any] {
        try XCTUnwrap(try JSONSerialization.jsonObject(with: bytes) as? [String: Any])
    }

    private func payload(of dict: [String: Any]) throws -> [String: Any] {
        try XCTUnwrap(dict["payload"] as? [String: Any])
    }

    func testOmitsResourcesWhenEmpty() throws {
        let (bytes, _) = try EnvelopeBuilder().buildEncoded(
            reportId: UUID(),
            sdkVersion: "1.0.0",
            resources: []
        )
        let dict = try encodeToDict(bytes)
        let p = try payload(of: dict)
        XCTAssertNil(p["resources"])
    }

    func testOmitsResourcesWhenNil() throws {
        let (bytes, _) = try EnvelopeBuilder().buildEncoded(
            reportId: UUID(),
            sdkVersion: "1.0.0"
        )
        let dict = try encodeToDict(bytes)
        let p = try payload(of: dict)
        XCTAssertNil(p["resources"], "the pre-resources builder shape must be untouched when resources is absent")
    }

    func testIncludesResourcesWhenPresent() throws {
        let samples = [ResourceSample(t: 1, cpu: 0.5, mem: 1024)]
        let (bytes, _) = try EnvelopeBuilder().buildEncoded(
            reportId: UUID(),
            sdkVersion: "1.0.0",
            resources: samples
        )
        let dict = try encodeToDict(bytes)
        let p = try payload(of: dict)
        let arr = try XCTUnwrap(p["resources"] as? [[String: Any]])
        XCTAssertEqual(arr.count, 1)
        XCTAssertEqual(arr[0]["mem"] as? Int64, 1024)
        XCTAssertEqual(arr[0]["cpu"] as? Double, 0.5)
    }

    // Omitted, not null — the schema's cpu is `.optional()`, and an explicit
    // null fails validation and drops the WHOLE report. Swift's JSONEncoder
    // omits nil Optionals by default; asserted here rather than assumed.
    func testOmitsCPUKeyEntirelyWhenNil() throws {
        let (bytes, _) = try EnvelopeBuilder().buildEncoded(
            reportId: UUID(),
            sdkVersion: "1.0.0",
            resources: [ResourceSample(t: 1, cpu: nil, mem: 8)]
        )
        let dict = try encodeToDict(bytes)
        let p = try payload(of: dict)
        let arr = try XCTUnwrap(p["resources"] as? [[String: Any]])
        XCTAssertFalse(arr[0].keys.contains("cpu"))
    }

    // The 256 hard cap must be re-applied at the encode boundary, keeping
    // the NEWEST samples — a stamp exceeding it rejects the WHOLE report,
    // non-retryably.
    func testCapsAtMaxSamplesKeepingNewest() throws {
        let samples = (0..<(ResourceRingBuffer.maxSamples + 10)).map {
            ResourceSample(t: Int64($0), cpu: nil, mem: Int64($0))
        }
        let (bytes, _) = try EnvelopeBuilder().buildEncoded(
            reportId: UUID(),
            sdkVersion: "1.0.0",
            resources: samples
        )
        let dict = try encodeToDict(bytes)
        let p = try payload(of: dict)
        let arr = try XCTUnwrap(p["resources"] as? [[String: Any]])
        XCTAssertEqual(arr.count, ResourceRingBuffer.maxSamples)
        XCTAssertEqual(arr.last?["mem"] as? Int64, Int64(ResourceRingBuffer.maxSamples + 9))
    }

    func testCrashEnvelopeCarriesResourcesFromTheSharedRing() throws {
        // `.shared` honors the capture kill-gate (like every sibling ring),
        // so a session must be open for `append` to take — mirrors
        // EnvelopeUserTests' `startSession()` convention.
        try TraceItX.shared.start(config: TraceItXConfig(
            appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU",
            capture: CaptureConfig(logs: false)
        ))
        ResourceRingBuffer.shared.clear()
        defer {
            ResourceRingBuffer.shared.clear()
            TraceItX.shared.kill()
        }
        // CrashReporter reads `ResourceRingBuffer.shared.snapshot()` — the
        // convenience that evicts against the REAL current clock (see
        // ResourceRingBuffer's CONTROLLER RULING doc comment) — so this
        // fixture must stamp a real "now", not an arbitrary epoch like the
        // ring-buffer unit tests use, or the sample would be evicted as
        // 1970-epoch-old before CrashReporter ever reads it.
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        ResourceRingBuffer.shared.append(ResourceSample(t: now, cpu: 0.2, mem: 2048), now: now)

        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("traceitx-resource-envelope-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let outbox = JSONLOutbox(fileURL: tempDir.appendingPathComponent("outbox.jsonl"))
        let json = """
        {"exceptionType":"TypeError","message":"boom","framesRaw":[],"mechanism":"errorutils","fatal":true,"occurredAt":"2026-08-12T00:00:00Z"}
        """
        let ok = CrashReporter.captureFacts(json: json, outbox: outbox, config: TraceItXConfig(appId: "app"))
        XCTAssertTrue(ok)
        let entry = try XCTUnwrap(try outbox.hydrate().first)
        let dict = try encodeToDict(entry.envelopeBytes)
        let p = try payload(of: dict)
        let arr = try XCTUnwrap(p["resources"] as? [[String: Any]], "CrashReporter must stamp the live resource ring onto payload.resources")
        XCTAssertEqual(arr.count, 1)
        XCTAssertEqual(arr[0]["mem"] as? Int64, 2048)
    }
}
