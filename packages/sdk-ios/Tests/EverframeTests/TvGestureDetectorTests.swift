// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

/// The TV gesture detector: long press (timer-driven; tvOS has no key
/// repeat), sequence and chord, with which presses must be kept from the app.
final class TvGestureDetectorTests: XCTestCase {
    private var presses: [NSObject] = []

    private func press() -> ObjectIdentifier {
        let object = NSObject()
        presses.append(object)
        return ObjectIdentifier(object)
    }

    private func down(_ key: String?, _ press: ObjectIdentifier, _ at: TimeInterval) -> TvKeyEvent {
        TvKeyEvent(key: key, phase: .down, press: press, at: at)
    }

    private func up(_ key: String?, _ press: ObjectIdentifier, _ at: TimeInterval) -> TvKeyEvent {
        TvKeyEvent(key: key, phase: .up, press: press, at: at)
    }

    private let play = "MEDIA_PLAY_PAUSE"

    func testLongPressFiresFromTheTimerAtTheDeadline() {
        var detector = TvGestureDetector(binding: .default)
        let p = press()
        let verdict = detector.feed(down(play, p, 10.0))
        XCTAssertEqual(verdict, TvKeyVerdict(fire: false, consume: false, holdDeadline: 11.5))
        XCTAssertFalse(detector.holdTimerFired(at: 11.49).fired)
        let fired = detector.holdTimerFired(at: 11.5)
        XCTAssertTrue(fired.fired)
        XCTAssertEqual(fired.press, p)
        XCTAssertFalse(detector.holdTimerFired(at: 11.6).fired)
    }

    func testShortTapNeverFires() {
        var detector = TvGestureDetector(binding: .default)
        let p = press()
        _ = detector.feed(down(play, p, 10.0))
        XCTAssertEqual(detector.feed(up(play, p, 10.3)), .pass)
        XCTAssertFalse(detector.holdTimerFired(at: 11.5).fired)
    }

    func testFiredHoldReleaseFollowsPolicy() {
        var detector = TvGestureDetector(binding: .default)
        let p = press()
        _ = detector.feed(down(play, p, 10.0))
        XCTAssertTrue(detector.holdTimerFired(at: 11.5).fired)
        let release = detector.feed(up(play, p, 11.7))
        XCTAssertFalse(release.fire)
        XCTAssertEqual(release.consume, TvGestureDetector.consumesFiredHoldRelease)
        XCTAssertNil(release.holdDeadline)
    }

    func testCancelledHoldNeverFires() {
        var detector = TvGestureDetector(binding: .default)
        let p = press()
        _ = detector.feed(down(play, p, 10.0))
        XCTAssertEqual(detector.feed(TvKeyEvent(key: play, phase: .cancelled, press: p, at: 10.2)), .pass)
        XCTAssertFalse(detector.holdTimerFired(at: 11.5).fired)
    }

    func testOtherKeysPassDuringAHold() {
        var detector = TvGestureDetector(binding: .default)
        let p = press()
        let arrow = press()
        _ = detector.feed(down(play, p, 10.0))
        XCTAssertEqual(detector.feed(down("DPAD_DOWN", arrow, 10.2)), .pass)
        XCTAssertEqual(detector.feed(up("DPAD_DOWN", arrow, 10.4)), .pass)
        XCTAssertEqual(detector.feed(down(nil, press(), 10.5)), .pass)
        XCTAssertTrue(detector.holdTimerFired(at: 11.5).fired)
    }

    func testANewPressOfTheKeyReplacesThePendingHold() {
        var detector = TvGestureDetector(binding: .longPress(key: "DPAD_CENTER", holdMs: 500))
        let first = press()
        let second = press()
        _ = detector.feed(down("DPAD_CENTER", first, 1.0))
        XCTAssertEqual(detector.feed(down("DPAD_CENTER", second, 1.2)).holdDeadline, 1.7)
        // The first press's release no longer clears the pending hold.
        XCTAssertEqual(detector.feed(up("DPAD_CENTER", first, 1.3)), .pass)
        XCTAssertFalse(detector.holdTimerFired(at: 1.5).fired)
        XCTAssertEqual(detector.holdTimerFired(at: 1.7).press, second)
    }

    func testSequenceFiresOnTheCompletingDownWithinTheWindow() {
        var detector = TvGestureDetector(binding: .sequence(keys: ["DPAD_UP", "DPAD_UP", "DPAD_DOWN", "DPAD_DOWN"],
                                                             windowMs: 1000))
        let keys = ["DPAD_UP", "DPAD_UP", "DPAD_DOWN", "DPAD_DOWN"]
        for (index, key) in keys.enumerated() {
            let p = press()
            let at = Double(index) * 0.2
            let verdict = detector.feed(down(key, p, at))
            let release = detector.feed(up(key, p, at + 0.08))
            if index < 3 {
                XCTAssertEqual(verdict, .pass, key)
                XCTAssertEqual(release, .pass, key)
            } else {
                XCTAssertTrue(verdict.fire && verdict.consume)
                XCTAssertEqual(release, TvKeyVerdict(fire: false, consume: true))
            }
        }
    }

    func testSlowSequenceNeverFires() {
        var detector = TvGestureDetector(binding: .sequence(keys: ["DPAD_UP", "DPAD_UP", "DPAD_DOWN", "DPAD_DOWN"],
                                                             windowMs: 1000))
        for (index, key) in ["DPAD_UP", "DPAD_UP", "DPAD_DOWN", "DPAD_DOWN"].enumerated() {
            let p = press()
            XCTAssertFalse(detector.feed(down(key, p, Double(index) * 0.4)).fire)
            _ = detector.feed(up(key, p, Double(index) * 0.4 + 0.05))
        }
    }

