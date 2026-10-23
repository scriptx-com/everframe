// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

/// Record on device: the keys pressed, as whole milliseconds from the first key-down.
final class GestureRecorderTests: XCTestCase {
    private var objects: [NSObject] = []

    private func press() -> ObjectIdentifier {
        let object = NSObject()
        objects.append(object)
        return ObjectIdentifier(object)
    }

    private func event(_ key: String?, _ phase: TvKeyPhase, _ press: ObjectIdentifier, _ at: TimeInterval) -> TvKeyEvent {
        TvKeyEvent(key: key, phase: phase, press: press, at: at)
    }

    func testTimesAreRelativeToTheFirstDown() {
        var recorder = GestureRecorder()
        let first = press()
        let second = press()
        recorder.feed(event("DPAD_UP", .down, first, 100.0))
        recorder.feed(event("DPAD_UP", .up, first, 100.08))
        recorder.feed(event("DPAD_UP", .down, second, 100.3))
        recorder.feed(event("DPAD_UP", .up, second, 100.38))
        XCTAssertEqual(recorder.finish(now: 110), [
            RecordedKey(key: "DPAD_UP", downMs: 0, upMs: 80),
            RecordedKey(key: "DPAD_UP", downMs: 300, upMs: 380),
        ])
    }

    func testHeldKeyAtFinishGetsNow() {
        var recorder = GestureRecorder()
        let p = press()
        recorder.feed(event("MEDIA_PLAY_PAUSE", .down, p, 50.0))
        XCTAssertEqual(recorder.finish(now: 51.62), [RecordedKey(key: "MEDIA_PLAY_PAUSE", downMs: 0, upMs: 1620)])
    }

    func testUnmappedKeysAreDropped() {
        var recorder = GestureRecorder()
        let unmapped = press()
        let mapped = press()
        recorder.feed(event(nil, .down, unmapped, 1.0))
        recorder.feed(event(nil, .up, unmapped, 1.1))
        recorder.feed(event("BACK", .down, mapped, 1.5))
        recorder.feed(event("BACK", .up, mapped, 1.6))
        XCTAssertEqual(recorder.finish(now: 2), [RecordedKey(key: "BACK", downMs: 0, upMs: 100)])
    }

    func testCapsAt32() {
        var recorder = GestureRecorder()
        for index in 0..<40 {
            let p = press()
            recorder.feed(event("DPAD_DOWN", .down, p, Double(index)))
            recorder.feed(event("DPAD_DOWN", .up, p, Double(index) + 0.05))
        }
        let events = recorder.finish(now: 50)
        XCTAssertEqual(events.count, GestureRecorder.maxEvents)
        XCTAssertEqual(GestureRecorder.maxEvents, 32)
        XCTAssertEqual(events.last, RecordedKey(key: "DPAD_DOWN", downMs: 31_000, upMs: 31_050))
    }

    func testCancelledPressEndsAtCancel() {
        var recorder = GestureRecorder()
        let p = press()
        recorder.feed(event("DPAD_CENTER", .down, p, 5.0))
        recorder.feed(event("DPAD_CENTER", .cancelled, p, 5.4))
        XCTAssertEqual(recorder.finish(now: 9), [RecordedKey(key: "DPAD_CENTER", downMs: 0, upMs: 400)])
    }

    func testNoKeysIsEmpty() {
        XCTAssertEqual(GestureRecorder().finish(now: 1), [])
        XCTAssertEqual(GestureRecorder.duration, 10)
    }

    func testAReleaseWithoutItsDownIsIgnored() {
        var recorder = GestureRecorder()
        recorder.feed(event("DPAD_UP", .up, press(), 1.0))
        XCTAssertEqual(recorder.finish(now: 2), [])
    }

    func testEncodesTheContractShape() throws {
        let data = try JSONEncoder().encode(RecordedKey(key: "MEDIA_PLAY_PAUSE", downMs: 0, upMs: 1620))
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["key", "downMs", "upMs"])
    }
}
