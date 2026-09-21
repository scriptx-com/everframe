// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Server-driven vitals gate (iOS spec 2026-09-05 §1). Written at ReplaySession's
// config-apply site (under its epoch re-check), read by VitalsController.
// Structure follows BrandingServerConfigBox, with two Android rulings folded in:
//  - publish(_, ifCurrent:) evaluates the predicate INSIDE the same critical
//    section as the write (Android codex round-4, #4) — "check then write" let
//    a superseded start()/kill() clear a live session's gate.
//  - subscribers are notified on VitalsQueue, never inline under the gate, and
//    a new subscriber is REPLAYED the current value (StateFlow semantics): a
//    controller installed after the first config fetch must still start.
//  - SUBMISSION to that queue happens while the gate is still HELD (codex
//    round-1, #7). The callbacks stay asynchronous; only their order is
//    serialized. Enqueueing after the unlock let a subscriber that had read
//    `enabled`, and then stalled, queue its replay BEHIND a refresh's
//    `disabled` — the serial queue delivered disabled-then-enabled and left
//    collection running against a box that reads disabled. Two concurrent
//    publishes had the same hole.
//
// Lock order: `gate` is OUTERMOST with respect to TraceItX.stateLock (the
// predicates read `currentStartEpoch`, which takes it). start()/kill() call
// publish(nil) OUTSIDE stateLock; nothing takes stateLock and then this gate.
import Foundation

struct VitalsServerConfig: Equatable, Sendable {
    let vitalsEnabled: Bool
    let vitalsSampleRate: Double
}

final class VitalsSubscription: @unchecked Sendable {
    private let onCancel: () -> Void
    private let lock = NSLock()
    private var cancelled = false
    init(_ onCancel: @escaping () -> Void) { self.onCancel = onCancel }
    func cancel() {
        lock.lock(); let first = !cancelled; cancelled = true; lock.unlock()
        if first { onCancel() }
    }
}

final class VitalsServerConfigBox: @unchecked Sendable {
    static let shared = VitalsServerConfigBox()

    private let gate = NSLock()
    private var _value: VitalsServerConfig?
    private var subscribers: [UUID: @Sendable (VitalsServerConfig?) -> Void] = [:]
    private let queue: DispatchQueue

    init(queue: DispatchQueue = VitalsQueue.shared) { self.queue = queue }

    var value: VitalsServerConfig? { gate.lock(); defer { gate.unlock() }; return _value }

    /// Test seam (round-1, #7): run immediately BEFORE a submission to `queue`, with `gate`
    /// still held. That is the whole content of the fix, and the only way to observe it from
    /// outside is to try to publish from another thread at exactly that instant.
    var __submissionHookForTesting: (() -> Void)?

    /// Publish iff `ifCurrent()` — evaluated under `gate` — still says this writer owns the signal.
    func publish(_ value: VitalsServerConfig?, ifCurrent: () -> Bool) {
        gate.lock()
        guard ifCurrent() else { gate.unlock(); return }
        _value = value
        // Submitted under `gate` — see the header. `queue.async` never blocks and never calls
        // back into this box, so holding the gate across it cannot deadlock.
        __submissionHookForTesting?()
        for s in subscribers.values { queue.async { s(value) } }
        gate.unlock()
    }

    func subscribe(_ cb: @escaping @Sendable (VitalsServerConfig?) -> Void) -> VitalsSubscription {
        let id = UUID()
        gate.lock()
        subscribers[id] = cb
        let current = _value
        __submissionHookForTesting?()
        queue.async { cb(current) }   // replay, submitted under `gate` for the same reason
        gate.unlock()
        return VitalsSubscription { [weak self] in
            guard let self else { return }
            self.gate.lock(); self.subscribers.removeValue(forKey: id); self.gate.unlock()
        }
    }

    func resetForTesting() {
        gate.lock(); _value = nil; subscribers.removeAll(); gate.unlock()
    }
}

extension ReplayConfig {
    func toVitalsServerConfig() -> VitalsServerConfig {
        VitalsServerConfig(vitalsEnabled: vitalsEnabled ?? false,
                           vitalsSampleRate: min(max(vitalsSampleRate ?? 1.0, 0.0), 1.0))
    }
}