    func testSequenceBrokenByAnotherKey() {
        var detector = TvGestureDetector(binding: .sequence(keys: ["DPAD_UP", "DPAD_UP", "DPAD_DOWN", "DPAD_DOWN"],
                                                             windowMs: 1000))
        var at = 0.0
        func tap(_ key: String?) -> Bool {
            let p = press()
            at += 0.1
            let fired = detector.feed(down(key, p, at)).fire
            _ = detector.feed(up(key, p, at + 0.02))
            return fired
        }
        XCTAssertFalse(["DPAD_UP", "DPAD_UP", "DPAD_CENTER", "DPAD_DOWN", "DPAD_DOWN"].map(tap).contains(true))
        // An unmapped press breaks the match too.
        XCTAssertFalse(["DPAD_UP", "DPAD_UP", nil, "DPAD_DOWN", "DPAD_DOWN"].map(tap).contains(true))
        XCTAssertEqual(["DPAD_UP", "DPAD_UP", "DPAD_DOWN", "DPAD_DOWN"].map(tap), [false, false, false, true])
    }

    func testSequenceClearsAfterFiring() {
        var detector = TvGestureDetector(binding: .sequence(keys: ["DPAD_UP", "DPAD_UP", "DPAD_DOWN", "DPAD_DOWN"],
                                                             windowMs: 1000))
        var fires: [Bool] = []
        for (index, key) in ["DPAD_UP", "DPAD_UP", "DPAD_DOWN", "DPAD_DOWN", "DPAD_DOWN"].enumerated() {
            let p = press()
            fires.append(detector.feed(down(key, p, Double(index) * 0.1)).fire)
            _ = detector.feed(up(key, p, Double(index) * 0.1 + 0.02))
        }
        XCTAssertEqual(fires, [false, false, false, true, false])
    }

    func testChordFiresOnTheCompletingDown() {
        var detector = TvGestureDetector(binding: .chord(keys: ["SHIFT", "B"]))
        let shift = press()
        let b = press()
        XCTAssertEqual(detector.feed(down("SHIFT", shift, 1.0)), .pass)
        let completing = detector.feed(down("B", b, 1.1))
        XCTAssertTrue(completing.fire && completing.consume)
        XCTAssertEqual(detector.feed(up("B", b, 1.2)), TvKeyVerdict(fire: false, consume: true))
        XCTAssertEqual(detector.feed(up("SHIFT", shift, 1.3)), .pass)
    }

    func testChordNeedsEveryKeyHeld() {
        var detector = TvGestureDetector(binding: .chord(keys: ["SHIFT", "B"]))
        let shift = press()
        _ = detector.feed(down("SHIFT", shift, 1.0))
        _ = detector.feed(up("SHIFT", shift, 1.1))
        XCTAssertEqual(detector.feed(down("B", press(), 1.2)), .pass)
    }

    func testOverlappingChordCompletionsKeepEachFiredPressConsumed() {
        var detector = TvGestureDetector(binding: .chord(keys: ["SHIFT", "B"]))
        let shift = press()
        let b1 = press()
        let b2 = press()
        _ = detector.feed(down("SHIFT", shift, 1.0))
        XCTAssertTrue(detector.feed(down("B", b1, 1.1)).fire)
        // A second B press while the first is still down completes the set again.
        XCTAssertTrue(detector.feed(down("B", b2, 1.2)).consume)
        XCTAssertTrue(detector.feed(up("B", b1, 1.3)).consume)
        XCTAssertTrue(detector.feed(up("B", b2, 1.4)).consume)
    }

    func testDropPendingKeepsConsumedPresses() {
        // A fired sequence's press stays consumed until its own release.
        var sequence = TvGestureDetector(binding: .sequence(keys: ["DPAD_UP", "DPAD_DOWN"], windowMs: 1000))
        let upPress = press()
        let downPress = press()
        _ = sequence.feed(down("DPAD_UP", upPress, 0))
        _ = sequence.feed(up("DPAD_UP", upPress, 0.05))
        XCTAssertTrue(sequence.feed(down("DPAD_DOWN", downPress, 0.1)).fire)
        sequence.dropPending()
        XCTAssertTrue(sequence.feed(up("DPAD_DOWN", downPress, 0.2)).consume)

        // Steps are cleared.
        let up2 = press()
        _ = sequence.feed(down("DPAD_UP", up2, 0.3))
        sequence.dropPending()
        XCTAssertFalse(sequence.feed(down("DPAD_DOWN", press(), 0.4)).fire)

        // An unfired hold is cleared.
        var hold = TvGestureDetector(binding: .default)
        _ = hold.feed(down(play, press(), 1.0))
        hold.dropPending()
        XCTAssertFalse(hold.holdTimerFired(at: 2.5).fired)

        // The chord's held set is cleared, its consumed press kept.
        var chord = TvGestureDetector(binding: .chord(keys: ["SHIFT", "B"]))
        let shift = press()
        let b = press()
        _ = chord.feed(down("SHIFT", shift, 1.0))
        XCTAssertTrue(chord.feed(down("B", b, 1.1)).fire)
        chord.dropPending()
        XCTAssertTrue(chord.feed(up("B", b, 1.2)).consume)
        XCTAssertFalse(chord.feed(down("B", press(), 1.3)).fire)
    }

    func testResetForgetsEverything() {
        var chord = TvGestureDetector(binding: .chord(keys: ["SHIFT", "B"]))
        let shift = press()
        let b = press()
        _ = chord.feed(down("SHIFT", shift, 1.0))
        XCTAssertTrue(chord.feed(down("B", b, 1.1)).fire)
        chord.reset()
        XCTAssertEqual(chord.feed(up("B", b, 1.2)), .pass)
    }
}
