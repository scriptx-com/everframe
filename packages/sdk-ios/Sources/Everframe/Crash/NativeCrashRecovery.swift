// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

/// Healthy-process recovery only. The host supplies every still-active run and
/// owns the directory exclusively. No live SDK configuration is read here.
final class NativeCrashRecovery: @unchecked Sendable {
    struct Limits: Sendable {
        var maxRuns = 16
        var maxRunBytes = 4 * 1024 * 1024
        var maxTotalBytes = 64 * 1024 * 1024
        var maxAge: TimeInterval = 14 * 24 * 60 * 60
        static let defaults = Limits()
    }
    struct Run: Sendable { let id: UUID; let recorderURL: URL }
    enum Failure: Error, Equatable { case activeRun, busy, unsafePath, capacity, io, unavailable, journal, missingRun, invalidLimits }
    enum Quarantine: Equatable { case record, context, multipleReports, journal }
    enum Outcome: Equatable { case noReport, quarantined(Quarantine), queued(UUID), alreadyImported(UUID) }
    enum Phase: Equatable { case staged, enqueued, receipted }
    private typealias Files = NativeCrashContextFiles
    private typealias Tree = NativeCrashRecoveryFiles
    private typealias Journal = NativeCrashRecoveryJournal
    private struct Inventory {
        let contexts: [NativeCrashContextStore.Run]
        let runs: [UUID: Tree.Inventory]
        let retiring: [UUID]
        var bytes: Int { runs.values.reduce(0) { $0 + $1.bytes } }
    }
    private static let lock = NSLock()
    private static var inFlight: Set<String> = []
    private let rootURL: URL
    private let runsURL: URL
    private let contextStore: NativeCrashContextStore
    private var activeRunIDs: Set<UUID>
    private let limits: Limits
    private let keyProvider: @Sendable () throws -> Data

    init(rootURL: URL, activeRunIDs: Set<UUID>, limits: Limits = .defaults,
         keyProvider: @escaping @Sendable () throws -> Data = { try OutboxEncryptionKey.getOrCreate() }) throws {
        let max = Limits.defaults
        guard limits.maxRuns > 0, limits.maxRuns <= max.maxRuns,
              limits.maxRunBytes > 0, limits.maxRunBytes <= max.maxRunBytes,
              limits.maxTotalBytes > 0, limits.maxTotalBytes <= max.maxTotalBytes,
              limits.maxAge.isFinite, limits.maxAge > 0, limits.maxAge <= max.maxAge else { throw Failure.invalidLimits }
        let root = rootURL.standardizedFileURL
        guard root.isFileURL, root.path == root.resolvingSymlinksInPath().path else { throw Failure.unsafePath }
        self.rootURL = root; runsURL = root.appendingPathComponent("runs", isDirectory: true)
        self.activeRunIDs = activeRunIDs; self.limits = limits; self.keyProvider = keyProvider
        contextStore = try Self.lock.withLock {
            try Self.checked {
                if try Files.info(root) == nil { try Files.makeDirectory(root) }
                try Files.directory(root)
                let runs = root.appendingPathComponent("runs", isDirectory: true)
                if try Files.info(runs) == nil { try Files.makeDirectory(runs) }
                try Files.directory(runs)
                return try NativeCrashContextStore(rootURL: root.appendingPathComponent("contexts"), keyProvider: keyProvider)
            }
        }
    }

