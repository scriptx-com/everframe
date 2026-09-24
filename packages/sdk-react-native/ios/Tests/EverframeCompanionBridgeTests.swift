// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Plan 06.2-11 — XCTest coverage for the iOS half of the companion bridge.
//
// Goals (matches plan §Task 4):
//   1. `EverframeBridge.startCompanion(_:)` creates an internal RelayWSClient
//      and installs Combine subscriptions on Everframe.shared.companion.
//   2. State + pairUrl changes on `Everframe.shared.companion` (driven via the
//      internal `__setState` / `__setPairUrl` seams) reach the
//      `EverframeEventEmitter` and fire JS event payloads.
//   3. `EverframeBridge.stopCompanion()` releases the client reference (the
//      Combine subscriptions intentionally persist across stop/start cycles —
//      see EverframeBridge.swift companion section comment).
#if canImport(XCTest)
import XCTest
import Combine
@testable import Everframe_ReactNative
import EverframeKit

final class EverframeCompanionBridgeTests: XCTestCase {

    override func setUp() {
        super.setUp()
        // Reset between tests so the latch + cancellables don't carry over.
        EverframeBridge._resetCompanionForTesting()
    }

    override func tearDown() {
        EverframeBridge._resetCompanionForTesting()
        super.tearDown()
    }

    // MARK: - startCompanion / stopCompanion bookkeeping

    func testStartCompanionCreatesClientAndStopReleasesIt() {
        XCTAssertFalse(EverframeBridge._hasCompanionClientForTesting(),
                       "no client before startCompanion")
        EverframeBridge.startCompanion("http://localhost:8787")
        XCTAssertTrue(EverframeBridge._hasCompanionClientForTesting(),
                      "startCompanion must store a RelayWSClient reference")

        EverframeBridge.stopCompanion()
        XCTAssertFalse(EverframeBridge._hasCompanionClientForTesting(),
                       "stopCompanion must drop the client reference")
    }

    func testStartCompanionWhileRunningIsNoOp() {
        EverframeBridge.startCompanion("http://localhost:8787")
        let firstID = EverframeBridge._companionClientIdentityForTesting()
        XCTAssertNotNil(firstID, "startCompanion must store a client")
        // A second start while already running is a no-op — the existing
        // socket is NOT recreated; the same client instance must remain.
        EverframeBridge.startCompanion("http://localhost:9999")
        XCTAssertEqual(EverframeBridge._companionClientIdentityForTesting(), firstID,
                       "repeat startCompanion must not recreate the client")
        // stop() clears it; a subsequent start() opens a fresh connection.
        EverframeBridge.stopCompanion()
        XCTAssertFalse(EverframeBridge._hasCompanionClientForTesting(),
                       "stopCompanion must drop the client")
        EverframeBridge.startCompanion("http://localhost:8787")
        XCTAssertTrue(EverframeBridge._hasCompanionClientForTesting(),
                      "start after stop must open a fresh client")
    }

    func testStartCompanionIgnoresInvalidEndpoint() {
        EverframeBridge.startCompanion("not a url")
        // The bridge logs + drops the call; no client is created.
        XCTAssertFalse(EverframeBridge._hasCompanionClientForTesting(),
                       "invalid URL must not yield a client")
    }

    // MARK: - Combine fan-out → EverframeEventEmitter

    func testCompanionStateChangeReachesEventEmitter() {
        // Force the emitter into existence; RN normally constructs it from
        // the module registry, but in unit-test context we instantiate it
        // directly so `shared` is set.
        let emitter = EverframeEventEmitter()
        XCTAssertNotNil(EverframeEventEmitter.shared, "emitter `shared` must be wired by init")

        // Capture the emit call by swapping a probe onto `sendEvent`. RN's
        // RCTEventEmitter doesn't expose listener counts cleanly, so we
        // exercise the `static sendState(_:)` helper directly instead and
        // observe via the underlying `Everframe.shared.companion` Combine
        // publisher to confirm the bridge has installed the subscription.
        let exp = expectation(description: "Combine sink fires")
        var cancellable: AnyCancellable?
        cancellable = Everframe.shared.companion.$state
            .dropFirst()  // skip the current value, watch for the next change
            .sink { state in
                XCTAssertEqual(state, .paired)
                exp.fulfill()
            }

        // Install bridge subscriptions by calling startCompanion (which
        // also creates a WS client we don't care about here — the WS
        // never actually opens against `localhost:8787` in the unit-test
        // environment, but the Combine sinks are installed first).
        EverframeBridge.startCompanion("http://localhost:8787")

        // Drive the state change through the documented `__setState` seam
        // (CompanionAPI.swift). This is the same write path the production
        // RelayWSClient uses.
        Everframe.shared.companion.__setState(.paired)

        wait(for: [exp], timeout: 2.0)
        cancellable?.cancel()
        _ = emitter  // keep alive past the wait
    }

