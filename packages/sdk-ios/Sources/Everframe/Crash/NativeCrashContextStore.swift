// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import CryptoKit

/// Immutable context bytes for a later native recovery coordinator. This type
/// neither starts the recorder nor constructs/uploads envelopes. Retirement is
/// explicit: the coordinator must never remove a context still published to a
/// live recorder or needed by a retained raw event.
final class NativeCrashContextStore: @unchecked Sendable {
    struct Limits: Sendable {
        var maxRuns = 16
        var maxContextsPerRun = 256
        var maxPayloadBytes = 64 * 1024
        var maxTotalBytes = 16 * 1024 * 1024
        static let defaults = Limits()
    }
    struct Run: Codable, Equatable, Sendable { let id: UUID; let createdAt: Date }
    enum Failure: Error, Equatable {
        case capacity, unsafePath, unknownEntry, corrupt, alreadyExists, invalidKey, missingRun, io, invalidLimits
    }
    private struct Header: Codable { let schemaVersion: Int; let run: Run }
    private struct Inventory { var runs: [Run] = []; var counts: [UUID: Int] = [:]; var bytes = 0 }
    private typealias Files = NativeCrashContextFiles
    private static let lock = NSLock()
    private static let magic = Data("EFCTX001".utf8)
    private static let overhead = 8 + 12 + 16
    let rootURL: URL
    private let limits: Limits
    private let keyProvider: @Sendable () throws -> Data

    init(rootURL: URL, limits: Limits = .defaults,
         keyProvider: @escaping @Sendable () throws -> Data = { try OutboxEncryptionKey.getOrCreate() }) throws {
        let maximum = Limits.defaults
        guard limits.maxRuns > 0, limits.maxRuns <= maximum.maxRuns,
              limits.maxContextsPerRun > 0, limits.maxContextsPerRun <= maximum.maxContextsPerRun,
              limits.maxPayloadBytes > 0, limits.maxPayloadBytes <= maximum.maxPayloadBytes,
              limits.maxTotalBytes > 0, limits.maxTotalBytes <= maximum.maxTotalBytes else { throw Failure.invalidLimits }
        let normalized = rootURL.standardizedFileURL
        guard normalized.isFileURL, normalized.path == normalized.resolvingSymlinksInPath().path else { throw Failure.unsafePath }
        self.rootURL = normalized; self.limits = limits; self.keyProvider = keyProvider
        try Self.lock.withLock {
            if try Files.info(normalized) == nil { try Files.makeDirectory(normalized) }
            else { try Files.directory(normalized); try Files.protect(normalized, directory: true) }
        }
    }

    /// Admission can leave room for an initial context. This is a capacity check,
    /// not a persistent reservation against other active runs' later writes.
    func createRun(now: Date = Date(), reservingPayloadBytes: Int = 0) throws -> Run {
        try Self.lock.withLock {
            guard reservingPayloadBytes >= 0, reservingPayloadBytes <= limits.maxPayloadBytes else { throw Failure.invalidLimits }
            let inventory = try scan()
            guard inventory.runs.count < limits.maxRuns, now.timeIntervalSince1970.isFinite else { throw Failure.capacity }
            let run = Run(id: UUID(), createdAt: now)
            let encoded = try JSONEncoder().encode(Header(schemaVersion: 1, run: run))
            let reserved = reservingPayloadBytes == 0 ? 0 : reservingPayloadBytes + Self.overhead
            guard encoded.count <= 1024, inventory.bytes <= limits.maxTotalBytes - encoded.count - reserved else { throw Failure.capacity }
            let staging = rootURL.appendingPathComponent(".creating-" + name(run.id), isDirectory: true)
            try Files.makeDirectory(staging)
            defer { try? FileManager.default.removeItem(at: staging) }
            try Files.writeImmutable(encoded, to: staging.appendingPathComponent("run.json"))
            try FileManager.default.moveItem(at: staging, to: runURL(run.id))
            try Files.syncDirectory(rootURL)
            return run
        }
    }

    func writeContext(_ payload: Data, runID: UUID, contextID: UUID = UUID()) throws -> UUID {
        try Self.lock.withLock {
            guard payload.count <= limits.maxPayloadBytes else { throw Failure.capacity }
            let inventory = try scan()
            guard let count = inventory.counts[runID] else { throw Failure.missingRun }
            let path = contextURL(runID, contextID)
            guard try Files.info(path) == nil else { throw Failure.alreadyExists }
            guard count < limits.maxContextsPerRun else { throw Failure.capacity }
            let storedCount = payload.count + Self.overhead
            guard inventory.bytes <= limits.maxTotalBytes - storedCount else { throw Failure.capacity }
            let sealed = try AES.GCM.seal(payload, using: encryptionKey(), authenticating: aad(runID, contextID))
            guard let combined = sealed.combined else { throw Failure.invalidKey }
            try Files.writeImmutable(Self.magic + combined, to: path)
            return contextID
        }
    }

    func readContext(runID: UUID, contextID: UUID) throws -> Data {
        try Self.lock.withLock {
            try Files.directory(rootURL)
            _ = try loadRun(runID)
            let bytes = try Files.read(contextURL(runID, contextID), maximum: limits.maxPayloadBytes + Self.overhead)
            guard bytes.starts(with: Self.magic), bytes.count >= Self.overhead else { throw Failure.corrupt }
            // Keychain failures propagate without removing or replacing any record.
            let key = try encryptionKey()
            do {
                let box = try AES.GCM.SealedBox(combined: bytes.dropFirst(Self.magic.count))
                return try AES.GCM.open(box, using: key, authenticating: aad(runID, contextID))
            } catch { throw Failure.corrupt }
        }
    }

