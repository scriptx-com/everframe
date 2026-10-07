// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

/// Separate callback-window and durable-delivery ownership. All disk operations
/// are serialized; the leaf lock only fences generations and transport permits.
final class AppleDiagnosticRuntime: @unchecked Sendable {
    private let lock = NSLock()
    private var generation: UInt64 = 0
    private var desired = false
    private var requestedErasure: UInt64 = 0
    private var completedErasure: UInt64 = 0
    private var callbackPending = false
    private let worker = DispatchQueue(label: "dev.everframe.apple-diagnostics", qos: .utility)
    private let owner = UUID()
    private let root: URL
    private let outbox: JSONLOutbox
    var deliveryOutbox: JSONLOutbox { outbox }
    private let keyProvider: @Sendable () throws -> Data
    private let now: @Sendable () -> Date
    private var store: AppleDiagnosticStore?
    private var window: (ticket: UInt64, id: UUID, begin: Date, context: AppleDiagnosticContext)?
    private var driver: ((Bool) -> Void)?
    private var drain: (@Sendable () async -> Void)?
    private var drainTask: Task<Void, Never>?
    private var retryTimer: DispatchSourceTimer?

    init(root: URL, outbox: JSONLOutbox, keyProvider: @escaping @Sendable () throws -> Data = { try OutboxEncryptionKey.getOrCreate() },
         now: @escaping @Sendable () -> Date = { Date() }) {
        self.root = root; self.outbox = outbox; self.keyProvider = keyProvider; self.now = now
    }
    deinit { retryTimer?.cancel(); drainTask?.cancel(); AppleDiagnosticDelivery.remove(owner: owner) }

    /// Called under SDK stateLock: no disk, framework or host calls.
    func boundary() {
        let ticket = lock.withLock { () -> UInt64 in
            generation &+= 1; desired = false; AppleDiagnosticDelivery.remove(owner: owner); return generation
        }
        stopIfCurrent(ticket)
    }
    @discardableResult func revoke() -> UInt64 {
        let request = lock.withLock { () -> (UInt64, UInt64) in
            generation &+= 1; desired = false; requestedErasure &+= 1
            AppleDiagnosticDelivery.remove(owner: owner); return (requestedErasure, generation)
        }
        stopIfCurrent(request.1)
        return request.0
    }
    private func stopIfCurrent(_ ticket: UInt64) {
        worker.async {
            guard self.lock.withLock({ self.generation == ticket && !self.desired }) else { return }
            self.window = nil; self.driver?(false); self.retryTimer?.cancel(); self.retryTimer = nil
        }
    }
    func requestEnable() -> UInt64 {
        lock.withLock { if !desired { generation &+= 1; desired = true }; return generation }
    }
    private func current(_ ticket: UInt64) -> Bool { lock.withLock { desired && generation == ticket } }

    func enable(context: AppleDiagnosticContext, ticket: UInt64? = nil,
                drain: (@Sendable () async -> Void)? = nil) async -> Bool {
        let ticket = ticket ?? requestEnable()
        return await onWorker {
            guard self.current(ticket) else { return false }
            do {
                try self.prepareStore()
                guard self.finishErasure(), self.current(ticket), let store = self.store else { return false }
                try self.maintain(now: self.now()); try store.activate()
                if self.window?.ticket != ticket {
                    self.retryTimer?.cancel(); self.retryTimer = nil
                    self.window = (ticket, UUID(), self.now(), context)
                }
                self.drain = drain
                self.retryPending(ticket: ticket, context: context)
                guard self.current(ticket) else { return false }
                self.driver?(true)
                self.installRetry(ticket: ticket, context: context)
                return true
            } catch { return false }
        }
    }
    func finishRevocation(_ request: UInt64) async -> Bool {
        await onWorker { self.finishErasure() && self.lock.withLock { self.completedErasure >= request } }
    }
    /// One pending platform callback job, with a bounded projection supplied by
    /// the adapter. Work never captures an unbounded backlog of OS payloads.
    func receive(_ projection: @escaping @Sendable () -> [AppleDiagnosticCandidate]) {
        let ticket = lock.withLock { () -> UInt64? in
            guard desired, !callbackPending else { return nil }; callbackPending = true; return generation
        }
        guard let ticket else { return }
        worker.async {
            defer { self.lock.withLock { self.callbackPending = false } }
            guard self.current(ticket) else { return }
            for candidate in projection().prefix(8) { _ = self.acceptOnWorker(candidate, ticket: ticket) }
        }
    }
    func accept(_ candidate: AppleDiagnosticCandidate) async -> Bool {
        let ticket = lock.withLock { generation }
        return await onWorker { self.acceptOnWorker(candidate, ticket: ticket) }
    }
    func setDriver(_ driver: @escaping (Bool) -> Void) { worker.async { self.driver = driver } }