    func prepareRun(now: Date = Date()) throws -> Run {
        try locked {
            guard now.timeIntervalSince1970.isFinite else { throw Failure.invalidLimits }
            _ = try maintainLocked(now: now)
            var inventory = try scan()
            while inventory.contexts.count >= limits.maxRuns || inventory.bytes >= limits.maxTotalBytes {
                guard let candidate = inventory.contexts.first(where: { !excluded($0.id) }) else { throw Failure.capacity }
                try retire(candidate.id, inventory: inventory)
                inventory = try scan()
            }
            let contextRun: NativeCrashContextStore.Run
            while true {
                do {
                    contextRun = try contextStore.createRun(now: now,
                        reservingPayloadBytes: NativeCrashContextStore.Limits.defaults.maxPayloadBytes)
                    break
                } catch NativeCrashContextStore.Failure.capacity {
                    // Context ciphertext has an independent byte budget. Reclaim
                    // eligible old runs even when raw bytes/run count still fit.
                    guard let candidate = inventory.contexts.first(where: { !excluded($0.id) }) else { throw Failure.capacity }
                    try retire(candidate.id, inventory: inventory)
                    inventory = try scan()
                }
            }
            // A crash here leaves an identifiable orphan context, never another run's owner.
            let path = runURL(contextRun.id)
            try Files.makeDirectory(path)
            let recorder = path.appendingPathComponent("recorder", isDirectory: true)
            try Files.makeDirectory(recorder)
            try Files.syncDirectory(path); try Files.syncDirectory(runsURL)
            activeRunIDs.insert(contextRun.id)
            return Run(id: contextRun.id, recorderURL: recorder)
        }
    }

    func writeContext(_ context: NativeCrashRecoveryContext, runID: UUID) throws -> UUID {
        try locked {
            guard activeRunIDs.contains(runID) else { throw Failure.activeRun }
            _ = try resumeRetirements()
            try Files.directory(runURL(runID)); try Files.directory(runURL(runID).appendingPathComponent("recorder"))
            return try contextStore.writeContext(context.encoded(), runID: runID)
        }
    }

    /// Hooks model process interruption and run outside the process lock. Production
    /// callers omit them. In-flight leases exclude retirement between these boundaries.
    func recover(runID: UUID, outbox: JSONLOutbox, phaseHook: ((Phase) throws -> Void)? = nil) throws -> Outcome {
        try locked {
            guard !activeRunIDs.contains(runID) else { throw Failure.activeRun }
            guard !Self.inFlight.contains(lease(runID)) else { throw Failure.busy }
            Self.inFlight.insert(lease(runID))
        }
        defer { Self.lock.withLock { _ = Self.inFlight.remove(lease(runID)) } }
        let prepared: (Journal.Stage?, Outcome?) = try locked { try stage(runID) }
        guard let staged = prepared.0 else { return prepared.1! }
        try phaseHook?(.staged)
        try locked { _ = try outbox.enqueueRecovered(staged.entry) }
        try phaseHook?(.enqueued)
        try locked {
            let inventory = try scan()
            let stored = try Files.read(runURL(runID).appendingPathComponent("stage.evr"), maximum: Journal.Kind.stage.maximum)
            let receipt = Journal.Receipt(schemaVersion: 1, rawHash: staged.rawHash,
                stageHash: Journal.hash(stored), reportID: staged.entry.reportId)
            let sealed = try Journal.seal(receipt, runID: runID, kind: .receipt, key: key())
            try reserve(sealed.count, runID: runID, inventory: inventory)
            try Files.writeImmutable(sealed, to: runURL(runID).appendingPathComponent("receipt.evr"))
        }
        try phaseHook?(.receipted)
        return .queued(staged.entry.reportId)
    }

    @discardableResult func maintain(now: Date = Date()) throws -> Int {
        try locked { try maintainLocked(now: now) }
    }

