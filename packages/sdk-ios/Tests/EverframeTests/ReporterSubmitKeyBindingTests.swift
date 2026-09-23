// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Follow-ups register item 9 — the reporter and companion submit paths must
// route by the config captured at the Send tap, never by whatever `start()`
// named while the report was being assembled.
//
// The window is SECONDS, not the microseconds of a crash unwind: between the
// Send tap and the upload sit per-shot annotation baking, image encoding,
// SHA-256, replay gzip and multipart construction. A `start(projectB)` landing
// in it used to upload project A's screenshot, UI tree, breadcrumb chain and
// network rows under project B's Everframe SDK key.
//
// Anonymity was never the mitigation it looked like. The epoch guard
// (`EFCapturedUser.resolve()`) correctly degraded the USER to anonymous on a
// session switch — and the payload shipped to B regardless. A screenshot of
// project A's app sitting in project B's inbox is the disclosure, with or
// without a name attached.
//
// WHY THE SUBMITTER IS INJECTED. `submit(_:)` builds its own `ReportSubmitter`
// and no test may reach the real ingest endpoint (register item 7 was exactly
// that failure). `ReporterSubmission.__submitterFactoryForTesting` is `nil` in
// production; here it both keeps the upload off the network and witnesses the
// thing under test — the config the submitter was CONSTRUCTED with, which is
// what decides the destination project.
//
// NO HOOK IS NEEDED TO REPRODUCE THE RACE. The captured session is a
// PARAMETER to `submit`, so `captureSessionSnapshot()` → `start(B)` →
// `submit(snapshot)` is the interleaving, deterministically, with no
// test-only entry point into the window.
//
// UIKIT-ONLY (false pass on macOS): `ReporterSubmission` lives inside
// `#if canImport(UIKit)`, so the type does not exist when `swift test
// --package-path packages/sdk-ios` runs on a plain macOS host — that run
// reports "0 tests, 0 failures", green and proving nothing. Real evidence
// comes from the iOS Simulator, which is why this suite is on
// `swift.yml`'s `lifecycle-tests-iOS` `-only-testing:` allowlist:
//
//     cd packages/sdk-ios && xcodebuild test -scheme Everframe-Package \
//       -destination "id=$(xcrun simctl list devices available -j | \
//         python3 -c 'import json,sys; ds=json.load(sys.stdin)["devices"]; print(next(d["udid"] for rt in sorted(ds) if "iOS" in rt for d in ds[rt] if d["name"].startswith("iPhone")))')" \
//       -only-testing:EverframeTests/ReporterSubmitKeyBindingTests
//
// (`cd` first and no `-workspace`: SwiftPM discovers `Package.swift` from the
// working directory, and `.swiftpm/xcode/package.xcworkspace` is not checked
// in — the same form `swift.yml`'s lifecycle job uses.)
#if canImport(UIKit)
import XCTest
import UIKit
import EverframeProtocol
@testable import EverframeKit

final class ReporterSubmitKeyBindingTests: XCTestCase {
    private let appA = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"
    private let appB = "txx_live_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

    /// `RecordingURLProtocol` is process-global state shared with
    /// `OutboxKeyBindingTests`; reset it on both edges so neither suite can
    /// read the other's recorded requests.
    override func setUp() {
        super.setUp()
        RecordingURLProtocol.reset()
    }

    /// `@MainActor` because `ReporterSubmission` is a `@MainActor` enum, so
    /// its static seam can only be touched from the main actor.
    @MainActor override func tearDown() {
        ReporterSubmission.__resetSubmitterFactoryForTesting()
        RecordingURLProtocol.reset()
        Everframe.shared.kill()
        super.tearDown()
    }

    /// `capture: CaptureConfig(logs: false)` keeps `start()` from installing
    /// the process-global stderr intercept — the same isolation
    /// `KillSwitchTests` and `EnvelopeUserTests` apply, for the same reason.
    private func config(_ appId: String) -> EverframeConfig {
        EverframeConfig(appId: appId, capture: CaptureConfig(logs: false))
    }

