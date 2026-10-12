// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Crash-only sessions (spec 2026-10-12), the replay half. A crash-only session
// samples replay at the server's `crashOnlySamplingRate` (0 when the server
// sends none) and captures no network bodies; an error takes a replay only
// while its session records (`ErrorReplayGate`), so at the default rate errors
// carry none. A companion bond upgrades the session to the normal rules at once,
// and a detach does not undo it. Rates 0 and 1 keep the session's random draw
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

    @Test(arguments: [#"{"type":"pair.bonded","pair_id":"p"}"#,
                      #"{"type":"pair.bonded","pair_id":"p","attribution_token":"attr_1","companion_user":{"display_name":"Ada L."}}"#])
    func aCompanionBondStartsReplayAndBodiesAtOnceAndADetachKeepsThem(bond: String) async throws {
        try await withGlobalCaptureStateLock {
            ErrorReplayGate.shared.__resetForTesting()
            let fetcher = CrashOnlyConfigFetcher([serverConfig])
            let box = SessionBox()
            Everframe.__replaySessionFactoryForTesting = { _ in
                MainActor.assumeIsolated {
                    let session = ReplaySession(provider: provider(fetcher), locallyDisabled: false)
                    box.session = session
                    return session
                }
            }
            let client = RelayWSClient(endpoint: URL(string: "https://relay.example.com")!, companion: CompanionAPI(),
                sdkKey: nil, deviceLabel: nil, announceTransport: nil)
            defer {
                Everframe.__resetReplaySessionFactoryForTesting()
                box.session?.teardown()
                Everframe.shared.kill()
                Everframe.__setConfigForTesting(nil)
                ErrorReplayGate.shared.__resetForTesting()
            }

            try Everframe.shared.start(config: crashOnlyConfig())
            #expect(await eventually { box.session?.currentConfig.replayEnabled == true })
            let session = try #require(box.session)
            #expect(session.__lifecycleStateForTesting() == .idle)
            #expect(ErrorReplayGate.shared.capture(epoch: epoch) == nil)
            #expect(!NetworkBodyCaptureGate.shared.isActive)

            client.handleControl(bond)
            #expect(await eventually { session.__lifecycleStateForTesting() == .buffering })
            #expect(NetworkBodyCaptureGate.shared.isActive)
            #expect(ErrorReplayGate.shared.capture(epoch: epoch) != nil)
            // The upgrade re-applied the confirmed config; it did not wait on a fetch.
            #expect(await fetcher.calls == 1)

            client.handleControl(#"{"type":"phone.disconnected","pair_id":"p"}"#)
            client.handleControl(#"{"type":"pair.expired","pair_id":"p","reason":"inactivity"}"#)
            await session.refreshConfigNow()
            #expect(session.__lifecycleStateForTesting() == .buffering)
            #expect(NetworkBodyCaptureGate.shared.isActive)
            await #expect(throws: EverframeReporterError.reporterDisabled) {
                try await Everframe.shared.report.open()
            }
        }
    }

    @Test func anUpgradeWithoutAConfirmedConfigFetchesOne() async throws {
        try await withGlobalCaptureStateLock {
            let fetcher = CrashOnlyConfigFetcher([nil, serverConfig])
            let box = SessionBox()
            Everframe.__replaySessionFactoryForTesting = { _ in
                MainActor.assumeIsolated {
                    let session = ReplaySession(provider: provider(fetcher), locallyDisabled: false)
                    box.session = session
                    return session
                }
            }
            defer {
                Everframe.__resetReplaySessionFactoryForTesting()
                box.session?.teardown()
                Everframe.shared.kill()
                Everframe.__setConfigForTesting(nil)
            }

            try Everframe.shared.start(config: crashOnlyConfig())
            #expect(await eventually { await fetcher.calls == 1 })
            let session = try #require(box.session)
            #expect(session.__lifecycleStateForTesting() == .idle)

            RelayWSClient(endpoint: URL(string: "https://relay.example.com")!, companion: CompanionAPI(),
                sdkKey: nil, deviceLabel: nil, announceTransport: nil)
                .handleControl(#"{"type":"pair.bonded","pair_id":"p"}"#)
            #expect(await eventually { session.__lifecycleStateForTesting() == .buffering })
            #expect(await fetcher.calls == 2)
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
