// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import Foundation
import UIKit
import Testing
@testable import TraceItXKit

private actor VideoConfigFetcher: URLSessionFetching {
    var succeeds = true
    func fail() { succeeds = false }
    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        guard succeeds else { throw URLError(.notConnectedToInternet) }
        return (Data(#"{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1,"nativeVideo":{"framesPerSecond":10}}"#.utf8),
            HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

@MainActor @Suite(.serialized) struct NativeVideoCoordinatorTests {
    private final class AssemblyState { var assembled = false }

    private func waitForAssembly(_ state: AssemblyState) async -> Bool {
        for _ in 0..<500 {
            if state.assembled { return true }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return state.assembled
    }

    @Test func replacingSDKSessionDuringCompanionReportStaysFrozenUntilClose() async {
        await withGlobalCaptureStateLock {
            let companion = TraceItX.shared.companion
            let client = RelayWSClient(companion: companion)
            let bridge = CompanionCaptureBridge(client: client)
            defer {
                client.disconnect()
                companion.__setState(.unpaired)
                CompanionCaptureBridge.abortReportCaptureLifecycle()
                withExtendedLifetime(bridge) {}
            }
            let assembly = AssemblyState()
            client.__sendHook = { message in
                if case .reportAssembled = message {
                    Task { @MainActor in assembly.assembled = true }
                }
            }
            client.handleControl(#"{"type":"pair.bonded","pair_id":"video-pair"}"#)
            client.handleControl(#"{"type":"report.request","correlation_id":"video-restart"}"#)
            #expect(await waitForAssembly(assembly))
            let provider = ReplayConfigProvider(configUrl: URL(string: "https://example.test/config")!, apiKey: "test", fetcher: VideoConfigFetcher())
            let session = ReplaySession(provider: provider, locallyDisabled: false)
            defer { session.teardown() }
            await session.refreshConfigNow()
            #expect(session.__lifecycleStateForTesting() == .frozen)
            companion.__finishReport(correlationId: "video-restart") {
                session.cancelForReporter()
            }
            #expect(session.__lifecycleStateForTesting() == .buffering)
        }
    }

    @Test(arguments: [false, true])
    func disconnectedCompanionDoesNotFreezeReplacementSession(afterAssembly: Bool) async {
        await withGlobalCaptureStateLock {
            let companion = TraceItX.shared.companion
            let client = RelayWSClient(companion: companion)
            let bridge = CompanionCaptureBridge(client: client)
            defer {
                client.disconnect()
                companion.__setState(.unpaired)
                CompanionCaptureBridge.abortReportCaptureLifecycle()
                withExtendedLifetime(bridge) {}
            }
            let assembly = AssemblyState()
            client.__sendHook = { message in
                if case .reportAssembled = message {
                    Task { @MainActor in assembly.assembled = true }
                }
            }
            client.handleControl(#"{"type":"pair.bonded","pair_id":"video-pair"}"#)
            client.handleControl("{\"type\":\"report.request\",\"correlation_id\":\"abandoned-video-\(afterAssembly)\"}")
            if afterAssembly { #expect(await waitForAssembly(assembly)) }
            // Disconnect invalidates authorization synchronously, including a
            // request whose asynchronous bridge callback has not run yet.
            client.disconnect()
            let provider = ReplayConfigProvider(configUrl: URL(string: "https://example.test/config")!, apiKey: "test", fetcher: VideoConfigFetcher())
            let session = ReplaySession(provider: provider, locallyDisabled: false)
            defer { session.teardown() }
            await session.refreshConfigNow()
            #expect(session.__lifecycleStateForTesting() == .buffering)
        }
    }

    // Run with -Xfrontend -enable-actor-data-race-checks to detect an
    // Objective-C notification selector entering MainActor off its executor.
    @Test func thermalNotificationFromBackgroundQueuePreservesCapture() async {
        await GlobalCaptureStateTestGate.shared.acquire()
        do {
            let provider = ReplayConfigProvider(configUrl: URL(string: "https://example.test/config")!, apiKey: "test", fetcher: VideoConfigFetcher())
            let session = ReplaySession(provider: provider, locallyDisabled: false)
            defer { session.teardown() }
            await session.refreshConfigNow()
            #expect(session.__lifecycleStateForTesting() == .buffering)
            await withCheckedContinuation { continuation in
                DispatchQueue.global().async {
                    NotificationCenter.default.post(name: ProcessInfo.thermalStateDidChangeNotification, object: ProcessInfo.processInfo)
                    DispatchQueue.main.async { continuation.resume() }
                }
            }
            #expect(session.__lifecycleStateForTesting() == .buffering)
        }
        TraceItX.shared.kill()
        await GlobalCaptureStateTestGate.shared.release()
    }

    @Test func queuedThermalNotificationDoesNotReviveTornDownSession() async {
        await GlobalCaptureStateTestGate.shared.acquire()
        do {
            let provider = ReplayConfigProvider(configUrl: URL(string: "https://example.test/config")!, apiKey: "test", fetcher: VideoConfigFetcher())
            let session = ReplaySession(provider: provider, locallyDisabled: false)
            await session.refreshConfigNow()
            #expect(session.__lifecycleStateForTesting() == .buffering)
            // Keep MainActor occupied until the background delivery queues its
            // callback, then tear down before allowing that callback to run.
            let posted = DispatchSemaphore(value: 0)
            DispatchQueue.global().async {
                NotificationCenter.default.post(name: ProcessInfo.thermalStateDidChangeNotification, object: ProcessInfo.processInfo)
                posted.signal()
            }
            #expect(posted.wait(timeout: .now() + 5) == .success)
            session.teardown()
            await withCheckedContinuation { continuation in
                DispatchQueue.main.async { continuation.resume() }
            }
            #expect(session.__lifecycleStateForTesting() == .idle)
        }
        TraceItX.shared.kill()
        await GlobalCaptureStateTestGate.shared.release()
    }

    @Test func replacingSDKSessionWhileReporterIsMountedDoesNotRecordReporter() async {
        await withGlobalCaptureStateLock {
            ReportAPI.__performSetPresenting(true)
            defer { ReportAPI.__performSetPresenting(false) }
            let provider = ReplayConfigProvider(configUrl: URL(string: "https://example.test/config")!, apiKey: "test", fetcher: VideoConfigFetcher())
            let session = ReplaySession(provider: provider, locallyDisabled: false)
            defer { session.teardown() }
            await session.refreshConfigNow()
            #expect(session.__lifecycleStateForTesting() == .frozen)
            ReportAPI.__performSetPresenting(false)
            session.cancelForReporter()
            #expect(session.__lifecycleStateForTesting() == .buffering)
        }
    }

    @Test func failedRefreshStopsLiveCaptureInsteadOfKeepingLastGoodReplay() async {
        await withGlobalCaptureStateLock {
            let fetcher = VideoConfigFetcher()
            let provider = ReplayConfigProvider(configUrl: URL(string: "https://example.test/config")!, apiKey: "test", fetcher: fetcher)
            let session = ReplaySession(provider: provider, locallyDisabled: false)
            defer { session.teardown() }
            await session.refreshConfigNow()
            #expect(session.__lifecycleStateForTesting() == .buffering)
            await fetcher.fail()
            await session.refreshConfigNow()
            #expect(session.__lifecycleStateForTesting() == .idle)
        }
    }

    @Test func backgroundAndMemoryWarningStopCaptureUntilForeground() async {
        await withGlobalCaptureStateLock {
            let provider = ReplayConfigProvider(configUrl: URL(string: "https://example.test/config")!, apiKey: "test", fetcher: VideoConfigFetcher())
            let session = ReplaySession(provider: provider, locallyDisabled: false)
            defer { session.teardown() }
            await session.refreshConfigNow()
            NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
            #expect(session.__lifecycleStateForTesting() == .idle)
            await session.refreshConfigNow()
            #expect(session.__lifecycleStateForTesting() == .idle)
            NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
            #expect(session.__lifecycleStateForTesting() == .buffering)
            NotificationCenter.default.post(name: UIApplication.didReceiveMemoryWarningNotification, object: nil)
            #expect(session.__lifecycleStateForTesting() == .idle)
            await session.refreshConfigNow()
            #expect(session.__lifecycleStateForTesting() == .idle)
            NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
            #expect(session.__lifecycleStateForTesting() == .buffering)
        }
    }
}
#endif
