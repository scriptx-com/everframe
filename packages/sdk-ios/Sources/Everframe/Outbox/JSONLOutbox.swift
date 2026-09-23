// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import CryptoKit

/// One persisted entry in the outbox: a serialized envelope plus the
/// metadata needed to retransmit it without re-running capture.
public struct OutboxEntry: Codable, Sendable, Equatable {
    public let reportId: UUID
    public let createdAt: Date
    public let envelopeBytes: Data            // base64-encoded by JSONEncoder
    public let idempotencyKey: String
    public let attachmentRefs: [AttachmentRef]
    /// The Everframe SDK key configured when this entry was queued. Drain submits with
    /// THIS key, never the currently-configured one — otherwise
    /// `start(projectA) → offline submit → start(projectB)` ships A's whole
    /// report (screenshot, network bodies, reporter identity) into B.
    /// Non-optional on purpose: a legacy line without it fails to decode and
    /// is dropped by `readAll`'s skip-malformed path. Never give it a default.
    public let sdkKey: String
    /// The ingest URL this entry was queued against. Stored alongside the key
    /// because the endpoint is independently redirectable (`IngestEndpoint`
    /// reads a dev override in DEBUG), so a key alone can still reach the
    /// wrong host. `String`, not `URL`, so a malformed value degrades to a
    /// skipped entry rather than a decode failure.
    public let endpoint: String
    /// The verified-identity subject (`sub`) this report was CAPTURED under —
    /// `EFCapturedUser.identitySubject` at the moment `enqueueToOutbox` ran.
    /// `nil` means the report was captured anonymously (no cached token, or
    /// identity disabled for the project) and must never be retroactively
    /// attributed on drain, however the holder is configured by then.
    ///
    /// Deliberately UNLIKE `sdkKey`/`endpoint` above: those have no default,
    /// so a legacy line missing either one fails `Decodable` and `readAll`'s
    /// skip-malformed path drops the whole entry (PR #63) — correct there,
    /// because a report with no known destination can't be routed at all.
    /// Here, absence means "anonymous", which is the fail-closed direction,
    /// so a `= nil` default lets a report queued by an Everframe SDK built before this
    /// field existed keep decoding and keep submitting, just without a
    /// header, rather than being silently discarded.
    public let identitySubject: String?

    public struct AttachmentRef: Codable, Sendable, Equatable {
        public let name: String
        public let filename: String
        public let contentType: String
        public let dataBase64: String
        public let sha256Hex: String

        public init(name: String, filename: String, contentType: String, dataBase64: String, sha256Hex: String) {
            self.name = name
            self.filename = filename
            self.contentType = contentType
            self.dataBase64 = dataBase64
            self.sha256Hex = sha256Hex
        }
    }

    public init(
        reportId: UUID,
        createdAt: Date,
        envelopeBytes: Data,
        idempotencyKey: String,
        attachmentRefs: [AttachmentRef],
        sdkKey: String,
        endpoint: String,
        identitySubject: String? = nil
    ) {
        self.reportId = reportId
        self.createdAt = createdAt
        self.envelopeBytes = envelopeBytes
        self.idempotencyKey = idempotencyKey
        self.attachmentRefs = attachmentRefs
        self.sdkKey = sdkKey
        self.endpoint = endpoint
        self.identitySubject = identitySubject
    }
}

/// AES-GCM-encrypted JSONL outbox at `Library/Caches/dev.everframe/outbox.jsonl`.
///
/// Capacity policy: at most `maxEntries` entries AND at most `maxTotalBytes`
/// of actual persisted bytes, including attachments and encryption overhead;
/// on overflow, oldest entries are evicted first. Oversized new reports throw.
///
/// All writes go through a temp-file rename to keep the on-disk JSONL atomic
/// across process crashes.
public final class JSONLOutbox: @unchecked Sendable {

    public static let DEFAULT_MAX_ENTRIES = 50
    public static let DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024
    private static let magic = Data("EVRBOX01".utf8)
    private static let encryptionOverhead = 8 + 12 + 16 // version + nonce + GCM tag

    private let fileURL: URL

    /// The path this outbox actually resolved to. Read-only; exists so tests
    /// can assert the default path is isolated (see `outboxURL`).
    public var resolvedFileURL: URL { fileURL }

    private let maxEntries: Int
    private let maxTotalBytes: Int
    // Separate submitters/crash capture construct separate outbox instances.
    // Their read-modify-write transactions must share one in-process owner.
    private static let storageQueue = DispatchQueue(label: "dev.everframe.outbox", qos: .utility)
    private var queue: DispatchQueue { Self.storageQueue }
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private let keyProvider: @Sendable () throws -> Data

