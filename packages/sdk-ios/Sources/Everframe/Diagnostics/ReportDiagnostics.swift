// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

/// Leaf lock: never calls providers, storage, lifecycle code or host callbacks.
final class ReportDiagnostics: @unchecked Sendable {
    static let shared = ReportDiagnostics()
    private let lock: NSLock
    private var state = ReportDeliveryStatus()
    private var current: Handle?

    init(lock: NSLock = NSLock()) { self.lock = lock }

    @discardableResult func beginGeneration(epoch: Int, enabled: Bool) -> Handle {
        lock.lock(); defer { lock.unlock() }
        let owner = Handle(ledger: self, epoch: epoch)
        current = owner
        state = ReportDeliveryStatus()
        state.status = "active"; state.reason = "none"; state.capture.enabled = enabled
        return owner
    }

    func retireGeneration(epoch: Int) {
        lock.lock(); defer { lock.unlock() }
        if let current, current.epoch > epoch { return }
        current = nil
        state = ReportDeliveryStatus()
        state.status = "disabled"; state.reason = "capture-disabled"
    }

    func handle(epoch: Int) -> Handle? {
        guard lock.try() else { return nil }
        defer { lock.unlock() }
        return current?.epoch == epoch ? current : nil
    }

    func snapshot() -> ReportDeliveryStatus {
        guard lock.try() else {
            var busy = ReportDeliveryStatus()
            busy.status = "unavailable"; busy.reason = "snapshot-busy"
            return busy
        }
        defer { lock.unlock() }
        return state // Swift value semantics retain an independent copy-on-write snapshot.
    }

    private func observe(_ owner: Handle, update: (inout ReportDeliveryStatus) -> Void) {
        guard lock.try() else { return }
        defer { lock.unlock() }
        guard current === owner else { return }
        update(&state)
        state.revision = Self.add(state.revision, 1)
    }

    // The only mutable field is an ARC-managed weak reference, never reassigned.
    final class Handle: @unchecked Sendable {
        // Weak to avoid a ledger/current-handle retain cycle. Retired handles
        // can outlive a local ledger but cannot publish into another one.
        private weak var ledger: ReportDiagnostics?
        let epoch: Int
        fileprivate init(ledger: ReportDiagnostics, epoch: Int) { self.ledger = ledger; self.epoch = epoch }

        func capture(_ path: ReportCapturePath, _ outcome: ReportCaptureOutcome) {
            ledger?.observe(self) { state in
                guard var value = state.capture.paths[path.rawValue], value.supported else { return }
                value.settledAttempts = ReportDiagnostics.add(value.settledAttempts, 1)
                value.outcomes[outcome.rawValue] = ReportDiagnostics.add(value.outcomes[outcome.rawValue] ?? 0, 1)
                value.lastOutcome = outcome.rawValue
                state.capture.paths[path.rawValue] = value
            }
        }

        func queueObserved(count: Int?, quality: ReportQueueQuality, migration: String? = nil) {
            ledger?.observe(self) { state in
                state.queue.observation = "observed"; state.queue.quality = quality.rawValue
                state.queue.pendingCount = count.flatMap { $0 >= 0 ? min($0, 2_147_483_647) : nil }
                state.queue.lastFailure = nil
                if let migration, ["not-observed", "clear", "blocked", "unknown"].contains(migration) { state.queue.migration = migration }
            }
        }

        func queueOperation(_ operation: ReportQueueOperation, amount: Int = 1, failure: ReportStorageFailure? = nil) {
            guard amount > 0 else { return }
            ledger?.observe(self) { state in
                state.queue.operations[operation.rawValue] = ReportDiagnostics.add(state.queue.operations[operation.rawValue] ?? 0, amount)
                if [.enqueueFailed, .removalFailed, .readFailed].contains(operation) {
                    state.queue.observation = "failed"; state.queue.quality = "unknown"; state.queue.pendingCount = nil
                    state.queue.lastFailure = (failure ?? .unknown).rawValue
                }
            }
        }

        func transport(_ origin: ReportTransportOrigin, _ outcome: ReportTransportOutcome, httpStatus: Int? = nil) {
            ledger?.observe(self) { state in
                var value = state.transport[origin.rawValue] ?? ReportTransportStatus()
                value.settledAttempts = ReportDiagnostics.add(value.settledAttempts, 1)
                value.outcomes[outcome.rawValue] = ReportDiagnostics.add(value.outcomes[outcome.rawValue] ?? 0, 1)
                value.lastOutcome = outcome.rawValue
                value.lastHttpStatus = httpStatus.flatMap { (100...599).contains($0) ? $0 : nil }
                state.transport[origin.rawValue] = value
            }
        }
    }

    private static func add(_ value: Int, _ amount: Int) -> Int { min(2_147_483_647, value + min(max(0, amount), 2_147_483_647)) }
}