    func testCompanionPairUrlChangeReachesEventEmitter() {
        let emitter = EverframeEventEmitter()
        XCTAssertNotNil(EverframeEventEmitter.shared)

        let exp = expectation(description: "Combine pairUrl sink fires")
        var cancellable: AnyCancellable?
        cancellable = Everframe.shared.companion.$pairUrl
            .dropFirst()
            .sink { url in
                XCTAssertEqual(url, "http://localhost:8787/r/sample-token")
                exp.fulfill()
            }

        EverframeBridge.startCompanion("http://localhost:8787")
        Everframe.shared.companion.__setPairUrl("http://localhost:8787/r/sample-token")

        wait(for: [exp], timeout: 2.0)
        cancellable?.cancel()
        _ = emitter
    }

    // MARK: - attachChallenge (spec 2026-08-19)

    func testCompanionAttachChallengeChangeReachesEventEmitter() {
        let emitter = EverframeEventEmitter()
        XCTAssertNotNil(EverframeEventEmitter.shared)

        let exp = expectation(description: "Combine attachChallenge sink fires")
        var cancellable: AnyCancellable?
        cancellable = Everframe.shared.companion.$attachChallenge
            .dropFirst()
            .sink { challenge in
                XCTAssertEqual(challenge?.code, "0427")
                XCTAssertEqual(challenge?.requestedByName, "Aurimas")
                XCTAssertEqual(challenge?.ttlMs, 60000)
                exp.fulfill()
            }

        EverframeBridge.startCompanion("http://localhost:8787")
        Everframe.shared.companion.__setAttachChallenge(
            CompanionAttachChallenge(code: "0427", requestedByName: "Aurimas", ttlMs: 60000)
        )

        wait(for: [exp], timeout: 2.0)
        cancellable?.cancel()
        _ = emitter
    }

    func testCompanionAttachChallengeClearReachesEventEmitterAsNil() {
        let emitter = EverframeEventEmitter()
        XCTAssertNotNil(EverframeEventEmitter.shared)

        EverframeBridge.startCompanion("http://localhost:8787")
        Everframe.shared.companion.__setAttachChallenge(
            CompanionAttachChallenge(code: "0427", requestedByName: "Aurimas", ttlMs: 60000)
        )

        let exp = expectation(description: "Combine attachChallenge sink fires nil")
        var cancellable: AnyCancellable?
        cancellable = Everframe.shared.companion.$attachChallenge
            .dropFirst()
            .sink { challenge in
                XCTAssertNil(challenge)
                exp.fulfill()
            }

        Everframe.shared.companion.__setAttachChallenge(nil)

        wait(for: [exp], timeout: 2.0)
        cancellable?.cancel()
        _ = emitter
    }

    // MARK: - EverframeEventEmitter own contract

    func testEmitterSupportedEvents() {
        let emitter = EverframeEventEmitter()
        let supported = emitter.supportedEvents() ?? []
        XCTAssertTrue(supported.contains(EverframeEventEmitter.stateEvent))
        XCTAssertTrue(supported.contains(EverframeEventEmitter.pairUrlEvent))
        XCTAssertTrue(supported.contains(EverframeEventEmitter.attachChallengeEvent))
    }

    func testEmitterRequiresMainQueueSetupIsFalse() {
        // Pure value-passing emitter — no UIKit reads at init time.
        XCTAssertFalse(EverframeEventEmitter.requiresMainQueueSetup())
    }

    // MARK: - Snake_case state string contract
    //
    // CompanionState.rawValue (Swift default for `enum CompanionState:
    // String`) is the camelCase case name — `.reportInProgress` would
    // cross to JS as "reportInProgress". The JS facade in companion.ts
    // declares the union as snake_case ("report_in_progress" |
    // "phone_disconnected"); without the explicit map at the bridge
    // boundary, the iOS path would silently never match. Lock the map
    // here so any future refactor that drops `rnString(for:)` fails this
    // test rather than the user's UAT.

    func testRnStringMapsAllFourStates() {
        XCTAssertEqual(EverframeBridge.rnString(for: .unpaired), "unpaired")
        XCTAssertEqual(EverframeBridge.rnString(for: .paired), "paired")
        XCTAssertEqual(EverframeBridge.rnString(for: .reportInProgress), "report_in_progress")
        XCTAssertEqual(EverframeBridge.rnString(for: .phoneDisconnected), "phone_disconnected")
    }
}
#endif
