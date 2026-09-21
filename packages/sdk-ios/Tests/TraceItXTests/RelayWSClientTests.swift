// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Phase 06.2-07 Task 2 — RelayWSClient unit tests.
//
// Tests target the parts of `RelayWSClient` that don't require a live WS
// server: URL composition, message dispatch on inbound control frames,
// close-code → state transitions, and backoff schedule. Live-server e2e
// coverage lives in Plan 10's bench harness + the ingest-service relay
// integration tests (already shipped in Plan 06.2-04 / 06.2-08).
//
// The `__scheduleReconnectHook` test seam (RelayWSClient.swift) lets us
// observe the reconnect schedule without actually sleeping or opening
// sockets — closures receive the computed delay synchronously.
import Testing
import Foundation
import TraceItXProtocol
@testable import TraceItXKit

@Suite(.serialized)
final class RelayWSClientTests {

    private func makeClient() -> (RelayWSClient, CompanionAPI) {
        let api = CompanionAPI()
        let url = URL(string: "https://relay.example.com")!
        return (RelayWSClient(endpoint: url, companion: api), api)
    }

    // MARK: - URL composition

    @Test func test1_wsURLForTV_https_to_wss() {
        let url = RelayWSClient.wsURLForTV(endpoint: URL(string: "https://relay.example.com")!)
        #expect(url.absoluteString == "wss://relay.example.com/relay/tv")
    }

    @Test func test2_wsURLForTV_http_to_ws_localhost() {
        let url = RelayWSClient.wsURLForTV(endpoint: URL(string: "http://localhost:8787")!)
        #expect(url.absoluteString == "ws://localhost:8787/relay/tv")
    }

    @Test func test3_wsURLForPhoneReconnect_uses_token() {
        let url = RelayWSClient.wsURLForPhoneReconnect(
            endpoint: URL(string: "https://relay.example.com")!,
            deviceToken: "dev_abc")
        #expect(url.absoluteString == "wss://relay.example.com/relay/phone/reconnect/dev_abc")
    }

    @Test func test4_pairURL_composition() {
        let url = RelayWSClient.pairURL(
            endpoint: URL(string: "https://relay.example.com")!,
            pairToken: "tok_xyz")
        #expect(url == "https://relay.example.com/r/tok_xyz")
    }

    @Test func test5_pairURL_with_port() {
        let url = RelayWSClient.pairURL(
            endpoint: URL(string: "http://localhost:8787")!,
            pairToken: "tok_dev")
        #expect(url == "http://localhost:8787/r/tok_dev")
    }

    // MARK: - Backoff schedule (Pitfall 3 — cap at 10 s)

    @Test func test6_backoffSchedule_capsAt10s() {
        for delay in RelayWSClient.backoffSchedule {
            #expect(delay <= 10.0)
        }
        // Last entry is 10 s — confirms the cap is the explicit terminator
        // (not just a coincidence of the first 4 entries).
        #expect(RelayWSClient.backoffSchedule.last == 10.0)
        #expect(RelayWSClient.backoffSchedule.count == 5)
    }

    @Test func test7_closeCode4001_transitionsToUnpaired() async throws {
        let (client, api) = makeClient()
        // Prime to .paired so we observe the transition.
        api.__setState(.paired)
        api.__setPairUrl("https://relay.example.com/r/tok_old")
        var delays: [TimeInterval] = []
        client.__scheduleReconnectHook = { delays.append($0) }

        // Simulate delegate callback for close-code 4001.
        client.urlSession(
            URLSession.shared,
            webSocketTask: URLSession.shared.webSocketTask(with: URL(string: "wss://example/")!),
            didCloseWith: URLSessionWebSocketTask.CloseCode(rawValue: 4001)!,
            reason: nil)

        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(api.state == .unpaired)
        #expect(api.pairUrl == nil)
        #expect(delays.count == 1) // reconnect scheduled
        _ = client
    }

    @Test func test8_closeCode4002_transitionsToUnpaired() async throws {
        let (client, api) = makeClient()
        api.__setState(.paired)
        var delays: [TimeInterval] = []
        client.__scheduleReconnectHook = { delays.append($0) }

        client.urlSession(
            URLSession.shared,
            webSocketTask: URLSession.shared.webSocketTask(with: URL(string: "wss://example/")!),
            didCloseWith: URLSessionWebSocketTask.CloseCode(rawValue: 4002)!,
            reason: nil)

        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(api.state == .unpaired)
        _ = client
    }

