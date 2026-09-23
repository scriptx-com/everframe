// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 8b — the wiring, not just the gate. IdentitySubjectGateTests already
// proves `resolveIdentityHeader` makes the right call in isolation; this
// suite proves `ReportSubmitter.drainOutbox(identityHolder:currentReplayConfig:)`
// actually THREADS that decision onto the wire for a real (stubbed) HTTP
// request — the exact thing that was missing when `drainOutbox` still
// defaulted to a fresh, empty holder and `.off`.
//
// `Transport/ReportSubmitter.swift` and `Outbox/JSONLOutbox.swift` are not
// UIKit-gated, so this runs on the macOS host build like
// `OutboxKeyBindingTests` — no `Everframe.shared` singleton, no stderr
// intercept, no UIKit.
import XCTest
@testable import EverframeKit

final class DrainIdentityHeaderTests: XCTestCase {

    private var tempDir: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("everframe-drain-identity-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        RecordingURLProtocol.reset()
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tempDir)
        try super.tearDownWithError()
    }

    private func makeOutbox() -> JSONLOutbox {
        JSONLOutbox(testFileURL: tempDir.appendingPathComponent("outbox.jsonl"))
    }

    private func stubbedSession() -> URLSession {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [RecordingURLProtocol.self]
        return URLSession(configuration: cfg)
    }

    /// `endpoint` defaults to the LIVE `IngestEndpoint.url` (independent
    /// review, round 4, Serious 1) — every existing case in this file wants
    /// an entry whose project (sdkKey AND endpoint) still matches the live
    /// one unless it's deliberately testing a mismatch, the same way
    /// `sdkKey` already defaults to `"key-A"` to match `makeSubmitter()`'s
    /// config below.
    private func entry(
        reportId: UUID = UUID(),
        identitySubject: String?,
        endpoint: String = IngestEndpoint.url.absoluteString
    ) -> OutboxEntry {
        OutboxEntry(
            reportId: reportId,
            createdAt: Date(),
            envelopeBytes: Data("{}".utf8),
            idempotencyKey: "idem-\(reportId.uuidString)",
            attachmentRefs: [],
            sdkKey: "key-A",
            endpoint: endpoint,
            identitySubject: identitySubject
        )
    }

    private func jwt(sub: String, exp: Date) -> String {
        let header = #"{"alg":"HS256","typ":"JWT"}"#.data(using: .utf8)!
        let payload = try! JSONSerialization.data(withJSONObject: ["sub": sub, "exp": Int(exp.timeIntervalSince1970)])
        func b64(_ d: Data) -> String {
            d.base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        return "\(b64(header)).\(b64(payload)).sig"
    }

    /// Fixture configs built through a real `ReplayConfigProvider.refresh()`
    /// against a stub fetcher, exactly like `IdentitySubjectGateTests` — see
    /// that file's header for why `ReplayConfig` cannot be constructed via
    /// `JSONDecoder` directly.
    private func decode(_ json: String) async -> ReplayConfig {
        struct SingleResponseFetcher: URLSessionFetching {
            let body: Data
            func data(for request: URLRequest) async throws -> (Data, URLResponse) {
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!
                return (body, response)
            }
        }
        let provider = ReplayConfigProvider(
            configUrl: URL(string: "https://everframe.dev/api/config")!,
            apiKey: "evr_test_key",
            fetcher: SingleResponseFetcher(body: Data(json.utf8))
        )
        await provider.refresh()
        return await provider.current
    }

    private func enabledConfig() async -> ReplayConfig {
        await decode(#"{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1,"identity":{"enabled":true}}"#)
    }

    func test_drain_attaches_the_header_when_the_entrys_subject_matches_the_live_holder() async throws {
        let now = Date()
        let holder = IdentityTokenHolder()
        let token = jwt(sub: "alice", exp: now.addingTimeInterval(300))
        holder.set(.token(token))

        let box = makeOutbox()
        try box.enqueue(entry(identitySubject: "alice"))

        let submitter = ReportSubmitter(
            config: EverframeConfig(appId: "key-A"), outbox: box, session: stubbedSession())
        await submitter.drainOutbox(identityHolder: holder, currentReplayConfig: { await enabledConfig() }, epochAtInitiation: 0, currentEpoch: { 0 })

        XCTAssertEqual(RecordingURLProtocol.recorded.count, 1)
        XCTAssertEqual(
            RecordingURLProtocol.recorded[0].identityToken, token,
            "an entry captured under alice, drained while alice's token is live, must carry it")
    }

    func test_drain_withholds_the_header_when_the_entrys_subject_differs_from_the_live_holder() async throws {
        let now = Date()
        let holder = IdentityTokenHolder()
        // Bob signed in after alice's report was captured and queued.
        holder.set(.token(jwt(sub: "bob", exp: now.addingTimeInterval(300))))

        let box = makeOutbox()
        try box.enqueue(entry(identitySubject: "alice"))

        let submitter = ReportSubmitter(
            config: EverframeConfig(appId: "key-A"), outbox: box, session: stubbedSession())
        await submitter.drainOutbox(identityHolder: holder, currentReplayConfig: { await enabledConfig() }, epochAtInitiation: 0, currentEpoch: { 0 })

        XCTAssertEqual(RecordingURLProtocol.recorded.count, 1)
        XCTAssertNil(
            RecordingURLProtocol.recorded[0].identityToken,
            "alice's queued report must never be drained carrying bob's credential")
    }

    func test_drain_withholds_the_header_for_an_entry_captured_anonymously() async throws {
        let now = Date()
        let holder = IdentityTokenHolder()
        holder.set(.token(jwt(sub: "alice", exp: now.addingTimeInterval(300))))

        let box = makeOutbox()
        try box.enqueue(entry(identitySubject: nil))

        let submitter = ReportSubmitter(
            config: EverframeConfig(appId: "key-A"), outbox: box, session: stubbedSession())
        await submitter.drainOutbox(identityHolder: holder, currentReplayConfig: { await enabledConfig() }, epochAtInitiation: 0, currentEpoch: { 0 })

        XCTAssertEqual(RecordingURLProtocol.recorded.count, 1)
        XCTAssertNil(
            RecordingURLProtocol.recorded[0].identityToken,
            "a report captured with nobody signed in must never be retroactively attributed")
    }

    // MARK: - Final whole-branch review, Important 2: project binding
    //
    // The header used to be resolved from the LIVE holder/config regardless
    // of which project the queued entry actually belongs to — unlike
    // `sdkKey`/`endpoint` on the very next line, which always come from the
    // entry itself. `start(projectA)` queues a report (sdkKey="key-A") ->
    // `start(projectB)` -> `setIdentityToken` with project B's live token,
    // whose `sub` happens to equal the entry's captured subject (plausible:
    // `sub` is the host's own user id, unchanged across a tenant switch) ->
    // drain fires -> project B's live bearer credential would ship to
    // project A's endpoint. Mutation-verified: reverting the `e.sdkKey ==
    // config.appId` guard in `drainOutbox` makes this test fail.

    func test_drain_withholds_the_header_when_the_entry_belongs_to_a_different_project_even_though_the_subject_matches() async throws {
        let now = Date()
        let holder = IdentityTokenHolder()
        // The live holder's token belongs to the SAME person ("alice") the
        // entry was captured under — the subject check alone would let this
        // through. Only the project (sdkKey) differs.
        holder.set(.token(jwt(sub: "alice", exp: now.addingTimeInterval(300))))

        let box = makeOutbox()
        // Entry's own sdkKey is "key-A" (the `entry(...)` helper's default);
        // the live submitter below is configured for a DIFFERENT project.
        try box.enqueue(entry(identitySubject: "alice"))

        let submitter = ReportSubmitter(
            config: EverframeConfig(appId: "key-B"), outbox: box, session: stubbedSession())
        await submitter.drainOutbox(identityHolder: holder, currentReplayConfig: { await enabledConfig() }, epochAtInitiation: 0, currentEpoch: { 0 })

        XCTAssertEqual(RecordingURLProtocol.recorded.count, 1)
        XCTAssertNil(
            RecordingURLProtocol.recorded[0].identityToken,
            "a live token must never drain onto a queued entry captured under a DIFFERENT project, even when the subject matches")
    }

    func test_drain_attaches_the_header_when_the_entrys_project_still_matches_the_live_config() async throws {
        // Sanity/non-regression companion to the case above: when the
        // entry's own project DOES still match the live config (the
        // ordinary, same-session case every other test in this file already
        // exercises), the header must still attach — this fix must not
        // over-withhold.
        let now = Date()
        let holder = IdentityTokenHolder()
        let token = jwt(sub: "alice", exp: now.addingTimeInterval(300))
        holder.set(.token(token))

        let box = makeOutbox()
        try box.enqueue(entry(identitySubject: "alice"))

        let submitter = ReportSubmitter(
            config: EverframeConfig(appId: "key-A"), outbox: box, session: stubbedSession())
        await submitter.drainOutbox(identityHolder: holder, currentReplayConfig: { await enabledConfig() }, epochAtInitiation: 0, currentEpoch: { 0 })

        XCTAssertEqual(RecordingURLProtocol.recorded.count, 1)
        XCTAssertEqual(
            RecordingURLProtocol.recorded[0].identityToken, token,
            "the header must still attach for the ordinary same-project case")
    }

    // MARK: - Independent review, round 4, Serious 1: endpoint binding
    //
    // `sdkKey`/`endpoint` on the upload itself already come from the ENTRY,
    // never the live config (`e.sdkKey`/`e.endpoint`, two lines below the
    // header decision) — PR #63 stored the endpoint alongside the key
    // specifically because "the endpoint is independently redirectable, so
    // a key alone can still reach the wrong host" (e.g. a dev-override
    // `EVERFRAME_DEV_INGEST_URL` changing between queue and drain). The
    // identity header used to be exempt from that rule: it checked
    // `e.sdkKey == config.appId` alone, so a live token could still attach
    // even when the entry's OWN endpoint no longer matched the live one.

    /// THE test that must exist: an entry whose sdkKey still matches but
    /// whose endpoint does NOT must withhold the header — the same subject
    /// that would otherwise attach cleanly (see the sanity companion above)
    /// must not attach once the endpoint alone has drifted. Mutation-
    /// verified: reverting the `e.endpoint == IngestEndpoint.url
    /// .absoluteString` half of the guard makes this fail.
    func test_drain_withholds_the_header_when_the_entrys_endpoint_no_longer_matches_the_live_one() async throws {
        let now = Date()
        let holder = IdentityTokenHolder()
        let token = jwt(sub: "alice", exp: now.addingTimeInterval(300))
        holder.set(.token(token))

        let box = makeOutbox()
        // sdkKey ("key-A") matches makeSubmitter()'s config below; only the
        // endpoint differs from the live IngestEndpoint.url.
        try box.enqueue(entry(identitySubject: "alice", endpoint: "https://a-different-host.example.com"))

        let submitter = ReportSubmitter(
            config: EverframeConfig(appId: "key-A"), outbox: box, session: stubbedSession())
        await submitter.drainOutbox(identityHolder: holder, currentReplayConfig: { await enabledConfig() }, epochAtInitiation: 0, currentEpoch: { 0 })

        XCTAssertEqual(RecordingURLProtocol.recorded.count, 1)
        XCTAssertNil(
            RecordingURLProtocol.recorded[0].identityToken,
            "a live token must never drain onto a queued entry whose endpoint no longer matches the live one, even when sdkKey and subject both match")
    }

    // MARK: - Independent review, Serious 2: the sdkKey pre-check alone is a TOCTOU window
    //
    // `resolveIdentityHeader` is `async`, and ITS OWN suspension point
    // (`holder.get(now:)`'s provider re-ask) gives a `start(projectB)` +
    // `setIdentityToken(B)` landing DURING resolution — after the `e.sdkKey
    // == config.appId` pre-check already passed — a window to land: a live
    // token resolved AFTER the project switch could still attach to an
    // entry whose `sdkKey`/`endpoint` are frozen at project A's values,
    // disclosing project B's bearer credential to project A's endpoint.

    /// THE test that must exist: an epoch change happening DURING resolution
    /// (simulated deterministically — the provider closure itself bumps the
    /// captured `epoch` var, standing in for `start(projectB)` landing while
    /// `resolveIdentityHeader`'s own await is in flight) must withhold the
    /// header even though the pre-check passed and the subject matches.
    /// Mutation-verified: reverting the post-resolution `currentEpoch() ==
    /// epochAtDrainStart` re-check makes this fail.
    func test_drain_withholds_the_header_when_the_epoch_changes_during_resolution() async throws {
        let now = Date()
        let holder = IdentityTokenHolder()
        let token = jwt(sub: "alice", exp: now.addingTimeInterval(300))
        var epoch = 0
        // Stands in for start(projectB) landing WHILE this entry's
        // resolveIdentityHeader(...) call is suspended awaiting the
        // provider — the epoch bump happens strictly BETWEEN
        // drainOutbox's pre-resolution snapshot and its post-resolution
        // re-check, deterministically, with no real threading needed.
        holder.set(.provider {
            epoch += 1
            return token
        })

        let box = makeOutbox()
        try box.enqueue(entry(identitySubject: "alice"))  // sdkKey defaults to "key-A"

        let submitter = ReportSubmitter(
            config: EverframeConfig(appId: "key-A"), outbox: box, session: stubbedSession())
        await submitter.drainOutbox(
            identityHolder: holder, currentReplayConfig: { await enabledConfig() },
            epochAtInitiation: 0, currentEpoch: { epoch })

        XCTAssertEqual(RecordingURLProtocol.recorded.count, 1)
        XCTAssertNil(
            RecordingURLProtocol.recorded[0].identityToken,
            "an epoch change during resolution must withhold the header even though the pre-check passed and the subject matches"
        )
    }

    /// Sanity/non-regression companion: when the epoch does NOT change
    /// during resolution (the ordinary case), the header must still attach.
    func test_drain_attaches_the_header_when_the_epoch_is_unchanged_throughout_resolution() async throws {
        let now = Date()
        let holder = IdentityTokenHolder()
        let token = jwt(sub: "alice", exp: now.addingTimeInterval(300))
        holder.set(.token(token))

        let box = makeOutbox()
        try box.enqueue(entry(identitySubject: "alice"))

        let submitter = ReportSubmitter(
            config: EverframeConfig(appId: "key-A"), outbox: box, session: stubbedSession())
        await submitter.drainOutbox(
            identityHolder: holder, currentReplayConfig: { await enabledConfig() },
            epochAtInitiation: 0, currentEpoch: { 0 })

        XCTAssertEqual(RecordingURLProtocol.recorded.count, 1)
        XCTAssertEqual(
            RecordingURLProtocol.recorded[0].identityToken, token,
            "the header must still attach when nothing raced the resolution"
        )
    }

    // MARK: - Independent review, round 11, P1(c): identity enablement re-read per entry
    //
    // `drainOutbox` used to receive one immutable `ReplayConfig` for the
    // WHOLE drain, captured once by the caller before the loop even started.
    // A drain can run for minutes across many entries — each attempt can
    // spend a full network timeout before falling back to retryable-queue —
    // so if remote config disables identity partway through, later entries
    // still invoked the provider and attached tokens, because nothing in
    // `drainOutbox` itself ever re-read enablement. Fixed by taking a
    // `currentReplayConfig` CLOSURE instead of a captured value, called
    // fresh both before AND after `resolveIdentityHeader` for every entry.

    /// The mid-resolution race, mirroring the epoch case above exactly:
    /// identity flips disabled WHILE `resolveIdentityHeader`'s own
    /// suspension (the holder's provider re-ask) is in flight — simulated
    /// deterministically via the provider closure itself flipping a
    /// captured `enabled` var, standing in for a remote config refresh
    /// landing mid-resolution. The header must be withheld even though the
    /// PRE-resolution read said enabled and the subject matches.
    /// Mutation-verified: reverting the post-resolution
    /// `isIdentityEnabled(await currentReplayConfig())` re-check makes this
    /// fail.
    func test_drain_withholds_the_header_when_identity_becomes_disabled_during_resolution() async throws {
        let now = Date()
        let holder = IdentityTokenHolder()
        let token = jwt(sub: "alice", exp: now.addingTimeInterval(300))
        var enabled = true
        holder.set(.provider {
            enabled = false
            return token
        })

        let box = makeOutbox()
        try box.enqueue(entry(identitySubject: "alice"))

        let submitter = ReportSubmitter(
            config: EverframeConfig(appId: "key-A"), outbox: box, session: stubbedSession())
        await submitter.drainOutbox(
            identityHolder: holder,
            currentReplayConfig: { enabled ? await enabledConfig() : ReplayConfig.off },
            epochAtInitiation: 0, currentEpoch: { 0 })

        XCTAssertEqual(RecordingURLProtocol.recorded.count, 1)
        XCTAssertNil(
            RecordingURLProtocol.recorded[0].identityToken,
            "identity becoming disabled during resolution must withhold the header even though the pre-check passed and the subject matches"
        )
    }

    /// A SEPARATE freshness case, distinct from the mid-resolution race
    /// above: identity is enabled while the FIRST entry in a drain pass is
    /// processed, then disabled before the SECOND entry's turn comes — a
    /// single `ReplayConfig` value captured once for the WHOLE drain (the
    /// pre-round-11 shape) would still see it enabled for BOTH entries,
    /// since nothing about a single entry's own resolution ever raced it.
    /// This is what "read per entry," not merely "read before/after one
    /// entry's own resolution," actually buys. Mutation-verified: reverting
    /// `currentReplayConfig` back to a captured value (calling it once,
    /// outside the loop) makes the SECOND entry's assertion fail.
    func test_drain_reads_identity_enablement_fresh_per_entry_not_once_for_the_whole_drain() async throws {
        let now = Date()
        let holder = IdentityTokenHolder()
        let token = jwt(sub: "alice", exp: now.addingTimeInterval(300))
        holder.set(.token(token))

        var callCount = 0
        let box = makeOutbox()
        try box.enqueue(entry(identitySubject: "alice"))
        try box.enqueue(entry(identitySubject: "alice"))

        let submitter = ReportSubmitter(
            config: EverframeConfig(appId: "key-A"), outbox: box, session: stubbedSession())
        await submitter.drainOutbox(
            identityHolder: holder,
            currentReplayConfig: {
                callCount += 1
                // Enabled for the FIRST entry's two reads (before/after its
                // own resolution), disabled from the SECOND entry's reads
                // onward — standing in for a remote config refresh landing
                // BETWEEN two entries in a long drain, not during either
                // one's own resolution.
                return callCount <= 2 ? await enabledConfig() : ReplayConfig.off
            },
            epochAtInitiation: 0, currentEpoch: { 0 })

        XCTAssertEqual(RecordingURLProtocol.recorded.count, 2)
        XCTAssertEqual(
            RecordingURLProtocol.recorded[0].identityToken, token,
            "the FIRST entry, drained while identity was still enabled, must carry the header")
        XCTAssertNil(
            RecordingURLProtocol.recorded[1].identityToken,
            "the SECOND entry, drained after identity flipped disabled, must withhold the header — a " +
                "single config value captured once for the whole drain would incorrectly still attach it"
        )
    }
}
