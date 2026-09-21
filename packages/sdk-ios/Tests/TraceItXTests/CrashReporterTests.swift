// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 13 — CrashReporter (RN JS-error capture path). Parity anchor is
// testFingerprintMatchesCrossSDKFixture, which drives
// packages/protocol/__tests__/fixtures/crash-fingerprint.json — the same
// fixture Android's Task 10 CrashReporterTest pins.
import XCTest
@testable import TraceItXKit
import TraceItXProtocol

final class CrashReporterTests: XCTestCase {
    private var tempDir: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        CrashReporter.__afterUserSnapshotHookForTesting = nil
        CrashReporter.__scheduleDrainForTesting = { _ in }

        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("traceitx-crash-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        CrashReporter.__afterUserSnapshotHookForTesting = nil
        CrashReporter.__scheduleDrainForTesting = nil
        TraceItX.shared.setUser(nil)
        TraceItX.shared._identityHolder.set(nil)
        TraceItX.shared._identityEnabledFlag.set(false)
        TraceItX.shared.__replayConfigOverrideForTesting = nil
        TraceItX.__setConfigForTesting(nil)
        TraceItX.captureGate = false
        try FileManager.default.removeItem(at: tempDir)
        try super.tearDownWithError()
    }

    private func makeOutbox() -> JSONLOutbox {
        JSONLOutbox(testFileURL: tempDir.appendingPathComponent("outbox.jsonl"))
    }

    func testHandledCaptureForcesClassificationAndPersistsEncryptedEnvelope() throws {
        let outbox = makeOutbox()
        let json = #"{"exceptionType":"HandledError","message":"private handled message","fatal":true,"handled":false,"source":"crash","mechanism":"malicious","framesRaw":["at f (index.bundle:1:0)"]}"#
        XCTAssertTrue(CrashReporter.captureHandledFacts(json: json, sdkName: "traceitx-react-native", outbox: outbox, config: TraceItXConfig(appId: "app")))
        let entry = try XCTUnwrap(try outbox.hydrate().first)
        let env = try JSONSerialization.jsonObject(with: entry.envelopeBytes) as! [String: Any]
        let crash = (env["payload"] as! [String: Any])["crash"] as! [String: Any]
        XCTAssertEqual(env["source"] as? String, "error")
        XCTAssertEqual(crash["handled"] as? Bool, true)
        XCTAssertEqual(crash["fatal"] as? Bool, false)
        XCTAssertEqual(crash["mechanism"] as? String, "captureException")
        XCTAssertNil(crash["details"], "React Native handled facts do not own native details yet")
        let disk = try Data(contentsOf: outbox.resolvedFileURL)
        XCTAssertEqual(String(decoding: disk.prefix(8), as: UTF8.self), "TXOBX001")
        XCTAssertNil(disk.range(of: Data("private handled message".utf8)))
    }