    private func stage(_ runID: UUID) throws -> (Journal.Stage?, Outcome?) {
        _ = try resumeRetirements()
        let inventory = try scan()
        guard let run = inventory.runs[runID], !inventory.retiring.contains(runID) else { throw Failure.missingRun }
        guard run.reports.count <= 1 else { return (nil, .quarantined(.multipleReports)) }
        let stageURL = runURL(runID).appendingPathComponent("stage.evr")
        let receiptURL = runURL(runID).appendingPathComponent("receipt.evr")
        let hasStage = try Files.info(stageURL) != nil, hasReceipt = try Files.info(receiptURL) != nil
        guard let reportURL = run.reports.first else {
            return (nil, hasStage || hasReceipt ? .quarantined(.journal) : .noReport)
        }
        let raw = try Tree.readRaw(reportURL), rawHash = Journal.hash(raw)
        if hasStage {
            let bytes = try Files.read(stageURL, maximum: Journal.Kind.stage.maximum)
            let staged: Journal.Stage
            do { staged = try Journal.open(Journal.Stage.self, bytes: bytes, runID: runID, kind: .stage, key: key()) }
            catch Failure.journal { return (nil, .quarantined(.journal)) }
            guard staged.schemaVersion == 1, staged.rawHash == rawHash,
                  staged.entry.attachmentRefs.isEmpty, staged.entry.envelopeBytes.count <= 512 * 1024,
                  staged.entry.idempotencyKey == Journal.hash(staged.entry.envelopeBytes) else { return (nil, .quarantined(.journal)) }
            // A previous immutable write may have published its fsynced file but
            // failed the directory sync. Reestablish durability before promotion.
            try Files.syncDirectory(runURL(runID))
            // Authenticated stage + identical raw hash preserve the original report/context
            // association without rerunning a newer decoder, policy or context snapshot.
            if hasReceipt {
                let bytesReceipt = try Files.read(receiptURL, maximum: Journal.Kind.receipt.maximum)
                let receipt: Journal.Receipt
                do { receipt = try Journal.open(Journal.Receipt.self, bytes: bytesReceipt, runID: runID, kind: .receipt, key: key()) }
                catch Failure.journal { return (nil, .quarantined(.journal)) }
                guard receipt.schemaVersion == 1, receipt.rawHash == rawHash,
                      receipt.stageHash == Journal.hash(bytes), receipt.reportID == staged.entry.reportId else { return (nil, .quarantined(.journal)) }
                return (nil, .alreadyImported(staged.entry.reportId))
            }
            return (staged, nil)
        }
        guard !hasReceipt else { return (nil, .quarantined(.journal)) }
        let record: NativeCrashRecord
        do { record = try NativeCrashRecordDecoder.decode(raw, redact: { _ in "" }) }
        catch { return (nil, .quarantined(.record)) }
        guard let contextID = record.contextID else { return (nil, .quarantined(.context)) }
        let context: NativeCrashRecoveryContext
        do { context = try NativeCrashRecoveryContext.decode(contextStore.readContext(runID: runID, contextID: contextID)) }
        catch { return (nil, .quarantined(.context)) }
        let entry: OutboxEntry
        do { entry = try context.entry(for: NativeCrashRecordDecoder.decode(raw, redact: context.redaction.compiled())) }
        catch { return (nil, .quarantined(.record)) }
        let value = Journal.Stage(schemaVersion: 1, rawHash: rawHash, contextID: contextID, entry: entry)
        let sealed = try Journal.seal(value, runID: runID, kind: .stage, key: key())
        try reserve(sealed.count, runID: runID, inventory: inventory)
        try Files.writeImmutable(sealed, to: stageURL)
        return (value, nil)
    }

