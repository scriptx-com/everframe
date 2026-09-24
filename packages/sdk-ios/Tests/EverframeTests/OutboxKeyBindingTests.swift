// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

/// Outbox key binding (spec 2026-08-12). Pure storage + submit-pipeline tests:
/// no `Everframe.shared`, no stderr intercept, no UIKit — the criteria for
/// joining the `swift.yml` companion filter.
final class OutboxKeyBindingTests: XCTestCase {
    func test_drain_keeps_report_on_disk_until_server_accepts_it() async throws {
        RecordingURLProtocol.reset()
        defer { RecordingURLProtocol.reset() }
        let box = makeOutbox()
        try box.enqueue(entry(key: "key-A", endpoint: "https://a.example.com", idem: "idem-A"))
        RecordingURLProtocol.onRequest = { XCTAssertEqual(box.count, 1, "An in-flight retry must still be durable") }
        let session = stubbedSession(); defer { session.invalidateAndCancel() }
        let submitter = ReportSubmitter(config: EverframeConfig(appId: "key-A"), outbox: box, session: session)
        await submitter.drainOutbox(identityHolder: IdentityTokenHolder(), currentReplayConfig: { .off },
            epochAtInitiation: 0, currentEpoch: { 0 })
        XCTAssertEqual(box.count, 0)
    }
    func test_retryable_upload_does_not_claim_queued_when_persistence_fails() async throws {
        RecordingURLProtocol.reset()
        RecordingURLProtocol.responseStatus = 503
        let box = JSONLOutbox(fileURL: tempDir.appendingPathComponent("failed-outbox"),
            keyProvider: { throw CocoaError(.fileWriteNoPermission) })
        let session = stubbedSession(); defer { session.invalidateAndCancel() }
        let submitter = ReportSubmitter(config: EverframeConfig(appId: "key-A"), outbox: box, session: session)
        do {
            _ = try await submitter.submit(envelopeBytes: Data("{}".utf8), idempotencyKey: "idem",
                attachments: [], endpoint: "https://a.example.com")
            XCTFail("A report that was not persisted must not be reported as queued")
        } catch {
            XCTAssertEqual((error as? CocoaError)?.code, .fileWriteNoPermission)
        }
    }

    private var tempDir: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("everframe-keybinding-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tempDir)
        try super.tearDownWithError()
    }

    private func makeOutbox() -> JSONLOutbox {
        JSONLOutbox(testFileURL: tempDir.appendingPathComponent("outbox.jsonl"))
    }

