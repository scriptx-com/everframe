// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Simulator quick capture's `captureHotkey.replay` flag. Replay records when the
// app's `replayEnabled` is true, or when quick capture is armed and the flag is
// true. The flag never turns replay off, and a disarm hands the decision back
// to `replayEnabled` at the next config apply. Drives the real
// `ReplaySession.refreshConfigNow()` seam against `QuickCapture.shared`, which
// is the instance that seam publishes to. UIKit-gated: run on a simulator (see
// TESTING.md).
#if canImport(UIKit)
import Foundation
import Testing
@testable import EverframeKit

/// Serves `bodies` in order; the last one repeats.
private actor QuickCaptureReplayFetcher: URLSessionFetching {
    private let bodies: [String]
    private var calls = 0
    init(_ bodies: [String]) { self.bodies = bodies }
    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        let body = bodies[min(calls, bodies.count - 1)]
        calls += 1
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

/// A config body. `samplingRate` 0 keeps a report session sampled out, so only
/// forcing can make it record.
private func config(replayEnabled: Bool, samplingRate: Double = 1, hotkey: String? = nil) -> String {
    let block = hotkey.map { #","captureHotkey":"# + $0 } ?? ""
    return #"{"replayEnabled":\#(replayEnabled),"replayDurationSec":30,"samplingRate":\#(samplingRate),"nativeVideo":{"framesPerSecond":10}\#(block)}"#
}

private let forcing = #"{"enabled":true,"replay":true}"#

@MainActor @Suite(.serialized)
struct QuickCaptureReplayTests {
    private func session(_ bodies: [String]) -> ReplaySession {
        let provider = ReplayConfigProvider(configUrl: URL(string: "https://example.test/api/config")!, sdkKey: "test",
            fetcher: QuickCaptureReplayFetcher(bodies))
        return ReplaySession(provider: provider, locallyDisabled: false)
    }

    /// An armed quick-capture session, as `start()` leaves it on a debug
    /// simulator: open kill switch, local opt-in. The server block arrives with
    /// the config each test serves.
    private func withArmedQuickCapture(localEnabled: Bool = true, _ body: @MainActor () async throws -> Void) async rethrows {
        try await withGlobalCaptureStateLock {
            let savedGate = Everframe.captureGate
            Everframe.captureGate = true
            QuickCapture.shared.beginSession(localEnabled: localEnabled, debug: true)
            defer {
                QuickCapture.shared.teardown()
                Everframe.captureGate = savedGate
            }
            try await body()
        }
    }

    @Test func armedWithTheReplayFlagRecordsWhileReplayIsOff() async {
        await withArmedQuickCapture {
            let session = session([config(replayEnabled: false, hotkey: forcing)])
            defer { session.teardown() }
            await session.refreshConfigNow()
            #expect(QuickCapture.shared.isArmed)
            #expect(QuickCapture.shared.forcesReplay)
            #expect(!session.currentConfig.replayEnabled)
            #expect(session.__lifecycleStateForTesting() == .buffering)
        }
    }

    /// A developer debug session: forced replay records even when the
    /// configured sampling rate would drop it.
    @Test func forcedReplayIgnoresSampling() async {
        await withArmedQuickCapture {
            let session = session([config(replayEnabled: true, samplingRate: 0, hotkey: forcing)])
            defer { session.teardown() }
            await session.refreshConfigNow()
            #expect(session.__lifecycleStateForTesting() == .buffering)
        }
    }

    @Test(arguments: [false, true])
    func withoutTheBlockReplayFollowsReplayEnabled(replayEnabled: Bool) async {
        await withArmedQuickCapture {
            let session = session([config(replayEnabled: replayEnabled)])
            defer { session.teardown() }
            await session.refreshConfigNow()
            #expect(!QuickCapture.shared.forcesReplay)
            #expect(session.__lifecycleStateForTesting() == (replayEnabled ? .buffering : .idle))
        }
    }

    @Test(arguments: [false, true])
    func aLocalOptOutLeavesReplayToReplayEnabled(replayEnabled: Bool) async {
        await withArmedQuickCapture(localEnabled: false) {
            let session = session([config(replayEnabled: replayEnabled, hotkey: forcing)])
            defer { session.teardown() }
            await session.refreshConfigNow()
            #expect(!QuickCapture.shared.isArmed)
            #expect(session.__lifecycleStateForTesting() == (replayEnabled ? .buffering : .idle))
        }
    }

    @Test(arguments: [false, true])
    func aClosedKillSwitchLeavesReplayToReplayEnabled(replayEnabled: Bool) async {
        await withArmedQuickCapture {
            Everframe.captureGate = false
            let session = session([config(replayEnabled: replayEnabled, hotkey: forcing)])
            defer { session.teardown() }
            await session.refreshConfigNow()
            #expect(!QuickCapture.shared.forcesReplay)
            #expect(session.__lifecycleStateForTesting() == (replayEnabled ? .buffering : .idle))
        }
    }

    @Test(arguments: [false, true])
    func aDisabledBlockLeavesReplayToReplayEnabled(replayEnabled: Bool) async {
        await withArmedQuickCapture {
            let session = session([config(replayEnabled: replayEnabled, hotkey: #"{"enabled":false,"replay":true}"#)])
            defer { session.teardown() }
            await session.refreshConfigNow()
            #expect(!QuickCapture.shared.isArmed)
            #expect(session.__lifecycleStateForTesting() == (replayEnabled ? .buffering : .idle))
        }
    }

    /// `replay: false` and an absent flag both mean "no opinion". Neither turns
    /// replay off when `replayEnabled` is true.
    @Test(arguments: [(#"{"enabled":true,"replay":false}"#, false), (#"{"enabled":true,"replay":false}"#, true),
                      (#"{"enabled":true}"#, false), (#"{"enabled":true}"#, true)])
    func withoutTheFlagReplayFollowsReplayEnabled(block: String, replayEnabled: Bool) async {
        await withArmedQuickCapture {
            let session = session([config(replayEnabled: replayEnabled, hotkey: block)])
            defer { session.teardown() }
            await session.refreshConfigNow()
            #expect(QuickCapture.shared.isArmed)
            #expect(!QuickCapture.shared.forcesReplay)
            #expect(session.__lifecycleStateForTesting() == (replayEnabled ? .buffering : .idle))
        }
    }

    /// A refresh that drops the block, or clears the flag, stops the forced
    /// recording; one that keeps forcing leaves it running.
    @Test(arguments: [config(replayEnabled: false),
                      config(replayEnabled: false, hotkey: #"{"enabled":true,"replay":false}"#),
                      config(replayEnabled: false, hotkey: #"{"enabled":false,"replay":true}"#)])
    func aDisarmingRefreshStopsTheForcedRecording(next: String) async {
        await withArmedQuickCapture {
            let session = session([config(replayEnabled: false, hotkey: forcing), next])
            defer { session.teardown() }
            await session.refreshConfigNow()
            #expect(session.__lifecycleStateForTesting() == .buffering)
            await session.refreshConfigNow()
            #expect(!QuickCapture.shared.forcesReplay)
            #expect(session.__lifecycleStateForTesting() == .idle)
        }
    }

    /// A disarm that arrives without a config, such as a closed kill switch or
    /// a quick-capture teardown, takes effect at the next apply.
    @Test func aKillSwitchOrTeardownStopsTheForcedRecordingAtTheNextApply() async {
        await withArmedQuickCapture {
            let session = session([config(replayEnabled: false, hotkey: forcing)])
            defer { session.teardown() }
            await session.refreshConfigNow()
            #expect(session.__lifecycleStateForTesting() == .buffering)
            Everframe.captureGate = false
            await session.refreshConfigNow()
            #expect(session.__lifecycleStateForTesting() == .idle)

            Everframe.captureGate = true
            await session.refreshConfigNow()
            #expect(session.__lifecycleStateForTesting() == .buffering)
            QuickCapture.shared.teardown()
            #expect(!QuickCapture.shared.forcesReplay)
        }
    }

    /// `replayEnabled` keeps recording after quick capture disarms.
    @Test func disarmingNeverStopsReplayTheAppEnabled() async {
        await withArmedQuickCapture {
            let session = session([config(replayEnabled: true, hotkey: forcing), config(replayEnabled: true)])
            defer { session.teardown() }
            await session.refreshConfigNow()
            #expect(session.__lifecycleStateForTesting() == .buffering)
            await session.refreshConfigNow()
            #expect(session.__lifecycleStateForTesting() == .buffering)
        }
    }

    /// Devices and release builds never arm quick capture, so the flag never
    /// reaches their replay.
    @Test func aReleaseBuildNeverForcesReplay() async {
        await withArmedQuickCapture {
            QuickCapture.shared.beginSession(localEnabled: true, debug: false)
            let session = session([config(replayEnabled: false, hotkey: forcing)])
            defer { session.teardown() }
            await session.refreshConfigNow()
            #expect(!QuickCapture.shared.forcesReplay)
            #expect(session.__lifecycleStateForTesting() == .idle)
        }
    }

    /// `kill()` disarms quick capture and tears the replay session down, which
    /// stops a forced recording at once.
    @Test func killStopsTheForcedRecording() async throws {
        try await withGlobalCaptureStateLock {
            final class SessionBox { var session: ReplaySession? }
            let box = SessionBox()
            let fetcher = QuickCaptureReplayFetcher([config(replayEnabled: false, hotkey: forcing)])
            Everframe.__replaySessionFactoryForTesting = { _ in
                MainActor.assumeIsolated {
                    let session = ReplaySession(provider: ReplayConfigProvider(
                        configUrl: URL(string: "https://example.test/api/config")!, sdkKey: "test", fetcher: fetcher),
                        locallyDisabled: false)
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
            try Everframe.shared.start(config: EverframeConfig(
                sdkKey: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU", capture: CaptureConfig(logs: false),
                releaseHealth: nil, debugBuild: true))
            #expect(await eventually { box.session?.__lifecycleStateForTesting() == .buffering })
            let session = try #require(box.session)
            #expect(QuickCapture.shared.forcesReplay)

            Everframe.shared.kill()
            #expect(!QuickCapture.shared.forcesReplay)
            #expect(await eventually { session.__lifecycleStateForTesting() == .idle })
        }
    }

    private func eventually(_ predicate: @MainActor () async -> Bool) async -> Bool {
        for _ in 0..<500 {
            if await predicate() { return true }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return await predicate()
    }
}
#endif
