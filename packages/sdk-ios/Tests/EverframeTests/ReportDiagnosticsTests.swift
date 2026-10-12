// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

final class ReportDiagnosticsTests: XCTestCase {
    func testActualStartReconfigureAndKillPublishGeneration() throws {
        defer { Everframe.shared.kill() }
        let config = EverframeConfig(sdkKey: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU", capture: CaptureConfig(logs: false))
        try Everframe.shared.start(config: config)
        let old = try XCTUnwrap(ReportDiagnostics.shared.handle(epoch: Everframe.shared.currentStartEpoch))
        old.capture(.nativeHandled, .persisted)
        XCTAssertEqual(Everframe.shared.getReportDeliveryStatus().capture.paths["native-handled"]?.settledAttempts, 1)
        try Everframe.shared.start(config: config)
        old.capture(.nativeHandled, .persisted)
        XCTAssertEqual(Everframe.shared.getReportDeliveryStatus().capture.paths["native-handled"]?.settledAttempts, 0)
        Everframe.shared.kill()
        XCTAssertEqual(Everframe.shared.getReportDeliveryStatus().status, "disabled")
    }

    func testInitialStateAndPlatformPolicies() throws {
        let state = ReportDiagnostics().snapshot()
        XCTAssertEqual(state.status, "not-started")
        XCTAssertNil(state.queue.pendingCount)
        XCTAssertEqual(state.queue.observation, "not-observed")
        XCTAssertEqual(state.queue.capacityPolicy, "evict-oldest")
        XCTAssertEqual(state.queue.terminalHttpPolicy, "attempt-remove")
        XCTAssertFalse(try XCTUnwrap(state.capture.paths["jvm-uncaught"]).supported)
    }

    func testGenerationReplacementRetiresEvenSameEpochAndReturnsValues() throws {
        let ledger = ReportDiagnostics()
        let old = ledger.beginGeneration(epoch: 1, enabled: true)
        old.capture(.nativeHandled, .persisted)
        let before = ledger.snapshot()
        let current = ledger.beginGeneration(epoch: 1, enabled: false)
        old.capture(.bridgeAutomatic, .persisted)
        XCTAssertEqual(ledger.snapshot().revision, 0)
        XCTAssertFalse(ledger.snapshot().capture.enabled)
        current.capture(.nativeHandled, .disabled)
        XCTAssertEqual(before.capture.paths["native-handled"]?.outcomes["persisted"], 1)
        XCTAssertEqual(ledger.snapshot().capture.paths["native-handled"]?.outcomes["persisted"], 0)
        ledger.retireGeneration(epoch: 2)
        current.capture(.nativeHandled, .persisted)
        XCTAssertEqual(ledger.snapshot().status, "disabled")
        XCTAssertEqual(ledger.snapshot().revision, 0)
        XCTAssertNil(ledger.handle(epoch: 1))
    }

    func testQueueFailureAndAcceptanceAreIndependentAndCountersSaturate() {
        let ledger = ReportDiagnostics()
        let owner = ledger.beginGeneration(epoch: 4, enabled: true)
        owner.queueObserved(count: 2, quality: .complete)
        owner.transport(.outboxDrain, .serverAccepted, httpStatus: 202)
        owner.queueOperation(.removalFailed, failure: .io)
        owner.queueOperation(.capacityEvicted, amount: Int.max)
        owner.queueOperation(.capacityEvicted)
        let state = ledger.snapshot()
        XCTAssertNil(state.queue.pendingCount)
        XCTAssertEqual(state.queue.observation, "failed")
        XCTAssertEqual(state.queue.operations["removed-after-acceptance"], 0)
        XCTAssertEqual(state.queue.operations["capacity-evicted"], 2_147_483_647)
        XCTAssertEqual(state.transport["outbox-drain"]?.outcomes["server-accepted"], 1)
    }

    func testContendedGetterAndObservationDoNotWait() {
        let lock = NSLock()
        let ledger = ReportDiagnostics(lock: lock)
        let owner = ledger.beginGeneration(epoch: 1, enabled: true)
        lock.lock()
        let done = expectation(description: "nonwaiting observation")
        DispatchQueue.global().async {
            XCTAssertEqual(ledger.snapshot().reason, "snapshot-busy")
            owner.capture(.nativeHandled, .persisted)
            done.fulfill()
        }
        wait(for: [done], timeout: 1)
        lock.unlock()
        XCTAssertEqual(ledger.snapshot().revision, 0)
    }

    func testJSONSchemaOmitsUnknownFieldsAndInvalidHTTPStatus() throws {
        let ledger = ReportDiagnostics()
        ledger.beginGeneration(epoch: 1, enabled: true).transport(.liveSubmit, .failed, httpStatus: 999)
        let json = try ledger.snapshot().toJSON()
        XCTAssertLessThan(json.utf8.count, 16_384)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), Set(["schemaVersion", "status", "reason", "scope", "coverage", "revision", "capture", "queue", "transport"]))
        XCTAssertNil((object["queue"] as? [String: Any])?["pendingCount"])
        XCTAssertFalse(json.contains("lastHttpStatus"))
    }
}
