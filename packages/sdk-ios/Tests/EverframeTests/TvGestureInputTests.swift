// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The Siri Remote gesture as the `UIWindow.sendEvent` hook drives it: what
// routes, what is delivered, and what a linked device keeps from the app.
// UIKit-gated: run on a simulator (see TESTING.md).
#if canImport(UIKit)
import UIKit
import XCTest
@testable import EverframeKit

@MainActor
private final class FakeTimer: TvGestureTimer {
    let delay: TimeInterval
    let body: @MainActor () -> Void
    private(set) var cancelled = false

    init(delay: TimeInterval, body: @escaping @MainActor () -> Void) {
        self.delay = delay
        self.body = body
    }

    nonisolated func cancel() {
        MainActor.assumeIsolated { cancelled = true }
    }

    func run() {
        guard !cancelled else { return }
        body()
    }
}

@MainActor
final class TvGestureInputTests: XCTestCase {
    private var now: TimeInterval = 100
    private var timers: [FakeTimer] = []
    private var routes: [CaptureGestureSource] = []
    private var decision = CaptureGestureDecision(action: .quickCapture, sendHello: false, swallowKeys: false)
    private var binding: TvGestureBinding? = .default
    private var editing = false
    private var objects: [NSObject] = []
    private var input: TvGestureInput!

    override func setUp() async throws {
        now = 100
        timers = []
        routes = []
        decision = CaptureGestureDecision(action: .quickCapture, sendHello: false, swallowKeys: false)
        binding = .default
        editing = false
        objects = []
        input = TvGestureInput(seams: TvGestureInput.Seams(
            now: { [unowned self] in self.now },
            schedule: { [unowned self] delay, body in
                let timer = FakeTimer(delay: delay, body: body)
                self.timers.append(timer)
                return timer
            },
            armedBinding: { [unowned self] in self.binding },
            route: { [unowned self] source in
                self.routes.append(source)
                return self.decision
            },
            isEditingText: { [unowned self] _ in self.editing }))
    }

    private var linked: CaptureGestureDecision {
        CaptureGestureDecision(action: .quickCapture, sendHello: false, swallowKeys: true)
    }

    private func press() -> ObjectIdentifier {
        let object = NSObject()
        objects.append(object)
        return ObjectIdentifier(object)
    }

    private func send(_ key: String?, _ phase: TvKeyPhase, _ press: ObjectIdentifier, at: TimeInterval) -> Bool {
        now = at
        return input.handle([TvKeyEvent(key: key, phase: phase, press: press, at: at)], window: nil)
    }

    /// Taps each key (down, then up 0.05 s later), 0.2 s apart. Returns each
    /// down's and up's delivery answers.
    private func tap(_ keys: [String], from start: TimeInterval = 100) -> [(down: Bool, up: Bool)] {
        keys.enumerated().map { index, key in
            let p = press()
            let at = start + Double(index) * 0.2
            return (send(key, .down, p, at: at), send(key, .up, p, at: at + 0.05))
        }
    }

    private let play = "MEDIA_PLAY_PAUSE"
    private let konami = TvGestureBinding.sequence(keys: ["DPAD_UP", "DPAD_UP", "DPAD_DOWN", "DPAD_DOWN"], windowMs: 1000)

    #if os(tvOS)
    func testPressTypeRawValuesMatchUIKit() {
        XCTAssertEqual(UIPress.PressType.upArrow.rawValue, 0)
        XCTAssertEqual(UIPress.PressType.downArrow.rawValue, 1)
        XCTAssertEqual(UIPress.PressType.leftArrow.rawValue, 2)
        XCTAssertEqual(UIPress.PressType.rightArrow.rawValue, 3)
        XCTAssertEqual(UIPress.PressType.select.rawValue, 4)
        XCTAssertEqual(UIPress.PressType.menu.rawValue, 5)
        XCTAssertEqual(UIPress.PressType.playPause.rawValue, 6)
        XCTAssertEqual(UIKeyboardHIDUsage.keyboardA.rawValue, 0x04)
        XCTAssertEqual(UIKeyboardHIDUsage.keyboardLeftShift.rawValue, 0xE1)
        XCTAssertEqual(UIKeyboardHIDUsage.keyboardRightShift.rawValue, 0xE5)
        XCTAssertEqual(UIKeyboardHIDUsage.keyboard0.rawValue, 0x27)
    }
    #endif

