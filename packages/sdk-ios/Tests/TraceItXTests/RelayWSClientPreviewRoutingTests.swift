// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Which inbound frame calls which session method, with which arguments — and
// which lifecycle signals stop the preview.
//
// Every defect Android's review found lived in exactly this seam, the
// client/session boundary, which is precisely the part that had gone
// untested there. The stop triggers are asserted rather than assumed: a
// preview that outlives the thing that authorised it is the failure this
// feature's whole privacy budget exists to prevent.
#if canImport(UIKit)
import Testing
import Foundation
import UIKit
import TraceItXProtocol
@testable import TraceItXKit

@Suite(.serialized)
@MainActor
struct RelayWSClientPreviewRoutingTests {

    final class RecordingSession: CompanionPreviewSessionApi {
        enum Call: Equatable {
            case start(String)
            case stop(String)
            case stopSilently
            case requestShot(correlationId: String, shotId: String, rect: NormalizedRect?)
            case clearStash
            case clearStashFor(String)
            case teardown
        }
        var calls: [Call] = []
        var isRunning: Bool = false
        func start(correlationId: String) { calls.append(.start(correlationId)) }
        func stop(reason: PreviewStopReason) { calls.append(.stop(reason.rawValue)) }
        func stopSilently() { calls.append(.stopSilently) }
        func clearStash() { calls.append(.clearStash) }
        func clearStashFor(correlationId: String) { calls.append(.clearStashFor(correlationId)) }
        func requestShot(correlationId: String, shotId: String, rect: NormalizedRect?, authAtRequest: UInt64) {
            calls.append(.requestShot(correlationId: correlationId, shotId: shotId, rect: rect))
        }
        func teardown() { calls.append(.teardown) }
    }

    /// Mirrors `RelayWSClientCompanionTests.makeClient`: the internal
    /// initializer with no announce transport, so nothing here touches the
    /// network. Only `handleControl` and the lifecycle handlers are driven.
    private func makeClient() -> (RelayWSClient, RecordingSession) {
        let client = RelayWSClient(
            endpoint: URL(string: "https://example.invalid")!,
            companion: CompanionAPI(),
            sdkKey: nil,
            deviceLabel: nil,
            announceTransport: nil)
        let session = RecordingSession()
        client.__previewSessionOverride = session
        return (client, session)
    }