    private func reserve(_ bytes: Int, runID: UUID, inventory: Inventory) throws {
        guard let run = inventory.runs[runID], run.bytes <= limits.maxRunBytes - bytes,
              inventory.bytes <= limits.maxTotalBytes - bytes else { throw Failure.capacity }
    }
    private func rawInventory() throws -> (runs: [UUID: Tree.Inventory], retiring: [UUID]) {
        for name in try Files.entries(rootURL, maximum: 2) {
            guard name == "contexts" || name == "runs" else { throw Failure.unsafePath }
        }
        var runs: [UUID: Tree.Inventory] = [:], retiring: [UUID] = []
        for name in try Files.entries(runsURL, maximum: 32) {
            let tombstone = name.hasPrefix(".retiring-")
            guard let id = Tree.uuid(tombstone ? String(name.dropFirst(10)) : name),
                  runs[id] == nil else { throw Failure.unsafePath }
            runs[id] = try Tree.scan(runsURL.appendingPathComponent(name), maximum: limits.maxRunBytes)
            if tombstone { retiring.append(id) }
        }
        return (runs, retiring)
    }
    private func scan() throws -> Inventory {
        let raw = try rawInventory()
        let contexts = try contextStore.runs(), ids = Set(contexts.map(\.id))
        guard raw.runs.keys.allSatisfy({ ids.contains($0) || raw.retiring.contains($0) }) else { throw Failure.unsafePath }
        return Inventory(contexts: contexts, runs: raw.runs, retiring: raw.retiring)
    }
    /// A durable raw tombstone is the retirement authority even when recursive
    /// context removal already deleted its run header. Validate raw trees first;
    /// removeRun independently checks every remaining context entry without
    /// requiring the header. Unknown content and active/in-flight IDs still block.
    private func resumeRetirements() throws -> Int {
        let raw = try rawInventory()
        var count = 0
        for id in raw.retiring where !excluded(id) {
            let context = rootURL.appendingPathComponent("contexts/" + id.uuidString.lowercased())
            if try Files.info(context) != nil { try contextStore.removeRun(id) }
            let tombstone = runsURL.appendingPathComponent(".retiring-" + id.uuidString.lowercased())
            try FileManager.default.removeItem(at: tombstone)
            try Files.syncDirectory(runsURL)
            count += 1
        }
        return count
    }
    private func maintainLocked(now: Date) throws -> Int {
        guard now.timeIntervalSince1970.isFinite else { throw Failure.invalidLimits }
        var count = try resumeRetirements()
        var inventory = try scan()
        for run in inventory.contexts where !excluded(run.id) && now.timeIntervalSince(run.createdAt) >= limits.maxAge {
            try retire(run.id, inventory: inventory); count += 1
        }
        inventory = try scan()
        while inventory.contexts.count > limits.maxRuns || inventory.bytes > limits.maxTotalBytes {
            guard let candidate = inventory.contexts.first(where: { !excluded($0.id) }) else { throw Failure.capacity }
            try retire(candidate.id, inventory: inventory); count += 1; inventory = try scan()
        }
        return count
    }
    private func retire(_ id: UUID, inventory: Inventory) throws {
        guard !excluded(id) else { throw Failure.activeRun }
        let tombstone = runsURL.appendingPathComponent(".retiring-" + id.uuidString.lowercased())
        if inventory.runs[id] != nil, !inventory.retiring.contains(id) {
            try FileManager.default.moveItem(at: runURL(id), to: tombstone)
            try Files.syncDirectory(runsURL)
        }
        if inventory.contexts.contains(where: { $0.id == id }) { try contextStore.removeRun(id) }
        if try Files.info(tombstone) != nil {
            _ = try Tree.scan(tombstone, maximum: limits.maxRunBytes)
            try FileManager.default.removeItem(at: tombstone); try Files.syncDirectory(runsURL)
        }
    }
    private func excluded(_ id: UUID) -> Bool { activeRunIDs.contains(id) || Self.inFlight.contains(lease(id)) }
    private func lease(_ id: UUID) -> String { rootURL.path + "/" + id.uuidString.lowercased() }
    private func runURL(_ id: UUID) -> URL { runsURL.appendingPathComponent(id.uuidString.lowercased(), isDirectory: true) }
    private func key() throws -> Data {
        do { let data = try keyProvider(); guard data.count == 32 else { throw Failure.unavailable }; return data }
        catch { throw Failure.unavailable }
    }
    private func locked<T>(_ action: () throws -> T) throws -> T {
        try Self.lock.withLock { try Self.checked(action) }
    }
    private static func checked<T>(_ action: () throws -> T) throws -> T {
        do { return try action() }
        catch let error as Failure { throw error }
        catch let error as NativeCrashContextStore.Failure {
            switch error {
            case .capacity: throw Failure.capacity
            case .unsafePath, .unknownEntry: throw Failure.unsafePath
            case .missingRun: throw Failure.missingRun
            default: throw Failure.io
            }
        }
        catch { throw Failure.io }
    }
}
