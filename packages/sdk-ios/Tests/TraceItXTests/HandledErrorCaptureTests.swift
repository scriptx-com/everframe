// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import Foundation
import XCTest
@testable import TraceItXKit

final class HandledErrorCaptureTests: XCTestCase {
    private var tempDir: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        TraceItX.shared.kill()
        CrashReporter.__afterUserSnapshotHookForTesting = nil
        CrashReporter.__scheduleDrainForTesting = { _ in }
        try? FileManager.default.removeItem(at: JSONLOutbox().resolvedFileURL)
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("traceitx-handled-error-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        configure()
    }

    override func tearDownWithError() throws {
        CrashReporter.__afterUserSnapshotHookForTesting = nil
        CrashReporter.__scheduleDrainForTesting = nil
        TraceItX.shared.kill()
        TraceItX.__setConfigForTesting(nil)
        try? FileManager.default.removeItem(at: JSONLOutbox().resolvedFileURL)
        try FileManager.default.removeItem(at: tempDir)
        try super.tearDownWithError()
    }

    private func configure(_ config: TraceItXConfig = TraceItXConfig(appId: "ios-handled-test")) {
        TraceItX.__setConfigForTesting(config)
        TraceItX.captureGate = true
    }

    private func makeOutbox(_ name: String = "outbox.jsonl") -> JSONLOutbox {
        JSONLOutbox(testFileURL: tempDir.appendingPathComponent(name))
    }

