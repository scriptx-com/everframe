// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// start()/kill() ↔ vitals runtime wiring. Serialized; every case resets the runtime.
import XCTest
import TraceItXProtocol
@testable import TraceItXKit

final class VitalsSessionBoundaryTests: XCTestCase {
    private let appA = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"
    private let appB = "txx_live_AnotherAppBBBBBBBBBBBBBBBBBBBBBB"
    private func config(_ id: String) -> TraceItXConfig { TraceItXConfig(appId: id, capture: CaptureConfig(logs: false)) }

    override func setUp() { super.setUp(); TraceItX.shared.kill(); VitalsRuntime.shared.resetForTesting(); VitalsServerConfigBox.shared.resetForTesting() }
    override func tearDown() { TraceItX.shared.kill(); VitalsRuntime.shared.resetForTesting(); VitalsServerConfigBox.shared.resetForTesting(); super.tearDown() }

    private func waitForController() -> VitalsController? {
        _ = AsyncTestHelpersSync.waitFor { VitalsRuntime.shared.current() != nil }
        return VitalsRuntime.shared.current()
    }
    private func enable() {
        VitalsServerConfigBox.shared.publish(VitalsServerConfig(vitalsEnabled: true, vitalsSampleRate: 1), ifCurrent: { true })
        VitalsQueue.shared.sync {}
    }

    func testStartInstallsAControllerThatStartsWhenTheServerEnablesVitals() throws {
        try TraceItX.shared.start(config: config(appA))
        let c = try XCTUnwrap(waitForController())
        XCTAssertFalse(c.isRunning)
        enable()
        XCTAssertTrue(c.isRunning)
        XCTAssertNotNil(VitalsRuntime.shared.currentStamp())
    }
    func testKillTearsTheRuntimeDownAndClearsTheServerSignal() throws {
        try TraceItX.shared.start(config: config(appA))
        _ = waitForController(); enable()
        let i = FakeIntegration(); _ = TraceItX.shared.trackPlayer(i, name: "main")
        TraceItX.shared.kill()
        XCTAssertNil(VitalsRuntime.shared.current()); XCTAssertNil(VitalsRuntime.shared.currentStamp())
        XCTAssertEqual(i.detached, 1)
        XCTAssertNil(VitalsServerConfigBox.shared.value)
    }
    func testASupersedingStartUnpublishesTheOldControllerBeforePublishingTheNewKey() throws {
        try TraceItX.shared.start(config: config(appA))
        let a = try XCTUnwrap(waitForController()); enable()
        try TraceItX.shared.start(config: config(appB))
        XCTAssertFalse(a.isRunning)                                  // shut down synchronously, in start(B)
        XCTAssertNil(VitalsServerConfigBox.shared.value)             // A's gate cleared
        _ = AsyncTestHelpersSync.waitFor { VitalsRuntime.shared.current() != nil && VitalsRuntime.shared.current() !== a }
        XCTAssertTrue(VitalsRuntime.shared.current() !== a)
    }
    func testATrackPlayerBeforeStartIsHonouredByTheFirstStart() throws {
        let i = FakeIntegration()
        let h = TraceItX.shared.trackPlayer(i, name: "main")
        XCTAssertEqual(h.id, "")
        try TraceItX.shared.start(config: config(appA))
        _ = AsyncTestHelpersSync.waitFor { i.ctx != nil }
        XCTAssertEqual(h.id, "p1")
    }
    func testTrackVitalsIsDroppedWithNoRunningCollectorAndRecordedWithOne() throws {
        TraceItX.shared.trackVitals("nothing")                       // no-op, no crash
        try TraceItX.shared.start(config: config(appA))
        let c = try XCTUnwrap(waitForController()); enable()
        TraceItX.shared.trackVitals("ad_break", data: ["position": "midroll"])
        let stamp = try XCTUnwrap(c.currentStamp())
        XCTAssertTrue(stamp.entries.contains { if case let .custom(e) = $0 { return e.name == "ad_break" }; return false })
    }
    /// Codex round-1, Critical 1. The envelope's stamp is bound to the epoch the report was
    /// CAPTURED under, so a report still being assembled when `start(B)` lands ships no vitals
    /// rather than B's session id and B's playback timeline. Removing the epoch comparison in
    /// `VitalsRuntime.stamp(forStartEpoch:)` puts B's session id into A's envelope here.
    func testAnEnvelopeCarriesOnlyTheVitalsOfTheSessionItWasCapturedUnder() throws {
        try TraceItX.shared.start(config: config(appA))
        let epochA = TraceItX.startEpochLockFree()
        _ = waitForController(); enable()
        TraceItX.shared.trackVitals("under_a")
        let underA = try envelope(vitalsStartEpoch: epochA)
        let sidA = try XCTUnwrap(underA["sessionId"] as? String)
        XCTAssertNotNil((underA["payload"] as? [String: Any])?["vitals"])

        try TraceItX.shared.start(config: config(appB))
        _ = waitForController(); enable()
        TraceItX.shared.trackVitals("under_b")
        let sidB = try XCTUnwrap(VitalsRuntime.shared.currentStamp()?.sessionId)
        XCTAssertNotEqual(sidA, sidB, "precondition: B is collecting into its own session")

        let stillA = try envelope(vitalsStartEpoch: epochA)
        XCTAssertNil(stillA["sessionId"], "A's report must not be stamped with B's session")
        XCTAssertNil((stillA["payload"] as? [String: Any])?["vitals"])

        // And a builder bound to no session at all stamps nothing while a real one is installed.
        let unbound = try envelope(vitalsStartEpoch: nil)
        XCTAssertNil(unbound["sessionId"]); XCTAssertNil((unbound["payload"] as? [String: Any])?["vitals"])
    }
    private func envelope(vitalsStartEpoch: Int?) throws -> [String: Any] {
        let (bytes, _) = try EnvelopeBuilder(vitalsStartEpoch: vitalsStartEpoch)
            .buildEncoded(reportId: UUID(), sdkVersion: "0.7.0", extra: ["title": "t", "description": "d"])
        return try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
    }

