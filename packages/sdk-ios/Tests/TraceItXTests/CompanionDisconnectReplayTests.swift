// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import Foundation
import Testing
@testable import TraceItXKit

private actor DisconnectReplayFetcher: URLSessionFetching {
    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        (Data(#"{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1,"nativeVideo":{"framesPerSecond":5}}"#.utf8),
         HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

@MainActor @Suite(.serialized)
struct CompanionDisconnectReplayTests {
    private final class SessionBox { var session: ReplaySession? }

    private func eventually(_ predicate: @MainActor () -> Bool) async -> Bool {
        for _ in 0..<500 {
            if predicate() { return true }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return predicate()
    }

    @Test(arguments: ["phone.disconnected", "pair.expired", "background", "disconnect", "rebound", "socketClose", "pendingRequest", "staleFailure"])
    func losingCompanionResumesReplay(reason: String) async throws {
        try await withGlobalCaptureStateLock {
            let box = SessionBox()
            TraceItX.__replaySessionFactoryForTesting = { _ in
                MainActor.assumeIsolated {
                    let provider = ReplayConfigProvider(configUrl: URL(string: "https://example.test/config")!,
                        apiKey: "test", fetcher: DisconnectReplayFetcher())
                    let session = ReplaySession(provider: provider, locallyDisabled: false)
                    box.session = session
                    return session
                }
            }
            defer {
                TraceItX.__resetReplaySessionFactoryForTesting()
                box.session?.teardown()
            }
            try TraceItX.shared.start(config: TraceItXConfig(
                appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU", capture: CaptureConfig(logs: false)))
            #expect(await eventually { box.session?.__lifecycleStateForTesting() == .buffering })
            let api = CompanionAPI()
            let client = RelayWSClient(companion: api)
            let bridge = CompanionCaptureBridge(client: client)
            defer { withExtendedLifetime(bridge) {} }
            client.handleControl(#"{"type":"pair.bonded","pair_id":"p"}"#)
            client.handleControl(#"{"type":"report.request","correlation_id":"abandoned"}"#)
            var authorizeOldCapture: (@MainActor @Sendable () -> Bool)?
            if reason != "pendingRequest" {
                #expect(await eventually { box.session?.__lifecycleStateForTesting() == .frozen })
                authorizeOldCapture = bridge.captureAuthorization(correlationId: "abandoned", authEpoch: CompanionAuthEpoch.current)
                #expect(authorizeOldCapture?() == true)
            }

            switch reason {
            case "background": client.handleDidEnterBackground()
            case "disconnect": client.disconnect()
            case "rebound": client.handleControl(#"{"type":"pair.bonded","pair_id":"new"}"#)
            case "socketClose":
                client.__scheduleReconnectHook = { _ in }
                client.urlSession(URLSession.shared,
                    webSocketTask: URLSession.shared.webSocketTask(with: URL(string: "wss://example.test/relay")!),
                    didCloseWith: URLSessionWebSocketTask.CloseCode(rawValue: 4005)!, reason: nil)
            case "pendingRequest":
                client.handleControl(#"{"type":"phone.disconnected","pair_id":"p"}"#)
                try await Task.sleep(nanoseconds: 600_000_000)
            case "staleFailure":
                client.handleControl(#"{"type":"phone.disconnected","pair_id":"p"}"#)
                client.handleControl(#"{"type":"pair.bonded","pair_id":"new"}"#)
                client.handleControl(#"{"type":"report.request","correlation_id":"live"}"#)
                try await Task.sleep(nanoseconds: 600_000_000)
                #expect(box.session?.__lifecycleStateForTesting() == .frozen)
                #expect(authorizeOldCapture?() == false)
                #expect(bridge.captureAuthorization(correlationId: "live", authEpoch: CompanionAuthEpoch.current)())
                NotificationCenter.default.post(name: .traceItXCompanionReportSubmit, object: nil,
                    userInfo: ["correlation_id": "abandoned",
                               "submit": CompanionSubmitBridgeTests.makeSubmit(correlationId: "abandoned")])
                NotificationCenter.default.post(name: .traceItXCompanionReportSubmitBinary, object: nil,
                    userInfo: ["correlation_id": "abandoned", "bytes": Data()])
                try await Task.sleep(nanoseconds: 300_000_000)
                #expect(box.session?.__lifecycleStateForTesting() == .frozen)
                #expect(api.__reportInProgressCorrelationIdForTesting() == "live")
                client.disconnect()
            default: client.handleControl("{\"type\":\"\(reason)\",\"pair_id\":\"p\",\"reason\":\"expired\"}")
            }
            if let authorizeOldCapture { #expect(!authorizeOldCapture()) }
            #expect(await eventually { box.session?.__lifecycleStateForTesting() == .buffering })
        }
    }
}
#endif
