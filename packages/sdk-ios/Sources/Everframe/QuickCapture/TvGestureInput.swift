// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Recognizes the app's TV binding in the Siri Remote presses that reach
// `UIWindow.sendEvent`, and decides which presses the hook delivers.
//
// - The `UIWindow.sendEvent` hook asks `needsPresses` first: with no armed
//   binding, no detector and no swallowed press pending it builds nothing.
// - A fired gesture goes through the mode rule (`CaptureGestureRouter`).
//   Only a linked device (`swallowKeys`) keeps presses from the app, and only
//   in pairs: a swallowed press's release is swallowed too, even after the
//   gesture disarms. A long press's `down` is always delivered, because the
//   press is not a gesture until the timer fires.
// - UIKit can hand one press event to more than one window; a press phase
//   seen in the last 8 is answered as it was the first time and never counted again.
// - A binding that types (letters, digits, SHIFT) stands aside while a text
//   input is being edited.
// - While Record on device runs, every press goes to the recording and is
//   delivered; nothing fires.
//
// Compiled wherever UIKit is, so iPhone simulators run the logic too; only
// tvOS installs the hook.
#if canImport(UIKit)
import UIKit

protocol TvGestureTimer {
    func cancel()
}

@MainActor
final class TvGestureInput {
    static let shared = TvGestureInput()

    struct Seams {
        var now: @MainActor () -> TimeInterval
        /// Runs the body after the delay (seconds) unless cancelled.
        var schedule: @MainActor (TimeInterval, @escaping @MainActor () -> Void) -> TvGestureTimer
        var armedBinding: @MainActor () -> TvGestureBinding?
        var route: @MainActor (CaptureGestureSource) -> CaptureGestureDecision
        var isEditingText: @MainActor (UIWindow?) -> Bool
        /// The Record on device recording in progress, if any.
        var recording: @MainActor () -> GestureRecording? = { nil }

        @MainActor static var live: Seams {
            Seams(
                now: { ProcessInfo.processInfo.systemUptime },
                schedule: { delay, body in LiveTimer(delay: delay, body: body) },
                armedBinding: { QuickCapture.shared.armedTvBinding },
                route: { CaptureGestureRouter.live.handle($0) },
                isEditingText: { QuickCaptureTextInput.firstResponderIsEditable(preferring: $0) },
                recording: { GestureRecording.shared.isActive ? GestureRecording.shared : nil })
        }
    }

    private final class LiveTimer: TvGestureTimer {
        /// Created, run and released on the main thread only.
        private final class Body: @unchecked Sendable {
            let run: @MainActor () -> Void
            init(_ run: @escaping @MainActor () -> Void) { self.run = run }
        }

        private let item: DispatchWorkItem

        init(delay: TimeInterval, body: @escaping @MainActor () -> Void) {
            let box = Body(body)
            item = DispatchWorkItem { MainActor.assumeIsolated { box.run() } }
            DispatchQueue.main.asyncAfter(deadline: .now() + max(0, delay), execute: item)
        }

        func cancel() { item.cancel() }
    }

    private struct Seen: Equatable {
        let press: ObjectIdentifier
        let phase: TvKeyPhase
        let at: TimeInterval
    }

    var seams: Seams = .live

    private var detector: TvGestureDetector?
    private var timer: TvGestureTimer?
    /// Presses kept from the app whose release must be kept too.
    private var swallowed: Set<ObjectIdentifier> = []
    /// The last 8 press phases and whether each was consumed.
    private var recent: [(seen: Seen, consumed: Bool)] = []
    private static let recentCapacity = 8

    init() {}

    init(seams: Seams) {
        self.seams = seams
    }

    /// Whether the hook must read presses at all.
    var needsPresses: Bool {
        !swallowed.isEmpty || detector != nil || seams.armedBinding() != nil || seams.recording() != nil
    }

    /// Feeds one press event's changing presses. Returns whether to deliver
    /// the event: false only when every key event in it was consumed.
    ///
    /// The event is the unit of delivery, so swallowing is committed per
    /// event: a press joins the swallowed set (its release will be kept too)
    /// only when the whole event is withheld. When the event is delivered,
    /// nothing in it counts as swallowed, and a duplicate of it is delivered.
    func handle(_ keys: [TvKeyEvent], window: UIWindow?) -> Bool {
        guard !keys.isEmpty else { return true }
        var judged: [(seen: Seen, consume: Bool, swallow: ObjectIdentifier?)] = []
        var withheld = true
        for event in keys {
            let seen = Seen(press: event.press, phase: event.phase, at: event.at)
            if let earlier = recent.first(where: { $0.seen == seen }) {
                if !earlier.consumed { withheld = false }
                continue
            }
            let verdict = judge(event, window: window)
            if !verdict.consume { withheld = false }
            judged.append((seen, verdict.consume, verdict.swallow))
        }
        for entry in judged {
            if withheld, let press = entry.swallow { swallowed.insert(press) }
            recent.append((entry.seen, withheld))
        }
        if recent.count > Self.recentCapacity { recent.removeFirst(recent.count - Self.recentCapacity) }
        return !withheld
    }