    /// Records the config its submitter was built with, and returns a
    /// submitter that cannot reach the network at all.
    ///
    /// `protocolClasses = [RecordingURLProtocol.self]` is LOad-BEARING, not
    /// belt-and-braces. An earlier draft passed a plain
    /// `URLSession(configuration: .ephemeral)` on the assumption that a test
    /// submitter "cannot reach anything"; the first red run came back
    /// `serverError(status: 401)` — it had POSTed a real report to the real
    /// ingest host and been rejected on the key. That is register item 7
    /// (a suite POSTing to production) reappearing, and the endpoint is not
    /// something this seam can override: `ReporterSubmission.submit` calls
    /// `submitter.submit(...)` without an `endpoint:` argument, so
    /// `ReportSubmitter` falls back to `IngestEndpoint.url`. Stubbing the
    /// protocol is what actually keeps the packet on this machine.
    ///
    /// It also buys the stronger assertion: `RecordingURLProtocol` captures
    /// the `Authorization` header, so the tests can check the key that went
    /// ON THE WIRE rather than only the config the submitter was built from.
    private final class FactorySpy: @unchecked Sendable {
        private(set) var configAppIds: [String] = []
        var ran: Bool { !configAppIds.isEmpty }

        func make(_ cfg: EverframeConfig) -> ReportSubmitter {
            configAppIds.append(cfg.appId)
            let sessionConfig = URLSessionConfiguration.ephemeral
            sessionConfig.protocolClasses = [RecordingURLProtocol.self]
            return ReportSubmitter(
                config: cfg,
                outbox: JSONLOutbox(
                    fileURL: FileManager.default.temporaryDirectory
                        .appendingPathComponent("everframe-item9-\(UUID().uuidString).jsonl")),
                session: URLSession(configuration: sessionConfig))
        }
    }

