// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Crash-only sessions (spec 2026-10-12), the replay half. A crash-only session
// samples replay at the server's `crashOnlySamplingRate` (0 when the server
// sends none) and captures no network bodies; an error takes a replay only
// while its session records (`ErrorReplayGate`), so at the default rate errors
// carry none. Rates 0 and 1 keep the session's random draw
// out of every assertion.
#if canImport(UIKit)
import Foundation
import Testing
@testable import EverframeKit

/// Serves `bodies` in order, the last one repeating; `nil` fails the fetch.
private actor CrashOnlyConfigFetcher: URLSessionFetching {
    private let bodies: [String?]
    private(set) var calls = 0
    init(_ bodies: [String?]) { self.bodies = bodies }
    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        let body = bodies[min(calls, bodies.count - 1)]
        calls += 1
        guard let body else { throw URLError(.notConnectedToInternet) }
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

/// Replay and bodies on for every session that can file a report.
private let serverConfig = #"{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1,"nativeVideo":{"framesPerSecond":10},"networkBodies":{"captureBodies":true}}"#
private let sdkKey = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"

@MainActor @Suite(.serialized)
struct CrashOnlyReplayTests {
    private final class SessionBox { var session: ReplaySession? }

    private func crashOnlyConfig() -> EverframeConfig {
        EverframeConfig(sdkKey: sdkKey, capture: CaptureConfig(logs: false, network: true), releaseHealth: nil,
            reporterEnabled: false)
    }

    private func provider(_ fetcher: CrashOnlyConfigFetcher) -> ReplayConfigProvider {
        ReplayConfigProvider(configUrl: URL(string: "https://example.test/api/config")!, sdkKey: "test", fetcher: fetcher)
    }

    private func eventually(_ predicate: @MainActor () async -> Bool) async -> Bool {
        for _ in 0..<500 {
            if await predicate() { return true }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return await predicate()
    }

    private var epoch: Int { Everframe.shared.currentStartEpoch }

    @Test func atTheDefaultRateACrashOnlySessionRecordsNothingSoItsErrorsCarryNoReplay() async {
        await withGlobalCaptureStateLock {
            ErrorReplayGate.shared.__resetForTesting()
            Everframe.__setConfigForTesting(crashOnlyConfig())
            defer { Everframe.__setConfigForTesting(nil); ErrorReplayGate.shared.__resetForTesting() }
            let session = ReplaySession(provider: provider(CrashOnlyConfigFetcher([serverConfig])), locallyDisabled: false)
            defer { session.teardown() }
            await session.refreshConfigNow()
            #expect(session.currentConfig.replayEnabled)
            #expect(session.__lifecycleStateForTesting() == .idle)
            #expect(ErrorReplayGate.shared.capture(epoch: epoch) == nil)
            #expect(!ErrorReplayGate.shared.reserve(epoch: epoch))
            #expect(!NetworkBodyCaptureGate.shared.isActive)
        }
    }

    @Test func theCrashOnlyRateDecidesReplayButNeverBodies() async {
        await withGlobalCaptureStateLock {
            ErrorReplayGate.shared.__resetForTesting()
            Everframe.__setConfigForTesting(crashOnlyConfig())
            defer { Everframe.__setConfigForTesting(nil); ErrorReplayGate.shared.__resetForTesting() }
            let body = #"{"replayEnabled":true,"replayDurationSec":30,"samplingRate":0,"crashOnlySamplingRate":1,"nativeVideo":{"framesPerSecond":10},"networkBodies":{"captureBodies":true}}"#
            let session = ReplaySession(provider: provider(CrashOnlyConfigFetcher([body])), locallyDisabled: false)
            defer { session.teardown() }
            await session.refreshConfigNow()
            #expect(session.__lifecycleStateForTesting() == .buffering)
            #expect(ErrorReplayGate.shared.capture(epoch: epoch) != nil)
            #expect(!NetworkBodyCaptureGate.shared.isActive)
        }
    }

    @Test func aReportSessionKeepsTheReportRate() async {
        await withGlobalCaptureStateLock {
            Everframe.__setConfigForTesting(EverframeConfig(sdkKey: sdkKey, capture: CaptureConfig(logs: false, network: true)))
            defer { Everframe.__setConfigForTesting(nil) }
            let body = #"{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1,"crashOnlySamplingRate":0,"nativeVideo":{"framesPerSecond":10},"networkBodies":{"captureBodies":true}}"#
            let session = ReplaySession(provider: provider(CrashOnlyConfigFetcher([body])), locallyDisabled: false)
            defer { session.teardown() }
            await session.refreshConfigNow()
            #expect(session.__lifecycleStateForTesting() == .buffering)
            #expect(NetworkBodyCaptureGate.shared.isActive)
        }
    }
}
#endif
