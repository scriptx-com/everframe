// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

final class TvRemoteKeysTests: XCTestCase {
    func testMapsSiriRemotePressTypes() {
        let names = (0...6).map { TvRemoteKeys.name(pressType: $0, keyUsage: nil) }
        XCTAssertEqual(names, ["DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT", "DPAD_CENTER", "BACK", "MEDIA_PLAY_PAUSE"])
    }

    func testMapsKeyboardUsages() {
        // A hardware keyboard's keys arrive with a press type outside 0…6.
        func key(_ usage: Int) -> String? { TvRemoteKeys.name(pressType: 2000, keyUsage: usage) }
        XCTAssertEqual(key(0x04), "A")
        XCTAssertEqual(key(0x05), "B")
        XCTAssertEqual(key(0x1D), "Z")
        XCTAssertEqual(key(0x1E), "1")
        XCTAssertEqual(key(0x26), "9")
        XCTAssertEqual(key(0x27), "0")
        XCTAssertEqual(key(0xE1), "SHIFT")
        XCTAssertEqual(key(0xE5), "SHIFT")
    }

    func testUnmappedIsNil() {
        for type in 30...33 { XCTAssertNil(TvRemoteKeys.name(pressType: type, keyUsage: nil)) }
        XCTAssertNil(TvRemoteKeys.name(pressType: 2000, keyUsage: 0x28))
        XCTAssertNil(TvRemoteKeys.name(pressType: 2000, keyUsage: 0x03))
        XCTAssertNil(TvRemoteKeys.name(pressType: 2000, keyUsage: 0xE0))
    }

    func testPressTypeWinsOverUsage() {
        XCTAssertEqual(TvRemoteKeys.name(pressType: 6, keyUsage: 0x2C), "MEDIA_PLAY_PAUSE")
    }

    func testReachableKeys() {
        XCTAssertEqual(TvRemoteKeys.reachable.count, 7 + 26 + 10 + 1)
        for key in ["MENU", "MEDIA_FAST_FORWARD", "MEDIA_REWIND", "PROG_RED", "PROG_GREEN", "PROG_YELLOW", "PROG_BLUE"] {
            XCTAssertFalse(TvRemoteKeys.reachable.contains(key), key)
        }
        XCTAssertTrue(TvRemoteKeys.reachable.isSubset(of: TvGestureBinding.contractKeys))
    }

    func testEffectiveBinding() {
        XCTAssertNil(TvRemoteKeys.effectiveBinding(nil))
        XCTAssertEqual(TvRemoteKeys.effectiveBinding(.chord(keys: ["PROG_RED", "PROG_BLUE"])), .default)
        XCTAssertEqual(TvRemoteKeys.effectiveBinding(.longPress(key: "MENU", holdMs: 1500)), .default)
        let dpad = TvGestureBinding.sequence(keys: ["DPAD_UP", "DPAD_UP", "DPAD_DOWN", "DPAD_DOWN"], windowMs: 1000)
        XCTAssertEqual(TvRemoteKeys.effectiveBinding(dpad), dpad)
        XCTAssertEqual(TvRemoteKeys.effectiveBinding(.chord(keys: ["SHIFT", "B"])), .chord(keys: ["SHIFT", "B"]))
    }
}
