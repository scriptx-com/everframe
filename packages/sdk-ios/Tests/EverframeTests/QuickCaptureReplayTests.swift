// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Simulator quick capture's `captureHotkey.replay` flag. Replay records when the
// app's `replayEnabled` is true, or when quick capture is armed and the flag is
// true. The flag never turns replay off, and a disarm hands the decision back
// to `replayEnabled` at the next config apply. Drives the real
// `ReplaySession.refreshConfigNow()` seam against `QuickCapture.shared`, which
// is the instance that seam publishes to. Also covers the outbox drain: a
// queued quick capture keeps its forced replay while forcing lasts.
// UIKit-gated: run on a simulator (see TESTING.md).
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

/// Answers every request with `status`, and runs `onRequest` as each one starts.
private final class QuickCaptureDrainURLProtocol: URLProtocol {
    nonisolated(unsafe) static var status = 200
    nonisolated(unsafe) static var onRequest: (() -> Void)?
    nonisolated(unsafe) static var replayRefs: [Int] = []

    static func reset() { status = 200; onRequest = nil; replayRefs = [] }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url else { return }
        Self.onRequest?()
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: Self.status, httpVersion: "HTTP/1.1",
                                                              headerFields: [:])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data())
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

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

    /// Unlinked release builds never arm quick capture, so the flag never
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

    /// On a real iPhone or iPad: `hostMode` is `.device` for the body, and the
    /// session is a release or debug build, linked or not.
    private func onRealDevice(debug: Bool, linked: Bool, _ body: @MainActor () async throws -> Void) async rethrows {
        try await withArmedQuickCapture {
            let savedMode = QuickCapture.shared.hostMode
            QuickCapture.shared.hostMode = .device
            defer { QuickCapture.shared.hostMode = savedMode }
            QuickCapture.shared.beginSession(localEnabled: true, debug: debug)
            QuickCapture.shared.setLinked(linked)
            try await body()
        }
    }

    /// A linked device, even a release build, records while the flag is set.
    @Test func aLinkedReleaseDeviceForcesReplay() async {
        await onRealDevice(debug: false, linked: true) {
            let session = session([config(replayEnabled: false, hotkey: forcing)])
            defer { session.teardown() }
            await session.refreshConfigNow()
            #expect(QuickCapture.shared.forcesReplay)
            #expect(session.__lifecycleStateForTesting() == .buffering)
        }
    }

    @Test func aDebugDeviceForcesReplay() async {
        await onRealDevice(debug: true, linked: false) {
            let session = session([config(replayEnabled: false, hotkey: forcing)])
            defer { session.teardown() }
            await session.refreshConfigNow()
            #expect(QuickCapture.shared.forcesReplay)
            #expect(session.__lifecycleStateForTesting() == .buffering)
        }
    }

    /// End users' devices never start recording because of quick capture.
    @Test func anUnlinkedReleaseDeviceNeverForcesReplay() async {
        await onRealDevice(debug: false, linked: false) {
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

    /// A quick capture queued offline keeps the replay forcing allowed when the
    /// outbox drains it later, while quick capture still forces replay.
    @Test func aQueuedForcedQuickCaptureKeepsItsReplayOnDrain() async throws {
        try await withArmedQuickCapture {
            QuickCapture.shared.publish(remote: CaptureHotkeyConfigWire(enabled: true, replay: true))
            #expect(QuickCapture.shared.forcesReplay)
            let drained = try await drainQueuedReplay()
            #expect(drained.uploads == 1)
            #expect(drained.replayRefsAtUpload == [1], "the replay must still be in the entry it uploads")
            #expect(drained.remaining == 0)
        }
    }

    /// Without forcing, the drain still strips replay while `replayEnabled` is false.
    @Test(arguments: [CaptureHotkeyConfigWire(enabled: true), CaptureHotkeyConfigWire(enabled: true, replay: false),
                      CaptureHotkeyConfigWire(enabled: false, replay: true), nil])
    func withoutForcingTheDrainStillStripsReplay(block: CaptureHotkeyConfigWire?) async throws {
        try await withArmedQuickCapture {
            QuickCapture.shared.publish(remote: block)
            #expect(!QuickCapture.shared.forcesReplay)
            let drained = try await drainQueuedReplay()
            #expect(drained.uploads == 1)
            #expect(drained.replayRefsAtUpload == [0], "revoked replay is removed before the retry")
            #expect(drained.remaining == 0)
        }
    }

    /// Forcing keeps replay only for the project that is running now.
    @Test func forcingNeverKeepsAnotherProjectsQueuedReplay() async throws {
        try await withArmedQuickCapture {
            QuickCapture.shared.publish(remote: CaptureHotkeyConfigWire(enabled: true, replay: true))
            let drained = try await drainQueuedReplay(entryKey: "another-project")
            #expect(drained.replayRefsAtUpload == [0])
        }
    }

    /// Forcing drives only the native video recorder, so it never keeps a
    /// queued VTree replay.
    @Test func forcingNeverKeepsAQueuedVTreeReplay() async throws {
        try await withArmedQuickCapture {
            QuickCapture.shared.publish(remote: CaptureHotkeyConfigWire(enabled: true, replay: true))
            let drained = try await drainQueuedReplay(nativeVideo: false)
            #expect(drained.replayRefsAtUpload == [0])
        }
    }

    /// Queues one report with a replay (native video, or else VTree) for
    /// `entryKey` while offline, then drains it with replay off as the running
    /// project `quick-capture-drain`.
    private func drainQueuedReplay(entryKey: String = "quick-capture-drain", nativeVideo: Bool = true) async throws
        -> (uploads: Int, replayRefsAtUpload: [Int], remaining: Int) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("quick-capture-drain-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let savedConfig = Everframe.shared.currentConfig
        Everframe.__setConfigForTesting(EverframeConfig(sdkKey: "quick-capture-drain"))
        Everframe.shared.__replayConfigOverrideForTesting = nil // replayEnabled false
        let urlConfig = URLSessionConfiguration.ephemeral
        urlConfig.protocolClasses = [QuickCaptureDrainURLProtocol.self]
        let urlSession = URLSession(configuration: urlConfig)
        defer {
            urlSession.invalidateAndCancel()
            QuickCaptureDrainURLProtocol.reset()
            Everframe.__setConfigForTesting(savedConfig)
            try? FileManager.default.removeItem(at: dir)
        }
        let box = JSONLOutbox(testFileURL: dir.appendingPathComponent("outbox.jsonl"))
        QuickCaptureDrainURLProtocol.status = 503
        let (filename, contentType) = nativeVideo ? ("replay.mp4", "video/mp4") : ("replay.json", "application/octet-stream")
        let queued = try await ReportSubmitter(config: EverframeConfig(sdkKey: entryKey), outbox: box, session: urlSession)
            .submit(
                envelopeBytes: Data(#"{"quickCapture":true,"attachments":[{"partName":"replay","kind":"sessionReplay","contentType":"\#(contentType)"}],"captureControl":{"included":[],"excluded":[]}}"#.utf8),
                idempotencyKey: "quick-capture-drain-idem",
                attachments: [ReportSubmitter.Attachment(name: "replay", filename: filename,
                    contentType: contentType, data: Data([1, 2, 3]), sha256Hex: "replay-hash")],
                endpoint: IngestEndpoint.url.absoluteString)
        guard case .queued = queued else { Issue.record("the offline upload must queue"); return (0, [], 0) }
        QuickCaptureDrainURLProtocol.reset()
        QuickCaptureDrainURLProtocol.onRequest = {
            let refs = (try? box.hydrate().first)?.attachmentRefs.filter { $0.name == "replay" }.count ?? -1
            QuickCaptureDrainURLProtocol.replayRefs.append(refs)
        }
        let epoch = Everframe.shared.currentStartEpoch
        await ReportSubmitter(config: EverframeConfig(sdkKey: "quick-capture-drain"), outbox: box, session: urlSession)
            .drainOutbox(identityHolder: IdentityTokenHolder(), currentReplayConfig: { .off },
                         epochAtInitiation: epoch, currentEpoch: { Everframe.shared.currentStartEpoch })
        return (QuickCaptureDrainURLProtocol.replayRefs.count, QuickCaptureDrainURLProtocol.replayRefs, box.count)
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