    private func acceptOnWorker(_ candidate: AppleDiagnosticCandidate, ticket: UInt64) -> Bool {
        guard current(ticket), let window, window.ticket == ticket, let store else { return false }
        let collected = now()
        guard window.context.accepts(candidate, since: window.begin, now: collected) else { return false }
        do {
            try maintain(now: collected)
            let hash = try window.context.hash(candidate)
            guard store.existing(hash: hash) == nil else { return false }
            let entry = try window.context.entry(candidate, ownershipID: window.id, now: collected)
            guard current(ticket) else { return false }
            // This is capture admission. A boundary after here cannot retarget
            // the immutable receipt; explicit erasure will remove it on this worker.
            try store.stage(entry, hash: hash)
            retryPending(ticket: ticket, context: window.context)
            return true
        } catch { return false }
    }
    private func prepareStore() throws {
        if store != nil { return }
        let key = try keyProvider()
        do { store = try AppleDiagnosticStore(root: root, keyProvider: { key }) }
        catch AppleDiagnosticStore.Failure.invalid {
            // Incomplete replacement cannot select either authority. Reset it
            // only after recording the erasure obligation in memory.
            lock.withLock { requestedErasure &+= 1; AppleDiagnosticDelivery.remove(owner: owner) }
            try AppleDiagnosticStore.eraseAmbiguous(root: root)
            store = try AppleDiagnosticStore(root: root, keyProvider: { key })
            try store?.revoke()
        }
    }
    private func finishErasure() -> Bool {
        do {
            try prepareStore()
            guard let store else { return false }
            while true {
                let pending = lock.withLock { requestedErasure != completedErasure }
                guard pending || store.needsOutboxErase else { return true }
                let requested = lock.withLock { requestedErasure }
                if !store.needsOutboxErase { try store.revoke() }
                try outbox.drain(where: AppleDiagnosticDelivery.isApple)
                try store.finishErasure()
                lock.withLock { completedErasure = requested }
            }
        } catch { return false }
    }
    private func retryPending(ticket: UInt64, context: AppleDiagnosticContext) {
        guard current(ticket), let store, !store.isRevoked else { return }
        for entry in store.pending where entry.sdkKey == context.frozen.sdkKey && entry.endpoint == context.frozen.endpoint {
            guard current(ticket) else { return }
            do {
                try outbox.enqueueRecovered(entry)
                lock.withLock {
                    guard desired, generation == ticket else { return }
                    AppleDiagnosticDelivery.publish(owner: owner, entry: entry) { [weak self] in
                        guard let self else { return }; self.worker.async { try? self.store?.settle(entry.reportId) }
                    }
                }
            } catch { continue }
        }
        if let drain, drainTask == nil {
            drainTask = Task { [weak self] in
                await drain()
                self?.worker.async { [weak self] in self?.drainTask = nil }
            }
        }
    }
    private func maintain(now: Date) throws {
        // Retention removes both copies. Expired Apple bytes must not occupy
        // the shared queue after their journal authority has been discarded.
        AppleDiagnosticDelivery.prune(owner: owner, now: now)
        try store?.maintain(now: now)
        try outbox.drain { entry in
            AppleDiagnosticDelivery.isApple(entry) && (entry.createdAt > now || now.timeIntervalSince(entry.createdAt) >= AppleDiagnosticStore.lifetime)
        }
    }
    private func installRetry(ticket: UInt64, context: AppleDiagnosticContext) {
        guard retryTimer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: worker)
        timer.schedule(deadline: .now() + 30, repeating: 30)
        timer.setEventHandler { [weak self] in
            guard let self, self.current(ticket) else { return }
            do { try self.maintain(now: self.now()) } catch { return }
            self.retryPending(ticket: ticket, context: context)
        }
        retryTimer = timer; timer.resume()
    }
    private func onWorker(_ work: @escaping () -> Bool) async -> Bool {
        await withCheckedContinuation { continuation in worker.async { continuation.resume(returning: work()) } }
    }
}
