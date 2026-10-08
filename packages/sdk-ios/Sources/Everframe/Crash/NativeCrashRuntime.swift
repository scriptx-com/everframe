// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import CryptoKit

/// Owns one process run. Context recovery and persistence stay on the worker;
/// vendor installation and enable run asynchronously on main. The leaf lock
/// never calls SDK state or waits for the worker. Fatal handling stays in C.
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
    private let scheduleAdmission: @Sendable (@escaping @Sendable () -> Void) -> Void
    private enum Prepared: Sendable { case published; case context(URL, UUID) }
    // Worker-owned recovery and immutable context state.
    private var recovery: NativeCrashRecovery?
    private var run: NativeCrashRecovery.Run?
    private var didRecover = false
    private var contextIdentifiers: [String: UUID] = [:]
    // Main-admission-owned; installation is terminal and holds no leaf lock across UIKit.
    private var attemptedInstall = false

    init(rootURL: URL, outbox: JSONLOutbox, recorder: Recorder,
         keyProvider: @escaping @Sendable () throws -> Data = { try OutboxEncryptionKey.getOrCreate() },
         scheduleAdmission: @escaping @Sendable (@escaping @Sendable () -> Void) -> Void = { DispatchQueue.main.async(execute: $0) }) {
        self.rootURL = rootURL; self.outbox = outbox; self.recorder = recorder; self.keyProvider = keyProvider; self.scheduleAdmission = scheduleAdmission
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
        let prepared: Prepared? = await withCheckedContinuation { continuation in
            worker.async { continuation.resume(returning: self.prepareOnWorker(ticket: ticket, context: context)) }
        }
        guard let prepared else { return false }
        switch prepared {
        case .published: return true
        case .context(let directory, let identifier):
            // Never synchronously hop to main: SDK state and context persistence
            // may be waiting independently. The admission rechecks its generation.
            return await withCheckedContinuation { continuation in
                scheduleAdmission {
                    continuation.resume(returning: self.admitOnMain(ticket: ticket, directory: directory, identifier: identifier))
                }
            }
        }
    }

    private func admitOnMain(ticket: UInt64, directory: URL, identifier: UUID) -> Bool {
        precondition(Thread.isMainThread)
        guard isCurrent(ticket) else { return false }
        if !attemptedInstall {
            attemptedInstall = true
            // Installation can call UIKit and reenter SDK configuration. Its
            // successful result starts disabled; do not hold the admission lock.
            let succeeded = recorder.install(directory)
            lock.withLock { installed = succeeded }
        }
        return lock.withLock {
            guard generation == ticket, installed else { return false }
            if publishedTicket == ticket { return true }
            // The current-generation check and enable share opt-out's leaf lock.
            guard recorder.publish(identifier) else { recorder.disable(); return false }
            publishedTicket = ticket
            return true
        }
    }

    private func isCurrent(_ ticket: UInt64) -> Bool { lock.withLock { generation == ticket } }

    private func prepareOnWorker(ticket: UInt64, context: @Sendable () throws -> NativeCrashRecoveryContext?) -> Prepared? {
        guard isCurrent(ticket) else { return nil }
        // A ticket names immutable ownership. Duplicate startup/setUser tails
        // must not close a healthy gate while rebuilding the same snapshot.
        if lock.withLock({ generation == ticket && publishedTicket == ticket }) { return .published }
        // Also safe for a caller refreshing the same ticket after a failure.
        lock.withLock { if generation == ticket, installed { recorder.disable() } }
        do {
            guard let context = try context(), isCurrent(ticket) else { return nil }
            if recovery == nil {
                recovery = try NativeCrashRecovery(rootURL: rootURL, activeRunIDs: [], keyProvider: keyProvider)
            }
            guard let recovery else { return nil }
            if !didRecover {
                for id in try recovery.closedRunIDs() {
                    guard isCurrent(ticket) else { return nil }
                    // A per-record failure retains evidence for the next launch.
                    // Structural inventory failures above stop the whole attempt.
                    _ = try? recovery.recover(runID: id, outbox: outbox)
                }
                // A run's age counts from its process start, not from the crash.
                // Import first so a long-lived process's fresh record is not retired.
                _ = try recovery.maintain()
                didRecover = true
            }
            guard isCurrent(ticket) else { return nil }
            if run == nil { run = try recovery.prepareRun() }
            guard let run else { return nil }
            let bytes = try context.encoded()
            let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            let identifier: UUID
            if let existing = contextIdentifiers[digest] { identifier = existing }
            else {
                identifier = try recovery.writeContext(context, runID: run.id)
                contextIdentifiers[digest] = identifier
            }
            guard isCurrent(ticket) else { return nil }
            return .context(run.recorderURL, identifier)
        } catch {
            // The gate was closed before work began. Never replace or delete a
            // current run to work around unavailable keys, capacity, or I/O.
            return nil
        }
    }
}
