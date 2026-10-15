// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit

@MainActor final class InteractionScrollAdapter: NSObject {
    static let shared = InteractionScrollAdapter(recorder: .shared)
    private final class Gesture: @unchecked Sendable {
        weak var view: UIScrollView?
        // Access only through Store; revocation drops content synchronously off-main.
        var owner: InteractionOwner?
        let axis: String, remote: Bool, tracksTouch: Bool
        weak var touch: UITouch?
        var start: CGFloat, last: CGFloat, time: Double, moved = false, recognized = false
        var observation: NSKeyValueObservation?
        init(_ view: UIScrollView, _ owner: InteractionOwner, _ axis: String, _ position: CGFloat, _ time: Double, remote: Bool, touch: UITouch?) {
            self.view = view; self.owner = owner; self.axis = axis; self.start = position; self.last = position; self.time = time
            self.remote = remote; self.touch = touch; self.tracksTouch = touch != nil
        }
    }
    private final class Store: @unchecked Sendable {
        private let lock = NSLock()
        private var entries: [Gesture] = []
        func all() -> [Gesture] { lock.lock(); defer { lock.unlock() }; return entries }
        func owner(_ item: Gesture) -> InteractionOwner? { lock.lock(); defer { lock.unlock() }; return entries.contains(where: { $0 === item }) ? item.owner : nil }
        func append(_ item: Gesture) { lock.lock(); defer { lock.unlock() }; entries.append(item) }
        func remove(_ item: Gesture) { lock.lock(); defer { lock.unlock() }; entries.removeAll { $0 === item }; item.owner = nil }
        func reset() -> [Gesture] {
            lock.lock(); defer { lock.unlock() }
            let old = entries; entries.removeAll(); old.forEach { $0.owner = nil }; return old
        }
    }
    private let recorder: InteractionEventRecorder, clock: () -> Double
    private let store = Store()
    init(recorder: InteractionEventRecorder, clock: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime * 1000 }) {
        self.recorder = recorder; self.clock = clock
        super.init()
        let store = self.store
        recorder.onRevoked { [weak self, weak store] in
            let old = store?.reset() ?? []
            DispatchQueue.main.async { [weak self] in old.forEach { self?.detach($0) } }
        }
    }
    var retainedHosts: Int { store.all().count }
    func began(_ view: UIScrollView, axis: String, touch: UITouch? = nil) {
        begin(view, axis: axis, remote: false, touch: touch)
    }
    private func begin(_ view: UIScrollView, axis: String, remote: Bool, touch: UITouch? = nil) {
        guard ["x", "y"].contains(axis), !recorder.suppresses(view: view, type: "scroll") else { return }
        finished(view)
        guard let owner = recorder.owner(view: view) else { return }
        if let oldest = store.all().first, retainedHosts >= 32 { remove(oldest, cancel: true) }
        let position = axis == "x" ? view.contentOffset.x : view.contentOffset.y
        let gesture = Gesture(view, owner, axis, position, clock(), remote: remote, touch: touch)
        guard recorder.retainIfCurrent(owner, { store.append(gesture) }) else { return }
        gesture.observation = view.observe(\.contentOffset, options: [.new]) { [weak self, weak view] _, _ in
            guard Thread.isMainThread, let view else { return }
            MainActor.assumeIsolated { self?.moved(view) }
        }
        view.panGestureRecognizer.addTarget(self, action: #selector(panChanged(_:)))
        scheduleCleanup(gesture)
    }
    func remoteBegan(_ view: UIScrollView, axis: String) {
        guard ["x", "y"].contains(axis) else { return }
        // A directional press can move an ancestor rather than the nearest rail.
        // Observe eligible ancestors; only the containers that move emit evidence.
        var current: UIView? = view
        for _ in 0..<32 {
            guard let candidate = current else { break }
            current = candidate.superview
            guard let scroll = candidate as? UIScrollView, scroll.isScrollEnabled else { continue }
            let extent = axis == "x"
                ? scroll.contentSize.width + scroll.adjustedContentInset.left + scroll.adjustedContentInset.right - scroll.bounds.width
                : scroll.contentSize.height + scroll.adjustedContentInset.top + scroll.adjustedContentInset.bottom - scroll.bounds.height
            guard extent > 0 else { continue }
            if let old = store.all().first(where: { $0.view === scroll }), old.remote, old.axis == axis, clock() - old.time < 200 { continue }
            begin(scroll, axis: axis, remote: true)
        }
    }
    func moved(_ view: UIScrollView) {
        guard let gesture = store.all().first(where: { $0.view === view }) else { return }
        guard view.window != nil, !recorder.suppresses(view: view, type: "scroll") else { remove(gesture, cancel: true); return }
        let position = gesture.axis == "x" ? view.contentOffset.x : view.contentOffset.y
        if !gesture.remote, !gesture.recognized {
            guard view.isDragging || [.began, .changed].contains(view.panGestureRecognizer.state) else {
                // Motion before recognition belongs to the app, not this touch.
                gesture.start = position; gesture.last = position; return
            }
            gesture.recognized = true
        }
        if gesture.moved, clock() - gesture.time >= 200, !view.isDragging, !view.isDecelerating { remove(gesture, cancel: false); return }
        guard position != gesture.last else { return }
        gesture.last = position; gesture.time = clock(); gesture.moved = true
        guard position != gesture.start else { recorder.cancel(host: view, type: "scroll"); return }
        guard let owner = store.owner(gesture) else { return }
        _ = recorder.observe(.init(owner: owner, event: nativeInteractionEvent("scroll", ["axis": gesture.axis, "direction": position > gesture.start ? "forward" : "backward"])))
    }
    func finished(_ view: UIScrollView) {
        guard let gesture = store.all().first(where: { $0.view === view }) else { return }
        if gesture.moved { recorder.complete(host: view, type: "scroll", reason: "end") }
        remove(gesture, cancel: false)
    }
    func close() { store.all().forEach { remove($0, cancel: true) } }
    private func remove(_ gesture: Gesture, cancel: Bool) {
        store.remove(gesture); detach(gesture)
        if cancel, let view = gesture.view { recorder.cancel(host: view, type: "scroll") }
    }
    private func detach(_ gesture: Gesture) {
        gesture.observation?.invalidate(); gesture.observation = nil
        gesture.view?.panGestureRecognizer.removeTarget(self, action: #selector(panChanged(_:)))
    }
    private func scheduleCleanup(_ gesture: Gesture) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self, weak gesture] in
            guard let self, let gesture, self.store.owner(gesture) != nil else { return }
            guard let view = gesture.view, view.window != nil else { self.remove(gesture, cancel: true); return }
            let touchEnded = gesture.tracksTouch && (gesture.touch == nil || gesture.touch?.phase == .ended || gesture.touch?.phase == .cancelled)
            let panEnded = [.failed, .cancelled, .ended].contains(view.panGestureRecognizer.state)
            if !view.isDragging, !view.isDecelerating,
               touchEnded || (!gesture.remote && panEnded) || ((gesture.remote || gesture.recognized) && self.clock() - gesture.time >= 200) {
                self.finished(view)
            } else { self.scheduleCleanup(gesture) }
        }
    }
    @objc private func panChanged(_ pan: UIPanGestureRecognizer) {
        guard let view = pan.view as? UIScrollView else { return }
        moved(view)
        if pan.state == .cancelled || pan.state == .failed { finished(view) }
        else if pan.state == .ended, !view.isDecelerating { finished(view) }
    }
    static func container(_ view: UIView?) -> UIScrollView? {
        var current = view
        for _ in 0..<32 { guard let view = current else { return nil }; if let scroll = view as? UIScrollView { return scroll }; current = view.superview }
        return nil
    }
    func beforeEvent(_ event: UIEvent, window: UIWindow) {
        if event.type == .touches, let touch = event.allTouches?.first(where: { $0.phase == .began }),
           let scroll = Self.container(touch.view ?? window.hitTest(touch.location(in: window), with: nil)) {
            began(scroll, axis: scroll.contentSize.width > scroll.bounds.width && scroll.contentSize.height <= scroll.bounds.height ? "x" : "y", touch: touch)
        }
        #if os(tvOS)
        if let presses = event as? UIPressesEvent, let press = presses.allPresses.first(where: { $0.phase == .began }),
           [.upArrow, .downArrow, .leftArrow, .rightArrow].contains(press.type),
           let scroll = Self.container(WindowTapBreadcrumbAdapter.focusedView(in: window)) {
            remoteBegan(scroll, axis: [.leftArrow, .rightArrow].contains(press.type) ? "x" : "y")
        }
        #endif
    }
    func afterEvent(_ event: UIEvent) {
        for gesture in store.all() {
            guard let view = gesture.view else { remove(gesture, cancel: true); continue }
            moved(view)
            if event.type == .touches, event.allTouches?.contains(where: { ($0.phase == .ended || $0.phase == .cancelled) && (!gesture.tracksTouch || $0 === gesture.touch) }) == true,
               !view.isDragging, !view.isDecelerating { finished(view) }
        }
    }
}
#endif
