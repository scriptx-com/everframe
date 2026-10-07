// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import CryptoKit

/// Owns one process run. Only the worker touches disk; the leaf lock never
/// calls SDK state, host code, or the worker. Fatal handling stays in C.
final class NativeCrashRuntime: @unchecked Sendable {
    struct Recorder {
        let install: (URL) -> Bool
        let disable: () -> Void
        /// Publish the immutable context identifier, then enable the recorder.
        let publish: (UUID) -> Bool
    }
    private let lock = NSLock()
    private var generation: UInt64 = 0
    private var installed = false
    private var publishedTicket: UInt64?
    private let worker = DispatchQueue(label: "dev.everframe.native-crash", qos: .utility)
    private let rootURL: URL
    private let outbox: JSONLOutbox
    private let recorder: Recorder
    private let keyProvider: @Sendable () throws -> Data
    // Worker-owned state. Installation is terminal even when the vendor fails.
    private var recovery: NativeCrashRecovery?
    private var run: NativeCrashRecovery.Run?
    private var didRecover = false
    private var attemptedInstall = false
    private var contextIdentifiers: [String: UUID] = [:]

    init(rootURL: URL, outbox: JSONLOutbox, recorder: Recorder,
         keyProvider: @escaping @Sendable () throws -> Data = { try OutboxEncryptionKey.getOrCreate() }) {
        self.rootURL = rootURL; self.outbox = outbox; self.recorder = recorder; self.keyProvider = keyProvider
    }

    /// Synchronous ownership barrier. An event already admitted by the native
    /// gate may finish with its original immutable context.
    @discardableResult func invalidate() -> UInt64 {
        lock.withLock {
            generation &+= 1
            publishedTicket = nil
            if installed { recorder.disable() }
            return generation
        }
    }

    func refresh(ticket: UInt64, context: @escaping @Sendable () throws -> NativeCrashRecoveryContext?) async -> Bool {
        await withCheckedContinuation { continuation in
            worker.async { continuation.resume(returning: self.refreshOnWorker(ticket: ticket, context: context)) }
        }
    }

    private func isCurrent(_ ticket: UInt64) -> Bool { lock.withLock { generation == ticket } }

    private func refreshOnWorker(ticket: UInt64, context: @Sendable () throws -> NativeCrashRecoveryContext?) -> Bool {
        guard isCurrent(ticket) else { return false }
        // A ticket names immutable ownership. Duplicate startup/setUser tails
        // must not close a healthy gate while rebuilding the same snapshot.
        if lock.withLock({ generation == ticket && publishedTicket == ticket }) { return true }
        // Also safe for a caller refreshing the same ticket after a failure.
        lock.withLock { if generation == ticket, installed { recorder.disable() } }
        do {
            guard let context = try context(), isCurrent(ticket) else { return false }
            if recovery == nil {
                recovery = try NativeCrashRecovery(rootURL: rootURL, activeRunIDs: [], keyProvider: keyProvider)
            }
            guard let recovery else { return false }
            if !didRecover {
                _ = try recovery.maintain()
                for id in try recovery.closedRunIDs() {
                    guard isCurrent(ticket) else { return false }
                    // A per-record failure retains evidence for the next launch.
                    // Structural inventory failures above stop the whole attempt.
                    _ = try? recovery.recover(runID: id, outbox: outbox)
                }
                didRecover = true
            }
            guard isCurrent(ticket) else { return false }
            if run == nil { run = try recovery.prepareRun() }
            guard let run else { return false }
            let bytes = try context.encoded()
            let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            let identifier: UUID
            if let existing = contextIdentifiers[digest] { identifier = existing }
            else {
                identifier = try recovery.writeContext(context, runID: run.id)
                contextIdentifiers[digest] = identifier
            }
            guard isCurrent(ticket) else { return false }
            if !attemptedInstall {
                attemptedInstall = true
                // May touch disk. Never hold the leaf lock across installation.
                // The native installer always starts disabled.
                let succeeded = recorder.install(run.recorderURL)
                lock.withLock { installed = succeeded }
            }
            return lock.withLock {
                guard generation == ticket, installed else { return false }
                guard recorder.publish(identifier) else { recorder.disable(); return false }
                publishedTicket = ticket
                return true
            }
        } catch {
            // The gate was closed before work began. Never replace or delete a
            // current run to work around unavailable keys, capacity, or I/O.
            return false
        }
    }
}
