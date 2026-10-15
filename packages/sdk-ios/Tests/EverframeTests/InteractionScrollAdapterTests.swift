// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit
import Testing
@testable import EverframeKit

@MainActor @Suite(.serialized) struct InteractionScrollAdapterTests {
    private final class DragScrollView: UIScrollView {
        var recognizedDrag = false
        override var isDragging: Bool { recognizedDrag }
    }
    private final class Touch: UITouch {
        var currentPhase: UITouch.Phase = .began
        override var phase: UITouch.Phase { currentPhase }
    }
    @Test func endedPendingTouchIsCleanedWithoutMotion() async throws {
        let f = InteractionAdapterFixture(), adapter = InteractionScrollAdapter(recorder: f.recorder, clock: { f.now })
        defer { adapter.close() }
        let view = f.attach(UIScrollView()), touch = Touch()
        adapter.began(view, axis: "y", touch: touch)
        touch.currentPhase = .ended; f.now = 250
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(adapter.retainedHosts == 0); #expect(f.buffer.size == 0)
    }
    @Test func movementBeforeRecognitionDoesNotAffectDragDirection() {
        let f = InteractionAdapterFixture(), adapter = InteractionScrollAdapter(recorder: f.recorder, clock: { f.now })
        defer { adapter.close() }
        let view = f.attach(DragScrollView())
        adapter.began(view, axis: "y")
        view.contentOffset.y = 100
        view.recognizedDrag = true; view.contentOffset.y = 80; adapter.finished(view)
        #expect(f.buffer.size == 1)
        #expect(f.events.last?["direction"] as? String == "backward")
    }
    @Test func heldTouchCanRecognizeDragAfterIdleWindow() async throws {
        let f = InteractionAdapterFixture(), adapter = InteractionScrollAdapter(recorder: f.recorder, clock: { f.now })
        defer { adapter.close() }
        let view = f.attach(DragScrollView(frame: CGRect(x: 0, y: 0, width: 100, height: 100)))
        view.contentSize = CGSize(width: 100, height: 1000)
        let touch = Touch()
        adapter.began(view, axis: "y", touch: touch)
        f.now = 250; try await Task.sleep(nanoseconds: 300_000_000)
        #expect(adapter.retainedHosts == 1)
        view.recognizedDrag = true; view.contentOffset.y = 100
        adapter.moved(view); view.recognizedDrag = false; adapter.finished(view)
        #expect(f.buffer.size == 1)
    }
    @Test func unrecognizedTouchCannotClaimProgrammaticMovement() {
        let f = InteractionAdapterFixture(), adapter = InteractionScrollAdapter(recorder: f.recorder, clock: { f.now })
        defer { adapter.close() }
        let view = f.attach(UIScrollView(frame: CGRect(x: 0, y: 0, width: 100, height: 100)))
        view.contentSize = CGSize(width: 100, height: 1000)
        adapter.began(view, axis: "y"); view.contentOffset.y = 100; adapter.finished(view)
        #expect(f.buffer.size == 0)
    }
    @Test func remoteDirectionObservesMovingAncestorOfNestedRail() {
        let f = InteractionAdapterFixture(), adapter = InteractionScrollAdapter(recorder: f.recorder, clock: { f.now })
        defer { adapter.close() }
        let outer = f.attach(UIScrollView(frame: CGRect(x: 0, y: 0, width: 100, height: 100)))
        outer.contentSize = CGSize(width: 100, height: 1000)
        let rail = UIScrollView(frame: outer.bounds); outer.addSubview(rail)
        rail.contentSize = CGSize(width: 1000, height: 100)
        let item = UIView(); rail.addSubview(item)
        // Same entry point used before UIKit delivers a directional remote press.
        adapter.remoteBegan(rail, axis: "y")
        outer.contentOffset.y = 100; adapter.finished(outer)
        #expect(f.buffer.size == 1)
        #expect(f.events.last?["axis"] as? String == "y")
        #expect(f.events.last?["direction"] as? String == "forward")
        adapter.remoteBegan(rail, axis: "x")
        rail.contentOffset.x = 100; adapter.finished(rail)
        #expect(f.buffer.size == 2)
        #expect(f.events.last?["axis"] as? String == "x")
    }
    @Test func revocationBetweenCaptureAndRetentionDoesNotRestoreGesture() {
        let f = InteractionAdapterFixture()
        let adapter = InteractionScrollAdapter(recorder: f.recorder, clock: { f.recorder.revoke(); return 0 })
        adapter.began(f.attach(UIScrollView()), axis: "y")
        #expect(adapter.retainedHosts == 0)
    }
    private final class Delegate: NSObject, UIScrollViewDelegate { var calls = 0; func scrollViewDidScroll(_ scrollView: UIScrollView) { calls += 1 } }
    @Test func gestureAndMomentumCoalesceWithoutReplacingDelegate() {
        let f = InteractionAdapterFixture(), adapter = InteractionScrollAdapter(recorder: f.recorder, clock: { f.now })
        let view = f.attach(DragScrollView(frame: CGRect(x: 0, y: 0, width: 200, height: 200)))
        view.contentSize = CGSize(width: 200, height: 2000)
        let delegate = Delegate(); view.delegate = delegate
        view.contentOffset.y = 5; adapter.moved(view); #expect(f.buffer.size == 0)
        adapter.began(view, axis: "y"); view.recognizedDrag = true; view.contentOffset.y = 50; adapter.moved(view)
        f.now = 100; view.contentOffset.y = 100; adapter.moved(view)
        f.now = 299; f.recorder.flushDue(); #expect(f.buffer.size == 0)
        adapter.finished(view); f.now = 1000; f.recorder.flushDue()
        #expect(f.buffer.size == 1); #expect(f.events.last?["direction"] as? String == "forward")
        #expect(view.delegate === delegate); #expect(delegate.calls > 0)
        adapter.close()
    }
    @Test func focusWithoutMovementAndStaleGesturesProduceNoSummary() {
        let f = InteractionAdapterFixture(), adapter = InteractionScrollAdapter(recorder: f.recorder, clock: { f.now })
        let view = f.attach(UIScrollView()); view.contentSize = CGSize(width: 2000, height: 200)
        adapter.began(view, axis: "x"); adapter.moved(view); adapter.finished(view); #expect(f.buffer.size == 0)
        adapter.began(view, axis: "x"); #expect(adapter.retainedHosts == 1)
        f.buffer.clear(); #expect(adapter.retainedHosts == 0)
        view.contentOffset.x = 100; adapter.moved(view); adapter.finished(view); #expect(f.buffer.size == 0)
        adapter.close()
    }
}
#endif