    func testUnlinkedLongPressCapturesAndDeliversEverything() {
        let p = press()
        XCTAssertTrue(send(play, .down, p, at: 100))
        XCTAssertEqual(timers.count, 1)
        XCTAssertEqual(timers[0].delay, 1.5, accuracy: 0.0001)
        now = 101.5
        timers[0].run()
        XCTAssertEqual(routes, [.remote])
        XCTAssertTrue(send(play, .up, p, at: 101.7))
        XCTAssertEqual(routes, [.remote])
    }

    func testLinkedLongPressAppliesTheReleasePolicy() {
        decision = linked
        let p = press()
        XCTAssertTrue(send(play, .down, p, at: 100), "a long press's down is always delivered")
        now = 101.5
        timers[0].run()
        XCTAssertEqual(routes, [.remote])
        XCTAssertEqual(send(play, .up, p, at: 101.8), !TvGestureDetector.consumesFiredHoldRelease)
        // The next tap is an ordinary tap.
        let next = press()
        XCTAssertTrue(send(play, .down, next, at: 103))
        XCTAssertTrue(send(play, .up, next, at: 103.1))
    }

    func testShortTapNeverRoutes() {
        decision = linked
        let p = press()
        XCTAssertTrue(send(play, .down, p, at: 100))
        XCTAssertTrue(send(play, .up, p, at: 100.3))
        XCTAssertTrue(timers[0].cancelled)
        now = 101.5
        timers[0].run()
        XCTAssertEqual(routes, [])
    }

    func testHeldArrowIsDeliveredAndNeverRoutes() {
        decision = linked
        let p = press()
        XCTAssertTrue(send("DPAD_DOWN", .down, p, at: 100))
        XCTAssertTrue(timers.isEmpty)
        XCTAssertTrue(send("DPAD_DOWN", .up, p, at: 102))
        XCTAssertEqual(routes, [])
    }

    func testLinkedSequenceSwallowsTheCompletingPressBothWays() {
        decision = linked
        binding = konami
        let answers = tap(["DPAD_UP", "DPAD_UP", "DPAD_DOWN", "DPAD_DOWN"])
        XCTAssertEqual(answers.map(\.down), [true, true, true, false])
        XCTAssertEqual(answers.map(\.up), [true, true, true, false])
        XCTAssertEqual(routes, [.remote])
    }

    func testUnlinkedSequenceDeliversEverything() {
        binding = konami
        let answers = tap(["DPAD_UP", "DPAD_UP", "DPAD_DOWN", "DPAD_DOWN"])
        XCTAssertTrue(answers.allSatisfy { $0.down && $0.up })
        XCTAssertEqual(routes, [.remote])
    }

    func testReleaseUnlinkedNeverSwallows() {
        decision = CaptureGestureDecision(action: .nothing, sendHello: true, swallowKeys: false)
        let p = press()
        XCTAssertTrue(send(play, .down, p, at: 100))
        now = 101.5
        timers[0].run()
        XCTAssertTrue(send(play, .up, p, at: 101.6))
        binding = konami
        XCTAssertTrue(tap(["DPAD_UP", "DPAD_UP", "DPAD_DOWN", "DPAD_DOWN"], from: 110).allSatisfy { $0.down && $0.up })
        XCTAssertEqual(routes, [.remote, .remote])
    }

    func testDisarmedNeedsNoPresses() {
        binding = nil
        XCTAssertFalse(input.needsPresses)
        binding = .default
        XCTAssertTrue(input.needsPresses)
    }

    func testBindingChangeMidHoldDoesNotFire() {
        decision = linked
        let p = press()
        XCTAssertTrue(send(play, .down, p, at: 100))
        binding = .longPress(key: play, holdMs: 2000)
        now = 101.5
        timers[0].run()
        XCTAssertEqual(routes, [])
        XCTAssertTrue(send(play, .up, p, at: 102.5))
    }

    func testDisarmMidHoldDoesNotFire() {
        decision = linked
        let p = press()
        XCTAssertTrue(send(play, .down, p, at: 100))
        binding = nil
        now = 101.5
        timers[0].run()
        XCTAssertEqual(routes, [])
        XCTAssertTrue(send(play, .up, p, at: 102))
        XCTAssertFalse(input.needsPresses)
    }

    func testCancelledPressCancelsTheTimer() {
        let p = press()
        XCTAssertTrue(send(play, .down, p, at: 100))
        XCTAssertTrue(send(play, .cancelled, p, at: 100.4))
        XCTAssertTrue(timers[0].cancelled)
        now = 101.5
        timers[0].run()
        XCTAssertEqual(routes, [])
    }

