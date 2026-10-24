// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

/// The `captureGesture` block: the app's TV binding, validated like the
/// server's schema. An invalid `tv` means no TV gesture, never a failed config.
final class CaptureGestureConfigTests: XCTestCase {
    private func body(_ block: String) -> Data {
        Data((#"{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1,"# + block + "}").utf8)
    }

    private func tv(_ raw: String) throws -> TvGestureBinding? {
        let config = try ReplayConfigProvider.__decodeForTesting(body(#""captureGesture":{"tv":"# + raw + "}"))
        XCTAssertNotNil(config.captureGesture, raw)
        XCTAssertTrue(config.replayEnabled)
        return config.captureGesture?.tv
    }

    func testDecodesTheContractDefault() throws {
        XCTAssertEqual(try tv(#"{"kind":"longPress","keys":["MEDIA_PLAY_PAUSE"],"holdMs":1500}"#), .default)
        XCTAssertEqual(TvGestureBinding.default, .longPress(key: "MEDIA_PLAY_PAUSE", holdMs: 1500))
    }

    func testDecodesSequenceAndChord() throws {
        XCTAssertEqual(
            try tv(#"{"kind":"sequence","keys":["DPAD_UP","DPAD_UP","DPAD_DOWN","DPAD_DOWN"],"windowMs":1000}"#),
            .sequence(keys: ["DPAD_UP", "DPAD_UP", "DPAD_DOWN", "DPAD_DOWN"], windowMs: 1000))
        XCTAssertEqual(try tv(#"{"kind":"chord","keys":["SHIFT","B"]}"#), .chord(keys: ["SHIFT", "B"]))
        // The bounds are inclusive.
        XCTAssertEqual(try tv(#"{"kind":"longPress","keys":["DPAD_CENTER"],"holdMs":500}"#),
                       .longPress(key: "DPAD_CENTER", holdMs: 500))
        XCTAssertEqual(try tv(#"{"kind":"longPress","keys":["BACK"],"holdMs":5000}"#),
                       .longPress(key: "BACK", holdMs: 5000))
        XCTAssertEqual(try tv(#"{"kind":"sequence","keys":["A","B"],"windowMs":300}"#),
                       .sequence(keys: ["A", "B"], windowMs: 300))
        XCTAssertEqual(try tv(#"{"kind":"chord","keys":["SHIFT","A","1","0"]}"#), .chord(keys: ["SHIFT", "A", "1", "0"]))
    }

    func testRejectsInvalidBindings() throws {
        let invalid = [
            #"{"kind":"longPress","keys":["MEDIA_PLAY_PAUSE"],"holdMs":499}"#,
            #"{"kind":"longPress","keys":["MEDIA_PLAY_PAUSE"],"holdMs":5001}"#,
            #"{"kind":"longPress","keys":["MEDIA_PLAY_PAUSE"],"holdMs":1500.5}"#,
            #"{"kind":"longPress","keys":["MEDIA_PLAY_PAUSE"],"holdMs":true}"#,
            #"{"kind":"longPress","keys":["MEDIA_PLAY_PAUSE"]}"#,
            #"{"kind":"longPress","keys":["MEDIA_PLAY_PAUSE","DPAD_UP"],"holdMs":1500}"#,
            #"{"kind":"sequence","keys":["DPAD_UP"],"windowMs":1000}"#,
            #"{"kind":"sequence","keys":["A","A","A","A","A","A","A","A","A"],"windowMs":1000}"#,
            #"{"kind":"sequence","keys":["DPAD_UP","DPAD_DOWN"],"windowMs":299}"#,
            #"{"kind":"sequence","keys":["DPAD_UP","DPAD_DOWN"],"windowMs":5001}"#,
            #"{"kind":"chord","keys":["A","A"]}"#,
            #"{"kind":"chord","keys":["A"]}"#,
            #"{"kind":"chord","keys":["A","B","C","D","E"]}"#,
            #"{"kind":"longPress","keys":["VOLUME_UP"],"holdMs":1500}"#,
            #"{"kind":"swipe","keys":["DPAD_UP"]}"#,
            #"{"kind":"longPress","keys":"MEDIA_PLAY_PAUSE","holdMs":1500}"#,
            #"{"keys":["MEDIA_PLAY_PAUSE"],"holdMs":1500}"#,
            #""longPress""#,
        ]
        for raw in invalid {
            XCTAssertNil(try tv(raw), raw)
        }
    }

    func testMissingOrNonObjectBlockIsNil() throws {
        XCTAssertNil(try ReplayConfigProvider.__decodeForTesting(body(#""captureHotkey":{"enabled":true}"#)).captureGesture)
        for raw in ["true", "[]", #""tv""#, "null", "1"] {
            let config = try ReplayConfigProvider.__decodeForTesting(body(#""captureGesture":"# + raw))
            XCTAssertNil(config.captureGesture, raw)
            XCTAssertTrue(config.replayEnabled)
        }
        // A block without `tv` is a block with no TV gesture.
        let empty = try ReplayConfigProvider.__decodeForTesting(body(#""captureGesture":{}"#))
        XCTAssertEqual(empty.captureGesture, CaptureGestureConfigWire(tv: nil))
        XCTAssertNil(ReplayConfig.off.captureGesture)
    }

    func testKeysAndTextInputYield() {
        XCTAssertEqual(TvGestureBinding.default.keys, ["MEDIA_PLAY_PAUSE"])
        XCTAssertFalse(TvGestureBinding.default.yieldsToTextInput)
        XCTAssertFalse(TvGestureBinding.sequence(keys: ["DPAD_UP", "DPAD_DOWN"], windowMs: 1000).yieldsToTextInput)
        XCTAssertTrue(TvGestureBinding.chord(keys: ["SHIFT", "B"]).yieldsToTextInput)
        XCTAssertTrue(TvGestureBinding.sequence(keys: ["DPAD_UP", "7"], windowMs: 1000).yieldsToTextInput)
        XCTAssertEqual(TvGestureBinding.contractKeys.count, 14 + 26 + 10 + 1)
    }

    #if os(tvOS)
    func testTvOSDeclaresCaptureGesture() {
        XCTAssertTrue(ReplayConfigProvider.sdkFeaturesHeaderValue.hasSuffix(", devicelinking, capturegesture"))
    }
    #else
    func testOtherPlatformsNeverDeclareCaptureGesture() {
        XCTAssertTrue(ReplayConfigProvider.sdkFeaturesHeaderValue.hasSuffix(", devicelinking"))
    }
    #endif
}
