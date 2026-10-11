// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import Foundation
import UIKit
import Testing
@testable import EverframeKit

private actor VideoConfigFetcher: URLSessionFetching {
    var succeeds = true
    func fail() { succeeds = false }
    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        guard succeeds else { throw URLError(.notConnectedToInternet) }
        return (Data(#"{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1,"nativeVideo":{"framesPerSecond":10}}"#.utf8),
            HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

@MainActor private final class DeviceConditionsBox {
    var value = ReplayDeviceConditions(thermal: .nominal, lowPowerMode: false)
}

@MainActor @Suite(.serialized) struct NativeVideoCoordinatorTests {
    @Test func errorReplayGateFollowsRecordingAndTheReporterFreeze() async {
        await withGlobalCaptureStateLock {
            ErrorReplayGate.shared.__resetForTesting()
            defer { ErrorReplayGate.shared.__resetForTesting() }
            let epoch = Everframe.shared.currentStartEpoch
            let provider = ReplayConfigProvider(configUrl: URL(string: "https://example.test/config")!, sdkKey: "test", fetcher: VideoConfigFetcher())
            let session = ReplaySession(provider: provider, locallyDisabled: false)
            defer { session.teardown() }
            #expect(!ErrorReplayGate.shared.reserve(epoch: epoch))
            await session.refreshConfigNow()
            #expect(ErrorReplayGate.shared.reserve(epoch: epoch))
            ErrorReplayGate.shared.release(epoch: epoch)
            session.freezeForReporter()
            #expect(!ErrorReplayGate.shared.reserve(epoch: epoch))
            guard case .omitted(let frozenReason) = await session.errorSnapshot(epoch: epoch) else {
                Issue.record("a frozen buffer served an error snapshot"); return
            }
            #expect(frozenReason == "replay_unavailable")
            session.cancelForReporter()
            #expect(ErrorReplayGate.shared.reserve(epoch: epoch))
            session.teardown()
            #expect(!ErrorReplayGate.shared.reserve(epoch: epoch))
        }
    }

    @Test func errorSnapshotKeepsTheSessionBufferingAndRefusesAnotherSessionsEpoch() async {
        await withGlobalCaptureStateLock {
            let epoch = Everframe.shared.currentStartEpoch
            let provider = ReplayConfigProvider(configUrl: URL(string: "https://example.test/config")!, sdkKey: "test", fetcher: VideoConfigFetcher())
            let session = ReplaySession(provider: provider, locallyDisabled: false)
            defer { session.teardown() }
            await session.refreshConfigNow()
            guard case .omitted(let foreign) = await session.errorSnapshot(epoch: epoch + 1) else {
                Issue.record("another session's error took this recording"); return
            }
            #expect(foreign == "replay_unavailable")
            switch await session.errorSnapshot(epoch: epoch) {
            case .movie(let artifact): artifact.removeOwnedFile()
            case .omitted(let reason): #expect(reason == "empty_recording")
            }
            #expect(session.__lifecycleStateForTesting() == .buffering)
        }
    }
    @Test func lowPowerModeAndSeriousHeatPauseCaptureUntilConditionsClear() async {
        await withGlobalCaptureStateLock {
            let conditions = DeviceConditionsBox()
            let provider = ReplayConfigProvider(configUrl: URL(string: "https://example.test/config")!, sdkKey: "test", fetcher: VideoConfigFetcher())
            let session = ReplaySession(provider: provider, locallyDisabled: false, deviceConditions: { conditions.value })
            defer { session.teardown() }
            await session.refreshConfigNow()
            #expect(session.__lifecycleStateForTesting() == .buffering)
            conditions.value.lowPowerMode = true
            await postFromBackgroundQueue(.NSProcessInfoPowerStateDidChange)
            #expect(session.__lifecycleStateForTesting() == .idle)
            await session.refreshConfigNow()
            #expect(session.__lifecycleStateForTesting() == .idle)
            conditions.value.lowPowerMode = false
            await postFromBackgroundQueue(.NSProcessInfoPowerStateDidChange)
            #expect(session.__lifecycleStateForTesting() == .buffering)
            conditions.value.thermal = .serious
            await postFromBackgroundQueue(ProcessInfo.thermalStateDidChangeNotification)
            #expect(session.__lifecycleStateForTesting() == .idle)
            conditions.value.thermal = .fair
            await postFromBackgroundQueue(ProcessInfo.thermalStateDidChangeNotification)
            #expect(session.__lifecycleStateForTesting() == .buffering)
        }
    }

    /// Foundation posts both notifications off the main queue; the session's
    /// MainActor hop is queued before this continuation resumes.
    private func postFromBackgroundQueue(_ name: Notification.Name) async {
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                NotificationCenter.default.post(name: name, object: ProcessInfo.processInfo)
                DispatchQueue.main.async { continuation.resume() }
            }
        }
    }

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
            let companion = Everframe.shared.companion
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
            let provider = ReplayConfigProvider(configUrl: URL(string: "https://example.test/config")!, sdkKey: "test", fetcher: VideoConfigFetcher())
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
            let companion = Everframe.shared.companion
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
            let provider = ReplayConfigProvider(configUrl: URL(string: "https://example.test/config")!, sdkKey: "test", fetcher: VideoConfigFetcher())
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
            let provider = ReplayConfigProvider(configUrl: URL(string: "https://example.test/config")!, sdkKey: "test", fetcher: VideoConfigFetcher())
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
        Everframe.shared.kill()
        await GlobalCaptureStateTestGate.shared.release()
    }

    @Test func queuedThermalNotificationDoesNotReviveTornDownSession() async {
        await GlobalCaptureStateTestGate.shared.acquire()
        do {
            let provider = ReplayConfigProvider(configUrl: URL(string: "https://example.test/config")!, sdkKey: "test", fetcher: VideoConfigFetcher())
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
        Everframe.shared.kill()
        await GlobalCaptureStateTestGate.shared.release()
    }

    @Test func replacingSDKSessionWhileReporterIsMountedDoesNotRecordReporter() async {
        await withGlobalCaptureStateLock {
            ReportAPI.__performSetPresenting(true)
            defer { ReportAPI.__performSetPresenting(false) }
            let provider = ReplayConfigProvider(configUrl: URL(string: "https://example.test/config")!, sdkKey: "test", fetcher: VideoConfigFetcher())
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
            let provider = ReplayConfigProvider(configUrl: URL(string: "https://example.test/config")!, sdkKey: "test", fetcher: fetcher)
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
            let provider = ReplayConfigProvider(configUrl: URL(string: "https://example.test/config")!, sdkKey: "test", fetcher: VideoConfigFetcher())
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