    func testDuplicateDeliveryCountsOnce() {
        decision = linked
        binding = konami
        var answers: [Bool] = []
        for (index, key) in ["DPAD_UP", "DPAD_UP", "DPAD_DOWN", "DPAD_DOWN"].enumerated() {
            let p = press()
            let at = 100 + Double(index) * 0.2
            for phase in [TvKeyPhase.down, .up] {
                let t = phase == .down ? at : at + 0.05
                // UIKit hands the same event to two windows.
                answers.append(send(key, phase, p, at: t))
                answers.append(send(key, phase, p, at: t))
            }
        }
        XCTAssertEqual(routes, [.remote])
        // The duplicate is answered as the first delivery was.
        XCTAssertEqual(answers, [true, true, true, true, true, true, true, true,
                                 true, true, true, true, false, false, false, false])

        binding = .default
        let p = press()
        timers = []
        XCTAssertTrue(send(play, .down, p, at: 110))
        XCTAssertTrue(send(play, .down, p, at: 110))
        XCTAssertEqual(timers.count, 1)
    }

    func testSwallowedPressStaysSwallowedAfterDisarm() {
        decision = linked
        binding = konami
        let presses = (0..<4).map { _ in press() }
        let keys = ["DPAD_UP", "DPAD_UP", "DPAD_DOWN", "DPAD_DOWN"]
        for index in 0..<3 {
            XCTAssertTrue(send(keys[index], .down, presses[index], at: 100 + Double(index) * 0.2))
            XCTAssertTrue(send(keys[index], .up, presses[index], at: 100.05 + Double(index) * 0.2))
        }
        XCTAssertFalse(send("DPAD_DOWN", .down, presses[3], at: 100.6))
        binding = nil
        XCTAssertTrue(input.needsPresses, "the swallowed press's release is still pending")
        XCTAssertFalse(send("DPAD_DOWN", .up, presses[3], at: 100.7))
        XCTAssertFalse(input.needsPresses)
    }

    func testTypingChordStandsAsideWhileEditingText() {
        decision = linked
        binding = .chord(keys: ["SHIFT", "B"])
        editing = true
        let shift = press()
        let b = press()
        XCTAssertTrue(send("SHIFT", .down, shift, at: 100))
        XCTAssertTrue(send("B", .down, b, at: 100.1))
        XCTAssertTrue(send("B", .up, b, at: 100.2))
        XCTAssertTrue(send("SHIFT", .up, shift, at: 100.3))
        XCTAssertEqual(routes, [])
        // Out of the field, the same chord captures.
        editing = false
        let shift2 = press()
        let b2 = press()
        XCTAssertTrue(send("SHIFT", .down, shift2, at: 101))
        XCTAssertFalse(send("B", .down, b2, at: 101.1))
        XCTAssertEqual(routes, [.remote])
    }

    func testTypingHoldDoesNotFireOnceATextInputHasFocus() {
        binding = .longPress(key: "A", holdMs: 1000)
        let p = press()
        XCTAssertTrue(send("A", .down, p, at: 100))
        editing = true
        now = 101
        timers[0].run()
        XCTAssertEqual(routes, [])
    }

    func testPlayPauseHoldStillFiresWhileEditingText() {
        editing = true
        let p = press()
        XCTAssertTrue(send(play, .down, p, at: 100))
        now = 101.5
        timers[0].run()
        XCTAssertEqual(routes, [.remote])
    }

    func testMixedEventIsDeliveredWhenOnlyOnePressIsConsumed() {
        decision = linked
        binding = konami
        let presses = (0..<4).map { _ in press() }
        let keys = ["DPAD_UP", "DPAD_UP", "DPAD_DOWN", "DPAD_DOWN"]
        for index in 0..<3 {
            _ = send(keys[index], .down, presses[index], at: 100 + Double(index) * 0.2)
            _ = send(keys[index], .up, presses[index], at: 100.05 + Double(index) * 0.2)
        }
        XCTAssertFalse(send("DPAD_DOWN", .down, presses[3], at: 100.6))
        // The swallowed press's release arrives together with another press's down.
        now = 100.7
        let other = press()
        XCTAssertTrue(input.handle([
            TvKeyEvent(key: "DPAD_DOWN", phase: .up, press: presses[3], at: 100.7),
            TvKeyEvent(key: "DPAD_LEFT", phase: .down, press: other, at: 100.7),
        ], window: nil))
        XCTAssertTrue(input.handle([], window: nil))
    }

    func testResetForgetsSwallowedPressesAndTheTimer() {
        decision = linked
        let p = press()
        _ = send(play, .down, p, at: 100)
        input.reset()
        XCTAssertTrue(timers[0].cancelled)
        binding = nil
        XCTAssertFalse(input.needsPresses)
    }
}
#endif