    func reset() {
        detector = nil
        cancelTimer()
        swallowed.removeAll()
        recent.removeAll()
    }

    /// Changing presses (`began`, `ended`, `cancelled`) as key events.
    static func keyEvents(_ presses: Set<UIPress>) -> [TvKeyEvent] {
        presses.compactMap { press in
            let phase: TvKeyPhase
            switch press.phase {
            case .began: phase = .down
            case .ended: phase = .up
            case .cancelled: phase = .cancelled
            default: return nil
            }
            let key = TvRemoteKeys.name(pressType: press.type.rawValue, keyUsage: press.key.map { $0.keyCode.rawValue })
            return TvKeyEvent(key: key, phase: phase, press: ObjectIdentifier(press), at: press.timestamp)
        }
    }

    // MARK: Per key event

    /// One key event's answer: whether it may be kept from the app, and the
    /// press that joins the swallowed set if its whole event is withheld.
    private struct Judgement {
        var consume: Bool
        var swallow: ObjectIdentifier?
    }

    private func judge(_ event: TvKeyEvent, window: UIWindow?) -> Judgement {
        // A swallowed press's release is swallowed, whatever happened since.
        let releasesSwallowed = event.phase != .down && swallowed.remove(event.press) != nil
        let pass = Judgement(consume: releasesSwallowed, swallow: nil)

        if let recording = seams.recording() {
            recording.feed(event)
            detector = nil
            cancelTimer()
            return pass
        }

        guard let binding = seams.armedBinding() else {
            detector = nil
            cancelTimer()
            return pass
        }
        if detector?.binding != binding {
            detector = TvGestureDetector(binding: binding)
            cancelTimer()
        }
        if binding.yieldsToTextInput, let key = event.key, binding.keys.contains(key),
           seams.isEditingText(window) {
            detector?.dropPending()
            cancelTimer()
            return pass
        }
        guard var current = detector else { return pass }
        let verdict = current.feed(event)
        detector = current
        if let deadline = verdict.holdDeadline {
            scheduleHold(deadline: deadline, binding: binding, window: window)
        } else if !current.isHoldPending {
            cancelTimer()
        }
        if verdict.fire {
            let decision = seams.route(.remote)
            // A sequence or chord's completing press is kept, with its release.
            return decision.swallowKeys ? Judgement(consume: true, swallow: event.press) : pass
        }
        // A completion overlapping a swallowed gesture belongs to it.
        if event.phase == .down, verdict.consume, !swallowed.isEmpty {
            return Judgement(consume: true, swallow: event.press)
        }
        return pass
    }

    // MARK: Hold timer

    private func scheduleHold(deadline: TimeInterval, binding: TvGestureBinding, window: UIWindow?) {
        cancelTimer()
        timer = seams.schedule(max(0, deadline - seams.now())) { [weak self, weak window] in
            self?.holdTimerFired(binding: binding, window: window)
        }
    }

    private func holdTimerFired(binding: TvGestureBinding, window: UIWindow?) {
        timer = nil
        // The state can change while the key is held: a refresh that changed
        // the binding, unlinked or disarmed the device, or a text input that
        // took focus. Nothing fires late.
        guard seams.recording() == nil, seams.armedBinding() == binding, var current = detector,
              current.binding == binding else {
            detector = nil
            return
        }
        if binding.yieldsToTextInput, seams.isEditingText(window) {
            current.dropPending()
            detector = current
            return
        }
        let result = current.holdTimerFired(at: seams.now())
        detector = current
        guard result.fired, let press = result.press else { return }
        let decision = seams.route(.remote)
        if decision.swallowKeys, TvGestureDetector.consumesFiredHoldRelease {
            swallowed.insert(press)
        }
    }

    private func cancelTimer() {
        timer?.cancel()
        timer = nil
    }

    // MARK: Testing

    var __hasTimerForTesting: Bool { timer != nil }
}
#endif
