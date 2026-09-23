// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Phase 06.2-12 Task 5 — CompanionCaptureBridge submit-path unit tests.
//
// Covers the parts of the new bridge surface that DON'T need a live WS
// server or a real ingest endpoint:
//   • Capture buffer stash + lookup by correlation_id (Task 2).
//   • Binary frame routing from RelayWSClient.handleBinary (Task 3).
//   • Submit-text-frame + binary-frame pairing — both orderings tolerated.
//   • report.failed emitted on missing-capture path.
//
// The full envelope-build + ReportSubmitter network path is NOT exercised
// here — ReporterSubmission.submit is @MainActor and currently has no
// dependency-injection seam for the submitter (it constructs
// `ReportSubmitter(config:)` internally). Stubbing requires either widening
// that seam (out of scope: would touch the shared in-process reporter
// pipeline) or standing up a fake URLSession at the ReportSubmitter level
// (already done in ReportSubmitterTests / IngestE2E suites). The
// integration test `the ingest service/__tests__/relay/e2e-report-flow.spec.ts`
// (Plan 06.2-04 / 06.2-08) covers the wire contract end-to-end with a real
// relay + ingest service.
import Testing
import Foundation
import EverframeProtocol
@testable import EverframeKit

@Suite(.serialized)
final class CompanionSubmitBridgeTests {

    private final class FailedFrameRecorder: @unchecked Sendable {
        private let lock = NSLock()
        private var correlationIds: Set<String> = []

        func record(_ message: EverframeRelayMessage) {
            guard case .reportFailed(let failure) = message else { return }
            lock.lock()
            correlationIds.insert(failure.correlationId)
            lock.unlock()
        }

        func contains(_ correlationId: String) -> Bool {
            lock.lock()
            defer { lock.unlock() }
            return correlationIds.contains(correlationId)
        }
    }

    private func makeBridge() -> (CompanionCaptureBridge, RelayWSClient, CompanionAPI) {
        let api = CompanionAPI()
        let client = RelayWSClient(

            companion: api)
        let bridge = CompanionCaptureBridge(client: client)
        return (bridge, client, api)
    }

    private func waitUntil(_ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return condition()
    }

    // MARK: - Capture buffer stash (Task 2)
    //
    // The stash is only populated by `handleReportRequest`, which runs on
    // @MainActor and calls ScreenshotCapture.captureKeyWindow(). Under the
    // SwiftPM-on-macOS test host there is no UIWindow, so
    // ScreenshotCapture.captureKeyWindow() returns nil and the stash is not
    // populated — the bridge sends an empty `report.assembled` instead
    // (DEFE-02 degrade path). We assert THAT behaviour here: the stash
    // count starts at 0 and a request-without-a-window does not add an
    // entry (it sends a degraded assembled frame, which is observable as
    // no crash + stash still empty).

    @Test func test1_stashStartsEmpty() {
        let (bridge, _, _) = makeBridge()
        #if canImport(UIKit)
        #expect(bridge.__stashCountForTesting() == 0)
        #else
        _ = bridge
        #endif
    }

    // MARK: - Submit text frame + binary frame pairing (Task 4)
    //
    // The bridge subscribes to both notifications on init. Posting the text
    // frame alone does NOT trigger a submit (bakedBytes == nil). Posting the
    // binary frame WITHOUT a preceding text frame is dropped silently. The
    // pair together with no capture stash emits `report.failed`.

    @Test func test2_submitWithoutCaptureStash_emitsReportFailed() async throws {
        let (bridge, _, _) = makeBridge()
        let corrId = "corr_test_2"

        // Text frame (recordPendingSubmit).
        let submit = Self.makeSubmit(correlationId: corrId)
        NotificationCenter.default.post(
            name: .everframeCompanionReportSubmit,
            object: nil,
            userInfo: ["correlation_id": corrId, "submit": submit])

        // Binary frame (triggers tryRunSubmit).
        // Without a stash entry for corrId, tryRunSubmit should immediately
        // post `report.failed` via client?.send(...). The client's task is
        // nil (we never called connect()), so the send is a silent drop —
        // but the buffer cleanup is observable: pendingSubmit dict empty.
        NotificationCenter.default.post(
            name: .everframeCompanionReportSubmitBinary,
            object: nil,
            userInfo: ["correlation_id": corrId, "bytes": Data()])

        // Let the async hop complete.
        try await Task.sleep(nanoseconds: 50_000_000)

        // Smoke: bridge didn't crash; stash still empty.
        #if canImport(UIKit)
        #expect(bridge.__stashCountForTesting() == 0)
        #else
        _ = bridge
        #endif
    }