    func test_entry_roundtrips_sdkKey_and_endpoint() throws {
        let box = makeOutbox()
        try box.enqueue(OutboxEntry(
            reportId: UUID(),
            createdAt: Date(),
            envelopeBytes: Data("x".utf8),
            idempotencyKey: "idem-1",
            attachmentRefs: [],
            sdkKey: "key-A",
            endpoint: "https://a.example.com"
        ))

        let out = try box.hydrate()
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].sdkKey, "key-A")
        XCTAssertEqual(out[0].endpoint, "https://a.example.com")
    }

    /// The entire migration story, isolated per field. A pre-fix line has no
    /// `sdkKey`/`endpoint`, so `JSONDecoder` throws `keyNotFound` and
    /// `readAll`'s existing `catch { continue }` drops it. Each case omits
    /// exactly ONE of the two keys (leaving the other present with a real
    /// value) so a future regression on either field alone is caught —
    /// `keyNotFound` fires for ANY missing required key, so a line missing
    /// both fields could not tell "both regressed" apart from "only one
    /// regressed"; these two cases can. If someone gives `sdkKey` OR
    /// `endpoint` a default value, the corresponding case below fails and
    /// the leak is back for every legacy entry missing that field.
    func test_legacy_line_missing_only_sdkKey_is_dropped() throws {
        let url = tempDir.appendingPathComponent("outbox.jsonl")
        let legacy = """
        {"reportId":"\(UUID().uuidString)","createdAt":"2026-08-12T00:00:00Z",\
        "envelopeBytes":"eA==","idempotencyKey":"idem-legacy","attachmentRefs":[],\
        "endpoint":"https://a.example.com"}
        """
        XCTAssertFalse(legacy.contains("sdkKey"), "sdkKey must be absent from this line")
        XCTAssertTrue(legacy.contains("\"endpoint\":\"https://a.example.com\""),
                      "endpoint must survive present in this line")
        try (legacy + "\n").write(to: url, atomically: true, encoding: .utf8)

        let box = JSONLOutbox(testFileURL: url)
        XCTAssertEqual(
            try box.hydrate().count, 0,
            "an entry missing only sdkKey cannot be routed and must not hydrate")
    }

    func test_legacy_line_missing_only_endpoint_is_dropped() throws {
        let url = tempDir.appendingPathComponent("outbox.jsonl")
        let legacy = """
        {"reportId":"\(UUID().uuidString)","createdAt":"2026-08-12T00:00:00Z",\
        "envelopeBytes":"eA==","idempotencyKey":"idem-legacy","attachmentRefs":[],\
        "sdkKey":"key-A"}
        """
        XCTAssertFalse(legacy.contains("endpoint"), "endpoint must be absent from this line")
        XCTAssertTrue(legacy.contains("\"sdkKey\":\"key-A\""),
                      "sdkKey must survive present in this line")
        try (legacy + "\n").write(to: url, atomically: true, encoding: .utf8)

        let box = JSONLOutbox(testFileURL: url)
        XCTAssertEqual(
            try box.hydrate().count, 0,
            "an entry missing only endpoint cannot be routed and must not hydrate")
    }

    private func entry(key: String, endpoint: String, idem: String) -> OutboxEntry {
        OutboxEntry(
            reportId: UUID(),
            createdAt: Date(),
            envelopeBytes: Data("{}".utf8),
            idempotencyKey: idem,
            attachmentRefs: [],
            sdkKey: key,
            endpoint: endpoint
        )
    }

    private func stubbedSession() -> URLSession {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [RecordingURLProtocol.self]
        return URLSession(configuration: cfg)
    }

    /// The leak, directly: an outbox holding entries for two projects, drained
    /// by a submitter configured for only one of them. Each report must reach
    /// the project that captured it.
    func test_drain_submits_each_entry_with_its_own_key_and_endpoint() async throws {
        RecordingURLProtocol.reset()
        let box = makeOutbox()
        try box.enqueue(entry(key: "key-A", endpoint: "https://a.example.com", idem: "idem-A"))
        try box.enqueue(entry(key: "key-B", endpoint: "https://b.example.com", idem: "idem-B"))

        let submitter = ReportSubmitter(
            config: EverframeConfig(appId: "key-B"),
            outbox: box,
            session: stubbedSession())
        await submitter.drainOutbox(identityHolder: IdentityTokenHolder(), currentReplayConfig: { .off }, epochAtInitiation: 0, currentEpoch: { 0 })

        let seen = Dictionary(
            RecordingURLProtocol.recorded.map { ($0.authorization ?? "", $0.host) },
            uniquingKeysWith: { first, _ in first })
        XCTAssertEqual(seen["Bearer key-A"], "a.example.com",
                       "project A's queued report must go to project A")
        XCTAssertEqual(seen["Bearer key-B"], "b.example.com")
        XCTAssertEqual(RecordingURLProtocol.recorded.count, 2)
    }

    /// The re-stamp trap. drainOutbox drops the entry from disk, calls
    /// submit(), and submit() re-enqueues on transient failure. If that
    /// re-enqueue rebuilds from `self.config`, a foreign entry silently
    /// becomes the active project's on the next drain.
    func test_transient_failure_during_drain_preserves_the_original_key() async throws {
        RecordingURLProtocol.reset()
        RecordingURLProtocol.responseStatus = 503   // retryable per RetryPolicy

        let box = makeOutbox()
        try box.enqueue(entry(key: "key-A", endpoint: "https://a.example.com", idem: "idem-A"))

        let submitter = ReportSubmitter(
            config: EverframeConfig(appId: "key-B"),
            outbox: box,
            session: stubbedSession())
        await submitter.drainOutbox(identityHolder: IdentityTokenHolder(), currentReplayConfig: { .off }, epochAtInitiation: 0, currentEpoch: { 0 })

        let survivors = try box.hydrate()
        XCTAssertEqual(survivors.count, 1, "a transient failure must leave the entry queued")
        XCTAssertEqual(survivors[0].sdkKey, "key-A",
                       "re-enqueue must not re-stamp the entry with the active config's key")
        XCTAssertEqual(survivors[0].endpoint, "https://a.example.com")
    }

    /// The default outbox path must never be the machine-global user caches
    /// directory during tests: it is shared by every `swift test` run and
    /// every sample app on the machine, which is how leftover envelopes came
    /// to drain to production ingest.
    func test_default_outbox_path_is_isolated_under_xctest() throws {
        let caches = FileManager.default
            .urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .standardizedFileURL.path

        let box = JSONLOutbox()
        let path = box.resolvedFileURL.standardizedFileURL.path

        XCTAssertFalse(
            path.hasPrefix(caches),
            "under XCTest the default outbox must not live in the shared user caches directory")
        XCTAssertTrue(
            path.contains("dev.everframe-test-"),
            "expected a per-launch test directory, got \(path)")
    }

    /// The per-launch directory is keyed on a UUID rather than the process id,
    /// because pids are recycled and nothing cleans these directories up — a
    /// later run inheriting a previous run's entries would drain them to
    /// whatever endpoint they were stamped with, which for an unconfigured test
    /// run is production. The UUID must NOT be regenerated per call, though:
    /// `CrashSidecar.hydrateInto` folds sidecar entries into a separately
    /// constructed `JSONLOutbox()`, so two default instances in one process
    /// have to name the same file.
    func test_default_outbox_path_is_stable_within_one_process() throws {
        let first = JSONLOutbox().resolvedFileURL.standardizedFileURL.path
        let second = JSONLOutbox().resolvedFileURL.standardizedFileURL.path

        XCTAssertEqual(
            first, second,
            "two default outboxes in one process must resolve to the same file, "
                + "or the crash sidecar hydrates into an outbox nothing drains")
    }
}
