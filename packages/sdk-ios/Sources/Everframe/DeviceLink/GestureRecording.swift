// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Record on device: the dashboard asks a linked Apple TV (through its config's
// `deviceLinking.link.recording`) to record the remote keys pressed for 10 s,
// so a teammate can set the app's TV gesture by pressing it. The device shows
// "Recording remote keys for 10 seconds", records, then posts the keys to
// `POST /api/device-link/recordings/:id` with its device token and says
// "Keys sent to Everframe" once the server accepted them.
//
// A request that arrives while the app has no foreground-active scene (it is
// in the background, or inactive) waits: the prompt toast could not show, so
// the 10 s window starts, and the request counts as handled, only once a
// scene becomes active.
//
// The token, origin and SDK key are taken once, when the recording starts, and
// the keys are posted with them only if the same link is still current at the
// end. A start(), kill() or unlink in between posts nothing.
//
// SECURITY: never log the token.
import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Posts a finished recording.
protocol GestureRecordingTransport: Sendable {
    /// True only when the server accepted the recording (`204`).
    func postRecording(recordingId: String, token: String, events: [RecordedKey]) async -> Bool
}

@MainActor
final class GestureRecording {
    static let shared = GestureRecording()

    static let startedText = "Recording remote keys for 10 seconds"
    static let sentText = "Keys sent to Everframe"

    typealias Snapshot = (token: String, endpoint: URL, sdkKey: String)

    /// An activation observer; `cancel()` removes it.
    final class Observation {
        private var onCancel: (() -> Void)?
        init(_ onCancel: @escaping () -> Void) { self.onCancel = onCancel }
        func cancel() {
            onCancel?()
            onCancel = nil
        }
    }

    struct Seams {
        /// Uptime, the clock remote key timestamps use.
        var now: @MainActor () -> TimeInterval
        /// Wall clock, for the request's `expiresAt`.
        var wallNow: @MainActor () -> Date
        var sleep: @MainActor (TimeInterval) async -> Void
        var showToast: @MainActor (String) -> Void
        /// The linked device's token, origin and SDK key, or nil when unlinked.
        var snapshot: @MainActor () -> Snapshot?
        var transport: @MainActor (_ endpoint: URL, _ sdkKey: String) -> GestureRecordingTransport
        /// Whether a scene is foreground-active, so the prompt toast can show.
        var isForegroundActive: @MainActor () -> Bool = { true }
        /// Calls the body each time a scene becomes active, until cancelled.
        var observeActivation: @MainActor (@escaping @MainActor () -> Void) -> Observation = { _ in Observation {} }

        static var live: Seams {
            Seams(
                now: { ProcessInfo.processInfo.systemUptime },
                wallNow: { Date() },
                sleep: { seconds in try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000)) },
                showToast: { text in
                    #if canImport(UIKit)
                    QuickCaptureToast.show(text: text)
                    #endif
                },
                snapshot: { DeviceLinkCoordinator.shared.recordingSnapshot() },
                transport: { endpoint, sdkKey in DeviceLinkClient(baseURL: endpoint, sdkKey: sdkKey) },
                isForegroundActive: {
                    #if canImport(UIKit)
                    return UIApplication.shared.connectedScenes.contains {
                        ($0 as? UIWindowScene)?.activationState == .foregroundActive
                    }
                    #else
                    return true
                    #endif
                },
                observeActivation: { body in
                    #if canImport(UIKit)
                    let box = ActivationBody(body)
                    let token = NotificationCenter.default.addObserver(
                        forName: UIScene.didActivateNotification, object: nil, queue: .main
                    ) { _ in MainActor.assumeIsolated { box.run() } }
                    return Observation { NotificationCenter.default.removeObserver(token) }
                    #else
                    return Observation {}
                    #endif
                })
        }
    }

    /// The activation callback, created and run on the main thread only.
    private final class ActivationBody: @unchecked Sendable {
        let run: @MainActor () -> Void
        init(_ run: @escaping @MainActor () -> Void) { self.run = run }
    }

    var seams: Seams

    private var handled: Set<String> = []
    private var recorder: GestureRecorder?
    private var generation = 0
    private var task: Task<Void, Never>?
    /// The latest request that arrived with no foreground-active scene.
    private var deferred: (request: DeviceLinkRecordingRequest, isCurrent: @Sendable () -> Bool)?
    private var activation: Observation?

    init(seams: Seams = .live) {
        self.seams = seams
    }

    /// A recording is in its 10 s window.
    var isActive: Bool { recorder != nil }

    /// Starts recording, unless this id was already handled, the request has
    /// expired, a recording is running or the device is not linked. With no
    /// foreground-active scene it waits for one (the latest request wins).
    /// `isCurrent` says whether the session that received the request is still current.
    func onRequest(_ request: DeviceLinkRecordingRequest, isCurrent: @escaping @Sendable () -> Bool) {
        guard !handled.contains(request.id), request.expiresAt > seams.wallNow(), recorder == nil,
              seams.snapshot() != nil else { return }
        guard seams.isForegroundActive() else {
            deferred = (request, isCurrent)
            if activation == nil {
                activation = seams.observeActivation { [weak self] in self?.sceneActivated() }
            }
            return
        }
        start(request, isCurrent: isCurrent)
    }

    /// A scene became active: start the waiting request, re-checked as new.
    private func sceneActivated() {
        guard let waiting = deferred, seams.isForegroundActive() else { return }
        dropDeferred()
        onRequest(waiting.request, isCurrent: waiting.isCurrent)
    }

    private func dropDeferred() {
        deferred = nil
        activation?.cancel()
        activation = nil
    }

    private func start(_ request: DeviceLinkRecordingRequest, isCurrent: @escaping @Sendable () -> Bool) {
        guard let snapshot = seams.snapshot() else { return }
        handled.insert(request.id)
        recorder = GestureRecorder()
        generation += 1
        let mine = generation
        seams.showToast(Self.startedText)
        task = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.seams.sleep(GestureRecorder.duration)
            await self.finish(request: request, snapshot: snapshot, generation: mine, isCurrent: isCurrent)
        }
    }

    func feed(_ event: TvKeyEvent) {
        recorder?.feed(event)
    }

    /// Drops a recording in progress, or one waiting for the foreground;
    /// nothing is posted.
    func teardown() {
        dropDeferred()
        generation += 1
        recorder = nil
        task?.cancel()
    }

    private func finish(request: DeviceLinkRecordingRequest, snapshot: Snapshot, generation mine: Int,
                        isCurrent: @Sendable () -> Bool) async {
        guard generation == mine, let recorder else { return }
        let events = recorder.finish(now: seams.now())
        self.recorder = nil
        // The same link, for the same origin and key, must still be current.
        guard isCurrent(), let current = seams.snapshot(), current.token == snapshot.token,
              current.endpoint == snapshot.endpoint, current.sdkKey == snapshot.sdkKey else { return }
        let sent = await seams.transport(snapshot.endpoint, snapshot.sdkKey)
            .postRecording(recordingId: request.id, token: snapshot.token, events: events)
        guard sent, generation == mine else { return }
        seams.showToast(Self.sentText)
    }

    func __eventsForTesting(now: TimeInterval) -> [RecordedKey] {
        recorder?.finish(now: now) ?? []
    }

    func __awaitFinishForTesting() async {
        await task?.value
    }
}