    /// Designated initializer (used by tests with a custom path).
    public convenience init(fileURL: URL, maxEntries: Int = JSONLOutbox.DEFAULT_MAX_ENTRIES, maxTotalBytes: Int = JSONLOutbox.DEFAULT_MAX_TOTAL_BYTES) {
        self.init(fileURL: fileURL, maxEntries: maxEntries, maxTotalBytes: maxTotalBytes,
            keyProvider: { try OutboxEncryptionKey.getOrCreate() })
    }

    init(fileURL: URL, maxEntries: Int = JSONLOutbox.DEFAULT_MAX_ENTRIES,
         maxTotalBytes: Int = JSONLOutbox.DEFAULT_MAX_TOTAL_BYTES,
         keyProvider: @escaping @Sendable () throws -> Data) {
        self.fileURL = fileURL
        self.maxEntries = max(0, maxEntries)
        self.maxTotalBytes = max(0, maxTotalBytes)
        self.keyProvider = keyProvider
        self.encoder = JSONEncoder()
        self.encoder.dateEncodingStrategy = .iso8601
        self.decoder = JSONDecoder()
        self.decoder.dateDecodingStrategy = .iso8601
        // Ensure parent dir exists (safe if pre-existing).
        let parent = fileURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
    }

    /// Convenience: production path = `Library/Caches/dev.everframe/outbox.jsonl`.
    public convenience init() {
        self.init(fileURL: JSONLOutbox.outboxURL())
    }