    private func decode(_ entry: OutboxEntry) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: entry.envelopeBytes) as? [String: Any])
    }

    private func decodedCrash(_ entry: OutboxEntry) throws -> [String: Any] {
        let envelope = try decode(entry)
        let payload = try XCTUnwrap(envelope["payload"] as? [String: Any])
        return try XCTUnwrap(payload["crash"] as? [String: Any])
    }

    func testHandledCaptureRedactsAndCapsFactsAfterRedaction() throws {
        let outbox = makeOutbox()
        let input: [String: Any] = [
            "exceptionType": String(repeating: "😀", count: 200) + "\u{0}",
            "message": "Bearer secret-token\u{0}" + String(repeating: "e\u{301}😀", count: 2_000),
            "framesRaw": Array(
                repeating: "Bearer frame-secret\u{0}" + String(repeating: "😀", count: 600),
                count: 300
            ),
        ]
        let json = String(decoding: try JSONSerialization.data(withJSONObject: input), as: UTF8.self)
        XCTAssertTrue(CrashReporter.captureHandledFacts(json: json, outbox: outbox, config: TraceItXConfig(appId: "app")))
        let entry = try XCTUnwrap(try outbox.hydrate().first)
        let crash = try decodedCrash(entry)
        XCTAssertEqual((crash["exceptionType"] as? String)?.utf16.count, 256)
        XCTAssertEqual((crash["message"] as? String)?.utf16.count, 4096)
        XCTAssertFalse(try XCTUnwrap(crash["message"] as? String).contains("secret-token"))
        XCTAssertFalse(try XCTUnwrap(crash["message"] as? String).contains("\u{0}"))
        let frames = try XCTUnwrap(crash["frames"] as? [[String: Any]])
        XCTAssertEqual(frames.count, 256)
        for frame in frames {
            let raw = try XCTUnwrap(frame["raw"] as? String)
            XCTAssertEqual(raw.utf16.count, 1024)
            XCTAssertFalse(raw.contains("\u{0}"))
            XCTAssertFalse(raw.contains("frame-secret"))
        }
    }

    func testHandledCaptureDropsMalformedOptionalIdentityButKeepsRawFacts() throws {
        for invalid in ["null", "42", "{}", #"{"engine":"hermes","platform":"ios","buildId":"\ud800","bundleName":"index.bundle"}"#] {
            let outbox = JSONLOutbox(testFileURL: tempDir.appendingPathComponent(UUID().uuidString))
            let json = "{\"exceptionType\":\"Error\",\"framesRaw\":[\"at raw\"],\"jsBundle\":\(invalid)}"
            XCTAssertTrue(CrashReporter.captureHandledFacts(json: json, outbox: outbox, config: TraceItXConfig(appId: "app")))
            let crash = try decodedCrash(XCTUnwrap(try outbox.hydrate().first))
            XCTAssertNil(crash["jsBundle"])
            XCTAssertEqual(crash["frames"] as? NSArray, [["raw": "at raw"]] as NSArray)
            XCTAssertEqual(crash["handled"] as? Bool, true)
        }
    }

    func testHandledCaptureKeepsBundleAndEntrySnapshotAcrossLaterContextChanges() throws {
        // Install only synchronous state: this test owns no start() network tail.
        TraceItX.__setConfigForTesting(TraceItXConfig(appId: "project-A"))
        TraceItX.captureGate = true
        TraceItX.shared.setUser(TXUser(id: "user-A"))
        TraceItX.shared._identityEnabledFlag.set(true)
        let claims: [String: Any] = ["sub": "verified-A", "exp": Int(Date().timeIntervalSince1970) + 300]
        func b64(_ data: Data) -> String {
            data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        }
        let token = b64(Data(#"{"alg":"HS256","typ":"JWT"}"#.utf8)) + "." + b64(try JSONSerialization.data(withJSONObject: claims)) + ".signature"
        TraceItX.shared._identityHolder.set(.token(token))
        CrashReporter.__afterUserSnapshotHookForTesting = {
            TraceItX.shared.setUser(TXUser(id: "user-B"))
            TraceItX.__setConfigForTesting(TraceItXConfig(appId: "project-B"))
        }
        let outbox = makeOutbox()
        let json = #"{"exceptionType":"Error","jsBundle":{"engine":"hermes","platform":"ios","buildId":" js-A ","bundleName":"index.bundle"}}"#
        XCTAssertTrue(CrashReporter.captureHandledFacts(json: json, sdkName: "traceitx-react-native", outbox: outbox))
        let entry = try XCTUnwrap(try outbox.hydrate().first)
        XCTAssertEqual(TraceItX.shared.currentConfig?.appId, "project-B")
        XCTAssertEqual(entry.sdkKey, "project-A")
        XCTAssertEqual(entry.endpoint, "http://127.0.0.1:9")
        XCTAssertEqual(entry.identitySubject, "verified-A")
        let envelope = try decode(entry)
        let reporter = try XCTUnwrap(envelope["reporter"] as? [String: Any])
        XCTAssertEqual((reporter["user"] as? [String: Any])?["id"] as? String, "user-A")
        XCTAssertEqual((envelope["sdk"] as? [String: Any])?["name"] as? String, "traceitx-react-native")
        XCTAssertEqual(try decodedCrash(entry)["jsBundle"] as? NSDictionary,
            ["engine": "hermes", "platform": "ios", "buildId": " js-A ", "bundleName": "index.bundle"] as NSDictionary)
    }

    func testHandledCaptureRefusesDisabledMissingConfigAndInvalidFactsThenRecovers() throws {
        let outbox = makeOutbox()
        let json = #"{"exceptionType":"Error"}"#
        var drains = 0
        CrashReporter.__scheduleDrainForTesting = { _ in drains += 1 }
        TraceItX.__setConfigForTesting(nil)
        XCTAssertFalse(CrashReporter.captureHandledFacts(json: json, outbox: outbox))
        XCTAssertFalse(CrashReporter.captureHandledFacts(json: json, outbox: outbox,
            config: TraceItXConfig(appId: "app", capture: CaptureConfig(crash: false))))
        for invalid in ["not json", "[]", "{}", #"{"exceptionType":42}"#] {
            XCTAssertFalse(CrashReporter.captureHandledFacts(json: invalid, outbox: outbox, config: TraceItXConfig(appId: "app")))
        }
        XCTAssertEqual(try outbox.hydrate().count, 0)
        XCTAssertEqual(drains, 0)
        XCTAssertTrue(CrashReporter.captureHandledFacts(json: json, outbox: outbox, config: TraceItXConfig(appId: "app")))
        XCTAssertEqual(try outbox.hydrate().count, 1)
        XCTAssertEqual(drains, 1)
    }

    func testReentrantRefusalsDoNotReleaseOuterCollectorsLatch() throws {
        let outbox = makeOutbox()
        let config = TraceItXConfig(appId: "app")
        let json = #"{"exceptionType":"Error","fatal":true}"#
        for handledOuter in [false, true] {
            var hookCalls = 0
            CrashReporter.__afterUserSnapshotHookForTesting = {
                hookCalls += 1
                // Bound recursion even if latch placement regresses.
                if hookCalls > 1 { return }
                XCTAssertFalse(CrashReporter.captureHandledFacts(json: json, outbox: outbox, config: config))
                XCTAssertFalse(CrashReporter.captureFacts(json: json, outbox: outbox, config: config))
            }
            XCTAssertTrue(handledOuter
                ? CrashReporter.captureHandledFacts(json: json, outbox: outbox, config: config)
                : CrashReporter.captureFacts(json: json, outbox: outbox, config: config))
            XCTAssertEqual(hookCalls, 1)
        }
        CrashReporter.__afterUserSnapshotHookForTesting = nil
        XCTAssertTrue(CrashReporter.captureHandledFacts(json: json, outbox: outbox, config: config))
        XCTAssertEqual(try outbox.hydrate().count, 3)
    }

    func testHandledCaptureRevocationRefusesStorageAndRecovers() throws {
        let outbox = makeOutbox()
        let config = TraceItXConfig(appId: "app")
        var drains = 0
        CrashReporter.__scheduleDrainForTesting = { _ in drains += 1 }
        CrashReporter.__afterUserSnapshotHookForTesting = { TraceItX.shared.kill() }
        XCTAssertFalse(CrashReporter.captureHandledFacts(json: #"{"exceptionType":"Error"}"#, outbox: outbox, config: config))
        XCTAssertEqual(try outbox.hydrate().count, 0)
        XCTAssertEqual(drains, 0)
        CrashReporter.__afterUserSnapshotHookForTesting = nil
        XCTAssertTrue(CrashReporter.captureHandledFacts(json: #"{"exceptionType":"Error"}"#, outbox: outbox, config: config))
        XCTAssertEqual(try outbox.hydrate().count, 1)
        XCTAssertEqual(drains, 1)
    }

    func testHandledCaptureAcknowledgesOnlyWritableEncryptedStorage() throws {
        let parent = tempDir.appendingPathComponent("blocked-parent")
        try Data("file prevents directory creation".utf8).write(to: parent)
        let outbox = JSONLOutbox(testFileURL: parent.appendingPathComponent("outbox.jsonl"))
        var drains = 0
        CrashReporter.__scheduleDrainForTesting = { _ in drains += 1 }
        let json = #"{"exceptionType":"Error"}"#
        XCTAssertFalse(CrashReporter.captureHandledFacts(json: json, outbox: outbox, config: TraceItXConfig(appId: "app")))
        XCTAssertEqual(drains, 0)
        try FileManager.default.removeItem(at: parent)
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        XCTAssertTrue(CrashReporter.captureHandledFacts(json: json, outbox: outbox, config: TraceItXConfig(appId: "app")))
        XCTAssertEqual(try outbox.hydrate().count, 1)
        XCTAssertEqual(drains, 1)
    }

    func testHandledCaptureRetainsNewestAtExistingCapacityAndRefusesOversize() throws {
        let path = tempDir.appendingPathComponent("capacity")
        let key = Data(repeating: 7, count: 32)
        let outbox = JSONLOutbox(fileURL: path, maxEntries: 2, keyProvider: { key })
        for type in ["Oldest", "Middle", "Newest"] {
            XCTAssertTrue(CrashReporter.captureHandledFacts(json: "{\"exceptionType\":\"\(type)\"}", outbox: outbox, config: TraceItXConfig(appId: "app")))
        }
        let entries = try outbox.hydrate()
        XCTAssertEqual(try entries.map { try decodedCrash($0)["exceptionType"] as? String }, ["Middle", "Newest"])
        let tooSmall = JSONLOutbox(fileURL: tempDir.appendingPathComponent("small"), maxTotalBytes: 1, keyProvider: { key })
        XCTAssertFalse(CrashReporter.captureHandledFacts(json: #"{"exceptionType":"Error"}"#, outbox: tooSmall, config: TraceItXConfig(appId: "app")))
        XCTAssertEqual(try tooSmall.hydrate().count, 0)
    }

    func testNonfatalDrainCanBeAwaitedAndKeepsRetryIdentityOnLocalFailure() async throws {
        // This is the collector's real drain operation. The required process
        // environment pins its endpoint to a closed loopback port.
        guard IngestEndpoint.url.absoluteString == "http://127.0.0.1:9" else {
            XCTFail("Run with TRACEITX_DEV_INGEST_URL=http://127.0.0.1:9 before starting XCTest")
            return
        }
        var operations: [@Sendable () async -> Void] = []
        CrashReporter.__scheduleDrainForTesting = { operations.append($0) }
        let fatalBox = JSONLOutbox(testFileURL: tempDir.appendingPathComponent("fatal.jsonl"))
        let json = #"{"exceptionType":"Error","fatal":true,"handled":true}"#
        let config = TraceItXConfig(appId: "app")
        XCTAssertTrue(CrashReporter.captureFacts(json: json, outbox: fatalBox, config: config))
        XCTAssertTrue(operations.isEmpty, "fatal automatic capture waits for a later drain")
        let automaticCrash = try decodedCrash(XCTUnwrap(try fatalBox.hydrate().first))
        XCTAssertEqual(automaticCrash["handled"] as? Bool, false)
        XCTAssertEqual(automaticCrash["fatal"] as? Bool, true)

        let outbox = makeOutbox()
        XCTAssertTrue(CrashReporter.captureHandledFacts(json: json, outbox: outbox, config: config))
        let before = try XCTUnwrap(try outbox.hydrate().first)
        XCTAssertEqual(operations.count, 1)
        await operations.removeFirst()()
        let after = try XCTUnwrap(try outbox.hydrate().first)
        XCTAssertEqual(after.reportId, before.reportId)
        XCTAssertEqual(after.idempotencyKey, before.idempotencyKey)
        XCTAssertEqual(after.envelopeBytes, before.envelopeBytes)
        XCTAssertEqual(after.sdkKey, before.sdkKey)
        XCTAssertEqual(after.endpoint, before.endpoint)
        XCTAssertEqual(after.identitySubject, before.identitySubject)
    }

    func testHermesIdentitySurvivesPersistenceWithoutRetaggingNativeBuild() throws {
        let outbox = makeOutbox()
        let json = """
        {"exceptionType":"Error","message":"hermes","fatal":true,"framesRaw":["at f (address at index.bundle:1:0)"],"jsBundle":{"engine":"hermes","platform":"ios","buildId":" js-7 ","bundleName":"index.bundle"}}
        """
        XCTAssertTrue(CrashReporter.captureFacts(json: json, sdkName: "traceitx-react-native", outbox: outbox, config: TraceItXConfig(appId: "app")))
        let entry = try XCTUnwrap(try outbox.hydrate().first)
        let env = try JSONSerialization.jsonObject(with: entry.envelopeBytes) as! [String: Any]
        let crash = (env["payload"] as! [String: Any])["crash"] as! [String: Any]
        XCTAssertEqual(crash["jsBundle"] as? NSDictionary, ["engine": "hermes", "platform": "ios", "buildId": " js-7 ", "bundleName": "index.bundle"] as NSDictionary)
        XCTAssertEqual(crash["frames"] as? NSArray, [["raw": "at f (address at index.bundle:1:0)"]] as NSArray)
        XCTAssertNil(crash["details"], "React Native automatic facts do not own native details yet")
        let app = (env["context"] as! [String: Any])["app"] as! [String: Any]
        XCTAssertEqual(app["build"] as? String, Bundle.main.infoDictionary?["CFBundleVersion"] as? String)
    }

    func testLoneSurrogateInOptionalIdentityKeepsRawCapture() throws {
        let outbox = makeOutbox()
        let json = #"{"exceptionType":"Error","fatal":true,"jsBundle":{"engine":"hermes","platform":"ios","buildId":"\ud800","bundleName":"index.bundle"}}"#
        XCTAssertTrue(CrashReporter.captureFacts(json: json, outbox: outbox, config: TraceItXConfig(appId: "app")))
        let entry = try XCTUnwrap(try outbox.hydrate().first)
        let env = try JSONSerialization.jsonObject(with: entry.envelopeBytes) as! [String: Any]
        XCTAssertNil(((env["payload"] as! [String: Any])["crash"] as! [String: Any])["jsBundle"])
    }

    func testInvalidOptionalBundleDoesNotSuppressCapture() throws {
        for invalid in ["null", "42", "{}", "{\"engine\":\"jsc\"}", "{\"engine\":\"hermes\",\"platform\":\"ios\",\"buildId\":\" \",\"bundleName\":\"index.bundle\"}"] {
            let outbox = JSONLOutbox(testFileURL: tempDir.appendingPathComponent(UUID().uuidString))
            XCTAssertTrue(CrashReporter.captureFacts(json: "{\"fatal\":true,\"exceptionType\":\"Error\",\"jsBundle\":\(invalid)}", outbox: outbox, config: TraceItXConfig(appId: "app")))
            let entry = try XCTUnwrap(try outbox.hydrate().first)
            let env = try JSONSerialization.jsonObject(with: entry.envelopeBytes) as! [String: Any]
            XCTAssertNil(((env["payload"] as! [String: Any])["crash"] as! [String: Any])["jsBundle"])
        }
    }

    func testCaptureFactsPersistsRedactedCrashEnvelope() throws {
        let outbox = makeOutbox()
        let json = """
        {"exceptionType":"TypeError","message":"boom Bearer abc.def-123","framesRaw":["at f (bundle.js:10:5)"],"mechanism":"errorutils","fatal":true,"occurredAt":"2026-07-18T12:00:00Z"}
        """
        let ok = CrashReporter.captureFacts(json: json, outbox: outbox, config: TraceItXConfig(appId: "app"))
        XCTAssertTrue(ok)
        let entry = try XCTUnwrap(try outbox.hydrate().first)
        let env = try JSONSerialization.jsonObject(with: entry.envelopeBytes) as! [String: Any]
        XCTAssertEqual(env["source"] as? String, "crash")
        let payload = env["payload"] as! [String: Any]
        let crash = payload["crash"] as! [String: Any]
        XCTAssertEqual(crash["fatal"] as? Bool, true)
        XCTAssertEqual(crash["exceptionType"] as? String, "TypeError")
        XCTAssertEqual((crash["fingerprint"] as? String)?.count, 16)
        XCTAssertFalse((crash["message"] as! String).contains("abc.def-123"))
        XCTAssertEqual(crash["handled"] as? Bool, false)
        let reporter = env["reporter"] as! [String: Any]
        XCTAssertLessThanOrEqual((reporter["title"] as! String).count, 50)
        XCTAssertEqual(reporter["description"] as? String, "")
    }

    func testCaptureFactsNonFatalShipsSourceError() throws {
        let outbox = makeOutbox()
        let json = """
        {"exceptionType":"RangeError","message":"oops","framesRaw":[],"mechanism":"errorutils","fatal":false,"occurredAt":"2026-07-18T12:00:00Z"}
        """
        let ok = CrashReporter.captureFacts(json: json, outbox: outbox, config: TraceItXConfig(appId: "app"))
        XCTAssertTrue(ok)
        let entry = try XCTUnwrap(try outbox.hydrate().first)
        let env = try JSONSerialization.jsonObject(with: entry.envelopeBytes) as! [String: Any]
        XCTAssertEqual(env["source"] as? String, "error")
        let payload = env["payload"] as! [String: Any]
        let crash = payload["crash"] as! [String: Any]
        XCTAssertEqual(crash["fatal"] as? Bool, false)
        XCTAssertEqual(crash["handled"] as? Bool, false)
    }

    func testAutomaticMechanismUsesUTF16BoundAndNormalizesNUL() throws {
        let outbox = makeOutbox()
        let mechanism = String(repeating: "😀", count: 40) + "\u{0}"
        let input: [String: Any] = [
            "exceptionType": "RangeError",
            "mechanism": mechanism,
            "fatal": false,
        ]
        let json = String(decoding: try JSONSerialization.data(withJSONObject: input), as: UTF8.self)
        XCTAssertTrue(CrashReporter.captureFacts(
            json: json, outbox: outbox, config: TraceItXConfig(appId: "app")
        ))
        let saved = try XCTUnwrap(try decodedCrash(XCTUnwrap(try outbox.hydrate().first))["mechanism"] as? String)
        XCTAssertEqual(saved.utf16.count, 64)
        XCTAssertFalse(saved.contains("\u{0}"))
    }

    func testCaptureFactsReturnsFalseWhenCrashCaptureDisabled() {
        let outbox = makeOutbox()
        let json = """
        {"exceptionType":"TypeError","message":"boom","framesRaw":[],"mechanism":"errorutils","fatal":true,"occurredAt":"2026-07-18T12:00:00Z"}
        """
        let cfg = TraceItXConfig(appId: "app", capture: CaptureConfig(crash: false))
        let ok = CrashReporter.captureFacts(json: json, outbox: outbox, config: cfg)
        XCTAssertFalse(ok)
        XCTAssertEqual(try outbox.hydrate().count, 0)
    }

    func testCaptureFactsReturnsFalseOnMalformedJSON() {
        let outbox = makeOutbox()
        let ok = CrashReporter.captureFacts(json: "not json", outbox: outbox, config: TraceItXConfig(appId: "app"))
        XCTAssertFalse(ok)
    }

    func testFingerprintMatchesCrossSDKFixture() throws {
        // CWD is not reliably the package root across every runner (plain
        // `swift test` vs. an xctest bundle launched inside the iOS
        // Simulator both differ) — resolve relative to this source file
        // instead: Tests/TraceItXTests/CrashReporterTests.swift -> up 3 to
        // packages/sdk-ios, then across to packages/protocol.
        let thisFile = URL(fileURLWithPath: #filePath)
        let packageRoot = thisFile
            .deletingLastPathComponent()  // TraceItXTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // packages/sdk-ios
        let url = packageRoot
            .deletingLastPathComponent()  // packages
            .appendingPathComponent("protocol/__tests__/fixtures/crash-fingerprint.json")
        let cases = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [[String: Any]]
        XCTAssertGreaterThanOrEqual(cases.count, 4)
        for c in cases {
            let frames = (c["frames"] as! [[String: Any]]).map { f -> String in
                if let fn = f["function"] as? String, let file = f["file"] as? String {
                    return "\(fn)|\(file)"
                }
                return (f["raw"] as! String).replacingOccurrences(
                    of: "[0-9]+", with: "", options: .regularExpression)
            }
            XCTAssertEqual(
                CrashReporter.fingerprint(exceptionType: c["exceptionType"] as! String, frameKeys: frames),
                c["expected"] as? String)
        }
    }

    func testBreadcrumbSnapshotIsNonDestructive() {
        // honorsKillGate: false — bypasses TraceItX.shared.captureGate (which
        // defaults closed pre-start()); mirrors BreadcrumbRingBufferTests'
        // buffer-level cases (see that file's header comment).
        let ring = BreadcrumbRingBuffer(maxCount: 100, honorsKillGate: false)
        ring.add(kind: .console, message: "one")
        XCTAssertEqual(ring.snapshot().map(\.message), ["one"])
        XCTAssertEqual(ring.size, 1)
    }
}