    /// The routed calls hop to the main actor through a chained task, so a test
    /// has to let that chain drain before asserting.
    private func drain() async {
        for _ in 0..<50 {
            await Task.yield()
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
    }

    private func frame(_ json: String) -> String { json }

    @Test("preview.start starts the session under the frame's correlation id")
    func previewStartRoutes() async throws {
        let (client, session) = makeClient()

        client.handleControl(frame(#"{"type":"preview.start","correlation_id":"c1"}"#))
        await drain()

        #expect(session.calls == [.start("c1")])
    }

    @Test("preview.stop goes quiet — it never echoes a stop back at the peer")
    func previewStopRoutes() async throws {
        let (client, session) = makeClient()

        client.handleControl(frame(#"{"type":"preview.stop","correlation_id":"c1","reason":"user"}"#))
        await drain()

        #expect(session.calls == [.stopSilently],
                "echoing a stop back at the peer that just sent one is nonsensical")
    }

    @Test("shot.request carries the ids from the frame, not from session state")
    func shotRequestRoutes() async throws {
        let (client, session) = makeClient()

        client.handleControl(frame(#"{"type":"shot.request","correlation_id":"c1","shot_id":"s1"}"#))
        await drain()

        #expect(session.calls == [.requestShot(correlationId: "c1", shotId: "s1", rect: nil)])
    }

    @Test("shot.request passes a crop rect through when present")
    func shotRequestWithRect() async throws {
        let (client, session) = makeClient()

        client.handleControl(frame(
            #"{"type":"shot.request","correlation_id":"c1","shot_id":"s1","rect":{"x":0.1,"y":0.2,"w":0.3,"h":0.4}}"#))
        await drain()

        #expect(session.calls == [.requestShot(correlationId: "c1", shotId: "s1",
                                               rect: NormalizedRect(x: 0.1, y: 0.2, w: 0.3, h: 0.4))])
    }

    // ---- The stop triggers ----

    @Test("phone.disconnected stops the preview and drops the stash")
    func phoneDisconnectedStops() async throws {
        let (client, session) = makeClient()

        client.handleControl(frame(#"{"type":"phone.disconnected","pair_id":"p1"}"#))
        await drain()

        #expect(session.calls == [.stopSilently, .clearStash],
                "nobody is left to receive frames, and a reconnecting phone must not re-crop the old cycle's pixels")
    }

    @Test("pair.expired stops the preview and drops the stash")
    func pairExpiredStops() async throws {
        let (client, session) = makeClient()

        client.handleControl(frame(#"{"type":"pair.expired","pair_id":"p1","reason":"ttl"}"#))
        await drain()

        #expect(session.calls == [.stopSilently, .clearStash])
    }

    @Test("backgrounding stops the preview but leaves it resumable")
    func backgroundingStops() async throws {
        let (client, session) = makeClient()

        client.handleDidEnterBackground()
        await drain()

        #expect(session.calls == [.stopSilently, .clearStash],
                "stopSilently + clearStash, never teardown — the SAME client reconnects on foreground")
        #expect(!session.calls.contains(.teardown))
    }

    @Test("disconnect tears the session down permanently")
    func disconnectTearsDown() async throws {
        let (client, session) = makeClient()

        client.disconnect()
        await drain()

        #expect(session.calls == [.teardown],
                "report-grade pixels must not outlive the client authorised to hold them")
    }

    @Test("disconnect tears the companion name badge down too")
    func disconnectTearsDownBadge() async throws {
        // Deliberately NOT using `makeClient()`: that helper's `CompanionAPI()`
        // is only referenced through the client's own `weak` property, so it
        // would be deallocated before this test could drive it. `companion`
        // must be held here, strongly, for the test's own lifetime.
        let companion = CompanionAPI()
        let client = RelayWSClient(
            endpoint: URL(string: "https://example.invalid")!,
            companion: companion,
            sdkKey: nil,
            deviceLabel: nil,
            announceTransport: nil)
        guard let badge = client.__badgeForTesting else {
            Issue.record("expected a badge instance — companionBadge defaults to enabled")
            return
        }
        let container = UIView(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        CompanionBadge.__surfaceProvider = { container }
        defer { CompanionBadge.__surfaceProvider = nil }

        companion.__setAttachedUserName("Alice")
        companion.__setCode("7421")
        await drain()
        #expect(badge.isVisible)
        #expect(container.subviews.count == 1)

        client.disconnect()
        await drain()

        #expect(!badge.isVisible,
                "disconnect() must tear the badge down too — before this fix it was only cleared on the separate terminal-close branch")
        #expect(container.subviews.isEmpty)
    }

    @Test("report.cancelled drops the stash but leaves the preview alone")
    func reportCancelledClearsStash() async throws {
        let (client, session) = makeClient()

        client.handleControl(frame(#"{"type":"report.cancelled","correlation_id":"c1"}"#))
        await drain()

        #expect(session.calls == [.clearStashFor("c1")],
                "correlation-scoped: a DELAYED cancellation from an OLDER report must not delete the current report's captures")
    }

    @Test("a terminal report frame the device sends drops the stash")
    func terminalReportFramesClearStash() async throws {
        // The device is the sender of report.completed / report.failed /
        // report.rejected, so the outbound send is the only choke point that
        // sees a report end however it ended. Before this, ONLY pair-loss and
        // backgrounding cleared the stash, so a finished report left
        // full-resolution screenshots resident until some LATER report happened
        // to start under a new correlation id.
        for (label, message) in [
            ("completed", RelayMessage.reportCompleted(
                ReportCompleted(correlationId: "c1", eventId: "e1", type: "report.completed"))),
            ("failed", RelayMessage.reportFailed(
                ReportFailed(correlationId: "c1", reason: "nope", type: "report.failed"))),
        ] {
            let (client, session) = makeClient()

            client.send(message)
            await drain()

            #expect(session.calls == [.clearStashFor("c1")],
                    "report.\(label) must drop THAT report's stash — a submit outlives its bond, so an unconditional clear erases a newer live report's captures")
        }
    }

    // ---- Ordering ----

    @Test("a start immediately followed by a stop is not reordered")
    func startThenStopKeepsOrder() async throws {
        // The one reordering that matters: if the start overtakes the stop, the
        // device keeps reading the user's screen with nothing left to stop it.
        //
        // HONEST LIMIT: this test passes under BOTH the chained hops the client
        // uses and a plain `Task { @MainActor in ... }` — measured by swapping
        // the implementation and re-running. Unstructured tasks carry no
        // DOCUMENTED ordering guarantee, but they evidently do not reorder in
        // practice here, so this asserts the observable property as a
        // regression guard rather than proving the chain is load-bearing. Do
        // not read a green run as evidence that dropping the chain is safe.
        let (client, session) = makeClient()

        for _ in 0..<20 {
            client.handleControl(frame(#"{"type":"preview.start","correlation_id":"c1"}"#))
            client.handleControl(frame(#"{"type":"preview.stop","correlation_id":"c1","reason":"user"}"#))
        }
        await drain()

        #expect(session.calls.count == 40)
        for pair in stride(from: 0, to: session.calls.count, by: 2) {
            #expect(session.calls[pair] == .start("c1"), "call \(pair) must be the start")
            #expect(session.calls[pair + 1] == .stopSilently, "call \(pair + 1) must be its stop")
        }
    }

    // ---- Phone-bound frames stay terminal ----

    @Test("shot.binary binds the next binary to its shot, rather than being ignored")
    func shotBinaryIsIngested() async throws {
        // `shot.binary` is phone -> device, at submit time. An earlier revision
        // of the routing lumped it in with the device-sent frames below and
        // called receiving it a protocol violation — wrong, and the effect was
        // that every extra shot's bytes were dropped, so a multi-shot report
        // uploaded only the primary screenshot and still reported success.
        let (client, _) = makeClient()
        let received = UncheckedBoxRef<[String: Any]?>(nil)
        let token = NotificationCenter.default.addObserver(
            forName: .traceItXCompanionReportShotBinary, object: nil, queue: nil
        ) { note in received.value = note.userInfo as? [String: Any] }
        defer { NotificationCenter.default.removeObserver(token) }

        client.handleControl(frame(
            #"{"type":"shot.binary","correlation_id":"c1","shot_id":"s7"}"#))
        client.__handleBinaryForTesting(Data([9, 9, 9]))
        await drain()

        let info = try #require(received.value, "the bytes must be routed, not dropped")
        #expect(info["correlation_id"] as? String == "c1")
        #expect(info["shot_id"] as? String == "s7", "the marker names which shot the bytes belong to")
        #expect((info["bytes"] as? Data)?.count == 3)
    }

    @Test("an interrupted shot transfer does not poison the next report")
    func staleShotBindingIsCleared() async throws {
        // `shot.binary` arms "the next binary belongs to shot X". If the phone
        // drops between the marker and its payload, that binding used to
        // outlive the phone leg — so the NEXT report's PRIMARY binary was
        // routed into the dead shot, and that report waited forever for a
        // primary which had already arrived.
        let (client, _) = makeClient()
        let shotBytes = UncheckedBoxRef<Int>(0)
        let token = NotificationCenter.default.addObserver(
            forName: .traceItXCompanionReportShotBinary, object: nil, queue: nil
        ) { _ in shotBytes.value += 1 }
        defer { NotificationCenter.default.removeObserver(token) }

        client.handleControl(frame(
            #"{"type":"shot.binary","correlation_id":"c1","shot_id":"s1"}"#))
        // …and the phone goes away before sending the bytes.
        client.handleControl(frame(#"{"type":"phone.disconnected","pair_id":"p1"}"#))
        await drain()

        // A later report's primary binary must NOT be swallowed as that shot.
        client.__handleBinaryForTesting(Data([1, 2, 3]))
        await drain()

        #expect(shotBytes.value == 0,
                "the stale binding must be cleared with the phone leg, or the next report's primary is misrouted")
    }

    /// Minimal mutable box so the notification closure can hand a value back.
    final class UncheckedBoxRef<T>: @unchecked Sendable {
        var value: T
        init(_ value: T) { self.value = value }
    }

    @Test("device-sent frame types are ignored when received")
    func phoneBoundFramesAreIgnored() async throws {
        let (client, session) = makeClient()

        client.handleControl(frame(
            #"{"type":"preview.frame","correlation_id":"c1","seq":0,"mime":"image/jpeg","width":8,"height":4}"#))
        client.handleControl(frame(
            #"{"type":"shot.assembled","correlation_id":"c1","shot_id":"s1","mime":"image/png","size":4,"width":8,"height":4}"#))
        client.handleControl(frame(
            #"{"type":"shot.failed","correlation_id":"c1","shot_id":"s1","reason":"nope"}"#))
        await drain()

        #expect(session.calls.isEmpty,
                "the device is the sole sender of these; receiving one is a protocol violation, not a case to handle")
    }
}
#endif