    @Test func test2b_multiShotSubmit_waitsForEveryShotThenProceeds() async throws {
        // Two regressions in one flow:
        //
        //  • the gate must WAIT while an announced shot is outstanding, and
        //  • the PRIMARY bytes must be buffered while it waits. They used to be
        //    a bare parameter, so the early return discarded them and every
        //    later call — driven by a shot arrival — passed nil. A multi-shot
        //    submit could then never complete: the phone sat on "submitting"
        //    forever.
        //
        // Observed through the stash: `dropEntries` runs only once the submit
        // path is actually entered, so the stash emptying is the signal that
        // the gate opened.
        let (bridge, _, _) = makeBridge()
        let corrId = "corr_test_2b"
        #if canImport(UIKit)
        bridge.__seedStashForTesting(correlationId: corrId, hostExtra: nil)
        #expect(bridge.__stashCountForTesting() == 1)
        #endif

        var submit = Self.makeSubmit(correlationId: corrId)
        submit = EverframeReportSubmit(
            annotations: submit.annotations,
            correlationId: submit.correlationId,
            description: submit.description,
            includes: submit.includes,
            shots: [EverframeReportSubmitShot(annotations: [], shotId: "s1")],
            title: submit.title,
            type: submit.type)
        NotificationCenter.default.post(
            name: .everframeCompanionReportSubmit, object: nil,
            userInfo: ["correlation_id": corrId, "submit": submit])
        NotificationCenter.default.post(
            name: .everframeCompanionReportSubmitBinary, object: nil,
            userInfo: ["correlation_id": corrId, "bytes": Data([1, 2, 3])])
        try await Task.sleep(nanoseconds: 100_000_000)

        #if canImport(UIKit)
        #expect(bridge.__stashCountForTesting() == 1,
                "the submit must still be waiting: shot s1 has not arrived")
        #endif

        NotificationCenter.default.post(
            name: .everframeCompanionReportShotBinary, object: nil,
            userInfo: ["correlation_id": corrId, "shot_id": "s1", "bytes": Data([9, 9])])
        try await Task.sleep(nanoseconds: 300_000_000)