    private func envelope(_ entry: OutboxEntry) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: entry.envelopeBytes) as? [String: Any])
    }

    private func crash(_ entry: OutboxEntry) throws -> [String: Any] {
        let payload = try XCTUnwrap(try envelope(entry)["payload"] as? [String: Any])
        return try XCTUnwrap(payload["crash"] as? [String: Any])
    }

    func testPublicCapturePersistsHandledErrorInDefaultEncryptedOutbox() throws {
        TraceItX.shared.setUser(TXUser(id: "captured-user"))
        TraceItX.shared.captureException(NSError(
            domain: "ExampleFailure",
            code: 17,
            userInfo: [NSLocalizedDescriptionKey: "handled probe"]
        ))

        let outbox = JSONLOutbox()
        let entry = try XCTUnwrap(try outbox.hydrate().first)
        let envelope = try envelope(entry)
        let crash = try crash(entry)
        XCTAssertEqual(envelope["source"] as? String, "error")
        XCTAssertEqual(crash["handled"] as? Bool, true)
        XCTAssertEqual(crash["fatal"] as? Bool, false)
        XCTAssertEqual(crash["mechanism"] as? String, "captureException")
        XCTAssertEqual(crash["exceptionType"] as? String, "ExampleFailure:17")
        XCTAssertEqual(crash["message"] as? String, "handled probe")
        XCTAssertEqual((crash["details"] as? [String: Any])?["severity"] as? String, "error")
        XCTAssertFalse(try XCTUnwrap(crash["frames"] as? [[String: Any]]).isEmpty)
        XCTAssertEqual((envelope["sdk"] as? [String: Any])?["name"] as? String, "traceitx-ios")
        XCTAssertNotNil((envelope["context"] as? [String: Any])?["app"])
        XCTAssertEqual(
            ((envelope["reporter"] as? [String: Any])?["user"] as? [String: Any])?["id"] as? String,
            "captured-user"
        )
        let disk = try Data(contentsOf: outbox.resolvedFileURL)
        XCTAssertEqual(String(decoding: disk.prefix(8), as: UTF8.self), "TXOBX001")
        XCTAssertNil(disk.range(of: Data("handled probe".utf8)))
    }

    func testPublicCaptureOwnsSuppliedDetailsAndKeepsFingerprintInputsUnchanged() throws {
        let metadata: [String: Any] = [
            "attempt": 3,
            "nested": ["state": "captured"],
        ]
        TraceItX.shared.captureException(
            NSError(
                domain: "OptionsFailure",
                code: 23,
                userInfo: [NSLocalizedDescriptionKey: "same failure"]
            ),
            options: CaptureExceptionOptions(
                severity: .warning,
                context: "checkout",
                metadata: metadata
            )
        )
        TraceItX.shared.captureException(NSError(
            domain: "OptionsFailure",
            code: 23,
            userInfo: [NSLocalizedDescriptionKey: "same failure"]
        ))

        let entries = try JSONLOutbox().hydrate()
        XCTAssertEqual(entries.count, 2)
        let supplied = try crash(entries[0])
        let baseline = try crash(entries[1])
        let details = try XCTUnwrap(supplied["details"] as? [String: Any])
        XCTAssertEqual(details["severity"] as? String, "warning")
        XCTAssertEqual(details["context"] as? String, "checkout")
        let savedMetadata = try XCTUnwrap(details["metadata"] as? [String: Any])
        XCTAssertEqual(savedMetadata["attempt"] as? Int, 3)
        XCTAssertEqual((savedMetadata["nested"] as? [String: Any])?["state"] as? String, "captured")
        XCTAssertEqual(supplied["fingerprint"] as? String, baseline["fingerprint"] as? String)
        XCTAssertEqual(supplied["exceptionType"] as? String, baseline["exceptionType"] as? String)
        XCTAssertEqual(supplied["message"] as? String, baseline["message"] as? String)
    }

    func testNativeNSErrorAndSwiftErrorsKeepTheirConcreteTypeRulesAndMessages() throws {
        enum ValueFailure: LocalizedError {
            case failed
            var errorDescription: String? { "localized enum message" }
        }
        final class CustomFailure: Error, CustomNSError {
            static let errorDomain = "MustNotBecomeNSError"
            static var errorCode: Int { 42 }
        }

        let outbox = makeOutbox()
        XCTAssertTrue(CrashReporter.captureHandledError(ValueFailure.failed, outbox: outbox))
        XCTAssertTrue(CrashReporter.captureHandledError(CustomFailure(), outbox: outbox))
        let crashes = try outbox.hydrate().map { try crash($0) }
        XCTAssertEqual(crashes[0]["exceptionType"] as? String, String(reflecting: ValueFailure.self))
        XCTAssertEqual(crashes[0]["message"] as? String, "localized enum message")
        XCTAssertEqual(crashes[1]["exceptionType"] as? String, String(reflecting: CustomFailure.self))
        XCTAssertFalse(try XCTUnwrap(crashes[1]["exceptionType"] as? String).contains("MustNotBecomeNSError"))
    }

    func testReferenceIdentityDeduplicatesSameObjectWithoutCallingHostEquality() throws {
        final class EqualityFailure: Error, Hashable {
            let equalityRead: () -> Void
            init(equalityRead: @escaping () -> Void) { self.equalityRead = equalityRead }
            static func == (lhs: EqualityFailure, rhs: EqualityFailure) -> Bool {
                lhs.equalityRead()
                return true
            }
            func hash(into hasher: inout Hasher) {
                equalityRead()
                hasher.combine(1)
            }
        }

        var equalityReads = 0
        let outbox = makeOutbox()
        let first = EqualityFailure { equalityReads += 1 }
        XCTAssertTrue(CrashReporter.captureHandledError(first, outbox: outbox))
        XCTAssertFalse(CrashReporter.captureHandledError(first, outbox: outbox))
        XCTAssertTrue(CrashReporter.captureHandledError(
            EqualityFailure { equalityReads += 1 }, outbox: outbox
        ))
        XCTAssertEqual(equalityReads, 0)
        XCTAssertEqual(try outbox.hydrate().count, 2)
    }

    func testDistinctNSErrorObjectsWithSameDomainAndCodeAreSeparateCaptures() throws {
        let outbox = makeOutbox()
        XCTAssertTrue(CrashReporter.captureHandledError(
            NSError(domain: "EqualNSError", code: 8), outbox: outbox
        ))
        XCTAssertTrue(CrashReporter.captureHandledError(
            NSError(domain: "EqualNSError", code: 8), outbox: outbox
        ))
        let crashes = try outbox.hydrate().map { try crash($0) }
        XCTAssertEqual(crashes.count, 2)
        XCTAssertEqual(crashes.map { $0["exceptionType"] as? String }, ["EqualNSError:8", "EqualNSError:8"])
    }

    func testRepeatedValueErrorsConsumeSeparateAdmissionsAndLimitIsTen() throws {
        enum ValueFailure: Error { case same }
        let outbox = makeOutbox()
        for index in 0..<11 {
            XCTAssertEqual(
                CrashReporter.captureHandledError(ValueFailure.same, outbox: outbox),
                index < 10
            )
        }
        XCTAssertEqual(try outbox.hydrate().count, 10)
    }

    func testStorageFailureAllowsSameReferenceToRetryAndSpendFinalAdmission() throws {
        enum ValueFailure: Error { case accepted }
        let outbox = makeOutbox()
        for _ in 0..<9 {
            XCTAssertTrue(CrashReporter.captureHandledError(ValueFailure.accepted, outbox: outbox))
        }
        let retry = NSError(domain: "RetryFailure", code: 1)
        let blockedParent = tempDir.appendingPathComponent("blocked")
        try Data("file".utf8).write(to: blockedParent)
        let blocked = JSONLOutbox(testFileURL: blockedParent.appendingPathComponent("outbox.jsonl"))
        XCTAssertFalse(CrashReporter.captureHandledError(retry, outbox: blocked))
        try FileManager.default.removeItem(at: blockedParent)
        XCTAssertTrue(CrashReporter.captureHandledError(retry, outbox: outbox))
        XCTAssertFalse(CrashReporter.captureHandledError(ValueFailure.accepted, outbox: outbox))
        XCTAssertEqual(try outbox.hydrate().count, 10)
    }

    func testRealStartResetsBudgetAndPreviouslyAcceptedReferenceIdentity() throws {
        enum ValueFailure: Error { case fill }
        let outbox = makeOutbox()
        let reused = NSError(domain: "AcrossStarts", code: 3)
        XCTAssertTrue(CrashReporter.captureHandledError(reused, outbox: outbox))
        for _ in 0..<9 {
            XCTAssertTrue(CrashReporter.captureHandledError(ValueFailure.fill, outbox: outbox))
        }
        XCTAssertFalse(CrashReporter.captureHandledError(ValueFailure.fill, outbox: outbox))

        try TraceItX.shared.start(config: TraceItXConfig(
            appId: "txx_live_00000000000000000000000000000000",
            capture: CaptureConfig(logs: false)
        ))
        XCTAssertTrue(CrashReporter.captureHandledError(reused, outbox: outbox))
        XCTAssertEqual(try outbox.hydrate().count, 11)
    }

    func testLateReservationCannotResetOrConsumeSuccessorEpoch() {
        let epoch = LockedValue(1)
        let admission = HandledErrorAdmission(currentEpoch: { epoch.get() })
        let old = admission.reserve(NSError(domain: "old", code: 1), capturedEpoch: 1)!
        epoch.set(2)
        for index in 0..<9 {
            let reservation = admission.reserve(
                NSError(domain: "new", code: index), capturedEpoch: 2
            )!
            admission.settle(reservation, durablyAccepted: true)
        }
        let tenth = admission.reserve(NSError(domain: "new", code: 10), capturedEpoch: 2)!
        XCTAssertNil(admission.reserve(NSError(domain: "late", code: 1), capturedEpoch: 1))
        admission.settle(old, durablyAccepted: true)
        XCTAssertNil(admission.reserve(NSError(domain: "pending", code: 1), capturedEpoch: 2))
        admission.settle(tenth, durablyAccepted: true)
        XCTAssertNil(admission.reserve(NSError(domain: "eleventh", code: 11), capturedEpoch: 2))
    }

    func testPrestartDisabledAndKilledCapturesDoNotEvaluateLocalizedDescription() {
        let reads = LockedValue(0)
        let error = CallbackLocalizedError {
            reads.mutate { $0 += 1 }
            TraceItX.shared.captureException(NSError(domain: "recursive", code: 1))
        }

        TraceItX.__setConfigForTesting(nil)
        TraceItX.captureGate = false
        TraceItX.shared.captureException(error)
        XCTAssertFalse(CrashReporter.captureHandledError(error, outbox: makeOutbox("prestart")))

        configure(TraceItXConfig(
            appId: "disabled",
            capture: CaptureConfig(crash: false)
        ))
        TraceItX.shared.captureException(error)
        XCTAssertFalse(CrashReporter.captureHandledError(error, outbox: makeOutbox("disabled")))

        configure()
        TraceItX.shared.kill()
        TraceItX.shared.captureException(error)
        XCTAssertFalse(CrashReporter.captureHandledError(error, outbox: makeOutbox("killed")))
        XCTAssertEqual(reads.get(), 0)
    }

    func testReentrantDescriptionCapturesOnlyOuterError() throws {
        let outbox = makeOutbox()
        let error = CallbackLocalizedError {
            XCTAssertFalse(CrashReporter.captureHandledError(
                NSError(domain: "recursive", code: 1), outbox: outbox
            ))
        }
        XCTAssertTrue(CrashReporter.captureHandledError(error, outbox: outbox))
        XCTAssertEqual(try outbox.hydrate().count, 1)
        XCTAssertEqual(try crash(XCTUnwrap(try outbox.hydrate().first))["message"] as? String, "callback message")
    }

    func testConfigChangeInsideDescriptionDropsStaleAttemptWithoutSpendingAdmission() throws {
        let outbox = makeOutbox()
        let shouldChange = LockedValue(true)
        let error = CallbackLocalizedError {
            if shouldChange.mutate({ value in
                defer { value = false }
                return value
            }) {
                TraceItX.__setConfigForTesting(TraceItXConfig(appId: "replacement"))
            }
        }
        XCTAssertFalse(CrashReporter.captureHandledError(error, outbox: outbox))
        XCTAssertEqual(try outbox.hydrate().count, 0)
        configure()
        XCTAssertTrue(CrashReporter.captureHandledError(error, outbox: outbox))
    }

    func testUserChangeInsideDescriptionKeepsCaptureEntryUserSnapshot() throws {
        TraceItX.shared.setUser(TXUser(id: "original-user"))
        let outbox = makeOutbox()
        let error = CallbackLocalizedError {
            TraceItX.shared.setUser(TXUser(id: "later-user"))
        }
        XCTAssertTrue(CrashReporter.captureHandledError(error, outbox: outbox))
        let saved = try envelope(XCTUnwrap(try outbox.hydrate().first))
        XCTAssertEqual(
            ((saved["reporter"] as? [String: Any])?["user"] as? [String: Any])?["id"] as? String,
            "original-user"
        )
    }

    func testKillAndStartInsideDescriptionDropTheOriginalAttempt() throws {
        let outbox = makeOutbox()
        let killed = CallbackLocalizedError { TraceItX.shared.kill() }
        XCTAssertFalse(CrashReporter.captureHandledError(killed, outbox: outbox))
        XCTAssertEqual(try outbox.hydrate().count, 0)

        configure()
        let restarted = CallbackLocalizedError {
            try? TraceItX.shared.start(config: TraceItXConfig(
                appId: "txx_live_00000000000000000000000000000000",
                capture: CaptureConfig(logs: false)
            ))
        }
        XCTAssertFalse(CrashReporter.captureHandledError(restarted, outbox: outbox))
        XCTAssertEqual(try outbox.hydrate().count, 0)
    }

    func testMetadataTraversalReentryCapturesOnlyTheReservedOuterError() throws {
        let outbox = makeOutbox()
        let reentrantResult = LockedValue<Bool?>(nil)
        let metadata = CrashCountedDictionary(keys: ["callback"]) { _ in
            reentrantResult.set(CrashReporter.captureHandledError(
                NSError(domain: "MetadataReentry", code: 2), outbox: outbox
            ))
            return "outer-value"
        }

        XCTAssertTrue(CrashReporter.captureHandledError(
            NSError(domain: "MetadataOuter", code: 1),
            options: CaptureExceptionOptions(metadata: ["host": metadata]),
            outbox: outbox
        ))
        XCTAssertEqual(reentrantResult.get(), false)
        XCTAssertEqual(metadata.valueReads, ["callback"])
        let saved = try crash(XCTUnwrap(try outbox.hydrate().first))
        let details = try XCTUnwrap(saved["details"] as? [String: Any])
        XCTAssertEqual(
            ((details["metadata"] as? [String: Any])?["host"] as? [String: Any])?["callback"] as? String,
            "outer-value"
        )
        XCTAssertEqual(try outbox.hydrate().count, 1)
    }

    func testKillRestartDuringMetadataDropsStaleAttemptWithoutSpendingSuccessorBudget() throws {
        enum ValueFailure: Error { case fill }
        let outbox = makeOutbox()
        let restarted = LockedValue(false)
        let metadata = CrashCountedDictionary(keys: ["callback"]) { _ in
            if !restarted.get() {
                restarted.set(true)
                TraceItX.shared.kill()
                try? TraceItX.shared.start(config: TraceItXConfig(
                    appId: "txx_live_00000000000000000000000000000000",
                    capture: CaptureConfig(logs: false)
                ))
            }
            return "stale"
        }
        let retry = NSError(domain: "MetadataRestart", code: 4)

        XCTAssertFalse(CrashReporter.captureHandledError(
            retry,
            options: CaptureExceptionOptions(metadata: ["host": metadata]),
            outbox: outbox
        ))
        XCTAssertEqual(try outbox.hydrate().count, 0)
        XCTAssertTrue(CrashReporter.captureHandledError(retry, outbox: outbox))
        for _ in 0..<9 {
            XCTAssertTrue(CrashReporter.captureHandledError(ValueFailure.fill, outbox: outbox))
        }
        XCTAssertFalse(CrashReporter.captureHandledError(ValueFailure.fill, outbox: outbox))
        XCTAssertEqual(try outbox.hydrate().count, 10)
    }

    func testAutomaticFatalCaptureRunsWhileMetadataTraversalIsBlocked() throws {
        let entered = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let finished = DispatchSemaphore(value: 0)
        let handledOutbox = makeOutbox("metadata-handled.jsonl")
        let automaticOutbox = makeOutbox("metadata-automatic.jsonl")
        let result = LockedValue<Bool?>(nil)
        let metadata = CrashCountedDictionary(keys: ["blocked"]) { _ in
            entered.signal()
            _ = release.wait(timeout: .now() + 5)
            return "released"
        }
        let inputs = SendableHandledCapture(
            error: NSError(domain: "BlockedMetadata", code: 8),
            options: CaptureExceptionOptions(metadata: ["host": metadata]),
            outbox: handledOutbox
        )
        let thread = Thread {
            defer { finished.signal() }
            result.set(CrashReporter.captureHandledError(
                inputs.error, options: inputs.options, outbox: inputs.outbox
            ))
        }
        defer { release.signal() }

        thread.start()
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        XCTAssertTrue(CrashReporter.captureFacts(
            json: #"{"exceptionType":"AutomaticDuringMetadata","fatal":true}"#,
            outbox: automaticOutbox,
            config: TraceItXConfig(appId: "ios-handled-test")
        ))
        release.signal()
        XCTAssertEqual(finished.wait(timeout: .now() + 5), .success)
        XCTAssertEqual(result.get(), true)
        XCTAssertEqual(try automaticOutbox.hydrate().count, 1)
        XCTAssertEqual(try handledOutbox.hydrate().count, 1)
    }

    func testNativeAllowanceDoesNotSuppressRNHandledOrAutomaticFatalFacts() throws {
        enum ValueFailure: Error { case fill }
        let outbox = makeOutbox()
        for _ in 0..<10 {
            XCTAssertTrue(CrashReporter.captureHandledError(ValueFailure.fill, outbox: outbox))
        }
        XCTAssertTrue(CrashReporter.captureHandledFacts(
            json: #"{"exceptionType":"RNHandled"}"#,
            sdkName: "traceitx-react-native", outbox: outbox,
            config: TraceItXConfig(appId: "ios-handled-test")
        ))
        XCTAssertTrue(CrashReporter.captureFacts(
            json: #"{"exceptionType":"RNAutomatic","fatal":true}"#,
            sdkName: "traceitx-react-native", outbox: outbox,
            config: TraceItXConfig(appId: "ios-handled-test")
        ))
        let entries = try outbox.hydrate()
        XCTAssertEqual(entries.count, 12)
        let rnCrashes = try entries.suffix(2).map { try crash($0) }
        XCTAssertEqual(rnCrashes[0]["handled"] as? Bool, true)
        XCTAssertEqual(rnCrashes[1]["handled"] as? Bool, false)
        XCTAssertEqual(rnCrashes[1]["fatal"] as? Bool, true)
    }

    func testNativeTextIsRedactedUTF16BoundedAndJSONSafe() throws {
        let message = "Bearer abc.def-123\u{0}" + String(repeating: "e\u{301}😀", count: 2_000)
        let domain = String(repeating: "😀", count: 200) + "\u{0}"
        let outbox = makeOutbox()
        XCTAssertTrue(CrashReporter.captureHandledError(NSError(
            domain: domain,
            code: 7,
            userInfo: [NSLocalizedDescriptionKey: message]
        ), outbox: outbox))
        let crash = try crash(XCTUnwrap(try outbox.hydrate().first))
        let type = try XCTUnwrap(crash["exceptionType"] as? String)
        let savedMessage = try XCTUnwrap(crash["message"] as? String)
        XCTAssertLessThanOrEqual(type.utf16.count, 256)
        XCTAssertLessThanOrEqual(savedMessage.utf16.count, 4096)
        XCTAssertFalse(type.contains("\u{0}"))
        XCTAssertFalse(savedMessage.contains("\u{0}"))
        XCTAssertFalse(savedMessage.contains("abc.def-123"))
        XCTAssertTrue(savedMessage.contains("e\u{301}"))
    }

    func testAutomaticFatalCaptureRunsWhileNativeDescriptionIsBlocked() throws {
        let entered = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let finished = DispatchSemaphore(value: 0)
        let nativeOutbox = makeOutbox("native.jsonl")
        let automaticOutbox = makeOutbox("automatic.jsonl")
        let result = LockedValue<Bool?>(nil)
        let blocking = BlockingLocalizedError(entered: entered, release: release)
        let thread = Thread {
            defer { finished.signal() }
            result.set(CrashReporter.captureHandledError(blocking, outbox: nativeOutbox))
        }
        thread.start()
        XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
        XCTAssertTrue(CrashReporter.captureFacts(
            json: #"{"exceptionType":"AutomaticFatal","fatal":true}"#,
            outbox: automaticOutbox,
            config: TraceItXConfig(appId: "ios-handled-test")
        ))
        release.signal()
        XCTAssertEqual(finished.wait(timeout: .now() + 5), .success)
        XCTAssertEqual(result.get(), true)
        XCTAssertEqual(try automaticOutbox.hydrate().count, 1)
        XCTAssertEqual(try nativeOutbox.hydrate().count, 1)
    }

    func testWeakAcceptedIdentityDoesNotRetainErrorOrRefundBudget() throws {
        enum ValueFailure: Error { case fill }
        let outbox = makeOutbox()
        weak var weakError: DeinitFailure?
        let deinitialized = expectation(description: "accepted error released")
        func captureTransient() {
            let error = DeinitFailure { deinitialized.fulfill() }
            weakError = error
            XCTAssertTrue(CrashReporter.captureHandledError(error, outbox: outbox))
        }
        captureTransient()
        wait(for: [deinitialized], timeout: 2)
        XCTAssertNil(weakError)
        for _ in 0..<9 {
            XCTAssertTrue(CrashReporter.captureHandledError(ValueFailure.fill, outbox: outbox))
        }
        XCTAssertFalse(CrashReporter.captureHandledError(ValueFailure.fill, outbox: outbox))
        XCTAssertEqual(try outbox.hydrate().count, 10)
    }

    func testNativeDrainClosureKeepsPersistedIdentityOnLoopbackFailure() async throws {
        guard IngestEndpoint.url.absoluteString == "http://127.0.0.1:9" else {
            XCTFail("Run with TRACEITX_DEV_INGEST_URL=http://127.0.0.1:9")
            return
        }
        let operations = LockedValue<[@Sendable () async -> Void]>([])
        CrashReporter.__scheduleDrainForTesting = { operation in
            operations.mutate { $0.append(operation) }
        }
        let outbox = makeOutbox()
        XCTAssertTrue(CrashReporter.captureHandledError(
            NSError(domain: "LoopbackFailure", code: 9), outbox: outbox
        ))
        let before = try XCTUnwrap(try outbox.hydrate().first)
        let operation = operations.mutate { $0.removeFirst() }
        await operation()
        let after = try XCTUnwrap(try outbox.hydrate().first)
        XCTAssertEqual(after.reportId, before.reportId)
        XCTAssertEqual(after.idempotencyKey, before.idempotencyKey)
        XCTAssertEqual(after.envelopeBytes, before.envelopeBytes)
        XCTAssertEqual(after.sdkKey, before.sdkKey)
        XCTAssertEqual(after.endpoint, before.endpoint)
        XCTAssertEqual(after.identitySubject, before.identitySubject)
    }
}