    /// Per-LAUNCH temp directory for the default outbox under XCTest.
    ///
    /// A `static let`, so every `JSONLOutbox()` in one process resolves to the
    /// SAME file — `CrashSidecar.hydrateInto` folding entries into the main
    /// outbox depends on that — while the UUID makes it unique across processes.
    ///
    /// The UUID is load-bearing and must not become the process ID. An earlier
    /// revision keyed this directory on `processIdentifier`, but PIDs are
    /// recycled by the OS and nothing ever removes these directories, so a later
    /// test process could inherit a previous run's entries. Since drain now
    /// submits with each entry's OWN stored endpoint, and `IngestEndpoint.url`
    /// falls back to production whenever the dev overrides are unset, such an
    /// inherited entry would upload to PRODUCTION ingest — reconstructing
    /// exactly the leak this isolation exists to prevent.
    private static let testOutboxDirectory: URL = {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("dev.everframe-test-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    private static func outboxURL() -> URL {
        // Under XCTest the default path must be per-launch. The production
        // path is `Library/Caches/dev.everframe`, which on macOS is
        // machine-global: every `swift test` run, every sample app and every
        // developer session share one file. Combined with `IngestEndpoint.url`
        // defaulting to production whenever the dev overrides are unset, that
        // let a test run drain another run's leftover envelopes to PRODUCTION
        // ingest. Per-launch also removes the cross-test contamination that
        // shared-state flake comes from.
        //
        // NOT wrapped in `#if DEBUG`, unlike `IngestEndpoint`'s dev override,
        // and the difference is deliberate. An earlier revision did guard this
        // with `#if DEBUG` for symmetry with that file, but the two guards
        // protect different things:
        //
        //   - `IngestEndpoint`'s `#if DEBUG` keeps a *redirectable ingest URL*
        //     out of shipped binaries. That is a real attack surface — an env
        //     var that reroutes where reports are uploaded — so it must not
        //     exist in release at all.
        //   - This branch only chooses a local file path. It cannot be turned
        //     into an exfiltration primitive: the worst a forced-true predicate
        //     achieves is queueing reports into a temp directory.
        //
        // Compiling it out therefore bought nothing and cost real safety:
        // `swift test -c release`, or an Xcode Release-configured test action,
        // fell through to the machine-global cache path while release also
        // hardcodes the production endpoint — draining residual test reports
        // straight to production, the exact leak this isolation exists to
        // prevent. The runtime predicate below is the only gate that matters,
        // and it cannot be true outside an actual XCTest host.
        //
        // Detect XCTest via two complementary methods (both required):
        // - `XCTestConfigurationFilePath` env var: set by Xcode and `xcodebuild test`
        //   (simulator-hosted test jobs where XCTest injects config into the test host).
        // - `Bundle.main.bundleIdentifier == "com.apple.dt.xctest.tool"`: set by
        //   the `swift test` CLI, which spawns the test bundle under Apple's xctest
        //   tool. This tool does not set `XCTestConfigurationFilePath` in the child.
        // Removing either branch loses detection in one of these environments.
        if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil ||
           Bundle.main.bundleIdentifier == "com.apple.dt.xctest.tool" {
            return testOutboxDirectory.appendingPathComponent("outbox.jsonl")
        }
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let dir = caches.appendingPathComponent("dev.everframe", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("outbox.jsonl")
    }

    public var count: Int {
        return queue.sync { (try? readAll().count) ?? 0 }
    }

    /// Append one entry; evict oldest entries until under capacity.
    public func enqueue(_ entry: OutboxEntry) throws {
        try queue.sync {
            var entries = try readAll()
            entries.removeAll { $0.reportId == entry.reportId }
            entries.append(entry)
            entries = try applyCapacity(entries)
            try writeAll(entries)
        }
    }

    /// Read every entry currently on disk; returns empty if the file is missing.
    public func hydrate() throws -> [OutboxEntry] {
        return try queue.sync { try readAll() }
    }

    /// Atomically remove every entry matching the predicate.
    public func drain(where predicate: (OutboxEntry) -> Bool) throws {
        try queue.sync {
            var entries = try readAll()
            entries.removeAll(where: predicate)
            try writeAll(entries)
        }
    }

    // MARK: - Private I/O

    private func readAll() throws -> [OutboxEntry] {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return [] }
        let stored = try Data(contentsOf: fileURL)
        // No legacy migration: unprotected native report queues are obsolete.
        guard stored.starts(with: Self.magic) else { return [] }
        let sealed = try AES.GCM.SealedBox(combined: stored.dropFirst(Self.magic.count))
        let data = try AES.GCM.open(sealed, using: encryptionKey(), authenticating: Self.magic)
        var out: [OutboxEntry] = []
        // JSONL: split on newline, skip empty lines, decode each.
        for line in data.split(separator: 0x0a, omittingEmptySubsequences: true) {
            do {
                let entry = try decoder.decode(OutboxEntry.self, from: Data(line))
                out.append(entry)
            } catch {
                // Skip malformed line — best-effort outbox (T-04-20: accept).
                continue
            }
        }
        return out
    }

    private func writeAll(_ entries: [OutboxEntry]) throws {
        if entries.isEmpty {
            if FileManager.default.fileExists(atPath: fileURL.path) { try FileManager.default.removeItem(at: fileURL) }
            return
        }
        var blob = Data()
        for entry in entries {
            let line = try encoder.encode(entry)
            blob.append(line)
            blob.append(0x0a)  // newline
        }
        let sealed = try AES.GCM.seal(blob, using: encryptionKey(), authenticating: Self.magic)
        guard let combined = sealed.combined else { throw OutboxStorageError.invalidKey }
        let protected = Self.magic + combined
        guard protected.count <= maxTotalBytes else { throw OutboxStorageError.capacityExceeded }
        // Only ciphertext ever reaches a temporary file.
        let tempURL = fileURL.deletingLastPathComponent()
            .appendingPathComponent("outbox-\(UUID().uuidString).tmp")
        defer { try? FileManager.default.removeItem(at: tempURL) }
        #if canImport(UIKit)
        // The ciphertext and its AfterFirstUnlockThisDeviceOnly key must both
        // remain available for background/crash enqueue after the device locks.
        // AES-GCM still protects the queue; neither is available before first unlock.
        try protected.write(to: tempURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try protected.write(to: tempURL, options: .atomic)
        #endif
        if FileManager.default.fileExists(atPath: fileURL.path) {
            // Adopt the new ciphertext's protection instead of retaining a
            // legacy queue's complete protection when replacing it while unlocked.
            _ = try FileManager.default.replaceItemAt(fileURL, withItemAt: tempURL, options: .usingNewMetadataOnly)
        } else {
            try FileManager.default.moveItem(at: tempURL, to: fileURL)
        }
    }

    private func encryptionKey() throws -> SymmetricKey {
        let data = try keyProvider()
        guard data.count == 32 else { throw OutboxStorageError.invalidKey }
        return SymmetricKey(data: data)
    }

    private func applyCapacity(_ entries: [OutboxEntry]) throws -> [OutboxEntry] {
        let sizes = try entries.map { try encoder.encode($0).count + 1 }
        guard maxEntries > 0, let newestSize = sizes.last,
              newestSize <= maxTotalBytes - Self.encryptionOverhead else { throw OutboxStorageError.capacityExceeded }
        var out = entries
        var index = 0
        var total = sizes.reduce(Self.encryptionOverhead, +)
        while out.count > maxEntries || total > maxTotalBytes {
            out.removeFirst()
            total -= sizes[index]; index += 1
        }
        return out
    }
}
