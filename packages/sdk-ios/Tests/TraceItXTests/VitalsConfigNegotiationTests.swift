// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Twin of VitalsServerConfigTest.kt + the vitals halves of the Android
// ReplayConfigProvider / ConfigValidator tests. Host-runnable.
import XCTest
@testable import TraceItXKit

final class VitalsConfigNegotiationTests: XCTestCase {
    override func setUp() { super.setUp(); VitalsServerConfigBox.shared.resetForTesting() }
    override func tearDown() { VitalsServerConfigBox.shared.resetForTesting(); super.tearDown() }

    private func decode(_ json: String) throws -> ReplayConfig {
        // ReplayConfigWire is private; go through the provider's decoder seam.
        try ReplayConfigProvider.__decodeForTesting(Data(json.utf8))
    }

    func testAbsentFieldsDefaultToOffAndFullRate() throws {
        let c = try decode(#"{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1}"#)
        XCTAssertNil(c.vitalsEnabled); XCTAssertNil(c.vitalsSampleRate)
        let v = c.toVitalsServerConfig()
        XCTAssertFalse(v.vitalsEnabled); XCTAssertEqual(v.vitalsSampleRate, 1.0)
    }
    func testPresentFieldsPassThroughRateClamped() throws {
        let c = try decode(#"{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1,"vitalsEnabled":true,"vitalsSampleRate":7}"#)
        XCTAssertEqual(c.vitalsEnabled, true); XCTAssertEqual(c.vitalsSampleRate, 7)
        XCTAssertEqual(c.toVitalsServerConfig(), VitalsServerConfig(vitalsEnabled: true, vitalsSampleRate: 1.0))
        XCTAssertEqual(try decode(#"{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1,"vitalsSampleRate":-2}"#).toVitalsServerConfig().vitalsSampleRate, 0.0)
    }
    func testAWrongTypedVitalsFieldDegradesThatFieldAloneAndNeverSinksTheConfig() throws {
        let c = try decode(#"{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1,"vitalsEnabled":"yes","vitalsSampleRate":"half"}"#)
        XCTAssertTrue(c.replayEnabled)
        XCTAssertNil(c.vitalsEnabled); XCTAssertNil(c.vitalsSampleRate)
    }
    func testTheFeaturesHeaderDeclaresVitals() {
        XCTAssertEqual(ReplayConfigProvider.sdkFeaturesHeaderValue, "networkbodies, identity, companionbadge, branding, nativevideo, vitals, resources, shaketoreport")
    }
    /// Codex round-1, #7 — a subscriber that has read the current value and a publisher that
    /// writes a newer one must reach the serial queue in THAT order. Submitting after the
    /// unlock let a replay of `enabled` land behind a refresh's `disabled`: the queue delivered
    /// disabled-then-enabled, so the last thing every subscriber saw was "enabled" while the
    /// box itself read "disabled" — collection running against a gate that says off.
    ///
    /// The interleaving is made deterministic through the submission hook, which runs at the
    /// instant the fix is about: a publish attempted from another thread there BLOCKS on the
    /// gate (post-fix) or slips in ahead of the replay (pre-fix, where the gate is already
    /// released by then).
    func testAStalledSubscribersReplayCanNeverOverwriteANewerDecision() {
        let q = DispatchQueue(label: "test.vitals.configbox")
        let box = VitalsServerConfigBox(queue: q)
        box.publish(VitalsServerConfig(vitalsEnabled: true, vitalsSampleRate: 1), ifCurrent: { true })

        let seen = Locked<[Bool?]>([])
        let refreshed = DispatchSemaphore(value: 0)
        let once = Locked(false)
        box.__submissionHookForTesting = {
            var first = false
            once.mutate { if !$0 { $0 = true; first = true } }
            guard first else { return }
            DispatchQueue.global().async { box.publish(nil, ifCurrent: { true }); refreshed.signal() }
            // Post-fix this times out — the refresh is parked on the gate this thread holds.
            _ = refreshed.wait(timeout: .now() + 0.5)
        }
        let sub = box.subscribe { cfg in seen.mutate { $0.append(cfg?.vitalsEnabled) } }
        XCTAssertEqual(refreshed.wait(timeout: .now() + 5), .success)
        q.sync {}

        XCTAssertNil(box.value, "precondition: the refresh disabled vitals")
        XCTAssertEqual(seen.value.map { $0 ?? false }, [true, false],
                       "the replay must be delivered BEFORE the newer decision, never after it")
        sub.cancel()
    }

    func testValidatorRejectsASampleRateOutsideZeroOne() {
        var cfg = TraceItXConfig(appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU")
        cfg.vitals.sampleRate = 1.5
        XCTAssertThrowsError(try ConfigValidator.validate(cfg)) { XCTAssertEqual($0 as? TraceItXConfigError, .invalidVitalsSampleRate) }
        cfg.vitals.sampleRate = .nan
        XCTAssertThrowsError(try ConfigValidator.validate(cfg))
        cfg.vitals.sampleRate = 0.5
        XCTAssertNoThrow(try ConfigValidator.validate(cfg))
        cfg.vitals.sampleRate = nil
        XCTAssertNoThrow(try ConfigValidator.validate(cfg))
    }
    func testBoxStartsNilPublishesReplaysToLateSubscribersAndResets() {
        let box = VitalsServerConfigBox.shared
        XCTAssertNil(box.value)
        let seen = Locked<[VitalsServerConfig?]>([])
        let exp = expectation(description: "two deliveries"); exp.expectedFulfillmentCount = 2
        let sub = box.subscribe { v in seen.mutate { $0.append(v) }; exp.fulfill() }
        box.publish(VitalsServerConfig(vitalsEnabled: true, vitalsSampleRate: 1.0), ifCurrent: { true })
        wait(for: [exp], timeout: 2)
        XCTAssertEqual(seen.value, [nil, VitalsServerConfig(vitalsEnabled: true, vitalsSampleRate: 1.0)])   // replayed nil, then the publish
        XCTAssertEqual(box.value, VitalsServerConfig(vitalsEnabled: true, vitalsSampleRate: 1.0))
        sub.cancel()
        box.publish(nil, ifCurrent: { true })
        XCTAssertNil(box.value)
        let late = expectation(description: "late subscriber gets current")
        let lateSub = box.subscribe { v in XCTAssertNil(v); late.fulfill() }
        wait(for: [late], timeout: 2)
        lateSub.cancel()
    }
    func testPublishIsANoOpOnceItsOwnGenerationIsSuperseded() {
        let box = VitalsServerConfigBox.shared
        box.publish(VitalsServerConfig(vitalsEnabled: true, vitalsSampleRate: 0.5), ifCurrent: { true })
        box.publish(nil, ifCurrent: { false })
        XCTAssertEqual(box.value, VitalsServerConfig(vitalsEnabled: true, vitalsSampleRate: 0.5))
    }
    func testACancelledSubscriberReceivesNothingFurther() {
        let box = VitalsServerConfigBox.shared
        let count = Locked(0)
        let sub = box.subscribe { _ in count.mutate { $0 += 1 } }
        sub.cancel()
        box.publish(VitalsServerConfig(vitalsEnabled: true, vitalsSampleRate: 1), ifCurrent: { true })
        VitalsQueue.shared.sync {}   // drain
        XCTAssertLessThanOrEqual(count.value, 1)   // at most the replayed nil, if it raced the cancel
    }
}