private final class LockedValue<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    init(_ value: Value) { self.value = value }

    func get() -> Value {
        lock.lock(); defer { lock.unlock() }
        return value
    }

    func set(_ newValue: Value) {
        lock.lock(); value = newValue; lock.unlock()
    }

    @discardableResult
    func mutate<Result>(_ operation: (inout Value) -> Result) -> Result {
        lock.lock(); defer { lock.unlock() }
        return operation(&value)
    }
}

private final class CallbackLocalizedError: LocalizedError, @unchecked Sendable {
    private let callback: () -> Void
    init(_ callback: @escaping () -> Void) { self.callback = callback }
    var errorDescription: String? { callback(); return "callback message" }
}

private final class BlockingLocalizedError: LocalizedError, @unchecked Sendable {
    private let entered: DispatchSemaphore
    private let release: DispatchSemaphore

    init(entered: DispatchSemaphore, release: DispatchSemaphore) {
        self.entered = entered
        self.release = release
    }

    var errorDescription: String? {
        entered.signal()
        _ = release.wait(timeout: .now() + 5)
        return "blocking message"
    }
}

private final class DeinitFailure: LocalizedError {
    private let onDeinit: () -> Void
    init(onDeinit: @escaping () -> Void) { self.onDeinit = onDeinit }
    var errorDescription: String? { "released message" }
    deinit { onDeinit() }
}

private final class SendableHandledCapture: @unchecked Sendable {
    let error: any Error
    let options: CaptureExceptionOptions
    let outbox: JSONLOutbox

    init(error: any Error, options: CaptureExceptionOptions, outbox: JSONLOutbox) {
        self.error = error
        self.options = options
        self.outbox = outbox
    }
}
