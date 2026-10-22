// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

/// The UIPress -> CaptureKeyEvent mapping, on raw values so it runs on the host.
/// `QuickCaptureTests` pins the raw values against UIKit's own constants.
final class CaptureKeyMappingTests: XCTestCase {
    private typealias M = CaptureKeyMapping

    private func event(
        _ keyCode: Int, _ characters: String = "", flags: Int = 0, began: Bool = true, at: TimeInterval = 1
    ) -> CaptureKeyEvent? {
        M.event(keyCode: keyCode, charactersIgnoringModifiers: characters,
                modifierFlags: flags, began: began, at: at)
    }

    private func parts(_ e: CaptureKeyEvent?) -> (CaptureKey, CaptureKeyModifiers, Bool, TimeInterval)? {
        guard case let .down(key, modifiers, isRepeat, at)? = e else { return nil }
        return (key, modifiers, isRepeat, at)
    }

    func testLeftAndRightShiftMapToShift() {
        XCTAssertEqual(parts(event(M.leftShiftUsage, flags: M.shiftFlag))?.0, .shift)
        XCTAssertEqual(parts(event(M.rightShiftUsage, flags: M.shiftFlag))?.0, .shift)
        // A Shift key-down carries the Shift flag and no characters.
        XCTAssertEqual(parts(event(M.leftShiftUsage, flags: M.shiftFlag))?.1, [.shift])
    }

    func testLettersAreLowercased() {
        XCTAssertEqual(parts(event(0x05, "B", flags: M.shiftFlag))?.0, .character("b"))
        XCTAssertEqual(parts(event(0x05, "b"))?.0, .character("b"))
    }

    func testEmptyCharactersMapToOther() {
        XCTAssertEqual(parts(event(0xE0, ""))?.0, .other) // left Control
    }

    func testNonBeganPhaseIsDropped() {
        XCTAssertNil(event(M.leftShiftUsage, flags: M.shiftFlag, began: false))
        XCTAssertNil(event(0x05, "b", began: false))
    }

    func testModifierFlagsMap() {
        let all = M.shiftFlag | M.controlFlag | M.optionFlag | M.commandFlag
        XCTAssertEqual(parts(event(0x05, "b", flags: all))?.1, [.shift, .control, .option, .command])
        XCTAssertEqual(parts(event(0x05, "b", flags: M.commandFlag | M.shiftFlag))?.1, [.command, .shift])
        // Caps Lock and other bits are not chord modifiers.
        XCTAssertEqual(parts(event(0x05, "b", flags: 1 << 16 | 1 << 21))?.1, [])
    }

    /// UIPress reports no auto-repeat, so every mapped key-down is a fresh press.
    func testIsRepeatIsFalseAndTimestampPassesThrough() {
        let p = parts(event(M.leftShiftUsage, flags: M.shiftFlag, at: 42.5))
        XCTAssertEqual(p?.2, false)
        XCTAssertEqual(p?.3, 42.5)
    }

    func testMappedDoubleShiftFiresTheMatcher() {
        var matcher = CaptureHotkeyMatcher(binding: .doubleShift)
        let first = event(M.leftShiftUsage, flags: M.shiftFlag, at: 10)!
        let second = event(M.rightShiftUsage, flags: M.shiftFlag, at: 10.2)!
        XCTAssertFalse(matcher.feed(first))
        XCTAssertTrue(matcher.feed(second))
    }
}
