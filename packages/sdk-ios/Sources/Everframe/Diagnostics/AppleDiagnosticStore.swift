// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import CryptoKit
import Darwin

/// Serialized by the runtime worker. Atomic authenticated replacement never
/// grants authority from an unfinished write or a malformed journal.
final class AppleDiagnosticStore {
    enum Failure: Error { case invalid, capacity, revoked }
    struct Receipt: Codable {
        let hash: String
        let entry: OutboxEntry
        var settled: Bool
    }
    private struct State: Codable {
        var version = 1
        var authorityID = UUID()
        var revoked = true
        // An absent state file cannot prove the shared queue was erased.
        // This also recovers a process death during ambiguous-journal reset.
        var needsOutboxErase = true
        var receipts: [Receipt] = []
    }
    private let root: URL
    private let key: Data
    private var state: State
    private let beforeCommit: () throws -> Void
    private static let magic = Data("EFAPPL01".utf8)
    private static let maximum = 4 * 1024 * 1024
    static let lifetime: TimeInterval = 7 * 86400
    var authorityID: UUID { state.authorityID }
    var isRevoked: Bool { state.revoked }
    var needsOutboxErase: Bool { state.needsOutboxErase }
    var pending: [OutboxEntry] { state.receipts.filter { !$0.settled }.map(\.entry) }
    func existing(hash: String) -> OutboxEntry? { state.receipts.first { $0.hash == hash }?.entry }

    init(root: URL, keyProvider: () throws -> Data = { try OutboxEncryptionKey.getOrCreate() },
         beforeCommit: @escaping () throws -> Void = {}) throws {
        self.root = root; self.key = try keyProvider(); self.beforeCommit = beforeCommit
        guard key.count == 32 else { throw Failure.invalid }
        if try NativeCrashContextFiles.info(root) == nil { try NativeCrashContextFiles.makeDirectory(root) }
        try NativeCrashContextFiles.directory(root)
        let entries = try NativeCrashContextFiles.entries(root, maximum: 4)
        guard entries.allSatisfy({ $0 == "state" }) else { throw Failure.invalid }
        if entries.contains("state") {
            let bytes = try NativeCrashContextFiles.read(root.appendingPathComponent("state"), maximum: Self.maximum)
            guard bytes.starts(with: Self.magic) else { throw Failure.invalid }
            do {
                let box = try AES.GCM.SealedBox(combined: bytes.dropFirst(Self.magic.count))
                let plain = try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: Self.magic)
                let decoder = JSONDecoder()
                state = try decoder.decode(State.self, from: plain)
            } catch { throw Failure.invalid }
            guard state.version == 1, state.receipts.count <= 32,
                  (!state.revoked || state.receipts.isEmpty),
                  Set(state.receipts.map { $0.entry.reportId }).count == state.receipts.count,
                  Set(state.receipts.map(\.hash)).count == state.receipts.count else { throw Failure.invalid }
        } else { state = State() }
    }

    /// Only used after closing all in-memory authority. Unknown entries are
    /// unlinked, never followed; an unsafe root itself remains a hard failure.
    static func eraseAmbiguous(root: URL) throws {
        try NativeCrashContextFiles.directory(root)
        for name in try NativeCrashContextFiles.entries(root, maximum: 4) {
            let path = root.appendingPathComponent(name)
            guard let info = try NativeCrashContextFiles.info(path), info.st_mode & S_IFMT != S_IFDIR else { throw Failure.invalid }
            guard unlink(path.path) == 0 else { throw NativeCrashContextFiles.posixError() }
        }
        try NativeCrashContextFiles.syncDirectory(root)
    }

    func activate() throws {
        guard !state.needsOutboxErase else { throw Failure.revoked }
        if !state.revoked { return }
        var next = state; next.revoked = false; try commit(next)
    }
    func stage(_ entry: OutboxEntry, hash: String) throws {
        guard !state.revoked else { throw Failure.revoked }
        if let old = state.receipts.first(where: { $0.hash == hash || $0.entry.reportId == entry.reportId }) {
            guard old.hash == hash, old.entry == entry else { throw Failure.invalid }; return
        }
        guard state.receipts.count < 32, hash.count == 64 else { throw Failure.capacity }
        var next = state; next.receipts.append(.init(hash: hash, entry: entry, settled: false)); try commit(next)
    }
    func settle(_ id: UUID) throws {
        guard let index = state.receipts.firstIndex(where: { $0.entry.reportId == id }), !state.receipts[index].settled else { return }
        var next = state; next.receipts[index].settled = true; try commit(next)
    }
    func revoke() throws {
        var next = State(); next.needsOutboxErase = true; try commit(next)
    }
    func finishErasure() throws {
        guard state.revoked else { throw Failure.invalid }
        var next = state; next.needsOutboxErase = false; try commit(next)
    }
    /// Returns whether expired receipts were removed.
    @discardableResult func maintain(now: Date) throws -> Bool {
        var next = state
        next.receipts.removeAll { now.timeIntervalSince($0.entry.createdAt) >= Self.lifetime || $0.entry.createdAt > now }
        guard next.receipts.count != state.receipts.count else { return false }
        try commit(next); return true
    }
    private func commit(_ next: State) throws {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let plain = try encoder.encode(next)
        guard plain.count <= Self.maximum - 64 else { throw Failure.capacity }
        let box = try AES.GCM.seal(plain, using: SymmetricKey(data: key), authenticating: Self.magic)
        guard let combined = box.combined else { throw Failure.invalid }
        try beforeCommit()
        let pending = root.appendingPathComponent(".pending")
        try NativeCrashContextFiles.writeImmutable(Self.magic + combined, to: pending)
        let destination = root.appendingPathComponent("state")
        if try NativeCrashContextFiles.info(destination) != nil { _ = try NativeCrashContextFiles.regular(destination) }
        guard rename(pending.path, destination.path) == 0 else { throw NativeCrashContextFiles.posixError() }
        try NativeCrashContextFiles.syncDirectory(root)
        state = next
    }
}