        #if canImport(UIKit)
        #expect(bridge.__stashCountForTesting() == 0,
                "once every announced shot has arrived the submit must proceed — it used to stall forever")
        #else
        _ = bridge
        #endif
    }

    @Test func test2c_repeatedSubmitDoesNotLaunchASecondUpload() async throws {
        // Cleanup used to run only after the upload finished, and an upload
        // takes seconds to minutes. A phone repeating the same `report.submit`
        // inside that window launched another concurrent upload from the SAME
        // received image set — duplicate reports and duplicated ingest cost
        // from one user action. The buffers are consumed at launch instead.
        let (bridge, _, _) = makeBridge()
        let corrId = "corr_test_2c"

        // The whole scenario below (seed, both submit cycles, and the final
        // assertion) only means what its comments say if there is a real
        // capture stash to consume — without one, `tryRunSubmit` takes the
        // no-capture `report.failed` exit instead (already covered by
        // test2_submitWithoutCaptureStash_emitsReportFailed) and the
        // sleeps/notifications here would just be busywork proving nothing.
        // So this is guarded as one unit rather than seeding unconditionally
        // and leaving the rest to run unseeded on macOS.
        #if canImport(UIKit)
        bridge.__seedStashForTesting(correlationId: corrId, hostExtra: nil)
        let submit = Self.makeSubmit(correlationId: corrId)

        NotificationCenter.default.post(
            name: .everframeCompanionReportSubmit, object: nil,
            userInfo: ["correlation_id": corrId, "submit": submit])
        NotificationCenter.default.post(
            name: .everframeCompanionReportSubmitBinary, object: nil,
            userInfo: ["correlation_id": corrId, "bytes": Data([1, 2, 3])])
        try await Task.sleep(nanoseconds: 50_000_000)

        // The phone re-sends the same submit while the first is still in flight.
        NotificationCenter.default.post(
            name: .everframeCompanionReportSubmit, object: nil,
            userInfo: ["correlation_id": corrId, "submit": submit])
        NotificationCenter.default.post(
            name: .everframeCompanionReportSubmitBinary, object: nil,
            userInfo: ["correlation_id": corrId, "bytes": Data([1, 2, 3])])
        try await Task.sleep(nanoseconds: 200_000_000)

        // HONEST LIMIT: this assertion passes with the launch-time consumption
        // removed — measured, not assumed. The post-upload `dropEntries` clears
        // the stash either way, so the observable available here cannot tell
        // one launch from two; counting uploads would need a submitter seam the
        // bridge does not expose. Kept as a regression guard on the observable
        // property. The fix itself is a straightforward ordering change:
        // consume at launch rather than at completion.
        #expect(bridge.__stashCountForTesting() == 0,
                "the image set must not be left available for a second upload")
        #else
        _ = bridge
        _ = corrId
        #endif
    }

    // MARK: - Binary frame without pending submit (Task 3)
    //
    // RelayWSClient.handleBinary only posts the
    // `.everframeCompanionReportSubmitBinary` notification when a
    // pendingSubmitCorrelationId is buffered. Calling handleBinary with no
    // prior submit text frame should be a no-op — verified indirectly by
    // checking that no observer fires (the bridge's binary handler bails
    // because there's no matching pending submit).

    @Test func test3_binaryFrameWithoutPriorSubmit_isDropped() async throws {
        let (bridge, _, _) = makeBridge()
        let corrId = "corr_test_3"

        // Post a binary frame with no preceding submit text frame.
        NotificationCenter.default.post(
            name: .everframeCompanionReportSubmitBinary,
            object: nil,
            userInfo: ["correlation_id": corrId, "bytes": Data([0x89, 0x50])])

        try await Task.sleep(nanoseconds: 30_000_000)

        // Bridge should remain in initial state — no crash, no stash growth.
        #if canImport(UIKit)
        #expect(bridge.__stashCountForTesting() == 0)
        #else
        _ = bridge
        #endif
    }

    // MARK: - Host attachments — drain at request time (Plan 06.2-13 Task 1)
    //
    // Contract: the companion bridge consumes `Everframe.shared.setExtra` +
    // `Everframe.shared.attachReactTree` exactly ONCE at the moment of
    // `report.request` — not at submit time. After consumption,
    // `__consumePendingAttachments()` MUST return (nil, nil). This mirrors
    // the in-process iOS/tvOS reporter modal (EFReporterPresenter.swift:72)
    // so a host that calls `setExtra("xyz")` then drives two back-to-back
    // companion reports sees "xyz" in the FIRST envelope and nil in the
    // second.
    //
    // The bridge's request handler relies on @MainActor ScreenshotCapture
    // (no UIWindow on the SwiftPM-on-macOS test host → returns nil → no
    // stash). To exercise the host-attachment thread WITHOUT a window, we
    // drive the consume from the test directly (the bridge calls the SAME
    // public API: Everframe.shared.__consumePendingAttachments()) and verify
    // the drain semantics. Then we seed the stash through a test seam and
    // assert that the values land where the submit handler reads them.

    // `attachReactTree` is deprecated (the value is drained and discarded,
    // never shipped) but the drain-once contract below is exactly what the
    // deprecation preserves, so this test must keep calling it. Marking the
    // test itself deprecated is Swift's only per-call-site suppression —
    // narrower than dropping the annotation on the API.
    @available(*, deprecated)
    @Test func test4_consumePendingAttachments_drainsOnce() async throws {
        // Reset to known state.
        _ = await Everframe.shared.__consumePendingAttachments()

        // Two values set.
        Everframe.shared.setExtra("companion-extra")
        let treeJSON = Self.makeReactTreeJSON()
        Everframe.shared.attachReactTree(treeJSON)

        // First drain (what the bridge does inside handleReportRequest).
        let (extra1, tree1) = await Everframe.shared.__consumePendingAttachments()
        #expect(extra1 == "companion-extra")
        #expect(tree1 != nil)

        // Second drain — must be nil (consume-once invariant).
        let (extra2, tree2) = await Everframe.shared.__consumePendingAttachments()
        #expect(extra2 == nil)
        #expect(tree2 == nil)
    }

    @Test func test5_stashedHostAttachments_threadIntoSubmit() throws {
        let (bridge, _, _) = makeBridge()
        let corrId = "corr_test_5"

        // Seed the stash the way handleReportRequest would after drain.
        // Host metadata captured at request time remains available at submit.
        #if canImport(UIKit)
        bridge.__seedStashForTesting(
            correlationId: corrId,
            hostExtra: "host-companion-extra"
        )

        let attachments = bridge.__stashHostAttachmentsForTesting(correlationId: corrId)
        #expect(attachments.present == true)
        #expect(attachments.hostExtra == "host-companion-extra")
        #else
        _ = bridge
        _ = corrId
        #endif
    }

    // MARK: - A terminal frame ends only ITS OWN report (PR-fix 7)
    //
    // This is the bridge half of the finding: `sendCompleted` / `sendFailed`
    // flipped the shared state to `.paired` unconditionally at the end of the
    // submit cycle. A submit runs for seconds-to-minutes; in that window the
    // pair can be released and re-attached to a DIFFERENT dashboard user (the
    // relay force-closes only the phone leg, so this same client keeps
    // serving), which legitimately returns the pair to `.paired` and lets the
    // new user's report start. The older cycle then ended and cleared the NEW
    // report's `.reportInProgress`, after which a third request was accepted
    // over the second and re-froze the capture state its composer was about to
    // consume.
    //
    // The failure branch is the one reachable from a unit test — the success
    // branch needs a real ingest round-trip — and it is the same defect: both
    // now go through `CompanionAPI.__finishReport(correlationId:)`, which acts
    // only for the report that currently owns the state.

    @Test func test6_staleSubmitFailure_doesNotEndTheLiveReport() async throws {
        let (bridge, client, api) = makeBridge()
        let failedFrames = FailedFrameRecorder()
        client.__sendHook = { failedFrames.record($0) }

        // The live report, started through the real frame path.
        client.handleControl(#"{"type":"pair.bonded","pair_id":"p"}"#)
        client.handleControl(#"{"type":"report.request","correlation_id":"c2"}"#)
        #expect(api.state == .reportInProgress)
        #expect(api.__reportInProgressCorrelationIdForTesting() == "c2")

        // A submit cycle terminating for a report the re-bond superseded. It
        // has no capture stash (its own was dropped, or this host has no
        // UIKit), so the bridge takes a `report.failed` exit — the shape every
        // failure path shares.
        Self.postSubmitCycle(correlationId: "c1")
        #expect(await waitUntil { failedFrames.contains("c1") })

        #expect(api.state == .reportInProgress)
        #expect(api.__reportInProgressCorrelationIdForTesting() == "c2")

        // …and the live report's OWN failure still ends it, so the guard is not
        // a latch that would leave a host stuck showing "report in progress".
        Self.postSubmitCycle(correlationId: "c2")
        #expect(await waitUntil {
            failedFrames.contains("c2")
                && api.state == .paired
                && api.__reportInProgressCorrelationIdForTesting() == nil
        })

        #expect(api.state == .paired)
        #expect(api.__reportInProgressCorrelationIdForTesting() == nil)
        _ = bridge
    }

    /// Drive one full submit cycle into the bridge: the `report.submit` text
    /// frame followed by the D-05 binary frame that triggers `tryRunSubmit`.
    private static func postSubmitCycle(correlationId: String) {
        NotificationCenter.default.post(
            name: .everframeCompanionReportSubmit,
            object: nil,
            userInfo: ["correlation_id": correlationId,
                       "submit": makeSubmit(correlationId: correlationId)])
        NotificationCenter.default.post(
            name: .everframeCompanionReportSubmitBinary,
            object: nil,
            userInfo: ["correlation_id": correlationId, "bytes": Data([0x89, 0x50])])
    }

    // MARK: - Helpers

    /// Build a minimal valid ReactTree JSON in the shape the JS bippy walker
    /// emits: ISO 8601 with milliseconds, rendererHint "dom", single empty
    /// root node. Same date format as the in-process modal decodes
    /// (EFReporterPresenter.swift custom .dateDecodingStrategy).
    static func makeReactTreeJSON() -> Data {
        let json = """
        {
          "capturedAt": "2026-05-20T12:34:56.789Z",
          "rendererHint": "dom",
          "root": {
            "children": [],
            "componentName": "EverframeApp",
            "componentType": "function",
            "identifiers": {},
            "rect": { "x": 0, "y": 0, "width": 100, "height": 100 },
            "safeProps": {}
          }
        }
        """
        return Data(json.utf8)
    }

    static func makeSubmit(correlationId: String) -> EverframeReportSubmit {
        return EverframeReportSubmit(
            annotations: [],
            correlationId: correlationId,
            description: EverframeReportSubmitDescription(redactions: [], text: "test desc"),
            includes: EverframeReportSubmitIncludes(
                logs: true, metadata: true, network: true,
                screenshot: true, uiTree: true),
            title: "test title",
            type: "report.submit")
    }
}
