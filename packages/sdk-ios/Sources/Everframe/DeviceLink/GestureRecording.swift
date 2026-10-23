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
// The token, origin and SDK key are taken once, when the recording starts, and
// the keys are posted with them only if the same link is still current at the
// end. A start(), kill() or unlink in between posts nothing.
//
// SECURITY: never log the token.
import Foundation

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
                transport: { endpoint, sdkKey in DeviceLinkClient(baseURL: endpoint, sdkKey: sdkKey) })
        }
    }

    var seams: Seams

    private var handled: Set<String> = []
    private var recorder: GestureRecorder?
    private var generation = 0
    private var task: Task<Void, Never>?

    init(seams: Seams = .live) {
        self.seams = seams
    }

    /// A recording is in its 10 s window.
    var isActive: Bool { recorder != nil }

    /// Starts recording, unless this id was already handled, the request has
    /// expired, a recording is running or the device is not linked.
    /// `isCurrent` says whether the session that received the request is still current.
    func onRequest(_ request: DeviceLinkRecordingRequest, isCurrent: @escaping @Sendable () -> Bool) {
        guard !handled.contains(request.id), request.expiresAt > seams.wallNow(), recorder == nil,
              let snapshot = seams.snapshot() else { return }
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

    /// Drops a recording in progress; nothing is posted.
    func teardown() {
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
