// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit

final class InteractionControlChange {
    let owner: InteractionOwner, timestamp: TimeInterval
    var initialSwitchState: Bool?
    var completed = false
    init(_ owner: InteractionOwner, _ timestamp: TimeInterval) { self.owner = owner; self.timestamp = timestamp }
}
@MainActor final class InteractionControlAdapter {
    static let shared = InteractionControlAdapter(recorder: .shared)
    private let recorder: InteractionEventRecorder
    private let clock: () -> Double
    private final class TouchOwner {
        let id: ObjectIdentifier, owner: InteractionOwner, initialState: Bool
        let timestamp: TimeInterval
        var deadline: Double, ended = false
        init(_ id: ObjectIdentifier, _ owner: InteractionOwner, _ initialState: Bool, _ timestamp: TimeInterval, _ deadline: Double) {
            self.id = id; self.owner = owner; self.initialState = initialState
            self.timestamp = timestamp; self.deadline = deadline
        }
    }
    // Only the store retains touch owners. Revocation drops their targets immediately,
    // including when clear/sign-out/configuration runs off the main thread.
    private final class TouchStore: @unchecked Sendable {
        private let lock = NSLock()
        private var entries: [TouchOwner] = []
        func update<T>(_ body: (inout [TouchOwner]) -> T) -> T {
            lock.lock(); defer { lock.unlock() }; return body(&entries)
        }
        func reset() { update { $0.removeAll() } }
    }
    private let touches = TouchStore()
    private var cleanupScheduled = false
    private final class Marker { let timestamp: TimeInterval; let state: String; init(_ timestamp: TimeInterval, _ state: String) { self.timestamp = timestamp; self.state = state } }
    private let last = NSMapTable<UIView, Marker>.weakToStrongObjects()
    init(recorder: InteractionEventRecorder, clock: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime * 1000 }) {
        self.recorder = recorder; self.clock = clock
        let touches = self.touches
        recorder.onRevoked { [weak touches] in touches?.reset() }
    }
    var retainedTouches: Int { touches.update { $0.count } }
    func beforeEvent(_ event: UIEvent, window: UIWindow) {
        guard event.type == .touches else { return }
        for touch in event.allTouches ?? [] {
            if let view = touch.view ?? window.hitTest(touch.location(in: window), with: nil) {
                self.touch(view, id: ObjectIdentifier(touch), phase: touch.phase, timestamp: event.timestamp)
            }
        }
    }
    // UISwitch can send valueChanged after CA commit, with a nil UIEvent and
    // isTracking == false. Accept that callback only for a recently ended real touch.
    func touch(_ source: UIView, id: ObjectIdentifier, phase: UITouch.Phase, timestamp: TimeInterval) {
        #if !os(tvOS)
        pruneTouches()
        if phase == .began {
            touches.update { $0.removeAll { $0.id == id } }
            var current: UIView? = source
            for _ in 0..<32 {
                guard let view = current else { break }
                if let control = view as? UISwitch {
                    guard let change = begin(control, eventTimestamp: timestamp) else { return }
                    let entry = TouchOwner(id, change.owner, control.isOn, timestamp, clock() + 5000)
                    guard recorder.retainIfCurrent(change.owner, {
                        touches.update {
                            $0.removeAll { $0.owner.host === control }
                            if $0.count >= 32 { $0.removeFirst() }
                            $0.append(entry)
                        }
                    }) else { return }
                    scheduleCleanup(); return
                }
                current = view.superview
            }
        } else {
            touches.update { entries in
                if phase == .cancelled { entries.removeAll { $0.id == id }; return }
                guard let entry = entries.first(where: { $0.id == id }), !entry.ended else { return }
                entry.ended = phase == .ended
                entry.deadline = clock() + (entry.ended ? 250 : 5000)
            }
        }
        #endif
    }
    func beginAction(_ view: UIView, event: UIEvent?) -> InteractionControlChange? {
        if let event {
            guard event.type == .touches || event.type == .presses else { return nil }
            // A regular UIKit action needs no deferred fallback afterwards.
            touches.update { $0.removeAll { $0.owner.host === view } }
            return begin(view, eventTimestamp: event.timestamp)
        }
        #if !os(tvOS)
        guard let control = view as? UISwitch else { return nil }
        pruneTouches()
        let entry = touches.update { entries -> TouchOwner? in
            guard let index = entries.firstIndex(where: { $0.owner.host === view && $0.ended }) else { return nil }
            return entries.remove(at: index)
        }
        guard let entry, entry.initialState != control.isOn else { return nil }
        let change = InteractionControlChange(entry.owner, entry.timestamp)
        change.initialSwitchState = entry.initialState
        return change
        #else
        return nil
        #endif
    }
    private func pruneTouches() {
        let now = clock()
        touches.update { $0.removeAll { $0.owner.host == nil || $0.deadline <= now } }
    }
    private func scheduleCleanup() {
        guard !cleanupScheduled else { return }; cleanupScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            guard let self else { return }
            self.cleanupScheduled = false; self.pruneTouches()
            if self.retainedTouches > 0 { self.scheduleCleanup() }
        }
    }
    func begin(_ view: UIView, eventTimestamp: TimeInterval) -> InteractionControlChange? {
        guard state(view) != nil, !recorder.suppresses(view: view, type: "control_change"), let owner = recorder.owner(view: view),
              WindowTapBreadcrumbAdapter.interactionDispatchRevision.map({ $0 == owner.revision }) ?? true else { return nil }
        return InteractionControlChange(owner, eventTimestamp)
    }
    @discardableResult func complete(_ change: InteractionControlChange) -> Bool {
        guard !change.completed else { return false }; change.completed = true
        guard let view = change.owner.host, !recorder.suppresses(view: view, type: "control_change"), let fields = state(view) else { return false }
        if let initial = change.initialSwitchState, fields["checked"] as? Bool == initial { return false }
        let signature = String(describing: fields.sorted { $0.key < $1.key })
        if let previous = last.object(forKey: view), previous.timestamp == change.timestamp, previous.state == signature { return false }
        let accepted = recorder.observe(.init(owner: change.owner, event: nativeInteractionEvent("control_change", fields)))
        if accepted { last.setObject(Marker(change.timestamp, signature), forKey: view) }
        return accepted
    }
    private func state(_ view: UIView) -> [String: Any]? {
        #if !os(tvOS)
        if let control = view as? UISwitch { return ["control": "switch", "checked": control.isOn] }
        if let control = view as? UISlider, control.value.isFinite { return ["control": "slider", "position": Double(control.value)] }
        #endif
        if let control = view as? UISegmentedControl, control.selectedSegmentIndex >= 0 {
            return ["control": "picker", "optionId": "segment:\(control.selectedSegmentIndex)"]
        }
        return nil
    }
}
#endif