    @Test func test9_closeCode4005_keepsTokenAndReconnects() async throws {
        // 4005 = server_shutdown — state doesn't get scrubbed; reconnect on
        // the new server process (potentially via device_token reconnect path).
        let (client, api) = makeClient()
        api.__setState(.paired)
        var delays: [TimeInterval] = []
        client.__scheduleReconnectHook = { delays.append($0) }

        client.urlSession(
            URLSession.shared,
            webSocketTask: URLSession.shared.webSocketTask(with: URL(string: "wss://example/")!),
            didCloseWith: URLSessionWebSocketTask.CloseCode(rawValue: 4005)!,
            reason: nil)

        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(api.state == .paired) // unchanged; 4005 is transient
        #expect(delays.count == 1)
        _ = client
    }

    // MARK: - Control-frame handlers (parity with Android RelayWSClientTest)

    @Test func test_phoneDisconnected_transitionsToPhoneDisconnected() async throws {
        // Server emits `phone.disconnected` when the phone WS closes
        // (browser tab close, network drop). The TV must flip out of
        // `.paired` so its UI reflects reality, without losing the
        // pair record — a phone reconnect within the 5-min grace window
        // will land a fresh `pair.bonded` and flip back.
        let (client, api) = makeClient()
        api.__setState(.paired)

        client.handleControl(#"{"type":"phone.disconnected","pair_id":"p"}"#)

        #expect(api.state == .phoneDisconnected)
    }

    @Test func test_reportCancelled_returnsToPairedFromReportInProgress() async throws {
        // Phone-side Discard after `report.request`. Without this handler
        // the TV's host UI sits on the "report in progress" indicator
        // forever even though the phone is back on bonded_idle.
        let (client, api) = makeClient()
        // `__beginReport`, not `__setState(.reportInProgress)`: a report in
        // flight has an identity, and only a frame carrying the same
        // correlation_id may end it (PR-fix 7). Standing the state up without
        // an owner would leave this cancel belonging to nobody.
        api.__beginReport(correlationId: "corr_x")

        client.handleControl(#"{"type":"report.cancelled","correlation_id":"corr_x"}"#)

        // `.reportCancelled` is the one control frame whose `__finishReport`
        // runs inside `Task { @MainActor }` — it has to, because it also calls
        // `CompanionCaptureBridge.abortReportCaptureLifecycle()`, which is
        // main-actor-isolated. `.reportCompleted` and `.reportFailed` finish
        // synchronously, which is why only this test needed the wait and why
        // asserting straight after `handleControl` looked correct next to its
        // neighbours.
        //
        // Without the hop the assertion ran on the still-unchanged state and
        // read `.reportInProgress`, so this test has been failing since it was
        // written — and because swift.yml's `--filter` excluded it, nothing
        // reported that. Hopping to the main actor here queues behind the
        // client's own already-enqueued Task, so the state is settled by the
        // time the expectation runs.
        await MainActor.run {}

        #expect(api.state == .paired)
    }

    @Test func test_pairBonded_tvSideMissingDeviceToken_doesNotCrash() async throws {
        // TV-side bond frame omits device_token / device_token_expires_at
        // (server only sends them to the phone). Prior to the optional-
        // fields codegen fix, strict decode failed and the bond was
        // silently dropped → state never flipped to `.paired`.
        let (client, api) = makeClient()
        api.__setState(.unpaired)
        api.__setPairUrl("https://relay.example.com/r/tok_xyz")

        client.handleControl(#"{"type":"pair.bonded","pair_id":"p"}"#)

        #expect(api.state == .paired)
        // pairUrl is RETAINED on bond — nulled only on socket close.
        #expect(api.pairUrl == "https://relay.example.com/r/tok_xyz")
    }

    @Test func test10_backoffEscalates_thenCapsAt10s() async throws {
        let (client, _) = makeClient()
        var delays: [TimeInterval] = []
        client.__scheduleReconnectHook = { delays.append($0) }

        // Trigger 7 reconnects — schedule should be [1,2,4,8,10,10,10].
        for _ in 0..<7 {
            client.urlSession(
                URLSession.shared,
                webSocketTask: URLSession.shared.webSocketTask(with: URL(string: "wss://example/")!),
                didCloseWith: URLSessionWebSocketTask.CloseCode(rawValue: 4006)!,
                reason: nil)
        }
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(delays == [1, 2, 4, 8, 10, 10, 10])
        _ = client
    }
}