    /// Round-1, O8 — this used to assert the kill predicate's own expression, inlined, and
    /// never called `kill()` at all. It now drives a REAL `VitalsTransport`, bound the way
    /// `start()` binds it, through a stub URLProtocol: a superseding start and a kill each have
    /// to stop the bytes actually leaving.
    func testTheTransportIsSilencedByKillAndByASupersedingStartEpoch() throws {
        VitalsStubProtocol.reset()
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [VitalsStubProtocol.self]
        let session = URLSession(configuration: cfg)
        let endpoint = URL(string: "https://ingest.example.test/api/ingest/vitals")!
        // The exact predicate TraceItX.start() binds into the vitals transport.
        func transport(boundTo epoch: Int) -> VitalsTransport {
            VitalsTransport(session: session, endpoint: endpoint, apiKey: appA,
                            isKilled: { !TraceItX.captureGate || TraceItX.startEpochLockFree() != epoch })
        }

        try TraceItX.shared.start(config: config(appA))
        let a = transport(boundTo: TraceItX.startEpochLockFree())
        a.send(Data(#"{"payload":{"kind":"chunk"}}"#.utf8))
        XCTAssertTrue(AsyncTestHelpersSync.waitFor { VitalsStubProtocol.requests.count == 1 }, "precondition: A's transport is live")

        try TraceItX.shared.start(config: config(appB))       // a superseding start, no kill
        a.send(Data(#"{"payload":{"kind":"chunk"}}"#.utf8))
        let b = transport(boundTo: TraceItX.startEpochLockFree())
        b.send(Data(#"{"payload":{"kind":"chunk"}}"#.utf8))
        XCTAssertTrue(AsyncTestHelpersSync.waitFor { VitalsStubProtocol.requests.count == 2 }, "precondition: B's transport is live")
        XCTAssertEqual(VitalsStubProtocol.requests.count, 2, "A's transport is silenced by B's epoch")

        TraceItX.shared.kill()
        b.send(Data(#"{"payload":{"kind":"chunk"}}"#.utf8))
        Thread.sleep(forTimeInterval: 0.2)
        XCTAssertEqual(VitalsStubProtocol.requests.count, 2, "kill() silences the live transport too")
        VitalsStubProtocol.reset()
    }
}
