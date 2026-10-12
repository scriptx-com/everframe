// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import CryptoKit
import Darwin

/// Process-wide serialization plus fresh reads protects multiple SDK instances.
/// The app-private directory must not be shared with another process or extension.
final class ReleaseHealthStore {
    enum Failure: Error { case invalid, capacity }
    private struct State: Codable { var version = 1; var entries: [ReleaseHealthEntry] = [] }
    private static let lock = NSLock()
    private static let magic = Data("EFHLTH01".utf8)
    static let maximum = 1024 * 1024
    static let lifetime: TimeInterval = 7 * 86400
    private let root: URL
    private let key: Data
    private let beforeCommit: () throws -> Void

    init(root: URL, keyProvider: () throws -> Data = { try OutboxEncryptionKey.getOrCreate() },
         beforeCommit: @escaping () throws -> Void = {}) throws {
        self.root = root; key = try keyProvider(); self.beforeCommit = beforeCommit
        guard key.count == 32 else { throw Failure.invalid }
        try Self.lock.withLock {
            if try NativeCrashContextFiles.info(root) == nil { try NativeCrashContextFiles.makeDirectory(root) }
            _ = try read()
        }
    }
    func pending() throws -> [ReleaseHealthEntry] { try Self.lock.withLock { try read().entries } }
    func append(_ entry: ReleaseHealthEntry) throws {
        try Self.lock.withLock {
            try Self.validate(entry)
            var state = try read()
            if let old = state.entries.first(where: { $0.recordID == entry.recordID }) {
                guard old == entry else { throw Failure.invalid }; return
            }
            guard state.entries.count < 256 else { throw Failure.capacity }
            state.entries.append(entry); try commit(state)
        }
    }
    func settle(_ id: UUID) throws {
        try Self.lock.withLock {
            var state = try read(); let old = state.entries.count
            state.entries.removeAll { $0.recordID == id }
            if old != state.entries.count { try commit(state) }
        }
    }
    func erase() throws { try Self.lock.withLock { _ = try read(); try commit(State()) } }
    func maintain(now: Date) throws {
        try Self.lock.withLock {
            var state = try read(); let old = state.entries.count
            state.entries.removeAll { $0.createdAt > now || now.timeIntervalSince($0.createdAt) >= Self.lifetime }
            if old != state.entries.count { try commit(state) }
        }
    }
    static func eraseAmbiguous(root: URL) throws {
        try lock.withLock {
            let names = try NativeCrashContextFiles.entries(root, maximum: 16)
            guard names.allSatisfy({ $0 == "state" || $0 == ".pending" || ($0.hasPrefix(".context-") && $0.hasSuffix(".tmp")) }) else { throw Failure.invalid }
            for name in names {
                let path = root.appendingPathComponent(name)
                guard let info = try NativeCrashContextFiles.info(path), info.st_mode & S_IFMT != S_IFDIR else { throw Failure.invalid }
                guard unlink(path.path) == 0 else { throw NativeCrashContextFiles.posixError() }
            }
            try NativeCrashContextFiles.syncDirectory(root)
        }
    }
    private func read() throws -> State {
        let names = try NativeCrashContextFiles.entries(root, maximum: 16)
        guard names.allSatisfy({ $0 == "state" }) else { throw Failure.invalid }
        guard names.contains("state") else { return State() }
        let bytes = try NativeCrashContextFiles.read(root.appendingPathComponent("state"), maximum: Self.maximum)
        guard bytes.starts(with: Self.magic) else { throw Failure.invalid }
        let state: State
        do {
            let box = try AES.GCM.SealedBox(combined: bytes.dropFirst(Self.magic.count))
            let plain = try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: Self.magic)
            state = try JSONDecoder().decode(State.self, from: plain)
        } catch { throw Failure.invalid }
        guard state.version == 1, state.entries.count <= 256,
              Set(state.entries.map(\.recordID)).count == state.entries.count else { throw Failure.invalid }
        for entry in state.entries { try Self.validate(entry) }
        return state
    }
    private static func validate(_ entry: ReleaseHealthEntry) throws {
        guard entry.body.count <= 8192, !entry.body.isEmpty,
              ReleaseHealthConfiguration.validText(entry.sdkKey, maximum: 4096),
              entry.endpoint.utf8.count <= 4096, let route = URLComponents(string: entry.endpoint),
              ["http", "https"].contains(route.scheme), route.host?.isEmpty == false,
              route.user == nil, route.password == nil, route.fragment == nil else { throw Failure.invalid }
    }
    private func commit(_ state: State) throws {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let plain = try encoder.encode(state)
        guard plain.count <= Self.maximum - 64 else { throw Failure.capacity }
        let box = try AES.GCM.seal(plain, using: SymmetricKey(data: key), authenticating: Self.magic)
        guard let combined = box.combined else { throw Failure.invalid }
        try beforeCommit()
        let pending = root.appendingPathComponent(".pending"), destination = root.appendingPathComponent("state")
        try NativeCrashContextFiles.writeImmutable(Self.magic + combined, to: pending)
        if try NativeCrashContextFiles.info(destination) != nil { _ = try NativeCrashContextFiles.regular(destination) }
        guard rename(pending.path, destination.path) == 0 else { throw NativeCrashContextFiles.posixError() }
        try NativeCrashContextFiles.syncDirectory(root)
    }
}
