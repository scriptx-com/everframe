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
        /// Nil provides no safe retirement authority (e.g. an enabled recorder).
        var retainedContextIdentifiers: () -> Set<UUID>? = { nil }
    }
    /// Foreground-termination inference for this process's run. Disabled by default; the app
    /// runtime passes `.production`, which is enabled only where TerminationPlatform allows it.
    struct TerminationOptions: Sendable {
        var enabled: Bool
        var identity: @Sendable () -> TerminationIdentity
        var now: @Sendable () -> Date
        var launchID: UUID
        var startTracking: @Sendable (TerminationStateFile) -> Void
        static let disabled = TerminationOptions(enabled: false, identity: { .current() }, now: { Date() },
            launchID: ReleaseHealthProcessIdentity.id, startTracking: { _ in })
        static var production: TerminationOptions {
            #if canImport(UIKit)
            return TerminationOptions(enabled: TerminationPlatform.isEligible(), identity: { .current() }, now: { Date() },
                launchID: ReleaseHealthProcessIdentity.id, startTracking: { TerminationTracker.startForApplication($0) })
            #else
            return .disabled
            #endif
        }
    }
    private let lock = NSLock()
    private var generation: UInt64 = 0
    private var installed = false
    private var publishedTicket: UInt64?
    /// Durable context without a release-health pointer for `publishedTicket`: the
    /// published context itself, or its unlinked twin when that one carries a pointer.
    private var publishedUnlinked: UUID?
    /// Exposure ID of the release-health pointer the `publishedTicket` context carries.
    private var publishedExposureID: String?
    private let worker = DispatchQueue(label: "dev.everframe.native-crash", qos: .utility)
    private let rootURL: URL
    private let outbox: JSONLOutbox
    private let recorder: Recorder
    private let keyProvider: @Sendable () throws -> Data
    private let scheduleAdmission: @Sendable (@escaping @Sendable () -> Void) -> Void
    private let termination: TerminationOptions
    /// Set once under `lock`; armed and disarmed only under `lock`, in step with the recorder:
    /// an inference is possible only where a real crash at that instant would have been captured.
    private var terminationState: TerminationStateFile?
    private enum Prepared: Sendable { case published; case context(URL, UUID, unlinked: UUID?, exposureID: String?) }
    // Worker-owned recovery and immutable context state.
    private var recovery: NativeCrashRecovery?
    private var run: NativeCrashRecovery.Run?
    private var didRecover = false
    private var contextIdentifiers: [String: UUID] = [:]
    // Identifiers prepared for `preparedTicket`; their admission may still be queued.
    private var preparedTicket: UInt64?
    private var preparedIdentifiers: Set<UUID> = []
    // Main-admission-owned; installation is terminal and holds no leaf lock across UIKit.
    private var attemptedInstall = false

    init(rootURL: URL, outbox: JSONLOutbox, recorder: Recorder,
         keyProvider: @escaping @Sendable () throws -> Data = { try OutboxEncryptionKey.getOrCreate() },
         scheduleAdmission: @escaping @Sendable (@escaping @Sendable () -> Void) -> Void = { DispatchQueue.main.async(execute: $0) },
         termination: TerminationOptions = .disabled) {
        self.rootURL = rootURL; self.outbox = outbox; self.recorder = recorder; self.keyProvider = keyProvider; self.scheduleAdmission = scheduleAdmission
        self.termination = termination
    }

    /// Synchronous ownership barrier. An event already admitted by the native
    /// gate may finish with its original immutable context.
    @discardableResult func invalidate() -> UInt64 {
        lock.withLock {
            generation &+= 1
            publishedTicket = nil; publishedUnlinked = nil; publishedExposureID = nil
            terminationState?.disarm()
            if installed { recorder.disable() }
            return generation
        }
    }

    /// The same barrier for a withdrawn release-health pointer. On main, the published
    /// ticket's durable unlinked context is rearmed under this lock, so work later in
    /// the same callback is captured; otherwise the next refresh rearms capture.
    @discardableResult func retireExposure() -> UInt64 {
        lock.withLock {
            let unlinked = publishedTicket == generation ? publishedUnlinked : nil
            generation &+= 1
            publishedTicket = nil; publishedUnlinked = nil; publishedExposureID = nil
            terminationState?.disarm()
            guard installed else { return generation }
            recorder.disable()
            if let unlinked, Thread.isMainThread {
                guard recorder.publish(unlinked) else { recorder.disable(); return generation }
                publishedTicket = generation; publishedUnlinked = unlinked
                terminationState?.arm(contextID: unlinked)
            }
            return generation
        }
    }

    /// Whether the current generation is armed with a context carrying exactly this
    /// release-health pointer (nil: none). Such capture needs no invalidation barrier.
    func isArmed(exposureID: String?) -> Bool {
        lock.withLock { publishedTicket == generation && publishedExposureID == exposureID }
    }

    func refresh(ticket: UInt64, context: @escaping @Sendable () throws -> NativeCrashRecoveryContext?) async -> Bool {
        let prepared: Prepared? = await withCheckedContinuation { continuation in
            worker.async { continuation.resume(returning: self.prepareOnWorker(ticket: ticket, context: context)) }
        }
        guard let prepared else { return false }
        switch prepared {
        case .published: return true
        case .context(let directory, let identifier, let unlinked, let exposureID):
            // Never synchronously hop to main: SDK state and context persistence
            // may be waiting independently. The admission rechecks its generation.
            return await withCheckedContinuation { continuation in
                scheduleAdmission {
                    continuation.resume(returning: self.admitOnMain(ticket: ticket, directory: directory,
                        identifier: identifier, unlinked: unlinked, exposureID: exposureID))
                }
            }
        }
    }

    private func admitOnMain(ticket: UInt64, directory: URL, identifier: UUID, unlinked: UUID?, exposureID: String?) -> Bool {
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
            guard recorder.publish(identifier) else { recorder.disable(); terminationState?.disarm(); return false }
            terminationState?.arm(contextID: identifier)
            publishedTicket = ticket; publishedUnlinked = unlinked; publishedExposureID = exposureID
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
        lock.withLock { if generation == ticket, installed { recorder.disable(); terminationState?.disarm() } }
        do {
            guard let context = try context(), isCurrent(ticket) else { return nil }
            if recovery == nil {
                recovery = try NativeCrashRecovery(rootURL: rootURL, activeRunIDs: [], keyProvider: keyProvider)
            }
            guard let recovery else { return nil }
            if !didRecover {
                // Oldest first; the last is the previous SDK process, the only run evaluated for a
                // foreground termination. Any run's journal still resumes, whatever its age.
                let closed = try recovery.closedRunIDs()
                let inference = termination.enabled
                    ? TerminationInference.Context(current: termination.identity(), now: termination.now()) : nil
                for id in closed {
                    guard isCurrent(ticket) else { return nil }
                    // A per-record failure retains evidence for the next launch.
                    // Structural inventory failures above stop the whole attempt.
                    _ = try? recovery.recover(runID: id, outbox: outbox, inference: id == closed.last ? inference : nil)
                }
                // A run's age counts from its process start, not from the crash.
                // Import first so a long-lived process's fresh record is not retired.
                _ = try recovery.maintain()
                didRecover = true
            }
            guard isCurrent(ticket) else { return nil }
            if run == nil {
                let prepared = try recovery.prepareRun(terminationState: termination.enabled)
                run = prepared
                if let state = prepared.terminationState {
                    // Header before anything can arm or sample; then the tracker owns the other fields.
                    state.writeHeader(launchID: termination.launchID, identity: termination.identity(), startedAt: termination.now())
                    lock.withLock { terminationState = state }
                    termination.startTracking(state)
                }
            }
            guard let run else { return nil }
            if preparedTicket != ticket { preparedTicket = ticket; preparedIdentifiers = [] }
            guard let identifier = try contextIdentifier(context, ticket: ticket, recovery: recovery, run: run) else { return nil }
            // A pointer-free twin lets a background withdrawal rearm capture without
            // disk work. Without one, that withdrawal waits for a refresh instead.
            let exposureID = context.releaseHealthExposure?.exposureID
            let unlinked = exposureID == nil ? identifier : (try? context.withoutReleaseHealthExposure())
                .flatMap { try? contextIdentifier($0, ticket: ticket, recovery: recovery, run: run) }
            guard isCurrent(ticket) else { return nil }
            return .context(run.recorderURL, identifier, unlinked: unlinked, exposureID: exposureID)
        } catch {
            // The gate was closed before work began. Never replace or delete a
            // current run to work around unavailable keys, capacity, or I/O.
            return nil
        }
    }

    /// Immutable contexts are cached by content digest. At the cache bound, retire every
    /// context that neither the recorder, a pending same-ticket admission nor the
    /// published unlinked context can still reference. Nil means the ticket is stale.
    private func contextIdentifier(_ context: NativeCrashRecoveryContext, ticket: UInt64,
                                   recovery: NativeCrashRecovery, run: NativeCrashRecovery.Run) throws -> UUID? {
        let bytes = try context.encoded()
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        if let existing = contextIdentifiers[digest] { preparedIdentifiers.insert(existing); return existing }
        if contextIdentifiers.count >= 128 {
            let retained = lock.withLock { () -> Set<UUID>? in
                guard generation == ticket, let current = recorder.retainedContextIdentifiers() else { return nil }
                return current.union(preparedIdentifiers).union(publishedUnlinked.map { [$0] } ?? [])
            }
            if let retained {
                do {
                    let remaining = try recovery.retireUnusedContexts(runID: run.id, keeping: retained)
                    contextIdentifiers = contextIdentifiers.filter { remaining.contains($0.value) }
                } catch {
                    // A partial unlink must not leave cached IDs pointing at
                    // absent files. Retrying persists fresh immutable bytes.
                    contextIdentifiers.removeAll()
                    throw error
                }
            }
        }
        guard isCurrent(ticket) else { return nil }
        let identifier = try recovery.writeContext(context, runID: run.id)
        contextIdentifiers[digest] = identifier; preparedIdentifiers.insert(identifier)
        return identifier
    }
}
