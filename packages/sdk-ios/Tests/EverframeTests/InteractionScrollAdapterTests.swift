// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit
import Testing
@testable import EverframeKit

@MainActor @Suite(.serialized) struct InteractionScrollAdapterTests {
    @Test func revocationBetweenCaptureAndRetentionDoesNotRestoreGesture() {
        let f = InteractionAdapterFixture()
        let adapter = InteractionScrollAdapter(recorder: f.recorder, clock: { f.recorder.revoke(); return 0 })
        adapter.began(f.attach(UIScrollView()), axis: "y")
        #expect(adapter.retainedHosts == 0)
    }
    private final class Delegate: NSObject, UIScrollViewDelegate { var calls = 0; func scrollViewDidScroll(_ scrollView: UIScrollView) { calls += 1 } }
    @Test func gestureAndMomentumCoalesceWithoutReplacingDelegate() {
        let f = InteractionAdapterFixture(), adapter = InteractionScrollAdapter(recorder: f.recorder, clock: { f.now })
        let view = f.attach(UIScrollView(frame: CGRect(x: 0, y: 0, width: 200, height: 200)))
        view.contentSize = CGSize(width: 200, height: 2000)
        let delegate = Delegate(); view.delegate = delegate
        view.contentOffset.y = 5; adapter.moved(view); #expect(f.buffer.size == 0)
        adapter.began(view, axis: "y"); view.contentOffset.y = 50; adapter.moved(view)
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
