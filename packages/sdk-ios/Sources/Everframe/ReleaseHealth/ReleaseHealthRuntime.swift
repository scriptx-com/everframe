// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import EverframeProtocol

enum ReleaseHealthDeliveryResult { case settled, retry }
typealias ReleaseHealthAdmission = @Sendable (@escaping @Sendable () -> Void) -> Bool
typealias ReleaseHealthSend = @Sendable (ReleaseHealthEntry, @escaping ReleaseHealthAdmission) async -> ReleaseHealthDeliveryResult

/// Memory-only admission lock, serial disk worker and independent HTTP task.
final class ReleaseHealthRuntime: @unchecked Sendable {
    static func makeRuntime() -> ReleaseHealthRuntime? {
        #if os(iOS)
        guard NSClassFromString("XCTestCase") == nil,
              ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else { return nil }
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].resolvingSymlinksInPath()
        return ReleaseHealthRuntime(root: caches.appendingPathComponent("dev.everframe.release-health"), initiallyForeground: false)
        #else
        return nil
        #endif
    }
    private struct Owner: Equatable, Sendable { let configuration: ReleaseHealthConfiguration; let sdkKey: String; let endpoint: String }
    private let lock = NSLock()
    private var generation: UInt64 = 0
    private var desired: Owner?
    private var foreground: Bool
    private var ready: EverframeNativeExposure?
    private var requestedErasure: UInt64 = 0
    private var completedErasure: UInt64 = 0
    private let worker = DispatchQueue(label: "dev.everframe.release-health", qos: .utility)
    private let root: URL
    private let keyProvider: () throws -> Data
    private let now: @Sendable () -> Date
    private let uptime: @Sendable () -> TimeInterval
    private let beforeCommit: () throws -> Void
    private let transport: ReleaseHealthSend
    private let processLaunchID: UUID
    private var store: ReleaseHealthStore?
    private var active: (ticket: UInt64, segment: ReleaseHealthSegment)?
    private var drainTask: Task<Void, Never>?
    private var timer: DispatchSourceTimer?

    init(root: URL, keyProvider: @escaping () throws -> Data = { try OutboxEncryptionKey.getOrCreate() },
         processLaunchID: UUID = ReleaseHealthProcessIdentity.id, now: @escaping @Sendable () -> Date = { Date() },
         uptime: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         beforeCommit: @escaping () throws -> Void = {},
         initiallyForeground: Bool = true,
         transport: @escaping ReleaseHealthSend = { entry, admission in await ReleaseHealthTransport.send(entry, admission: admission) }) {
        self.root = root; self.keyProvider = keyProvider; self.processLaunchID = processLaunchID
        self.now = now; self.uptime = uptime; self.beforeCommit = beforeCommit; self.transport = transport
        self.foreground = initiallyForeground
    }
    deinit { timer?.cancel(); drainTask?.cancel() }
    var readyPointer: EverframeNativeExposure? { lock.withLock { ready } }

    /// Called only with the SDK's published configuration ownership captured.
    func requestEnable(configuration: ReleaseHealthConfiguration, sdkKey: String, endpoint: String) -> UInt64 {
        let capturedAt = now(), capturedUptime = uptime()
        let transition: (UInt64, Bool) = lock.withLock {
            let next = Owner(configuration: configuration, sdkKey: sdkKey, endpoint: endpoint)
            let changed = desired != next
            if changed { generation &+= 1; desired = next; ready = nil }
            return (generation, changed)
        }
        if transition.1 {
            worker.async {
                if let active = self.active, active.ticket < transition.0 {
                    self.closeActive(capturedAt: capturedAt, capturedUptime: capturedUptime)
                }
            }
        }
        return transition.0
    }
    /// Called at the SDK's context invalidation boundary. No disk work occurs here.
    /// Inactive UIKit interruptions stay foreground; only background closes a session.
    /// `retiredPointer` reports, atomically with the change, whether a ready pointer
    /// was withdrawn: only then can a native context carry a pointer that must go.
    @discardableResult func setForeground(_ value: Bool) -> (ticket: UInt64, retiredPointer: Bool)? {
        let capturedAt = now(), capturedUptime = uptime()
        let change: (ticket: UInt64, retiredPointer: Bool)? = lock.withLock {
            guard foreground != value else { return nil }
            let retired = ready != nil
            foreground = value; generation &+= 1; ready = nil
            return (generation, retired)
        }
        if let ticket = change?.ticket, !value {
            worker.async {
                if let active = self.active, active.ticket < ticket {
                    self.closeActive(reason: .background, capturedAt: capturedAt, capturedUptime: capturedUptime)
                }
                self.startDrain(ticket)
            }
        }
        return change
    }
    func boundary() {
        let capturedAt = now(), capturedUptime = uptime()
        let ticket = lock.withLock { () -> UInt64 in generation &+= 1; desired = nil; ready = nil; return generation }
        worker.async {
            if let active = self.active, active.ticket < ticket {
                self.closeActive(capturedAt: capturedAt, capturedUptime: capturedUptime)
            }
            if self.lock.withLock({ self.generation == ticket && self.desired == nil }) { self.stopDrain() }
        }
    }
    @discardableResult func revoke() -> UInt64 {
        let request = lock.withLock { () -> (UInt64, UInt64) in
            generation &+= 1; desired = nil; ready = nil; requestedErasure &+= 1; return (requestedErasure, generation)
        }
        worker.async {
            if let active = self.active, active.ticket < request.1 { self.active = nil }
            if self.lock.withLock({ self.generation == request.1 && self.desired == nil }) { self.stopDrain() }
        }
        return request.0
    }
    func enable(ticket: UInt64, sdkVersion: String) async -> Bool {
        await onWorker {
            guard self.lock.withLock({ self.foreground }), let owner = self.owner(ticket), ReleaseHealthConfiguration.validText(sdkVersion, maximum: 64) else { return false }
            do {
                try self.prepareStore()
                guard self.finishErasure(), self.lock.withLock({ self.foreground }), self.owner(ticket) == owner, let store = self.store else { return false }
                try store.maintain(now: self.now())
                if self.active?.ticket != ticket {
                    self.closeActive()
                    let segment = ReleaseHealthSegment(configuration: owner.configuration, sdkVersion: sdkVersion,
                        sdkKey: owner.sdkKey, endpoint: owner.endpoint, processLaunchID: self.processLaunchID,
                        now: self.now(), uptime: self.uptime())
                    try store.append(segment.entry(end: false, now: self.now(), uptime: self.uptime()))
                    self.active = (ticket, segment)
                }
                let published = self.lock.withLock { () -> Bool in
                    guard self.generation == ticket, self.desired == owner, self.foreground,
                          self.requestedErasure == self.completedErasure else { return false }
                    self.ready = self.active?.segment.pointer; return self.ready != nil
                }
                if published { self.startDrain(ticket); self.startTimer(ticket) }
                return published
            } catch { return false }
        }
    }
    func finishRevocation(_ request: UInt64) async -> Bool {
        await onWorker {
            do { try self.prepareStore() } catch { return false }
            return self.finishErasure() && self.lock.withLock { self.completedErasure >= request }
        }
    }
    func barrier() async { _ = await onWorker { true } }
    func flush() async {
        let task = await onWorker { () -> Task<Void, Never>? in
            let ticket = self.lock.withLock { self.generation }; self.startDrain(ticket); return self.drainTask
        }
        await task?.value
    }
    private func owner(_ ticket: UInt64) -> Owner? { lock.withLock { generation == ticket ? desired : nil } }
    private func prepareStore() throws {
        let key = try keyProvider()
        do { store = try ReleaseHealthStore(root: root, keyProvider: { key }, beforeCommit: beforeCommit) }
        catch ReleaseHealthStore.Failure.invalid {
            lock.withLock { requestedErasure &+= 1; ready = nil }
            active = nil
            try ReleaseHealthStore.eraseAmbiguous(root: root)
            store = try ReleaseHealthStore(root: root, keyProvider: { key }, beforeCommit: beforeCommit)
        }
    }
    private func finishErasure() -> Bool {
        guard let store else { return false }
        do {
            while true {
                let request = lock.withLock { requestedErasure }
                if lock.withLock({ completedErasure == request }) { return true }
                active = nil; try store.erase()
                lock.withLock { completedErasure = request }
            }
        } catch { return false }
    }
    private func closeActive(reason: ReleaseHealthEndReason = .sdkStop, capturedAt: Date? = nil, capturedUptime: TimeInterval? = nil) {
        guard let previous = active else { return }; active = nil
        guard lock.withLock({ requestedErasure == completedErasure }) else { return }
        try? store?.append(previous.segment.entry(end: true, now: capturedAt ?? now(), uptime: capturedUptime ?? uptime(), endReason: reason))
    }
    private func stopDrain() { timer?.cancel(); timer = nil; drainTask?.cancel() }
    private func startTimer(_ ticket: UInt64) {
        timer?.cancel()
        let next = DispatchSource.makeTimerSource(queue: worker)
        next.schedule(deadline: .now() + 30, repeating: 30)
        next.setEventHandler { [weak self] in self?.startDrain(ticket) }
        timer = next; next.resume()
    }
    private func startDrain(_ ticket: UInt64) {
        guard drainTask == nil, let owner = owner(ticket), let store else { return }
        let entries: [ReleaseHealthEntry]
        do { try store.maintain(now: now()); entries = try store.pending() } catch { return }
        drainTask = Task { [weak self] in
            guard let self else { return }
            for entry in entries where entry.sdkKey == owner.sdkKey && entry.endpoint == owner.endpoint {
                guard !Task.isCancelled, self.owner(ticket) == owner else { break }
                let result = await self.transport(entry) { start in
                    self.lock.withLock {
                        guard self.generation == ticket, self.desired == owner,
                              self.requestedErasure == self.completedErasure,
                              self.now() >= entry.createdAt,
                              self.now().timeIntervalSince(entry.createdAt) < ReleaseHealthStore.lifetime else { return false }
                        start(); return true
                    }
                }
                if case .retry = result { break }
                _ = await self.onWorker { try? self.store?.settle(entry.recordID); return true }
            }
            _ = await self.onWorker { self.drainTask = nil; return true }
        }
    }
    private func onWorker<T: Sendable>(_ work: @escaping @Sendable () -> T) async -> T {
        await withCheckedContinuation { continuation in worker.async { continuation.resume(returning: work()) } }
    }
}