    func runs() throws -> [Run] {
        try Self.lock.withLock {
            try scan().runs.sorted { $0.createdAt == $1.createdAt ? name($0.id) < name($1.id) : $0.createdAt < $1.createdAt }
        }
    }

    /// Explicit retirement can remove corrupt ciphertext, but never follows links
    /// or silently removes unknown content. Caller coordinates raw-event retention.
    /// One rename retires the run before any file is deleted, so an interrupted
    /// removal leaves a recognized tombstone that the next scan finishes.
    func removeRun(_ runID: UUID) throws {
        try Self.lock.withLock {
            try Files.directory(rootURL)
            let path = runURL(runID)
            guard try Files.info(path) != nil else { throw Failure.missingRun }
            try checkRunFiles(path)
            let tombstone = rootURL.appendingPathComponent(".removing-" + name(runID), isDirectory: true)
            try FileManager.default.moveItem(at: path, to: tombstone)
            try Files.syncDirectory(rootURL)
            try removeTombstone(tombstone)
        }
    }

    private func scan() throws -> Inventory {
        var inventory = Inventory()
        for entry in try Files.entries(rootURL, maximum: limits.maxRuns + 8) {
            let path = rootURL.appendingPathComponent(entry, isDirectory: true)
            if entry.hasPrefix(".creating-"), uuid(String(entry.dropFirst(10))) != nil {
                try removeAbandonedRun(path)
                continue
            }
            if entry.hasPrefix(".removing-"), uuid(String(entry.dropFirst(10))) != nil {
                try removeTombstone(path)
                continue
            }
            guard let id = uuid(entry) else { throw Failure.unknownEntry }
            let run = try loadRun(id)
            inventory.runs.append(run)
            guard inventory.runs.count <= limits.maxRuns else { throw Failure.capacity }
            var count = 0
            for filename in try Files.entries(path, maximum: limits.maxContextsPerRun + 8) {
                let file = path.appendingPathComponent(filename)
                let info = try Files.regular(file)
                if stagingContextID(filename) != nil {
                    guard info.st_size >= 0, info.st_size <= limits.maxPayloadBytes + Self.overhead else { throw Failure.capacity }
                    try FileManager.default.removeItem(at: file)
                    continue
                }
                let maximum: Int
                if filename == "run.json" { maximum = 1024 }
                else if contextID(filename) != nil { count += 1; maximum = limits.maxPayloadBytes + Self.overhead }
                else { throw Failure.unknownEntry }
                guard count <= limits.maxContextsPerRun, info.st_size >= 0, info.st_size <= maximum else { throw Failure.capacity }
                let size = Int(info.st_size)
                guard inventory.bytes <= limits.maxTotalBytes - size else { throw Failure.capacity }
                inventory.bytes += size
            }
            inventory.counts[id] = count
        }
        return inventory
    }

    private func removeAbandonedRun(_ path: URL) throws {
        try Files.directory(path)
        for name in try Files.entries(path, maximum: 3) {
            guard name == "run.json" || stagingContextID(name) != nil else { throw Failure.unknownEntry }
            let info = try Files.regular(path.appendingPathComponent(name))
            guard info.st_size >= 0, info.st_size <= 1024 else { throw Failure.capacity }
        }
        try FileManager.default.removeItem(at: path)
    }

    /// A run or retirement tombstone holds only recognized regular files; any
    /// subset is valid because deletion can stop after an arbitrary unlink.
    private func checkRunFiles(_ path: URL) throws {
        try Files.directory(path)
        for entry in try Files.entries(path, maximum: limits.maxContextsPerRun + 8) {
            guard entry == "run.json" || contextID(entry) != nil || stagingContextID(entry) != nil else { throw Failure.unknownEntry }
            try Files.regular(path.appendingPathComponent(entry))
        }
    }

    private func removeTombstone(_ path: URL) throws {
        try checkRunFiles(path)
        try FileManager.default.removeItem(at: path)
        try Files.syncDirectory(rootURL)
    }

    private func loadRun(_ id: UUID) throws -> Run {
        let path = runURL(id)
        guard try Files.info(path) != nil else { throw Failure.missingRun }
        try Files.directory(path)
        let data = try Files.read(path.appendingPathComponent("run.json"), maximum: 1024)
        do {
            let header = try JSONDecoder().decode(Header.self, from: data)
            guard header.schemaVersion == 1, header.run.id == id,
                  header.run.createdAt.timeIntervalSince1970.isFinite else { throw Failure.corrupt }
            return header.run
        } catch { throw Failure.corrupt }
    }

    private func encryptionKey() throws -> SymmetricKey {
        let bytes = try keyProvider()
        guard bytes.count == 32 else { throw Failure.invalidKey }
        return SymmetricKey(data: bytes)
    }
    private func aad(_ runID: UUID, _ contextID: UUID) -> Data {
        Self.magic + Data((name(runID) + "/" + name(contextID)).utf8)
    }
    private func name(_ id: UUID) -> String { id.uuidString.lowercased() }
    private func uuid(_ value: String) -> UUID? {
        guard let id = UUID(uuidString: value), name(id) == value else { return nil }; return id
    }
    private func contextID(_ value: String) -> UUID? {
        guard value.hasSuffix(".evctx") else { return nil }; return uuid(String(value.dropLast(6)))
    }
    private func stagingContextID(_ value: String) -> UUID? {
        guard value.hasPrefix(".context-"), value.hasSuffix(".tmp") else { return nil }
        return uuid(String(value.dropFirst(9).dropLast(4)))
    }
    private func runURL(_ id: UUID) -> URL { rootURL.appendingPathComponent(name(id), isDirectory: true) }
    private func contextURL(_ run: UUID, _ context: UUID) -> URL { runURL(run).appendingPathComponent(name(context) + ".evctx") }
}
