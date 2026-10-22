// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

final class CaptureHotkeyTests: XCTestCase {
    private func shift(_ t: TimeInterval, isRepeat: Bool = false) -> CaptureKeyEvent {
        .down(key: .shift, modifiers: [.shift], isRepeat: isRepeat, at: t)
    }

    func testParse() {
        XCTAssertEqual(CaptureHotkeyBinding.parse(nil), .doubleShift)
        XCTAssertEqual(CaptureHotkeyBinding.parse(""), .doubleShift)
        XCTAssertEqual(CaptureHotkeyBinding.parse("Shift Shift"), .doubleShift)
        XCTAssertEqual(CaptureHotkeyBinding.parse("Mod+Shift+B"), .chord(modifiers: [.command, .shift], key: "b"))
        XCTAssertEqual(CaptureHotkeyBinding.parse("Ctrl+Alt+X"), .chord(modifiers: [.control, .option], key: "x"))
        XCTAssertEqual(CaptureHotkeyBinding.parse("Cmd+Opt+k"), .chord(modifiers: [.command, .option], key: "k"))
        XCTAssertEqual(CaptureHotkeyBinding.parse("garbage+++"), .doubleShift)
    }

    func testDoubleShiftFiresWithinWindow() {
        var m = CaptureHotkeyMatcher(binding: .doubleShift)
        XCTAssertFalse(m.feed(shift(0)))
        XCTAssertTrue(m.feed(shift(0.3)))
    }

    func testDoubleShiftOutsideWindowDoesNotFire() {
        var m = CaptureHotkeyMatcher(binding: .doubleShift)
        XCTAssertFalse(m.feed(shift(0)))
        XCTAssertFalse(m.feed(shift(0.5)))
    }

    func testShiftLetterShiftDoesNotFire() {
        var m = CaptureHotkeyMatcher(binding: .doubleShift)
        XCTAssertFalse(m.feed(shift(0)))
        XCTAssertFalse(m.feed(.down(key: .character("b"), modifiers: [.shift], isRepeat: false, at: 0.1)))
        XCTAssertFalse(m.feed(shift(0.2)))
    }

    func testAutoRepeatIgnored() {
        var m = CaptureHotkeyMatcher(binding: .doubleShift)
        XCTAssertFalse(m.feed(shift(0)))
        XCTAssertFalse(m.feed(shift(0.05, isRepeat: true)))
        XCTAssertTrue(m.feed(shift(0.2)))
    }

    func testThirdShiftAfterFireStartsOver() {
        var m = CaptureHotkeyMatcher(binding: .doubleShift)
        XCTAssertFalse(m.feed(shift(0)))
        XCTAssertTrue(m.feed(shift(0.2)))
        XCTAssertFalse(m.feed(shift(0.3)))
    }

    func testChordFires() {
        var m = CaptureHotkeyMatcher(binding: .chord(modifiers: [.command, .shift], key: "b"))
        XCTAssertTrue(m.feed(.down(key: .character("b"), modifiers: [.command, .shift], isRepeat: false, at: 0)))
        XCTAssertFalse(m.feed(.down(key: .character("b"), modifiers: [.shift], isRepeat: false, at: 1)))
    }
}