    /// A 1×1 image is enough — nothing here asserts on pixels, and every
    /// encode stage still runs for real, so the test exercises the actual
    /// assembly rather than a shortcut through it.
    @MainActor private func inputs(
        session: EFCapturedSession, includeNetwork: Bool = false
    ) -> ReporterSubmission.Inputs {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1))
        let image = renderer.image { ctx in
            UIColor.black.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 1, height: 1))
        }
        let png = image.pngData()!
        return ReporterSubmission.Inputs(
            captureResult: ScreenshotCapture.Result(
                image: image, widthPoints: 1, heightPoints: 1, scale: 1, pngData: png),
            shots: [ReporterSubmission.Inputs.Shot(image: image, annotated: false)],
            title: "t",
            description: "d",
            includeLogs: false,
            includeNetwork: includeNetwork,
            includeMetadata: false,
            extraOverrides: [:],
            hostExtra: nil,
            capturedSession: session
        )
    }

    /// THE DEFECT. The session is snapshotted as project A (the Send tap),
    /// project B starts while the report is being assembled, and the report
    /// must still go out under A's key.
    @MainActor func testAReportIsSubmittedUnderTheProjectItWasCapturedIn() async throws {
        try Everframe.shared.start(config: config(appA))
        let captured = Everframe.shared.captureSessionSnapshot()

        try Everframe.shared.start(config: config(appB))

        let spy = FactorySpy()
        ReporterSubmission.__submitterFactoryForTesting = { spy.make($0) }

        _ = try? await ReporterSubmission.submit(inputs(session: captured))

        // Non-vacuity: B really is the live session, so a fix that simply read
        // the live config again would be caught here rather than passing.
        XCTAssertEqual(
            Everframe.shared.currentConfig?.appId, appB,
            "precondition: project B must be the live session — otherwise this test asserts nothing")
        XCTAssertEqual(
            spy.configAppIds, [appA],
            "the report must upload under the key of the project it was captured in, not whoever start() named while it was being assembled")
        // The claim that actually matters to a customer: the key on the wire.
        XCTAssertEqual(
            RecordingURLProtocol.recorded.map(\.authorization), ["Bearer \(appA)"],
            "the ingest POST must carry project A's key — this is the byte that decides whose inbox the screenshot lands in")
    }

    /// Control: nothing switches, nothing changes. A "fix" that pinned some
    /// fixed key would pass the case above and fail here.
    @MainActor func testAReportKeepsItsKeyWhenNothingSwitchesDuringAssembly() async throws {
        try Everframe.shared.start(config: config(appA))
        let captured = Everframe.shared.captureSessionSnapshot()

        let spy = FactorySpy()
        ReporterSubmission.__submitterFactoryForTesting = { spy.make($0) }

        _ = try? await ReporterSubmission.submit(inputs(session: captured))

        XCTAssertEqual(spy.configAppIds, [appA])
        XCTAssertEqual(RecordingURLProtocol.recorded.map(\.authorization), ["Bearer \(appA)"])
    }

    /// FOLLOW-UPS ITEM 9, SECOND ROUND (external review 2026-08-13, codex).
    ///
    /// Routing by the captured config closed the direction that mattered and
    /// opened a narrower one in reverse: `submit` pins project A's key and then
    /// reads `NetworkRingBuffer` LIVE, several statements later. Project B's
    /// rows — captured after the switch, into a ring `start(B)` had just
    /// cleared — would have shipped under A's key.
    ///
    /// The row is appended AFTER the switch, so it is unambiguously B's.
    ///
    /// Reads the envelope back out of the outbox rather than off the wire:
    /// `RecordingURLProtocol` records only host and Authorization, so the body
    /// has to be recovered from the entry `ReportSubmitter` enqueues. A 503
    /// makes `RetryPolicy.classify` return `.retryable`, which is what puts it
    /// there — still no packet leaving the machine.
    @MainActor func testAReportDoesNotCarryNetworkRowsCapturedByTheNextProject() async throws {
        try Everframe.shared.start(config: config(appA))
        let captured = Everframe.shared.captureSessionSnapshot()

        try Everframe.shared.start(config: config(appB))
        // Project B's traffic, captured entirely under B's session.
        NetworkRingBuffer.shared.append(
            NetworkLogEntry(
                timestamp: Date(), method: "GET",
                url: "https://project-b-only.example.invalid/secret",
                status: 200, durationMs: 12, requestHeaders: [:], responseHeaders: [:]))

        RecordingURLProtocol.responseStatus = 503
        let outboxURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("everframe-item9-reverse-\(UUID().uuidString).jsonl")
        ReporterSubmission.__submitterFactoryForTesting = { cfg in
            let sessionConfig = URLSessionConfiguration.ephemeral
            sessionConfig.protocolClasses = [RecordingURLProtocol.self]
            return ReportSubmitter(
                config: cfg,
                outbox: JSONLOutbox(testFileURL: outboxURL),
                session: URLSession(configuration: sessionConfig))
        }

        // includeNetwork: true — the section must be REQUESTED for its absence
        // to mean anything.
        _ = try? await ReporterSubmission.submit(inputs(session: captured, includeNetwork: true))

        let entry = try XCTUnwrap(
            try JSONLOutbox(testFileURL: outboxURL).hydrate().first,
            "the 503 should have enqueued the envelope — otherwise there is nothing to inspect")
        XCTAssertEqual(entry.sdkKey, appA, "precondition: still routed to project A")
        XCTAssertFalse(
            String(decoding: entry.envelopeBytes, as: UTF8.self)
                .contains("project-b-only.example.invalid"),
            "project B's network row must not ride project A's report")
    }

    /// FOLLOW-UPS ITEM 9, THIRD ROUND (external review 2026-08-13, codex).
    ///
    /// The frozen snapshots are process-global and unkeyed, so gating only the
    /// LIVE reads was not enough. Once `start(B)` clears the slot, a report
    /// opened UNDER B can freeze its own chain into it before report A's
    /// in-flight submit reaches `takeFrozen()` — and A would then upload B's
    /// breadcrumbs under A's key.
    ///
    /// The freeze here happens strictly after the switch, so the chain is
    /// unambiguously B's.
    ///
    /// Also asserts the thing that makes this fix non-obvious: A must not
    /// CONSUME the slot either. `takeFrozen()` and `discardAndResume()` both
    /// clear it, so either one would steal the snapshot from the B report that
    /// legitimately owns it — trading a cross-tenant disclosure for silent
    /// data loss in the other project.
    @MainActor func testAReportNeitherShipsNorStealsTheNextProjectsFrozenBreadcrumbs() async throws {
        try Everframe.shared.start(config: config(appA))
        let captured = Everframe.shared.captureSessionSnapshot()

        try Everframe.shared.start(config: config(appB))
        // A report opening under project B: its own crumb, its own freeze.
        Everframe.shared.addBreadcrumb(message: "PROJECT-B-ONLY-CRUMB")
        BreadcrumbRingBuffer.shared.freeze()

        RecordingURLProtocol.responseStatus = 503
        let outboxURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("everframe-item9-frozen-\(UUID().uuidString).jsonl")
        ReporterSubmission.__submitterFactoryForTesting = { cfg in
            let sessionConfig = URLSessionConfiguration.ephemeral
            sessionConfig.protocolClasses = [RecordingURLProtocol.self]
            return ReportSubmitter(
                config: cfg,
                outbox: JSONLOutbox(testFileURL: outboxURL),
                session: URLSession(configuration: sessionConfig))
        }

        _ = try? await ReporterSubmission.submit(inputs(session: captured))

        let entry = try XCTUnwrap(try JSONLOutbox(testFileURL: outboxURL).hydrate().first)
        XCTAssertEqual(entry.sdkKey, appA, "precondition: still routed to project A")
        XCTAssertFalse(
            String(decoding: entry.envelopeBytes, as: UTF8.self).contains("PROJECT-B-ONLY-CRUMB"),
            "project B's frozen breadcrumb chain must not ride project A's report")
        XCTAssertEqual(
            BreadcrumbRingBuffer.shared.takeFrozen()?.map(\.message), ["PROJECT-B-ONLY-CRUMB"],
            """
            project A's submit must LEAVE project B's frozen chain in place — \
            consuming or discarding it would silently strip the breadcrumbs \
            from B's own report
            """)
    }

    /// A `kill()` during assembly revokes the capture: nothing is submitted.
    ///
    /// Checked at the SUBMIT boundary, deliberately NOT immediately before the
    /// outbox write the way the crash path does it. On the crash path the
    /// outbox write IS the delivery — the process is dying. Here
    /// `ReportSubmitter.submit` uploads live FIRST and enqueues only when
    /// `RetryPolicy.classify` calls the failure retryable, so a check before
    /// the write would run only on the FAILURE path: a revoked report that
    /// uploaded successfully would never be checked at all.
    @MainActor func testAKillDuringAssemblyStopsTheSubmitEntirely() async throws {
        try Everframe.shared.start(config: config(appA))
        let captured = Everframe.shared.captureSessionSnapshot()

        let spy = FactorySpy()
        ReporterSubmission.__submitterFactoryForTesting = { spy.make($0) }

        Everframe.shared.kill()
        // start() re-opens `captureGate`, so a boolean gate check would let
        // this through — the case only a monotonic counter catches.
        try Everframe.shared.start(config: config(appB))

        do {
            _ = try await ReporterSubmission.submit(inputs(session: captured))
            XCTFail("a revoked capture must not be submitted")
        } catch ReporterSubmissionError.revoked {
            // expected
        }
        XCTAssertTrue(Everframe.shared.captureGate, "precondition: start() re-opened the gate")
        XCTAssertFalse(spy.ran, "no submitter may even be constructed for a revoked capture")
        XCTAssertTrue(
            RecordingURLProtocol.recorded.isEmpty,
            "a revoked capture must put nothing on the wire at all")
    }
}
#endif
